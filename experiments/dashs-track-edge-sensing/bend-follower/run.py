#!/usr/bin/env python3
"""Producer for the default-OFF paired-boundary path-follower experiment."""
import argparse, hashlib, json, sys
from pathlib import Path
import numpy as np
from PIL import Image
ROOT=Path(__file__).resolve().parent
INPUT=ROOT.parent/'restored/edge-diagnostic/edge-readings-work/inputs.json'
RGBA=ROOT.parent/'restored/edge-diagnostic/edge-readings-work/source.rgba'
SOURCE=ROOT.parent/'restored/edge-diagnostic/edge-reading-inspection/DashsTrack-full.jpg'
sys.path.insert(0,str(ROOT/'lib'))
from tracker import track_hole, synthetic_checks, multiscale_edge_support
from render_trace import render_all, render_h18, render_failures
FEATURE='pairedBoundaryPathFollower'
DEFAULT_PARAMS={'steps':90,'step_length':4.0,'beam_width':24,'min_width':12.0,'max_width':100.0,'heading_offsets':[-0.22,-0.11,0.0,0.11,0.22],'width_offsets':[-2.0,0.0,2.0],'transverse_offsets':[-1.0,0.0,1.0],'min_pair_support':0.0,'support_weight':1.0,'curvature_weight':0.55,'width_weight':0.35}
def canonical(x): return hashlib.sha256(json.dumps(x,sort_keys=True,separators=(',',':')).encode()).hexdigest()
def _bilinear(a,x,y):
 h,w=a.shape
 if x<0 or y<0 or x>w-1 or y>h-1:return float("nan")
 x0,y0=int(x),int(y);x1,y1=min(x0+1,w-1),min(y0+1,h-1);fx,fy=x-x0,y-y0
 return (1-fx)*(1-fy)*float(a[y0,x0])+fx*(1-fy)*float(a[y0,x1])+(1-fx)*fy*float(a[y1,x0])+fx*fy*float(a[y1,x1])
def learn_initial_width(gray, mask, seed, heading):
 """First exposed Tee→Badge extension only; finite scan bounds are recorded diagnostics."""
 tx,ty=float(np.cos(heading)),float(np.sin(heading));nx,ny=-ty,tx
 mask_float=mask.astype(float)
 def sample(x,y):
  if _bilinear(mask_float,x,y)>0.001:return float("nan")
  return _bilinear(gray,x,y)
 best=None
 # Exact sampled post-badge positions, no endpoint/basket inputs.
 # Backward scan is the exposed Tee→Badge leg; it avoids learning the badge glyph.
 for d in range(30,101,5):
  cx=seed['badge']['xPx']-d*tx;cy=seed['badge']['yPx']-d*ty
  for width in range(12,101,4):
   l=(cx-nx*width/2,cy-ny*width/2);r=(cx+nx*width/2,cy+ny*width/2)
   a=multiscale_edge_support(sample,l,(nx,ny));b=multiscale_edge_support(sample,r,(-nx,-ny))
   if np.isfinite(a) and np.isfinite(b):
    v=min(a,b)
    if best is None or v>best[0]:best=(float(v),d,width,cx,cy,float(a),float(b))
 if best is None:return 24.0,{'state':'UNKNOWN','reason':'no_exposed_paired_support','searchPx':[12,100],'clipped':False}
 score,d,width,cx,cy,a,b=best
 return float(width),{'state':'MEASURED','score':score,'widthPx':width,'searchPx':[12,100],'clipped':width in (12,100),'centerAtPx':[cx,cy],'distanceFromBadgePx':-d,'edgeSupport':[a,b],'leg':'exposed Tee→Badge (backward from Badge center)'}
