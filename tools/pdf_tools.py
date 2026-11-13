"""
PDF helpers for Nalo Flow (PyMuPDF).

  python pdf_tools.py read    <path>
  python pdf_tools.py replace <src> <dst> <ops.json>
  python pdf_tools.py render  <src> <outdir> [max_pages]
"""
import json
import sys
from pathlib import Path

import pymupdf as fitz


def read_pdf(path, max_chars=16000):
    document = fitz.open(path)
    pages = []
    for index, page in enumerate(document, 1):
        text = page.get_text("text").strip()
        pages.append(f"第 {index} 页：\n{text or '（这一页没有文字层）'}")
    document.close()
    joined = "\n\n".join(pages)
    return joined[:max_chars]


def average_color(page, rect):
    """取文字周围最常见的背景色，而不是平均色，避免留下灰块。"""
    from collections import Counter
    try:
        clip = fitz.Rect(max(0, rect.x0 - 4), max(0, rect.y0 - 4), rect.x1 + 4, rect.y1 + 4)
        pix = page.get_pixmap(clip=clip, dpi=48)
        data = pix.samples
        if not data:
            return (1, 1, 1)
        colors = Counter()
        for index in range(0, len(data) - 2, 3):
            r, g, b = data[index], data[index + 1], data[index + 2]
            colors[(r // 24 * 24, g // 24 * 24, b // 24 * 24)] += 1
        value = colors.most_common(1)[0][0]
        return (value[0] / 255, value[1] / 255, value[2] / 255)
    except Exception:
        return (1, 1, 1)


def replace_pdf(src, dst, ops):
    document = fitz.open(src)
    changed = 0
    for page in document:
        hits = []
        for op in ops:
            find = str(op.get("find", ""))
            replace = str(op.get("replace", ""))
            if not find:
                continue
            for rect in page.search_for(find):
                hits.append((rect, replace))
        if not hits:
            continue
        for rect, _ in hits:
            fill = average_color(page, rect)
            page.add_redact_annot(rect, fill=fill)
        page.apply_redactions()
        for rect, replace in hits:
            fill = average_color(page, rect)
            brightness = (fill[0] + fill[1] + fill[2]) / 3
            color = (0, 0, 0) if brightness > 0.5 else (1, 1, 1)
            font_size = max(6, min(rect.height * 0.82, 96))
            try:
                page.insert_text(
                    (rect.x0, rect.y0 + rect.height * 0.78),
                    replace,
                    fontsize=font_size,
                    fontname="china-s",
                    color=color,
                )
            except Exception:
                page.insert_text(
                    (rect.x0, rect.y0 + rect.height * 0.78),
                    replace,
                    fontsize=font_size,
                    color=color,
                )
            changed += 1
    Path(dst).parent.mkdir(parents=True, exist_ok=True)
    document.save(dst, garbage=3, deflate=True)
    document.close()
    print(f"已生成：{dst}，替换 {changed} 处")


def render_pdf(src, outdir, max_pages=5, scale=1.6):
    document = fitz.open(src)
    out = Path(outdir)
    out.mkdir(parents=True, exist_ok=True)
    files = []
    for index, page in enumerate(document):
        if index >= max_pages:
            break
        pix = page.get_pixmap(matrix=fitz.Matrix(scale, scale))
        target = out / f"page-{index + 1}.png"
        pix.save(target)
        files.append(str(target))
    document.close()
    print("\n".join(files))


def main(argv):
    if len(argv) < 3:
        print("usage: pdf_tools.py <read|replace|render> ...", file=sys.stderr)
        sys.exit(2)
    command = argv[1]
    if command == "read":
        print(read_pdf(argv[2]))
    elif command == "replace":
        if len(argv) < 5:
            print("replace 需要 <src> <dst> <ops.json>", file=sys.stderr)
            sys.exit(2)
        ops = json.loads(Path(argv[4]).read_text(encoding="utf-8-sig"))
        if isinstance(ops, dict):
            ops = [ops]
        replace_pdf(argv[2], argv[3], ops)
    elif command == "render":
        max_pages = int(argv[4]) if len(argv) > 4 else 5
        render_pdf(argv[2], argv[3], max_pages)
    else:
        print(f"未知命令 {command}", file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    main(sys.argv)
