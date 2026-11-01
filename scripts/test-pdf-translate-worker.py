"""python scripts/test-pdf-translate-worker.py；PDF 真生成，OCR 座標使用 fixture。"""

import importlib.util
import io
import json
import os
import subprocess
import sys
from collections import Counter
from pathlib import Path

import pymupdf as fitz

sys.dont_write_bytecode = True

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("pdf_worker", ROOT / "src/main/pdf-translate/worker.py")
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


def write_fixture(path):
    with fitz.open() as doc:
        page = doc.new_page(width=420, height=540)
        page.insert_text((28, 40), "Document title", fontsize=17, color=(0.05, 0.2, 0.4))
        page.insert_text((28, 75), "First paragraph line.", fontsize=11)
        page.insert_text((28, 90), "Second paragraph line.", fontsize=11)
        page.insert_text((28, 125), "E = mc^2", fontsize=12)
        page.draw_line((25, 132), (165, 132), color=(0, 0, 0))
        page.draw_rect((25, 160, 330, 225), color=(0, 0, 0))
        page.draw_line((170, 160), (170, 225), color=(0, 0, 0))
        page.draw_line((25, 190), (330, 190), color=(0, 0, 0))
        for x, y, text in ((35, 180, "Region"), (180, 180, "Revenue"),
                           (35, 215, "North"), (180, 215, "100")):
            page.insert_text((x, y), text, fontsize=11)
        page.draw_line((70, 400), (320, 400), color=(0, 0, 0))
        page.draw_line((70, 400), (70, 270), color=(0, 0, 0))
        page.draw_line((70, 385), (160, 320), color=(0.2, 0.5, 0.8), width=2)
        page.draw_line((160, 320), (270, 295), color=(0.2, 0.5, 0.8), width=2)
        page.insert_text((130, 425), "Time", fontsize=11)
        page.insert_text((50, 365), "Temperature", fontsize=11, rotate=90)
        page.insert_text((28, 475), "Energy E = mc^2 remains.", fontsize=11)
        original = page.get_pixmap(matrix=fitz.Matrix(2, 2))
        scan = doc.new_page(width=420, height=540)
        scan.insert_image(scan.rect, stream=original.tobytes("png"))
        tiny = doc.new_page(width=420, height=540)
        tiny.insert_text((28, 40), "Tiny", fontsize=9)
        rotated = doc.new_page(width=300, height=400)
        rotated.insert_text((30, 60), "Rotated label", fontsize=12)
        rotated.set_rotation(90)
        doc.set_metadata({"title": "Original title", "author": "Fixture author"})
        doc.set_toc([[1, "Chapter one", 1], [2, "Scanned page", 2], [1, "Rotated page", 4]])
        doc.set_page_labels([{"startpage": 0, "prefix": "P-", "style": "D", "firstpagenum": 1}])
        doc[0].insert_link({"kind": fitz.LINK_GOTO, "from": fitz.Rect(25, 20, 230, 50), "page": 3, "to": fitz.Point(30, 60)})
        doc.save(path)


def spans(page):
    records = []
    for block in page.get_text("dict")["blocks"]:
        for line in block.get("lines", []):
            for span in line["spans"]:
                records.append({"rect": fitz.Rect(span["bbox"]), "text": span["text"],
                                "dir": line["dir"]})
    return records


