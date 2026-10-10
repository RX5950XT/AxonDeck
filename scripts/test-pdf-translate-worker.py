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
    def __init__(self, source):
        with fitz.open(source) as doc:
            self.spots = spans(doc[0])
            self.inline = doc[0].search_for("E = mc^2")[-1]
            self.spots = [s for s in self.spots if not s["text"].startswith("Energy ")]
            for text in ("Energy", "E = mc^2", "remains."):
                self.spots.append({"text": text, "rect": doc[0].search_for(text)[-1], "dir": (1, 0)})
        self.calls = 0
        self.regions = []

    def predict(self, image, **kwargs):
        height, width = image.shape[:2]
        if kwargs.get("prompt_label") == "spotting":
            candidates = [(r, sx, sy) for r, sx, sy in self.regions
                          if abs(round(r.width * sx) - width) < 3
                          and abs(round(r.height * sy) - height) < 3]
            assert candidates, (width, height)
            rect, sx, sy = candidates[0]
            polys, texts = [], []
            for record in self.spots:
                box = record["rect"]
                if (box & rect).get_area() < box.get_area() * 0.9:
                    continue
                # 真 Paddle spotting 的旋轉縱軸也回水平順序的 axis-aligned polygon。
                points = [(box.x0, box.y0), (box.x1, box.y0),
                          (box.x1, box.y1), (box.x0, box.y1)]
                polys.append([[(x - rect.x0) * sx, (y - rect.y0) * sy] for x, y in points])
                texts.append(record["text"])
            return iter([{"res": {"spotting_res": {"rec_polys": polys, "rec_texts": texts}}}])
        self.calls += 1
        if self.calls > 2:
            return iter([{"res": {"parsing_res_list": []}}])
        sx, sy = width / 420, height / 540
        blocks = [("doc_title", (25, 20, 230, 50)), ("text", (25, 60, 250, 98)),
                  ("display_formula", (25, 110, 170, 134)),
                  ("table", (25, 160, 330, 225)), ("chart", (30, 265, 330, 432)),
                  ("text", (25, 455, 270, 490)), ("inline_formula", tuple(self.inline))]
        self.regions = [(fitz.Rect(rect), sx, sy) for label, rect in blocks if "formula" not in label]
        # scan 行內公式所在文字區分成上下、公式左右四個可讀區。
        mixed = fitz.Rect(25, 455, 270, 490)
        formula = self.inline
        self.regions.extend([(r, sx, sy) for r in (
            fitz.Rect(mixed.x0, mixed.y0, mixed.x1, formula.y0),
            fitz.Rect(mixed.x0, formula.y1, mixed.x1, mixed.y1),
            fitz.Rect(mixed.x0, formula.y0, formula.x0, formula.y1),
            fitz.Rect(formula.x1, formula.y0, mixed.x1, formula.y1))])
        return iter([{"res": {"parsing_res_list": [
            {"block_label": label, "block_bbox": [rect[0] * sx, rect[1] * sy, rect[2] * sx, rect[3] * sy],
             "block_content": ""} for label, rect in blocks]}}])


class Replies:
    def __init__(self, output, target):
        self.output = output
        self.target = target
        self.requests = []

    def readline(self, _limit):
        message = json.loads(self.output.getvalue().splitlines()[-1])
        assert message["type"] == "translate"
        self.requests.append(message["text"])
        mapping = {"Document title": "文件標題", "First paragraph line. Second paragraph line.": "第一段文字。第二行內容。",
                   "Region": "區域", "Revenue": "營收", "North": "北區", "Time": "時間",
                   "Temperature": "溫度", "Rotated label": "旋轉標籤"}
        mapping.update({"Energy ": "能量", " remains.": "保持。"})
        mapping.update({"Energy": "能量", "remains.": "保持。"})
        text = "many words " * 2000 if message["text"] == "Tiny" else mapping.get(message["text"], "譯文")
        return json.dumps({"id": message["id"], "text": text}, ensure_ascii=False) + "\n"


def config(source, output, layout):
    return {"inputPath": str(source), "outputPath": str(output), "layoutDir": str(layout),
            "endpoint": {"baseUrl": "http://127.0.0.1:8080/v1", "apiKey": "test-only"},
            "ocrModel": "paddleocrvl16", "targetLang": "zh-TW", "sourceLang": "en"}


