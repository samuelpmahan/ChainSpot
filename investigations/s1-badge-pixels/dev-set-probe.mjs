import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, extname, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { executeNodeCanonicalInputTick } from '../../packages/alg/dist/exec/node-intake.js';
import { opencvSaturation } from '../../packages/alg/dist/detectors/threeFactor/raster.js';

const [corpusRoot, outDir = 'investigations/s1-badge-pixels/dev-set-output'] = process.argv.slice(2);
if (!corpusRoot) throw new Error('Usage: node dev-set-probe.mjs <chainspot-corpus/dev> [out-dir]');
mkdirSync(outDir, { recursive: true });

const stageDir = resolve('packages/alg/dist/stages/S1/exp/badge-assembly');
const { createStage } = await import(pathToFileURL(resolve(stageDir, 'stage.js')).href);
const yaml = readFileSync(resolve(stageDir, 'PrincipleComponentRender.yaml'), 'utf8');

function roleParts(candidate) {
  const out = [
    ['plate', candidate.plate?.part],
    ['border', candidate.border?.part],
    ...((candidate.digits ?? []).map(x => ['digit', x.part])),
    ...((candidate.digitLoops?.rows ?? []).flatMap(row => (row.matches ?? []).map(x => ['loop', x.part])))
  ];
  return out.filter(([, part]) => part?.pixels);
}

function bboxOf(part) {
  let minX=Infinity,minY=Infinity,maxX=-1,maxY=-1;
  for (const p of part.pixels) {
    const x=p%part.widthPx,y=Math.floor(p/part.widthPx);
    if(x<minX)minX=x;if(x>maxX)maxX=x;if(y<minY)minY=y;if(y>maxY)maxY=y;
  }
  return [minX,minY,maxX-minX+1,maxY-minY+1];
}

function footprint(border) {
  const [x0,y0,w,h]=bboxOf(border), W=border.widthPx, H=border.heightPx;
  const borderSet=new Set(border.pixels);
  const minX=Math.max(0,x0-1), minY=Math.max(0,y0-1), maxX=Math.min(W-1,x0+w), maxY=Math.min(H-1,y0+h);
  const exterior=new Set(), q=[];
  const push=(x,y)=>{if(x<minX||x>maxX||y<minY||y>maxY)return;const p=y*W+x;if(borderSet.has(p)||exterior.has(p))return;exterior.add(p);q.push([x,y]);};
  for(let x=minX;x<=maxX;x++){push(x,minY);push(x,maxY)}
  for(let y=minY;y<=maxY;y++){push(minX,y);push(maxX,y)}
  for(let i=0;i<q.length;i++){const [x,y]=q[i];push(x-1,y);push(x+1,y);push(x,y-1);push(x,y+1)}
  const fp=[];
  for(let y=y0;y<y0+h;y++)for(let x=x0;x<x0+w;x++){const p=y*W+x;if(borderSet.has(p)||!exterior.has(p))fp.push(p)}
  return fp;
}

const N8=[[-1,-1],[0,-1],[1,-1],[-1,0],[1,0],[-1,1],[0,1],[1,1]];
function adjacentRoles(p, W, H, roleSets) {
  const x=p%W,y=Math.floor(p/W), roles=new Set();
  for (const [role,set] of roleSets) {
    if(set.has(p)){roles.add(role);continue}
    for(const [dx,dy] of N8){const xx=x+dx,yy=y+dy;if(xx>=0&&xx<W&&yy>=0&&yy<H&&set.has(yy*W+xx)){roles.add(role);break}}
  }
  return [...roles].sort();
}
function pairName(roles){
  const wanted=[['plate','digit'],['plate','border'],['digit','loop']];
  for(const [a,b] of wanted) if(roles.includes(a)&&roles.includes(b)) return `${a}<->${b}`;
  if(roles.length>=2) return roles.join('<->');
  return roles[0] ? `single:${roles[0]}` : 'none';
}
function rgbClass(r,g,b){
  const v=Math.max(r,g,b), s=opencvSaturation(r,g,b);
  if(v<=45)return 'black-core';
  if(v>=210&&s<=45)return 'white-core';
  if(s<=45)return 'neutral-transition';
  return 'chromatic-transition';
}
function imageFiles(dir){
  return readdirSync(dir).filter(n=>['.jpg','.jpeg','.png'].includes(extname(n).toLowerCase())).map(n=>join(dir,n));
}

