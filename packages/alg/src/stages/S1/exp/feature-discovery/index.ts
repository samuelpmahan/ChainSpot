import {pxFn, type PxC} from '../../../../exec/board';
import {Comparator, type ComparisonInput} from '../../../../exec/comparator';
import {createPqlStage} from '../../../../exec/stage';

type Box = readonly [number,number,number,number];
type Part = {pixels: ArrayLike<number>; widthPx:number; heightPx:number; coordinateFrameId:string};
type Badge = {id:string; pixels:ArrayLike<number>; border:{bbox:Box;part:Part}};
export interface Sample {
 id:string; widthPx:number; heightPx:number; coordinateFrameId:string;
 bbox:Box; pixels:number[]; excludedCorners:number[];
 points:{x:number;y:number;pixel:number}[];
}
export interface Feature {id:string; value:number; pixels:number[]; regions:Box[]}
export interface FeatureRow {id:string; features:Feature[]}
export interface Label {value:string; source:string; captureId:string}
type Labels = Record<string,Label>;
interface Table {rows:FeatureRow[]; labels:Labels}
const elapsed = <T>(fn:()=>T) => {const start=performance.now();const value=fn();return {value,elapsedMs:performance.now()-start};};

/** Bbox geometry is a reviewable starting assumption, not a topology assertion. */
export function material({badges,insetPx,cornerFraction,canvasWidth,canvasHeight}:{badges:{candidates:Badge[]};insetPx:number;cornerFraction:number;canvasWidth:number;canvasHeight:number}):Sample[] {
 if (!Number.isInteger(insetPx)||insetPx<0||cornerFraction<0||cornerFraction>=0.5||canvasWidth<2||canvasHeight<2) throw new Error('Invalid material geometry');
 return badges.candidates.map(badge=>{
  const [bx,by,bw,bh]=badge.border.bbox;
  const x=bx+insetPx,y=by+insetPx,w=bw-2*insetPx,h=bh-2*insetPx;
  if(w<=0||h<=0) throw new Error(`Empty interior: ${badge.id}`);
  const owned=new Set(Array.from(badge.pixels));
  const pixels:number[]=[],excludedCorners:number[]=[];
  const cw=Math.ceil(w*cornerFraction),ch=Math.ceil(h*cornerFraction);
  const scale=Math.min((canvasWidth-1)/w,(canvasHeight-1)/h);
  const ox=(canvasWidth-w*scale)/2,oy=(canvasHeight-h*scale)/2;
  for(let j=0;j<h;j++) for(let i=0;i<w;i++) {
   const pixel=(y+j)*badge.border.part.widthPx+x+i;
   if(owned.has(pixel)) continue;
   if((i<cw||i>=w-cw)&&(j<ch||j>=h-ch)) excludedCorners.push(pixel);
   else pixels.push(pixel);
  }
  return {id:badge.id,widthPx:badge.border.part.widthPx,heightPx:badge.border.part.heightPx,
   coordinateFrameId:badge.border.part.coordinateFrameId,bbox:[x,y,w,h],pixels,excludedCorners,
   points:pixels.map(pixel=>({pixel,x:ox+(pixel%badge.border.part.widthPx-x+0.5)*scale,
    y:oy+(Math.floor(pixel/badge.border.part.widthPx)-y+0.5)*scale}))};
 });
}

