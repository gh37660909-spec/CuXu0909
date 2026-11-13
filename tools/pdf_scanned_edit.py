"""
Patch text on scanned PDF pages using OCR boxes + PIL.

  python pdf_scanned_edit.py <images_dir> <boxes.json> <ops.json> <out.pdf>

boxes.json: {"page-1.png": {"lines": [{"text","x","y","w","h"}]}, ...}
ops.json:   [{"find": "...", "replace": "..."}]
"""
import json
import re
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

FONT_PATHS = [
    "C:/Windows/Fonts/msyh.ttc",
    "C:/Windows/Fonts/msyhbd.ttc",
    "C:/Windows/Fonts/simhei.ttf",
]


def load_font(size):
    for path in FONT_PATHS:
        try:
            return ImageFont.truetype(path, max(8, int(size)))
        except Exception:
            continue
    return ImageFont.load_default()


def background_color(image, box):
    x, y, w, h = box
    samples = []
    for px, py in [
        (max(0, x - 3), max(0, y - 3)),
        (min(image.width - 1, x + w + 3), max(0, y - 3)),
        (max(0, x - 3), min(image.height - 1, y + h + 3)),
        (min(image.width - 1, x + w + 3), min(image.height - 1, y + h + 3)),
    ]:
        samples.append(image.getpixel((px, py)))
    if not samples:
        return (255, 255, 255)
    samples.sort(key=lambda c: sum(c[:3]))
    return samples[-1][:3]


def main(argv):
    images_dir = Path(argv[1])
    boxes = json.loads(Path(argv[2]).read_text(encoding="utf-8-sig"))
    ops = json.loads(Path(argv[3]).read_text(encoding="utf-8-sig"))
    out_pdf = Path(argv[4])

    pages = []
    changed = 0
    for image_path in sorted(images_dir.glob("page-*.png")):
        image = Image.open(image_path).convert("RGB")
        draw = ImageDraw.Draw(image)
        lines = (boxes.get(image_path.name) or {}).get("lines") or []
        for op in ops:
            find = str(op.get("find", ""))
            replace = str(op.get("replace", ""))
            if not find:
                continue
            for line in lines:
                def norm(value):
                    return re.sub(r"\s+", "", str(value or ""))
                if norm(find) not in norm(line.get("text", "")):
                    continue
                box = (line["x"], line["y"], line["w"], line["h"])
                fill = background_color(image, box)
                draw.rectangle(
                    [box[0] - 2, box[1] - 2, box[0] + box[2] + 2, box[1] + box[3] + 2],
                    fill=fill,
                )
                brightness = sum(fill) / 3
                color = (0, 0, 0) if brightness > 140 else (255, 255, 255)
                font = load_font(box[3] * 0.8)
                draw.text((box[0], box[1]), replace, font=font, fill=color)
                changed += 1
        pages.append(image)

    if not pages:
        raise SystemExit("没有渲染出页面")
    pages[0].save(out_pdf, "PDF", save_all=True, append_images=pages[1:], resolution=150)
    print(f"已生成：{out_pdf}，替换 {changed} 处")


if __name__ == "__main__":
    main(sys.argv)
