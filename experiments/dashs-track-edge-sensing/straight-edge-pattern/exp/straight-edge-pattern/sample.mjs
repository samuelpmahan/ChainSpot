import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {sampleFourLaneBand, DEFAULT_FOUR_LANE_SENSOR_KNOBS as knobs} from './st.fourLaneSensor.mts';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
fs.mkdirSync(root+'/output',{recursive:true});
const input=JSON.parse(fs.readFileSync(root+'/data/inputs.json'));
const ann=JSON.parse(fs.readFileSync(root+'/data/annotation.json'));
const straight=ann.holes.filter(h=>!h.corridorBends.length).map(h=>h.number);
const image={width:input.width,height:input.height,data:new Uint8Array(fs.readFileSync(root+'/data/source.rgba'))};
const offsets=Array.from({length:241},(_,i)=>-60+i*.5);
const distances=Array.from({length:521},(_,i)=>-220+i);
const holes=[];
for(const seed of input.seeds.filter(s=>straight.includes(s.hole)||s.hole===18)){
 const heading=Math.atan2(seed.badge.yPx-seed.tee.yPx,seed.badge.xPx-seed.tee.xPx);
 const tx=Math.cos(heading),ty=Math.sin(heading),nx=-ty,ny=tx;
 const a=ann.holes.find(h=>h.number===seed.hole);
 const basketDistance=(a.basket.xPx-seed.badge.xPx)*tx+(a.basket.yPx-seed.badge.yPx)*ty;
 const teeDistance=(seed.tee.xPx-seed.badge.xPx)*tx+(seed.tee.yPx-seed.badge.yPx)*ty;
 const bands=distances.map(d=>offsets.map(n=>{
  const v=sampleFourLaneBand(image,{xPx:seed.badge.xPx+tx*d,yPx:seed.badge.yPx+ty*d},heading,n,input.seeds.map(s=>s.badge),knobs);
  return v.occluded?null:v.mean;
 }));
 holes.push({...seed,heading,tx,ty,nx,ny,teeDistance,basketDistance,basket:a.basket,straight:straight.includes(seed.hole),bands});
}
fs.writeFileSync(root+'/output/bands.json',JSON.stringify({sourceSha256:input.sourceSha256,offsets,distances,knobs,holes,provenance:'Original sampleFourLaneBand; source pixels unchanged. Annotations select straight examples and mark Tee/Basket extent for inspection, never change heading. H3/H12 annotation Tee seeds disclosed in each hole. Negative distance is before Badge. Badge bboxes masked; other glyphs and circles remain visible.'}));
console.log(`Sampled ${holes.length} holes, ${distances.length} distances, ${offsets.length} offsets; original sampler retained.`);