class FixturePipeline:
    """PP-DocLayoutV3（predict）＋ Unlimited-OCR-2（recognize）的替身；OCR 輸出照真模型格式。"""

    def __init__(self, source):
        with fitz.open(source) as doc:
            page = doc[0]
            self.inline = page.search_for("E = mc^2")[-1]
            first, second = page.search_for("First paragraph line.")[0], page.search_for("Second paragraph line.")[0]
            self.ocr_blocks = [
                ("title<LEVEL1>", page.search_for("Document title")[0], "# **Document title**"),
                ("text", first | second, "First paragraph line.\n<MERGE>\nSecond paragraph line."),
                ("equation", fitz.Rect(25, 110, 170, 134), "$$\nE = mc^2\n$$"),
                ("table", fitz.Rect(25, 160, 330, 225), "<table><tr><td>Region</td><td>Revenue</td></tr></table>"),
                ("image", fitz.Rect(30, 265, 330, 432), ""),
                ("page_number", fitz.Rect(380, 500, 400, 515), "12"),
                ("text", page.search_for("Energy E = mc^2 remains.")[0], "*Energy* $E = mc^2$ remains.")]
        self.calls = 0
        self.ocr_calls = 0

    def recognize(self, png):
        assert png.startswith(b"\x89PNG"), "OCR 要收 PNG"
        self.ocr_calls += 1
        box = lambda r: f"[{round(r.x0 / 420 * 1000)}, {round(r.y0 / 540 * 1000)}, {round(r.x1 / 420 * 1000)}, {round(r.y1 / 540 * 1000)}]"  # noqa: E731
        return "<PAGE>" + "\n".join(f"<BLOCK>{label}{box(rect)}<FORK>{text}" for label, rect, text in self.ocr_blocks), False

    def predict(self, image, **kwargs):
        height, width = image.shape[:2]
        self.calls += 1
        if self.calls > 2:
            return iter([{"res": {"boxes": []}}])
        sx, sy = width / 420, height / 540
        blocks = [("doc_title", (25, 20, 230, 50)), ("text", (25, 60, 250, 98)),
                  ("display_formula", (25, 110, 170, 134)),
                  ("table", (25, 160, 330, 225)), ("chart", (30, 265, 330, 432)),
                  ("text", (25, 455, 270, 490)), ("inline_formula", tuple(self.inline))]
        return iter([{"res": {"boxes": [
            {"label": label, "coordinate": [rect[0] * sx, rect[1] * sy, rect[2] * sx, rect[3] * sy]}
            for label, rect in blocks]}}])


class Replies:
    def __init__(self, output, target):
        self.output = output
        self.target = target
        self.requests = []
        self.seen = 0

    def readline(self, _limit):
        # 一頁的請求會一次送完；依序回覆尚未回的那一筆。
        lines = self.output.getvalue().splitlines()
        while True:
            message = json.loads(lines[self.seen])
            self.seen += 1
            if message["type"] == "translate":
                break
        self.requests.append(message["text"])
        # 短詞要帶整頁原文當參考，且參考裡含它自己
        assert len(message["text"]) >= worker.SHORT_TEXT or message.get("reference", message["text"]).count(message["text"]), message
        mapping = {"Document title": "文件標題", "First paragraph line. Second paragraph line.": "第一段文字。第二行內容。",
                   "Region": "區域", "Revenue": "營收", "North": "北區", "Time": "時間",
                   "Temperature": "溫度", "Rotated label": "旋轉標籤"}
        mapping.update({"Energy ": "能量", " remains.": "保持。", "Energy E = mc^(2) remains.": "能量 E = mc^(2) 保持。"})
        mapping.update({"Energy": "能量", "remains.": "保持。"})
        text = "many words " * 2000 if message["text"] == "Tiny" else mapping.get(message["text"], "譯文")
        return json.dumps({"id": message["id"], "text": text}, ensure_ascii=False) + "\n"


def config(source, output, layout):
    return {"inputPath": str(source), "outputPath": str(output), "layoutDir": str(layout),
            "endpoint": {"baseUrl": "http://127.0.0.1:8080/v1", "apiKey": "test-only"},
            "ocrModel": "unlimitedocr2q8", "targetLang": "zh-TW", "sourceLang": "en"}


