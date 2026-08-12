#!/usr/bin/env python3
"""Dash basket-glyph occluder spike, Python transcription.

Tests whether rendered basket UI glyphs sever otherwise-continuous ribbon
mass, using strictly local closing inside the production basket-icon footprint.
No rings, no global union-find. Renders a sparse overview plus target-hole
contact sheet with explicit TEE / NUMBER / BASKET / GLYPH / REPAIR labels.
"""
from __future__ import annotations

import argparse
import io
import json
import math
import zipfile
from collections import deque
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont
from scipy import ndimage as ndi
from skimage.color import rgb2lab
from skimage.measure import label as cc_label, regionprops

REPO = Path(__file__).resolve().parents[2]
GOLDEN_ZIP = REPO / "resources/GoldenTeeSet.chainspot.zip"
GOLDEN_DETECTOR_CACHE = REPO / "scripts/cv-probes/hole-path-results/tuning/badge-cache/GoldenTeeSet-f7eb83c2ed515e94.json"

SCALE = 3
BOX_MEAN_WINDOW = 41
RAY_EVIDENCE_DL = 10.0
OPEN_SIZE = 7
EVIDENCE_THRESH = 0.2
MIN_COMPONENT_PX = 25
TEXTURE_LSTD_MIN = 12.0
SEED_RADIUS_PX = 40.0
BADGE_HALF_W_PX = 40.0
BADGE_HALF_H_PX = 30.0
MAX_CLOSE_PX = 18.0
GAP_THRESHOLDS_PX = (6, 9, 12, 15, 18)
BASKET_ICON_VERTICAL_OFFSET_UI = 20.0
BASKET_ICON_RADIUS_UI = 28.0

GOLDEN_TRUTH = [
    (1, 884.8377444109449, 431.9287297485859, 520.909799907873, 426.51990558136015),
    (2, 458.1890699314583, 572.3708514226876, 764.8909697077348, 561.3106463391507),
    (3, 736.6058148380408, 714.6225977184242, 495.14541111301537, 627.099586019013),
    (4, 430.7483576493411, 644.5234235908367, 432.3184616324048, 863.8527701115761),
    (5, 491.56578024851615, 853.0390314516907, 685.3405371507645, 796.3447522033824),
    (6, 680.3814775133769, 850.5247486359476, 438.8388685382941, 914.8063409675767),
    (7, 368.65962418131465, 982.3336860325766, 618.8090454892177, 950.4392544203181),
    (8, 514.9311375611513, 1010.8688843716736, 423.53780515507555, 1176.3405127485696),
    (9, 372.5817142119152, 1181.7862886590783, 306.87752170715316, 1413.0335179962228),
    (10, 260.3490808032921, 1463.0891774122085, 138.43612905330735, 1640.5876987977786),
    (11, 73.56806925413619, 1827.735355732454, 391.34286393147585, 1807.8273853587643),
    (12, 419.21206435573754, 1770.303751900341, 339.1160651426048, 1531.067445545252),
    (13, 446.8826273187712, 1472.9553053160814, 688.779301552193, 1590.6311067912745),
    (14, 680.1006626449425, 1506.8815001878377, 816.6160850013131, 1323.6636042303671),
    (15, 875.1573282347795, 1361.7653659724785, 1034.4051911294462, 1084.9287878265427),
    (16, 1156.1751121865675, 1179.2847661157596, 1128.1243178636212, 763.6529034629543),
    (17, 1069.9746471517396, 852.7679190008336, 872.8859719547469, 986.596640679826),
    (18, 788.5810990714863, 850.3708280038526, 1000.1876912467347, 438.4487575793592),
]
GOLDEN_BADGES = [
    (1, 755.0, 449.0), (2, 578.0, 582.0), (3, 607.0, 670.0), (4, 444.0, 744.0),
    (5, 551.0, 813.0), (6, 551.0, 885.0), (7, 444.0, 983.0), (8, 461.0, 1068.0),
    (9, 338.0, 1304.0), (10, 195.0, 1555.0), (11, 241.0, 1818.0), (12, 375.0, 1644.0),
    (13, 572.0, 1535.0), (14, 704.0, 1426.0), (15, 906.0, 1277.0), (16, 1140.5, 966.0),
    (17, 965.0, 922.0), (18, 862.5, 778.0),
]
TARGETS = {
    4: {"glyphs": (4,), "why": "basket end across own B4 glyph"},
    6: {"glyphs": (7,), "why": "tee side across foreign B7 glyph"},
    9: {"glyphs": (9,), "why": "basket end across own B9 glyph"},
    10: {"glyphs": (10,), "why": "suspected basket-end glyph family"},
    12: {"glyphs": (11,), "why": "corridor across foreign B11 glyph"},
}