const courses=[];
for(const name of readdirSync(corpusRoot).sort()){
  if(name==='Annotated')continue;
  const dir=join(corpusRoot,name); if(!statSync(dir).isDirectory())continue;
  const files=imageFiles(dir); if(!files.length)continue;
  const input=files.find(f=>basename(f).toLowerCase().includes('-full.')) ?? files[0];
  const warm=await executeNodeCanonicalInputTick(resolve(input));
  const stage=createStage(yaml); const results=stage.run({pxc:warm.pxc});
  const ok=results.find(r=>r.status==='completed'&&r.run);
  if(!ok) throw new Error(`${name}: stage failed: ${JSON.stringify(results.map(r=>({variant:r.variant,status:r.status,error:r.error})))}`);
  let candidates;
  for(const tick of ok.run.ticks??[]) for(const calc of tick.calculations??[]) if(calc.output?.candidates) candidates=calc.output.candidates;
  if(!candidates){
    const seen=new Set(); const walk=v=>{if(!v||typeof v!=='object'||seen.has(v))return;seen.add(v);if(Array.isArray(v.candidates)&&v.candidates[0]?.border)candidates=v.candidates;for(const x of Object.values(v))walk(x)};walk(ok.run);
  }
  if(!candidates) throw new Error(`${name}: badgeCandidates not found in run output`);
  const rgba=warm.croppedImage.rgba, W=warm.croppedImage.widthPx, H=warm.croppedImage.heightPx;
  const candidateUnion=new Set(), footprintUnion=new Set(), residualUnion=new Set(), outerHaloUnion=new Set();
  const transitionClasses={}, rgbClasses={};
  const perCandidate=[];
  for(const c of candidates){
    const owned=new Set(c.pixels), fp=footprint(c.border.part), roles=roleParts(c), roleSets=roles.map(([role,part])=>[role,new Set(part.pixels)]);
    for(const p of owned)candidateUnion.add(p); for(const p of fp)footprintUnion.add(p);
    const residual=fp.filter(p=>!owned.has(p)); for(const p of residual)residualUnion.add(p);
    const localTransitions={};
    for(const p of residual){
      const k=pairName(adjacentRoles(p,W,H,roleSets)); localTransitions[k]=(localTransitions[k]??0)+1; transitionClasses[k]=(transitionClasses[k]??0)+1;
      const i=p*4, cls=rgbClass(rgba[i],rgba[i+1],rgba[i+2]); rgbClasses[cls]=(rgbClasses[cls]??0)+1;
    }
    const borderSet=new Set(c.border.part.pixels), fpSet=new Set(fp);
    for(const bp of borderSet){const x=bp%W,y=Math.floor(bp/W);for(const [dx,dy] of N8){const xx=x+dx,yy=y+dy;if(xx<0||xx>=W||yy<0||yy>=H)continue;const p=yy*W+xx;if(fpSet.has(p)||owned.has(p))continue;outerHaloUnion.add(p)}}
    perCandidate.push({id:c.id,ownedPx:owned.size,footprintPx:fp.length,residualPx:residual.length,coveragePct:100*owned.size/fp.length,transitionClasses:localTransitions});
  }
  const haloRgb={}; for(const p of outerHaloUnion){const i=p*4,cls=rgbClass(rgba[i],rgba[i+1],rgba[i+2]);haloRgb[cls]=(haloRgb[cls]??0)+1}
  courses.push({course:name,input:basename(input),widthPx:W,heightPx:H,candidateCount:candidates.length,ownedPx:candidateUnion.size,footprintPx:footprintUnion.size,residualPx:residualUnion.size,coveragePct:100*candidateUnion.size/footprintUnion.size,transitionClasses,rgbClasses,outerHaloPx:outerHaloUnion.size,outerHaloRgb:haloRgb,perCandidate});
}

const total={courses:courses.length,candidates:courses.reduce((s,c)=>s+c.candidateCount,0),ownedPx:courses.reduce((s,c)=>s+c.ownedPx,0),footprintPx:courses.reduce((s,c)=>s+c.footprintPx,0),residualPx:courses.reduce((s,c)=>s+c.residualPx,0),outerHaloPx:courses.reduce((s,c)=>s+c.outerHaloPx,0)};
total.coveragePct=100*total.ownedPx/total.footprintPx;
for(const key of ['transitionClasses','rgbClasses','outerHaloRgb']) total[key]={};
for(const c of courses) for(const key of ['transitionClasses','rgbClasses','outerHaloRgb']) for(const [k,v] of Object.entries(c[key])) total[key][k]=(total[key][k]??0)+v;
const report={generatedAt:new Date().toISOString(),definition:'detector-derived border footprint; not annotated recall',thresholds:{black:'V<=45',white:'V>=210 && OpenCV S<=45'},courses,total};
writeFileSync(join(outDir,'dev-set-report.json'),JSON.stringify(report,null,2));
const rows=courses.map(c=>`| ${c.course} | ${c.candidateCount} | ${c.ownedPx} | ${c.footprintPx} | ${c.residualPx} | ${c.coveragePct.toFixed(3)}% | ${c.outerHaloPx} |`).join('\n');
const md=`# S1 badge-pixel dev-set probe\n\nDetector-derived footprint completeness; **not annotation recall**.\n\n| Course | candidates | owned | footprint | residual | coverage | outer 1px halo |\n|---|---:|---:|---:|---:|---:|---:|\n${rows}\n\n## Aggregate\n\n- courses: ${total.courses}\n- candidates: ${total.candidates}\n- owned / footprint: ${total.ownedPx} / ${total.footprintPx}\n- coverage: ${total.coveragePct.toFixed(5)}%\n- residual: ${total.residualPx}\n- residual RGB classes: ${JSON.stringify(total.rgbClasses)}\n- residual adjacency classes: ${JSON.stringify(total.transitionClasses)}\n- outer halo: ${total.outerHaloPx}\n- outer halo RGB classes: ${JSON.stringify(total.outerHaloRgb)}\n\nSee \`dev-set-report.json\` for per-candidate detail.\n`;
writeFileSync(join(outDir,'DEV-SET-SUMMARY.md'),md);
console.log(md);
