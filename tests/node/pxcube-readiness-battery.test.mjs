import assert from 'node:assert/strict';
import test from 'node:test';
import { BLOCKED, FAIL, PASS } from '../../scripts/pxcube-flexible-battery.mjs';
import { formatReadiness, runReadinessBattery } from '../../scripts/pxcube-readiness-battery.mjs';

const adapter=(id,status)=>({id,canFulfill:async()=>status!=='UNAVAILABLE',run:async()=>({status})});

test('readiness composes Checks and their FlexibleBattery testimony',async()=>{
  const r=await runReadinessBattery([
    {check:{id:'kernel'},adapters:[adapter('vitest','UNAVAILABLE'),adapter('node',PASS)]},
    {check:{id:'s0-render'},adapters:[adapter('imagemagick',PASS)]}
  ]);
  assert.equal(r.status,PASS);
  assert.deepEqual(r.checks[0].attempts.map(x=>[x.adapter,x.status]),[['vitest',BLOCKED],['node',PASS]]);
  assert.match(formatReadiness(r),/kernel: PASS via node/);
});

test('FAIL dominates BLOCKED; BLOCKED dominates otherwise passing readiness',async()=>{
  const blocked=await runReadinessBattery([
    {check:{id:'a'},adapters:[adapter('a',PASS)]},
    {check:{id:'b'},adapters:[adapter('b','UNAVAILABLE')]}
  ]);
  assert.equal(blocked.status,BLOCKED);
  const failed=await runReadinessBattery([
    {check:{id:'a'},adapters:[adapter('a','UNAVAILABLE')]},
    {check:{id:'b'},adapters:[adapter('b',FAIL)]}
  ]);
  assert.equal(failed.status,FAIL);
});
