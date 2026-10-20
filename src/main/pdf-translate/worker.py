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
    if (config["ocrModel"] != "paddleocrvl16" or len(config["targetLang"]) > 80
            or config.get("layoutDevice", "cpu") not in ("cpu", "gpu")):
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
    pages = config.get("pages")
    if pages is not None and (not isinstance(pages, list) or not 0 < len(pages) <= 50 or not all(
            isinstance(r, list) and len(r) == 2 and all(type(n) is int for n in r)
            and r[0] >= 1 and (r[1] == 0 or r[1] >= r[0]) for r in pages)):
        raise WorkerError("CONFIG")
    if not isinstance(config.get("dual", False), bool):
        raise WorkerError("CONFIG")
    source = os.path.realpath(config["inputPath"])
    target = os.path.realpath(config["outputPath"])
    if source == target or not os.path.isfile(source) or os.path.exists(target):
        raise WorkerError("PATH")
    if not os.path.isdir(config["layoutDir"]):
        raise WorkerError("LAYOUT_MISSING")


def create_layout(config):
    # 版面只要框和標籤；整頁 VL 辨識每一塊很慢，原生文字頁根本用不到。
    from paddleocr import LayoutDetection
    # GPU 版執行環境：版面偵測走顯示卡（約快 45 倍）；顯示卡起不來就退回 CPU，GPU 版的 Paddle 也能跑 CPU
    if config.get("layoutDevice") == "gpu":
        try:
            return LayoutDetection(model_name="PP-DocLayoutV3", model_dir=config["layoutDir"], device="gpu")
        except Exception:  # noqa: BLE001
            pass
    return LayoutDetection(model_name="PP-DocLayoutV3", model_dir=config["layoutDir"], device="cpu")


class LazyPipeline:
    """只有遇到沒有原生文字的區塊（掃描頁、圖）才載入 VL 辨識。"""

    def __init__(self, config):
        self.config = config
        self.value = None

    def predict(self, *args, **kwargs):
        if self.value is None:
            self.value = create_pipeline(self.config)
        return self.value.predict(*args, **kwargs)


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


# 拉丁字母要連續 3 個以上才算詞；t、P、dx、x y z 這類數學變數送去翻只會原樣回來。
# 希臘字母同理視為符號；中日韓等其他文字一個字就有意義。
WORD = re.compile(r"[A-Za-z\u00C0-\u024F]{3,}|[^\W\d_A-Za-z\u00C0-\u024F\u0370-\u03FF]")


# 函數名（cos、exp）與微分（dx、Mdx、ydy）也有三個字母，但翻了會變成「餘弦」「經驗」「好的」。
MATH_TOKEN = re.compile(r"(?:(?:arc)?(?:sin|cos|tan|cot|sec|csc)h?|exp|log|ln|lim|max|min|det|sup|inf|arg"
                        r"|[A-Za-z]{0,3}d[rstuvxyz])\s*\(?")


def translatable(text):
    # 每個詞都是數學記號（「, sin」「cos x, exp」）就整段不翻：數學一律留原樣
    words = [word for word in WORD.findall(text) if not MATH_TOKEN.fullmatch(word)]
    return bool(words) and not is_formula(text)


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
    units, kept = [], []
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
                    if text.strip():
                        kept.append(rect)
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
            for unit in runs:
                if unit and translatable(unit["text"]):
                    units.append(unit)
                elif unit:
                    kept.append(unit["rect"])
    # kept：留在頁面上的原文（變數、公式字），段落合併不能蓋到它們。
    return units, kept


def page_image(page):
    scale = min(2.0, math.sqrt(MAX_PAGE_PIXELS / max(1, page.rect.get_area())))
    pix = page.get_pixmap(matrix=fitz.Matrix(scale, scale), colorspace=fitz.csRGB, alpha=False)
    import numpy as np
    image = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, 3)
    return image[:, :, ::-1].copy(), pix.width / page.rect.width, pix.height / page.rect.height


