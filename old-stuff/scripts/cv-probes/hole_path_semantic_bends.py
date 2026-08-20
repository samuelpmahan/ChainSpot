#!/usr/bin/env python3
"""Compare cheap semantic-bend extractors on frozen hole-path outputs only."""
import argparse, csv, html, json, math
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw

REPO=Path(__file__).resolve().parents[2]; R=REPO/'scripts/cv-probes/hole-path-results'
DP=R/'hole-paths-v2.json'; AP=R/'alexclark-hole-paths.json'
DB=REPO/'resources/ribbon-reference/IMG_5641-bent-holes-labels.json'
DG=REPO/'resources/ribbon-reference/IMG_5641-ribbon-golden.json'
AL=REPO/'resources/stitch-annotate/AlexClark/AlexClark-McKinney-TX-labels.json'
RDP_EPS=10.; PEN=25.; WIN=50.; TURN=10.; RAD=21.; LOC_BAD=42.; SHAPE_BAD=.80
CATS={1:'gentle',2:'gentle',3:'straight',4:'late bend',5:'dogleg',6:'straight',7:'gentle',8:'dogleg',9:'straight',10:'straight',11:'straight',12:'straight',13:'straight',14:'dogleg',15:'gentle',16:'straight',17:'straight',18:'two-bend'}

def xy(p): return [float(p['xPx']),float(p['yPx'])]
def d(a,b): return float(np.linalg.norm(np.asarray(a)-np.asarray(b)))
def wrap(a): return (a+math.pi)%(2*math.pi)-math.pi
def metrics(poly):
 out=[]
 for i in range(1,len(poly)-1):
  a=np.asarray(poly[i])-np.asarray(poly[i-1]); b=np.asarray(poly[i+1])-np.asarray(poly[i])
  hi,ho=math.atan2(a[1],a[0]),math.atan2(b[1],b[0]); t=wrap(ho-hi)
  out.append({'pointPx':[round(x,1) for x in poly[i]],'incomingHeadingDeg':round(math.degrees(hi),1),'outgoingHeadingDeg':round(math.degrees(ho),1),'turnAngleDeg':round(math.degrees(t),1),'turnAngleRad':round(t,4)})
 return out

def sample(poly,step=2.):
 p=np.asarray(poly,float); out=[p[0]]
 for a,b in zip(p[:-1],p[1:]):
  n=max(1,int(math.ceil(np.linalg.norm(b-a)/step)))
  out += [a+(b-a)*i/n for i in range(1,n+1)]
 return np.asarray(out)
def segdist(p,a,b):
 v=b-a; den=v@v
 if den<1e-12:return float(np.linalg.norm(p-a))
 t=np.clip(((p-a)@v)/den,0,1); return float(np.linalg.norm(p-(a+t*v)))
def poly_dist(p,poly):
 q=np.asarray(poly,float); return min(segdist(p,a,b) for a,b in zip(q[:-1],q[1:]))
def shape_cont(poly,frozen): return float(np.mean([poly_dist(p,frozen)<=RAD for p in sample(poly)]))
def orient(edge,tee): return edge if d(edge[0],tee)<=d(edge[-1],tee) else list(reversed(edge))
def mask(left,right,tee,size):
 l,r=orient(left,tee),orient(right,tee); im=Image.new('1',tuple(size),0); ImageDraw.Draw(im).polygon([tuple(p) for p in l+list(reversed(r))],fill=1); return im
def contain(im,poly):
 a=np.asarray(im,bool); p=sample(poly); x=np.clip(np.rint(p[:,0]).astype(int),0,a.shape[1]-1); y=np.clip(np.rint(p[:,1]).astype(int),0,a.shape[0]-1); return float(a[y,x].mean())
def sse(p,i,j):
 a,b=p[i],p[j]; q=p[i:j+1]; v=b-a; den=v@v
 if den<1e-12:return float(np.square(q-a).sum())
 t=np.clip(((q-a)@v)/den,0,1); return float(np.square(q-(a+t[:,None]*v)).sum())
def resample(edge,n=101):
 p=np.asarray(edge,float); lens=np.linalg.norm(np.diff(p,axis=0),axis=1); c=np.r_[0,np.cumsum(lens)]; out=[]
 for s in np.linspace(0,c[-1],n):
  j=min(max(np.searchsorted(c,s,side='right')-1,0),len(lens)-1); t=(s-c[j])/max(lens[j],1e-12); out.append(p[j]+t*(p[j+1]-p[j]))
 return np.asarray(out)