def test_pdf(root):
    source, output = root / "source.pdf", root / "translated.pdf"
    write_fixture(source)
    before = source.read_bytes()
    stream = io.StringIO()
    reply = Replies(stream, output)
    fixture = FixturePipeline(source)
    worker.run(config(source, output, root), reply, stream, fixture, fixture)
    done = json.loads(stream.getvalue().splitlines()[-1])
    assert done["type"] == "done" and done["pages"] == 4, done
    assert done["translatedBlocks"] >= 12, done
    assert fixture.ocr_calls == 1, "只有掃描頁要整頁 OCR 一次"
    assert {w["code"] for w in done["warnings"]} >= {"overflow"}, done
    assert "E = mc^2" not in reply.requests and "100" not in reply.requests
    assert "First paragraph line. Second paragraph line." in reply.requests
    assert before == source.read_bytes(), "原始 PDF 被修改"
    # 每段譯文各嵌一份中文字型時，這 4 頁會到數十 MB。
    assert output.stat().st_size < 1_500_000, output.stat().st_size
    with fitz.open(output) as doc, fitz.open(source) as original:
        assert doc.page_count == 4
        native_text, scan_text = doc[0].get_text(), doc[1].get_text()
        for source_text in ("Document title", "Region", "Revenue", "North", "Time", "Temperature"):
            assert source_text not in native_text, (source_text, native_text)
        for target_text in ("文件標題", "區域", "營收", "北區", "時間", "溫度"):
            assert target_text in native_text, (target_text, native_text)
        # 掃描頁：標題、段落、含行內公式的段落、表格的字翻；表格的數字、圖、公式、頁碼留原樣（Unlimited-OCR-2 不輸出圖內文字）
        flat = "".join(scan_text.split())
        assert "文件標題" in flat and "第一段文字。第二行內容。" in flat and "能量E=mc2保持。" in flat, scan_text
        assert "區域" in scan_text and "營收" in scan_text and "12" not in scan_text, scan_text
        assert "E = mc^2" in native_text and "100" in native_text
        assert native_text.count("E = mc^2") == 2 and "Energy" not in native_text and "remains" not in native_text
        assert "Energy " in reply.requests and "Energy E = mc^(2) remains." in reply.requests, reply.requests
        old_paths = [d["items"] for d in original[0].get_drawings()]
        new_paths = [d["items"] for d in doc[0].get_drawings()]
        assert all(items in new_paths for items in old_paths), "公式／圖表／表格線條遺失"
        # 掃描頁公式和資料線保持像素原樣（表格的字會換成譯文，不在此列）。
        for rect in (fitz.Rect(25, 110, 170, 134), fitz.Rect(100, 295, 275, 380)):
            old = original[1].get_pixmap(matrix=fitz.Matrix(2, 2), clip=rect)
            new = doc[1].get_pixmap(matrix=fitz.Matrix(2, 2), clip=rect)
            assert old.samples == new.samples, "掃描頁公式／資料曲線遭改動"
        assert "Tiny" in doc[2].get_text(), "溢出時未保留原文"
        assert "Rotated label" not in doc[3].get_text() and "旋轉標籤" in doc[3].get_text()
        assert doc[3].rect == original[3].rect, "旋轉頁尺寸改變"
        assert doc.metadata["title"] == "Original title" and doc.metadata["author"] == "Fixture author"
        assert doc.get_toc() == original.get_toc() and doc.get_page_labels() == original.get_page_labels()
        links = doc[0].get_links()
        assert len(links) == 1 and links[0]["page"] == 3 and links[0]["from"] == original[0].get_links()[0]["from"]
        doc[0].get_pixmap(matrix=fitz.Matrix(2, 2)).save(root / "native-preview.png")
        doc[1].get_pixmap(matrix=fitz.Matrix(2, 2)).save(root / "scan-preview.png")
    print("PASS 4 頁 PDF：原文替換、段落、掃描頁整頁 OCR、行內公式、表格、圖表座標、旋轉、溢出、原檔、書籤、跨頁連結")


def test_incremental(root):
    source, output = root / "long.pdf", root / "long-translated.pdf"
    with fitz.open() as doc:
        for index in range(40):
            doc.new_page().insert_text((30, 60), f"Page number {index + 1}")
        doc.save(source)
    stream = io.StringIO()
    writes = []
    original_append = worker.append_page

    def append(path, document, first):
        assert document.page_count == 1, "整份文件同時留在輸出文件"
        original_append(path, document, first)
        with fitz.open(path) as saved:
            writes.append(saved.page_count)

    class EmptyPipeline:
        def predict(self, _image, **_kwargs):
            return [{"res": {"boxes": []}}]

    worker.append_page = append
    try:
        worker.run(config(source, output, root), Replies(stream, output), stream, EmptyPipeline(), EmptyPipeline())
    finally:
        worker.append_page = original_append
    assert writes == list(range(1, 41))
    assert json.loads(stream.getvalue().splitlines()[-1])["pages"] == 40
    print("PASS 40 頁：每頁落盤、每次只帶一頁、不累積 raster")