def parse_layout(layout, image, sx, sy, bounds, warnings):
    raw = single_result(layout.predict(image)).get("boxes")
    if not isinstance(raw, list):
        raise WorkerError("OCR_RESULT")
    blocks = []
    for block in raw:
        if not isinstance(block, dict) or not isinstance(block.get("label"), str):
            raise WorkerError("OCR_RESULT")
        bbox = block.get("coordinate", [])
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
            blocks.append({"rect": rect, "label": block["label"]})
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
        # 公式與數學記號刻意保留，不算沒翻到
        if not translatable(text):
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


def collect_units(page, layout, pipeline, warnings):
    image, sx, sy = page_image(page)
    blocks = parse_layout(layout, image, sx, sy, page.rect, warnings)
    protected = [b["rect"] for b in blocks if "formula" in b["label"] or b["label"] == "seal"]
    native, kept = native_units(page, protected, warnings)
    units = native[:]
    regions = [b["rect"] for b in blocks if "formula" not in b["label"] and b["label"] != "seal"]
    if not regions and not native:
        regions = [page.rect]
    for region in regions:
        # 有文字層的區塊以原生文字為準（含留著的數學字）；OCR 只補掃描頁和圖片，
        # 否則 OCR 結果會蓋在原文與公式上，又慢又擠。
        if any(not (rect & region).is_empty for rect in [u["rect"] for u in native] + kept):
            continue
        for part in text_regions(region, protected):
            found = spotting_units(pipeline, image, part, sx, sy, page.rect, protected, units, warnings)
            units.extend(found)
    grouped = group_paragraphs(units, blocks, protected + kept)
    # 跟公式／變數同一行的片段（Linear independence of ＋ n ＋ functions）：
    # 數學字位置固定，合併翻時模型會為了整句通順搬字，這種要各自單獨翻
    # 不附整行原文當上下文：實測模型會把公式也翻進去（n 重複、冒出 $n$）
    # inline＝第幾行：同一行被公式切開的片段不能放進同一批合併翻，不同行的可以
    same_line = lambda a, b: min(a.y1, b.y1) - max(a.y0, b.y0) > min(a.height, b.height) * 0.5  # noqa: E731
    lines = []
    for unit in grouped:
        rect = unit["rect"]
        if not any(same_line(r, rect) for r in protected + kept):
            continue
        unit["inline"] = next((index for index, line in enumerate(lines) if same_line(line, rect)), len(lines))
        if unit["inline"] == len(lines):
            lines.append(rect)
    return grouped, image, sx, sy


def group_paragraphs(units, blocks, protected):
    grouped, used = [], set()
    for block in blocks:
        if block["label"] not in ("text", "paragraph", "content", "reference_content", "abstract"):
            continue
        indices = [i for i, unit in enumerate(units) if i not in used
                   and unit["rotate"] == 0 and overlap(unit["rect"], block["rect"]) > 0.95]
        if len(indices) == 1:
            # body：正文段落，跨欄／跨頁接段只看這種
            units[indices[0]]["body"] = True
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
                        "erase_rects": [u["rect"] for u in selected], "body": True})
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


def room_right(page, units):
    """每段橫排原生文字右邊還能用到哪裡：同一行下一個字、包住它的框線、頁面右邊界（跟左邊界對稱）。"""
    words = [fitz.Rect(w[:4]) for w in page.get_text("words")]
    drawings = [d["rect"] for d in page.get_drawings() if d["rect"].width > 4 and d["rect"].height > 4]
    left = min((w.x0 for w in words), default=36)
    edge = page.rect.x1 - max(18, left)
    rooms = []
    for unit in units:
        rect = unit["rect"]
        if unit["raster"] or unit["rotate"]:
            rooms.append(None)
            continue
        same_line = lambda r: min(r.y1, rect.y1) - max(r.y0, rect.y0) > rect.height * 0.3  # noqa: E731
        right = min([w.x0 for w in words if same_line(w) and w.x0 >= rect.x1 - 1] + [edge])
        # 圖框裡的標籤不能長出框外
        right = min([d.x1 for d in drawings if d.contains(rect)] + [right])
        rooms.append(right - 2 if right - 2 > rect.x1 + 1 else None)
    return rooms


