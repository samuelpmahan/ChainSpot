from __future__ import annotations

import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

FONT = ImageFont.load_default()
CYAN = (0, 255, 255, 255)
GREEN = (0, 255, 80, 255)
MAGENTA = (255, 0, 255, 255)
ORANGE = (255, 128, 0, 255)
YELLOW = (255, 255, 0, 255)
RED = (255, 0, 0, 255)


def ring_box(ring: dict) -> list[float]:
    return [ring['bboxX'], ring['bboxY'], ring['bboxW'], ring['bboxH']]


def draw_boxes(image: Image.Image, boxes: list[list[float]], color, width: int = 7) -> Image.Image:
    out = image.copy().convert('RGBA')
    draw = ImageDraw.Draw(out)
    for x, y, w, h in boxes:
        draw.rectangle([x - 3, y - 3, x + w + 3, y + h + 3], outline=(0, 0, 0, 255), width=width + 4)
        draw.rectangle([x - 3, y - 3, x + w + 3, y + h + 3], outline=color, width=width)
    return out


def draw_accepted(image: Image.Image, tees: list[dict]) -> Image.Image:
    out = draw_boxes(image, [tee['bbox'] for tee in tees], GREEN)
    draw = ImageDraw.Draw(out)
    for tee in tees:
        x, y = tee['center']
        r = 8
        draw.line([x - r, y, x + r, y], fill=MAGENTA, width=5)
        draw.line([x, y - r, x, y + r], fill=MAGENTA, width=5)
    return out