def one_bend(center):
 n=len(center); return min(range(max(2,int(.2*n)),min(n-2,int(.8*n))),key=lambda i:sse(center,0,i)+sse(center,i,n-1))
def prune(poly):
 p=[list(x) for x in poly]
 while len(p)>2:
  ms=metrics(p); weak=next((i+1 for i,m in enumerate(ms) if abs(m['turnAngleDeg'])<10),None)
  if weak is None:break
  del p[weak]
 return p

def truth():
 db,dg,al=map(lambda p:json.loads(p.read_text()),(DB,DG,AL)); dash={}
 for h in dg['holes']:
  n=int(h['number']); l=[xy(x) for x in h['leftEdge']]; r=[xy(x) for x in h['rightEdge']]
  if d(l[0],r[0])+d(l[-1],r[-1])>d(l[0],r[-1])+d(l[-1],r[0]):r.reverse()
  c=(resample(l)+resample(r))/2; bends=[c[one_bend(c)].tolist()] if n in (1,2) else []
  dash[n]={'count':len(bends),'bends':bends,'cat':CATS[n],'mask':mask(l,r,c[0].tolist(),(dg['source']['widthPx'],dg['source']['heightPx'])),'source':'dense golden gutters'}
 by={int(h['number']):h for h in db['holes']}
 for n in range(4,19):
  if n not in by: dash[n]={'count':0,'bends':[],'cat':CATS[n],'mask':None,'source':'bent fixture unlisted=straight'}; continue
  h=by[n]; t,b=xy(h['tee']),xy(h['basket']); l=orient([xy(x) for x in h['left']],t); r=orient([xy(x) for x in h['right']],t)
  mids=[((np.asarray(a)+b)/2).tolist() for a,b in zip(l[1:-1],r[1:-1])]; p=prune([t]+mids+[b])
  dash[n]={'count':len(p)-2,'bends':p[1:-1],'cat':CATS[n],'mask':mask(l,r,t,(db['imageWidthPx'],db['imageHeightPx'])),'source':'explicit bent gutters'}
 alex={}
 for h in al['holes']:
  n=int(h['number']); t,b=xy(h['tee']),xy(h['basket']); l=orient([xy(x) for x in h['left']],t); r=orient([xy(x) for x in h['right']],t)
  mids=[((np.asarray(a)+b)/2).tolist() for a,b in zip(l[1:-1],r[1:-1])]; p=prune([t]+mids+[b])
  alex[n]={'count':len(p)-2,'bends':p[1:-1],'cat':'bent','mask':mask(l,r,t,(al['imageWidthPx'],al['imageHeightPx'])),'source':'existing Alex bent gutters'}
 return dash,alex

def rdp(poly,eps=RDP_EPS):
 p=np.asarray(poly,float)
 if len(p)<=2:return p.tolist()
 ds=np.array([segdist(q,p[0],p[-1]) for q in p]); i=int(ds.argmax())
 if ds[i]<=eps:return [p[0].tolist(),p[-1].tolist()]
 return rdp(p[:i+1].tolist(),eps)[:-1]+rdp(p[i:].tolist(),eps)
def piece(poly,pen=PEN):
 p=sample(poly,6.); n=len(p); m=max(3,int(math.ceil((n-1)*.12))); cost=np.full((n,n),np.inf)
 for i in range(n-1):
  for j in range(i+1,n):cost[i,j]=sse(p,i,j)
 choices=[(cost[0,n-1]/n,[0,n-1])]
 if n>2*m:
  choices.append(min([((cost[0,i]+cost[i,n-1])/n+pen,[0,i,n-1]) for i in range(m,n-m)],key=lambda x:x[0]))
 if n>3*m:
  choices.append(min([((cost[0,i]+cost[i,j]+cost[j,n-1])/n+2*pen,[0,i,j,n-1]) for i in range(m,n-2*m) for j in range(i+m,n-m)],key=lambda x:x[0]))
 _,idx=min(choices,key=lambda x:x[0]); return p[idx].tolist()
def at_s(p,c,s):
 s=np.clip(s,0,c[-1]); j=min(max(np.searchsorted(c,s,side='right')-1,0),len(p)-2); t=(s-c[j])/max(c[j+1]-c[j],1e-12); return p[j]+t*(p[j+1]-p[j])
