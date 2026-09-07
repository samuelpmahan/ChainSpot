import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { PNG } from 'pngjs';
import { executeNodeCanonicalInputTick } from '../packages/alg/dist/exec/node-intake.js';
import { createPxCRootMounts } from '../packages/alg/dist/exec/mounts.js';
import { createStage } from '../packages/alg/dist/stages/S1/exp/badge-assembly/stage.js';
import { S0_CROPPED_IMAGE_ADDRESS } from '../packages/alg/dist/stages/S0/clean/index.js';
import { classifyBadgeAgainstTemplates } from '../packages/alg/dist/detectors/threeFactor/features/g1.badgeGlyphTemplate.js';

const [corpusRoot='chainspot-corpus/dev', outPng='/tmp/same-number-badge-overlaps.png', outJson='/tmp/same-number-badge-overlaps.json'] = process.argv.slice(2);
const TARGET_MS=40_000, HARD_MS=55_000, started=performance.now();
const watchdog=setTimeout(()=>{ console.error(`HARD WATCHDOG: projection exceeded ${HARD_MS}ms`); process.exit(124); },HARD_MS);
const yaml=readFileSync(resolve('packages/alg/dist/stages/S1/exp/badge-assembly/PrincipleComponentRender.yaml'),'utf8');
const roots=createPxCRootMounts();
const labels=new Map();
const candidatesByRoot=new Map();

function fullImageIn(dir){ const f=readdirSync(dir).filter(n=>/\.(png|jpe?g)$/i.test(n)).sort(); return f.find(n=>/-full\./i.test(n))??f[0]; }
function findCandidates(run){
 let found;
 const seen=new Set();
 const walk=v=>{ if(!v||typeof v!=='object'||seen.has(v))return; seen.add(v); if(Array.isArray(v.candidates)&&v.candidates[0]?.border) found=v.candidates; for(const x of Object.values(v)) walk(x); };
 walk(run); return found;
}
function bboxOf(candidate){
 const b=candidate.border.bbox; return {x:b[0],y:b[1],w:b[2],h:b[3],cx:b[0]+b[2]/2,cy:b[1]+b[3]/2};
}
function fakeBadge(candidate,index){ const b=candidate.border.bbox; return {detId:`projection:${index}`,component:{},cxPx:b[0]+b[2]/2,cyPx:b[1]+b[3]/2,bbox:[...b],source:'projection',digits:[],rawLabel:'',digitCount:0,label:null,bestLabel:null,labelCandidates:[],confidence:Infinity,abstentionReason:null,confidenceFloor:0,conflictWith:[],notes:[]}; }

for(const course of readdirSync(corpusRoot).sort()){
 if(course==='Annotated')continue; const dir=join(corpusRoot,course); if(!statSync(dir).isDirectory())continue;
 const file=fullImageIn(dir); if(!file)continue;
 const s0=await executeNodeCanonicalInputTick(resolve(dir,file));
 const result=createStage(yaml).run({pxc:s0.pxc}).find(r=>r.kind==='default'&&r.status==='completed');
 if(!result?.run) throw new Error(`${course}: Default S1 did not complete.`);
 const candidates=findCandidates(result.run); if(!candidates) throw new Error(`${course}: assembled candidates not found.`);
 const root=s0.fullImage.imageId; roots.mount(root,result.pxc); labels.set(root,course); candidatesByRoot.set(root,candidates);
}

const groups=new Map(Array.from({length:18},(_,i)=>[String(i+1),[]]));
const grouping=[];
for(const [root,pxc] of roots.entries()){
 const course=labels.get(root); const image=pxc.get(S0_CROPPED_IMAGE_ADDRESS); const candidates=candidatesByRoot.get(root);
 for(const [index,candidate] of candidates.entries()){
  const verdict=classifyBadgeAgainstTemplates({width:image.widthPx,height:image.heightPx,data:image.rgba},fakeBadge(candidate,index),0);
  const label=verdict.templateLabel??verdict.templateBestLabel;
  grouping.push({course,root,candidateId:candidate.id,label,accepted:verdict.templateLabel!==null,score:verdict.templateScore,margin:verdict.templateMargin,bbox:candidate.border.bbox});
  if(label&&groups.has(label)) groups.get(label).push({course,root,candidate,image,bbox:bboxOf(candidate),accepted:verdict.templateLabel!==null,score:verdict.templateScore});
 }
}

