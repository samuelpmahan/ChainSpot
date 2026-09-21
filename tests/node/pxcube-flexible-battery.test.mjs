import assert from 'node:assert/strict';
import test from 'node:test';
import { BLOCKED, PASS, runFlexibleBattery } from '../../scripts/pxcube-flexible-battery.mjs';

test('battery changes fulfillment, never semantic check identity', async()=>{
  const result=await runFlexibleBattery({id:'speculative-kernel'},[
    {id:'package-vitest',canFulfill:async()=>false,run:async()=>{throw new Error('no')}},
    {id:'node-proof',canFulfill:async()=>true,run:async()=>({status:PASS,semanticTestimony:{cone:'surgical'},environmentTestimony:{node:process.version}})}
  ]);
  assert.equal(result.check,'speculative-kernel');
  assert.equal(result.fulfillment,'node-proof');
  assert.equal(result.status,PASS);
  assert.equal(result.attempts[0].status,BLOCKED);
  assert.equal(result.semanticTestimony.cone,'surgical');
});

test('blocked fulfillment may fall through but semantic failure may not', async()=>{
  let thirdRan=false;
  const result=await runFlexibleBattery({id:'truth'},[
    {id:'blocked',canFulfill:async()=>true,run:async()=>({status:BLOCKED})},
    {id:'real',canFulfill:async()=>true,run:async()=>({status:'FAIL',semanticTestimony:{why:'wrong result'}})},
    {id:'cheat',canFulfill:async()=>true,run:async()=>{thirdRan=true; return {status:PASS}}}
  ]);
  assert.equal(result.status,'FAIL');
  assert.equal(result.fulfillment,'real');
  assert.equal(thirdRan,false);
});