def heading(poly,win=WIN,th=TURN):
 p=np.asarray(poly,float); c=np.r_[0,np.cumsum(np.linalg.norm(np.diff(p,axis=0),axis=1))]
 if c[-1]<=2*win:return [p[0].tolist(),p[-1].tolist()]
 ev=[]
 for s in np.arange(win,c[-1]-win+1e-9,2):
  a,b,z=at_s(p,c,s-win),at_s(p,c,s),at_s(p,c,s+win); ev.append((s,b.tolist(),wrap(math.atan2(*(z-b)[::-1])-math.atan2(*(b-a)[::-1]))))
 active=[abs(math.degrees(e[2]))>=th for e in ev]; cl=[]; i=0
 while i<len(ev):
  if not active[i]:i+=1;continue
  sign=np.sign(ev[i][2]); j=i+1
  while j<len(ev) and active[j] and np.sign(ev[j][2])==sign:j+=1
  cl.append(max(ev[i:j],key=lambda e:abs(e[2]))); i=j
 merged=[]
 for e in cl:
  if merged and np.sign(e[2])==np.sign(merged[-1][2]) and e[0]-merged[-1][0]<=win:
   if abs(e[2])>abs(merged[-1][2]):merged[-1]=e
  else:merged.append(e)
 if len(merged)>2:merged=sorted(sorted(merged,key=lambda e:abs(e[2]),reverse=True)[:2])
 return [p[0].tolist()]+[e[1] for e in merged]+[p[-1].tolist()]
def baseline(row,anchored):
 p=[[float(x),float(y)] for x,y in row['centerlinePx']]; k=int(row['bends']); bends=p[2:2+k] if anchored else p[1:1+k]; return [p[0]]+bends+[p[-1]]

def eval_course(name,rows,tr,anchored):
 out={}
 for n in sorted(tr):
  row=rows[str(n)]; frozen=[[float(x),float(y)] for x,y in row['centerlinePx']]; before=contain(tr[n]['mask'],frozen) if tr[n]['mask'] else None
  methods={'capsule':baseline(row,anchored),'rdp':rdp(frozen),'piecewise':piece(frozen),'heading':heading(frozen)}; mm={}
  for key,poly in methods.items():
   ms=metrics(poly); errs=[d(a,b) for a,b in zip([m['pointPx'] for m in ms],tr[n]['bends'])] if len(ms)==tr[n]['count'] else []
   after=contain(tr[n]['mask'],poly) if tr[n]['mask'] else None
   status='SHAPE BAD' if before is not None and before<SHAPE_BAD else 'COUNT WRONG' if len(ms)!=tr[n]['count'] else 'LOCATION WRONG' if errs and max(errs)>LOC_BAD else 'GOOD'
   mm[key]={'count':len(ms),'bends':ms,'errors':[round(x,1) for x in errs],'shapeAfter':round(shape_cont(poly,frozen),3),'truthAfter':round(after,3) if after is not None else None,'status':status}
  out[str(n)]={'truthCount':tr[n]['count'],'truthBends':[[round(x,1),round(y,1)] for x,y in tr[n]['bends']],'category':tr[n]['cat'],'source':tr[n]['source'],'frozen':frozen,'truthBefore':round(before,3) if before is not None else None,'methods':mm}
 return {'course':name,'holes':out}
def agg(c,m):
 rows=list(c['holes'].values()); good=[r for r in rows if r['truthBefore'] is None or r['truthBefore']>=SHAPE_BAD]; straight=[r for r in good if r['truthCount']==0]; bent=[r for r in good if r['truthCount']>0]
 exact=sum(r['methods'][m]['count']==r['truthCount'] for r in good); raw=sum(r['methods'][m]['count']==r['truthCount'] for r in rows); errs=[e for r in good for e in r['methods'][m]['errors']]; rawerr=[e for r in rows for e in r['methods'][m]['errors']]
 return {'rawLabeledHoles':len(rows),'rawExact012CountAccuracy':round(raw/len(rows),3),'evaluatedShapeGoodHoles':len(good),'shapeBadHoles':len(rows)-len(good),'straightVsBentAccuracy':round(sum((r['methods'][m]['count']>0)==(r['truthCount']>0) for r in good)/len(good),3) if straight and bent else None,'exact012CountAccuracy':round(exact/len(good),3),'falseBendsOnStraightHoles':sum(r['methods'][m]['count']>0 for r in straight) if straight else None,'straightHoleCount':len(straight),'missedBendCount':sum(max(0,r['truthCount']-r['methods'][m]['count']) for r in good),'extraBendCount':sum(max(0,r['methods'][m]['count']-r['truthCount']) for r in good),'medianBendLocationErrorPx':round(float(np.median(errs)),1) if errs else None,'maxBendLocationErrorPx':round(max(errs),1) if errs else None,'rawMedianBendLocationErrorPx':round(float(np.median(rawerr)),1) if rawerr else None,'rawMaxBendLocationErrorPx':round(max(rawerr),1) if rawerr else None}