def test_validation(root):
    base = config(root / "source.pdf", root / "invalid.pdf", root)
    for change in ({"outputPath": base["inputPath"]}, {"endpoint": {"baseUrl": "https://example.com/v1"}},
                   {"endpoint": {"baseUrl": "http://127.0.0.1:8080/v1?key=secret"}}, {"ocrModel": "unknown"}, {"layoutDevice": "gpu:0; rm"},
                   {"pages": [[0, 1]]}, {"pages": [[3, 2]]}, {"pages": "1-2"}, {"dual": "yes"}):
        try:
            worker.validate_config({**base, **change})
            raise AssertionError("錯誤 config 被接受")
        except worker.WorkerError:
            pass
    for raw in ("[]\n", "{invalid}\n", "{}", ""):
        try:
            worker.read_message(io.StringIO(raw))
            raise AssertionError("錯誤協定被接受")
        except worker.WorkerError:
            pass
    for raw in ('{"id":"wrong","text":"ok"}\n', '{"id":"1:0","text":"a"}\n{"id":"1:0","text":"b"}\n'):
        try:
            worker.request_translations(io.StringIO(raw), io.StringIO(), 1, ["private", "words"])
            raise AssertionError("錯誤或重複 id 被接受")
        except worker.WorkerError as error:
            assert error.code == "TRANSLATION"
    broken = "".join(map(chr, (0xDCE6, 0xDC96, 0xDC87))) + "件"
    out_of_order = (json.dumps({"id": "1:1", "text": "第二"}, ensure_ascii=False) + "\n"
                    + json.dumps({"id": "1:0", "text": broken}, ensure_ascii=False) + "\n")
    dirty, second = worker.request_translations(io.StringIO(out_of_order), io.StringIO(), 1, ["Document", "Second"])
    assert second == "第二", "亂序回覆沒對回原請求"
    assert dirty == "���件" and not any(chr(0xD800) <= char <= chr(0xDFFF) for char in dirty), repr(dirty)
    # 先送下一頁再收這一頁：別頁的回覆先收著，輪到那頁再取；alone 標記照送
    cross = "".join(json.dumps({"id": i, "text": t}, ensure_ascii=False) + "\n"
                    for i, t in (("2:0", "下一頁"), ("1:0", "這一頁")))
    sent = io.StringIO()
    translations = worker.Translations(io.StringIO(cross), sent)
    first, second = translations.request(1, ["This page"], {0: 3}), translations.request(2, ["Next page"])
    assert translations.collect(first) == ["這一頁"] and translations.collect(second) == ["下一頁"]
    assert [(m.get("alone"), m.get("line")) for m in map(json.loads, sent.getvalue().splitlines())] == [(True, 3), (None, None)]
    assert not worker.translatable("x y dx t") and not worker.translatable("λ") and worker.translatable("溫度")
    assert worker.translatable("Model") and not worker.translatable("100")
    assert not any(map(worker.translatable, ("cos", "exp", "Mdx", "ydy", ", sin", "cos x, exp"))) and worker.translatable("Add")
    assert worker.translatable("the max value") and worker.translatable("sinusoidal wave")
    plain, prose = worker.ocr_plain(r"**Question 5.** The *average* $\langle j^2 \rangle = \sum_{j=0}^{\infty} j^2 P(j)$ and $\frac{\hbar^2}{2m}$, $\psi_n$")
    assert plain == "**Question 5.** The average ⟨j^(2)⟩ = ∑_(j=0)^(∞) j^(2) P(j) and (ℏ^(2))/(2m), ψ_(n)", plain
    markup = worker.text_html("e^（-iE_(n)t）與 a_b", {"size": 11, "color": 0, "flags": 0, "raster": True}, "zh-TW")
    assert "e<sup>-iE<sub>n</sub>t</sup>與 a_b" in markup, markup
    markup = worker.text_html(r"常數 V_0（與 x 無關）。相位因子：\exp(-iV_0t/\hbar)。my_file", {"size": 11, "color": 0, "flags": 0, "raster": True}, "zh-TW")
    assert "V<sub>0</sub>（與" in markup and "exp(-iV<sub>0</sub>t/ℏ)。my_file" in markup, markup
    markup = worker.text_html(r"價格 $5 與 $10；$\partial x/\partial t = 0$、$x$、$V_0$", {"size": 11, "color": 0, "flags": 0, "raster": True}, "zh-TW")
    assert "價格 $5 與 $10；∂x/∂t = 0、x、V<sub>0</sub>" in markup, markup
    plain, prose = worker.ocr_plain("**Problem 1.13** Suppose *classical* $V_0$")
    assert plain == "**Problem 1.13** Suppose classical V_(0)" and "*" not in prose, (plain, prose)
    markup = worker.text_html("**習題 1.13** 假設 **古典", {"size": 11, "color": 0, "flags": 0, "raster": True}, "zh-TW")
    assert "<b>習題 1.13</b> 假設 古典" in markup, markup
    assert worker.translatable(prose) and not worker.translatable(worker.ocr_plain("$x = 3$ [1.8]")[1])

    class Cut:
        def recognize(self, _png):
            return "<PAGE><BLOCK>text[0, 0, 1000, 500]<FORK>Complete words here.<BLOCK>text[0, 500, 1000, 1000]<FORK>Trunc", True
    import numpy as np
    cut_warnings = Counter()
    found = worker.ocr_units(Cut(), np.full((100, 100, 3), 255, np.uint8), 1, 1, fitz.Rect(0, 0, 100, 100), [], [], None, cut_warnings)
    assert [u["text"] for u in found] == ["Complete words here."] and cut_warnings["OCR_TEXT_NOT_LOCATED"] == 1, found
    warnings = Counter()
    assert worker.checked_rect([0, 0, float("nan"), 100], fitz.Rect(0, 0, 100, 100), warnings) is None
    assert warnings["OCR_BOX_INVALID"] == 1
    completed = subprocess.run([sys.executable, str(ROOT / "src/main/pdf-translate/worker.py")],
                               input=json.dumps({**base, "outputPath": base["inputPath"]}) + "\n",
                               text=True, encoding="utf-8", capture_output=True)
    error = json.loads(completed.stdout)
    assert completed.returncode == 1 and error["type"] == "error"
    assert "private" not in completed.stdout and "secret" not in completed.stdout
    print("PASS 輸入驗證、協定、錯誤訊息不含文件／金鑰")

    pending = root / "pending-redaction.pdf"
    with fitz.open() as doc:
        page = doc.new_page()
        page.insert_text((20, 30), "Do not apply pending redaction")
        page.add_redact_annot((10, 10, 200, 50))
        doc.save(pending)
    try:
        fixture = FixturePipeline(root / "source.pdf")
        worker.run(config(pending, root / "pending-result.pdf", root), io.StringIO(), io.StringIO(), fixture, fixture)
        raise AssertionError("執行了使用者尚未批准的 PDF 遮蔽註記")
    except worker.WorkerError as error:
        assert error.code == "PDF_UNSUPPORTED"
    assert not (root / "pending-result.pdf").exists()
    print("PASS 未套用的 PDF 遮蔽註記不會被順便執行")


