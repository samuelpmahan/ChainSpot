const fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process'),{parse,stringify}=require('yaml'),sharp=require('sharp');
const [input,out]=process.argv.slice(2);if(!input||!out)throw Error('Usage: node scripts/sweep-feature-bbox.cjs assemblies.json output-directory');
fs.mkdirSync(out,{recursive:true});const base=parse(fs.readFileSync(path.join(__dirname,'../packages/alg/src/stages/S1/exp/feature-discovery/PrincipleComponentRender.yaml'),'utf8'));
const sweep=[];
for(const inset of [2,3,4,5]){
 const dir=path.resolve(out,'inset-'+inset);fs.mkdirSync(dir,{recursive:true});const composition=structuredClone(base);composition.Ticks[0].Calculations[0].args.insetPx=inset;
 const yamlPath=path.join(dir,'input.yaml');fs.writeFileSync(yamlPath,stringify(composition));
 execFileSync(process.execPath,[path.join(__dirname,'run-feature-discovery.cjs'),path.resolve(input),dir,yamlPath],{timeout:55000,stdio:'pipe'});
 const summary=JSON.parse(fs.readFileSync(path.join(dir,'summary.json'))),data=JSON.parse(fs.readFileSync(path.join(dir,'Default.json')));
 sweep.push({inset,summary,data});console.log(JSON.stringify({inset,results:summary.variants.map(v=>({variant:v.variant,fit:v.fitAgreement,pixels:v.retained,pcy:v.pcyEqualsDirect}))}));
}
const labels=sweep[0].summary.white;const all=labels.map(l=>Number(l.value)).sort((a,b)=>a-b);
function sheet(numbers,name){
 const width=1400,rowH=190,height=110+numbers.length*rowH;
 let svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#17140d"/><g fill="#ead9b6" font-family="monospace"><text x="20" y="28" font-size="22">Dash bbox sweep · retained pixels at the same scale</text><text x="20" y="53" font-size="14">Cyan retained · pink removed from 2px baseline · gold current bbox</text>`;
 sweep.forEach((run,c)=>svg+=`<text x="${c*350+20}" y="88" font-size="18">${run.inset}px inset</text>`);
 numbers.forEach((num,r)=>{
  const index=labels.findIndex(l=>Number(l.value)===num),original=sweep[0].data.samples[index];
  const [bx,by,bw,bh]=original.bbox;
  sweep.forEach((run,c)=>{
   const sample=run.data.samples[index],keep=new Set(sample.pixels),removed=original.pixels.filter(p=>!keep.has(p)),[x,y,w,h]=sample.bbox;
   const px=(members,color)=>members.map(p=>`<rect x="${p%sample.widthPx}" y="${Math.floor(p/sample.widthPx)}" width="1" height="1" fill="${color}"/>`).join('');
   svg+=`<g transform="translate(${c*350+5} ${110+r*rowH})"><rect width="340" height="184" fill="#211c13" stroke="#675737"/><text x="10" y="21" font-size="15">${num} · ${sample.pixels.length}px</text><svg x="5" y="26" width="330" height="150" viewBox="${bx-1} ${by-1} ${bw+2} ${bh+2}" shape-rendering="crispEdges">${px(removed,'#ff689b')}${px(sample.pixels,'#6de0ff')}<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="#c99b40" stroke-width="0.18"/></svg></g>`;
  });
 });svg+='</g></svg>';fs.writeFileSync(path.join(out,name+'.svg'),svg);return sharp(Buffer.from(svg)).png().toFile(path.join(out,name+'.png'));
}
const rows=sweep.map(({inset,summary,data})=>({inset,variants:summary.variants,root:data.model.featureIds[data.model.model.split?.feature],white:summary.white,comparisons:summary.comparisons}));
fs.writeFileSync(path.join(out,'sweep-summary.json'),JSON.stringify(rows,null,2));
Promise.all([sheet([10,12,13,14,15,16,17],'target-badges'),sheet(all,'all-badges')]).then(()=>console.log('Rendered both sheets'));
