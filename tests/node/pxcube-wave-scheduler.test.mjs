import assert from 'node:assert/strict';
import test from 'node:test';
import { executionWaves, executeWaves } from '../../scripts/pxcube-wave-scheduler.mjs';
const ops=[
 {id:'left',consumes:['x'],produces:['left']},
 {id:'right',consumes:['x'],produces:['right']},
 {id:'join',consumes:['left','right'],produces:['total']}
];
test('Part topology yields parallel-ready deterministic waves',()=>{
 assert.deepEqual(executionWaves(ops,['x']),[[ops[0],ops[1]],[ops[2]]]);
});
test('independent wave overlaps physically but testimony stays deterministic',async()=>{
 let active=0,maxActive=0;
 const out=await executeWaves({ops,seeded:['x'],run:async(op)=>{
  active++; maxActive=Math.max(maxActive,active);
  if(op.id!=='join') await new Promise(r=>setTimeout(r,15));
  active--; return op.id;
 }});
 assert.equal(maxActive,2);
 assert.deepEqual(out.waves,[['left','right'],['join']]);
 assert.deepEqual(out.testimony.map(x=>x.opId),['left','right','join']);
});