def fit(rect, markup, scale_low, rotate):
    with fitz.open() as probe:
        test_page = probe.new_page(width=max(rect.x1 + 1, 10), height=max(rect.y1 + 1, 10))
        return test_page.insert_htmlbox(rect, markup, scale_low=scale_low, rotate=rotate)


def prepare_translation(unit, translated, target, warnings, right=None):
    rect = unit["rect"]
    markup = text_html(translated, unit, target)
    scale_low = min(1, max(0.5, MIN_FONT_SIZE / unit["size"]))
    boxes = [rect] + ([fitz.Rect(rect.x0, rect.y0, right, rect.y1)] if right else [])
    # 先原框、再往右延伸；都放不下就縮到 3pt，寧可字小也不保留原文（3pt 還放不下＝譯文長得不合理）
    for box in boxes:
        spare, scale = fit(box, markup, scale_low, unit["rotate"])
        if spare >= 0 and scale >= 0.75:
            return {**unit, "box": box, "markup": markup, "scale_low": scale_low}
    floor = min(scale_low, 3 / unit["size"])
    spare, scale = fit(boxes[-1], markup, floor, unit["rotate"])
    if spare < 0:
        warnings["TEXT_OVERFLOW_ORIGINAL_KEPT"] += 1
        return None
    if scale < 0.75:
        warnings["TEXT_SHRUNK"] += 1
    return {**unit, "box": boxes[-1], "markup": markup, "scale_low": floor}


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
        spare, _ = page.insert_htmlbox(unit.get("box", unit["rect"]), unit["markup"],
                                      scale_low=unit["scale_low"], rotate=unit["rotate"])
        if spare < 0:
            raise WorkerError("PDF_WRITE")


# 句子沒寫完的結尾：沒有句號類標點（含引號、括號收尾）
SENTENCE_END = re.compile(r"[.!?:;。！？：；…\"”’)\]）」]\s*$")
CUT_AFTER = "，。、；：！？,.;:!?)）」 "


def continues(first, second):
    """first 的句子沒寫完、second 小寫開頭：同一段被換欄或換頁切開"""
    return (first["flags"] == second["flags"] and abs(first["size"] - second["size"]) < 1
            and not SENTENCE_END.search(first["text"]) and bool(re.match(r"[a-z]", second["text"].lstrip())))


def column_ends(units):
    """每一欄最上面和最底下的正文段落（跟公式同一行、掃描、旋轉的不接）"""
    body = [n for n, u in enumerate(units) if u.get("body") and "inline" not in u and not u["raster"] and not u["rotate"]]
    same_column = lambda a, b: min(a.x1, b.x1) - max(a.x0, b.x0) > 0  # noqa: E731
    ends = []
    for higher in (False, True):
        ends.append([n for n in body if not any(
            m != n and same_column(units[n]["rect"], units[m]["rect"])
            and (units[m]["rect"].y0 < units[n]["rect"].y0 if higher else units[m]["rect"].y0 > units[n]["rect"].y0)
            for m in body)])
    bottoms, tops = ends
    return bottoms, tops


def column_joins(units):
    """{左欄最後一段: 右欄第一段}；不串成鏈（A→B→C 的 B 已經併進 A，就不能再帶 C）"""
    bottoms, tops = column_ends(units)
    joins = {}
    for first in bottoms:
        right = [n for n in tops if units[n]["rect"].x0 >= units[first]["rect"].x1 - 2]
        if not right:
            continue
        second = min(right, key=lambda n: units[n]["rect"].x0)
        if (first not in joins.values() and second not in joins and second not in joins.values()
                and continues(units[first], units[second])):
            joins[first] = second
    return joins


def page_end(units, joins, last):
    """last：這頁最後一段（最右欄最底下）；否則第一段（最左欄最上面）。已經在欄間接段的不算"""
    bottoms, tops = column_ends(units)
    linked = set(joins) | set(joins.values())
    candidates = [n for n in (bottoms if last else tops) if n not in linked]
    if not candidates:
        return None
    if last:
        return max(candidates, key=lambda n: (units[n]["rect"].x0, units[n]["rect"].y1))
    return min(candidates, key=lambda n: (units[n]["rect"].x0, units[n]["rect"].y0))


