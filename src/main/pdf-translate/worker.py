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
OCR_MAX_TOKENS = 8192
# 標題帶 <LEVEL1>～<LEVEL3>；跨欄接續的段落之間夾 <MERGE>（內容裡的標籤由 ocr_plain 清掉）
OCR_BLOCK = re.compile(r"<BLOCK>([a-z_]+)(?:<[A-Z0-9_]+>)*\[(\d+),\s*(\d+),\s*(\d+),\s*(\d+)\]<FORK>(.*?)(?=<BLOCK>|<PAGE>|\Z)", re.S)
# 公式、圖、頁碼留原樣；圖裡的字模型不輸出（內容是空的）；表格另外逐格處理（table_units）。
# other＝表格標題、資料來源這類（純圖形的 other 內容是空的，自然跳過）
OCR_TEXT_LABELS = {"text", "title", "header", "footer", "image_caption", "image_footnote", "page_footnote", "aside_text",
                   "other"}
# PP-DocLayoutV3 裡不是文字段落的區塊：原生文字頁上這些區域沒文字層也不必整頁 OCR
LAYOUT_NON_TEXT = {"chart", "image", "header_image", "footer_image", "seal", "table", "number", "formula_number"}


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
    if (config["ocrModel"] != "unlimitedocr2q8" or len(config["targetLang"]) > 80
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


class OcrClient:
    """Unlimited-OCR-2：整頁一張圖送 llama router（OpenAI 相容），回 `<BLOCK>類型[x0, y0, x1, y1]<FORK>內容`。"""

    def __init__(self, config):
        self.config = config

    def recognize(self, png):
        import base64
        import urllib.request
        endpoint = self.config["endpoint"]
        body = {"model": self.config["ocrModel"], "temperature": 0, "max_tokens": OCR_MAX_TOKENS, "stream": False,
                "messages": [{"role": "user", "content": [
                    {"type": "text", "text": "<PAGE>"},
                    {"type": "image_url", "image_url": {"url": "data:image/png;base64," + base64.b64encode(png).decode()}},
                    {"type": "text", "text": "Multi page parsing."}]}]}
        request = urllib.request.Request(endpoint["baseUrl"].rstrip("/") + "/chat/completions",
                                         data=json.dumps(body).encode("utf-8"),
                                         headers={"content-type": "application/json",
                                                  "authorization": "Bearer " + endpoint.get("apiKey", "")})
        # 只連本機 router：不走系統代理
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        try:
            with opener.open(request, timeout=900) as response:
                value = json.loads(response.read(MAX_MESSAGE + 1))
        except (OSError, ValueError):
            raise WorkerError("OCR_FAILED") from None
        choice = (value.get("choices") or [None])[0] if isinstance(value, dict) else None
        content = choice.get("message", {}).get("content") if isinstance(choice, dict) else None
        if not isinstance(content, str):
            raise WorkerError("OCR_RESULT")
        return content, choice.get("finish_reason") == "length"


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


LATEX_SYMBOLS = {"langle": "⟨", "rangle": "⟩", "hbar": "ℏ", "infty": "∞", "sum": "∑", "int": "∫", "oint": "∮",
                 "partial": "∂", "nabla": "∇", "cdot": "·", "times": "×", "pm": "±", "mp": "∓", "le": "≤", "leq": "≤",
                 "ge": "≥", "geq": "≥", "ne": "≠", "neq": "≠", "approx": "≈", "equiv": "≡", "propto": "∝", "sim": "∼",
                 "to": "→", "rightarrow": "→", "leftarrow": "←", "Rightarrow": "⇒", "sqrt": "√", "prime": "′",
                 "dagger": "†", "ldots": "…", "cdots": "⋯", "dots": "…", "in": "∈", "quad": " ", "qquad": " ",
                 "varepsilon": "ε", "vartheta": "ϑ", "varphi": "φ", "ell": "ℓ", "circ": "°", "degree": "°"}
# 上下標先寫成 ^(…)／_(…) 送去翻（純文字、模型會原樣留著），排版時才換成 <sup>／<sub>；
# 中文譯文常把括號改成全形，兩種都認
SCRIPT_MARK = re.compile(r"([\^_])[(（]([^()（）]{1,60})[)）]")
# 雲端模型（Gemini）會把 V_(0)、ℏ 改寫回 LaTeX 的 V_0、\hbar：譯文裡含 \指令 或 字母_數字 的英數串再轉一次。
# shortcut: 掃描頁裡真的反斜線路徑（C:\Users）也會被吃掉，遇到再收窄
LEFTOVER_LATEX = re.compile(r"[!-~]*(?:\\[A-Za-z]+|[A-Za-z][\^_]\{?[0-9])[!-~]*")
# 譯文裡用 $…$ 包起來的公式：內容要像公式（\指令、^、_、{，或不含空白的短式子），`$5 與 $10` 這種價錢不動
TRANSLATED_MATH = re.compile(r"\$\$(.+?)\$\$|\\\((.+?)\\\)|\$([^$\n]*?(?:\\[A-Za-z]|[\^_{])[^$\n]*?|[A-Za-z0-9.,/+\-=()]{1,12})\$", re.S)


def latex_command(match):
    import unicodedata
    name = match.group(1)
    if name in LATEX_SYMBOLS:
        return LATEX_SYMBOLS[name]
    try:
        return unicodedata.lookup(("GREEK CAPITAL LETTER " if name[0].isupper() else "GREEK SMALL LETTER ")
                                  + name.upper().replace("LAMBDA", "LAMDA"))
    except KeyError:
        return "" if name in ("left", "right", "big", "Big", "displaystyle", ",", ";", "!") else name


def script_html(text):
    """^(…)／_(…) → <sup>／<sub>（由內往外，e^(-iE_(n)t) 這種巢狀也行）；text 已經 html.escape 過"""
    for _ in range(3):
        text = SCRIPT_MARK.sub(lambda m: f"<{'sup' if m.group(1) == '^' else 'sub'}>{m.group(2)}"
                                         f"</{'sup' if m.group(1) == '^' else 'sub'}>", text)
    return text


def latex_plain(expr):
    """行內公式轉成可直接排進譯文的文字（PDF 文字框不能排 LaTeX）：⟨j^(2)⟩、∑_(j=0)^(∞) jP(j)、1/14。"""
    text = re.sub(r"\\(?:text|mathrm|mathbf|mathit|mathcal|operatorname|boldsymbol|mathbb)\s*\{([^{}]*)\}", r"\1", expr)
    for _ in range(3):
        text = re.sub(r"\\[dt]?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}",
                      lambda m: "/".join(p if len(p) <= 1 else f"({p})" for p in (m.group(1), m.group(2))), text)
    text = re.sub(r"\\([A-Za-z]+|[,;!])(?:\s+(?=\w))?", latex_command, text)
    text = re.sub(r"([\^_])\s*(?:\{([^{}]*)\}|([^\s(（]))", lambda m: f"{m.group(1)}({(m.group(2) or m.group(3)).strip()})", text)
    text = re.sub(r"\s+", " ", text.replace("{", "").replace("}", ""))
    return re.sub(r"\s+([⟩)\],.])", r"\1", text).strip()


def ocr_plain(text):
    """OCR 的 Markdown＋LaTeX → 純文字；回 (純文字, 拿掉公式後的文字)。"""
    text = re.sub(r"<[^>]+>", " ", text)
    text = re.sub(r"^\s*#+\s*", "", text.strip())
    # 粗體留成 **…** 一起送翻（模型會照搬），排版時換成 <b>；先換成私用字元，免得被下面的斜體規則吃掉
    text = re.sub(r"(\*\*|__)(.+?)\1", "\\2", text, flags=re.S)
    text = re.sub(r"(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?![\w*])", r"\1", text, flags=re.S)
    math = re.compile(r"\$\$(.+?)\$\$|\$(.+?)\$|\\\((.+?)\\\)", re.S)
    prose = math.sub(" ", text).replace("", "").replace("", "")
    plain = math.sub(lambda m: latex_plain(next(g for g in m.groups() if g is not None)), text)
    plain = plain.replace("", "**").replace("", "**")
    return re.sub(r"\s+", " ", plain).strip(), prose


def raster_metrics(image, rect, sx, sy):
    """掃描段落的版面：字級（每行墨水列高的中位數 × 0.85，雜點不算一行）、
    行距（相鄰行起點的距離 ÷ 字級）、首行有沒有縮排（第一行比其他行晚開始超過 0.8 字）。"""
    import numpy as np
    crop = image[max(0, int(rect.y0 * sy)):math.ceil(rect.y1 * sy), max(0, int(rect.x0 * sx)):math.ceil(rect.x1 * sx)]
    if crop.size == 0:
        return {"size": MIN_FONT_SIZE}
    gray = crop.mean(axis=2)
    dark = gray < np.median(gray) - 60
    ink = np.concatenate(([False], dark.mean(axis=1) > 0.01, [False]))
    edges = np.flatnonzero(ink[1:] != ink[:-1])
    lines = [(top, bottom) for top, bottom in zip(edges[::2], edges[1::2]) if bottom - top >= 3]
    # 變音符號（Ö 上的點）、標題旁的橫線也是一條墨水：比最高那行矮一半以上的不算一行
    tallest = max((bottom - top for top, bottom in lines), default=0)
    lines = [(top, bottom) for top, bottom in lines if bottom - top >= tallest * 0.4]
    if not lines:
        return {"size": min(24, max(MIN_FONT_SIZE, rect.height * 0.75))}
    size = min(24, max(MIN_FONT_SIZE, float(np.median([b - t for t, b in lines])) / sy * 0.85))
    if len(lines) < 2:
        return {"size": size}
    pitch = float(np.median(np.diff([top for top, _ in lines]))) / sy
    starts = [np.flatnonzero(dark[top:bottom].any(axis=0))[:1] for top, bottom in lines]
    starts = [int(x[0]) if len(x) else 0 for x in starts]
    return {"size": size, "leading": round(min(1.8, max(1.0, pitch / size)), 2),
            "indent": (starts[0] - min(starts[1:])) / sx > size * 0.8}


def whole_bold(raw):
    """整塊都包在 **…** 裡（OCR 把粗體標成 Markdown）"""
    return bool(re.fullmatch(r"\s*(?:#+\s*)?(\*\*|__)(?:(?!\1).)+\1\s*", raw, re.S))


def png_bytes(image):
    height, width = image.shape[:2]
    return fitz.Pixmap(fitz.csRGB, width, height, image[:, :, ::-1].tobytes(), False).tobytes("png")


TABLE_ROW = re.compile(r"<tr\b[^>]*>(.*?)</tr>", re.S | re.I)
TABLE_CELL = re.compile(r"<t[dh]\b([^>]*)>(.*?)</t[dh]>", re.S | re.I)


def table_cells(content):
    """OCR 的 <table> → ([{row, col, rows, cols, text, prose, bold}], 列數, 欄數)；colspan／rowspan 照 HTML 規則佔格"""
    cells, taken = [], set()
    for r, row in enumerate(TABLE_ROW.findall(content)):
        c = 0
        for attrs, inner in TABLE_CELL.findall(row):
            while (r, c) in taken:
                c += 1
            spans = []
            for name in ("rowspan", "colspan"):
                found = re.search(name + r"\s*=\s*[\"']?(\d+)", attrs, re.I)
                spans.append(max(1, min(50, int(found.group(1)))) if found else 1)
            taken.update((r + i, c + j) for i in range(spans[0]) for j in range(spans[1]))
            text, prose = ocr_plain(inner)
            cells.append({"row": r, "col": c, "rows": spans[0], "cols": spans[1], "text": text.replace("**", ""),
                          "prose": prose, "bold": whole_bold(inner)})
            c += spans[1]
    # 欄數取多數列的寬度：OCR 偶爾把一格拆成兩格（2 years｜10 months），那列標 odd，逐格換字時不動它
    row_width = Counter(r for r, _ in taken)
    widths = Counter(row_width.values())
    ncols = max(widths, key=lambda width: (widths[width], width)) if widths else 0
    cells = [{**cell, "odd": row_width[cell["row"]] > ncols or cell["col"] + cell["cols"] > ncols} for cell in cells]
    return cells, max((r + 1 for r, _ in taken), default=0), ncols


def ink_runs(mask):
    """布林陣列裡連續 True 的 [(起, 迄)]"""
    import numpy as np
    edges = np.flatnonzero(np.diff(np.concatenate(([0], mask.astype(np.int8), [0]))))
    return list(zip(edges[::2].tolist(), edges[1::2].tolist()))


def table_grid(image, rect, sx, sy, cells, nrows, ncols):
    """從掃描圖推每格的位置：欄界＝直線或最寬的 ncols-1 條直向空白；列界＝列間空白，
    有橫線的、下一行字佔比較多欄的優先（多行儲存格的第二行只佔一兩欄）。
    推出來的格要跟 OCR 內容對得上（有字的格有墨水、空格沒墨水），對不上回 None。
    回 [(cell, 格子框, 字的框或 None)]，PDF 座標"""
    import numpy as np
    left, top = max(0, int(rect.x0 * sx)), max(0, int(rect.y0 * sy))
    crop = image[top:math.ceil(rect.y1 * sy), left:math.ceil(rect.x1 * sx)]
    if crop.size == 0 or nrows < 1 or ncols < 1:
        return None
    gray = crop.mean(axis=2)
    dark = gray < np.median(gray) - 60
    # 格線＝夠長的連續墨水；只看比例的話，每列同一欄都有的字（M、F）疊起來也像直線
    longest = lambda line: max((b - a for a, b in ink_runs(line)), default=0)  # noqa: E731
    hline = np.array([longest(row) > dark.shape[1] * 0.3 for row in dark])
    vline = np.array([longest(col) > dark.shape[0] * 0.3 for col in dark.T])
    text = dark & ~hline[:, None] & ~vline[None, :]
    bands = [(t, b) for t, b in ink_runs(text.sum(axis=1) >= 2) if b - t >= 3]
    if len(bands) < nrows:
        return None
    line = float(np.median([b - t for t, b in bands]))
    per_band = np.array([text[t:b].any(axis=0) for t, b in bands])
    # 跨欄的表頭只佔少數幾行，不會把欄間空白填掉
    empty = (per_band.sum(axis=0) <= max(1, len(bands) * 0.1)) | vline
    gaps = [(a, b) for a, b in ink_runs(empty) if a > 0 and b < len(empty)]
    ranked = sorted(gaps, key=lambda g: (bool(vline[g[0]:g[1]].any()), g[1] - g[0]), reverse=True)
    gaps, rest = ranked[:ncols - 1], ranked[ncols - 1:]
    if len(gaps) < ncols - 1 or any(not vline[a:b].any() and b - a < line * 0.5 for a, b in gaps):
        return None
    # 沒用到的空白跟選上的差不多寬（或是一條直線）＝OCR 的欄數跟圖對不上，硬配會整欄錯位
    narrowest = min((b - a for a, b in gaps if not vline[a:b].any()), default=line * 2.5)
    if any(vline[a:b].any() or b - a > narrowest * 0.6 for a, b in rest):
        return None
    xs = [0] + sorted((a + b) / 2 for a, b in gaps) + [crop.shape[1]]
    touches = [sum(bool(row[int(xs[i]):int(xs[i + 1])].any()) for i in range(ncols)) for row in per_band]
    cuts = sorted(range(len(bands) - 1), reverse=True, key=lambda i: (
        bool(hline[bands[i][1]:bands[i + 1][0]].any()), touches[i + 1], bands[i + 1][0] - bands[i][1]))[:nrows - 1]
    ys = [0] + [(bands[i][1] + bands[i + 1][0]) / 2 for i in sorted(cuts)] + [crop.shape[0]]
    placed = []
    for cell in cells:
        if cell["odd"]:
            placed.append((cell, None, None))
            continue
        a, b = int(xs[cell["col"]]), int(xs[cell["col"] + cell["cols"]])
        c, d = int(ys[cell["row"]]), int(ys[cell["row"] + cell["rows"]])
        ys_, xs_ = np.nonzero(text[c:d, a:b])
        ink = None if len(xs_) < 3 else (a + xs_.min(), c + ys_.min(), a + xs_.max() + 1, c + ys_.max() + 1)
        if (ink is None) != (not cell["text"].strip()):
            return None
        pdf = lambda x0, y0, x1, y1: fitz.Rect((left + x0) / sx, (top + y0) / sy, (left + x1) / sx, (top + y1) / sy)  # noqa: E731
        placed.append((cell, pdf(a, c, b, d), ink and pdf(*ink)))
    # 整張表一個字級（跟 raster_metrics 同算法：一行墨水高 × 0.85）；逐格量的話有沒有 g、y 下伸字母就差一號
    return placed, min(24, max(MIN_FONT_SIZE, line / sy * 0.85))


def column_aligns(placed):
    """每欄的對齊：靠左、置中、靠右哪個在這欄最整齊（字的左緣、中心、右緣最一致）；分不出來就靠左"""
    import numpy as np
    edges = {}
    for cell, box, ink in placed:
        if box is not None and ink is not None and cell["cols"] == 1:
            edges.setdefault(cell["col"], []).append(
                (ink.x0 - box.x0, (ink.x0 + ink.x1 - box.x0 - box.x1) / 2, box.x1 - ink.x1))
    aligns = {}
    for col, values in edges.items():
        spread = dict(zip(("left", "center", "right"), np.ptp(np.array(values), axis=0).tolist()))
        best = min(spread.values())
        aligns[col] = next(name for name in ("left", "center", "right") if spread[name] <= best + 1)
    return aligns


def table_units(raw, rect, image, sx, sy):
    """掃描表格：格子推得出來就逐格換字（格線、底色都留著）；推不出來（合併格太亂、沒有空白可分）
    就整張表重排——每格照樣各自送翻，排版時再組回一張 HTML 表（見 prepare_table）"""
    cells, nrows, ncols = table_cells(raw)
    wanted = [n for n, cell in enumerate(cells) if cell["text"] and translatable(cell["prose"])]
    if not wanted:
        return []
    grid = table_grid(image, rect, sx, sy, cells, nrows, ncols)
    if grid is None:
        # 列跟列貼在一起時墨水量出來是好幾列高：字級不超過每列平均高度
        size = max(MIN_FONT_SIZE, min(raster_metrics(image, rect, sx, sy)["size"], rect.height / max(1, nrows) / 1.25))
        table = {"rect": rect, "cells": cells, "nrows": nrows, "size": size}
        return [{"text": cells[n]["text"], "rect": rect, "color": 0, "flags": 0, "rotate": 0, "raster": True,
                 "cell": True, "table": table, "index": n, "size": table["size"]} for n in wanted]
    placed, size = grid
    aligns = column_aligns(placed)
    units = []
    for n, (cell, box, ink) in enumerate(placed):
        if n not in wanted or box is None:
            continue
        align = aligns.get(cell["col"], "left") if cell["cols"] == 1 else "center"
        if align == "center":
            # 以原本字的中心為準，左右各留一樣寬
            middle = (ink.x0 + ink.x1) / 2
            half = max(ink.width / 2, min(middle - box.x0, box.x1 - middle) - 1)
            left, right = middle - half, middle + half
        else:
            left = ink.x0 - 0.5 if align == "left" else box.x0 + 1
            right = ink.x1 + 0.5 if align == "right" else box.x1 - 1
        units.append({"text": cell["text"], "rect": fitz.Rect(left, ink.y0 - 0.5, right, box.y1), "erase_rects": [ink],
                      "color": 0, "flags": 16 if cell["bold"] else 0, "rotate": 0, "raster": True, "cell": True,
                      "align": align, "size": size, "leading": 1.15})
    return units


def ocr_units(ocr, image, sx, sy, bounds, protected, native, regions, warnings):
    """整頁 OCR 一次；regions＝要補的區域（None＝整頁都沒文字層）"""
    content, cut = ocr.recognize(png_bytes(image))
    blocks = OCR_BLOCK.findall(content)
    if cut and blocks:
        # 達上限：最後一塊可能沒寫完
        blocks.pop()
        warnings["OCR_TEXT_NOT_LOCATED"] += 1
    units = []
    for label, x0, y0, x1, y1, raw in blocks:
        if label not in OCR_TEXT_LABELS and label != "table":
            continue
        value = [bounds.x0 + int(x0) / 1000 * bounds.width, bounds.y0 + int(y0) / 1000 * bounds.height,
                 bounds.x0 + int(x1) / 1000 * bounds.width, bounds.y0 + int(y1) / 1000 * bounds.height]
        rect = checked_rect(value, bounds, warnings)
        if (rect is None or (regions is not None and not any(overlap(rect, r) > 0.5 for r in regions))
                or any(overlap(rect, area) > 0.5 for area in protected)
                or any(overlap(rect, u["rect"]) > 0.4 or overlap(u["rect"], rect) > 0.7 for u in native)):
            continue
        if label == "table":
            units.extend(table_units(raw, rect, image, sx, sy))
            continue
        text, prose = ocr_plain(raw)
        # 公式拿掉後還得有字才翻（純公式、編號留原樣）
        if not text or not translatable(prose):
            continue
        # 全大寫的標題（THE SCHRÖDINGER EQUATION）模型常認不出專有名詞，先轉一般大小寫再翻
        if label in ("title", "header") and text.isupper():
            text = text.title()
        # 標題、整塊粗體整段粗；段落內的局部粗體留著 **…** 送翻（斜體中文不用，不帶）
        bold = label == "title" or whole_bold(raw)
        if bold:
            text = text.replace("**", "")
        units.append({"text": text, "rect": rect, "color": 0, "flags": 16 if bold else 0, "rotate": 0, "raster": True,
                      **raster_metrics(image, rect, sx, sy), **({"body": True} if label == "text" else {})})
    return units


def collect_units(page, layout, ocr, warnings):
    image, sx, sy = page_image(page)
    blocks = parse_layout(layout, image, sx, sy, page.rect, warnings)
    protected = [b["rect"] for b in blocks if "formula" in b["label"] or b["label"] == "seal"]
    native, kept = native_units(page, protected, warnings)
    units = native[:]
    # 有文字層的區塊以原生文字為準（含留著的數學字）；OCR 只補掃描頁和沒文字層的段落，
    # 否則 OCR 結果會蓋在原文與公式上，又慢又擠。整頁沒文字層就整頁都收。
    written = [u["rect"] for u in native] + kept
    missing = None if not written else [
        b["rect"] for b in blocks if "formula" not in b["label"] and b["label"] not in LAYOUT_NON_TEXT
        and not any(not (rect & b["rect"]).is_empty for rect in written)]
    if missing is None or missing:
        units.extend(ocr_units(ocr, image, sx, sy, page.rect, protected, native, missing, warnings))
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
        indices = [i for i, unit in enumerate(units) if i not in used and "cell" not in unit
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
    style = (f"margin:0;padding:0;font-family:sans-serif;font-size:{unit['size']}pt;"
             f"line-height:{unit.get('leading', 1)};color:#{color:06x};")
    if unit.get("align"):
        style += f"text-align:{unit['align']};"
    elif "leading" in unit:
        # 掃描段落照原書：多行左右對齊、首行縮排
        style += "text-align:justify;" + ("text-indent:2em;" if unit.get("indent") else "")
    if unit["flags"] & 2:
        style += "font-style:italic;"
    body = body_html(text, unit["raster"])
    if unit["flags"] & 16:
        body = f"<b>{body.replace('<b>', '').replace('</b>', '')}</b>"
    return f'<div lang="{html.escape(target, quote=True)}" style="{style}">{body}</div>'


def body_html(text, raster):
    if raster:
        text = TRANSLATED_MATH.sub(lambda m: latex_plain(next(g for g in m.groups() if g is not None)), text)
        text = LEFTOVER_LATEX.sub(lambda m: latex_plain(m.group(0)), text)
    body = html.escape(text).replace(chr(10), "<br>")
    if raster:
        # 段落裡的局部粗體；模型漏掉一半的 ** 就拿掉，不留星號
        body = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", script_html(body)).replace("**", "")
    return body


def table_html(table, texts, target):
    """整張表重排：照 OCR 的列、欄與合併格組回 HTML 表；texts＝{第幾格: 譯文}，沒翻的格放原文"""
    rows = []
    for r in range(table["nrows"]):
        tds = []
        for n, cell in enumerate(table["cells"]):
            if cell["row"] != r:
                continue
            span = (f' rowspan="{cell["rows"]}"' if cell["rows"] > 1 else "") + (
                f' colspan="{cell["cols"]}"' if cell["cols"] > 1 else "")
            body = body_html(texts.get(n, cell["text"]), True)
            tds.append(f'<td{span} style="border:0.4pt solid #666;padding:0 2pt;vertical-align:middle">'
                       f'{f"<b>{body}</b>" if cell["bold"] else body}</td>')
        rows.append(f"<tr>{''.join(tds)}</tr>")
    # 行高撐到每列平均分到原表的高度，表才會鋪滿原位置（多行的格放不下時 fit 會再縮字）
    leading = min(2.5, max(1.15, table["rect"].height / max(1, table["nrows"]) / table["size"] * 0.95))
    return (f'<div lang="{html.escape(target, quote=True)}"><table style="width:100%;border-collapse:collapse;'
            f'font-family:sans-serif;font-size:{table["size"]}pt;line-height:{leading:.2f}">{"".join(rows)}</table></div>')


def prepare_table(table, texts, target, warnings):
    """整張重排的表：放不下就縮字，縮到 3pt 還放不下就保留原表"""
    rect = table["rect"]
    markup = table_html(table, texts, target)
    for scale_low in (min(1, max(0.5, MIN_FONT_SIZE / table["size"])), min(1, 3 / table["size"])):
        spare, scale = fit(rect, markup, scale_low, 0, target)
        if spare >= 0:
            if scale < 0.75:
                warnings["TEXT_SHRUNK"] += 1
            return {"rect": rect, "box": rect, "erase_rects": [rect], "markup": markup, "scale_low": scale_low,
                    "rotate": 0, "raster": True, "target": target}
    warnings["TEXT_OVERFLOW_ORIGINAL_KEPT"] += 1
    return None


# 內建中文字型只有一種粗細，粗體看不出來：粗體字改用系統的黑體粗體（只嵌入用到的字）
BOLD_FONTS = {"zh-TW": "msjhbd.ttc", "zh-CN": "msyhbd.ttc", "ja": "YuGothB.ttc", "ko": "malgunbd.ttf"}
_bold_fonts = {}


def bold_font(target):
    """(css, archive)；沒有對應字型（非 Windows、英文譯文）就用預設"""
    if target not in _bold_fonts:
        folder = os.path.join(os.environ.get("WINDIR", ""), "Fonts")
        name = BOLD_FONTS.get(target)
        _bold_fonts[target] = (("@font-face{font-family:boldcjk;font-weight:bold;src:url(%s);}"
                                "b{font-family:boldcjk,sans-serif;}" % name, fitz.Archive(folder))
                               if name and os.path.isfile(os.path.join(folder, name)) else ("", None))
    return _bold_fonts[target]


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


def insert_html(page, rect, markup, scale_low, rotate, target):
    css, archive = bold_font(target)
    return page.insert_htmlbox(rect, markup, css=css or None, archive=archive, scale_low=scale_low, rotate=rotate)


def fit(rect, markup, scale_low, rotate, target):
    with fitz.open() as probe:
        test_page = probe.new_page(width=max(rect.x1 + 1, 10), height=max(rect.y1 + 1, 10))
        return insert_html(test_page, rect, markup, scale_low, rotate, target)


def prepare_translation(unit, translated, target, warnings, right=None):
    rect = unit["rect"]
    markup = text_html(translated, unit, target)
    scale_low = min(1, max(0.5, MIN_FONT_SIZE / unit["size"]))
    boxes = [rect] + ([fitz.Rect(rect.x0, rect.y0, right, rect.y1)] if right else [])
    # 先原框、再往右延伸；都放不下就縮到 3pt，寧可字小也不保留原文（3pt 還放不下＝譯文長得不合理）
    for box in boxes:
        spare, scale = fit(box, markup, scale_low, unit["rotate"], target)
        if spare >= 0 and scale >= 0.75:
            return {**unit, "box": box, "markup": markup, "scale_low": scale_low, "target": target}
    floor = min(scale_low, 3 / unit["size"])
    spare, scale = fit(boxes[-1], markup, floor, unit["rotate"], target)
    if spare < 0:
        warnings["TEXT_OVERFLOW_ORIGINAL_KEPT"] += 1
        return None
    if scale < 0.75:
        warnings["TEXT_SHRUNK"] += 1
    return {**unit, "box": boxes[-1], "markup": markup, "scale_low": floor, "target": target}


def replace_units(page, units, image, sx, sy):
    # 不移除向量線條；公式框不在 units 中。原生文字用遮蔽移除。
    native = [u for u in units if not u["raster"]]
    for unit in native:
        for rect in unit.get("erase_rects", [unit["rect"]]):
            page.add_redact_annot(rect, fill=None, cross_out=False)
    if native:
        page.apply_redactions(images=0, graphics=0, text=0)
    # 掃描頁直接蓋背景色矩形：遮蔽會改寫掃描圖的像素，邊緣重新取樣後留一條暗線（框線殘影）
    for unit in units:
        if not unit["raster"]:
            continue
        for rect in unit.get("erase_rects", [unit["rect"]]):
            # OCR 框貼著字邊；不外擴的話右緣、下伸部會留一點沒蓋到的字
            rect = (rect + (-1.5, -1.5, 1.5, 1.5)) & page.rect
            page.draw_rect(rect, color=None, fill=background_color(image, rect, sx, sy), width=0, overlay=True)
    for unit in units:
        spare, _ = insert_html(page, unit.get("box", unit["rect"]), unit["markup"],
                               unit["scale_low"], unit["rotate"], unit.get("target", ""))
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


def run(config, stdin, stdout, ocr=None, layout=None):
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
        ocr = ocr if ocr is not None else OcrClient(config)
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
            units, state["image"], state["sx"], state["sy"] = collect_units(page, layout, ocr, warnings)
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
                tables = {}
                for unit, translated, right in zip(units, texts, room_right(page, units)):
                    if "table" in unit:
                        # 整張重排的表：先收齊每格譯文，最後一次排
                        if translated != unit["text"].strip():
                            tables.setdefault(id(unit["table"]), (unit["table"], {}))[1][unit["index"]] = translated
                        continue
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
                for table, cell_texts in tables.values():
                    result = prepare_table(table, cell_texts, config["targetLang"], warnings)
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
