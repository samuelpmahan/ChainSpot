#!/usr/bin/env python3
"""Check original-reader parity against the original script's entire overlap."""
from pathlib import Path
import json
ROOT=Path(__file__).resolve().parents[2]
x=json.loads((ROOT/'output/bands.json').read_text())
old=json.loads((ROOT.parent/'restored/edge-diagnostic/edge-readings-work/readings.json').read_text())
assert x['sourceSha256']==old['sourceSha256']
holes={h['hole']:h for h in x['holes']};n=0;maxerr=0
for r in old['rows']:
 if r['hole'] not in holes or r['width']!=40 or r['distancePx']>300:continue
 b=holes[r['hole']]['bands'][r['distancePx']+220]
 for side,inside,outside in [('left',85,75),('right',155,165)]:
  if r[side]['occluded'] or b[inside] is None or b[outside] is None:continue
  err=abs((b[inside]-b[outside])-r[side]['rawDiff']);maxerr=max(err,maxerr);n+=1
assert n>0 and maxerr==0,(n,maxerr)
p={'originalSamplerParity':{'comparisons':n,'maxAbsoluteDifference':maxerr},'sourceSha256':x['sourceSha256'],'holesSampled':len(holes),'distanceSamples':len(x['distances']),'sidewaysSamples':len(x['offsets'])}
(ROOT/'output/parity.json').write_text(json.dumps(p,indent=2));print(json.dumps(p))
