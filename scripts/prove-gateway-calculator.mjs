import assert from 'node:assert/strict';
import { createExecBoard } from '../packages/alg/dist/exec/board.js';
import { createMemorySink } from '../packages/alg/dist/exec/sink.js';
import { executeCompiledPlan } from '../packages/alg/dist/exec/gateway.js';

const op={id:'calculator.add',kind:'compute',gate:'CALC',unit:'calculator',consumes:['a','b'],produces:['sum'],calculations:['fn.nativeAdd']};
const plan={ops:[op],planFingerprint:'calc-plan',bindings:{}};
const ctx={span:()=>()=>{}};
function run(resolver){
 const board=createExecBoard(); board.set('a',7); board.set('b',5);
 const sink=createMemorySink(); let calls=0;
 const runtime={implementations:new Map([[op.id,(b)=>{calls++; b.set('sum',b.get('a')+b.get('b'));}]]),resolver};
 const receipts=executeCompiledPlan(plan,board,ctx,sink,runtime);
 return {board,receipt:receipts[0],calls};
}
const normal=run(undefined);
assert.equal(normal.calls,1); assert.equal(normal.board.get('sum'),12);
assert.equal(normal.receipt.resolution,'EXECUTE'); assert.equal(normal.receipt.lineage,'clean');

const reused=(()=>{ const board=createExecBoard(); board.set('a',7); board.set('b',5); board.set('sum',12); const exp=board.fork('exp/reuse'); const sink=createMemorySink(); let calls=0; const runtime={implementations:new Map([[op.id,(b)=>{calls++; b.set('sum',b.get('a')+b.get('b'));}]]),resolver:()=>({resolution:'REUSE',reason:'cache-hit',cause:['semantic identity matched trusted clean Part'],lineage:'exp/reuse'})}; const receipts=executeCompiledPlan(plan,exp,ctx,sink,runtime); return {board:exp,receipt:receipts[0],calls}; })();
assert.equal(reused.calls,0); assert.equal(reused.board.get('sum'),12);
assert.equal(reused.receipt.resolution,'REUSE'); assert.equal(reused.receipt.resolutionReason,'cache-hit');
assert.deepEqual(reused.receipt.resolutionCause,['semantic identity matched trusted clean Part']); assert.equal(reused.receipt.lineage,'exp/reuse');
console.log(JSON.stringify({execute:{calls:normal.calls,resolution:normal.receipt.resolution,durationMs:normal.receipt.durationMs},reuse:{calls:reused.calls,resolution:reused.receipt.resolution,durationMs:reused.receipt.durationMs}},null,2));

let refused=false;
try { run(()=>({resolution:'REUSE',reason:'cache-hit',lineage:'exp/bad-cache'})); } catch(e) {
  refused=/could not resolve Part/.test(String(e));
}
assert.equal(refused,true,'REUSE without produced Parts must fail loud');
