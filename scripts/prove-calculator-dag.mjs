import assert from 'node:assert/strict';
import { createExecBoard } from '../packages/alg/dist/exec/board.js';
import { executeCompiledPlan, executeCompiledPlanAsync } from '../packages/alg/dist/exec/gateway.js';

const ctx={span:()=>()=>{}};
const ops=[
 {id:'left',kind:'compute',gate:'CALC',unit:'calc',consumes:['x'],produces:['left'],calculations:['fn.left']},
 {id:'right',kind:'compute',gate:'CALC',unit:'calc',consumes:['x'],produces:['right'],calculations:['fn.right']},
 {id:'join',kind:'compute',gate:'CALC',unit:'calc',consumes:['left','right'],produces:['total'],calculations:['fn.join']}
];
const plan={ops,planFingerprint:'dag',bindings:{}};
const board=createExecBoard(); board.set('x',4);
const order=[];
const runtime={implementations:new Map([
 ['left',(b)=>{order.push('left');b.set('left',b.get('x')+1)}],
 ['right',(b)=>{order.push('right');b.set('right',b.get('x')*2)}],
 ['join',(b)=>{order.push('join');b.set('total',b.get('left')+b.get('right'))}]
])};
executeCompiledPlan(plan,board,ctx,undefined,runtime);
assert.deepEqual(order,['left','right','join']); assert.equal(board.get('total'),13);

// Async resolver parity: reused left Part satisfies downstream join; right executes.
const asyncBoard=createExecBoard(); asyncBoard.set('x',4); let leftCalls=0,rightCalls=0,joinCalls=0;
const asyncRuntime={implementations:new Map([
 ['left',async(b)=>{leftCalls++;b.set('left',b.get('x')+1)}],
 ['right',async(b)=>{rightCalls++;b.set('right',b.get('x')*2)}],
 ['join',async(b)=>{joinCalls++;b.set('total',b.get('left')+b.get('right'))}]
]),resolver:(op)=>op.id==='left'?{resolution:'REUSE',reason:'cache-hit',reusedParts:{left:5},lineage:'exp/dag'}:{resolution:'EXECUTE',reason:'required',lineage:'exp/dag'}};
const receipts=await executeCompiledPlanAsync(plan,asyncBoard,ctx,undefined,asyncRuntime);
assert.equal(leftCalls,0); assert.equal(rightCalls,1); assert.equal(joinCalls,1); assert.equal(asyncBoard.get('total'),13);
assert.deepEqual(receipts.map(r=>[r.opId,r.resolution]),[['left','REUSE'],['right','EXECUTE'],['join','EXECUTE']]);
console.log(JSON.stringify({sequential:{order,total:board.get('total')},asyncResolver:{leftCalls,rightCalls,joinCalls,total:asyncBoard.get('total'),resolutions:receipts.map(r=>[r.opId,r.resolution])}},null,2));
