from __future__ import annotations

import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

FONT = ImageFont.load_default()
NEON_GREEN = (57, 255, 20, 255)
NEON_CYAN = (0, 255, 255, 255)
NEON_YELLOW = (255, 255, 0, 255)
NEON_MAGENTA = (255, 0, 255, 255)


def dim_base(image: Image.Image, factor: float = 0.14) -> Image.Image:
    out = image.copy().convert('RGBA')
    px = out.load()
    for y in range(out.height):
        for x in range(out.width):
            r, g, b, a = px[x, y]
            px[x, y] = (int(r * factor), int(g * factor), int(b * factor), a)
    return out


def paint_pixels(image: Image.Image, indexes: set[int], color: tuple[int, int, int, int]) -> Image.Image:
    out = image.copy()
    px = out.load()
    width = out.width
    for value in indexes:
        x = value % width
        y = value // width
        if 0 <= x < out.width and 0 <= y < out.height:
            px[x, y] = color
    return out


def checkerboard(width: int, height: int, cell: int = 16) -> Image.Image:
    out = Image.new('RGBA', (width, height), (35, 35, 35, 255))
    draw = ImageDraw.Draw(out)
    for y in range(0, height, cell):
        for x in range(0, width, cell):
            if ((x // cell) + (y // cell)) % 2:
                draw.rectangle(
                    [x, y, min(width - 1, x + cell - 1), min(height - 1, y + cell - 1)],
                    fill=(70, 70, 70, 255),
                )
    return out


def remaining(image: Image.Image, muted: set[int]) -> Image.Image:
    out = image.copy().convert('RGBA')
    px = out.load()
    width = out.width
    for value in muted:
        x = value % width
        y = value // width
        r, g, b, _ = px[x, y]
        px[x, y] = (r, g, b, 0)
    bg = checkerboard(out.width, out.height)
    bg.alpha_composite(out)
    return bg


def badge_boxes(image: Image.Image, badges: list[dict]) -> Image.Image:
    out = image.copy().convert('RGBA')
    draw = ImageDraw.Draw(out)
    for index, badge in enumerate(badges, 1):
        x, y, width, height = badge['bbox']
        draw.rectangle([x - 2, y - 2, x + width + 1, y + height + 1], outline=(0, 0, 0, 255), width=6)
        draw.rectangle([x - 2, y - 2, x + width + 1, y + height + 1], outline=NEON_GREEN, width=3)
        label = str(badge['label'] or index)
        ty = max(0, y - 18)
        draw.rectangle([x - 2, ty - 2, x + 18, ty + 13], fill=(0, 0, 0, 230))
        draw.text((x, ty), label, fill=NEON_GREEN, font=FONT)
    return out


def fit_width(image: Image.Image, width: int) -> Image.Image:
    scale = width / image.width
    return image.resize((width, max(1, int(image.height * scale))), Image.Resampling.NEAREST)


def panel(title: str, image: Image.Image, width: int = 700) -> Image.Image:
    body = fit_width(image, width)
    title_height = 32
    out = Image.new('RGBA', (width, body.height + title_height), (12, 12, 12, 255))
    draw = ImageDraw.Draw(out)
    draw.text((8, 9), title, fill=(255, 255, 255, 255), font=FONT)
    out.alpha_composite(body, (0, title_height))
    return out


def contact_sheet(panels: list[Image.Image], cols: int = 2, pad: int = 14) -> Image.Image:
    rows = [panels[i:i + cols] for i in range(0, len(panels), cols)]
    col_width = max(item.width for item in panels)
    row_heights = [max(item.height for item in row) for row in rows]
    out = Image.new(
        'RGBA',
        (cols * col_width + pad * (cols + 1), sum(row_heights) + pad * (len(rows) + 1)),
        (22, 22, 22, 255),
    )
    y = pad
    for row, row_height in zip(rows, row_heights):
        x = pad
        for item in row:
            out.alpha_composite(item, (x, y))
            x += col_width + pad
        y += row_height + pad
    return out


def main() -> None:
    snapshot_path = Path(sys.argv[1]).resolve()
    snapshot = json.loads(snapshot_path.read_text())
    out_dir = snapshot_path.parent

    canonical = Image.open(out_dir / snapshot['panels']['s0:CroppedImage']).convert('RGBA')
    masks = Image.open(out_dir / snapshot['panels']['s1:Masks']).convert('RGBA')
    owned = set(snapshot['ownedPixels'])
    muted = set(snapshot['mutedPixels'])
    added = muted - owned

    owned_view = paint_pixels(dim_base(canonical), owned, NEON_CYAN)
    added_view = paint_pixels(dim_base(canonical), added, NEON_YELLOW)
    muted_view = paint_pixels(dim_base(canonical), owned, NEON_CYAN)
    muted_view = paint_pixels(muted_view, added, NEON_YELLOW)
    removed_view = paint_pixels(dim_base(canonical), muted, NEON_MAGENTA)
    remaining_view = remaining(canonical, muted)
    badge_view = badge_boxes(canonical, snapshot['badges'])

    panels = [
        panel('1  BADGE OBJECTS — neon green boxes + labels', badge_view),
        panel('2  MASKS — production bright/dark mask', masks),
        panel(f'3  OWNED PX — neon cyan ({len(owned):,})', owned_view),
        panel(f'4  ADDED MUTE ONLY — neon yellow ({len(added):,})', added_view),
        panel(f'5  MUTED TOTAL — cyan owned + yellow added ({len(muted):,})', muted_view),
        panel('6  REMOVED FROM REMAINING — neon magenta', removed_view),
        panel('7  ACTUAL REMAINING — transparent removals over checkerboard', remaining_view),
    ]

    sheet_path = out_dir / 's1-neon-correctness-sheet.png'
    contact_sheet(panels).save(sheet_path)
    owned_view.save(out_dir / 's1-owned-neon.png')
    added_view.save(out_dir / 's1-added-mute-neon.png')
    muted_view.save(out_dir / 's1-muted-neon.png')
    removed_view.save(out_dir / 's1-removed-neon.png')
    remaining_view.save(out_dir / 's1-remaining-checkerboard.png')
    badge_view.save(out_dir / 's1-badge-objects-neon.png')
    print(sheet_path)


if __name__ == '__main__':
    main()