@dataclass(frozen=True)
class GlyphBand:
    hole_number: int
    x_px: float
    y_px: float
    radius_px: float

@dataclass(frozen=True)
class Connection:
    a: int
    b: int
    gap_px: float
    x_px: float
    y_px: float
    glyph_holes: tuple[int, ...]


def load_source_image(path: Path) -> Image.Image:
    with zipfile.ZipFile(path) as zf:
        data = zf.read("images/source-original.jpg")
    return Image.open(io.BytesIO(data)).convert("RGB")


def load_ui_scale() -> float:
    value = json.loads(GOLDEN_DETECTOR_CACHE.read_text()).get("uiScalePx")
    if not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
        raise RuntimeError(f"No valid uiScalePx in {GOLDEN_DETECTOR_CACHE}")
    return float(value)


def segment_ribbon_mass(full: Image.Image):
    out_w, out_h = full.width // SCALE, full.height // SCALE
    rgb = np.asarray(full.resize((out_w, out_h), Image.Resampling.LANCZOS)).astype(np.float32) / 255.0
    lab_l = rgb2lab(rgb)[..., 0]
    local_mean = ndi.uniform_filter(lab_l, size=BOX_MEAN_WINDOW, mode="reflect")
    ev = np.clip((lab_l - local_mean) / RAY_EVIDENCE_DL, 0.0, 1.0)
    for _, bx, by in GOLDEN_BADGES:
        x0 = max(0, int(math.floor((bx - BADGE_HALF_W_PX) / SCALE)))
        x1 = min(out_w, int(math.ceil((bx + BADGE_HALF_W_PX) / SCALE)))
        y0 = max(0, int(math.floor((by - BADGE_HALF_H_PX) / SCALE)))
        y1 = min(out_h, int(math.ceil((by + BADGE_HALF_H_PX) / SCALE)))
        ev[y0:y1, x0:x1] = 1.0
    opened = ndi.grey_opening(ev, size=(OPEN_SIZE, OPEN_SIZE))
    labels = cc_label(opened >= EVIDENCE_THRESH, connectivity=2).astype(np.int32, copy=False)
    texture_kept: set[int] = set()
    for region in regionprops(labels):
        if region.area < MIN_COMPONENT_PX:
            continue
        if float(lab_l[labels == region.label].std()) >= TEXTURE_LSTD_MIN:
            texture_kept.add(int(region.label))
    return labels, texture_kept


def nearest_component_label(labels: np.ndarray, x_src: float, y_src: float) -> int | None:
    h, w = labels.shape
    xi, yi = int(x_src / SCALE), int(y_src / SCALE)
    if not (0 <= xi < w and 0 <= yi < h):
        return None
    direct = int(labels[yi, xi])
    if direct:
        return direct
    r = max(1, int(round(SEED_RADIUS_PX / SCALE)))
    y0, y1 = max(0, yi - r), min(h, yi + r + 1)
    x0, x1 = max(0, xi - r), min(w, xi + r + 1)
    window = labels[y0:y1, x0:x1]
    ys, xs = np.nonzero(window)
    if len(xs) == 0:
        return None
    d2 = (xs - (xi - x0)) ** 2 + (ys - (yi - y0)) ** 2
    k = int(np.argmin(d2))
    return int(window[ys[k], xs[k]])