def tee_mask(snapshot: dict) -> Image.Image:
    width = snapshot['canonical']['widthPx']
    height = snapshot['canonical']['heightPx']
    mask = Image.new('L', (width, height), 0)
    px = mask.load()
    for value in snapshot['teePixels']:
        px[value % width, value // width] = 255
    return mask


def exact_local_crops(image: Image.Image, snapshot: dict) -> Image.Image:
    width, height = image.size
    mask = tee_mask(snapshot)
    cols, rows = 3, 6
    cell_w, cell_h = width // cols, height // rows
    canvas = Image.new('RGBA', (width, height), (18, 18, 18, 255))
    draw = ImageDraw.Draw(canvas)

    for index, tee in enumerate(snapshot['tees']):
        cx, cy = tee['center']
        crop_w, crop_h = 140, 110
        x0 = max(0, min(width - crop_w, int(cx - crop_w / 2)))
        y0 = max(0, min(height - crop_h, int(cy - crop_h / 2)))
        x1, y1 = x0 + crop_w, y0 + crop_h

        crop = image.crop((x0, y0, x1, y1)).convert('RGBA')
        local_mask = mask.crop((x0, y0, x1, y1))
        halo = local_mask.filter(ImageFilter.MaxFilter(7))
        crop = Image.alpha_composite(crop, Image.new('RGBA', crop.size, (0, 0, 0, 70)))
        halo_layer = Image.new('RGBA', crop.size, MAGENTA)
        halo_layer.putalpha(halo.point(lambda value: 115 if value else 0))
        crop = Image.alpha_composite(crop, halo_layer)
        exact = Image.new('RGBA', crop.size, MAGENTA)
        exact.putalpha(local_mask)
        crop = Image.alpha_composite(crop, exact)
        crop = crop.resize((cell_w - 8, cell_h - 30), Image.Resampling.NEAREST)

        col, row = index % cols, index // cols
        x, y = col * cell_w, row * cell_h
        canvas.alpha_composite(crop, (x + 4, y + 26))
        draw.text((x + 8, y + 8), f"T{index + 1} exact px={tee['pxCount']}", fill=(255, 255, 255, 255), font=FONT)
        draw.rectangle([x, y, x + cell_w - 1, y + cell_h - 1], outline=(90, 90, 90, 255), width=2)
    return canvas


def checkerboard(width: int, height: int, cell: int = 18) -> Image.Image:
    out = Image.new('RGBA', (width, height), (215, 215, 215, 255))
    draw = ImageDraw.Draw(out)
    for y in range(0, height, cell):
        for x in range(0, width, cell):
            if ((x // cell) + (y // cell)) % 2:
                draw.rectangle([x, y, min(width - 1, x + cell - 1), min(height - 1, y + cell - 1)], fill=(150, 150, 150, 255))
    return out


def remaining(image: Image.Image, snapshot: dict) -> Image.Image:
    out = image.copy().convert('RGBA')
    px = out.load()
    width = out.width
    for value in snapshot['teePixels']:
        x, y = value % width, value // width
        r, g, b, _ = px[x, y]
        px[x, y] = (r, g, b, 0)
    bg = checkerboard(out.width, out.height)
    bg.alpha_composite(out)
    return bg


def rejected_panel(image: Image.Image, snapshot: dict) -> Image.Image:
    out = image.copy().convert('RGBA')
    draw = ImageDraw.Draw(out)
    groups = [
        (snapshot['rings']['excludedByBadge'], RED, 'ring'),
        (snapshot['unframed'], YELLOW, 'ring'),
        (snapshot['rejectedFramed'], ORANGE, 'bbox'),
    ]
    for items, color, mode in groups:
        for item in items:
            x, y, w, h = ring_box(item) if mode == 'ring' else item['bbox']
            draw.rectangle([x - 3, y - 3, x + w + 3, y + h + 3], outline=(0, 0, 0, 255), width=10)
            draw.rectangle([x - 3, y - 3, x + w + 3, y + h + 3], outline=color, width=6)
    draw.rectangle([12, 12, 620, 92], fill=(0, 0, 0, 205))
    draw.text((24, 22), f"RED excluded by Badge mute ({len(snapshot['rings']['excludedByBadge'])})", fill=RED, font=FONT)
    draw.text((24, 44), f"YELLOW ring without frame ({len(snapshot['unframed'])})", fill=YELLOW, font=FONT)
    draw.text((24, 66), f"ORANGE framed outside common family ({len(snapshot['rejectedFramed'])})", fill=ORANGE, font=FONT)
    return out


def fit_width(image: Image.Image, width: int) -> Image.Image:
    scale = width / image.width
    return image.resize((width, max(1, int(image.height * scale))), Image.Resampling.LANCZOS)


def panel(title: str, image: Image.Image, width: int = 700) -> Image.Image:
    body = fit_width(image, width)
    title_height = 36
    out = Image.new('RGBA', (width, body.height + title_height), (12, 12, 12, 255))
    ImageDraw.Draw(out).text((8, 11), title, fill=(255, 255, 255, 255), font=FONT)
    out.alpha_composite(body, (0, title_height))
    return out


def sheet(panels: list[Image.Image], cols: int = 3, pad: int = 10) -> Image.Image:
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
    canonical = Image.open(out_dir / snapshot['panels']['s3:CroppedImage']).convert('RGBA')

    candidates = draw_boxes(canonical, [ring_box(ring) for ring in snapshot['rings']['candidates']], CYAN)
    measured = draw_boxes(canonical, [item['bbox'] for item in snapshot['measured']], ORANGE)
    measured = draw_boxes(measured, [item['bbox'] for item in snapshot['family']], GREEN, width=5)
    accepted = draw_accepted(canonical, snapshot['tees'])
    exact = exact_local_crops(canonical, snapshot)
    remain = remaining(canonical, snapshot)
    rejected = rejected_panel(canonical, snapshot)

    panels = [
        panel(f"1 RING CANDIDATES — cyan ({len(snapshot['rings']['candidates'])})", candidates),
        panel(f"2 ENCLOSING FRAMES — orange ({len(snapshot['measured'])}); FAMILY — green ({len(snapshot['family'])})", measured),
        panel(f"3 ACCEPTED VISIBLE TEE OBJECTS — green + magenta centers ({len(snapshot['tees'])})", accepted),
        panel(f"4 EXACT TeePx — magenta in 18 readable local-context crops ({len(snapshot['teePixels']):,})", exact),
        panel('5 ACTUAL REMAINING — exact TeePx transparent over checkerboard', remain),
        panel('6 REJECTED / NOT-ACCEPTED — production S3 categories', rejected),
    ]

    out = out_dir / 's3-neon-correctness-sheet.png'
    sheet(panels).save(out)
    candidates.save(out_dir / 's3-ring-candidates-neon.png')
    measured.save(out_dir / 's3-family-neon.png')
    accepted.save(out_dir / 's3-visible-tees-neon.png')
    exact.save(out_dir / 's3-tee-px-local-crops.png')
    remain.save(out_dir / 's3-remaining-checkerboard.png')
    rejected.save(out_dir / 's3-rejected-neon.png')
    print(out)


if __name__ == '__main__':
    main()
