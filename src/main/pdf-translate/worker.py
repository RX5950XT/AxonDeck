"""逐頁 OCR / 翻譯 / PDF 文字替換。stdout 僅供 main 的 JSONL 協定。"""

import os
import sys

_JSONL = None
if os.environ.get("AXONDECK_PDF_WORKER") == "1":
    # 第三方套件在 import 時可能直接印 stdout（如 PyMuPDF 的 fitz 警告）；
    # 先把真正的輸出管留下，fd 1 改送 stderr（main 啟動時 stderr 已忽略）。
    _JSONL = os.fdopen(os.dup(sys.stdout.fileno()), "w", encoding="utf-8", newline="\n", buffering=1)
    os.dup2(sys.stderr.fileno(), sys.stdout.fileno())

import contextlib
import html
import json
import math
import re
from collections import Counter
from urllib.parse import urlsplit

import pymupdf as fitz


MAX_MESSAGE = 4 * 1024 * 1024
MAX_PAGE_PIXELS = 12_000_000
MIN_FONT_SIZE = 6
MATH_FONT = re.compile(r"symbol|math|cmmi|cmsy|cmex|msam|msbm", re.I)
MATH_TEXT = re.compile(r"\\(?:frac|sum|int|sqrt|begin)\b|[∑∫√≠≤≥∂∞]|\$[^$]+\$")


class WorkerError(Exception):
    def __init__(self, code):
        self.code = code


def read_message(stream):
    line = stream.readline(MAX_MESSAGE + 1)
    if not line or len(line) > MAX_MESSAGE or not line.endswith("\n"):
        raise WorkerError("PROTOCOL")
    try:
        value = json.loads(line)
    except (ValueError, TypeError):
        raise WorkerError("PROTOCOL") from None
    if not isinstance(value, dict):
        raise WorkerError("PROTOCOL")
    return value


def emit(stream, value):
    stream.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n")
    stream.flush()


def validate_config(config):
    for key in ("inputPath", "outputPath", "layoutDir", "targetLang", "ocrModel"):
        if not isinstance(config.get(key), str) or not config[key] or "\0" in config[key]:
            raise WorkerError("CONFIG")
    if config["ocrModel"] != "paddleocrvl16" or len(config["targetLang"]) > 80:
        raise WorkerError("CONFIG")
    endpoint = config.get("endpoint", {})
    if not isinstance(endpoint, dict) or not isinstance(endpoint.get("baseUrl"), str):
        raise WorkerError("CONFIG")
    try:
        url = urlsplit(endpoint["baseUrl"])
        port = url.port
    except ValueError:
        raise WorkerError("CONFIG") from None
    if (url.scheme != "http" or url.hostname not in ("127.0.0.1", "localhost", "::1")
            or not port or url.username or url.password or url.query or url.fragment):
        raise WorkerError("CONFIG")
    if not isinstance(endpoint.get("apiKey", ""), str):
        raise WorkerError("CONFIG")
    source = os.path.realpath(config["inputPath"])
    target = os.path.realpath(config["outputPath"])
    if source == target or not os.path.isfile(source) or os.path.exists(target):
        raise WorkerError("PATH")
    if not os.path.isdir(config["layoutDir"]):
        raise WorkerError("LAYOUT_MISSING")


def create_pipeline(config):
    # 固定本機 layout，避免 Paddle 在處理文件時另下載模型。
    from paddleocr import PaddleOCRVL
    return PaddleOCRVL(
        pipeline_version="v1.6", layout_detection_model_name="PP-DocLayoutV3",
        layout_detection_model_dir=config["layoutDir"], device="cpu",
        vl_rec_backend="llama-cpp-server", vl_rec_server_url=config["endpoint"]["baseUrl"],
        vl_rec_api_model_name=config["ocrModel"],
        vl_rec_api_key=config["endpoint"].get("apiKey", ""), vl_rec_max_concurrency=1,
        use_doc_orientation_classify=False, use_doc_unwarping=False,
        use_chart_recognition=True, use_queues=False, merge_layout_blocks=False,
        format_block_content=False,
    )


