/** Stage-aware referee and diagnostic projection of a retained LAB Sweep.
 * Reads the actual Stage PxC. Never executes a detector or writes truth into PxC.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join, basename, dirname } from 'node:path';
import { PNG } from 'pngjs';
import { restorePxC, digest } from './pxcSnapshot';
import { makeLabeledContactSheet } from '../scope/render';
import { ComponentPxC } from '@chainspot/alg/stages/componentPxC';
import { BadgePxC } from '@chainspot/alg/stages/S1/clean/Badge';
import { BasketPxC } from '@chainspot/alg/stages/S2/clean/Basket';
import { TeePxC } from '@chainspot/alg/stages/S3/clean/Tee';

export type Point = readonly [number, number];
export type Visibility = 'VISIBLE' | 'PARTIAL' | 'INVISIBLE' | 'UNKNOWN';
export interface Target { number: number; tee: Point; basket: Point; visibility: Visibility; bends: Point[]; width: number; }
export interface Detection { id: string; point: Point; }
export interface Match { number: number; id: string; distance: number; }
export const STAGE_TOLERANCE_PX = 7;

/** Maximum-cardinality, minimum-total-distance bipartite association.
 * Dummies prevent an implausible match from being forced. A single detection
 * cannot satisfy two annotations; false positives remain in the receipt.
 */
export function matchObjects(targets: readonly { number: number; point: Point }[], detections: readonly Detection[], tolerance = STAGE_TOLERANCE_PX) {
  if (!Number.isFinite(tolerance) || tolerance < 0) throw new Error('Tolerance must be finite and nonnegative.');
  if (new Set(targets.map(t => t.number)).size !== targets.length || new Set(detections.map(d => d.id)).size !== detections.length) throw new Error('Object identities must be unique.');
  for (const item of [...targets, ...detections]) if (item.point.length !== 2 || item.point.some(v => !Number.isFinite(v))) throw new Error('Coordinates must be finite.');
  const n = targets.length, m = detections.length + n;
  if (!n) return { matches: [] as Match[], missing: [] as number[], extra: detections.map(d => d.id) };
  const penalty = (n + 1) * (tolerance + 1);
  const costs = targets.map(t => [
    ...detections.map(d => { const distance = Math.hypot(t.point[0]-d.point[0],t.point[1]-d.point[1]); return distance <= tolerance ? distance : 2*penalty; }),
    ...Array(n).fill(penalty)
  ]);
  const u = new Float64Array(n+1), v = new Float64Array(m+1), p = new Int32Array(m+1), way = new Int32Array(m+1);
  for(let i=1;i<=n;i++) {
    p[0]=i; let j0=0; const minv = new Float64Array(m+1).fill(Infinity), used = new Uint8Array(m+1);
    do { used[j0]=1; const i0=p[j0]; let delta=Infinity,j1=0;
      for(let j=1;j<=m;j++) if(!used[j]) { const cur=costs[i0-1][j-1]-u[i0]-v[j]; if(cur<minv[j]) {minv[j]=cur;way[j]=j0;} if(minv[j]<delta) {delta=minv[j];j1=j;} }
      for(let j=0;j<=m;j++) if(used[j]) {u[p[j]]+=delta;v[j]-=delta;} else minv[j]-=delta;
      j0=j1;
    } while(p[j0]!==0);
    do { const j1=way[j0];p[j0]=p[j1];j0=j1; } while(j0!==0);
  }
  const matches: Match[]=[];
  for(let j=1;j<=detections.length;j++) if(p[j] && costs[p[j]-1][j-1]<=tolerance) matches.push({ number:targets[p[j]-1].number,id:detections[j-1].id,distance:costs[p[j]-1][j-1] });
  matches.sort((a,b)=>a.number-b.number);
  return { matches, missing: targets.filter(t=>!matches.some(m=>m.number===t.number)).map(t=>t.number), extra:detections.filter(d=>!matches.some(m=>m.id===d.id)).map(d=>d.id) };
}

/** Visibility is independent evaluator metadata, never guessed from whether
 * ALG found the object. An unreviewed missing target makes S3 UNKNOWN, not PASS.
 */
