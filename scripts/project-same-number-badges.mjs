import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PNG } from 'pngjs';
import { executeNodeCanonicalInputTick } from '../packages/alg/dist/exec/node-intake.js';
import { createPxCRootMounts } from '../packages/alg/dist/exec/mounts.js';
import { createStage } from '../packages/alg/dist/stages/S1/exp/badge-assembly/stage.js';
import { S0_CROPPED_IMAGE_ADDRESS } from '../packages/alg/dist/stages/S0/clean/index.js';
import { runThreeFactor } from '../packages/alg/dist/detectors/threeFactor/index.js';

const [corpusRoot='chainspot-corpus/dev', outPng='/tmp/same-number-badge-overlaps.png', outJson='/tmp/same-number-badge-overlaps.json'] = process.argv.slice(2);
const TARGET_MS=40_000,HARD_MS=55_000,started=performance.now();
const watchdog=setTimeout(()=>{console.error(`HARD WATCHDOG: projection exceeded ${HARD_MS}ms`);process.exit(124)},HARD_MS);
const yaml=readFileSync(resolve('packages/alg/dist/stages/S1/exp/badge-assembly/PrincipleComponentRender.yaml'),'utf8');
const roots=createPxCRootMounts(), meta=new Map();
function fullImageIn(dir){const f=readdirSync(dir).filter(n=>/\.(png|jpe?g)$/i.test(n)).sort();return f.find(n=>/-full\./i.test(n))??f[0]}
function findCandidates(run){let found;const seen=new Set();const walk=v=>{if(!v||typeof v!=='object'||seen.has(v))return;seen.add(v);if(Array.isArray(v.candidates)&&v.candidates[0]?.border)found=v.candidates;for(const x of Object.values(v))walk(x)};walk(run);return found}
function bboxOf(c){const b=c.border.bbox;return{x:b[0],y:b[1],w:b[2],h:b[3],cx:b[0]+b[2]/2,cy:b[1]+b[3]/2}}
for(const course of readdirSync(corpusRoot).sort()){
 if(course==='Annotated')continue;const dir=join(corpusRoot,course);if(!statSync(dir).isDirectory())continue;const file=fullImageIn(dir);if(!file)continue;
 const s0=await executeNodeCanonicalInputTick(resolve(dir,file));const result=createStage(yaml).run({pxc:s0.pxc}).find(r=>r.kind==='default'&&r.status==='completed');if(!result?.run)throw new Error(`${course}: Default S1 did not complete.`);
 const candidates=findCandidates(result.run);if(!candidates)throw new Error(`${course}: assembled candidates not found.`);const root=s0.fullImage.imageId;roots.mount(root,result.pxc);meta.set(root,{course,candidates});
}
const groups=new Map(Array.from({length:18},(_,i)=>[String(i+1),[]])), grouping=[];
for(const [root,pxc] of roots.entries()){
 const {course,candidates}=meta.get(root),image=pxc.get(S0_CROPPED_IMAGE_ADDRESS);
 const legacy=runThreeFactor({imageId:image.imageId,widthPx:image.widthPx,heightPx:image.heightPx,rgba:image.rgba});
 const labeled=legacy.measurement.badges.filter(b=>b.label!==null&&Number(b.label)>=1&&Number(b.label)<=18);
 const labels=labeled.map(b=>b.label).sort((a,b)=>Number(a)-Number(b));
 if(labeled.length!==18||new Set(labels).size!==18)throw new Error(`${course}: legacy join reader did not yield labels 1..18 exactly once: ${labels.join(',')}`);
 const unmatched=new Set(candidates.map((_,i)=>i));
 for(const badge of labeled){
  let best=-1,bestD=Infinity;for(const i of unmatched){const bb=bboxOf(candidates[i]);const d=(bb.cx-badge.cxPx)**2+(bb.cy-badge.cyPx)**2;if(d<bestD){bestD=d;best=i}}
  if(best<0)throw new Error(`${course}: no new S1 candidate available for legacy badge ${badge.label}`);unmatched.delete(best);const candidate=candidates[best],bbox=bboxOf(candidate),distancePx=Math.sqrt(bestD);
  if(distancePx>12)throw new Error(`${course}: label ${badge.label} nearest new S1 candidate is ${distancePx.toFixed(2)}px away`);
  const item={course,root,candidate,image,bbox,distancePx};groups.get(String(badge.label)).push(item);grouping.push({course,root,label:badge.label,candidateId:candidate.id,distancePx,bbox:candidate.border.bbox});
 }
}
const PAD=10,TILE_W=94,TILE_H=76,COLS=6,ROWS=3,HEADER=18;const sheet=new PNG({width:COLS*TILE_W,height:ROWS*(TILE_H+HEADER)});sheet.data.fill(255);
function setPixel(x,y,r,g,b,a=255){if(x<0||y<0||x>=sheet.width||y>=sheet.height)return;const o=(y*sheet.width+x)*4;sheet.data[o]=r;sheet.data[o+1]=g;sheet.data[o+2]=b;sheet.data[o+3]=a}
const FONT={0:['111','101','101','101','111'],1:['010','110','010','010','111'],2:['111','001','111','100','111'],3:['111','001','111','001','111'],4:['101','101','111','001','001'],5:['111','100','111','001','111'],6:['111','100','111','101','111'],7:['111','001','010','010','010'],8:['111','101','111','101','111'],9:['111','101','111','001','111']};
function textNumber(v,x,y){let dx=0;for(const ch of String(v)){const rows=FONT[ch];for(let yy=0;yy<5;yy++)for(let xx=0;xx<3;xx++)if(rows[yy][xx]==='1')for(let sy=0;sy<2;sy++)for(let sx=0;sx<2;sx++)setPixel(x+dx+xx*2+sx,y+yy*2+sy,0,0,0);dx+=8}}
const summary=[];
for(let n=1;n<=18;n++){
 const items=groups.get(String(n)),col=(n-1)%COLS,row=Math.floor((n-1)/COLS),ox=col*TILE_W,oy=row*(TILE_H+HEADER);textNumber(n,ox+4,oy+4);const anchorX=ox+Math.floor(TILE_W/2),anchorY=oy+HEADER+Math.floor(TILE_H/2),accum=new Float64Array(TILE_W*TILE_H*4),counts=new Uint16Array(TILE_W*TILE_H);
 for(const {image,bbox} of items){const x0=Math.max(0,Math.floor(bbox.x-PAD)),y0=Math.max(0,Math.floor(bbox.y-PAD)),x1=Math.min(image.widthPx,Math.ceil(bbox.x+bbox.w+PAD)),y1=Math.min(image.heightPx,Math.ceil(bbox.y+bbox.h+PAD));for(let sy=y0;sy<y1;sy++)for(let sx=x0;sx<x1;sx++){const dx=Math.round(anchorX+(sx-bbox.cx)),dy=Math.round(anchorY+(sy-bbox.cy));if(dx<ox||dx>=ox+TILE_W||dy<oy+HEADER||dy>=oy+HEADER+TILE_H)continue;const src=(sy*image.widthPx+sx)*4,local=(dy-(oy+HEADER))*TILE_W+(dx-ox),ao=local*4;accum[ao]+=image.rgba[src];accum[ao+1]+=image.rgba[src+1];accum[ao+2]+=image.rgba[src+2];accum[ao+3]+=image.rgba[src+3];counts[local]++}}
 for(let y=0;y<TILE_H;y++)for(let x=0;x<TILE_W;x++){const i=y*TILE_W+x,c=counts[i];if(!c)continue;const a=i*4;setPixel(ox+x,oy+HEADER+y,Math.round(accum[a]/c),Math.round(accum[a+1]/c),Math.round(accum[a+2]/c),255)}
 summary.push({number:n,count:items.length,courses:items.map(i=>i.course),allSix:items.length===6,maxJoinDistancePx:Math.max(...items.map(i=>i.distancePx))});
}
writeFileSync(outPng,PNG.sync.write(sheet));const elapsedMs=performance.now()-started;clearTimeout(watchdog);const report={rootSemantics:'<ImgID>/{px.*,fn.*}',addressMutation:false,joinKey:'projection-only legacy course reader labels, spatially joined to current S1 candidates',projectionPixels:'current S1 assembled-border-centered crops +10px source context',mountedRoots:roots.roots().length,targetMs:TARGET_MS,hardMs:HARD_MS,elapsedMs,withinTarget:elapsedMs<=TARGET_MS,summary,grouping};writeFileSync(outJson,JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));if(elapsedMs>TARGET_MS)console.warn(`TARGET MISS: ${elapsedMs.toFixed(1)}ms`);
