import assert from 'node:assert/strict';
import test from 'node:test';
import { planS1FromCanonicalPixels } from '../../scripts/pxcube-s0-s1-semantic-bridge.mjs';

const clean={widthPx:2,heightPx:2,rgba:new Uint8ClampedArray([1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16])};
const candidate={widthPx:2,heightPx:1,rgba:new Uint8ClampedArray([1,2,3,4,5,6,7,8])};
const ops=[
 {id:'badgeStage.masks',semanticConsumes:['px.course.canonicalPixels.pixels'],produces:['badgeStage.masks']},
 {id:'badgeStage.components',semanticConsumes:['badgeStage.masks'],consumes:['badgeStage.masks'],produces:['badgeStage.components']},
 {id:'metadata',semanticConsumes:['px.source.fullImage.imageId'],produces:['meta']}
];
test('S0 canonicalPixels edition delta opens only justified S1 cone',()=>{
 const {deltas,plan}=planS1FromCanonicalPixels({clean,candidate,s1Ops:ops});
 assert.ok(deltas.some(d=>d.path==='px.course.canonicalPixels.height'));
 assert.ok(deltas.some(d=>d.path.startsWith('px.course.canonicalPixels.pixels')));
 assert.deepEqual(plan.map(x=>[x.id,x.resolution]),[
  ['badgeStage.masks','EXECUTE'],['badgeStage.components','EXECUTE'],['metadata','REUSE']
 ]);
});