def first_clear_post_badge(mask, seed, heading, width):
    tx,ty=float(np.cos(heading)),float(np.sin(heading));nx,ny=-ty,tx
    mask_float=mask.astype(float)
    for d in range(1,121):
        cx=seed['badge']['xPx']+d*tx;cy=seed['badge']['yPx']+d*ty
        # Clearance includes both future boundary supports, not center alone.
        pts=((cx,cy),(cx-nx*width/2,cy-ny*width/2),(cx+nx*width/2,cy+ny*width/2))
        if all(_bilinear(mask_float,x,y)<=0.001 for x,y in pts):
            return cx,cy,{'state':'CLEARED','distanceFromBadgePx':d,'rule':'first center+both predicted boundaries outside known Badge bboxes'}
    return seed['badge']['xPx'],seed['badge']['yPx'],{'state':'UNKNOWN','reason':'no_clear_postBadge_pose_within_120px'}
def main():
 ap=argparse.ArgumentParser();ap.add_argument('--out',type=Path,default=ROOT/'output/direct');ap.add_argument('--holes',default='');ap.add_argument('--max-steps',type=int,default=None);args=ap.parse_args();args.out.mkdir(parents=True,exist_ok=True)
 inp=json.loads(INPUT.read_text());raw=RGBA.read_bytes();arr=np.frombuffer(raw,dtype=np.uint8).reshape((inp['height'],inp['width'],4));rgb=arr[:,:,:3].copy()
 # Each badge is known visual ownership. Its pixels are excluded from support, including ownBadge.
 mask=np.zeros((inp['height'],inp['width']),dtype=bool)
 for s in inp['seeds']:
  b=s['badge'];x0=max(0,int(b['bboxX']));y0=max(0,int(b['bboxY']));x1=min(inp['width'],int(b['bboxX']+b['bboxW']));y1=min(inp['height'],int(b['bboxY']+b['bboxH']));mask[y0:y1+1,x0:x1+1]=True
 chosen={int(v) for v in args.holes.split(',') if v.strip()}; params=dict(DEFAULT_PARAMS)
 if args.max_steps is not None: params['steps']=args.max_steps
 holes=[]
 for seed in inp['seeds']:
  if chosen and seed['hole'] not in chosen: continue
  try:
   heading=float(np.arctan2(seed['badge']['yPx']-seed['tee']['yPx'], seed['badge']['xPx']-seed['tee']['xPx']))
   gray=np.dot(rgb[...,:3],[0.2126,0.7152,0.0722])
   width,learned=learn_initial_width(gray,mask,seed,heading)
   # Begin at the measured exposed sample; Badge pixels stay UNKNOWN.
   cx,cy,clearance=first_clear_post_badge(mask,seed,heading,width)
   adapted={'center':(cx,cy),'heading':heading,'width':width}
   h=track_hole(gray,mask,adapted,params)
   h.update({'hole':seed['hole'],'executionState':'ran','seedProvenance':seed.get('teeSource'),'trackedExtentPx':max(0,len(h.get('points',[]))-1)*params['step_length'],'initialWidthMeasurement':learned,'badgeTransit':{'state':'UNKNOWN','reason':'known Badge visual ownership masked; no edge support credited','postBadgeStart':clearance},'checkpoints':[{'step':i,'center':q['center'],'support':q['support']} for i,q in enumerate(h.get('points',[])) if i and i%20==0]})
   # Bounded source-only ablations diagnose curvature and sharp-only sensing.
   h['variants']={'default':{'state':'ran','multiscale':True,'curvatureWeight':params['curvature_weight']}}
   if seed['hole']==18:
    for name,change in {'weakerCurvature':{'curvature_weight':0.25},'strongerCurvature':{'curvature_weight':1.10},'sharpOnlyEdges':{'use_multiscale_support':False}}.items():
     vv=dict(params);vv.update(change);r=track_hole(gray,mask,adapted,vv)
     h['variants'][name]={'state':'ran','stopReason':r.get('stop'),'trackedExtentPx':max(0,len(r.get('points',[]))-1)*vv['step_length'],'bestScore':r.get('widthDiagnostics',{}).get('bestScore'),'bendCandidates':r.get('bendCandidates',[]),'points':r.get('points',[]),'checkpoints':[{'step':i,'center':q['center'],'support':q['support']} for i,q in enumerate(r.get('points',[])) if i and i%20==0]}
   holes.append(h)
   # Durable progress receipt permits inspection of bounded all18 runs before final render.
   partial={'runId':'paired-boundary-follower-source-v1','featureId':FEATURE,'state':'running','holesCompleted':len(holes),'holes':holes}
   (args.out/'partial-receipt.json').write_text(json.dumps(partial,indent=2))
   print(json.dumps({'progress':len(holes),'hole':seed['hole'],'status':h['status'],'extent':h['trackedExtentPx'],'stop':h['stop']}),flush=True)
  except Exception as e: holes.append({'hole':seed['hole'],'status':'failed','seedProvenance':seed.get('teeSource'),'points':[],'alternatives':[],'stop':{'reason':'producer_exception','detail':repr(e)},'bendCandidates':[]})
 run_id='paired-boundary-follower-source-v1'
 trace={'runId':run_id,'featureId':FEATURE,'imageId':inp['sourceSha256'],'coordinateFrame':'source pixels x right/y down; headings radians; widths pixels','source':{'inputsPath':'../restored/edge-diagnostic/edge-readings-work/inputs.json','rgbaPath':'../restored/edge-diagnostic/edge-readings-work/source.rgba','fullJpeg':'../restored/edge-diagnostic/edge-reading-inspection/DashsTrack-full.jpg','sha256':inp['sourceSha256']},'provenance':{'tee':'saved seeds; H3,H5,H12 annotation-assisted as explicitly recorded','badge':'saved badge bboxes mask visual ownership','forbiddenInputs':'No annotation JSON, Basket targets, C2 targets, or width annotation were read'},'params':params,'paramsHash':canonical(params),'holes':holes,'synthetic':synthetic_checks(),'limitations':'Bounded discrete curvature-aware beam approximation; no endpoint steering. C2 continuation is UNKNOWN unless evidence supports it.'}
 # Renderer receives frozen winner geometry; each other hole remains trace data only.
 h18=next((h for h in holes if h.get('hole')==18),None)
 if h18:
  p=h18.get('points',[]); bends=[b.get('point') for b in h18.get('bendCandidates',[]) if b.get('status')=='FOUND' and b.get('point')]
  trace['candidates']=[{'candidateId':'H18-primary','winner':True,'status':h18.get('status'),'centerline':[q['center'] for q in p],'leftEdge':[q['left'] for q in p],'rightEdge':[q['right'] for q in p],'bendDots':bends}]
 trace['traceHash']=canonical({k:v for k,v in trace.items() if k!='traceHash'})
 (args.out/'trace.json').write_text(json.dumps(trace,indent=2))
 summary={'runId':run_id,'featureId':FEATURE,'traceHash':trace['traceHash'],'paramsHash':trace['paramsHash'],'holes':[{'hole':h['hole'],'status':h['status'],'trackedExtentPx':h.get('trackedExtentPx',0),'stop':h.get('stop',{}).get('reason') if isinstance(h.get('stop'),dict) else h.get('stop'),'widthHypotheses':h.get('widthDiagnostics',{}),'bendPoints':h.get('bendCandidates',[]),'variants':h.get('variants',{}),'checkpoints':h.get('checkpoints',[])} for h in holes],'synthetic':trace['synthetic']}
 (args.out/'summary.json').write_text(json.dumps(summary,indent=2))
 render_h18(SOURCE,trace,args.out/'H18-paired-boundary-detail.jpg');render_all(SOURCE,trace,args.out/'DashsTrack-all18-paired-boundary.jpg');render_failures(SOURCE,trace,args.out/'focused-failures.jpg')
 if holes and all(h.get('status')=='failed' for h in holes): raise RuntimeError('all selected holes had producer_exception')
 print(json.dumps({'runId':run_id,'featureId':FEATURE,'traceHash':trace['traceHash'],'holes':len(holes)},indent=2))
if __name__=='__main__': main()
