"""
Document and image helpers for Nalo Flow's agent tools.

Usage:
  python doc_tools.py read   <path>
  python doc_tools.py convert <src> <dst> [--width N] [--quality Q]
  python doc_tools.py edit   <path> <ops.json>
  python doc_tools.py info   <path>

Output is plain text (or JSON for info). Errors go to stderr with exit code 1.
"""
import json
import os
import sys
from pathlib import Path

MAX_TEXT = 12000


def fail(message):
    print(message, file=sys.stderr)
    sys.exit(1)


def read_docx(path):
    from docx import Document
    document = Document(path)
    parts = []
    for paragraph in document.paragraphs:
        text = paragraph.text.strip()
        if text:
            parts.append(text)
    for index, table in enumerate(document.tables, 1):
        parts.append(f"[表格 {index}]")
        for row in table.rows:
            cells = [cell.text.strip() for cell in row.cells]
            parts.append(" | ".join(cells))
    return "\n".join(parts)


def read_xlsx(path):
    from openpyxl import load_workbook
    workbook = load_workbook(path, data_only=True, read_only=True)
    parts = []
    for sheet in workbook.worksheets:
        parts.append(f"[工作表 {sheet.title}]")
        for row in sheet.iter_rows(values_only=True):
            values = ["" if cell is None else str(cell) for cell in row]
            if any(value.strip() for value in values):
                parts.append(" | ".join(values))
    return "\n".join(parts)


def read_pptx(path):
    from pptx import Presentation
    presentation = Presentation(path)
    parts = []
    for index, slide in enumerate(presentation.slides, 1):
        parts.append(f"[第 {index} 页]")
        for shape in slide.shapes:
            if getattr(shape, "has_text_frame", False):
                text = shape.text_frame.text.strip()
                if text:
                    parts.append(text)
    return "\n".join(parts)


def read_plain(path):
    data = Path(path).read_bytes()
    for encoding in ("utf-8", "utf-8-sig", "gbk", "latin-1"):
        try:
            return data.decode(encoding)
        except UnicodeDecodeError:
            continue
    return data.decode("utf-8", errors="replace")


def read_any(path):
    suffix = Path(path).suffix.lower()
    if suffix == ".docx":
        return read_docx(path)
    if suffix in (".xlsx", ".xlsm"):
        return read_xlsx(path)
    if suffix == ".pptx":
        return read_pptx(path)
    if suffix in (".txt", ".md", ".csv", ".json", ".log", ".xml", ".html", ".htm", ".py", ".js", ".css", ".ts"):
        return read_plain(path)
    if suffix == ".pdf":
        fail("PDF 需要额外的解析组件，当前版本暂不支持直接读取 PDF，请转成 docx 或图片后再试")
    fail(f"暂不支持读取 {suffix or '未知'} 类型，支持 docx / xlsx / pptx / txt / md / csv / json")


def do_read(path):
    text = read_any(path)
    text = text.strip()
    if not text:
        print("（文件里没有可读文字）")
        return
    if len(text) > MAX_TEXT:
        text = text[:MAX_TEXT] + f"\n…（已截断，原文共 {len(text)} 字符）"
    print(text)


def do_convert(src, dst, width=None, quality=88):
    from PIL import Image
    image = Image.open(src)
    if width:
        ratio = width / float(image.width)
        image = image.resize((int(width), max(1, int(image.height * ratio))), Image.LANCZOS)
    target = Path(dst)
    if target.suffix.lower() in (".jpg", ".jpeg"):
        image.convert("RGB").save(target, "JPEG", quality=int(quality))
    elif target.suffix.lower() == ".webp":
        image.convert("RGB").save(target, "WEBP", quality=int(quality))
    elif target.suffix.lower() == ".png":
        image.convert("RGBA").save(target, "PNG")
    elif target.suffix.lower() == ".bmp":
        image.convert("RGB").save(target, "BMP")
    else:
        fail(f"不支持的输出格式 {target.suffix}，支持 jpg / png / webp / bmp")
    print(f"已转换：{dst}（{image.width}x{image.height}）")