def result_data(result):
    value = result.json if hasattr(result, "json") else result
    if not isinstance(value, dict):
        raise WorkerError("OCR_RESULT")
    value = value.get("res", value)
    if not isinstance(value, dict):
        raise WorkerError("OCR_RESULT")
    return value


def single_result(results):
    iterator = iter(results)
    first = next(iterator, None)
    if first is None or next(iterator, None) is not None:
        raise WorkerError("OCR_RESULT")
    return result_data(first)


def checked_rect(value, bounds, warnings):
    try:
        if len(value) != 4 or not all(math.isfinite(float(n)) for n in value):
            raise ValueError()
        rect = fitz.Rect(value) & bounds
    except (TypeError, ValueError, OverflowError):
        warnings["OCR_BOX_INVALID"] += 1
        return None
    if rect.is_empty or rect.width < 1 or rect.height < 1:
        warnings["OCR_BOX_INVALID"] += 1
        return None
    return rect


def overlap(rect, other):
    return (rect & other).get_area() / max(1, rect.get_area())


def text_regions(region, protected):
    regions = [region]
    for formula in protected:
        remaining = []
        for rect in regions:
            cut = rect & formula
            if cut.is_empty:
                remaining.append(rect)
                continue
            pieces = [fitz.Rect(rect.x0, rect.y0, rect.x1, cut.y0),
                      fitz.Rect(rect.x0, cut.y1, rect.x1, rect.y1),
                      fitz.Rect(rect.x0, cut.y0, cut.x0, cut.y1),
                      fitz.Rect(cut.x1, cut.y0, rect.x1, cut.y1)]
            remaining.extend(part for part in pieces if part.width >= 2 and part.height >= 2)
        regions = remaining
    return regions


def is_formula(text, font=""):
    return bool(MATH_FONT.search(font) or MATH_TEXT.search(text)
                or ("=" in text and len(text.split()) < 10))


def translatable(text):
    return any(ch.isalpha() for ch in text) and not is_formula(text)


def direction_rotation(direction):
    angle = math.degrees(math.atan2(-direction[1], direction[0])) % 360
    nearest = (round(angle / 90) * 90) % 360
    return nearest if min(abs(angle - nearest), 360 - abs(angle - nearest)) < 3 else None


def span_parts(span, protected):
    parts, chars = [], []
    for char in span.get("chars", []):
        rect = fitz.Rect(char["bbox"])
        if any(overlap(rect, area) > 0.1 for area in protected):
            if chars:
                parts.append(chars)
                chars = []
        else:
            chars.append(char)
    if chars:
        parts.append(chars)
    for part in parts:
        rect = fitz.Rect(part[0]["bbox"])
        for char in part[1:]:
            rect |= fitz.Rect(char["bbox"])
        yield {**span, "text": "".join(char["c"] for char in part), "bbox": rect}


def native_units(page, protected, warnings):
    units = []
    invisible = [fitz.Rect(s["bbox"]) for s in page.get_texttrace() if s.get("type") == 3]
    for block in page.get_text("rawdict", flags=fitz.TEXTFLAGS_RAWDICT & ~fitz.TEXT_PRESERVE_IMAGES)["blocks"]:
        for line in block.get("lines", []):
            rotation = direction_rotation(line.get("dir", (1, 0)))
            runs = []
            parts = [part for span in line["spans"] for part in span_parts(span, protected)]
            for span in parts:
                text = span.get("text", "")
                rect = fitz.Rect(span["bbox"])
                if not text.strip() or is_formula(text, span.get("font", "")):
                    runs.append(None)
                    continue
                if rotation is None:
                    warnings["TEXT_ROTATION_UNSUPPORTED"] += 1
                    continue
                if any(overlap(rect, area) > 0.8 for area in invisible):
                    continue
                unit = {"text": text, "rect": rect, "size": float(span["size"]),
                        "color": span.get("color", 0), "flags": span.get("flags", 0),
                        "rotate": rotation, "raster": False}
                previous = runs[-1] if runs else None
                gap = rect.x0 - previous["rect"].x1 if previous else 0
                if (previous and rotation == 0 and 0 <= gap < span["size"] * 1.5
                        and previous["flags"] == unit["flags"]
                        and previous["color"] == unit["color"]
                        and abs(previous["size"] - unit["size"]) < 0.5
                        and not any(not ((rect | previous["rect"]) & area).is_empty for area in protected)):
                    previous["text"] += (" " if gap > 1 else "") + text
                    previous["rect"] |= rect
                else:
                    runs.append(unit)
            units.extend(unit for unit in runs if unit and translatable(unit["text"]))
    return units


