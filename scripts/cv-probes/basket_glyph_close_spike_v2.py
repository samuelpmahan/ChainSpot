#!/usr/bin/env python3
"""Target-isolated basket-glyph diagnostic + readable render cards.

Builds on basket_glyph_close_spike.py but fixes two presentation/experiment
problems from v1:
1. each audited hole is tested against ONLY its named basket glyph, so nearby
   glyphs cannot contaminate the repair claim;
2. map crops carry only compact TEE/NUMBER/BASKET/B# markers and R# dots.
   All repair details live in a side card instead of being drawn on top of
   the satellite image.

It also measures the full glyph-local closure ceiling. The 18px cap came from
ring-stroke repair; a basket icon is ~100px across, so the script reports both
"strict <=18px" and the minimum gap needed when growth is still confined to
that exact glyph footprint (up to one glyph diameter).
"""
from __future__ import annotations

import argparse
import math
from pathlib import Path

from PIL import Image, ImageDraw

import basket_glyph_close_spike as base


def exact_connect_threshold(a, b, connections):
    if a is None or b is None:
        return None
    if a == b:
        return 0.0
    for threshold in sorted({c.gap_px for c in connections}):
        if b in base.reachable(a, connections, threshold):
            return float(threshold)
    return None


def tee_threshold(labels, badge_label, connections, tx, ty, limit_px=30.0):
    if badge_label is None:
        return None
    if base.nearest_label_set_distance(labels, {badge_label}, tx, ty) <= limit_px:
        return 0.0
    for threshold in sorted({c.gap_px for c in connections}):
        if base.nearest_label_set_distance(labels, base.reachable(badge_label, connections, threshold), tx, ty) <= limit_px:
            return float(threshold)
    return None


def relevant_connections(connections, badge_label, basket_label):
    """Prefer edges that actually lie on a badge->basket reachable path; otherwise all."""
    if badge_label is None or basket_label is None or badge_label == basket_label:
        return connections
    adjacency = {}
    edge_by_pair = {}
    for c in connections:
        adjacency.setdefault(c.a, []).append(c.b)
        adjacency.setdefault(c.b, []).append(c.a)
        edge_by_pair[(min(c.a, c.b), max(c.a, c.b))] = c
    parent = {badge_label: None}
    stack = [badge_label]
    while stack:
        cur = stack.pop(0)
        if cur == basket_label:
            break
        for nxt in adjacency.get(cur, []):
            if nxt not in parent:
                parent[nxt] = cur
                stack.append(nxt)
    if basket_label not in parent:
        return connections
    out = []
    cur = basket_label
    while parent[cur] is not None:
        prev = parent[cur]
        out.append(edge_by_pair[(min(cur, prev), max(cur, prev))])
        cur = prev
    return list(reversed(out))


def clean_crop_bounds(points, width, height, margin=100):
    x0, y0, x1, y1 = base.crop_bounds(points, width, height, margin)
    # keep crop reasonably compact so labels remain large
    return x0, y0, x1, y1


def draw_tag(draw, x, y, text, color, font, shape="circle"):
    if shape == "square":
        draw.rectangle((x-8, y-8, x+8, y+8), fill=(15,15,15,220), outline=color, width=3)
    elif shape == "cross":
        draw.ellipse((x-9,y-9,x+9,y+9), fill=(15,15,15,180), outline=color, width=3)
        draw.line((x-6,y,x+6,y), fill=color, width=3); draw.line((x,y-6,x,y+6), fill=color, width=3)
    else:
        draw.ellipse((x-9,y-9,x+9,y+9), fill=(15,15,15,190), outline=color, width=3)
    base.outlined_text(draw, (x+12,y), text, font, color, anchor="lm")


