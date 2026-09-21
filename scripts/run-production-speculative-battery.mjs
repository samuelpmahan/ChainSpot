import { spawnSync } from 'node:child_process';
import { runFlexibleBattery, BLOCKED, PASS, FAIL } from './pxcube-flexible-battery.mjs';

const run=(cmd,args)=>{
  const r=spawnSync(cmd,args,{stdio:'inherit'});
  return r.error ? {blocked:r.error.message} : {code:r.status ?? 1};
};

const check={id:'production-speculative-kernel'};
const result=await runFlexibleBattery(check,[
  {
    id:'package-vitest',
    canFulfill:async()=>false,
    run:async()=>({status:BLOCKED,environmentTestimony:{reason:'@chainspot/alg has no package-local test script/config'}})
  },
  {
    id:'compiled-node-proof',
    canFulfill:async()=>true,
    run:async()=>{
      const r=run(process.execPath,['scripts/prove-production-speculative.mjs']);
      if(r.blocked) return {status:BLOCKED,environmentTestimony:{reason:r.blocked}};
      return r.code===0
        ? {status:PASS,semanticTestimony:{kernel:'surgical invalidation + convergence + pass-while rebuke'},environmentTestimony:{node:process.version}}
        : {status:FAIL,semanticTestimony:{reason:'compiled production proof contradicted check'}};
    }
  }
]);
console.log(JSON.stringify(result,null,2));
process.exitCode=result.result.status===PASS ? 0 : 1;