def do_edit(path, ops_path):
    ops = json.loads(Path(ops_path).read_text(encoding="utf-8-sig"))
    if not isinstance(ops, list):
        ops = [ops]
    suffix = Path(path).suffix.lower()
    changed = 0

    if suffix == ".docx":
        from docx import Document
        document = Document(path)

        def replace_in_paragraph(paragraph, find, repl):
            hit = False
            for run in paragraph.runs:
                if find in run.text:
                    run.text = run.text.replace(find, repl)
                    hit = True
            if not hit and find in paragraph.text:
                paragraph.text = paragraph.text.replace(find, repl)
                hit = True
            return hit

        for op in ops:
            if "find" in op:
                find, repl = str(op["find"]), str(op.get("replace", ""))
                for paragraph in document.paragraphs:
                    if replace_in_paragraph(paragraph, find, repl):
                        changed += 1
                for table in document.tables:
                    for row in table.rows:
                        for cell in row.cells:
                            for paragraph in cell.paragraphs:
                                if replace_in_paragraph(paragraph, find, repl):
                                    changed += 1
            elif "append" in op:
                document.add_paragraph(str(op["append"]))
                changed += 1
        document.save(path)

    elif suffix in (".xlsx", ".xlsm"):
        from openpyxl import load_workbook
        workbook = load_workbook(path)
        for op in ops:
            sheet = workbook[op["sheet"]] if op.get("sheet") else workbook.active
            if "cell" in op:
                sheet[str(op["cell"])] = op.get("value")
                changed += 1
            elif "find" in op:
                for row in sheet.iter_rows():
                    for cell in row:
                        if isinstance(cell.value, str) and op["find"] in cell.value:
                            cell.value = cell.value.replace(str(op["find"]), str(op.get("replace", "")))
                            changed += 1
        workbook.save(path)

    elif suffix == ".pptx":
        from pptx import Presentation
        presentation = Presentation(path)
        for op in ops:
            if "find" not in op:
                continue
            find, repl = str(op["find"]), str(op.get("replace", ""))
            for slide in presentation.slides:
                for shape in slide.shapes:
                    if getattr(shape, "has_text_frame", False):
                        for paragraph in shape.text_frame.paragraphs:
                            for run in paragraph.runs:
                                if find in run.text:
                                    run.text = run.text.replace(find, repl)
                                    changed += 1
        presentation.save(path)

    elif suffix in (".txt", ".md", ".csv"):
        text = Path(path).read_text(encoding="utf-8")
        for op in ops:
            if "find" in op:
                find, repl = str(op["find"]), str(op.get("replace", ""))
                count = text.count(find)
                if count:
                    text = text.replace(find, repl)
                    changed += count
        Path(path).write_text(text, encoding="utf-8")

    else:
        fail(f"暂不支持编辑 {suffix or '未知'} 类型，支持 docx / xlsx / pptx / txt / md / csv")

    print(f"已保存：{path}，共 {changed} 处改动")


def do_info(path):
    target = Path(path)
    info = {"path": str(target), "name": target.name, "suffix": target.suffix.lower(), "bytes": target.stat().st_size}
    if target.suffix.lower() in (".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif"):
        from PIL import Image
        with Image.open(target) as image:
            info.update({"width": image.width, "height": image.height, "format": image.format})
    print(json.dumps(info, ensure_ascii=False))