def build_seed_placements(labels: np.ndarray):
    badge = {n: nearest_component_label(labels, x, y) for n, x, y in GOLDEN_BADGES}
    basket = {n: nearest_component_label(labels, bx, by) for n, _tx, _ty, bx, by in GOLDEN_TRUTH}
    return badge, basket


def build_glyph_bands(ui_scale_px: float) -> list[GlyphBand]:
    offset = BASKET_ICON_VERTICAL_OFFSET_UI * ui_scale_px
    radius = BASKET_ICON_RADIUS_UI * ui_scale_px
    return [GlyphBand(n, bx, by - offset, radius) for n, _tx, _ty, bx, by in GOLDEN_TRUTH]


def build_band_mask(shape: tuple[int, int], bands: list[GlyphBand]) -> np.ndarray:
    h, w = shape
    band = np.zeros((h, w), dtype=bool)
    for glyph in bands:
        cx, cy, r = glyph.x_px / SCALE, glyph.y_px / SCALE, glyph.radius_px / SCALE
        x0, x1 = max(0, int(math.floor(cx-r))), min(w-1, int(math.ceil(cx+r)))
        y0, y1 = max(0, int(math.floor(cy-r))), min(h-1, int(math.ceil(cy+r)))
        yy, xx = np.mgrid[y0:y1+1, x0:x1+1]
        band[y0:y1+1, x0:x1+1] |= (xx-cx)**2 + (yy-cy)**2 <= r*r
    return band


def glyphs_at(x_px: float, y_px: float, bands: list[GlyphBand]) -> tuple[int, ...]:
    return tuple(sorted(g.hole_number for g in bands if math.hypot(x_px-g.x_px, y_px-g.y_px) <= g.radius_px))


def glyph_close(labels: np.ndarray, band: np.ndarray, bands: list[GlyphBand]) -> list[Connection]:
    h, w = labels.shape
    max_steps = int(math.ceil(MAX_CLOSE_PX / SCALE))
    owner = np.zeros(labels.shape, dtype=np.int32)
    dist = np.full(labels.shape, -1, dtype=np.int16)
    frontier: deque[tuple[int, int]] = deque()
    best: dict[tuple[int, int], Connection] = {}

    def consider(a: int, b: int, gap_steps: int, x: int, y: int):
        if a == b:
            return
        gap_px = gap_steps * SCALE
        if gap_px > MAX_CLOSE_PX:
            return
        aa, bb = sorted((int(a), int(b)))
        x_px, y_px = x*SCALE, y*SCALE
        c = Connection(aa, bb, float(gap_px), float(x_px), float(y_px), glyphs_at(x_px, y_px, bands))
        old = best.get((aa, bb))
        if old is None or c.gap_px < old.gap_px:
            best[(aa, bb)] = c

    for y in range(h):
        for x in range(w):
            if labels[y, x] != 0 or not band[y, x]:
                continue
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    if dx == 0 and dy == 0:
                        continue
                    nx, ny = x+dx, y+dy
                    if not (0 <= nx < w and 0 <= ny < h):
                        continue
                    lbl = int(labels[ny, nx])
                    if lbl == 0:
                        continue
                    if dist[y, x] == -1:
                        dist[y, x], owner[y, x] = 1, lbl
                        frontier.append((x, y))
                    elif owner[y, x] != lbl:
                        consider(int(owner[y, x]), lbl, int(dist[y, x]), x, y)

    for step in range(2, max_steps+1):
        if not frontier:
            break
        nxt: deque[tuple[int, int]] = deque()
        while frontier:
            x, y = frontier.popleft()
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    if dx == 0 and dy == 0:
                        continue
                    nx, ny = x+dx, y+dy
                    if not (0 <= nx < w and 0 <= ny < h):
                        continue
                    if labels[ny, nx] != 0 or not band[ny, nx]:
                        continue
                    if dist[ny, nx] == -1:
                        dist[ny, nx], owner[ny, nx] = step, owner[y, x]
                        nxt.append((nx, ny))
                    elif owner[ny, nx] != owner[y, x]:
                        consider(int(owner[y, x]), int(owner[ny, nx]), int(dist[y, x] + dist[ny, nx]), x, y)
        frontier = nxt
    return sorted(best.values(), key=lambda c: (c.gap_px, c.a, c.b))


