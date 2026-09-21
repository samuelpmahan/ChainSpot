import assert from 'node:assert/strict';
import { convergeOnEquivalence, propagateWhileParity, semanticDelta, surgicalExecutionCone } from '../packages/alg/dist/exec/speculative.js';

const deltas=semanticDelta({membership:{bottom:4},meta:{filename:'a'}},{membership:{bottom:20},meta:{filename:'a'}});
assert.deepEqual(surgicalExecutionCone(deltas,[
  {id:'edge',semanticConsumes:['membership.bottom'],produces:['edges']},
  {id:'measure',consumes:['edges'],produces:['stats']},
  {id:'meta',semanticConsumes:['meta.filename'],produces:['receipt']}
]),[
  {id:'edge',resolution:'EXECUTE'},
  {id:'measure',resolution:'EXECUTE'},
  {id:'meta',resolution:'REUSE'}
]);
assert.equal(convergeOnEquivalence('candidate','clean',{parity:true,comparator:'fn.compare'}).converged,true);
let after=false;
const result=propagateWhileParity([
  {id:'S0',compare:()=>({parity:true})},
  {id:'S1',compare:()=>({parity:false,where:'Badge 7'})},
  {id:'S2',compare:()=>{after=true; return {parity:true};}}
]);
assert.equal(result.status,'REBUKED');
assert.equal(after,false);
console.log('production speculative kernel PASS');