def write_csv(path,courses):
 flds=['course','hole','truth_category','truth_count','shape_truth_containment_before','rdp_count','rdp_bends_px','rdp_location_errors_px','rdp_incoming_headings_deg','rdp_outgoing_headings_deg','rdp_turn_angles_deg','rdp_turn_angles_rad','rdp_detected_shape_containment_before','rdp_detected_shape_containment_after','rdp_truth_containment_after','status','piecewise_count','piecewise_location_errors_px','heading_count','heading_location_errors_px','capsule_count','capsule_location_errors_px']
 with path.open('w',newline='') as f:
  w=csv.DictWriter(f,fieldnames=flds);w.writeheader()
  for cname,c in courses.items():
   for n,r in c['holes'].items():
    a=r['methods']['rdp']; p=r['methods']['piecewise']; h=r['methods']['heading']; b=r['methods']['capsule']; join=lambda xs:';'.join(str(x) for x in xs)
    w.writerow({'course':cname,'hole':n,'truth_category':r['category'],'truth_count':r['truthCount'],'shape_truth_containment_before':r['truthBefore'],'rdp_count':a['count'],'rdp_bends_px':';'.join(f"({x['pointPx'][0]:.1f},{x['pointPx'][1]:.1f})" for x in a['bends']),'rdp_location_errors_px':join(a['errors']),'rdp_incoming_headings_deg':join([x['incomingHeadingDeg'] for x in a['bends']]),'rdp_outgoing_headings_deg':join([x['outgoingHeadingDeg'] for x in a['bends']]),'rdp_turn_angles_deg':join([x['turnAngleDeg'] for x in a['bends']]),'rdp_turn_angles_rad':join([x['turnAngleRad'] for x in a['bends']]),'rdp_detected_shape_containment_before':1.0,'rdp_detected_shape_containment_after':a['shapeAfter'],'rdp_truth_containment_after':a['truthAfter'],'status':a['status'],'piecewise_count':p['count'],'piecewise_location_errors_px':join(p['errors']),'heading_count':h['count'],'heading_location_errors_px':join(h['errors']),'capsule_count':b['count'],'capsule_location_errors_px':join(b['errors'])})
