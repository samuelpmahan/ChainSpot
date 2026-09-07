const fs=require('fs'),path=require('path'),sharp=require('sharp');
const {createExecBoard}=require('../packages/alg/dist/exec/board');
const {createStage}=require('../packages/alg/dist/stages/S1/exp/number-templates');
const [input,out]=process.argv.slice(2);fs.mkdirSync(out,{recursive:true});const data=JSON.parse(fs.readFileSync(input));
const pxc=createExecBoard();pxc.set('px.s1.discovery.material',data.samples);pxc.set('px.s1.discovery.labels',data.table.labels);
const yaml=fs.readFileSync(path.join(__dirname,'../packages/alg/src/stages/S1/exp/number-templates/PrincipleComponentRender.yaml'),'utf8');
const results=createStage(yaml).run({pxc});for(const r of results){if(r.status!=='completed')throw Error(r.error);}
const comparisons=pxc.get('px.pql.NumberTemplateSensitivity.comparisons');
fs.writeFileSync(path.join(out,'comparison.json'),JSON.stringify(comparisons,null,2));
for(const r of results)fs.writeFileSync(path.join(out,r.variant+'.json'),JSON.stringify({executionMs:r.executionMs,run:r.run},(_,v)=>ArrayBuffer.isView(v)?Array.from(v):v));
const world=results[0].pxc,queries=world.get('px.s1.templates.queries'),dice=world.get('px.s1.templates.readings').readings,chamfer=results[1].pxc.get('px.s1.templates.readings').readings;
let svg='<svg xmlns="http://www.w3.org/2000/svg" width="1440" height="1270"><rect width="100%" height="100%" fill="#17140d"/><g fill="#ead9b6" font-family="monospace"><text x="20" y="30" font-size="22">Tight-cropped number templates · perturbation comparison</text><text x="20" y="56" font-size="14">Same-source synthetic queries · D = overlap, C = symmetric distance · pink = disagreement with source label</text>';
const chosen=['1','4','6','10','14','18'],conditions=['self','shift-right','shift-down','drop-10pct','add-10pct','drop-25pct'];
for(let row=0;row<chosen.length;row++)for(let col=0;col<conditions.length;col++){
 const index=queries.findIndex(q=>q.label===chosen[row]&&q.condition===conditions[col]),q=queries[index],d=dice[index],c=chamfer[index];
 svg+=`<g transform="translate(${col*240+5} ${80+row*195})"><rect width="230" height="188" fill="#211c13" stroke="#675737"/><text x="8" y="20" font-size="13">${q.label} / ${q.condition}</text><svg x="15" y="30" width="200" height="120" viewBox="0 0 32 24" shape-rendering="crispEdges">`;
 for(const p of q.points)svg+=`<rect x="${p%32}" y="${Math.floor(p/32)}" width="1" height="1" fill="#6de0ff"/>`;
 svg+=`</svg><text x="10" y="175" font-size="15" fill="${d.label===q.label?'#ead9b6':'#ff689b'}">D: ${d.label}</text><text x="115" y="175" font-size="15" fill="${c.label===q.label?'#ead9b6':'#ff689b'}">C: ${c.label}</text></g>`;
}svg+='</g></svg>';fs.writeFileSync(path.join(out,'comparison.svg'),svg);sharp(Buffer.from(svg)).png().toFile(path.join(out,'comparison.png')).then(()=>console.log(JSON.stringify(comparisons,null,2)));
