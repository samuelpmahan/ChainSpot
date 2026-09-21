import assert from 'node:assert/strict';
import test from 'node:test';
import { BLOCKED, PASS, runFlexibleBattery } from '../../scripts/pxcube-flexible-battery.mjs';

test('battery changes fulfillment, never semantic check identity', async()=>{
  const result=await runFlexibleBattery({id:'speculative-kernel'},[
    {id:'package-vitest',canFulfill:async()=>false,run:async()=>{throw new Error('no')}},
    {id:'node-proof',canFulfill:async()=>true,run:async()=>({status:PASS,semanticTestimony:{cone:'surgical'},environmentTestimony:{node:process.version}})}
  ]);
  assert.equal(result.result.check,'speculative-kernel');
  assert.equal(result.result.fulfillment,'node-proof');
  assert.equal(result.result.status,PASS);
  assert.equal(result.attempts[0].status,BLOCKED);
  assert.equal(result.result.semanticTestimony.cone,'surgical');
});

test('blocked fulfillment may fall through but semantic failure may not', async()=>{
  let thirdRan=false;
  const result=await runFlexibleBattery({id:'truth'},[
    {id:'blocked',canFulfill:async()=>true,run:async()=>({status:BLOCKED})},
    {id:'real',canFulfill:async()=>true,run:async()=>({status:'FAIL',semanticTestimony:{why:'wrong result'}})},
    {id:'cheat',canFulfill:async()=>true,run:async()=>{thirdRan=true; return {status:PASS}}}
  ]);
  assert.equal(result.result.status,'FAIL');
  assert.equal(result.result.fulfillment,'real');
  assert.equal(thirdRan,false);
});


test('attempts are homogeneous and result is separate', async()=>{
  const out=await runFlexibleBattery({id:'shape'},[
    {id:'nope',canFulfill:async()=>false,run:async()=>({status:PASS})},
    {id:'yes',canFulfill:async()=>true,run:async()=>({status:PASS,semanticTestimony:{ok:true}})}
  ]);
  assert.deepEqual(out.attempts.map(({adapter,status})=>({adapter,status})),[
    {adapter:'nope',status:BLOCKED},
    {adapter:'yes',status:PASS}
  ]);
  assert.equal(out.result.check,'shape');
  assert.equal(out.result.fulfillment,'yes');
  assert.deepEqual(out.result.semanticTestimony,{ok:true});
});
