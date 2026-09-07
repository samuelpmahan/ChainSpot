const fs=require('node:fs'),sharp=require('sharp'),path=require('node:path');
const out=process.argv[2],d=JSON.parse(fs.readFileSync(path.join(out,'Default.json'))),s=JSON.parse(fs.readFileSync(path.join(out,'summary.json')));
const esc=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;');
const cols=3,cw=450,ch=260;
let svg=`<svg xmlns="http://www.w3.org/2000/svg" width="1350" height="1660"><rect width="1350" height="1660" fill="#17140d"/><g font-family="monospace" fill="#e8d9b9"><text x="20" y="30" font-size="22">Dash · UnaccountedDigitPx feature discovery</text><text x="20" y="55" font-size="14">Gray retained · pink excluded corners · cyan first tree feature</text><text x="20" y="78" font-size="14">White labels are predictions. Tree fit: 16/18 · boosted stumps: 2/18 (training only)</text>`;
d.samples.forEach((sample,i)=>{
 const x=i%cols*cw,y=100+Math.floor(i/cols)*ch;const row=d.table.rows[i],pred=d.model.predictions[i];
 const f=row.features[pred.trace[0]?.feature];const [bx,by,bw,bh]=sample.bbox;
 svg+=`<g transform="translate(${x+10} ${y})"><rect width="430" height="250" fill="#201c13" stroke="#685631"/><text x="12" y="24" font-size="16">White ${esc(s.white[i].value)} · tree ${esc(pred.label)}</text>`;
 svg+=`<svg x="15" y="35" width="400" height="158" viewBox="${bx-1} ${by-1} ${bw+2} ${bh+2}" shape-rendering="crispEdges">`;
 const px=(items,color)=>items.map(p=>`<rect x="${p%sample.widthPx}" y="${Math.floor(p/sample.widthPx)}" width="1" height="1" fill="${color}"/>`).join('');
 svg+=px(sample.excludedCorners,'#ff689b')+px(sample.pixels,'#888')+px(f?.pixels||[],'#6de0ff')+'</svg>';
 svg+=`<text x="12" y="212" font-size="13">${esc(f?.id)} = ${f?.value.toFixed(3)}</text><text x="12" y="234" font-size="13">${sample.pixels.length} retained · ${sample.excludedCorners.length} corner px</text></g>`;
});svg+='</g></svg>';fs.writeFileSync(path.join(out,'feature-overview.svg'),svg);sharp(Buffer.from(svg)).png().toFile(path.join(out,'feature-overview.png')).then(()=>console.log('rendered'));
