from __future__ import annotations

import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

FONT = ImageFont.load_default()
GREEN = (57, 255, 20, 255)
CYAN = (0, 255, 255, 255)
YELLOW = (255, 255, 0, 255)
MAGENTA = (255, 0, 255, 255)
ORANGE = (255, 128, 0, 255)


def dim(image: Image.Image, factor: float = 0.14) -> Image.Image:
    out = image.copy().convert('RGBA')
    px = out.load()
    for y in range(out.height):
        for x in range(out.width):
            r, g, b, a = px[x, y]
            px[x, y] = (int(r * factor), int(g * factor), int(b * factor), a)
    return out


def draw_boxes(image: Image.Image, boxes: list[dict], color, key: str = 'bbox', label: str = 'order') -> Image.Image:
    out = image.copy().convert('RGBA')
    draw = ImageDraw.Draw(out)
    for item in boxes:
        x, y, w, h = item[key]
        draw.rectangle([x - 2, y - 2, x + w + 1, y + h + 1], outline=(0, 0, 0, 255), width=6)
        draw.rectangle([x - 2, y - 2, x + w + 1, y + h + 1], outline=color, width=3)
        text = str(item.get(label, ''))
        if text:
            ty = max(0, y - 18)
            draw.rectangle([x - 2, ty - 2, x + 22, ty + 13], fill=(0, 0, 0, 230))
            draw.text((x, ty), text, fill=color, font=FONT)
    return out


def paint_pixels(image: Image.Image, pixels: set[int], color) -> Image.Image:
    out = image.copy().convert('RGBA')
    px = out.load()
    width = out.width
    for value in pixels:
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
                draw.rectangle([x, y, min(width - 1, x + cell - 1), min(height - 1, y + cell - 1)], fill=(70, 70, 70, 255))
    return out


def remaining(image: Image.Image, removed: set[int]) -> Image.Image:
    out = image.copy().convert('RGBA')
    px = out.load()
    width = out.width
    for value in removed:
        x = value % width
        y = value // width
        r, g, b, _ = px[x, y]
        px[x, y] = (r, g, b, 0)
    bg = checkerboard(out.width, out.height)
    bg.alpha_composite(out)
    return bg


def fit_width(image: Image.Image, width: int) -> Image.Image:
    scale = width / image.width
    return image.resize((width, max(1, int(image.height * scale))), Image.Resampling.NEAREST)


def panel(title: str, image: Image.Image, width: int = 700) -> Image.Image:
    body = fit_width(image, width)
    title_height = 32
    out = Image.new('RGBA', (width, body.height + title_height), (12, 12, 12, 255))
    ImageDraw.Draw(out).text((8, 9), title, fill=(255, 255, 255, 255), font=FONT)
    out.alpha_composite(body, (0, title_height))
    return out


def sheet(panels: list[Image.Image], cols: int = 2, pad: int = 14) -> Image.Image:
    rows = [panels[i:i + cols] for i in range(0, len(panels), cols)]
    col_width = max(item.width for item in panels)
    row_heights = [max(item.height for item in row) for row in rows]
    out = Image.new('RGBA', (cols * col_width + pad * (cols + 1), sum(row_heights) + pad * (len(rows) + 1)), (22, 22, 22, 255))
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
    canonical = Image.open(out_dir / snapshot['panels']['s2:CroppedImage from S1 PxC']).convert('RGBA')

    family = draw_boxes(canonical, snapshot['family'], CYAN)
    shells = draw_boxes(canonical, snapshot['shellMembers'], YELLOW)
    baskets = draw_boxes(canonical, snapshot['baskets'], GREEN)
    basket_pixels = set(snapshot['basketPixels'])
    owned = paint_pixels(dim(canonical), basket_pixels, MAGENTA)
    removed = paint_pixels(dim(canonical), basket_pixels, ORANGE)
    remain = remaining(canonical, basket_pixels)

    panels = [
        panel(f"1  BASKET FAMILY — neon cyan ({len(snapshot['family'])})", family),
        panel(f"2  SHELL FAMILY — neon yellow ({len(snapshot['shellMembers'])})", shells),
        panel(f"3  BASKET OBJECTS — neon green ({len(snapshot['baskets'])})", baskets),
        panel(f"4  BASKET PX — neon magenta ({len(basket_pixels):,})", owned),
        panel('5  REMOVED FROM REMAINING — neon orange', removed),
        panel('6  ACTUAL REMAINING — transparent BasketPx over checkerboard', remain),
    ]

    out = out_dir / 's2-neon-correctness-sheet.png'
    sheet(panels).save(out)
    family.save(out_dir / 's2-family-neon.png')
    shells.save(out_dir / 's2-shell-family-neon.png')
    baskets.save(out_dir / 's2-baskets-neon.png')
    owned.save(out_dir / 's2-basket-px-neon.png')
    remain.save(out_dir / 's2-remaining-checkerboard.png')
    print(out)


if __name__ == '__main__':
    main()