def page_image(page):
    scale = min(2.0, math.sqrt(MAX_PAGE_PIXELS / max(1, page.rect.get_area())))
    pix = page.get_pixmap(matrix=fitz.Matrix(scale, scale), colorspace=fitz.csRGB, alpha=False)
    import numpy as np
    image = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, 3)
    return image[:, :, ::-1].copy(), pix.width / page.rect.width, pix.height / page.rect.height


def parse_layout(pipeline, image, sx, sy, bounds, warnings):
    results = pipeline.predict(image, temperature=0, max_new_tokens=8192)
    data = single_result(results)
    raw = data.get("parsing_res_list")
    if not isinstance(raw, list):
        raise WorkerError("OCR_RESULT")
    blocks = []
    for block in raw:
        if not isinstance(block, dict) or not isinstance(block.get("block_label"), str):
            raise WorkerError("OCR_RESULT")
        bbox = block.get("block_bbox", [])
        if not isinstance(bbox, (list, tuple)) or len(bbox) != 4:
            warnings["OCR_BOX_INVALID"] += 1
            continue
        try:
            value = [float(bbox[0]) / sx, float(bbox[1]) / sy,
                     float(bbox[2]) / sx, float(bbox[3]) / sy]
        except (TypeError, ValueError):
            warnings["OCR_BOX_INVALID"] += 1
            continue
        rect = checked_rect(value, bounds, warnings)
        if rect is not None:
            blocks.append({"rect": rect, "label": block["block_label"],
                           "text": block.get("block_content", "")})
    return blocks


def spotting_units(pipeline, image, region, sx, sy, bounds, protected, native, warnings):
    x0, y0 = max(0, int(region.x0 * sx)), max(0, int(region.y0 * sy))
    x1, y1 = min(image.shape[1], math.ceil(region.x1 * sx)), min(image.shape[0], math.ceil(region.y1 * sy))
    crop = image[y0:y1, x0:x1]
    if crop.size == 0:
        return []
    results = pipeline.predict(crop, use_layout_detection=False, prompt_label="spotting",
                               temperature=0, max_new_tokens=8192, max_pixels=1605632)
    spot = single_result(results).get("spotting_res", {})
    polys, texts = spot.get("rec_polys", []), spot.get("rec_texts", [])
    if not isinstance(polys, (list, tuple)) or not isinstance(texts, (list, tuple)) or len(polys) != len(texts):
        raise WorkerError("OCR_RESULT")
    if not texts:
        warnings["OCR_TEXT_NOT_LOCATED"] += 1
    units = []
    for points, text in zip(polys, texts):
        if isinstance(text, (list, tuple)):
            text = text[0] if text else ""
        if not isinstance(text, str):
            raise WorkerError("OCR_RESULT")
        if not translatable(text):
            if is_formula(text) and len(re.findall(r"[A-Za-z]{3,}", text)) > 1:
                warnings["TEXT_UNTRANSLATED"] += 1
            continue
        try:
            coords = [(float(p[0]) / sx + x0 / sx, float(p[1]) / sy + y0 / sy) for p in points]
            value = [min(p[0] for p in coords), min(p[1] for p in coords),
                     max(p[0] for p in coords), max(p[1] for p in coords)]
        except (ValueError, TypeError, IndexError):
            warnings["OCR_BOX_INVALID"] += 1
            continue
        rect = checked_rect(value, bounds, warnings)
        if rect is None or any(overlap(rect, area) > 0.1 for area in protected):
            continue
        if any(overlap(rect, unit["rect"]) > 0.4 or overlap(unit["rect"], rect) > 0.7 for unit in native):
            continue
        direction = (coords[1][0] - coords[0][0], coords[1][1] - coords[0][1])
        rotation = direction_rotation(direction)
        # shortcut: spotting 不帶字形朝向；長窄單一英文詞依常見圖表縱軸轉 90°。
        if (rotation == 0 and rect.height > rect.width * 2.5 and len(text) <= 40
                and re.fullmatch(r"[A-Za-z][A-Za-z0-9%/_-]{2,}", text)):
            rotation = 90
        if rotation is None:
            warnings["TEXT_ROTATION_UNSUPPORTED"] += 1
            continue
        size = min(24, max(MIN_FONT_SIZE, (rect.width if rotation in (90, 270) else rect.height) * 0.8))
        units.append({"text": text, "rect": rect, "size": size, "color": 0,
                      "flags": 0, "rotate": rotation, "raster": True})
    return units


