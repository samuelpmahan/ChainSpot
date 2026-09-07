/// <reference lib="dom" />
import type { PqlRun } from './pql';
export interface PixelLayer { name: string; pixels: readonly number[]; color: string }
/** Same SVG projection is used by browser inspection and SVG export. */
export function renderPartsSvg(layers: readonly PixelLayer[], width: number, height: number, source = ''): string {
 let x0=width,y0=height,x1=0,y1=0;
 const paths=layers.map(layer=>{
  const sorted=[...new Set(layer.pixels)].sort((a,b)=>a-b);
  let path='';
  for(let i=0;i<sorted.length;i++) {
   const start=sorted[i]; let end=start;
   while(i+1<sorted.length && sorted[i+1]===end+1 && Math.floor(sorted[i+1]/width)===Math.floor(start/width)) end=sorted[++i];
   const x=start%width,y=Math.floor(start/width),length=end-start+1;
   x0=Math.min(x0,x);y0=Math.min(y0,y);x1=Math.max(x1,x+length);y1=Math.max(y1,y+1);
   path+=`M${x} ${y}h${length}v1h-${length}z`;
  }
  return `<path fill="${layer.color}" d="${path}"/>`;
 });
 if(!layers.some(l=>l.pixels.length)){x0=0;y0=0;x1=width;y1=height;}
 x0=Math.max(0,x0-4); y0=Math.max(0,y0-4); x1=Math.min(width,x1+4); y1=Math.min(height,y1+4);
 const safeSource=source.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');
 return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x0} ${y0} ${x1-x0} ${y1-y0}" style="width:100%;height:100%;image-rendering:pixelated" shape-rendering="crispEdges"><rect x="${x0}" y="${y0}" width="${x1-x0}" height="${y1-y0}" fill="#444"/>${source?`<image href="${safeSource}" width="${width}" height="${height}"/>`:''}${paths.join('')}</svg>`;
}

/** A portable inspector over actual Calculation outputs, with no detector calls. */
export function renderPqlHtml(run: PqlRun, width: number, height: number, source = ''): string {
 const outputs=run.Ticks.flatMap(t=>t.Calculations.map(c=>({tick:t.name,call:c.actualCall,args:c.args,into:c.into,output:c.output})));
 const data=JSON.stringify({outputs,width,height,source},(_key,value)=>ArrayBuffer.isView(value)?Array.from(value as unknown as ArrayLike<number>):value).replace(/</g,'\\u003c');
 return `<!doctype html><html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>PrincipleComponentRender</title><style>body{margin:20px;background:#15130f;color:#f2dfb9;font:15px monospace}main{display:grid;grid-template-columns:260px 1fr 300px;gap:16px}section{border:1px solid #74603a;padding:14px}#view{height:70vh}select,button{font:inherit;max-width:100%;margin:6px 0;background:#292318;color:inherit;padding:8px}label{display:block;overflow-wrap:anywhere;margin:8px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere}@media(max-width:850px){main{grid-template-columns:1fr}}</style><h1>PrincipleComponentRender</h1><main><section><select id="operation"></select><select id="item"></select><div id="layers"></div></section><section><label><input type="checkbox" id="source">Source pixels</label><div id="view"></div><button id="download">Export current SVG</button></section><section><pre id="details"></pre></section></main><script>const data=${data};const renderPartsSvg=${renderPartsSvg.toString()};(${inspector.toString()})(data,renderPartsSvg,${pixelLayers.toString()});</script></html>`;
}
function inspector(data: any, render: typeof renderPartsSvg, collect: typeof pixelLayers) {
 const operation=document.getElementById('operation') as HTMLSelectElement;
 const item=document.getElementById('item') as HTMLSelectElement;
 const layersBox=document.getElementById('layers')!;
 const source=document.getElementById('source') as HTMLInputElement;
 const view=document.getElementById('view')!;
 let layers: PixelLayer[]=[]; let visible: boolean[]=[];
 const palette=['#ffbf50','#50d6ff','#ffffff','#ff7b98','#a0e38a','#c9a1ff'];
 const paint=()=>{view.innerHTML=render(layers.filter((_,i)=>visible[i]),data.width,data.height,source.checked?data.source:'');};
 function selectItem() {
  const value=data.outputs[operation.selectedIndex].output;
  const collection=Array.isArray(value)?value:value.candidates??value.components;
  const chosen=collection?collection[item.selectedIndex]:value;
  layers=collect(chosen);visible=layers.map(()=>true);layersBox.replaceChildren();
  layers.forEach((layer,i)=>{const label=document.createElement('label'),box=document.createElement('input');box.type='checkbox';box.checked=true;box.onchange=()=>{visible[i]=box.checked;paint();};label.append(box,document.createTextNode(layer.name));label.style.color=layer.color;layersBox.append(label);});
  paint();
 }
 function selectOperation() {
  const selected=data.outputs[operation.selectedIndex];
  document.getElementById('details')!.textContent=JSON.stringify({tick:selected.tick,call:selected.call,args:selected.args,into:selected.into},null,2);
  const value=selected.output;const collection=Array.isArray(value)?value:value.candidates??value.components;
  item.replaceChildren();
  for(const [i,node] of (collection??[value]).entries()){const option=document.createElement('option');option.textContent=node.id??`Item ${i+1}`;item.append(option);}
  selectItem();
 }
 data.outputs.forEach((c:any)=>{const option=document.createElement('option');option.textContent=`${c.tick} / ${c.call}`;operation.append(option);});
 operation.selectedIndex=data.outputs.length-1;operation.onchange=selectOperation;item.onchange=selectItem;source.onchange=paint;
 document.getElementById('download')!.onclick=()=>{const a=document.createElement('a');const url=URL.createObjectURL(new Blob([view.innerHTML],{type:'image/svg+xml'}));a.href=url;a.download='Parts.svg';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
 selectOperation();
}

export function pixelLayers(value: unknown): PixelLayer[] {
 const palette=['#ffbf50','#50d6ff','#ffffff','#ff7b98','#a0e38a','#c9a1ff'];
 const layers: PixelLayer[]=[]; const seen=new Set<string>();
  function visit(node:any,path:string) {
   if(!node || typeof node!=='object')return;
   if(node.kind==='cropped-raster')return;
   if(node.kind==='component'||node.kind==='mask') {
    const identity=node.address??path;if(seen.has(identity))return;seen.add(identity);
    const pixels=node.kind==='mask'?Array.from(node.pixels as ArrayLike<number>).flatMap((v:number,i:number)=>v?[i]:[]):node.pixels;
    layers.push({name:`${path} / ${node.id}`,pixels,color:palette[layers.length%palette.length]});return;
   }
   for(const [key,child] of Object.entries(node)) if(key!=='pixels') visit(child,`${path}.${key}`);
  }
 visit(value,'Part');
 return layers;
}