def joined(first, second):
    left, right = first["text"].rstrip(), second["text"].lstrip()
    return left[:-1] + right if left.endswith("-") else f"{left} {right}"


def split_translation(first, second, translated):
    """兩段接起來翻的譯文切回兩邊：照原文長度比例，在最近的標點或空白下刀"""
    if translated == joined(first, second).strip():
        return first["text"].strip(), second["text"].strip()
    a, b = len(first["text"].strip()), len(second["text"].strip())
    target = round(len(translated) * a / max(1, a + b))
    window = max(2, len(translated) // 5)
    cuts = [i for i in range(max(1, target - window), min(len(translated) - 1, target + window) + 1)
            if translated[i - 1] in CUT_AFTER]
    cut = min(cuts, key=lambda i: abs(i - target)) if cuts else min(max(1, target), len(translated) - 1)
    head, tail = translated[:cut].strip(), translated[cut:].strip()
    # 譯文太短切不開：整句放前一段，後一段保留原文
    return (head, tail) if head and tail else (translated, second["text"].strip())


def document_title(source):
    """論文標題給模型判斷領域：metadata 的標題可信就用，否則第一頁字最大的那幾段"""
    title = (source.metadata or {}).get("title", "").strip()
    if 4 <= len(title) <= 300 and not re.search(r"\.(docx?|pdf|tex|dvi)$|^untitled|^microsoft", title, re.I):
        return title
    spans = [(span["size"], span["text"].strip()) for block in source[0].get_text("dict")["blocks"]
             for line in block.get("lines", []) for span in line["spans"] if span["text"].strip()]
    if not spans:
        return ""
    sizes = sorted(size for size, _ in spans)
    biggest = sizes[-1]
    if biggest < sizes[len(sizes) // 2] * 1.3:
        return ""
    return " ".join(text for size, text in spans if size >= biggest - 0.5)[:300]


def document_sample(source, chosen, limit=30000):
    """抽術語用的原文：選定頁面的文字層（掃描頁沒有，就少一點）"""
    parts, size = [], 0
    for index in sorted(chosen):
        if size >= limit:
            break
        text = source[index].get_text().strip()
        parts.append(text)
        size += len(text)
    return "\n".join(parts)[:limit]


def chosen_pages(ranges, count):
    if not ranges:
        return set(range(count))
    chosen = {index for start, end in ranges for index in range(start - 1, min(end or count, count))}
    if not chosen:
        raise WorkerError("PAGES")
    return chosen


def interleave(source, translated_path, final, chosen):
    """雙語對照：原文頁後面接譯文頁，沒選的頁只放原文。書籤指到譯文頁；跨頁連結、頁碼標籤不保留"""
    with fitz.open(translated_path) as translated, fitz.open() as dual:
        target = {}
        for index in range(source.page_count):
            dual.insert_pdf(source, from_page=index, to_page=index, links=False)
            if index in chosen:
                dual.insert_pdf(translated, from_page=index, to_page=index, links=False)
            target[index + 1] = dual.page_count
        dual.set_metadata(source.metadata)
        dual.set_toc([[level, title, target.get(page, page)] for level, title, page in source.get_toc(simple=True)])
        dual.save(final, garbage=4, deflate=True)


SHORT_TEXT = 80
REFERENCE_CHARS = 1500


class Translations:
    """一頁的請求一次送出，main 並行翻譯，回覆順序不固定，依 id 對回。

    可以先送下一頁的請求再收這一頁的回覆：別頁的回覆先收著，輪到那頁再取。
    """

    def __init__(self, stdin, stdout):
        self.stdin, self.stdout = stdin, stdout
        self.pending, self.done = set(), {}

    def request(self, page_number, texts, alone=None, numbers=None):
        """alone：{編號: 第幾行}，跟公式同一行的片段；同一行的不放進同一批合併翻。
        numbers：每段的編號（預設 0、1、2…）；接段時有些段落不另外送，編號會跳號"""
        numbers = list(range(len(texts))) if numbers is None else numbers
        ids = [f"{page_number}:{number}" for number in numbers]
        alone = alone or {}
        # 圖框標籤這類短詞單獨翻會亂猜詞義（Physical System→身體的系統）；附整頁原文給模型參考。
        reference = "\n".join(texts)[:REFERENCE_CHARS]
        for number, request_id, text in zip(numbers, ids, texts):
            message = {"type": "translate", "id": request_id, "text": text}
            if number in alone:
                message["alone"] = True
                message["line"] = alone[number]
            if len(text) < SHORT_TEXT and len(reference) > len(text):
                message["reference"] = reference
            emit(self.stdout, message)
            self.pending.add(request_id)
        return ids

    def collect(self, ids):
        while any(request_id not in self.done for request_id in ids):
            reply = read_message(self.stdin)
            request_id = reply.get("id")
            if request_id not in self.pending or reply.get("error"):
                raise WorkerError("TRANSLATION")
            translated = reply.get("text")
            if not isinstance(translated, str) or not translated.strip() or len(translated) > 200000:
                raise WorkerError("TRANSLATION")
            self.pending.discard(request_id)
            # 上游偶發孤立替代字（無效 UTF-8）；PyMuPDF 寫不進去，整段放棄更糟，換成 U+FFFD。
            self.done[request_id] = "".join("\ufffd" if "\ud800" <= char <= "\udfff" else char
                                            for char in translated).strip()
        return [self.done.pop(request_id) for request_id in ids]


def request_translations(stdin, stdout, page_number, texts):
    translations = Translations(stdin, stdout)
    return translations.collect(translations.request(page_number, texts))


def append_page(path, page_doc, first):
    # 每段譯文各帶一份完整中文字型（約 3.5 MB）；先子集化，最後再去重。
    page_doc.subset_fonts()
    if first:
        page_doc.save(path, garbage=3, deflate=True)
    else:
        # 重新開啟磁碟上的輸出，避免長文件把所有頁面影像留在記憶體。
        with fitz.open(path) as output:
            output.insert_pdf(page_doc)
            output.saveIncr()


def preserve_navigation(source, path, final):
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
        # 逐頁增量存檔會留下舊版物件；最後整份重寫並合併相同字型。
        output.save(final, garbage=4, deflate=True)


def run(config, stdin, stdout, pipeline=None, layout=None):
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
        chosen = chosen_pages(config.get("pages"), pages)
        emit(stdout, {"type": "progress", "page": 0, "pages": pages, "stage": "opening"})
        # 標題與原文樣本先送：main 趁版面偵測時抽術語
        emit(stdout, {"type": "document", "title": document_title(source), "sample": document_sample(source, chosen)})
        layout = layout if layout is not None else create_layout(config)
        pipeline = pipeline if pipeline is not None else LazyPipeline(config)
        partial = config["outputPath"] + ".pages"
        translations = Translations(stdin, stdout)

        def open_page(index):
            emit(stdout, {"type": "progress", "page": index + 1, "pages": pages, "stage": "ocr"})
            # 出錯時整個 worker 結束，不另外關這份暫存文件
            single = fitz.open()
            single.insert_pdf(source, from_page=index, to_page=index)
            page = single[0]
            if any(annot.type[0] == fitz.PDF_ANNOT_REDACT for annot in page.annots() or []):
                raise WorkerError("PDF_UNSUPPORTED")
            state = {"page": index + 1, "single": single, "units": [], "joins": {}, "tail": None, "head": None,
                     "next": None, "image": None, "sx": 1, "sy": 1, "ids": [], "numbers": [], "texts": {}}
            # 沒選的頁照原樣輸出
            if index not in chosen:
                return state
            if page.rotation:
                page.remove_rotation()
            units, state["image"], state["sx"], state["sy"] = collect_units(page, layout, pipeline, warnings)
            state["units"], state["joins"] = units, column_joins(units)
            # 最後一段句子沒寫完，先不送，等下一頁開好看第一段是不是接著寫
            tail = page_end(units, state["joins"], True) if index + 1 < pages else None
            state["tail"] = tail if tail is not None and not SENTENCE_END.search(units[tail]["text"]) else None
            return state

        def send(state, before):
            """before＝上一頁：它最後一段跟這頁第一段是同一段就接起來翻，這頁不另送第一段"""
            units = state["units"]
            if before is not None and before["tail"] is not None:
                tail = before["units"][before["tail"]]
                head = page_end(units, state["joins"], False) if units else None
                if head is not None and (head == state["tail"] or not continues(tail, units[head])):
                    head = None
                text = joined(tail, units[head]) if head is not None else tail["text"]
                before["ids"] += translations.request(before["page"], [text], None, [before["tail"]])
                before["numbers"].append(before["tail"])
                before["next"], state["head"] = head, head
            skip = set(state["joins"].values()) | {state["tail"], state["head"]}
            numbers = [n for n in range(len(units)) if n not in skip]
            texts = [joined(units[n], units[state["joins"][n]]) if n in state["joins"] else units[n]["text"] for n in numbers]
            state["ids"] = translations.request(state["page"], texts,
                                                {n: units[n]["inline"] for n in numbers if "inline" in units[n]}, numbers)
            state["numbers"] = numbers

        def page_texts(state, after):
            """收這頁的譯文；接段的譯文切開，後半給右欄或下一頁的第一段"""
            texts = state["texts"]
            for number, translated in zip(state["numbers"], translations.collect(state["ids"])):
                partner = state["joins"].get(number)
                if partner is not None:
                    texts[number], texts[partner] = split_translation(state["units"][number], state["units"][partner], translated)
                elif number == state["tail"] and state["next"] is not None:
                    head = state["next"]
                    texts[number], after["texts"][head] = split_translation(state["units"][number], after["units"][head], translated)
                else:
                    texts[number] = translated
            if len(texts) != len(state["units"]):
                raise WorkerError("TRANSLATION")
            return [texts[n] for n in range(len(state["units"]))]

        upcoming = open_page(0)
        send(upcoming, None)
        for index in range(pages):
            current, upcoming = upcoming, None
            units, image, sx, sy = current["units"], current["image"], current["sx"], current["sy"]
            with current["single"] as single:
                page = single[0]
                # 這頁在等翻譯時先做下一頁的版面偵測，請求也先送出去，main 不會閒著
                if index + 1 < pages:
                    upcoming = open_page(index + 1)
                    send(upcoming, current)
                ready = []
                emit(stdout, {"type": "progress", "page": index + 1, "pages": pages, "stage": "translate"})
                texts = page_texts(current, upcoming)
                for unit, translated, right in zip(units, texts, room_right(page, units)):
                    if translated == unit["text"].strip():
                        # 縮寫、術語、程式碼（DEs、Top-K、zero-shot、"size": "small"）原樣保留是對的；
                        # 像一句話（三個以上一般英文字、不帶程式符號）才算沒翻到
                        if (len(re.findall(r"\b[a-z]{3,}\b", translated)) >= 3
                                and not re.search(r'[{}\[\]"_<>=]', translated)):
                            warnings["TEXT_UNTRANSLATED"] += 1
                        continue
                    result = prepare_translation(unit, translated, config["targetLang"], warnings, right)
                    if result is not None:
                        ready.append(result)
                emit(stdout, {"type": "progress", "page": index + 1, "pages": pages, "stage": "render"})
                replace_units(page, ready, image, sx, sy)
                translated_count += len(ready)
                emit(stdout, {"type": "progress", "page": index + 1, "pages": pages, "stage": "saving"})
                append_page(partial, single, index == 0)
        try:
            if config.get("dual"):
                interleave(source, partial, config["outputPath"], chosen)
            else:
                preserve_navigation(source, partial, config["outputPath"])
        finally:
            with contextlib.suppress(OSError):
                os.remove(partial)
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
    # main 用 -I 啟動會忽略 PYTHONIOENCODING；不指定就以系統碼頁（cp950）解譯文，PDF 變亂碼。
    if hasattr(stdin, "reconfigure"):
        stdin.reconfigure(encoding="utf-8")
    if _JSONL is None:
        if hasattr(stdout, "reconfigure"):
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
