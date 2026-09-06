#!/usr/bin/env python3
"""Evaluation only: compare a frozen trace to annotations, render source witnesses.

Never imported by the producer. Usage: review-bend-trace.py TRACE ANNOTATION IMAGE OUT
All distances below are source pixels; match counts are not accuracy claims.
"""
import sys, json, hashlib
from pathlib import Path
import numpy as np
from scipy.optimize import linear_sum_assignment
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from PIL import Image

tp, ap, ip, out = map(Path, sys.argv[1:5]); out.mkdir(parents=True, exist_ok=True)
t=json.loads(tp.read_text()); ann=json.loads(ap.read_text())
truth={h['number']:h for h in ann['holes']}
rows=[]
for h in t['holes']:
 a=truth.get(h['hole'])
 if a is None: rows.append({'hole':h['hole'],'evaluation':'no_annotation'}); continue
 proposals=[b['point'] for b in h.get('bendCandidates',[]) if b.get('status')=='FOUND' and b.get('point')]
 targets=[[b['xPx'],b['yPx']] for b in a.get('corridorBends',[])]
 matches=[]; unused_p=list(range(len(proposals)));unused_t=list(range(len(targets)))
 if proposals and targets:
  d=np.linalg.norm(np.asarray(proposals)[:,None,:]-np.asarray(targets)[None,:,:],axis=2)
  ii,jj=linear_sum_assignment(d)
  matches=[{'proposalIndex':int(i),'annotationIndex':int(j),'distancePx':float(d[i,j])} for i,j in zip(ii,jj)]
  unused_p=[i for i in unused_p if i not in ii];unused_t=[j for j in unused_t if j not in jj]
 rows.append({'hole':h['hole'],'executionStatus':h['status'],'stop':h.get('stop'),
  'tracePoints':len(h.get('points',[])),'annotationBends':len(targets),'proposedBends':len(proposals),
  'falseBendsOnAnnotatedStraight':len(proposals) if not targets else None,
  'initialWidth':h.get('initialWidthMeasurement'),'oneToOneMatches':matches,
  'unmatchedProposals':unused_p,'unmatchedAnnotationBends':unused_t})
report={'traceHash':t.get('traceHash'),'traceFileSha256':hashlib.sha256(tp.read_bytes()).hexdigest(),
 'annotationSha256':hashlib.sha256(ap.read_bytes()).hexdigest(),'evaluationOnly':True,
 'matching':'minimum total distance, one-to-one, no acceptance threshold; unmatched retained',
 'rows':rows}
(out/'evaluation.json').write_text(json.dumps(report,indent=2)+'\n')
im=np.asarray(Image.open(ip).convert('RGB'))
hs=[h for n in (18,16,11) for h in t['holes'] if h['hole']==n]
fig,axes=plt.subplots(1,max(1,len(hs)),figsize=(5*max(1,len(hs)),8),squeeze=False)
for ax,h in zip(axes[0],hs):
 ax.imshow(im);q=np.asarray([p['center'] for p in h['points']]);a=truth[h['hole']]
 context=np.asarray([p for p in q]+[[a[k]['xPx'],a[k]['yPx']] for k in ('tee','basket')])
 for key,color in [('left','#ffcc33'),('right','#e355c7'),('center','#00cde0')]:
  p=np.asarray([x[key] for x in h['points']]);
  if len(p):ax.plot(p[:,0],p[:,1],color=color,lw=1.2,label=key)
 for b in h.get('bendCandidates',[]):
  if b.get('status')=='FOUND' and b.get('point'):ax.scatter(*b['point'],s=45,c='#ff6528',edgecolor='white',zorder=5)
 ax.set_xlim(max(0,context[:,0].min()-50),min(im.shape[1],context[:,0].max()+50))
 ax.set_ylim(min(im.shape[0],context[:,1].max()+50),max(0,context[:,1].min()-50))
 ax.set_title(f"H{h['hole']} · stop: {h.get('stop')}\nOrange = proposed bends",fontsize=12);ax.set_aspect('equal');ax.tick_params(labelsize=8)
fig.suptitle('Frozen source trace: paired boundaries and proposed bends',fontsize=15)
fig.tight_layout();fig.savefig(out/'H18-H16-H11-review.jpg',dpi=140);plt.close(fig)
print(json.dumps({'traceHash':report['traceHash'],'evaluatedHoles':len(rows),'output':str(out)}))