def render_target_cards(source, labels, kept, bands_by_hole, evaluations, out_path):
    fonts = base.load_fonts()
    truth = {n:(tx,ty,bx,by) for n,tx,ty,bx,by in base.GOLDEN_TRUTH}
    badges = {n:(x,y) for n,x,y in base.GOLDEN_BADGES}
    overlay = base.alpha_mask_overlay(source, labels, kept)

    map_w, card_w, panel_h = 600, 390, 500
    panel_w = map_w + card_w
    cols = 1
    rows = len(evaluations)
    sheet = Image.new("RGB", (panel_w, rows*panel_h + 70), (22,22,22))
    sd = ImageDraw.Draw(sheet)
    sd.text((18,14), "Dash basket-glyph repair — target-isolated diagnostics", font=fonts["title"], fill="white")
    sd.text((18,46), "Map: GREEN ribbon · CYAN focus glyph · RED R# repair · BLUE TEE · YELLOW NUMBER · PURPLE BASKET", font=fonts["small"], fill=(210,210,210))

    for row, ev in enumerate(evaluations):
        hole = ev["hole"]
        tx,ty,bx,by = truth[hole]; nx,ny = badges[hole]
        focus = [bands_by_hole[n] for n in ev["focusGlyphs"]]
        points=[(tx,ty),(nx,ny),(bx,by)] + [(g.x_px,g.y_px) for g in focus]
        x0,y0,x1,y1 = clean_crop_bounds(points, source.width, source.height)
        crop = overlay.crop((x0,y0,x1,y1)).convert("RGBA")
        draw = ImageDraw.Draw(crop, "RGBA")
        loc=lambda x,y:(x-x0,y-y0)

        for g in focus:
            gx,gy=loc(g.x_px,g.y_px)
            draw.ellipse((gx-g.radius_px,gy-g.radius_px,gx+g.radius_px,gy+g.radius_px), outline=(50,225,255,245), width=5)
            draw_tag(draw,gx,gy-g.radius_px-14,f"B{g.hole_number} GLYPH",(50,225,255,255),fonts["small"])

        shown = ev["pathRepairs"] if ev["pathRepairs"] else ev["allRepairs"]
        for idx,c in enumerate(shown,1):
            rx,ry=loc(c.x_px,c.y_px)
            r=7
            draw.ellipse((rx-r,ry-r,rx+r,ry+r), fill=(255,40,40,245), outline="white", width=2)
            base.outlined_text(draw,(rx+11,ry),f"R{idx}",fonts["label"],(255,80,80,255),anchor="lm")

        txx,tyy=loc(tx,ty); nxx,nyy=loc(nx,ny); bxx,byy=loc(bx,by)
        draw_tag(draw,txx,tyy,"TEE",(30,150,255,255),fonts["label"])
        draw_tag(draw,nxx,nyy,"NUMBER",(255,210,40,255),fonts["label"],shape="square")
        draw_tag(draw,bxx,byy,"BASKET",(220,80,255,255),fonts["label"],shape="cross")

        sf=min((map_w-18)/crop.width,(panel_h-18)/crop.height)
        resized=crop.resize((max(1,int(crop.width*sf)),max(1,int(crop.height*sf))),Image.Resampling.LANCZOS).convert("RGB")
        panel_y=70+row*panel_h
        map_panel=Image.new("RGB",(map_w,panel_h),(28,28,28)); map_panel.paste(resized,((map_w-resized.width)//2,(panel_h-resized.height)//2))
        sheet.paste(map_panel,(0,panel_y))

        card=Image.new("RGB",(card_w,panel_h),(12,12,12)); cd=ImageDraw.Draw(card)
        cd.text((18,16),f"H{hole}",font=fonts["title"],fill="white")
        cd.text((18,50),ev["why"],font=fonts["small"],fill=(220,220,220))
        y=90
        strict = ev["strictConnectedAt"]
        full = ev["fullConnectedAt"]
        strict_text = "YES" if strict is not None and strict <= base.MAX_CLOSE_PX else "NO"
        cd.text((18,y),f"≤18px local close: {strict_text}",font=fonts["label"],fill=(100,230,120) if strict_text=="YES" else (255,100,100)); y+=31
        cd.text((18,y),f"badge↔basket min gap: {full if full is not None else 'not connected'}",font=fonts["small"],fill="white"); y+=25
        cd.text((18,y),f"tee distance raw: {ev['rawTeeDist']:.1f}px",font=fonts["small"],fill="white"); y+=23
        cd.text((18,y),f"tee distance @18: {ev['strictTeeDist']:.1f}px",font=fonts["small"],fill="white"); y+=23
        cd.text((18,y),f"tee distance full glyph: {ev['fullTeeDist']:.1f}px",font=fonts["small"],fill="white"); y+=23
        cd.text((18,y),f"tee≤30 min gap: {ev['teeWithin30At'] if ev['teeWithin30At'] is not None else 'never'}",font=fonts["small"],fill="white"); y+=34
        cd.line((18,y,card_w-18,y),fill=(80,80,80),width=1); y+=12
        cd.text((18,y),"Repairs shown on map",font=fonts["label"],fill=(255,120,120)); y+=28
        if not shown:
            cd.text((18,y),"none",font=fonts["small"],fill=(180,180,180))
        for idx,c in enumerate(shown,1):
            causes="/".join(f"B{n}" for n in c.glyph_holes) or "glyph"
            cd.text((18,y),f"R{idx}: {c.gap_px:.0f}px · {causes}",font=fonts["small"],fill="white"); y+=20
            cd.text((38,y),f"C{c.a} ↔ C{c.b}",font=fonts["small"],fill=(175,175,175)); y+=22
        sheet.paste(card,(map_w,panel_y))

    sheet.save(out_path, quality=95)


def main():
    parser=argparse.ArgumentParser(); parser.add_argument("--out",type=Path,default=base.REPO/"scripts/cv-probes/ribbon-mass-results-py"); args=parser.parse_args(); args.out.mkdir(parents=True,exist_ok=True)
    source=base.load_source_image(base.GOLDEN_ZIP); ui=base.load_ui_scale(); labels,texture=base.segment_ribbon_mass(source); badge,basket=base.build_seed_placements(labels); bands=base.build_glyph_bands(ui); by_hole={g.hole_number:g for g in bands}
    seed_kept={x for x in badge.values() if x is not None}|{x for x in basket.values() if x is not None}; kept=seed_kept|texture
    truth={n:(tx,ty,bx,by) for n,tx,ty,bx,by in base.GOLDEN_TRUTH}

    evaluations=[]
    print("Target-isolated basket-glyph close")
    print(f"uiScale={ui:.6f}; glyph radius={base.BASKET_ICON_RADIUS_UI*ui:.1f}px; diameter={2*base.BASKET_ICON_RADIUS_UI*ui:.1f}px")
    for hole,spec in base.TARGETS.items():
        focus=[by_hole[n] for n in spec["glyphs"]]
        band=base.build_band_mask(labels.shape,focus)
        diagnostic_cap=float(math.ceil(max(2*g.radius_px for g in focus)))
        old_cap=base.MAX_CLOSE_PX
        base.MAX_CLOSE_PX=diagnostic_cap
        all_connections=base.glyph_close(labels,band,focus)
        base.MAX_CLOSE_PX=old_cap

        bl,kl=badge[hole],basket[hole]; tx,ty,_bx,_by=truth[hole]
        strict_connections=[c for c in all_connections if c.gap_px <= old_cap]
        raw_dist=base.nearest_label_set_distance(labels,{bl} if bl is not None else set(),tx,ty)
        strict_dist=base.nearest_label_set_distance(labels,base.reachable(bl,strict_connections,old_cap),tx,ty)
        full_dist=base.nearest_label_set_distance(labels,base.reachable(bl,all_connections,diagnostic_cap),tx,ty)
        strict_at=exact_connect_threshold(bl,kl,strict_connections)
        full_at=exact_connect_threshold(bl,kl,all_connections)
        tee_at=tee_threshold(labels,bl,all_connections,tx,ty)
        path_repairs=relevant_connections(all_connections,bl,kl)
        evaluations.append({"hole":hole,"why":spec["why"],"focusGlyphs":list(spec["glyphs"]),"strictConnectedAt":strict_at,"fullConnectedAt":full_at,"rawTeeDist":raw_dist,"strictTeeDist":strict_dist,"fullTeeDist":full_dist,"teeWithin30At":tee_at,"allRepairs":all_connections,"pathRepairs":path_repairs})
        print(f"H{hole:02d} focus={','.join('B'+str(n) for n in spec['glyphs'])}: badge↔basket raw={'same' if bl==kl and bl is not None else 'split'}; <=18={strict_at}; full={full_at}; tee {raw_dist:.1f}->{strict_dist:.1f}->{full_dist:.1f}px; tee<=30@{tee_at}; local edges={len(all_connections)}")

    out=args.out/"GoldenTeeSet-basket-glyph-close-target-cards.png"
    render_target_cards(source,labels,kept,by_hole,evaluations,out)
    print(f"rendered {out}")

if __name__ == "__main__": main()
