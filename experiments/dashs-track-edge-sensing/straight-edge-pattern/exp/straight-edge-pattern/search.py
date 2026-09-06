#!/usr/bin/env python3
"""Find paired curve recurrences, retaining raw data and every per-hole result.

Correlation ranks visual candidates only. It is not probability or validation.
No reversal, side swap, distance stretching, smoothing, or endpoint steering.
"""
from pathlib import Path
import json,numpy as np
from numpy.lib.stride_tricks import sliding_window_view
ROOT=Path(__file__).resolve().parents[2]
a=json.loads((ROOT/'output/bands.json').read_text())
offsets=np.array(a['offsets']);distances=np.array(a['distances'])
holes={h['hole']:h for h in a['holes']}
def gradient(h):
 b=np.array(h['bands'],dtype=float)
 return b[:,10:]-b[:,:-10] # 5 px separation, centered at offsets[5:-5]
go=offsets[5:-5]
def trace(h,offset,side=1):return gradient(h)[:,np.where(go==offset)[0][0]]*side
ref=holes[18];mask=(distances>=105)&(distances<=155)
template=np.array([trace(ref,-20)[mask],trace(ref,20,-1)[mask]])
def correlations(windows,ref):
 x=windows-windows.mean(axis=-1,keepdims=True);r=ref-ref.mean()
 den=np.sqrt((x*x).sum(axis=-1)*(r*r).sum())
 return np.divide((x*r).sum(axis=-1),den,out=np.full(den.shape,np.nan),where=den>1e-10)
results=[]
for hole,h in holes.items():
 if hole==18:continue
 g=gradient(h);rows=[]
 for mode,lefts,rights in [('original-readers',[-20],[20]),('sideways-search',list(range(-40,-9,2)),list(range(10,41,2)))]:
  l=np.stack([trace(h,o) for o in lefts],axis=1)
  r=np.stack([trace(h,o,-1) for o in rights],axis=1)
  lw=sliding_window_view(l,51,axis=0);rw=sliding_window_view(r,51,axis=0)
  lc=correlations(lw,template[0]);rc=correlations(rw,template[1])
  for i,d in enumerate(distances[:-50]):
   if d<h['teeDistance']+15 or d+50>h['basketDistance']-15:continue
   if not np.isfinite(lc[i]).any() or not np.isfinite(rc[i]).any():continue
   li=int(np.nanargmax(lc[i]));ri=int(np.nanargmax(rc[i]))
   rows.append({'hole':hole,'mode':mode,'start':int(d),'end':int(d+50),'leftOffset':lefts[li],'rightOffset':rights[ri],
    'leftShapeMatch':float(lc[i,li]),'rightShapeMatch':float(rc[i,ri]),'rankScore':float((lc[i,li]+rc[i,ri])/2),
    'pairCorrelation':float(np.corrcoef(lw[i,li],rw[i,ri])[0,1]),
    'leftRaw':lw[i,li].tolist(),'rightRaw':rw[i,ri].tolist()})
  subset=[q for q in rows if q['mode']==mode]
  if subset:results.append(max(subset,key=lambda q:q['rankScore']))
out={'reference':{'hole':18,'start':105,'end':155,'leftOffset':-20,'rightOffset':20,'leftRaw':template[0].tolist(),'rightRaw':template[1].tolist()},
 'method':'Separate per-side shape correlations averaged only to rank candidates. Raw levels retained. No reversal, swapping, smoothing, or stretching.',
 'search':'Nine annotation-selected straight holes; 51-sample windows inside annotated Tee/Basket extent with 15px inset for inspection; Badge-masked bands unavailable. Original +/-20 readers plus left -40..-10/right10..40 by2px. Finite search, not a universal absence test.',
 'results':sorted(results,key=lambda q:-q['rankScore'])}
(ROOT/'output/matches.json').write_text(json.dumps(out,indent=2))
for r in out['results']:print(r['hole'],r['mode'],r['start'],r['end'],r['leftOffset'],r['rightOffset'],round(r['rankScore'],3),round(r['pairCorrelation'],3))

# A different, explicitly recorded question: strongest opposite movement at
# the ORIGINAL reader positions, without changing widths or fitting the template.
opposition=[]
for hole,h in holes.items():
 l=trace(h,-20);r=trace(h,20,-1);candidates=[]
 for i,d in enumerate(distances[:-50]):
  if d<h['teeDistance']+15 or d+50>h['basketDistance']-15:continue
  left=l[i:i+51];right=r[i:i+51]
  if not np.isfinite(left).all() or not np.isfinite(right).all() or min(left.std(),right.std())<1e-6:continue
  candidates.append({'hole':hole,'start':int(d),'end':int(d+50),'opposition':float(np.corrcoef(left,right)[0,1]),
   'leftMean':float(left.mean()),'rightMean':float(right.mean()),'leftStd':float(left.std()),'rightStd':float(right.std())})
 if candidates:opposition.append(min(candidates,key=lambda q:q['opposition']))
(ROOT/'output/opposition.json').write_text(json.dumps(opposition,indent=2))