/** Continuous regional statistics; retain memberships so every feature is drawable. */
export function features({samples,labels,columns,rows,canvasWidth,canvasHeight}:{samples:Sample[];labels:Labels;columns:number;rows:number;canvasWidth:number;canvasHeight:number}):Table {
 if(!Number.isInteger(columns)||!Number.isInteger(rows)||columns<1||rows<1) throw new Error('Invalid grid');
 return {labels,rows:samples.map(sample=>{
  const output:Feature[]=[],cells:{points:Sample['points'];box:Box;angle:number;coherence:number}[]=[];
  for(let r=0;r<rows;r++) for(let c=0;c<columns;c++) {
   const box:Box=[c*canvasWidth/columns,r*canvasHeight/rows,canvasWidth/columns,canvasHeight/rows];
   const points=sample.points.filter(p=>p.x>=box[0]&&p.x<box[0]+box[2]&&p.y>=box[1]&&p.y<box[1]+box[3]);
   const n=points.length,mx=points.reduce((s,p)=>s+p.x,0)/(n||1),my=points.reduce((s,p)=>s+p.y,0)/(n||1);
   const xx=points.reduce((s,p)=>s+(p.x-mx)**2,0),yy=points.reduce((s,p)=>s+(p.y-my)**2,0),xy=points.reduce((s,p)=>s+(p.x-mx)*(p.y-my),0);
   const coherence=n<2?0:Math.hypot(xx-yy,2*xy)/(xx+yy||1),angle=.5*Math.atan2(2*xy,xx-yy);
   cells.push({points,box,angle,coherence});
   const add=(name:string,value:number)=>output.push({id:`cell:${r}:${c}:${name}`,value,pixels:points.map(p=>p.pixel),regions:[box]});
   add('occupancy',n/(sample.points.length||1));
   add('direction-x',coherence*Math.cos(2*angle));add('direction-y',coherence*Math.sin(2*angle));add('coherence',coherence);
  }
  for(let i=0;i<cells.length;i++) for(const j of [i%columns<columns-1?i+1:-1,i+columns<cells.length?i+columns:-1]) {
   if(j<0)continue;const a=cells[i],b=cells[j],pixels=[...a.points,...b.points].map(p=>p.pixel),regions=[a.box,b.box];
   output.push({id:`pair:${i}:${j}:contrast`,value:(a.points.length-b.points.length)/(sample.points.length||1),pixels,regions});
   output.push({id:`pair:${i}:${j}:bend`,value:Math.min(a.coherence,b.coherence)*(1-Math.cos(2*(a.angle-b.angle)))/2,pixels,regions});
  }
  for(const axis of ['row','column'] as const) for(let k=0;k<(axis==='row'?rows:columns);k++) {
   const selected=cells.filter((_,i)=>axis==='row'?Math.floor(i/columns)===k:i%columns===k);
   output.push({id:`${axis}:${k}:occupancy`,value:selected.reduce((s,c)=>s+c.points.length,0)/(sample.points.length||1),pixels:selected.flatMap(c=>c.points.map(p=>p.pixel)),regions:selected.map(c=>c.box)});
  }
  return {id:sample.id,features:output};
 })};
}

interface Split {feature:number;threshold:number;gain:number}
type Tree = {counts:Record<string,number>;split?:Split;left?:Tree;right?:Tree};
const counts=(table:Table,indices:number[])=>{const out:Record<string,number>={};for(const i of indices){const label=table.labels[table.rows[i].id]?.value;if(label!==undefined)out[label]=(out[label]||0)+1;}return out;};
const impurity=(c:Record<string,number>)=>{const n=Object.values(c).reduce((a,b)=>a+b,0);return n?1-Object.values(c).reduce((s,v)=>s+(v/n)**2,0):0;};
function bestSplit(table:Table,indices:number[]):Split|undefined {
 let best:Split|undefined;const base=impurity(counts(table,indices));
 for(let f=0;f<(table.rows[0]?.features.length||0);f++) {
  const values=[...new Set(indices.map(i=>table.rows[i].features[f].value))].sort((a,b)=>a-b);
  for(let k=1;k<values.length;k++) {
   const threshold=(values[k-1]+values[k])/2,left=indices.filter(i=>table.rows[i].features[f].value<=threshold),right=indices.filter(i=>table.rows[i].features[f].value>threshold);
   const gain=base-(left.length*impurity(counts(table,left))+right.length*impurity(counts(table,right)))/indices.length;
   if(gain>0&&(!best||gain>best.gain))best={feature:f,threshold,gain};
  }
 }return best;
}
function grow(table:Table,indices:number[],depth:number):Tree {
 const node:Tree={counts:counts(table,indices)},split=depth>0?bestSplit(table,indices):undefined;
 if(split){node.split=split;node.left=grow(table,indices.filter(i=>table.rows[i].features[split.feature].value<=split.threshold),depth-1);node.right=grow(table,indices.filter(i=>table.rows[i].features[split.feature].value>split.threshold),depth-1);}return node;
}
const winner=(c:Record<string,number>)=>Object.entries(c).sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]))[0]?.[0]??null;
function predict(tree:Tree,row:FeatureRow){const trace:Split[]=[];let node=tree;while(node.split){trace.push(node.split);node=row.features[node.split.feature].value<=node.split.threshold?node.left!:node.right!;}return {label:winner(node.counts),trace,counts:node.counts};}