def do_create(spec_path):
    spec = json.loads(Path(spec_path).read_text(encoding="utf-8-sig"))
    target = Path(spec["path"])
    target.parent.mkdir(parents=True, exist_ok=True)
    suffix = target.suffix.lower()
    blocks = spec.get("blocks") or []

    if suffix == ".docx":
        from docx import Document
        from docx.shared import Pt
        document = Document()
        if spec.get("title"):
            document.add_heading(str(spec["title"]), level=0)
        for block in blocks:
            kind = block.get("type", "paragraph")
            text = str(block.get("text", block.get("content", "")))
            if kind == "heading":
                document.add_heading(text, level=int(block.get("level", 1)))
            elif kind == "bullet":
                document.add_paragraph(text, style="List Bullet")
            else:
                paragraph = document.add_paragraph(text)
                paragraph.paragraph_format.space_after = Pt(6)
        document.save(target)

    elif suffix in (".xlsx", ".xlsm"):
        from openpyxl import Workbook
        workbook = Workbook()
        sheets = spec.get("sheets") or [{"name": "Sheet1", "rows": blocks and [[b.get("text", "")] for b in blocks] or []}]
        first = True
        for sheet_spec in sheets:
            sheet = workbook.active if first else workbook.create_sheet()
            sheet.title = str(sheet_spec.get("name") or ("Sheet1" if first else "Sheet"))
            first = False
            for row in sheet_spec.get("rows") or []:
                sheet.append([cell for cell in row])
        workbook.save(target)

    elif suffix == ".pptx":
        from pptx import Presentation
        from pptx.util import Inches, Pt
        presentation = Presentation()
        slides = spec.get("slides") or []
        if not slides:
            slides = [{"title": spec.get("title") or target.stem, "bullets": [b.get("text", "") for b in blocks]}]
        for slide_spec in slides:
            slide = presentation.slides.add_slide(presentation.slide_layouts[1])
            slide.shapes.title.text = str(slide_spec.get("title") or "")
            body = slide.placeholders[1].text_frame
            body.text = ""
            for index, bullet in enumerate(slide_spec.get("bullets") or []):
                paragraph = body.paragraphs[0] if index == 0 else body.add_paragraph()
                paragraph.text = str(bullet)
                paragraph.font.size = Pt(20)
            if slide_spec.get("notes"):
                slide.notes_slide.notes_text_frame.text = str(slide_spec["notes"])
        presentation.save(target)

    elif suffix in (".txt", ".md", ".csv"):
        lines = []
        if spec.get("title"):
            lines.append(("# " if suffix == ".md" else "") + str(spec["title"]))
        for block in blocks:
            text = str(block.get("text", block.get("content", "")))
            if block.get("type") == "heading":
                lines.append(("#" if suffix == ".md" else "") + " " + text)
            elif block.get("type") == "bullet":
                lines.append("- " + text)
            else:
                lines.append(text)
        if spec.get("text"):
            lines.append(str(spec["text"]))
        target.write_text("\n".join(lines) + "\n", encoding="utf-8")

    else:
        fail(f"暂不支持创建 {suffix or '未知'} 类型，支持 docx / xlsx / pptx / txt / md / csv / wps")

    print(f"已创建：{target.name}（{target.stat().st_size} 字节）")


