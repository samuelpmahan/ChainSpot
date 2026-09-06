#!/usr/bin/env python3
"""Fixed-heading ternary sensing run. This is a sensor experiment, not a tracker."""
import argparse, hashlib, json, math, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent/'lib'))
from ternary_methods import method_a, method_b, rgb_distance, rgb_variance

ROOT=Path(__file__).resolve().parent
INPUT=ROOT.parent/'restored/edge-diagnostic/edge-readings-work/inputs.json'
RGBA=ROOT.parent/'restored/edge-diagnostic/edge-readings-work/source.rgba'
FEATURE='ternaryEdgeSensing'
PARAMS={'distancesPx':'0..500 step10 plus exact H18 controls','profileWindowPx':96,'tangentOffsetsPx':[-4,-2,0,2,4],'readerHalfGapPx':2,'methodA_liveCenterBandPx':5,'methodB_initialWindowPx':48,'methodB_maxWindowPx':96,'methodB_minInteriorPx':4,'methodB_minContrastRgb':12}

def hash_json(x): return hashlib.sha256(json.dumps(x,sort_keys=True,separators=(',',':')).encode()).hexdigest()
def median(vals):
    vals=[v for v in vals if v is not None]
    if not vals: return None
    n=len(vals)
    return tuple((sorted(v[j] for v in vals)[(n-1)//2]+sorted(v[j] for v in vals)[n//2])/2 for j in range(3))
def mean(vals): return tuple(sum(v[j] for v in vals)/len(vals) for j in range(3)) if vals else None
def rgb_at(raw,w,h,x,y):
    # Match recovered sampler Math.round for non-negative source coordinates.
    xi,yi=math.floor(x+0.5),math.floor(y+0.5)
    if not (0<=xi<w and 0<=yi<h): return None, {'xPx':x,'yPx':y,'xRounded':xi,'yRounded':yi,'reason':'outsideImage'}
    p=(yi*w+xi)*4; v=tuple(raw[p:p+3]); return v, {'xPx':x,'yPx':y,'xRounded':xi,'yRounded':yi,'rgbaIndex':p}
def in_box(x,y,b): return b['bboxX']<=x<=b['bboxX']+b['bboxW'] and b['bboxY']<=y<=b['bboxY']+b['bboxH']
def tangent_rgb(raw,w,h,cx,cy,heading,offset,boxes):
    tx,ty=math.cos(heading),math.sin(heading); nx,ny=-ty,tx; out=[]
    for along in PARAMS['tangentOffsetsPx']:
        x=cx+nx*offset+tx*along; y=cy+ny*offset+ty*along
        ident={'offsetPx':offset,'alongPx':along,'xPx':x,'yPx':y}
        if any(in_box(x,y,b) for b in boxes): out.append({**ident,'rgb':None,'reason':'badgeOccluded'}); continue
        rgb,more=rgb_at(raw,w,h,x,y); out.append({**ident,'rgb':rgb,**more})
    vis=[tuple(q['rgb']) for q in out if q['rgb'] is not None]
    blocked=len(out)-len(vis)
    majority_blocked=blocked*2>=len(out)
    # Preserve visible raw RGB but do not turn a majority-occluded band into material evidence.
    return {'offsetPx':offset,'samples':out,'rawMeanRgb':mean(vis),'meanRgb':None if majority_blocked else mean(vis),'varianceRgb':rgb_variance(vis),'visible':len(vis),'occluded':majority_blocked}
def classify_b_readers(result, positions):
    if result.get('classification')=='UNKNOWN' or not result.get('edges'): return [{'offsetPx':p,'state':'UNKNOWN','reason':result.get('quality')} for p in positions]
    a,b=result['edges']; # profile indices; runner stores profile offset by index
    out=[]
    for p in positions:
      inside=[]
      for x in (p-PARAMS['readerHalfGapPx'],p+PARAMS['readerHalfGapPx']):
        idx=int(x+PARAMS['profileWindowPx']); inside.append(a<=idx<b)
      if all(inside): state='RIBBON'; reason='bothWithinFittedInterior'
      elif not any(inside): state='TERRAIN'; reason='bothOutsideFittedInterior'
      else: state='EDGE'; reason='transition';
      out.append({'offsetPx':p,'state':state,'reason':reason,'edgePolarity':'terrainToRibbon' if state=='EDGE' and (p+PARAMS['profileWindowPx'])<a else 'ribbonToTerrain' if state=='EDGE' else None})
    return out
def build_row(raw,w,h,seed,d,frozen_refs,boxes):
    heading=math.atan2(seed['badge']['yPx']-seed['tee']['yPx'],seed['badge']['xPx']-seed['tee']['xPx']); tx,ty=math.cos(heading),math.sin(heading)
    cx=seed['badge']['xPx']+tx*d; cy=seed['badge']['yPx']+ty*d
    prof=[tangent_rgb(raw,w,h,cx,cy,heading,o,boxes) for o in range(-PARAMS['profileWindowPx'],PARAMS['profileWindowPx']+1)]
    by_offset={q['offsetPx']:q for q in prof}; center_band=[by_offset[o]['meanRgb'] for o in range(-PARAMS['methodA_liveCenterBandPx'],PARAMS['methodA_liveCenterBandPx']+1) if by_offset[o]['meanRgb']]
    live=median(center_band); predrop=frozen_refs.get(seed['hole'],{}).get('rgb'); terrain=median([q['meanRgb'] for q in prof if abs(q['offsetPx'])>64 and q['meanRgb']])
    # Every transverse point is a reader candidate. Pair samples at +/-2 preserve its raw identity.
    candidates=[]
    for o in range(-90,91,2):
        pair=[by_offset.get(o-PARAMS['readerHalfGapPx'],{}).get('meanRgb'),by_offset.get(o+PARAMS['readerHalfGapPx'],{}).get('meanRgb')]
        ra_live=method_a(pair,center=0,expected_offsets=(0,1),transverse_samples=center_band,predrop_samples=[predrop] if predrop else [],terrain_samples=[terrain] if terrain else [],reference_selector='live')
        ra_pre=method_a(pair,center=0,expected_offsets=(0,1),transverse_samples=center_band,predrop_samples=[predrop] if predrop else [],terrain_samples=[terrain] if terrain else [],reference_selector='predrop')
        candidates.append({'objectId':f'H{seed["hole"]}:d{d}:o{o}','offsetPx':o,'pairOffsetsPx':[o-2,o+2],'rawRgb':pair,'methodA_live':ra_live,'methodA_predrop':ra_pre})
    # Method B begins at centred -48..48 then gets whole trace if clipped; its interval is allowed anywhere in that window.
    bsmall=[q['meanRgb'] for q in prof[48:145]]
    bfull=[q['meanRgb'] for q in prof]
    b=method_b(bsmall,min_width=PARAMS['methodB_minInteriorPx'],contrast=PARAMS['methodB_minContrastRgb'],expand=True)
    expanded=False
    if b.get('quality')=='window_failure': b=method_b(bfull,min_width=PARAMS['methodB_minInteriorPx'],contrast=PARAMS['methodB_minContrastRgb'],expand=False); expanded=True
    if b.get('edges'):
      # Convert local B indices to full [-96,+96] index range.
      shift=0 if expanded else 48; b['edges']=[b['edges'][0]+shift,b['edges'][1]+shift]
    b['observationWindowPx']=[-96,96] if expanded else [-48,48]; b['expanded']=expanded
    # Ablation only: fixed full 96px window, not fed into the default reader verdict.
    bfull_ablation=None
    if seed['hole']==18:
      bfull_ablation=method_b(bfull,min_width=PARAMS['methodB_minInteriorPx'],contrast=PARAMS['methodB_minContrastRgb'],expand=False)
      if bfull_ablation.get('edges'): bfull_ablation['edges']=[bfull_ablation['edges'][0],bfull_ablation['edges'][1]]
      bfull_ablation['observationWindowPx']=[-96,96]
      bfull_ablation['ablation']='fullWindow96; not used by default classification'
    readers_b=classify_b_readers(b,[x['offsetPx'] for x in candidates])
    for c,rb in zip(candidates,readers_b): c['methodB']=rb
    # Rendering fields are projections of stored trace values; renderer does not reclassify.
    state = b.get('classification','UNKNOWN')
    reason = b.get('quality','')
    samples=[]
    for c in candidates:
      state_c=c['methodB']['state']
      o=c['offsetPx']; q=by_offset.get(o)
      if q:
        for e in q['samples']: samples.append({**e,'state':state_c})
    edges=[]
    if b.get('edges'):
      for ei in b['edges']:
        o=ei-PARAMS['profileWindowPx']; edges.append({'points':[{'xPx':cx+(-math.sin(heading))*o-4*math.cos(heading),'yPx':cy+math.cos(heading)*o-4*math.sin(heading)},{'xPx':cx+(-math.sin(heading))*o+4*math.cos(heading),'yPx':cy+math.cos(heading)*o+4*math.sin(heading)}]})
    return {'rowId':f'H{seed["hole"]}:d{d}','rayId':f'H{seed["hole"]}','hole':seed['hole'],'distancePx':d,'center':{'xPx':cx,'yPx':cy},'headingRad':heading,'state':state,'reason':reason,'rawValues':{'methodBResidualSse':b.get('residual_sse'),'methodBSeparation':b.get('separation')},'profile':prof,'references':{'liveMiddleRgb':live,'preDropFrozenRgb':predrop,'preDropProvenance':frozen_refs.get(seed['hole'],{}),'terrainFlanksRgb':terrain},'methodB':b,'methodBFullWindowAblation':bfull_ablation,'readers':candidates,'samples':samples,'segments':edges}
def synthetic():
    from ternary_methods import method_b
    strip=[(10,10,10)]*6+[(200,40,40)]*8+[(10,10,10)]*6
    uniform=[(50,50,50)]*20
    dim=[(65+i%3,65+i%3,65+i%3) for i in range(6)]+[(75+i%3,75+i%3,75+i%3) for i in range(8)]+[(65+i%3,65+i%3,65+i%3) for i in range(6)]
    gradient=[(i*4,i*4,i*4) for i in range(20)]
    missing=[None]*20
    offcenter=[(5,5,5)]*5+[(160,20,20)]*7+[(5,5,5)]*15
    return {n:method_b(v,min_width=4,contrast=12) for n,v in {'knownStrip':strip,'uniform':uniform,'dimVariable':dim,'terrainGradient':gradient,'missing':missing,'offCenterStrip':offcenter}.items()}
def main():
    ap=argparse.ArgumentParser(); ap.add_argument('--out',type=Path,default=ROOT/'output'); ap.add_argument('--holes',default='',help='comma-separated hole IDs; empty means all18'); args=ap.parse_args(); args.out.mkdir(parents=True,exist_ok=True)
    inp=json.loads(INPUT.read_text()); raw=RGBA.read_bytes(); boxes=[s['badge'] for s in inp['seeds']]
    ds=set(range(0,501,10)); ds.update([80,100,110,130,150]); frozen_refs={}; rows=[]
    selected={int(x) for x in args.holes.split(',') if x.strip()}
    for s in inp['seeds']:
      if selected and s['hole'] not in selected: continue
      for d in sorted(ds):
       # Do not let the fixed initial ray become an implicit tracker after it leaves the image.
       h=math.atan2(s['badge']['yPx']-s['tee']['yPx'],s['badge']['xPx']-s['tee']['xPx']); x=s['badge']['xPx']+math.cos(h)*d; y=s['badge']['yPx']+math.sin(h)*d
       if not(0<=x<inp['width'] and 0<=y<inp['height']): break
       # Freeze one early exposed center reference only (first valid d>=30), never expand it after drift.
       if s['hole'] not in frozen_refs and d>=30:
        provisional=tangent_rgb(raw,inp['width'],inp['height'],x,y,h,0,boxes)
        if provisional['meanRgb'] is not None: frozen_refs[s['hole']]={'rgb':provisional['meanRgb'],'distancePx':d,'rule':'first non-majority-occluded center band at d>=30'}
       rows.append(build_row(raw,inp['width'],inp['height'],s,d,frozen_refs,boxes))
    trace={'featureId':FEATURE,'runId':'ternary-edge-initial-v1','imageId':inp['sourceSha256'],'params':PARAMS,'paramsHash':hash_json(PARAMS),'source':{'inputsPath':'../restored/edge-diagnostic/edge-readings-work/inputs.json','rgbaPath':'../restored/edge-diagnostic/edge-readings-work/source.rgba','sha256':inp['sourceSha256']},'coordinateFrame':'source pixels, x right/y down; normal negative=left','execution':'fixed Tee→Badge initial heading, no bend/basket/C2 tracking','rays':[{'rayId':f'H{s["hole"]}','points':[{'xPx':s['badge']['xPx'],'yPx':s['badge']['yPx']},{'xPx':s['badge']['xPx']+math.cos(math.atan2(s['badge']['yPx']-s['tee']['yPx'],s['badge']['xPx']-s['tee']['xPx']))*500,'yPx':s['badge']['yPx']+math.sin(math.atan2(s['badge']['yPx']-s['tee']['yPx'],s['badge']['xPx']-s['tee']['xPx']))*500}]} for s in inp['seeds']],'rows':rows,'synthetic':synthetic(),'probabilities':'None. All margins, contrasts, and residuals are uncalibrated RGB units.'}
    trace['traceHash']=hash_json({k:v for k,v in trace.items() if k!='traceHash'})
    (args.out/'trace.json').write_text(json.dumps(trace,separators=(',',':')))
    summary={'runId':trace['runId'],'imageId':trace['imageId'],'paramsHash':trace['paramsHash'],'featureId':FEATURE,'traceHash':trace['traceHash'],'rows':len(rows),'readers':sum(len(r['readers']) for r in rows),'h18Distances':[r['distancePx'] for r in rows if r['hole']==18 and r['distancePx'] in [80,100,110,130,150]],'synthetic':trace['synthetic']}
    (args.out/'summary.json').write_text(json.dumps(summary,indent=2)); print(json.dumps(summary,indent=2))
if __name__=='__main__': main()