def test_pdf(root):
    source, output = root / "source.pdf", root / "translated.pdf"
    write_fixture(source)
    before = source.read_bytes()
    stream = io.StringIO()
    reply = Replies(stream, output)
    worker.run(config(source, output, root), reply, stream, FixturePipeline(source))
    done = json.loads(stream.getvalue().splitlines()[-1])
    assert done["type"] == "done" and done["pages"] == 4, done
    assert done["translatedBlocks"] >= 15, done
    assert {w["code"] for w in done["warnings"]} >= {"overflow"}, done
    assert "E = mc^2" not in reply.requests and "100" not in reply.requests
    assert "First paragraph line. Second paragraph line." in reply.requests
    assert before == source.read_bytes(), "原始 PDF 被修改"
    with fitz.open(output) as doc, fitz.open(source) as original:
        assert doc.page_count == 4
        native_text, scan_text = doc[0].get_text(), doc[1].get_text()
        for source_text in ("Document title", "Region", "Revenue", "North", "Time", "Temperature"):
            assert source_text not in native_text, (source_text, native_text)
        for target_text in ("文件標題", "區域", "營收", "北區", "時間", "溫度"):
            assert target_text in native_text and target_text in scan_text, (target_text, native_text, scan_text)
        assert "E = mc^2" in native_text and "100" in native_text
        assert native_text.count("E = mc^2") == 2 and "Energy" not in native_text and "remains" not in native_text
        assert "能量" in scan_text and "保持。" in scan_text
        assert "Energy" in reply.requests and "remains." in reply.requests
        old_paths = [d["items"] for d in original[0].get_drawings()]
        new_paths = [d["items"] for d in doc[0].get_drawings()]
        assert all(items in new_paths for items in old_paths), "公式／圖表／表格線條遺失"
        # 掃描頁公式和資料線保持像素原樣。
        for rect in (fitz.Rect(25, 110, 170, 134), fitz.Rect(100, 295, 275, 380), original[0].search_for("E = mc^2")[-1]):
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
    print("PASS 4 頁 PDF：原文替換、段落、掃描頁、行內公式、表格、圖表座標、旋轉、溢出、原檔、書籤、跨頁連結")


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
            return [{"res": {"parsing_res_list": []}}]

    worker.append_page = append
    try:
        worker.run(config(source, output, root), Replies(stream, output), stream, EmptyPipeline())
    finally:
        worker.append_page = original_append
    assert writes == list(range(1, 41))
    assert json.loads(stream.getvalue().splitlines()[-1])["pages"] == 40
    print("PASS 40 頁：每頁落盤、每次只帶一頁、不累積 raster")


def test_validation(root):
    base = config(root / "source.pdf", root / "invalid.pdf", root)
    for change in ({"outputPath": base["inputPath"]}, {"endpoint": {"baseUrl": "https://example.com/v1"}},
                   {"endpoint": {"baseUrl": "http://127.0.0.1:8080/v1?key=secret"}}, {"ocrModel": "unknown"}):
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
    try:
        worker.request_translation(io.StringIO('{"id":"wrong","text":"ok"}\n'), io.StringIO(), "1", "private")
        raise AssertionError("錯誤 id 被接受")
    except worker.WorkerError as error:
        assert error.code == "TRANSLATION"
    broken = "".join(map(chr, (0xDCE6, 0xDC96, 0xDC87))) + "件"
    dirty = worker.request_translation(
        io.StringIO(json.dumps({"id": "1:0", "text": broken}, ensure_ascii=False) + "\n"),
        io.StringIO(), "1:0", "Document")
    assert dirty == "���件" and not any(chr(0xD800) <= char <= chr(0xDFFF) for char in dirty), repr(dirty)
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
        worker.run(config(pending, root / "pending-result.pdf", root), io.StringIO(), io.StringIO(), FixturePipeline(root / "source.pdf"))
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
    worker.run(config(root / "page.png", root / "image-translated.pdf", root),
               reply, stream, FixturePipeline(source))
    done = json.loads(stream.getvalue().splitlines()[-1])
    assert done["type"] == "done" and done["pages"] == 1, done
    assert done["translatedBlocks"] > 0, done
    with fitz.open(root / "image-translated.pdf") as doc:
        assert doc.page_count == 1
        text = doc[0].get_text()
        assert "文件標題" in text and "Document title" not in text, text
    print("PASS 圖片：單頁輸入走同一管線，輸出單頁翻譯 PDF")


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
        test_validation(root)
        print(f"PREVIEW {root}", flush=True)
        if "--preview" in sys.argv:
            input("檢查完成後送 Enter 清理。\n")
    finally:
        holder.stdin.close()
        holder.wait(timeout=15)


if __name__ == "__main__":
    main()
