#!/usr/bin/env python3
"""Regenerate the default book-cover placeholder (assets/nocover.png).

Kept in the repo so the PNG can be rebuilt; the SVG (assets/nocover.svg) is
the source of truth for the design.
"""
import os
from PIL import Image, ImageDraw, ImageFont

W, H = 600, 900
SS = 3  # supersample for smooth edges
w, h = W * SS, H * SS

img = Image.new("RGB", (w, h))
px = img.load()
top = (65, 80, 106)
bot = (43, 53, 70)
for y in range(h):
    t = y / (h - 1)
    px_row = tuple(round(top[i] + (bot[i] - top[i]) * t) for i in range(3))
    for x in range(w):
        px[x, y] = px_row

d = ImageDraw.Draw(img, "RGBA")

# inner border
m = 26 * SS
d.rounded_rectangle([m, m, w - m, h - m], radius=10 * SS,
                    outline=(255, 255, 255, 36), width=2 * SS)

# open-book glyph: two page quads meeting at a center spine
cx, cy = w // 2, int(h * 0.42)
lw = 6 * SS
col = (203, 212, 227, 225)
outer = 84 * SS      # distance from centre to outer page edge
gap = 9 * SS         # half-gap at the spine
top_y = cy - 66 * SS
bot_y = cy + 66 * SS
sag = 12 * SS        # how much the outer edge droops
d.line([(cx - gap, top_y), (cx - gap, bot_y)], fill=col, width=lw)  # spine, left
d.line([(cx + gap, top_y), (cx + gap, bot_y)], fill=col, width=lw)  # spine, right
d.line(  # left page: spine-top -> outer-top -> outer-bottom -> spine-bottom
    [(cx - gap, top_y), (cx - outer, top_y + sag),
     (cx - outer, bot_y + sag), (cx - gap, bot_y)],
    fill=col, width=lw, joint="curve")
d.line(  # right page (mirror)
    [(cx + gap, top_y), (cx + outer, top_y + sag),
     (cx + outer, bot_y + sag), (cx + gap, bot_y)],
    fill=col, width=lw, joint="curve")

def load_font(size):
    for name in (
        "/System/Library/Fonts/Helvetica.ttc",
        "/System/Library/Fonts/Supplemental/Arial.ttf",
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

spaced(d, "NO COVER", int(h * 0.68), 30 * SS, (231, 236, 245, 235), 6 * SS)
spaced(d, "SimpleOPDS", int(h * 0.68) + 46 * SS, 15 * SS, (231, 236, 245, 120), 2 * SS)

img = img.resize((W, H), Image.LANCZOS)
out = os.path.join(os.path.dirname(__file__), "..", "assets", "nocover.png")
img.save(out, "PNG", optimize=True)
print("wrote", os.path.normpath(out), os.path.getsize(out), "bytes")
