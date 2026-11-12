#!/usr/bin/env python3
"""Build the finish textures in src/assets/textures (D42).

Floors come from CC0 ambientCG colour maps (credits in src/assets/textures/LICENSES.md),
shrunk to 512 px, some tinted; wallpapers are drawn here. Prints each texture's average colour:
that is the finish's `color` in contract/finishes.json (the flat look and the fallback).

    uv run --project apps/api python -I apps/web/scripts/make-textures.py <folder with *_Color.jpg>

Pillow is a backend dependency, so this runs in the API's environment.
"""

import math
import random
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageEnhance, ImageStat

OUT = Path(__file__).resolve().parent.parent / "src" / "assets" / "textures"
SIZE = 512
QUALITY = 80

# finish key -> (ambientCG asset, tint as the target average colour or None, desaturate 0..1)
FLOORS = {
    "oak_light": ("WoodFloor040", None, 0.0),
    "oak": ("WoodFloor051", None, 0.0),
    "walnut": ("WoodFloor051", (92, 60, 40), 0.0),
    "herringbone": ("WoodFloor034", None, 0.0),
    "tiles_white": ("Tiles107", None, 0.0),
    "tiles_grey": ("Tiles038", None, 0.0),
    "terracotta": ("Tiles027", (178, 98, 66), 0.0),
    "checker": ("Tiles012", None, 0.0),
    "stone": ("Tiles139", None, 0.0),
    "concrete": ("Concrete046", None, 0.7),
    "carpet": ("Carpet016", None, 0.0),
}


def average(im: Image.Image) -> tuple[int, int, int]:
    r, g, b = (round(c) for c in ImageStat.Stat(im.convert("RGB")).mean)
    return r, g, b


def tint(im: Image.Image, target: tuple[int, int, int]) -> Image.Image:
    """Scale each channel so the average becomes `target` (keeps grain, seams and grout)."""
    avg = average(im)
    bands = [b.point(lambda v, f=t / max(a, 1): min(255, round(v * f))) for b, a, t in zip(im.split(), avg, target)]
    return Image.merge("RGB", bands)


def floor(src_dir: Path, key: str) -> Image.Image:
    asset, target, desat = FLOORS[key]
    im = Image.open(src_dir / f"{asset}_1K-JPG_Color.jpg").convert("RGB")
    w, h = im.size
    im = im.resize((SIZE, SIZE * h // w), Image.Resampling.LANCZOS)
    if desat:
        im = ImageEnhance.Color(im).enhance(1 - desat)
    if target:
        im = tint(im, target)
    return im


# --- wallpapers (project code, same licence as the app); each repeats every 50 cm -------------


def stripes() -> Image.Image:
    im = Image.new("RGB", (SIZE, SIZE), (230, 234, 237))
    d = ImageDraw.Draw(im)
    for x0 in range(0, SIZE, 64):
        d.rectangle([x0, 0, x0 + 22, SIZE], fill=(205, 214, 220))
        d.rectangle([x0 + 30, 0, x0 + 33, SIZE], fill=(214, 221, 226))
    return im


def floral() -> Image.Image:
    im = Image.new("RGB", (SIZE, SIZE), (236, 228, 214))
    d = ImageDraw.Draw(im)
    step = 128
    for row in range(-1, SIZE // step + 1):
        for col in range(-1, SIZE // step + 1):
            cx = col * step + (step // 2 if row % 2 else 0)
            cy = row * step + step // 2
            for k in range(5):
                a = k * 2 * math.pi / 5
                px, py = cx + 15 * math.cos(a), cy + 15 * math.sin(a)
                d.ellipse([px - 11, py - 11, px + 11, py + 11], fill=(214, 196, 168))
            d.ellipse([cx - 7, cy - 7, cx + 7, cy + 7], fill=(190, 160, 120))
            d.line([cx + 18, cy + 24, cx + 40, cy + 48], fill=(170, 182, 150), width=3)
    return im


def geometric() -> Image.Image:
    im = Image.new("RGB", (SIZE, SIZE), (220, 223, 213))
    d = ImageDraw.Draw(im)
    step = 64
    for i in range(-SIZE, 2 * SIZE, step):
        d.line([i, 0, i + SIZE, SIZE], fill=(186, 192, 175), width=3)
        d.line([i, SIZE, i + SIZE, 0], fill=(186, 192, 175), width=3)
    return im


def linen() -> Image.Image:
    rnd = random.Random(7)
    im = Image.new("RGB", (SIZE, SIZE), (230, 223, 210))
    d = ImageDraw.Draw(im)
    for _ in range(900):
        y = rnd.randrange(SIZE)
        x = rnd.randrange(SIZE)
        n = rnd.randrange(30, 140)
        shade = rnd.choice([(219, 211, 196), (238, 232, 221)])
        if rnd.random() < 0.5:
            d.line([x, y, x + n, y], fill=shade)
            d.line([x + n - SIZE, y, x - SIZE, y], fill=shade)  # wrap: tiles seamlessly
        else:
            d.line([x, y, x, y + n], fill=shade)
            d.line([x, y - SIZE, x, y + n - SIZE], fill=shade)
    return im


WALLPAPERS = {"stripes": stripes, "floral": floral, "geometric": geometric, "linen": linen}


def main() -> None:
    src = Path(sys.argv[1])
    OUT.mkdir(parents=True, exist_ok=True)
    for key in FLOORS:
        im = floor(src, key)
        im.save(OUT / f"{key}.jpg", quality=QUALITY, optimize=True, progressive=True)
        print(f"{key:12s} #{'%02x%02x%02x' % average(im)}  {im.size[0]}x{im.size[1]}")
    for key, draw in WALLPAPERS.items():
        im = draw()
        im.save(OUT / f"wallpaper-{key}.jpg", quality=QUALITY, optimize=True, progressive=True)
        print(f"{key:12s} #{'%02x%02x%02x' % average(im)}  wallpaper")


if __name__ == "__main__":
    main()