def reachable(start: int | None, connections: list[Connection], threshold_px: float) -> set[int]:
    if start is None:
        return set()
    adj: dict[int, set[int]] = {}
    for c in connections:
        if c.gap_px > threshold_px:
            continue
        adj.setdefault(c.a, set()).add(c.b)
        adj.setdefault(c.b, set()).add(c.a)
    seen, stack = {start}, [start]
    while stack:
        cur = stack.pop()
        for nxt in adj.get(cur, ()):
            if nxt not in seen:
                seen.add(nxt)
                stack.append(nxt)
    return seen


def nearest_label_set_distance(labels: np.ndarray, kept: set[int], x_src: float, y_src: float) -> float:
    if not kept:
        return math.inf
    mask = np.isin(labels, list(kept))
    yi, xi = int(round(y_src/SCALE)), int(round(x_src/SCALE))
    if not (0 <= yi < labels.shape[0] and 0 <= xi < labels.shape[1]):
        return math.inf
    if mask[yi, xi]:
        return 0.0
    return float(ndi.distance_transform_edt(~mask)[yi, xi] * SCALE)


def threshold_connects(a: int | None, b: int | None, connections: list[Connection]) -> int | None:
    if a is None or b is None:
        return None
    if a == b:
        return 0
    for threshold in GAP_THRESHOLDS_PX:
        if b in reachable(a, connections, threshold):
            return threshold
    return None