const PAD=10, TILE_W=94, TILE_H=76, COLS=6, ROWS=3, HEADER=18;
const sheet=new PNG({width:COLS*TILE_W,height:ROWS*(TILE_H+HEADER)}); sheet.data.fill(255);
function setPixel(x,y,r,g,b,a=255){ if(x<0||y<0||x>=sheet.width||y>=sheet.height)return; const o=(y*sheet.width+x)*4; sheet.data[o]=r;sheet.data[o+1]=g;sheet.data[o+2]=b;sheet.data[o+3]=a; }
// tiny 3x5 numeric font, projection annotation only
const FONT={0:['111','101','101','101','111'],1:['010','110','010','010','111'],2:['111','001','111','100','111'],3:['111','001','111','001','111'],4:['101','101','111','001','001'],5:['111','100','111','001','111'],6:['111','100','111','101','111'],7:['111','001','010','010','010'],8:['111','101','111','101','111'],9:['111','101','111','001','111']};
function textNumber(value,x,y){ let dx=0; for(const ch of String(value)){ const rows=FONT[ch]; for(let yy=0;yy<5;yy++)for(let xx=0;xx<3;xx++)if(rows[yy][xx]==='1')for(let sy=0;sy<2;sy++)for(let sx=0;sx<2;sx++)setPixel(x+dx+xx*2+sx,y+yy*2+sy,0,0,0); dx+=8; } }

const summary=[];
for(let n=1;n<=18;n++){
 const items=groups.get(String(n)); const col=(n-1)%COLS,row=Math.floor((n-1)/COLS); const ox=col*TILE_W,oy=row*(TILE_H+HEADER); textNumber(n,ox+4,oy+4);
 const anchorX=ox+Math.floor(TILE_W/2),anchorY=oy+HEADER+Math.floor(TILE_H/2); const accum=new Float64Array(TILE_W*TILE_H*4),counts=new Uint16Array(TILE_W*TILE_H);
 for(const item of items){
  const {image,bbox}=item; const x0=Math.max(0,Math.floor(bbox.x-PAD)), y0=Math.max(0,Math.floor(bbox.y-PAD)); const x1=Math.min(image.widthPx,Math.ceil(bbox.x+bbox.w+PAD)), y1=Math.min(image.heightPx,Math.ceil(bbox.y+bbox.h+PAD));
  for(let sy=y0;sy<y1;sy++)for(let sx=x0;sx<x1;sx++){
   const dx=Math.round(anchorX+(sx-bbox.cx)),dy=Math.round(anchorY+(sy-bbox.cy)); if(dx<ox||dx>=ox+TILE_W||dy<oy+HEADER||dy>=oy+HEADER+TILE_H)continue;
   const src=(sy*image.widthPx+sx)*4, local=(dy-(oy+HEADER))*TILE_W+(dx-ox), ao=local*4;
   accum[ao]+=image.rgba[src];accum[ao+1]+=image.rgba[src+1];accum[ao+2]+=image.rgba[src+2];accum[ao+3]+=image.rgba[src+3];counts[local]++;
  }
 }
 for(let y=0;y<TILE_H;y++)for(let x=0;x<TILE_W;x++){ const i=y*TILE_W+x,c=counts[i]; if(!c)continue; const a=i*4; setPixel(ox+x,oy+HEADER+y,Math.round(accum[a]/c),Math.round(accum[a+1]/c),Math.round(accum[a+2]/c),255); }
 summary.push({number:n,count:items.length,courses:items.map(i=>i.course),allSix:items.length===6,acceptedCount:items.filter(i=>i.accepted).length});
}

writeFileSync(outPng,PNG.sync.write(sheet));
const elapsedMs=performance.now()-started; clearTimeout(watchdog);
const report={rootSemantics:'<ImgID>/{px.*,fn.*}',addressMutation:false,joinKey:'projection-only legacy whole-glyph template read',projectionPixels:'current S1 assembled-border-centered crops +10px source context',mountedRoots:roots.roots().length,targetMs:TARGET_MS,hardMs:HARD_MS,elapsedMs,withinTarget:elapsedMs<=TARGET_MS,summary,grouping};
writeFileSync(outJson,JSON.stringify(report,null,2)); console.log(JSON.stringify(report,null,2)); if(elapsedMs>TARGET_MS)console.warn(`TARGET MISS: ${elapsedMs.toFixed(1)}ms`);
