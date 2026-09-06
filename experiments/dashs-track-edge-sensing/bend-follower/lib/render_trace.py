"""Small source-backed evidence rendering API used by the bend-follower runner.

Functions consume an already saved trace object and a source raster. They do
not run sensing, read annotation targets, or select alternate paths.
"""
from __future__ import annotations
from pathlib import Path
from typing import Any
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import render as _r

def _winner(trace: dict[str, Any]) -> dict[str, Any]:
    cs = _r.candidates(trace)
    return next((c for c in cs if _r.is_winner(c)), cs[0] if cs else {})

def render_h18(source_path, trace, output_path):
    source = _r.Image.open(source_path).convert("RGB")
    winner = _winner(trace)
    full = _r.overlay(source, winner, "H18 early source | primary + paired edges + bend dots", True, True)
    cropped, box = _r.crop_h18(full, winner, trace)
    _r.save_jpg(cropped, Path(output_path))
    return {"output": str(output_path), "cropBox": list(box), "winner": _r.candidate_id(winner, 0)}

def render_all(source_path, trace, output_path):
    source = _r.Image.open(source_path).convert("RGB")
    holes = trace.get("holes", []) if isinstance(trace.get("holes"),list) else []
    # Every executed hole contributes exactly one saved primary path. No alternate is drawn.
    if holes:
        im=source
        drawn=0
        for h in holes:
            pts=h.get("points",[]) if isinstance(h,dict) else []
            if not pts: continue
            bends=[b.get("point") for b in h.get("bendCandidates",[]) if b.get("status")=="FOUND" and b.get("point")]
            c={"centerline":[q.get("center") for q in pts],"leftEdge":[q.get("left") for q in pts],"rightEdge":[q.get("right") for q in pts],"bendDots":bends}
            im=_r.overlay(im,c,"",True,True); drawn+=1
        _r.label(im,f"All 18 source graph | {drawn} primary traces")
        _r.save_jpg(im,Path(output_path)); return {"output":str(output_path),"primaryTraceCount":drawn}
    winner = _winner(trace)
    _r.save_jpg(_r.overlay(source, winner, "All source graph | primary winner", True, True), Path(output_path))
    return {"output": str(output_path), "winner": _r.candidate_id(winner, 0),"primaryTraceCount":1 if winner else 0}

def render_failures(source_path, trace, output_path):
    source = _r.Image.open(source_path).convert("RGB")
    winner = _winner(trace)
    failures = _r.failure_points(trace)
    _r.save_jpg(_r.overlay(source, winner, "Focused failures | stored failure rows", False, True, failures), Path(output_path))
    return {"output": str(output_path), "winner": _r.candidate_id(winner, 0), "failureCount": len(failures)}