def load_fonts():
    candidates = ["/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "/usr/share/fonts/truetype/liberation2/LiberationSans-Bold.ttf"]
    path = next((p for p in candidates if Path(p).exists()), None)
    if path:
        return {"title": ImageFont.truetype(path, 26), "label": ImageFont.truetype(path, 18), "small": ImageFont.truetype(path, 14)}
    d = ImageFont.load_default()
    return {"title": d, "label": d, "small": d}


def alpha_mask_overlay(base: Image.Image, labels: np.ndarray, kept: set[int]) -> Image.Image:
    m = Image.fromarray((np.isin(labels, list(kept))*255).astype(np.uint8), mode="L").resize(base.size, Image.Resampling.NEAREST)
    out = base.convert("RGBA")
    tint = Image.new("RGBA", base.size, (60, 230, 90, 88))
    out.alpha_composite(Image.composite(tint, Image.new("RGBA", base.size, (0,0,0,0)), m))
    return out


def outlined_text(draw, xy, text, font, fill, anchor="la"):
    draw.text(xy, text, font=font, fill=fill, stroke_width=3, stroke_fill=(10,10,10,230), anchor=anchor)


def draw_marker(draw, x, y, kind, label, fonts):
    if kind == "tee":
        color=(30,150,255,255); draw.ellipse((x-10,y-10,x+10,y+10), outline=color, width=4); draw.ellipse((x-3,y-3,x+3,y+3), fill=color)
    elif kind == "badge":
        color=(255,210,40,255); draw.rectangle((x-8,y-8,x+8,y+8), outline=color, width=4)
    else:
        color=(220,80,255,255); draw.line((x-9,y,x+9,y), fill=color, width=4); draw.line((x,y-9,x,y+9), fill=color, width=4)
    outlined_text(draw, (x+13,y-13), label, fonts["label"], color)


def render_overview(source, labels, kept, bands, connections, out_path):
    fonts=load_fonts(); image=alpha_mask_overlay(source, labels, kept); draw=ImageDraw.Draw(image,"RGBA")
    focus={4,7,9,10,11}
    for g in bands:
        color=(60,225,255,220) if g.hole_number in focus else (60,225,255,60)
        draw.ellipse((g.x_px-g.radius_px,g.y_px-g.radius_px,g.x_px+g.radius_px,g.y_px+g.radius_px), outline=color, width=4 if g.hole_number in focus else 1)
        if g.hole_number in focus:
            outlined_text(draw,(g.x_px,g.y_px-g.radius_px-8),f"B{g.hole_number} GLYPH",fonts["label"],color,anchor="mb")
    for i,c in enumerate(connections,1):
        r=max(4,int(round(c.gap_px/2.5))); draw.ellipse((c.x_px-r,c.y_px-r,c.x_px+r,c.y_px+r),fill=(255,35,35,230),outline=(255,255,255,255),width=2)
        cause="/".join(f"B{n}" for n in c.glyph_holes) or "glyph"
        outlined_text(draw,(c.x_px+r+4,c.y_px),f"R{i} {c.gap_px:.0f}px {cause}",fonts["small"],(255,90,90,255))
    truth={n:(tx,ty,bx,by) for n,tx,ty,bx,by in GOLDEN_TRUTH}; badges={n:(x,y) for n,x,y in GOLDEN_BADGES}
    for n in TARGETS:
        tx,ty,bx,by=truth[n]; nx,ny=badges[n]
        draw_marker(draw,tx,ty,"tee",f"H{n} TEE",fonts); draw_marker(draw,nx,ny,"badge",f"H{n} NUMBER",fonts); draw_marker(draw,bx,by,"basket",f"H{n} BASKET",fonts)
    draw.rounded_rectangle((20,20,610,150),radius=12,fill=(10,10,10,205),outline=(255,255,255,130),width=2)
    outlined_text(draw,(35,35),"Basket-glyph local closing — overview",fonts["title"],(255,255,255,255))
    draw.text((35,75),"GREEN ribbon   CYAN glyph footprint   RED accepted repair",font=fonts["small"],fill="white")
    draw.text((35,100),"BLUE H# TEE   YELLOW H# NUMBER   PURPLE H# BASKET",font=fonts["small"],fill="white")
    draw.text((35,123),"Truth tee/basket are grading annotations only.",font=fonts["small"],fill=(210,210,210,255))
    image.convert("RGB").save(out_path,quality=95)


def crop_bounds(points,width,height,margin=110):
    xs=[p[0] for p in points]; ys=[p[1] for p in points]
    x0=max(0,int(min(xs)-margin)); y0=max(0,int(min(ys)-margin)); x1=min(width,int(max(xs)+margin)); y1=min(height,int(max(ys)+margin))
    if x1-x0<360:
        e=(360-(x1-x0))//2; x0=max(0,x0-e); x1=min(width,x1+e)
    if y1-y0<360:
        e=(360-(y1-y0))//2; y0=max(0,y0-e); y1=min(height,y1+e)
    return x0,y0,x1,y1


def render_target_sheet(source,labels,kept,bands,connections,badge_labels,basket_labels,out_path):
    fonts=load_fonts(); truth={n:(tx,ty,bx,by) for n,tx,ty,bx,by in GOLDEN_TRUTH}; badges={n:(x,y) for n,x,y in GOLDEN_BADGES}; by_hole={g.hole_number:g for g in bands}
    overlay=alpha_mask_overlay(source,labels,kept); panel_w,panel_h,cols=720,560,2; rows=math.ceil(len(TARGETS)/cols)
    sheet=Image.new("RGB",(cols*panel_w,rows*panel_h+80),(24,24,24)); sd=ImageDraw.Draw(sheet)
    sd.text((20,20),"Dash basket-glyph close — audited target crops",font=fonts["title"],fill="white")
    sd.text((20,52),"Every target and cause is named. Red dots are algorithm-accepted repairs.",font=fonts["small"],fill=(210,210,210))
    for idx,(hole,spec) in enumerate(TARGETS.items()):
        tx,ty,bx,by=truth[hole]; nx,ny=badges[hole]; focus=[by_hole[n] for n in spec["glyphs"]]
        x0,y0,x1,y1=crop_bounds([(tx,ty),(nx,ny),(bx,by)]+[(g.x_px,g.y_px) for g in focus],source.width,source.height)
        crop=overlay.crop((x0,y0,x1,y1)).convert("RGBA"); draw=ImageDraw.Draw(crop,"RGBA"); loc=lambda x,y:(x-x0,y-y0)
        for g in bands:
            gx,gy=loc(g.x_px,g.y_px)
            if gx+g.radius_px<0 or gy+g.radius_px<0 or gx-g.radius_px>crop.width or gy-g.radius_px>crop.height: continue
            is_focus=g.hole_number in spec["glyphs"]; color=(60,225,255,230) if is_focus else (60,225,255,60)
            draw.ellipse((gx-g.radius_px,gy-g.radius_px,gx+g.radius_px,gy+g.radius_px),outline=color,width=4 if is_focus else 1)
            if is_focus: outlined_text(draw,(gx,gy-g.radius_px-5),f"B{g.hole_number} GLYPH FOOTPRINT",fonts["small"],color,anchor="mb")
        nearby=0
        for c in connections:
            rx,ry=loc(c.x_px,c.y_px)
            if not (0<=rx<crop.width and 0<=ry<crop.height): continue
            nearby+=1; r=max(5,int(round(c.gap_px/2.5))); draw.ellipse((rx-r,ry-r,rx+r,ry+r),fill=(255,35,35,235),outline="white",width=2)
            cause="/".join(f"B{n}" for n in c.glyph_holes) or "glyph"; outlined_text(draw,(rx+r+5,ry),f"REPAIR {c.gap_px:.0f}px across {cause}",fonts["small"],(255,95,95,255))
        txx,tyy=loc(tx,ty); nxx,nyy=loc(nx,ny); bxx,byy=loc(bx,by)
        draw_marker(draw,txx,tyy,"tee",f"H{hole} TEE",fonts); draw_marker(draw,nxx,nyy,"badge",f"H{hole} NUMBER",fonts); draw_marker(draw,bxx,byy,"basket",f"H{hole} BASKET",fonts)
        bl,kl=badge_labels[hole],basket_labels[hole]; raw={bl} if bl is not None else set(); closed=reachable(bl,connections,MAX_CLOSE_PX)
        rd=nearest_label_set_distance(labels,raw,tx,ty); cd=nearest_label_set_distance(labels,closed,tx,ty); at=threshold_connects(bl,kl,connections)
        conn="badge↔basket already same raw component" if bl is not None and bl==kl else "badge↔basket STILL SPLIT" if at is None else f"badge↔basket connects at ≤{at}px"
        lines=[f"H{hole}: {spec['why']}",conn,f"tee reach from badge component: {rd:.1f}px → {cd:.1f}px",f"repairs visible in this crop: {nearby}"]
        draw.rounded_rectangle((8,8,crop.width-8,105),radius=10,fill=(5,5,5,210),outline=(255,255,255,110),width=2)
        for li,text in enumerate(lines): draw.text((18,15+li*21),text,font=fonts["small"],fill="white")
        sf=min((panel_w-20)/crop.width,(panel_h-50)/crop.height); resized=crop.resize((int(crop.width*sf),int(crop.height*sf)),Image.Resampling.LANCZOS).convert("RGB")
        panel=Image.new("RGB",(panel_w,panel_h),(30,30,30)); panel.paste(resized,((panel_w-resized.width)//2,(panel_h-resized.height)//2)); sheet.paste(panel,((idx%cols)*panel_w,80+(idx//cols)*panel_h))
    sheet.save(out_path,quality=95)


def main():
    parser=argparse.ArgumentParser(); parser.add_argument("--render",action="store_true"); parser.add_argument("--out",type=Path,default=REPO/"scripts/cv-probes/ribbon-mass-results-py"); args=parser.parse_args(); args.out.mkdir(parents=True,exist_ok=True)
    source=load_source_image(GOLDEN_ZIP); ui_scale=load_ui_scale(); labels,texture_kept=segment_ribbon_mass(source); badge_labels,basket_labels=build_seed_placements(labels); bands=build_glyph_bands(ui_scale); connections=glyph_close(labels,build_band_mask(labels.shape,bands),bands)
    seed_kept={x for x in badge_labels.values() if x is not None}|{x for x in basket_labels.values() if x is not None}; kept=seed_kept|texture_kept
    print("Dash / GoldenTeeSet basket-glyph local-close (Python)"); print(f"source={source.width}x{source.height} uiScalePx={ui_scale:.6f}"); print(f"glyph offset={BASKET_ICON_VERTICAL_OFFSET_UI*ui_scale:.1f}px radius={BASKET_ICON_RADIUS_UI*ui_scale:.1f}px"); print(f"accepted connections={len(connections)} max gap={MAX_CLOSE_PX:.0f}px")
    bins={}
    for c in connections: b=int(math.floor(c.gap_px/3)*3); bins[b]=bins.get(b,0)+1
    for b in sorted(bins): print(f"  gap {b:02d}-{b+3:02d}px: {'#'*bins[b]} ({bins[b]})")
    print("\nAccepted repairs:")
    for i,c in enumerate(connections,1): print(f"  R{i:02d}: C{c.a}<->C{c.b} gap={c.gap_px:.1f}px at ({c.x_px:.0f},{c.y_px:.0f}) across {'/'.join('B'+str(n) for n in c.glyph_holes) or 'glyph'}")
    truth={n:(tx,ty,bx,by) for n,tx,ty,bx,by in GOLDEN_TRUTH}; rows=[]; print("\nAudited target holes:")
    for hole,spec in TARGETS.items():
        bl,kl=badge_labels[hole],basket_labels[hole]; tx,ty,_bx,_by=truth[hole]; raw={bl} if bl is not None else set(); closed=reachable(bl,connections,MAX_CLOSE_PX); rd=nearest_label_set_distance(labels,raw,tx,ty); cd=nearest_label_set_distance(labels,closed,tx,ty); at=threshold_connects(bl,kl,connections)
        state="already-connected" if bl is not None and bl==kl else "still-split" if at is None else f"connects<={at}px"
        print(f"  H{hole:02d}: {state:18s} tee-distance {rd:6.1f} -> {cd:6.1f}px focus={','.join('B'+str(n) for n in spec['glyphs'])}")
        rows.append({"hole":hole,"why":spec["why"],"focusGlyphs":list(spec["glyphs"]),"rawBadgeComponent":bl,"rawBasketComponent":kl,"badgeBasketConnectedAtPx":at,"rawTeeDistancePx":rd,"closedTeeDistancePx":cd})
    payload={"uiScalePx":ui_scale,"glyphGeometry":{"verticalOffsetPx":BASKET_ICON_VERTICAL_OFFSET_UI*ui_scale,"radiusPx":BASKET_ICON_RADIUS_UI*ui_scale},"maxClosePx":MAX_CLOSE_PX,"connectionCount":len(connections),"connections":[{"a":c.a,"b":c.b,"gapPx":c.gap_px,"xPx":c.x_px,"yPx":c.y_px,"glyphHoles":list(c.glyph_holes)} for c in connections],"targets":rows}; (args.out/"GoldenTeeSet-basket-glyph-close.json").write_text(json.dumps(payload,indent=2))
    if args.render:
        overview=args.out/"GoldenTeeSet-basket-glyph-close-overview.png"; sheet=args.out/"GoldenTeeSet-basket-glyph-close-targets.png"; render_overview(source,labels,kept,bands,connections,overview); render_target_sheet(source,labels,kept,bands,connections,badge_labels,basket_labels,sheet); print(f"\nRendered:\n  {overview}\n  {sheet}")

if __name__ == "__main__": main()
