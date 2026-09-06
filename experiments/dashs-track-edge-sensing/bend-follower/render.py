#!/usr/bin/env python3
"""Render saved bend-follower evidence without rerunning sensing or reading annotations.

Inputs are a source raster and a source-backed trace JSON or NPZ.  Geometry is
copied from the trace only: this module never samples pixels, resolves winners,
or loads annotation/target files.
"""
from __future__ import annotations
import argparse, hashlib, json, math
from pathlib import Path
from typing import Any
import numpy as np
from PIL import Image, ImageDraw, ImageFont

COLORS = {"center": (0, 220, 255), "left": (255, 205, 35), "right": (255, 105, 210),
          "bend": (255, 90, 40), "fail": (240, 40, 45), "pass": (60, 220, 100),
          "unknown": (180, 180, 180), "alternate": (150, 150, 155)}
FOCUS_H18 = {80, 100, 110, 130, 150}

def xy(v: Any):
    if isinstance(v, dict):
        for a,b in (("xPx","yPx"),("x","y"),("x0","y0")):
            if a in v and b in v: return (float(v[a]), float(v[b]))
        for k in ("point","center","position","coord"):
            if k in v:
                p=xy(v[k])
                if p is not None:return p
    elif isinstance(v,(list,tuple,np.ndarray)) and len(v)>=2:
        try:return float(v[0]),float(v[1])
        except (TypeError,ValueError):return None
    return None

def points(v: Any):
    if isinstance(v, dict):
        for k in ("points","path","polyline","trajectory","centerline","vertices"):
            if k in v:return [p for q in v[k] if (p:=xy(q)) is not None]
        a,b=xy(v.get("start")),xy(v.get("end"))
        return [a,b] if a and b else ([] if not xy(v) else [xy(v)])
    if isinstance(v,(list,tuple,np.ndarray)):
        return [p for q in v if (p:=xy(q)) is not None]
    return []

def norm_points(v: Any): return points(v)

def first(d, keys, default=None):
    for k in keys:
        if isinstance(d,dict) and k in d and d[k] is not None:return d[k]
    return default

def load_trace(path: Path):
    if path.suffix.lower()==".npz":
        z=np.load(path,allow_pickle=True); out={}
        for k in z.files:
            x=z[k]
            if x.ndim==0:
                try:out[k]=x.item()
                except Exception:out[k]=x.tolist()
            else:out[k]=x.tolist()
        return out
    return json.loads(path.read_text())

def candidates(trace):
    raw=first(trace,("candidates","solutions","paths","tracks"),[])
    if isinstance(raw,dict): raw=[dict(v, candidateId=k) if isinstance(v,dict) else v for k,v in raw.items()]
    if not isinstance(raw,list):raw=[]
    # A trace with direct primary geometry is treated as one candidate.
    if not raw and isinstance(trace.get("winner"),dict):
        raw=[dict(trace["winner"], winner=True)]
    elif not raw and isinstance(trace.get("primary"),dict):
        raw=[dict(trace["primary"], primary=True)]
    elif not raw and any(k in trace for k in ("centerline","centerLine","path")):
        raw=[trace]
    return [x for x in raw if isinstance(x,dict)]

def candidate_id(c,i): return str(first(c,("candidateId","id","trackId","pathId","name"),f"candidate-{i+1}"))
def is_winner(c):
    status=str(first(c,("role","status","state","verdict"),"")).lower()
    return bool(c.get("winner") or c.get("primary") or status in {"winner","primary","accepted","selected"})

def geometry(c):
    center=norm_points(first(c,("centerline","centerLine","control","path","trajectory"),[]))
    left=norm_points(first(c,("leftEdge","left_edge","edgeLeft","pairedLeft","innerLeft"),[]))
    right=norm_points(first(c,("rightEdge","right_edge","edgeRight","pairedRight","innerRight"),[]))
    bends=norm_points(first(c,("bendDots","bend_points","bends","waypoints","corners"),[]))
    # paired edges can arrive as edgePairs: [[left,right], ...]
    pairs=first(c,("edgePairs","pairedEdges","edges"),[])
    if (not left or not right) and isinstance(pairs,list):
        for pair in pairs:
            if isinstance(pair,(list,tuple)) and len(pair)>=2:
                a,b=xy(pair[0]),xy(pair[1])
                if a and b:left.append(a);right.append(b)
    return center,left,right,bends

def row_items(trace):
    rows=first(trace,("rows","spatialRows","readings","samples"),[])
    return rows if isinstance(rows,list) else []

def failure_points(trace):
    out=[]
    for row in row_items(trace):
        if not isinstance(row,dict):continue
        state=str(first(row,("state","status","verdict","classification"),"unknown")).lower()
        if state not in {"fail","failed","reject","rejected","failure","error","unknown"}:continue
        p=xy(row) or xy(first(row,("center","position","point"),None))
        if p:out.append((p,state,str(first(row,("rowId","id","hole","rayId"),"failure"))))
    return out