export function judgeVisibleTees(targets: readonly Target[], detections: readonly Detection[], tolerance=STAGE_TOLERANCE_PX) {
  const match = matchObjects(targets.map(t=>({number:t.number,point:t.tee})), detections, tolerance);
  const missing = new Set(match.missing);
  const required = targets.filter(t=>t.visibility==='VISIBLE');
  const failed = required.filter(t=>missing.has(t.number)).map(t=>t.number);
  const unknown = targets.filter(t=>t.visibility==='UNKNOWN').map(t=>t.number);
  const fabricated = targets.filter(t=>t.visibility==='INVISIBLE'&&!missing.has(t.number)).map(t=>t.number);
  const deferred = targets.filter(t=>t.visibility==='PARTIAL'||t.visibility==='INVISIBLE').map(t=>({number:t.number,visibility:t.visibility,detected:!missing.has(t.number)}));
  return { stage:'S3', verdict: failed.length||match.extra.length||fabricated.length ? 'FAIL' : unknown.length ? 'UNKNOWN' : 'PASS',
    unexpectedVisibleOnInvisible:fabricated, requiredVisible:required.length, matchedRequired:required.length-failed.length, missingVisible:failed, visibilityUnknown:unknown, deferredToS4:deferred, ...match };
}

export interface Raster { widthPx:number; heightPx:number; rgba:Uint8Array|Uint8ClampedArray; imageId?:string; }
export function exactCropOffset(full:Raster, canonical:Raster):Point {
  if(full.widthPx!==canonical.widthPx || canonical.heightPx>full.heightPx) throw new Error('Audit requires a single-source vertical crop; unsupported frame is UNKNOWN.');
  const src=Buffer.from(full.rgba.buffer,full.rgba.byteOffset,full.rgba.byteLength);
  const dst=Buffer.from(canonical.rgba.buffer,canonical.rgba.byteOffset,canonical.rgba.byteLength);
  const rowBytes=full.widthPx*4, matches:number[]=[];
  for(let top=0;top<=full.heightPx-canonical.heightPx;top++) if(src.subarray(top*rowBytes,top*rowBytes+dst.length).equals(dst)) matches.push(top);
  if(matches.length!==1) throw new Error('Canonical crop position is not uniquely established by exact source pixels.');
  return [0,matches[0]];
}

export function alignTruth(truth:any, full:Raster, canonical:Raster, visibility:Record<string,Visibility>={}) {
  const crop=exactCropOffset(full,canonical);
  const width=truth.sourceImage?.widthPx??truth.imageWidthPx, height=truth.sourceImage?.heightPx??truth.imageHeightPx;
  if(width!==canonical.widthPx) throw new Error('Truth/source widths differ: no coordinate mapping established.');
  let shift:Point, mode:string, uncertainty:number;
  if(height===full.heightPx && (!truth.sourceImage?.sha256 || truth.sourceImage.sha256===full.imageId)) { shift=[-crop[0],-crop[1]]; mode='raw-source-exact-crop';uncertainty=0; }
  else if(truth.sourceImage?.sha256===canonical.imageId) {shift=[0,0];mode='canonical-byte-match';uncertainty=0;}
  else if(Math.abs(height-canonical.heightPx)<=STAGE_TOLERANCE_PX) {shift=[0,0];mode='historical-crop-with-7px-forgiveness';uncertainty=Math.abs(height-canonical.heightPx);}
  else throw new Error(`Truth frame ${width}x${height} does not line up with LAB ${canonical.widthPx}x${canonical.heightPx} within 7px.`);
  const point=(p:any):Point=>[p.xPx+shift[0],p.yPx+shift[1]];
  const targets:Target[]=truth.holes.map((h:any)=>({number:h.number,tee:point(h.tee),basket:point(h.basket),visibility:visibility[String(h.number)]??'UNKNOWN',bends:(h.corridorBends??[]).map(point),width:h.corridorWidthPx??0}));
  if(new Set(targets.map(t=>t.number)).size!==targets.length) throw new Error('Duplicate truth hole identities.');
  return {frame:{mode,shift,uncertaintyPx:uncertainty,tolerancePx:STAGE_TOLERANCE_PX,canonicalId:canonical.imageId,crop},targets};
}

export function cropDiagnostic(image:Raster, center:Point, path:string, size=80, scale=3, owned?:ReadonlySet<number>) {
  const png=new PNG({width:size*scale,height:size*scale}); const x0=Math.round(center[0]-size/2),y0=Math.round(center[1]-size/2);
  for(let y=0;y<png.height;y++) for(let x=0;x<png.width;x++) { const sx=x0+Math.floor(x/scale),sy=y0+Math.floor(y/scale),d=(y*png.width+x)*4;
    if(sx<0||sy<0||sx>=image.widthPx||sy>=image.heightPx) {png.data.set([28,28,28,255],d);continue;}
    const pixel=sy*image.widthPx+sx; png.data.set(image.rgba.subarray(pixel*4,pixel*4+4),d);
    if(owned?.has(pixel)) png.data.set([255,70,180,255],d);
  }
  mkdirSync(dirname(path),{recursive:true});writeFileSync(path,PNG.sync.write(png));
}

