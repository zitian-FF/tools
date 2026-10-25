#!/usr/bin/env python3
"""Generate the watch face's device resources from the design handoff.

Usage:
    python3 make_resources.py <path to claude-handoff folder>

Writes into ../resources:
  drawables/portraits/<id>.png   304x304 opaque portraits: the circular
                                 headshot scaled to the portrait disk, with
                                 an anti-aliased edge blended onto black
                                 (cheaper than alpha and the face is black)
  drawables/portraits.xml        bitmap resource list
  drawables/launcher_icon.png    56x56 icon from the first portrait
  fonts/hour.fnt|png, minute.fnt|png
                                 digit-only BMFont fonts rendered from Barlow
                                 Condensed Bold (SIL Open Font License, see
                                 fonts/), so the face needs no device system
                                 fonts; condensed digits fit the rim blocks

Portraits and the icon are git-ignored (the repo is published by GitHub Pages); rerun this
after a fresh checkout.
"""

import json
import os
import sys

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
RES = os.path.join(HERE, "..", "resources")
DISK = 304                     # portrait disk diameter (radius 152)
SUPERSAMPLE = 4
FONT = os.path.join(HERE, "fonts", "barlow-condensed-latin-700-normal.woff")
FONTS = {"hour": 24, "minute": 19}   # em size in px: digit height ~17 / ~14


def portraits(handoff):
    manifest = json.load(open(os.path.join(handoff, "manifest.json")))
    out_dir = os.path.join(RES, "drawables", "portraits")
    os.makedirs(out_dir, exist_ok=True)
    big = DISK * SUPERSAMPLE
    mask = Image.new("L", (big, big), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, big - 1, big - 1), fill=255)
    mask = mask.resize((DISK, DISK), Image.LANCZOS)
    lines = ["<drawables>"]
    for c in manifest["characters"]:
        src = Image.open(os.path.join(handoff, c["portrait320"])).convert("RGBA")
        art = src.resize((DISK, DISK), Image.LANCZOS)
        black = Image.new("RGBA", (DISK, DISK), (0, 0, 0, 255))
        # Flatten the art's own (circular) alpha onto black, the face's
        # background, then cut a clean anti-aliased disk edge.
        flat = Image.alpha_composite(black, art)
        img = Image.composite(flat, black, mask).convert("RGB")
        img.save(os.path.join(out_dir, c["id"] + ".png"), optimize=True)
        lines.append(f'    <bitmap id="P_{c["id"]}" filename="portraits/{c["id"]}.png" dithering="none"/>')
    lines.append("</drawables>")
    # Launcher icon: the first girl's portrait, circular, 56x56 (vivoactive5).
    first = Image.open(os.path.join(out_dir, manifest["characters"][0]["id"] + ".png"))
    big_icon = first.resize((224, 224), Image.LANCZOS)
    icon_mask = Image.new("L", (224, 224), 0)
    ImageDraw.Draw(icon_mask).ellipse((0, 0, 223, 223), fill=255)
    icon = Image.new("RGBA", (224, 224), (0, 0, 0, 0))
    icon.paste(big_icon, (0, 0), icon_mask)
    icon.resize((56, 56), Image.LANCZOS).save(os.path.join(RES, "drawables", "launcher_icon.png"))
    with open(os.path.join(RES, "drawables", "portraits.xml"), "w") as f:
        f.write("\n".join(lines) + "\n")
    print("portraits:", len(manifest["characters"]))


def bmfont(name, size):
    font = ImageFont.truetype(FONT, size)
    # Tabular figures so every digit has the same advance.
    features = ["tnum"]
    chars = "0123456789"
    boxes = {ch: font.getbbox(ch, features=features) for ch in chars}
    # Tight line box around the digits, so the watch's vertical centring
    # centres the digits themselves rather than an ascender/descender box.
    top = min(b[1] for b in boxes.values())
    bottom = max(b[3] for b in boxes.values())
    line_h = bottom - top
    pad = 1
    cells = []
    x = pad
    for ch in chars:
        b = boxes[ch]
        w = b[2] - b[0]
        adv = round(font.getlength(ch, features=features))
        cells.append((ch, x, b, w, adv))
        x += w + pad * 2
    sheet_w, sheet_h = x, line_h + pad * 2
    sheet = Image.new("RGBA", (sheet_w, sheet_h), (255, 255, 255, 0))
    d = ImageDraw.Draw(sheet)
    rows = []
    for ch, cx, b, w, adv in cells:
        d.text((cx - b[0], pad - top), ch, font=font, fill=(255, 255, 255, 255), features=features)
        rows.append(f"char id={ord(ch)} x={cx} y={pad} width={w} height={line_h} "
                    f"xoffset={b[0]} yoffset=0 xadvance={adv} page=0 chnl=15")
    png = name + ".png"
    sheet.save(os.path.join(RES, "fonts", png))
    fnt = [f'info face="Barlow Condensed" size={size} bold=1 italic=0 charset="" unicode=1 '
           f'stretchH=100 smooth=1 aa=1 padding=0,0,0,0 spacing=1,1',
           f"common lineHeight={line_h} base={line_h} scaleW={sheet_w} scaleH={sheet_h} pages=1 packed=0",
           f'page id=0 file="{png}"',
           f"chars count={len(chars)}"] + rows
    with open(os.path.join(RES, "fonts", name + ".fnt"), "w") as f:
        f.write("\n".join(fnt) + "\n")
    print(f"font {name}: size {size}, digit height {line_h}px, advance {cells[0][4]}px")


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    portraits(sys.argv[1])
    os.makedirs(os.path.join(RES, "fonts"), exist_ok=True)
    for name, size in FONTS.items():
        bmfont(name, size)
    with open(os.path.join(RES, "fonts", "fonts.xml"), "w") as f:
        f.write("<fonts>\n" + "".join(
            f'    <font id="{n.capitalize()}Font" filename="{n}.fnt" antialias="true" filter="0123456789"/>\n'
            for n in FONTS) + "</fonts>\n")


if __name__ == "__main__":
    main()
