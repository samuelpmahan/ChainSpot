import {pxFn,type PxC} from '../../../../exec/board';
import {createPqlStage} from '../../../../exec/stage';
import {Comparator,type ComparisonInput} from '../../../../exec/comparator';
import {normalizeDigitMask} from '../../../../detectors/threeFactor/digits/normalize';
import {DEFAULT_DIGITS_KNOBS} from '../../../../detectors/threeFactor/digits/segment';
interface Sample {id:string;pixels:number[];widthPx:number}
interface Label {value:string;source:string;captureId:string}
interface Glyph {id:string;label:string;source:string;captureId:string;mask:Uint8Array;points:number[];width:number;height:number}
interface Query extends Glyph {condition:string;origin:string}
export function normalize({samples,labels,width,height}:{samples:Sample[];labels:Record<string,Label>;width:number;height:number}):Glyph[]{
 return samples.map(s=>{
  if(!s.pixels.length||!labels[s.id])throw Error(`Missing pixels or label for ${s.id}`);
  const xs=s.pixels.map(p=>p%s.widthPx),ys=s.pixels.map(p=>Math.floor(p/s.widthPx));
  const x=Math.min(...xs),y=Math.min(...ys),w=Math.max(...xs)-x+1,h=Math.max(...ys)-y+1;
  const raw=new Uint8Array(w*h);for(const p of s.pixels)raw[(Math.floor(p/s.widthPx)-y)*w+p%s.widthPx-x]=1;
  // One-pixel padding makes the declared +/-1 alignment probes lossless translations.
  if(width<3||height<3)throw Error('Canvas must leave room for alignment padding');
  const inner=normalizeDigitMask(raw,w,h,{...DEFAULT_DIGITS_KNOBS,digitW:width-2,digitH:height-2});
  const mask=new Uint8Array(width*height);
  for(let iy=0;iy<height-2;iy++)for(let ix=0;ix<width-2;ix++)mask[(iy+1)*width+ix+1]=inner[iy*(width-2)+ix];
  return {id:s.id,label:labels[s.id].value,source:labels[s.id].source,captureId:labels[s.id].captureId,mask,points:Array.from(mask).flatMap((v,i)=>v?[i]:[]),width,height};
 });
}
/** Templates never include the generated queries. Self matches are reported separately. */
export function queries({templates}:{templates:Glyph[]}):Query[]{
 return templates.flatMap(t=>['self','shift-right','shift-down','drop-10pct','add-10pct','drop-25pct'].map(condition=>{
  const mask=new Uint8Array(t.mask.length);let state=0x12345678;const random=()=>{state^=state<<13;state^=state>>>17;state^=state<<5;return (state>>>0)/4294967296;};
  t.points.forEach(p=>{let dest=p;
   if(condition==='shift-right'){if(p%t.width===t.width-1)return;dest++;}
   if(condition==='shift-down'){if(Math.floor(p/t.width)===t.height-1)return;dest+=t.width;}
   if(condition.startsWith('drop')&&random()<(condition==='drop-25pct'?.25:.1))return;
   mask[dest]=1;
  });
  if(condition==='add-10pct'){
   const zeros=Array.from(mask).flatMap((v,i)=>v?[]:[i]);
   for(let i=0;i<Math.min(zeros.length,Math.ceil(t.points.length*.1));i++){
    const j=i+Math.floor(random()*(zeros.length-i));[zeros[i],zeros[j]]=[zeros[j],zeros[i]];mask[zeros[i]]=1;
   }
  }
  return {...t,id:`${t.id}:${condition}`,origin:t.id,condition,mask,points:Array.from(mask).flatMap((v,i)=>v?[i]:[])};
 }));
}
function distanceMap(g:Glyph){
 const out=new Float64Array(g.mask.length);out.fill(Infinity);
 for(const p of g.points)out[p]=0;
 // Exact Manhattan distance transform, two passes.
 for(let p=0;p<out.length;p++){if(p%g.width)out[p]=Math.min(out[p],out[p-1]+1);if(p>=g.width)out[p]=Math.min(out[p],out[p-g.width]+1);}
 for(let p=out.length-1;p>=0;p--){if(p%g.width<g.width-1)out[p]=Math.min(out[p],out[p+1]+1);if(p+g.width<out.length)out[p]=Math.min(out[p],out[p+g.width]+1);}
 return out;
}
export function match({templates,queries,metric}:{templates:Glyph[];queries:Query[];metric:'dice'|'chamfer'}){
 if(metric!=='dice'&&metric!=='chamfer')throw Error('Unknown template metric');
 const start=performance.now();const maps=metric==='chamfer'?templates.map(distanceMap):[];const preparationMs=performance.now()-start;
 const readings=queries.map(q=>{
  const begin=performance.now(),qm=metric==='chamfer'?distanceMap(q):undefined;
  const ranking=templates.map((t,i)=>{
   if(t.width!==q.width||t.height!==q.height)throw Error('Template canvas mismatch');
   let score:number;
   if(metric==='dice'){const intersection=q.points.reduce((s,p)=>s+t.mask[p],0);score=2*intersection/(q.points.length+t.points.length||1);}
   else {const distance=(q.points.reduce((s,p)=>s+maps[i][p],0)/(q.points.length||1)+t.points.reduce((s,p)=>s+qm![p],0)/(t.points.length||1))/2;score=-distance;}
   return {label:t.label,template:t.id,score};
  }).sort((a,b)=>b.score-a.score||a.label.localeCompare(b.label));
  return {id:q.id,origin:q.origin,condition:q.condition,expected:q.label,label:ranking[0]?.label??null,
   gap:ranking.length>1?ranking[0].score-ranking[1].score:null,ranking,matchingMs:performance.now()-begin};
 });
 return {metric,preparationMs,readings,evaluation:'synthetic sensitivity against source templates; self matches are plumbing only; no independent-capture accuracy'};
}
export class TemplateComparator extends Comparator {
 readonly id='number-template-robustness';
 compare({baseline,feature}:ComparisonInput){
  const read=(r:ComparisonInput['baseline'])=>r.pxc.get('px.s1.templates.readings') as ReturnType<typeof match>;
  if(baseline.status!=='completed'||feature.status!=='completed')return {baseline:baseline.status,feature:feature.status};
  const a=read(baseline),b=read(feature);
  const summarize=(r:typeof a)=>Object.fromEntries([...new Set(r.readings.map(x=>x.condition))].map(c=>{const rows=r.readings.filter(x=>x.condition===c);return [c,{matched:rows.filter(x=>x.label===x.expected).length,total:rows.length,matchingMs:rows.reduce((s,x)=>s+x.matchingMs,0)}];}));
  return {expectation:'Prefer retained labels under perturbation; report cost and disagreements without promoting a winner',baseline:summarize(a),feature:summarize(b),disagreements:a.readings.flatMap((r,i)=>r.label===b.readings[i].label?[]:[{id:r.id,expected:r.expected,dice:r.label,chamfer:b.readings[i].label}])};
 }
}
export function createStage(yaml:string){
 const stage=createPqlStage(yaml,pxc=>{
  pxc.register(pxFn<Parameters<typeof normalize>[0],ReturnType<typeof normalize>>('fn.s1.templates.normalize'),normalize);
  pxc.register(pxFn<Parameters<typeof queries>[0],ReturnType<typeof queries>>('fn.s1.templates.queries'),queries);
  pxc.register(pxFn<Parameters<typeof match>[0],ReturnType<typeof match>>('fn.s1.templates.match'),match);
 });
 stage.register({id:'symmetric-chamfer',overrides:{'fn.s1.templates.match':{call:'fn.s1.templates.match',args:{metric:'chamfer'}}},comparator:new TemplateComparator()});return stage;
}