def do_office_edit(spec_path):
    spec = json.loads(Path(spec_path).read_text(encoding="utf-8-sig"))
    target = Path(spec["path"])
    ops = spec.get("ops") or []
    suffix = target.suffix.lower()
    changed = 0

    if suffix == ".docx":
        from docx import Document
        from docx.shared import Inches
        document = Document(str(target))
        for op in ops:
            kind = op.get("type", "replace")
            if kind == "heading":
                document.add_heading(str(op.get("text", "")), level=int(op.get("level", 1)))
                changed += 1
            elif kind == "paragraph":
                document.add_paragraph(str(op.get("text", "")))
                changed += 1
            elif kind == "table":
                rows = op.get("rows") or []
                if rows:
                    table = document.add_table(rows=len(rows), cols=len(rows[0]))
                    for r, row in enumerate(rows):
                        for c, value in enumerate(row):
                            table.cell(r, c).text = str(value)
                    changed += 1
            elif kind == "image":
                image_path = Path(op["path"])
                if not image_path.is_absolute():
                    image_path = target.parent / image_path
                document.add_picture(str(image_path), width=Inches(float(op.get("width", 4))))
                changed += 1
            elif kind == "replace":
                find, repl = str(op.get("find", "")), str(op.get("replace", ""))
                for paragraph in document.paragraphs:
                    if find in paragraph.text:
                        paragraph.text = paragraph.text.replace(find, repl)
                        changed += 1
                for table in document.tables:
                    for row in table.rows:
                        for cell in row.cells:
                            if find in cell.text:
                                cell.text = cell.text.replace(find, repl)
                                changed += 1
        document.save(str(target))

    elif suffix in (".xlsx", ".xlsm"):
        from openpyxl import load_workbook
        from openpyxl.styles import Font, PatternFill
        workbook = load_workbook(str(target))
        for op in ops:
            sheet = workbook[op["sheet"]] if op.get("sheet") else workbook.active
            kind = op.get("type", "cell")
            if kind == "cell":
                cell = sheet[str(op["cell"])]
                if op.get("formula"):
                    cell.value = str(op["formula"])
                else:
                    cell.value = op.get("value")
                if op.get("bold"):
                    cell.font = Font(bold=True)
                if op.get("fill"):
                    cell.fill = PatternFill("solid", fgColor=str(op["fill"]).lstrip("#"))
                changed += 1
            elif kind == "row":
                sheet.append([value for value in (op.get("values") or [])])
                changed += 1
            elif kind == "sheet":
                workbook.create_sheet(str(op.get("title") or "Sheet"))
                changed += 1
        workbook.save(str(target))

    elif suffix == ".pptx":
        from pptx import Presentation
        from pptx.util import Inches, Pt
        presentation = Presentation(str(target))
        for op in ops:
            kind = op.get("type", "slide")
            if kind == "slide":
                slide = presentation.slides.add_slide(presentation.slide_layouts[1])
                slide.shapes.title.text = str(op.get("title", ""))
                body = slide.placeholders[1].text_frame
                body.text = ""
                for index, bullet in enumerate(op.get("bullets") or []):
                    paragraph = body.paragraphs[0] if index == 0 else body.add_paragraph()
                    paragraph.text = str(bullet)
                    paragraph.font.size = Pt(20)
                changed += 1
            elif kind == "image":
                image_path = Path(op["path"])
                if not image_path.is_absolute():
                    image_path = target.parent / image_path
                slide = presentation.slides.add_slide(presentation.slide_layouts[6])
                slide.shapes.add_picture(str(image_path), Inches(0.5), Inches(0.5), width=Inches(9))
                changed += 1
            elif kind == "replace":
                find, repl = str(op.get("find", "")), str(op.get("replace", ""))
                for slide in presentation.slides:
                    for shape in slide.shapes:
                        if getattr(shape, "has_text_frame", False):
                            for paragraph in shape.text_frame.paragraphs:
                                for run in paragraph.runs:
                                    if find in run.text:
                                        run.text = run.text.replace(find, repl)
                                        changed += 1
        presentation.save(str(target))

    else:
        fail(f"暂不支持 {suffix} 的高级编辑，支持 docx / xlsx / pptx")

    print(f"已更新：{target.name}，{changed} 处改动")


def main(argv):
    if len(argv) < 3:
        fail("usage: doc_tools.py <read|create|convert|edit|office_edit|info> <path> ...")
    command, path = argv[1], argv[2]
    if command == "read":
        do_read(path)
    elif command == "info":
        do_info(path)
    elif command == "convert":
        if len(argv) < 4:
            fail("convert 需要目标路径：convert <src> <dst> [--width N] [--quality Q]")
        width = None
        quality = 88
        rest = argv[4:]
        for index, token in enumerate(rest):
            if token == "--width":
                width = int(rest[index + 1])
            if token == "--quality":
                quality = int(rest[index + 1])
        do_convert(path, argv[3], width, quality)
    elif command == "create":
        if len(argv) < 3:
            fail("create 需要 spec 文件：create <spec.json>")
        do_create(path)
    elif command == "office_edit":
        if len(argv) < 3:
            fail("office_edit 需要 spec 文件：office_edit <spec.json>")
        do_office_edit(path)
    elif command == "edit":
        if len(argv) < 4:
            fail("edit 需要操作文件：edit <path> <ops.json>")
        do_edit(path, argv[3])
    else:
        fail(f"未知命令 {command}")


if __name__ == "__main__":
    main(sys.argv)