/** Multiclass SAMME with one-threshold, two-leaf weak learners. Training only. */
function boost(table:Table,indices:number[],rounds:number) {
 const classes=[...new Set(indices.map(i=>table.labels[table.rows[i].id].value))];
 const learners:{feature:number;threshold:number;left:string;right:string;weight:number}[]=[];
 let weights=indices.map(()=>1/(indices.length||1));
 if(classes.length<2)return learners;
 for(let round=0;round<rounds;round++) {
  let best:{feature:number;threshold:number;left:string;right:string;error:number}|undefined;
  for(let f=0;f<(table.rows[0]?.features.length||0);f++) {
   const values=[...new Set(indices.map(i=>table.rows[i].features[f].value))].sort((a,b)=>a-b);
   for(let k=1;k<values.length;k++) {
    const threshold=(values[k-1]+values[k])/2,l:Record<string,number>={},r:Record<string,number>={};
    indices.forEach((i,j)=>{const c=table.rows[i].features[f].value<=threshold?l:r,label=table.labels[table.rows[i].id].value;c[label]=(c[label]||0)+weights[j];});
    const left=winner(l)!,right=winner(r)!;
    const error=indices.reduce((s,i,j)=>s+((table.rows[i].features[f].value<=threshold?left:right)===table.labels[table.rows[i].id].value?0:weights[j]),0);
    if(!best||error<best.error)best={feature:f,threshold,left,right,error};
   }
  }
  if(!best||best.error>=1-1/classes.length)break;
  const weight=Math.log((1-Math.max(best.error,1e-12))/Math.max(best.error,1e-12))+Math.log(classes.length-1);
  learners.push({...best,weight});if(best.error===0)break;
  weights=weights.map((w,j)=>w*Math.exp((table.rows[indices[j]].features[best!.feature].value<=best!.threshold?best!.left:best!.right)===table.labels[table.rows[indices[j]].id].value?0:weight));
  const total=weights.reduce((a,b)=>a+b,0);weights=weights.map(w=>w/total);
 }return learners;
}

