// Saved Badge memberships -> reviewed discovery YAML -> artifacts. No annotation inputs.
const fs=require('node:fs'),path=require('node:path');
const {createExecBoard}=require('../packages/alg/dist/exec/board.js');
const {createStage}=require('../packages/alg/dist/stages/S1/exp/feature-discovery/index.js');
const {renderFeatureCheckpoint}=require('../packages/alg/dist/stages/S1/exp/feature-discovery/render.js');
const {segmentDigits}=require('../packages/alg/dist/detectors/threeFactor/digits/segment.js');
const {normalizeDigitMask}=require('../packages/alg/dist/detectors/threeFactor/digits/normalize.js');
const {predictProbs}=require('../packages/alg/dist/detectors/threeFactor/digits/logisticInference.js');
const logistic=require('../packages/alg/dist/detectors/threeFactor/assets/logistic.json');
const [input,out,yamlPath]=process.argv.slice(2);if(!input||!out)throw Error('Usage: node scripts/run-feature-discovery.cjs assemblies.json output-directory [composition.yaml]');
fs.mkdirSync(out,{recursive:true});const assembly=JSON.parse(fs.readFileSync(input,'utf8')),labels={},white=[];
for(const b of assembly.candidates){
 const pixels=[...new Set(b.digits.flatMap(d=>Array.from(d.part.pixels)))],width=assembly.width;
 const xs=pixels.map(p=>p%width),ys=pixels.map(p=>Math.floor(p/width));
 const x=Math.min(...xs),y=Math.min(...ys),w=Math.max(...xs)-x+1,h=Math.max(...ys)-y+1,data=new Uint8Array(w*h);
 pixels.forEach(p=>data[(Math.floor(p/width)-y)*w+p%width-x]=1);
 const segmented=segmentDigits({width:w,height:h,data});
 const readings=segmented.digits.map(d=>{const probs=predictProbs(logistic,normalizeDigitMask(d.mask,d.bbox[2],d.bbox[3]));const rank=probs.map((score,i)=>({label:logistic.classes[i],score})).sort((a,b)=>b.score-a.score);return {label:rank[0].label,rank};});
 const value=readings.map(r=>r.label).join('');if(value)labels[b.id]={value,source:'white logistic prediction on assembled glyph union; unreviewed',captureId:'DashsTrack-saved-assembly'};
 white.push({id:b.id,value,readings,notes:segmented.notes});
}
const pxc=createExecBoard();pxc.set('px.s1.exp.badgeAssembly.badgeCandidates',assembly);pxc.set('px.s1.discovery.labels',labels);
const yaml=fs.readFileSync(yamlPath || path.join(__dirname,'../packages/alg/src/stages/S1/exp/feature-discovery/PrincipleComponentRender.yaml'),'utf8');
const results=createStage(yaml).run({pxc});const summary={variants:[],comparisons:pxc.get('px.pql.S1FeatureDiscovery.comparisons'),white};
for(const r of results){
 if(r.status!=='completed'){summary.variants.push({variant:r.variant,error:r.error});continue;}
 const get=k=>r.pxc.get('px.s1.discovery.'+k),samples=get('material'),table=get('features'),model=get('model'),mining=get('combinations');
 const selected={};model.predictions.forEach(p=>{selected[p.id]=[...new Set(p.trace.map(t=>model.featureIds[t.feature]))].slice(0,3);});
 fs.writeFileSync(path.join(out,r.variant+'.html'),renderFeatureCheckpoint(samples,table.rows,selected));
 fs.writeFileSync(path.join(out,r.variant+'.json'),JSON.stringify({samples,table,model,mining,sensitivity:get('sensitivity'),selected}));
 summary.variants.push({variant:r.variant,executionMs:r.executionMs,trainingMs:model.trainingMs,badges:samples.length,features:table.rows[0]?.features.length,
  retained:samples.reduce((s,b)=>s+b.pixels.length,0),excludedCorners:samples.reduce((s,b)=>s+b.excludedCorners.length,0),
  fitAgreement:model.predictions.filter(p=>p.label===labels[p.id]?.value).length,predictions:model.predictions.map(p=>({id:p.id,label:p.label})),
  combinations:mining.combinations.length,pcyEqualsDirect:mining.pcyEqualsDirect,directMs:mining.directMs,pcyMs:mining.pcyMs,truncated:mining.triplesTruncated});
}
fs.writeFileSync(path.join(out,'summary.json'),JSON.stringify(summary,null,2));fs.writeFileSync(path.join(out,'PrincipleComponentRender.yaml'),yaml);
console.log(JSON.stringify(summary.variants,null,2));