def draw_poly(draw, pts, color, width=3):
    if len(pts)>1:draw.line(pts,fill=color,width=width,joint="curve")
    for x,y in pts[::max(1,len(pts)//30)]:draw.ellipse((x-2,y-2,x+2,y+2),fill=color)

def label(im, text):
    d=ImageDraw.Draw(im,"RGBA"); f=ImageFont.load_default(); box=d.textbbox((0,0),text,font=f)
    d.rectangle((6,6,14+box[2],18+box[3]),fill=(0,0,0,175));d.text((10,9),text,fill=(255,255,255,255),font=f)

def overlay(source, cs, title, include_edges=True, include_bends=True, failures=()):
    im=source.convert("RGBA").copy(); d=ImageDraw.Draw(im,"RGBA")
    center,left,right,bends=geometry(cs)
    draw_poly(d,center,COLORS["center"],4)
    if include_edges:
        draw_poly(d,left,COLORS["left"],3);draw_poly(d,right,COLORS["right"],3)
    if include_bends:
        for x,y in bends:d.ellipse((x-7,y-7,x+7,y+7),fill=COLORS["bend"],outline=(255,255,255),width=2)
    for (x,y),state,_ in failures:
        d.ellipse((x-8,y-8,x+8,y+8),outline=COLORS["fail"],width=3)
    label(im,title);return im

def crop_h18(im, cs, trace):
    center,left,right,bends=geometry(cs); pts=center+left+right+bends
    # Prefer explicit focus crop; otherwise bbox around primary H18 geometry.
    crop=first(trace,("h18Crop","earlyH18Crop","focusCrop"),None)
    if isinstance(crop,(list,tuple)) and len(crop)>=4: box=tuple(map(int,crop[:4]))
    elif pts:
        xs=[p[0] for p in pts];ys=[p[1] for p in pts];box=(max(0,int(min(xs)-70)),max(0,int(min(ys)-70)),min(im.width,int(max(xs)+70)),min(im.height,int(max(ys)+70)))
    else: box=(760,340,min(im.width,1085),min(im.height,880))
    return im.crop(box),box

def save_jpg(im,path):
    path.parent.mkdir(parents=True,exist_ok=True); im.convert("RGB").save(path,quality=92,optimize=True)

def render(trace_path, source_path, out_dir):
    trace=load_trace(trace_path); source=Image.open(source_path).convert("RGB")
    cs=candidates(trace)
    winner=next((c for c in cs if is_winner(c)), cs[0] if cs else {})
    failures=failure_points(trace)
    # Only winner geometries are ever drawn. Alternates are summarized below.
    early=crop_h18(overlay(source,winner,"H18 early source | primary + paired edges + bend dots",True,True),winner,trace)
    save_jpg(early[0],out_dir/"early-h18-source.jpg")
    save_jpg(overlay(source,winner,"All 18 graph | primary winner",True,True),out_dir/"all18-graph.jpg")
    save_jpg(overlay(source,winner,"Focused failures | stored failure rows",False,True,failures),out_dir/"focused-failures.jpg")
    alts=[]
    for i,c in enumerate(cs):
        if c is winner:continue
        cen,lft,rgt,bnd=geometry(c)
        alts.append({"candidateId":candidate_id(c,i),"status":first(c,("status","state","verdict","role"),None),"centerlinePoints":len(cen),"leftEdgePoints":len(lft),"rightEdgePoints":len(rgt),"bendDots":len(bnd)})
    manifest={"source":str(source_path),"sourceSha256":hashlib.sha256(source_path.read_bytes()).hexdigest(),"trace":str(trace_path),"winner":candidate_id(winner,cs.index(winner) if winner in cs else 0),"outputs":["early-h18-source.jpg","all18-graph.jpg","focused-failures.jpg"],"h18CropBox":list(early[1]),"failureCount":len(failures),"alternateSummary":alts,"annotationReads":0,"pixelSampling":0}
    (out_dir/"alternate-summary.json").write_text(json.dumps({"winner":manifest["winner"],"alternates":alts},indent=2)+"\n")
    (out_dir/"render-manifest.json").write_text(json.dumps(manifest,indent=2)+"\n")
    return manifest

def main(argv=None):
    ap=argparse.ArgumentParser(description=__doc__);ap.add_argument("trace",type=Path);ap.add_argument("--source",type=Path,required=True);ap.add_argument("--out",type=Path,default=Path("output"));a=ap.parse_args(argv);print(json.dumps(render(a.trace,a.source,a.out),indent=2));return 0
if __name__=="__main__":raise SystemExit(main())
