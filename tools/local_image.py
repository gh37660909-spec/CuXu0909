from PIL import Image, ImageDraw, ImageFilter, ImageFont
import sys, random, textwrap, os, hashlib, math

prompt = sys.argv[1] if len(sys.argv) > 1 else 'Nalo Code image'
out = sys.argv[2] if len(sys.argv) > 2 else 'image.png'
seed = int(hashlib.sha1(prompt.encode('utf-8')).hexdigest()[:8], 16)
random.seed(seed)

vertical = any(word in prompt for word in ('海报', '竖版', '手机', '9:16', '封面'))
W, H = (1080, 1440) if vertical else (1600, 900)

palettes = [
    ((9, 20, 38), (20, 66, 88), (76, 225, 170)),
    ((28, 18, 42), (78, 34, 92), (255, 154, 92)),
    ((10, 30, 26), (22, 74, 58), (244, 208, 96)),
    ((22, 22, 28), (56, 56, 72), (120, 190, 255)),
    ((42, 18, 22), (92, 34, 42), (255, 196, 120)),
    ((18, 30, 48), (36, 64, 110), (180, 220, 255)),
    ((38, 32, 24), (92, 76, 48), (255, 220, 150)),
]
base, mid, accent = palettes[seed % len(palettes)]
img = Image.new('RGB', (W, H), base)
d = ImageDraw.Draw(img)

# gradient background
for y in range(H):
    t = y / max(1, H - 1)
    r = int(base[0] + (mid[0] - base[0]) * t)
    g = int(base[1] + (mid[1] - base[1]) * t)
    b = int(base[2] + (mid[2] - base[2]) * t)
    d.line([(0, y), (W, y)], fill=(r, g, b))

# soft light
glow = Image.new('RGBA', (W, H), (0, 0, 0, 0))
gd = ImageDraw.Draw(glow)
for i in range(6):
    x = random.randint(-W // 3, W)
    y = random.randint(-H // 3, H)
    rad = random.randint(W // 4, W // 2)
    gd.ellipse([x - rad, y - rad, x + rad, y + rad], fill=(*accent, random.randint(12, 26)))
glow = glow.filter(ImageFilter.GaussianBlur(110))
img = Image.alpha_composite(img.convert('RGBA'), glow).convert('RGB')
d = ImageDraw.Draw(img)

# thin geometry
for i in range(5):
    x = int(W * (0.08 + i * 0.21)) + random.randint(-30, 30)
    d.line([(x, 0), (x + random.randint(-100, 100), H)], fill=(*accent, 35), width=1)
for i in range(4):
    y = int(H * (0.18 + i * 0.22))
    d.arc([-W // 4, y - H // 2, W + W // 4, y + H // 2], 200, 340, fill=(255, 255, 255, 40), width=2)

# sport motif
sport = 'football' if any(k in prompt.lower() for k in ('足球', 'football', 'soccer')) else ('basketball' if any(k in prompt.lower() for k in ('篮球', 'basketball')) else '')
if sport == 'football':
    left, top, right, bottom = int(W * .52), int(H * .16), int(W * .93), int(H * .72)
    d.rounded_rectangle([left, top, right, bottom], radius=24, outline=(255, 255, 255, 90), width=3)
    d.line([W // 2, top, W // 2, bottom], fill=(255, 255, 255, 80), width=2)
    d.ellipse([W // 2 - 90, H // 2 - 90, W // 2 + 90, H // 2 + 90], outline=(255, 255, 255, 80), width=2)
    cx, cy, r = int(W * .74), int(H * .4), 92
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(248, 250, 252), outline=(30, 40, 52), width=4)
    for ang in range(0, 360, 72):
        a = math.radians(ang)
        x = cx + math.cos(a) * r * .52
        y = cy + math.sin(a) * r * .52
        pts = [(x + math.cos(a + k * 2.513) * 26, y + math.sin(a + k * 2.513) * 26) for k in range(5)]
        d.polygon(pts, fill=(24, 32, 44))
elif sport == 'basketball':
    cx, cy, r = int(W * .74), int(H * .38), 112
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(226, 112, 48), outline=(40, 30, 24), width=4)
    d.line([cx - r, cy, cx + r, cy], fill=(40, 30, 24), width=5)
    d.line([cx, cy - r, cx, cy + r], fill=(40, 30, 24), width=5)
    d.arc([cx - r, cy - r, cx + r, cy + r], 40, 220, fill=(40, 30, 24), width=5)
    d.arc([cx - r, cy - r, cx + r, cy + r], 220, 400, fill=(40, 30, 24), width=5)
else:
    # abstract data/illustration blocks
    for i in range(5):
        x = int(W * .55) + random.randint(-20, 180)
        y = int(H * .18) + i * 84
        d.rounded_rectangle([x, y, x + random.randint(150, 320), y + 42], radius=12, fill=(*accent, 34 if i % 2 == 0 else 22))
    d.ellipse([int(W * .68), int(H * .18), int(W * .9), int(H * .52)], outline=(255, 255, 255, 60), width=3)

# text
font_path = r'C:\Windows\Fonts\msyhbd.ttc'
if not os.path.exists(font_path):
    font_path = r'C:\Windows\Fonts\msyh.ttc'
if not os.path.exists(font_path):
    font_path = r'C:\Windows\Fonts\arialbd.ttf'

def font(size):
    try:
        return ImageFont.truetype(font_path, size)
    except Exception:
        return ImageFont.load_default()

clean = ' '.join(prompt.replace('\n', ' ').split())
title = clean[:26] or 'NALO CODE'
d.text((int(W * .06), int(H * .56)), title, font=font(54 if not vertical else 48), fill=(255, 255, 255))
subtitle = 'FOOTBALL' if sport == 'football' else ('BASKETBALL' if sport == 'basketball' else 'AI VISUAL')
d.text((int(W * .062), int(H * .66)), subtitle, font=font(24), fill=accent)
body = textwrap.fill(clean, 32 if not vertical else 24)[:180]
d.text((int(W * .062), int(H * .73)), body, font=font(24), fill=(225, 232, 242), spacing=10)
d.rectangle([int(W * .06), int(H * .9), int(W * .5), int(H * .903)], fill=accent)
d.text((int(W * .06), int(H * .92)), 'NALO CODE  /  LOCAL VISUAL ENGINE', font=font(18), fill=(185, 195, 208))
img.save(out, 'PNG')
print(out)
