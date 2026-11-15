# Ground detail maps from the source textures in docs/ (one set per look):
#   R = grass, G = sand, B = earth, A = asphalt — each the texture's brightness,
#   centred on 0.5 with an even contrast, made seamless and cut to 512 px.
# The ground and road shaders keep their own colours (palette, seasons, snow, night)
# and take only this pattern from the map: one texture read per pixel.
#
#   python scripts/ground-textures.py      (Pillow only)
#
# source: docs/green1.png, sand1.png, earth1.png, asphalt1.png

from pathlib import Path
from statistics import fmean, pstdev
from PIL import Image, ImageFilter, ImageChops

ROOT = Path(__file__).resolve().parent.parent
SIZE = 512
SETS = {'realistic': '1'}
CHANNELS = ['green', 'sand', 'earth', 'asphalt']


def edge_mask() -> Image.Image:
    """1 at the picture's edges, 0 in its middle: where the half-shifted copy takes over."""
    mask = Image.new('L', (SIZE, SIZE))
    px = []
    for y in range(SIZE):
        fy = abs(y / (SIZE - 1) * 2 - 1)
        for x in range(SIZE):
            fx = abs(x / (SIZE - 1) * 2 - 1)
            e = min(1.0, max(0.0, (max(fx, fy) - 0.55) / 0.4)) ** 1.5
            px.append(int(e * 255 + 0.5))
    mask.putdata(px)
    return mask


MASK = edge_mask()


def detail(path: Path) -> Image.Image:
    lum = Image.open(path).convert('RGB').resize((SIZE, SIZE), Image.LANCZOS).convert('L')
    # seamless: blend with itself shifted by half, so the seams of one fall where the other is whole
    lum = Image.composite(ImageChops.offset(lum, SIZE // 2, SIZE // 2), lum, MASK)
    # the broadest light and dark is left to the shader's own noise: keep the grain
    blur = list(lum.filter(ImageFilter.GaussianBlur(SIZE / 8)).get_flattened_data())
    grain = [v - b * 0.7 for v, b in zip(lum.get_flattened_data(), blur)]
    mean, std = fmean(grain), pstdev(grain) or 1.0
    out = Image.new('L', (SIZE, SIZE))
    out.putdata([max(0, min(255, int(127.5 + (g - mean) / (std * 4) * 255))) for g in grain])
    return out


for name, suffix in SETS.items():
    planes = [detail(ROOT / 'docs' / f'{c}{suffix}.png') for c in CHANNELS]
    out = ROOT / 'public' / 'textures' / f'ground-{name}.png'
    out.parent.mkdir(parents=True, exist_ok=True)
    Image.merge('RGBA', planes).save(out, optimize=True)
    print(out.relative_to(ROOT), out.stat().st_size // 1024, 'KB')
