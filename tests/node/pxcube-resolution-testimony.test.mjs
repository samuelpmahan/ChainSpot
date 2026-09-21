import assert from 'node:assert/strict';
import test from 'node:test';
import { conservativeSemanticPlan } from '../../packages/alg/dist/exec/speculative.js';
import { resolutionTestimony } from '../../scripts/pxcube-resolution-testimony.mjs';

test('resolution testimony explains direct and propagated execution',()=>{
 const calculations=[
  {id:'masks',semanticConsumes:['localImage.pixels'],produces:['masks']},
  {id:'components',semanticConsumes:['masks.bright'],consumes:['masks'],produces:['components']},
  {id:'metadata',semanticConsumes:['localImage.filename'],produces:['meta']}
 ];
 const deltas=[{path:'localImage.pixels',before:'a',after:'b'}];
 const plan=conservativeSemanticPlan(deltas,calculations);
 const t=resolutionTestimony({lineage:'exp/smart-crop',deltas,plan,calculations});
 assert.deepEqual(t,[
  {lineage:'exp/smart-crop',calculation:'masks',resolution:'EXECUTE',reason:'semantic-delta',cause:['localImage.pixels']},
  {lineage:'exp/smart-crop',calculation:'components',resolution:'EXECUTE',reason:'semantic-delta',cause:['masks changed by masks']},
  {lineage:'exp/smart-crop',calculation:'metadata',resolution:'REUSE',reason:'declared-unaffected',cause:['declared semantic dependencies unaffected']}
 ]);
});