def test_image(root):
    source = root / "image-source.pdf"
    write_fixture(source)
    with fitz.open(source) as doc:
        doc[0].get_pixmap().save(root / "page.png")
    stream = io.StringIO()
    reply = Replies(stream, root / "image-translated.pdf")
    fixture = FixturePipeline(source)
    worker.run(config(root / "page.png", root / "image-translated.pdf", root), reply, stream, fixture, fixture)
    done = json.loads(stream.getvalue().splitlines()[-1])
    assert done["type"] == "done" and done["pages"] == 1, done
    assert done["translatedBlocks"] > 0, done
    with fitz.open(root / "image-translated.pdf") as doc:
        assert doc.page_count == 1
        text = doc[0].get_text()
        assert "文件標題" in text and "Document title" not in text, text
    print("PASS 圖片：單頁輸入走同一管線，輸出單頁翻譯 PDF")


FLOW_TRANSLATIONS = {
    "Deep learning models are useful and the method that we propose here is simple. It works well.":
        "深度學習模型很有用，我們提出的方法很簡單。效果很好。",
    "This paragraph continues onto the following page without a break. Done here.":
        "這段文字延續到下一頁，中間沒有斷開。到此結束。",
}


class FlowLayout:
    """兩欄頁＋接續頁：每頁的正文框（PDF 座標）"""

    PAGES = [[(30, 50, 230, 100), (270, 50, 470, 100), (270, 400, 470, 450)], [(30, 50, 230, 100)]]

    def __init__(self):
        self.calls = 0

    def predict(self, image, **_kwargs):
        sx, sy = image.shape[1] / 500, image.shape[0] / 600
        boxes = self.PAGES[self.calls]
        self.calls += 1
        return iter([{"res": {"boxes": [{"label": "text", "coordinate": [x0 * sx, y0 * sy, x1 * sx, y1 * sy]}
                                        for x0, y0, x1, y1 in boxes]}}])


