#!/usr/bin/env python3
"""Regenerate the default book-cover placeholders.

  python3 bin/make-nocover.py          -> assets/nocover.png       (colour)
  python3 bin/make-nocover.py --eink   -> assets/nocover-eink.png  (grayscale)

The matching SVGs in assets/ are the source of truth for the design.
"""
import os
import sys
from PIL import Image, ImageDraw, ImageFont

EINK = "--eink" in sys.argv

W, H = 600, 900
SS = 3
w, h = W * SS, H * SS

if EINK:
    # a light card on a slightly darker ground, matching the e-ink theme
    img = Image.new("RGB", (w, h), (244, 244, 244))
    ImageDraw.Draw(img).rounded_rectangle(
        [10 * SS, 10 * SS, w - 10 * SS, h - 10 * SS],
        radius=18 * SS, fill=(255, 255, 255))
else:
    img = Image.new("RGB", (w, h))
    px = img.load()
    top, bot = (65, 80, 106), (43, 53, 70)
    for y in range(h):
        t = y / (h - 1)
        row = tuple(round(top[i] + (bot[i] - top[i]) * t) for i in range(3))
        for x in range(w):
            px[x, y] = row

d = ImageDraw.Draw(img, "RGBA")

border_col = (154, 154, 154, 255) if EINK else (255, 255, 255, 36)
m = 26 * SS
d.rounded_rectangle([m, m, w - m, h - m], radius=(14 if EINK else 10) * SS,
                    outline=border_col, width=2 * SS)

# open-book glyph
cx, cy = w // 2, int(h * 0.42)
lw = (7 if EINK else 6) * SS
col = (90, 90, 90, 255) if EINK else (203, 212, 227, 225)
outer, gap, sag = 84 * SS, 9 * SS, 12 * SS
top_y, bot_y = cy - 66 * SS, cy + 66 * SS
d.line([(cx - gap, top_y), (cx - gap, bot_y)], fill=col, width=lw)
d.line([(cx + gap, top_y), (cx + gap, bot_y)], fill=col, width=lw)
d.line([(cx - gap, top_y), (cx - outer, top_y + sag),
        (cx - outer, bot_y + sag), (cx - gap, bot_y)], fill=col, width=lw, joint="curve")
d.line([(cx + gap, top_y), (cx + outer, top_y + sag),
        (cx + outer, bot_y + sag), (cx + gap, bot_y)], fill=col, width=lw, joint="curve")


def load_font(size):
    for name in (
        "/System/Library/Fonts/Helvetica.ttc",
        "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/Library/Fonts/Arial.ttf",
    ):
        if os.path.exists(name):
            return ImageFont.truetype(name, size)
    return ImageFont.load_default()


def spaced(draw, text, y, size, fill, tracking):
    font = load_font(size)
    widths = [draw.textlength(ch, font=font) for ch in text]
    total = sum(widths) + tracking * (len(text) - 1)
    x = (w - total) / 2
    for ch, cw in zip(text, widths):
        draw.text((x, y), ch, font=font, fill=fill)
        x += cw + tracking


main = (51, 51, 51, 255) if EINK else (231, 236, 245, 235)
sub = (128, 128, 128, 255) if EINK else (231, 236, 245, 120)
spaced(d, "NO COVER", int(h * 0.68), 32 * SS, main, 6 * SS)
spaced(d, "SimpleOPDS", int(h * 0.68) + 48 * SS, 15 * SS, sub, 2 * SS)

img = img.resize((W, H), Image.LANCZOS)
name = "nocover-eink.png" if EINK else "nocover.png"
if EINK:
    img = img.convert("L")  # 8-bit grayscale: legible text, still ~3 KB
out = os.path.join(os.path.dirname(__file__), "..", "assets", name)
img.save(out, "PNG", optimize=True)
print("wrote", os.path.normpath(out), os.path.getsize(out), "bytes")
