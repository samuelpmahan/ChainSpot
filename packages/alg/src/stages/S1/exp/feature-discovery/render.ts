import type {Sample, FeatureRow} from './index';
const escape=(value:string)=>value.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
/** Exact original pixel memberships, zoomed by SVG viewBox. No calculations rerun. */
export function renderFeatureCheckpoint(samples:Sample[],rows:FeatureRow[],selected:Record<string,string[]>={}):string {
 const cards=samples.map(sample=>{
  const row=rows.find(r=>r.id===sample.id),chosen=row?.features.filter(f=>(selected[sample.id]||[]).includes(f.id))||[];
  const [x,y,w,h]=sample.bbox;
  const pixels=(members:number[],color:string)=>members.map(p=>`<rect x="${p%sample.widthPx}" y="${Math.floor(p/sample.widthPx)}" width="1" height="1" fill="${color}"/>`).join('');
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x-1} ${y-1} ${w+2} ${h+2}" shape-rendering="crispEdges"><rect x="${x-1}" y="${y-1}" width="${w+2}" height="${h+2}" fill="#111"/>${pixels(sample.excludedCorners,'#ff689b')}${pixels(sample.pixels,'#888')}${chosen.map((f,i)=>pixels(f.pixels,['#6de0ff','#ffd36d','#98ee85'][i%3])).join('')}</svg>`;
  return `<article><h3>${escape(sample.id)}</h3>${svg}<p>${sample.pixels.length} retained · ${sample.excludedCorners.length} corner pixels excluded</p>${chosen.map(f=>`<p>${escape(f.id)} = ${f.value.toFixed(4)}</p>`).join('')}<details><summary>All measurements</summary><pre>${escape(JSON.stringify(row?.features.map(({id,value})=>({id,value})),null,2))}</pre></details></article>`;
 }).join('');
 return `<!doctype html><html><head><meta charset="utf-8"><title>UnaccountedDigitPx feature checkpoint</title><style>body{background:#17140d;color:#e8d9b9;font:14px monospace;padding:20px}main{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:16px}article{border:1px solid #76603a;padding:12px;overflow-wrap:anywhere}svg{width:100%;height:220px}pre{overflow:auto}</style></head><body><h1>UnaccountedDigitPx · feature review</h1><p>Gray: retained. Pink: excluded corners. Cyan / gold / green: selected feature memberships, painted in selection order. Bbox and corner exclusions are provisional.</p><main>${cards}</main></body></html>`;
}