/** Tokens use each feature's observed median; absence is explicit through the low token. */
export function mine({table,minSupport,buckets,maxTriples}:{table:Table;minSupport:number;buckets:number;maxTriples:number}) {
 if(minSupport<1||!Number.isInteger(buckets)||buckets<1||maxTriples<0)throw new Error('Invalid mining arguments');
 const thresholds=(table.rows[0]?.features||[]).map((_,f)=>{const v=table.rows.map(r=>r.features[f].value).sort((a,b)=>a-b);return v[Math.floor(v.length/2)];});
 const transactions=table.rows.map(r=>r.features.map((f,i)=>2*i+(f.value>thresholds[i]?1:0)));
 const single=new Map<number,number>();transactions.forEach(t=>t.forEach(v=>single.set(v,(single.get(v)||0)+1)));
 const hash=(a:number,b:number)=>(Math.imul(a+1,73856093)^Math.imul(b+1,19349663))>>>0;
 const key=(a:number,b:number)=>`${a},${b}`;
 const countPairs=(pcy:boolean)=>{
  const bins=new Uint32Array(buckets),pairs=new Map<string,number>();
  if(pcy)for(const t of transactions)for(let i=0;i<t.length;i++)for(let j=i+1;j<t.length;j++)bins[hash(t[i],t[j])%buckets]++;
  for(const t of transactions)for(let i=0;i<t.length;i++)for(let j=i+1;j<t.length;j++) {
   const a=t[i],b=t[j];if((single.get(a)||0)<minSupport||(single.get(b)||0)<minSupport||(pcy&&bins[hash(a,b)%buckets]<minSupport))continue;
   const k=key(a,b);pairs.set(k,(pairs.get(k)||0)+1);
  }return [...pairs].filter(([,n])=>n>=minSupport).sort((a,b)=>a[0].localeCompare(b[0]));
 };
 const direct=elapsed(()=>countPairs(false)),pcy=elapsed(()=>countPairs(true));
 const pairs=direct.value.map(([k,support])=>({items:k.split(',').map(Number),support}));
 const frequent=new Set(direct.value.map(([k])=>k));
 const triples:{items:number[];support:number}[]=[];let attempted=0,truncated=false;
 const items=[...single.keys()].filter(i=>single.get(i)!>=minSupport).sort((a,b)=>a-b);
 outer:for(let a=0;a<items.length;a++)for(let b=a+1;b<items.length;b++)for(let c=b+1;c<items.length;c++) {
  const triple=[items[a],items[b],items[c]];
  if(!frequent.has(key(triple[0],triple[1]))||!frequent.has(key(triple[0],triple[2]))||!frequent.has(key(triple[1],triple[2])))continue;
  if(attempted>=maxTriples){truncated=true;break outer;}attempted++;
  const support=transactions.filter(t=>triple.every(i=>t.includes(i))).length;if(support>=minSupport)triples.push({items:triple,support});
 }
 const combinations=[...pairs,...triples].map(combination=>({...combination,labels:counts(table,transactions.flatMap((t,i)=>combination.items.every(item=>t.includes(item))?[i]:[]))}));
 return {thresholds,tokenMeaning:'2*featureIndex + (value > median ? 1 : 0)',combinations,directMs:direct.elapsedMs,pcyMs:pcy.elapsedMs,
  pcyEqualsDirect:JSON.stringify(direct.value)===JSON.stringify(pcy.value),tripleCandidatesAttempted:attempted,triplesTruncated:truncated};
}
export function model({table,maxDepth,rounds,method}:{table:Table;maxDepth:number;rounds:number;method:'tree'|'boost'}) {
 if(method!=='tree'&&method!=='boost')throw new Error('Unknown discovery model');
 const indices=table.rows.flatMap((r,i)=>table.labels[r.id]?[i]:[]);
 const fit=elapsed(()=>method==='tree'?grow(table,indices,maxDepth):boost(table,indices,rounds));
 const tree=method==='tree'?fit.value as Tree:undefined,learners=method==='boost'?fit.value as ReturnType<typeof boost>:undefined;
 const predictions=table.rows.map(row=>{
  if(tree)return {id:row.id,...predict(tree,row)};
  const scores:Record<string,number>={};const trace=(learners||[]).map(l=>{const label=row.features[l.feature].value<=l.threshold?l.left:l.right;scores[label]=(scores[label]||0)+l.weight;return {...l,value:row.features[l.feature].value,label};});
  return {id:row.id,label:winner(scores),scores,trace};
 });
 return {method,trainingMs:fit.elapsedMs,trainingIds:indices.map(i=>table.rows[i].id),labels:table.labels,model:fit.value,predictions,
  evaluation:'training-fit only; no acceptance or generalization claim',featureIds:table.rows[0]?.features.map(f=>f.id)||[]};
}
export class DiscoveryComparator extends Comparator {
 readonly id='feature-discovery-differences';
 compare({baseline,feature}:ComparisonInput) {
  const read=(r:ComparisonInput['baseline'])=>r.pxc.has('px.s1.discovery.model')?r.pxc.get('px.s1.discovery.model') as ReturnType<typeof model>:undefined;
  const a=read(baseline),b=read(feature);
  return {baselineStatus:baseline.status,featureStatus:feature.status,baselineMs:baseline.executionMs,featureMs:feature.executionMs,
   disagreements:a&&b?a.predictions.flatMap(p=>{const other=b.predictions.find(q=>q.id===p.id);return other?.label===p.label?[]:[{id:p.id,baseline:p.label,feature:other?.label??null}];}):null,
   expectation:'Compare training predictions and cost; neither method is promoted or accepted automatically.'};
 }
}
export function prepare(pxc:PxC) {
 pxc.register(pxFn<Parameters<typeof sensitivity>[0],ReturnType<typeof sensitivity>>('fn.s1.discovery.sensitivity'),sensitivity);
 pxc.register(pxFn<Parameters<typeof material>[0],ReturnType<typeof material>>('fn.s1.discovery.material'),material);
 pxc.register(pxFn<Parameters<typeof features>[0],ReturnType<typeof features>>('fn.s1.discovery.features'),features);
 pxc.register(pxFn<Parameters<typeof mine>[0],ReturnType<typeof mine>>('fn.s1.discovery.mine'),mine);
 pxc.register(pxFn<Parameters<typeof model>[0],ReturnType<typeof model>>('fn.s1.discovery.model'),model);
}
export function createStage(yaml:string) {
 const stage=createPqlStage(yaml,prepare);
 stage.register({id:'boosted-stumps',overrides:{'fn.s1.discovery.model':{call:'fn.s1.discovery.model',args:{method:'boost'}}},comparator:new DiscoveryComparator()});
 return stage;
}

/** Deterministic sensitivity probes, never independent training examples. */
export function sensitivity({samples,table,columns,rows,canvasWidth,canvasHeight}:{samples:Sample[];table:Table;columns:number;rows:number;canvasWidth:number;canvasHeight:number}) {
 const variants=['shift-x','shift-y','drop-every-tenth','add-neighbor-every-tenth'] as const;
 return variants.map(variant=>{
  const changed=samples.map(s=>({...s,points:variant==='shift-x'?s.points.map(p=>({...p,x:p.x+1})):variant==='shift-y'?s.points.map(p=>({...p,y:p.y+1})):variant==='drop-every-tenth'?s.points.filter((_,i)=>i%10!==0):[...s.points,...s.points.filter((_,i)=>i%10===0).map(p=>({...p,x:p.x+1}))]}));
  const measured=features({samples:changed,labels:table.labels,columns,rows,canvasWidth,canvasHeight});
  return {variant,synthetic:true,units:'normalized canvas coordinates',rows:measured.rows.map((r,i)=>({id:r.id,captureId:table.labels[r.id]?.captureId,
   changes:r.features.map((f,j)=>({feature:f.id,before:table.rows[i].features[j].value,after:f.value,delta:f.value-table.rows[i].features[j].value}))}))};
 });
}
