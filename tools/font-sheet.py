"""Contact sheet: compare italic serif 'n' glyphs for the Nalo Flow mark."""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

FONTS = {
    "Georgia Italic": r"C:\Windows\Fonts\georgiai.ttf",
    "Cambria Italic": r"C:\Windows\Fonts\cambriai.ttf",
    "Times Italic": r"C:\Windows\Fonts\timesi.ttf",
    "Palatino Italic": r"C:\Windows\Fonts\palai.ttf",
    "Constantia Italic": r"C:\Windows\Fonts\constani.ttf",
    "Garamond Italic": r"C:\Windows\Fonts\GARAIT.TTF",
    "Bookman Italic": r"C:\Windows\Fonts\bookos.ttf",
}

CELL = 320
sheet = Image.new("RGB", (CELL * len(FONTS), CELL + 34), "#1c1c1f")
draw = ImageDraw.Draw(sheet)
label_font = ImageFont.truetype(r"C:\Windows\Fonts\segoeui.ttf", 15)

for index, (name, path) in enumerate(FONTS.items()):
    x = index * CELL
    draw.rounded_rectangle([x + 18, 18, x + CELL - 18, CELL - 16], radius=64, fill="#232329")
    try:
        font = ImageFont.truetype(path, 210)
    except Exception as error:  # pragma: no cover
        draw.text((x + 24, 120), f"fail: {error}", fill="#ff8888")
        continue
    bbox = draw.textbbox((0, 0), "n", font=font)
    width, height = bbox[2] - bbox[0], bbox[3] - bbox[1]
    draw.text((x + (CELL - width) / 2 - bbox[0], 24 + (CELL - 58 - height) / 2 - bbox[1]),
              "n", font=font, fill="#f6f6f8")
    draw.text((x + 22, CELL + 4), name, font=label_font, fill="#9a9aa2")

out = Path(r"C:\Users\Admin（无密码）\Documents\deepseek-harness\default-workspace\nalo-flow\tools\font-sheet.png")
out.parent.mkdir(parents=True, exist_ok=True)
sheet.save(out)
print(out, sheet.size)