export function readStageState(runDirectory:string) {
  const dir=resolve(runDirectory), receipt=JSON.parse(readFileSync(join(dir,'run.receipt.json'),'utf8'));
  const bytes=readFileSync(join(dir,'pxc.bin'));
  if(digest(bytes)!==receipt.artifacts.pxc.sha256) throw new Error('Retained PxC checksum mismatch.');
  if(digest(readFileSync(receipt.source))!==receipt.identity.inputSha256) throw new Error('Source changed since the retained Sweep.');
  const pxc=restorePxC(bytes); return {dir,receipt,pxc,image:pxc.get(ComponentPxC.image),full:pxc.get<Raster>('px.source.fullImage')};
}

export function runStageAuditCli(args:readonly string[]):void {
  const [runDirectory,truthPath,visibilityPath]=args;
  if(!runDirectory||!truthPath||args.length>3) throw new Error('Usage: lab sweep audit S3_RUN_DIRECTORY TRUTH.json [VISIBILITY.json]');
  const state=readStageState(runDirectory);
  const truth=JSON.parse(readFileSync(resolve(truthPath),'utf8'));
  if(!truth.sourceImage) throw new Error('Sparse teaching annotations are example IDs, not hole IDs. Use teaching analysis, not the Dev4 grader.');
  const visibility=visibilityPath?JSON.parse(readFileSync(resolve(visibilityPath),'utf8')):{};
  const aligned=alignTruth(truth,state.full,state.image,visibility);
  const tees=state.pxc.get(TeePxC.objects).map((t,i)=>({id:`tee-${i}`,point:t.center}));
  const baskets=state.pxc.get(BasketPxC.objects).map((b,i)=>{const box=b.has.detectFamily.body.bbox;return {id:`basket-${i}`,point:[box[0]+(box[2]-1)/2,box[1]+box[3]-1] as Point};});
  const labels=state.pxc.get(BadgePxC.objects).map(b=>b.label);
  const out=join(state.dir,'stage-audit');mkdirSync(out,{recursive:true});
  const s3=judgeVisibleTees(aligned.targets,tees);
  const s2=matchObjects(aligned.targets.map(t=>({number:t.number,point:t.basket})),baskets);
  const expectedLabels=aligned.targets.map(t=>String(t.number));
  const s1={stage:'S1',labels,missing:expectedLabels.filter(n=>!labels.includes(n)),extra:labels.filter(n=>!expectedLabels.includes(n??'')),duplicates:labels.filter((n,i)=>labels.indexOf(n)!==i)};
  const owned=new Set(state.pxc.get(TeePxC.objects).flatMap(t=>Array.from(t.px)));
  const entries=[];
  for(const target of aligned.targets) {
    const path=join(out,`H${target.number}-tee.png`);cropDiagnostic(state.image,target.tee,path);
    const match=s3.matches.find(m=>m.number===target.number);
    entries.push({path,label:`H${target.number} ${match?'MATCH':'MISSING'} ${target.visibility}`});
    cropDiagnostic(state.image,target.tee,join(out,`H${target.number}-tee-ownership.png`),80,3,owned);
  }
  makeLabeledContactSheet(entries,join(out,'tee-contact.png'));
  const receipt={schema:'stage-aware-audit-v1',mode:'TRUTH-ASSISTED-EVALUATION-ONLY',source:state.receipt.source,sourceRun:state.dir,truthSha256:digest(readFileSync(resolve(truthPath))),frame:aligned.frame,s1,s2:{stage:'S2',verdict:s2.missing.length||s2.extra.length?'FAIL':'PASS',...s2},s3,
    unexecuted:['S4','S5','S6','S7'],targets:aligned.targets,teeDetections:tees,basketDetections:baskets,diagnostic:join(out,'tee-contact.png')};
  writeFileSync(join(out,'audit.json'),JSON.stringify(receipt,null,2)+'\n');
  console.log(JSON.stringify({source:basename(state.receipt.source),frame:aligned.frame,s1,s2:receipt.s2,s3,diagnostic:receipt.diagnostic},null,2));
}