class FlowReplies:
    def __init__(self, output):
        self.output, self.seen, self.requests, self.documents = output, 0, [], []

    def readline(self, _limit):
        lines = self.output.getvalue().splitlines()
        while True:
            message = json.loads(lines[self.seen])
            self.seen += 1
            if message["type"] == "document":
                self.documents.append(message)
            if message["type"] == "translate":
                break
        self.requests.append(message["text"])
        text = FLOW_TRANSLATIONS.get(message["text"], "譯文")
        return json.dumps({"id": message["id"], "text": text}, ensure_ascii=False) + "\n"


def test_flow(root):
    source, output = root / "flow.pdf", root / "flow-dual.pdf"
    with fitz.open() as doc:
        first = doc.new_page(width=500, height=600)
        for x, y, text in ((32, 70, "Deep learning models are useful"), (32, 85, "and the method that we"),
                           (272, 70, "propose here is simple."), (272, 85, "It works well."),
                           (272, 420, "This paragraph continues"), (272, 435, "onto the following")):
            first.insert_text((x, y), text, fontsize=10)
        second = doc.new_page(width=500, height=600)
        second.insert_text((32, 70), "page without a break.", fontsize=10)
        second.insert_text((32, 85), "Done here.", fontsize=10)
        doc.new_page(width=500, height=600).insert_text((32, 70), "Skipped page text.", fontsize=10)
        doc.set_metadata({"title": "Flow fixture paper"})
        doc.set_toc([[1, "Start", 1], [1, "Skipped", 3]])
        doc.save(source)
    stream = io.StringIO()
    reply = FlowReplies(stream)
    worker.run({**config(source, output, root), "pages": [[1, 2]], "dual": True}, reply, stream, FlowLayout(), FlowLayout())
    done = json.loads(stream.getvalue().splitlines()[-1])
    assert done["type"] == "done" and done["pages"] == 3, done
    assert reply.documents and reply.documents[0]["title"] == "Flow fixture paper", reply.documents
    assert "Skipped page text." not in reply.documents[0]["sample"] and "propose here" in reply.documents[0]["sample"]
    # 換欄、換頁切開的句子接起來送一次，後半不另外送
    assert set(FLOW_TRANSLATIONS) <= set(reply.requests), reply.requests
    assert not {"propose here is simple. It works well.", "page without a break. Done here."} & set(reply.requests)
    assert "Skipped page text." not in reply.requests
    with fitz.open(output) as doc:
        # 原 1、譯 1、原 2、譯 2、原 3（沒選的頁只放原文）
        assert doc.page_count == 5, doc.page_count
        assert "Deep learning" in doc[0].get_text() and "Skipped page text." in doc[4].get_text()
        left, right = doc[1].get_text(clip=fitz.Rect(0, 0, 250, 600)), doc[1].get_text(clip=fitz.Rect(250, 0, 500, 300))
        assert "深度學習" in left and "效果很好" in right and "Deep" not in left and "propose" not in right, (left, right)
        assert "這段文字" in doc[1].get_text(clip=fitz.Rect(250, 380, 500, 600)), doc[1].get_text()
        assert "到此結束" in "".join(doc[3].get_text().split()) and "page without" not in doc[3].get_text(), doc[3].get_text()
        assert [entry[2] for entry in doc.get_toc()] == [2, 5], doc.get_toc()
    try:
        worker.run({**config(source, root / "none.pdf", root), "pages": [[9, 0]]}, io.StringIO(), io.StringIO(), FlowLayout(), FlowLayout())
        raise AssertionError("超出頁數的範圍被接受")
    except worker.WorkerError as error:
        assert error.code == "PAGES"
    assert worker.split_translation({"text": "ab"}, {"text": "cd"}, "譯") == ("譯", "cd")
    print("PASS 接段：雙欄換欄、跨頁接著翻再切回；頁碼範圍；雙語對照與書籤")


