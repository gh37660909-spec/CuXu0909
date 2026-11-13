"""Generate the Nalo Flow icon set.

Lineage: the Nalo mark (dark tile + white italic serif n). Extension: a tapered
stream arc ending in a node - work flowing into the agent and back out.

Sizes are not naive downscales: glyph height, stroke weight and the amount of
detail are tuned per size so 16/32 px stay readable (bold italic below 64 px).

Run:  python tools/make-icon.py
"""
from __future__ import annotations

import math
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "web"
FONTS = {
    "regular": r"C:\Windows\Fonts\georgiai.ttf",
    "bold": r"C:\Windows\Fonts\georgiaz.ttf",
}
LABEL_FONT = r"C:\Windows\Fonts\segoeui.ttf"

SIZES = (512, 256, 192, 128, 64, 32, 16)
S = 4


def lerp(a: float, b: float, t: float) -> float:
    return a + (b - a) * t


def vertical_gradient(size: int, top: tuple, bottom: tuple) -> Image.Image:
    column = np.linspace(0, 1, size, dtype=np.float32).reshape(size, 1)
    rows = np.zeros((size, size, 3), dtype=np.float32)
    for channel in range(3):
        rows[:, :, channel] = top[channel] + (bottom[channel] - top[channel]) * column
    return Image.fromarray(rows.round().clip(0, 255).astype(np.uint8), "RGB").convert("RGBA")


def radial_glow(size: int, center: tuple, radius: float, strength: float) -> Image.Image:
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float32)
    distance = np.sqrt((xx - center[0]) ** 2 + (yy - center[1]) ** 2) / radius
    falloff = (np.clip(1 - distance, 0, 1) ** 2 * strength * 255).clip(0, 255).astype(np.uint8)
    white = Image.new("RGB", (size, size), (255, 255, 255))
    return Image.merge("RGBA", (*white.split(), Image.fromarray(falloff, "L")))


def squircle(size: int, radius_ratio: float) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size - 1, size - 1],
                                           radius=int(size * radius_ratio), fill=255)
    return mask


def tapered_arc(draw: ImageDraw.ImageDraw, center, radius, start_deg, end_deg,
                width_from, width_to, alpha_from, alpha_to, steps=300):
    for index in range(steps + 1):
        t = index / steps
        angle = math.radians(lerp(start_deg, end_deg, t))
        x = center[0] + math.cos(angle) * radius
        y = center[1] + math.sin(angle) * radius
        width = lerp(width_from, width_to, t ** 1.55)
        alpha = int(lerp(alpha_from, alpha_to, t ** 1.05))
        draw.ellipse([x - width / 2, y - width / 2, x + width / 2, y + width / 2],
                     fill=(255, 255, 255, alpha))


def profile_for(size: int) -> dict:
    """Geometry per size. Detail steps down as the tile shrinks: node -> arc ->
    corner dot -> bare glyph, so nothing becomes a smudge at 16-32 px."""
    if size >= 192:
        return {"font": "regular", "glyph_h": 0.500, "radius": 0.225, "arc_r": 0.412,
                "arc": (152, 341), "arc_w": (0.5, 9.0), "arc_a": (8, 244),
                "node": 11.0, "ring": 4.4, "dot": 0.30, "corner": 0.0,
                "shadow": 9.0, "glow": 0.085, "x": 0.470, "y": 0.545}
    if size >= 96:
        return {"font": "regular", "glyph_h": 0.530, "radius": 0.232, "arc_r": 0.408,
                "arc": (152, 341), "arc_w": (0.8, 11.5), "arc_a": (18, 250),
                "node": 12.5, "ring": 5.2, "dot": 0.30, "corner": 0.0,
                "shadow": 7.0, "glow": 0.09, "x": 0.468, "y": 0.548}
    if size >= 48:
        return {"font": "bold", "glyph_h": 0.590, "radius": 0.240, "arc_r": 0.400,
                "arc": (154, 338), "arc_w": (1.2, 15.0), "arc_a": (28, 238),
                "node": 0.0, "ring": 0.0, "dot": 0.0, "corner": 0.0,
                "shadow": 0.0, "glow": 0.10, "x": 0.466, "y": 0.552}
    if size >= 24:
        return {"font": "bold", "glyph_h": 0.720, "radius": 0.250, "arc_r": 0.0,
                "arc": (0, 0), "arc_w": (0, 0), "arc_a": (0, 0),
                "node": 0.0, "ring": 0.0, "dot": 0.0, "corner": 0.055,
                "shadow": 0.0, "glow": 0.12, "x": 0.472, "y": 0.566}
    return {"font": "bold", "glyph_h": 0.790, "radius": 0.260, "arc_r": 0.0,
            "arc": (0, 0), "arc_w": (0, 0), "arc_a": (0, 0),
            "node": 0.0, "ring": 0.0, "dot": 0.0, "corner": 0.0,
            "shadow": 0.0, "glow": 0.14, "x": 0.500, "y": 0.560}


def fit_font(font_path: str, text: str, target_height: float) -> tuple[ImageFont.FreeTypeFont, tuple]:
    """Pick a font size whose rendered glyph height matches target_height."""
    probe = ImageFont.truetype(font_path, 200)
    bbox = probe.getbbox(text)
    natural = bbox[3] - bbox[1]
    size = max(6, int(round(200 * target_height / natural)))
    font = ImageFont.truetype(font_path, size)
    return font, font.getbbox(text)


