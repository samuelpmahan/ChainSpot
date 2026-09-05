#!/usr/bin/env python3
"""View Args only: project exact retained PxC pixels; never execute CV or read truth.

Usage: python3 scripts/chainspot-lab/experiments/project_interiors.py RUNS.json OUT.png
RUNS.json is [{"course": "...", "receipt": ".../run.receipt.json"}, ...].
Requires the packet's Node runtime and Pillow. The snapshot checksum is verified
before deserialization. Amber is unclaimed white support; cyan is observed fill.
"""
from pathlib import Path
import json
import subprocess
import sys
from PIL import Image, ImageDraw, ImageFont

NODE_VIEW = r'''
const fs=require('node:fs'), crypto=require('node:crypto'), v8=require('node:v8'), path=require('node:path');
const rows=JSON.parse(fs.readFileSync(process.argv[1],'utf8')), out=[];
for(const row of rows) {
 const r=JSON.parse(fs.readFileSync(row.receipt,'utf8'));
 const bytes=fs.readFileSync(path.join(path.dirname(row.receipt),r.artifacts.pxc.path));
 if(crypto.createHash('sha256').update(bytes).digest('hex')!==r.artifacts.pxc.sha256) throw Error('PxC checksum mismatch');
 const px=new Map(v8.deserialize(Buffer.from(bytes))), image=px.get('px.image.cropped');
 if(!image || image.rgba.length!==image.widthPx*image.heightPx*4) throw Error('Missing canonical raster');
 for(const tee of px.get(r.selectionAddress || 'px.tees')) {
  if(!tee.has.interior) continue;
  const span=96, left=Math.max(0,Math.min(image.widthPx-span,Math.round(tee.center[0])-span/2)), top=Math.max(0,Math.min(image.heightPx-span,Math.round(tee.center[1])-span/2));
  const rgba=Buffer.alloc(span*span*4);
  for(let y=0;y<span;y++) rgba.set(image.rgba.subarray(((y+top)*image.widthPx+left)*4,((y+top)*image.widthPx+left+span)*4),y*span*4);
  const local=ps=>Array.from(ps).map(p=>[p%image.widthPx-left,Math.floor(p/image.widthPx)-top]).filter(([x,y])=>x>=0&&y>=0&&x<span&&y<span);
  out.push({course:row.course,id:tee.has.interior.candidateId,span,rgba:rgba.toString('base64'),owned:local(tee.px),support:local(tee.has.whiteSupport.px),receipt:row.receipt,snapshotSha256:r.artifacts.pxc.sha256});
 }
}
console.log(JSON.stringify(out));
'''

def main() -> None:
    import base64
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    result = subprocess.run(['node', '-e', NODE_VIEW, sys.argv[1]], check=True, capture_output=True, text=True, timeout=25)
    rows = json.loads(result.stdout)
    if not rows:
        raise SystemExit('No retained interior observations to project.')
    scale, tile, header, gap = 3, 288, 27, 10
    canvas = Image.new('RGB', (tile*2+gap*3, (tile+header+gap)*len(rows)+38), 'white')
    draw = ImageDraw.Draw(canvas)
    font = ImageFont.load_default(size=17)
    draw.text((gap,8), 'Source             |  Cyan: observed fill; amber: unclaimed support', fill='black', font=font)
    sidecar=[]
    for i,row in enumerate(rows):
        y=38+i*(tile+header+gap)
        draw.text((gap,y), f"{row['course']} / {row['id']} / {len(row['owned'])} observed px", fill='black',font=font)
        raw=Image.frombytes('RGBA',(row['span'],row['span']),base64.b64decode(row['rgba'])).convert('RGB')
        projection=raw.copy()
        for x,py in row['support']: projection.putpixel((x,py),(245,158,11))
        for x,py in row['owned']: projection.putpixel((x,py),(0,220,235))
        canvas.paste(raw.resize((tile,tile),Image.Resampling.NEAREST),(gap,y+header))
        canvas.paste(projection.resize((tile,tile),Image.Resampling.NEAREST),(tile+gap*2,y+header))
        sidecar.append({k:v for k,v in row.items() if k not in ('rgba','owned','support')})
    target=Path(sys.argv[2]); target.parent.mkdir(parents=True,exist_ok=True); canvas.save(target)
    target.with_suffix('.json').write_text(json.dumps({'projection':'VIEW_ONLY_NO_CV','rows':sidecar},indent=2)+'\n')
    print(f'{target.resolve()} ({len(rows)} retained observations; no computation rerun)')

if __name__=='__main__': main()