def svg(path,courses):
 tiles=[(k[0],int(n),r) for k,c in courses.items() for n,r in c['holes'].items()]; cols,tw,th=4,360,270; rows=math.ceil(len(tiles)/cols); s=[f'<svg xmlns="http://www.w3.org/2000/svg" width="{cols*tw}" height="{rows*th}" viewBox="0 0 {cols*tw} {rows*th}"><rect width="100%" height="100%" fill="white"/><style>text{{font:11px monospace}}.f{{fill:none;stroke:#bbb;stroke-width:7}}.p{{fill:none;stroke:#111;stroke-width:4}}.b{{fill:#fa0;stroke:#111;stroke-width:2}}.t{{stroke:#0675d8;stroke-width:3}}</style>']
 for i,(pref,n,r) in enumerate(tiles):
  x0,y0=(i%cols)*tw,(i//cols)*th; a=r['methods']['rdp']; pred=[r['frozen'][0]]+[x['pointPx'] for x in a['bends']]+[r['frozen'][-1]]; allp=r['frozen']+pred+r['truthBends']; xs=[q[0] for q in allp];ys=[q[1] for q in allp]; cx,cy=(min(xs)+max(xs))/2,(min(ys)+max(ys))/2; sc=min((tw-50)/max(max(xs)-min(xs),1),135/max(max(ys)-min(ys),1)); tr=lambda q:(x0+tw/2+(q[0]-cx)*sc,y0+88+(q[1]-cy)*sc); pts=lambda qs:' '.join(f'{tr(q)[0]:.1f},{tr(q)[1]:.1f}' for q in qs)
  s += [f'<g><rect x="{x0}" y="{y0}" width="{tw}" height="{th}" fill="none" stroke="#ddd"/><polyline class="f" points="{pts(r["frozen"])}"/><polyline class="p" points="{pts(pred)}"/>']
  for b in a['bends']:
   x,y=tr(b['pointPx']);s.append(f'<circle class="b" cx="{x:.1f}" cy="{y:.1f}" r="7"/>')
  for q in r['truthBends']:
   x,y=tr(q);s.append(f'<path class="t" d="M{x-8:.1f},{y:.1f}H{x+8:.1f} M{x:.1f},{y-8:.1f}V{y+8:.1f}"/>')
  err='—' if not a['errors'] else ','.join(map(str,a['errors'])); turns='—' if not a['bends'] else ', '.join(f"{abs(b['turnAngleDeg']):.1f}°/{abs(b['turnAngleRad']):.3f}rad" for b in a['bends']); texts=[f'{pref}{n} {a["status"]}',f'truth {r["truthCount"]} pred {a["count"]} {r["category"]}',f'err px: {err}',f'turn: {turns}',f'shape contain: 1.00 -> {a["shapeAfter"]:.2f}']
  for j,t in enumerate(texts):s.append(f'<text x="{x0+8}" y="{y0+190+j*15}">{html.escape(t)}</text>')
  s.append('</g>')
 s.append('</svg>');path.write_text('\n'.join(s)+'\n')

def main():
 ap=argparse.ArgumentParser();ap.add_argument('--out',default=str(R));out=Path(ap.parse_args().out);out.mkdir(parents=True,exist_ok=True)
 dr,ar=json.loads(DP.read_text()),json.loads(AP.read_text());dt,at=truth(); dash=eval_course("Dash's Track",dr,dt,True);alex=eval_course('AlexClark labeled bent subset',ar,at,False);courses={'Dash':dash,'AlexClark':alex}
 ag={m:{'Dash':agg(dash,m),'AlexClark':agg(alex,m)} for m in ('capsule','rdp','piecewise','heading')}
 robust={'rdpDashExactCount':{str(e):sum(len(rdp(dr[str(n)]['centerlinePx'],e))-2==dt[n]['count'] for n in range(1,19)) for e in (8,10,12,14)},'piecewiseDashExactCount':{str(p):sum(len(piece(dr[str(n)]['centerlinePx'],p))-2==dt[n]['count'] for n in range(1,19)) for p in (16,25,36,49)},'headingDashExactCount':{str(t):sum(len(heading(dr[str(n)]['centerlinePx'],WIN,t))-2==dt[n]['count'] for n in range(1,19)) for t in (8,10,12,14)}}
 floor={}
 for cname,tr,rows,c in [('Dash',dt,dr,dash),('AlexClark',at,ar,alex)]:
  z=[]
  for n,v in tr.items():
   if not v['count']:continue
   frozen=rows[str(n)]['centerlinePx']; tm=metrics([frozen[0]]+v['bends']+[frozen[-1]])
   for i,x in enumerate(tm): z.append({'hole':n,'bend':i+1,'trueApproxTurnDeg':round(abs(x['turnAngleDeg']),1),'detectedByRdp':c['holes'][str(n)]['methods']['rdp']['count']==v['count'],'rdpStatus':c['holes'][str(n)]['methods']['rdp']['status']})
  floor[cname]=sorted(z,key=lambda x:x['trueApproxTurnDeg'])
 summary={'frozenInput':{'Dash':'hole-path-results/hole-paths-v2.json','AlexClark':'hole-path-results/alexclark-hole-paths.json','note':'No raster segmentation/path fitting is run.'},'parameters':{'rdpEpsilonPx':RDP_EPS,'piecewisePenaltyPx2PerBend':PEN,'headingWindowPx':WIN,'headingThresholdDeg':TURN,'detectedCorridorRadiusPx':RAD,'diagnosticLocationWrongPx':LOC_BAD,'diagnosticShapeBadContainment':SHAPE_BAD},'aggregates':ag,'robustnessChecks':robust,'turnMagnitudeFloor':floor}
 (out/'semantic-bends-summary.json').write_text(json.dumps(summary,indent=2)+'\n');write_csv(out/'semantic-bends-results.csv',courses);svg(out/'semantic-bends-contact-sheet.svg',courses)
 for m in ag:print(m,json.dumps(ag[m],separators=(',',':')))
 print('robustness',json.dumps(robust,separators=(',',':')))
if __name__=='__main__':main()