def build(size: int) -> Image.Image:
    profile = profile_for(size)
    canvas = size * S
    unit = canvas / 100.0

    base = vertical_gradient(canvas, (46, 46, 52), (16, 16, 18))
    base = Image.alpha_composite(base, radial_glow(canvas, (canvas * 0.33, canvas * 0.21),
                                                   canvas * 0.64, profile["glow"]))

    if profile["arc_r"] > 0:
        center = (canvas * 0.5, canvas * 0.548)
        radius = canvas * profile["arc_r"]
        arc_layer = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
        tapered_arc(ImageDraw.Draw(arc_layer), center, radius,
                    profile["arc"][0], profile["arc"][1],
                    profile["arc_w"][0] * unit, profile["arc_w"][1] * unit,
                    profile["arc_a"][0], profile["arc_a"][1])
        base = Image.alpha_composite(base, arc_layer)

        node_layer = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
        ndraw = ImageDraw.Draw(node_layer)
        if profile["node"] > 0:
            # node sits exactly at the head of the stream
            node_angle = math.radians(profile["arc"][1] + 1.2)
            nx = center[0] + math.cos(node_angle) * radius
            ny = center[1] + math.sin(node_angle) * radius
            ring = profile["node"] * unit
            width = max(1, int(round(profile["ring"] * unit)))
            ndraw.ellipse([nx - ring, ny - ring, nx + ring, ny + ring],
                          outline=(255, 255, 255, 252), width=width)
            if profile["dot"] > 0:
                ndraw.ellipse([nx - ring * profile["dot"], ny - ring * profile["dot"],
                               nx + ring * profile["dot"], ny + ring * profile["dot"]],
                              fill=(255, 255, 255, 255))
            base = Image.alpha_composite(base, node_layer)

    font, bbox = fit_font(FONTS[profile["font"]], "n", canvas * profile["glyph_h"])
    glyph_layer = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    gdraw = ImageDraw.Draw(glyph_layer)
    gw, gh = bbox[2] - bbox[0], bbox[3] - bbox[1]
    gx = canvas * profile["x"] - gw / 2 - bbox[0]
    gy = canvas * profile["y"] - gh / 2 - bbox[1]
    gdraw.text((gx, gy), "n", font=font, fill=(247, 247, 249, 255))

    if profile["shadow"] > 0:
        shadow = glyph_layer.filter(ImageFilter.GaussianBlur(profile["shadow"] * unit / 3))
        alpha = shadow.split()[3].point(lambda value: int(value * 0.5))
        shadow = Image.merge("RGBA", (Image.new("L", (canvas, canvas), 0), Image.new("L", (canvas, canvas), 0),
                                      Image.new("L", (canvas, canvas), 0), alpha))
        shadow_canvas = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
        shadow_canvas.paste(shadow, (0, int(3 * unit)), shadow)
        base = Image.alpha_composite(base, shadow_canvas)

    base = Image.alpha_composite(base, glyph_layer)

    if profile["corner"] > 0:
        corner_layer = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
        cdraw = ImageDraw.Draw(corner_layer)
        cx, cy = canvas * 0.795, canvas * 0.245
        cr = canvas * profile["corner"]
        cdraw.ellipse([cx - cr, cy - cr, cx + cr, cy + cr], fill=(255, 255, 255, 250))
        base = Image.alpha_composite(base, corner_layer)

    rim = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    rdraw = ImageDraw.Draw(rim)
    rdraw.rounded_rectangle([0, 0, canvas - 1, canvas - 1], radius=int(canvas * profile["radius"]),
                            outline=(255, 255, 255, 26), width=max(1, int(1.2 * S)))
    rdraw.rounded_rectangle([0, 0, canvas - 1, canvas - 1], radius=int(canvas * profile["radius"]),
                            outline=(0, 0, 0, 76), width=max(1, int(2.0 * S)))
    base = Image.alpha_composite(base, rim)

    base.putalpha(squircle(canvas, profile["radius"]))
    return base.resize((size, size), Image.LANCZOS)


def main() -> None:
    WEB.mkdir(parents=True, exist_ok=True)
    for size in SIZES:
        image = build(size)
        image.save(WEB / f"icon-{size}.png")
        print("wrote", WEB / f"icon-{size}.png")

    build(256).save(WEB / "icon.ico",
                    sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    print("wrote", WEB / "icon.ico")

    # preview: large detail on top row, actual-size strip below
    sheet = Image.new("RGBA", (900, 700), (12, 12, 13, 255))
    draw = ImageDraw.Draw(sheet)
    label = ImageFont.truetype(LABEL_FONT, 14)
    big = build(512).resize((300, 300), Image.LANCZOS)
    sheet.alpha_composite(big, (30, 30))
    draw.text((30, 340), "512 px master", font=label, fill=(150, 150, 158))

    x, y = 380, 30
    for size in (128, 96, 64, 48, 32, 24, 16):
        image = build(size)
        sheet.alpha_composite(image, (x, y))
        draw.text((x, y + size + 6), f"{size}", font=label, fill=(150, 150, 158))
        x += max(size, 44) + 16
        if x > 840:
            x, y = 380, 30 + 200

    strip_y = 400
    draw.text((30, strip_y - 22), "actual size", font=label, fill=(150, 150, 158))
    x = 30
    for size in (256, 128, 64, 48, 32, 16):
        sheet.alpha_composite(build(size), (x, strip_y))
        x += size + 18
    sheet.save(ROOT / "tools" / "icon-preview.png")
    print("wrote", ROOT / "tools" / "icon-preview.png")


if __name__ == "__main__":
    main()