def collect_units(page, pipeline, warnings):
    image, sx, sy = page_image(page)
    blocks = parse_layout(pipeline, image, sx, sy, page.rect, warnings)
    protected = [b["rect"] for b in blocks if "formula" in b["label"] or b["label"] == "seal"]
    native = native_units(page, protected, warnings)
    units = native[:]
    regions = [b["rect"] for b in blocks if "formula" not in b["label"] and b["label"] != "seal"]
    if not regions and not native:
        regions = [page.rect]
    for region in regions:
        # 原生文字足夠時，表格和圖表依逐行框替換，不整塊覆蓋。
        covered = sum((unit["rect"] & region).get_area() for unit in native)
        if covered > region.get_area() * 0.25:
            continue
        for part in text_regions(region, protected):
            found = spotting_units(pipeline, image, part, sx, sy, page.rect, protected, units, warnings)
            units.extend(found)
    return group_paragraphs(units, blocks, protected), image, sx, sy


def group_paragraphs(units, blocks, protected):
    grouped, used = [], set()
    for block in blocks:
        if block["label"] not in ("text", "paragraph", "content", "reference_content", "abstract"):
            continue
        indices = [i for i, unit in enumerate(units) if i not in used
                   and unit["rotate"] == 0 and overlap(unit["rect"], block["rect"]) > 0.95]
        if len(indices) < 2:
            continue
        selected = [units[i] for i in indices]
        first = selected[0]
        if any(u["raster"] != first["raster"] or u["flags"] != first["flags"]
               or u["color"] != first["color"] or abs(u["size"] - first["size"]) > 1.5 for u in selected):
            continue
        rect = fitz.Rect(first["rect"])
        for unit in selected[1:]:
            rect |= unit["rect"]
        if any(not (rect & area).is_empty for area in protected):
            continue
        ordered = sorted(selected, key=lambda u: (round(u["rect"].y0 / 3), u["rect"].x0))
        grouped.append({**first, "rect": rect, "text": " ".join(u["text"].strip() for u in ordered),
                        "erase_rects": [u["rect"] for u in selected]})
        used.update(indices)
    return grouped + [unit for i, unit in enumerate(units) if i not in used]


def background_color(image, rect, sx, sy):
    import numpy as np
    x0, y0 = max(0, int(rect.x0 * sx) - 1), max(0, int(rect.y0 * sy) - 1)
    x1, y1 = min(image.shape[1] - 1, int(rect.x1 * sx) + 1), min(image.shape[0] - 1, int(rect.y1 * sy) + 1)
    border = np.concatenate((image[y0, x0:x1 + 1], image[y1, x0:x1 + 1],
                             image[y0:y1 + 1, x0], image[y0:y1 + 1, x1]))
    return tuple(float(v) / 255 for v in np.median(border, axis=0)[::-1])


