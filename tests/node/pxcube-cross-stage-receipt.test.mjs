import assert from 'node:assert/strict';
import test from 'node:test';
import { crossStageReceipt } from '../../scripts/pxcube-cross-stage-receipt.mjs';
const t=(opId,resolution,durationMs)=>({opId,resolution,durationMs});
test('cross-stage Receipt binds crop delta, S1 execution, parity and timing',()=>{
 const r=crossStageReceipt({
  lineage:'exp/tighter-crop',
  cleanS0:{widthPx:10,heightPx:10},candidateS0:{widthPx:10,heightPx:9},
  deltas:[{path:'px.course.canonicalPixels.height',before:10,after:9}],
  s1Plan:[{id:'badgeStage.masks',resolution:'EXECUTE'}],
  cleanS1:{badges:[{detId:'B1'}],testimonies:[t('masks','EXECUTE',4)]},
  candidateS1:{badges:[{detId:'B1'}],testimonies:[t('masks','EXECUTE',3)]}
 });
 assert.equal(r.badgeParity.parity,true); assert.equal(r.continuation,'PASS_WHILE');
 assert.equal(r.timing.execution.deltaMs,-1);
 assert.equal(r.s1.testimony[0].resolution,'EXECUTE');
});