def test_tables():
    """掃描表格：格子推得出來逐格換字（每欄對齊、整表一個字級）；推不出來整張重排；OCR 多拆一格的列不動"""
    doc = fitz.open()
    page = doc.new_page(width=300, height=140)
    rows = [("Name", "Count", "Status"), ("Apple tree", "12", "Healthy plant"), ("Pine", "7", "Dry soil")]
    for r, row in enumerate(rows):
        for c, text in enumerate(row):
            page.insert_text((20 + c * 95, 40 + r * 25), text, fontsize=11)
    page.draw_line((15, 47), (290, 47), width=1)
    image, sx, sy = worker.page_image(page)
    rect = fitz.Rect(10, 20, 295, 100)
    content = "<table>" + "".join("<tr>" + "".join(f"<td>{t}</td>" for t in row) + "</tr>" for row in rows) + "</table>"
    units = worker.table_units(content, rect, image, sx, sy)
    # 數字格不翻；其他每格一段，位置在自己那格
    assert [u["text"] for u in units] == ["Name", "Count", "Status", "Apple tree", "Healthy plant", "Pine", "Dry soil"], units
    assert all("table" not in u and u["align"] == "left" for u in units), units
    # 11pt 英文的墨水高 × 0.85（中文字滿版，看起來跟原本一樣高）
    assert len({u["size"] for u in units}) == 1 and 8 <= units[0]["size"] <= 11, units[0]["size"]
    assert units[3]["rect"].x0 < 25 < units[3]["rect"].x1 and units[4]["rect"].x0 > 180, (units[3]["rect"], units[4]["rect"])
    # 有一列被 OCR 多拆一格：欄數照多數列，那列不動，其他照樣逐格
    odd = content.replace("<td>Dry soil</td>", "<td>Dry</td><td>soil</td>")
    units = worker.table_units(odd, rect, image, sx, sy)
    assert "Dry" not in [u["text"] for u in units] and "Healthy plant" in [u["text"] for u in units], units
    # 欄數對不上圖（OCR 只給兩欄）：整張重排，排成一張含合併格的 HTML 表
    merged = "<table><tr><td colspan=\"2\">Name and count</td></tr><tr><td>Apple tree</td><td>12</td></tr></table>"
    units = worker.table_units(merged, rect, image, sx, sy)
    assert units and all(u["table"] is units[0]["table"] for u in units), units
    result = worker.prepare_table(units[0]["table"], {0: "名稱與數量", 1: "蘋果樹"}, "zh-TW", Counter())
    assert result and 'colspan="2"' in result["markup"] and "蘋果樹" in result["markup"] and ">12<" in result["markup"], result
    print("PASS 表格：逐格換字、每欄對齊、多拆一格的列不動、對不上就整張重排")


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    # 由專案共用 test-temp 管理資料夾，Node 活到 Python 驗證完成才清理。
    holder = subprocess.Popen(["node", "-e", "const {tempDir}=require('./scripts/lib/test-temp');console.log(tempDir('pdf-worker-'));process.stdin.resume()"],
                              cwd=ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, encoding="utf-8")
    root = Path(holder.stdout.readline().strip())
    try:
        test_pdf(root)
        test_image(root)
        test_incremental(root)
        test_flow(root)
        test_tables()
        test_validation(root)
        print(f"PREVIEW {root}", flush=True)
        if "--preview" in sys.argv:
            input("檢查完成後送 Enter 清理。\n")
    finally:
        holder.stdin.close()
        holder.wait(timeout=15)


if __name__ == "__main__":
    main()