def text_html(text, unit, target):
    color = unit["color"]
    style = f"margin:0;padding:0;font-family:sans-serif;font-size:{unit['size']}pt;line-height:1;color:#{color:06x};"
    if unit["flags"] & 16:
        style += "font-weight:bold;"
    if unit["flags"] & 2:
        style += "font-style:italic;"
    return f'<div lang="{html.escape(target, quote=True)}" style="{style}">{html.escape(text).replace(chr(10), "<br>")}</div>'


def prepare_translation(unit, translated, target, warnings):
    rect = unit["rect"]
    markup = text_html(translated, unit, target)
    scale_low = min(1, max(0.5, MIN_FONT_SIZE / unit["size"]))
    with fitz.open() as probe:
        test_page = probe.new_page(width=max(rect.x1 + 1, 10), height=max(rect.y1 + 1, 10))
        spare, scale = test_page.insert_htmlbox(rect, markup, scale_low=scale_low, rotate=unit["rotate"])
    if spare < 0:
        warnings["TEXT_OVERFLOW_ORIGINAL_KEPT"] += 1
        return None
    if scale < 0.75:
        warnings["TEXT_SHRUNK"] += 1
    return {**unit, "markup": markup, "scale_low": scale_low}


def replace_units(page, units, image, sx, sy):
    # 不移除向量線條。掃描頁只擦每段文字的像素，公式框不在 units 中。
    for raster in (False, True):
        selected = [u for u in units if u["raster"] == raster]
        for unit in selected:
            for rect in unit.get("erase_rects", [unit["rect"]]):
                fill = background_color(image, rect, sx, sy) if raster else None
                page.add_redact_annot(rect, fill=fill, cross_out=False)
        if selected:
            page.apply_redactions(images=2 if raster else 0, graphics=0, text=0)
    for unit in units:
        spare, _ = page.insert_htmlbox(unit["rect"], unit["markup"],
                                      scale_low=unit["scale_low"], rotate=unit["rotate"])
        if spare < 0:
            raise WorkerError("PDF_WRITE")


def request_translation(stdin, stdout, request_id, text):
    emit(stdout, {"type": "translate", "id": request_id, "text": text})
    reply = read_message(stdin)
    if reply.get("id") != request_id or reply.get("error"):
        raise WorkerError("TRANSLATION")
    translated = reply.get("text")
    if not isinstance(translated, str) or not translated.strip() or len(translated) > 200000:
        raise WorkerError("TRANSLATION")
    # 上游偶發孤立替代字（無效 UTF-8）；PyMuPDF 寫不進去，整段放棄更糟，換成 �。
    translated = "".join("\ufffd" if "\ud800" <= char <= "\udfff" else char for char in translated)
    return translated.strip()


def append_page(path, page_doc, first):
    if first:
        page_doc.save(path, deflate=True)
    else:
        # 重新開啟磁碟上的輸出，避免長文件把所有頁面影像留在記憶體。
        with fitz.open(path) as output:
            output.insert_pdf(page_doc)
            output.saveIncr()


def preserve_navigation(source, path):
    with fitz.open(path) as output:
        output.set_metadata(source.metadata)
        output.set_toc(source.get_toc(simple=False))
        labels = source.get_page_labels()
        if labels:
            output.set_page_labels(labels)
        # insert_pdf 逐頁複製不會保留跨頁連結，在所有目標頁存在後補回。
        for index in range(source.page_count):
            original, target = source[index], output[index]
            goto = [link for link in original.get_links() if link["kind"] == fitz.LINK_GOTO and link.get("page", -1) >= 0]
            for link in target.get_links():
                if link["kind"] == fitz.LINK_GOTO:
                    target.delete_link(link)
            for link in goto:
                value = {**link, "from": link["from"] * original.rotation_matrix}
                destination = source[link["page"]]
                if "to" in value:
                    value["to"] = value["to"] * destination.rotation_matrix
                target.insert_link(value)
        output.saveIncr()


