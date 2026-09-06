import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {sampleFourLaneBand,observeFourLaneCrossSection,DEFAULT_FOUR_LANE_SENSOR_KNOBS} from './st.fourLaneSensor.mts';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const input=JSON.parse(fs.readFileSync(root+'/inputs.json','utf8'));
const image={width:input.width,height:input.height,data:new Uint8Array(fs.readFileSync(root+'/source.rgba'))};
const knobs=DEFAULT_FOUR_LANE_SENSOR_KNOBS,occluders=input.seeds.map(s=>s.badge),rows=[];
for(const seed of input.seeds){
 const headingRad=Math.atan2(seed.badge.yPx-seed.tee.yPx,seed.badge.xPx-seed.tee.xPx),tx=Math.cos(headingRad),ty=Math.sin(headingRad),nx=-ty,ny=tx;
 for(const width of seed.hole===18?[32,36,40,44,48]:[40])for(let d=0;d<=500;d++){
 const center={xPx:seed.badge.xPx+tx*d,yPx:seed.badge.yPx+ty*d};
 if(center.xPx<0||center.xPx>=image.width||center.yPx<0||center.yPx>=image.height)break;
 const point=offset=>({xPx:center.xPx+nx*offset,yPx:center.yPx+ny*offset});
 const rail=(offset,sign)=>{const io=offset+sign*knobs.edgeDeltaPx,oo=offset-sign*knobs.edgeDeltaPx;
 const inside=sampleFourLaneBand(image,center,headingRad,io,occluders,knobs),outside=sampleFourLaneBand(image,center,headingRad,oo,occluders,knobs);
 const rawDiff=inside.mean===null||outside.mean===null?null:inside.mean-outside.mean,occluded=inside.occluded||outside.occluded;
 return {insideMean:inside.mean,outsideMean:outside.mean,rawDiff,score:occluded||rawDiff===null?null:Math.min(1,Math.max(0,rawDiff/knobs.liftReference)),occluded,insidePoint:point(io),outsidePoint:point(oo),railPoint:point(offset)};};
 rows.push({hole:seed.hole,width,distancePx:d,center,headingRad,left:rail(-width/2,1),right:rail(width/2,-1),centerBand:sampleFourLaneBand(image,center,headingRad,0,occluders,knobs)});
 }
}
let parityCount=0;
for(const row of rows.filter((r,i)=>i%17===0)){const exact=observeFourLaneCrossSection(image,{...row.center,headingRad:row.headingRad,corridorWidthPx:row.width},occluders,knobs);for(const [name,key] of [['left','leftRail'],['right','rightRail']]){if(exact[key]!==row[name].score)throw new Error('Rail parity failure');parityCount++;}}
const receipt={...input,parity:{comparisons:parityCount,exact:true},knobs,samplePositionRule:'For each insidePoint/outsidePoint use offsets [-4,-2,0,2,4] along (cos heading,sin heading); source sampler Math.round to pixel.',sideConvention:'left means code lane -W/2; right +W/2. Image coordinates y down.',rows};
fs.writeFileSync(root+'/readings.json',JSON.stringify(receipt));
const fields=['hole','width','distancePx','x','y','leftInside','leftOutside','leftDiff','leftScore','leftOccluded','rightInside','rightOutside','rightDiff','rightScore','rightOccluded'];
fs.writeFileSync(root+'/readings.csv',fields.join(',')+'\n'+rows.map(r=>[r.hole,r.width,r.distancePx,r.center.xPx,r.center.yPx,r.left.insideMean,r.left.outsideMean,r.left.rawDiff,r.left.score,r.left.occluded,r.right.insideMean,r.right.outsideMean,r.right.rawDiff,r.right.score,r.right.occluded].join(',')).join('\n'));
console.log(JSON.stringify({rows:rows.length,seeds:input.seeds.length,output:root+'/readings.json'}));