def run(config, stdin, stdout, pipeline=None):
    validate_config(config)
    warnings = Counter()
    translated_count = 0
    # 圖片先轉成單頁 PDF：後面的逐頁複製、連結保留都只認 PDF。
    with contextlib.ExitStack() as stack:
        original = stack.enter_context(fitz.open(config["inputPath"]))
        if original.needs_pass or original.page_count == 0 or (not original.is_pdf and original.page_count != 1):
            raise WorkerError("PDF_UNSUPPORTED")
        source = original if original.is_pdf else stack.enter_context(
            fitz.open(stream=original.convert_to_pdf(), filetype="pdf"))
        pages = source.page_count
        emit(stdout, {"type": "progress", "page": 0, "pages": pages, "stage": "opening"})
        pipeline = pipeline if pipeline is not None else create_pipeline(config)
        for index in range(pages):
            emit(stdout, {"type": "progress", "page": index + 1, "pages": pages, "stage": "ocr"})
            with fitz.open() as single:
                single.insert_pdf(source, from_page=index, to_page=index)
                page = single[0]
                if any(annot.type[0] == fitz.PDF_ANNOT_REDACT for annot in page.annots() or []):
                    raise WorkerError("PDF_UNSUPPORTED")
                if page.rotation:
                    page.remove_rotation()
                units, image, sx, sy = collect_units(page, pipeline, warnings)
                ready = []
                emit(stdout, {"type": "progress", "page": index + 1, "pages": pages, "stage": "translate"})
                for number, unit in enumerate(units):
                    translated = request_translation(stdin, stdout, f"{index + 1}:{number}", unit["text"])
                    if translated == unit["text"].strip():
                        warnings["TEXT_UNTRANSLATED"] += 1
                        continue
                    result = prepare_translation(unit, translated, config["targetLang"], warnings)
                    if result is not None:
                        ready.append(result)
                emit(stdout, {"type": "progress", "page": index + 1, "pages": pages, "stage": "render"})
                replace_units(page, ready, image, sx, sy)
                translated_count += len(ready)
                emit(stdout, {"type": "progress", "page": index + 1, "pages": pages, "stage": "saving"})
                append_page(config["outputPath"], single, index == 0)
        preserve_navigation(source, config["outputPath"])
    codes = {"TEXT_OVERFLOW_ORIGINAL_KEPT": "overflow", "OCR_TEXT_NOT_LOCATED": "untranslated",
             "TEXT_UNTRANSLATED": "untranslated", "TEXT_ROTATION_UNSUPPORTED": "unsupported",
             "OCR_BOX_INVALID": "spotting", "TEXT_SHRUNK": "small_text"}
    counts = Counter()
    for code, count in warnings.items():
        counts[codes[code]] += count
    emit(stdout, {"type": "done", "pages": pages, "translatedBlocks": translated_count,
                  "warnings": [{"code": code, "count": count} for code, count in sorted(counts.items())]})


def main():
    stdin = sys.stdin
    stdout = _JSONL or sys.stdout
    if _JSONL is None:
        if hasattr(stdin, "reconfigure"):
            stdin.reconfigure(encoding="utf-8")
            stdout.reconfigure(encoding="utf-8", newline="\n")
        # 原生 Paddle 的 printf 也要導走；保留另一個 fd 專供 JSONL。
        stdout = os.fdopen(os.dup(stdout.fileno()), "w", encoding="utf-8", newline="\n", buffering=1)
        os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
    try:
        config = read_message(stdin)
        with contextlib.redirect_stdout(sys.stderr):
            run(config, stdin, stdout)
    except WorkerError as error:
        emit(stdout, {"type": "error", "code": error.code, "message": "PDF 翻譯未完成。"})
        return 1
    except Exception:
        # 第三方錯誤可能含文件內容、路徑或 API key，不穿過協定。
        emit(stdout, {"type": "error", "code": "WORKER_FAILED", "message": "PDF 翻譯未完成。"})
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
