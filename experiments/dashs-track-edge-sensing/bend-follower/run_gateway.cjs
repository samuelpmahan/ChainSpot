'use strict';
/* Experimental adapter: the real archived ABFeature gateway invokes the source-backed producer. */
const fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
const runtime=path.join(__dirname,'..','ternary-edge','runtime','archive','ChainSpot-Sweep-Ready','chainspot','packages','alg','dist');
const {compileABFeatureSet,executeABFeatureSet}=require(path.join(runtime,'exec','feature-set.js'));
const {createExecBoard}=require(path.join(runtime,'exec','board.js'));
const outDir=path.resolve(process.argv[2]||path.join(__dirname,'output','gateway'));
const py=process.env.PYTHON||'python3';
const featureId='pairedBoundaryPathFollower';
const operation={
 spec:{id:'paired-boundary-follower.track',unit:'G5',gate:'G5',features:[featureId],consumes:['bendFollower.sourceSpec'],produces:['bendFollower.trace'],calculations:['fn.paired-boundary-follower.track'],accessConformance:'exact'},
 run(board){const s=board.get('bendFollower.sourceSpec');fs.mkdirSync(s.outDir,{recursive:true});const args=[path.join(__dirname,'run.py'),'--out',s.outDir]; if(process.env.BEND_FOLLOWER_HOLES) args.push('--holes',process.env.BEND_FOLLOWER_HOLES); execFileSync(py,args,{cwd:__dirname,stdio:'pipe'});board.set('bendFollower.trace',JSON.parse(fs.readFileSync(path.join(s.outDir,'trace.json'),'utf8')));}
};
const definition={id:'paired-boundary-follower.experimental',features:[{id:featureId,gate:'G5',kind:'deviation',defaultEnabled:false,note:'Bounded paired-boundary diagnostic.',knobs:{beamWidth:{default:24,validate:v=>Number.isInteger(v)&&v>1?null:'positive integer required'}},operations:[operation]}],seededSlots:['bendFollower.sourceSpec']};
async function invoke(enabled){const c=compileABFeatureSet(definition,{[featureId]:{enabled,knobs:{beamWidth:24}}},'paired-boundary-follower-v1');const b=createExecBoard();b.set('bendFollower.sourceSpec',{outDir});const receipt=await executeABFeatureSet(c,b,{}, {runId:'paired-boundary-follower-gateway-v1',invocation:enabled?'ON':'OFF'});return {receipt,trace:enabled?b.get('bendFollower.trace'):null};}
(async()=>{const off=await invoke(false),on=await invoke(true);const exact=on.receipt.operations[0]?.declaredConsumes.join(',')===on.receipt.operations[0]?.actualConsumes.join(',')&&on.receipt.operations[0]?.declaredProduces.join(',')===on.receipt.operations[0]?.actualProduces.join(',');const check={offOperations:off.receipt.operations.length,onOperations:on.receipt.operations.length,offEnabled:off.receipt.enabledFeatureIds,onEnabled:on.receipt.enabledFeatureIds,accessExact:exact,actualTraceHash:on.trace?.traceHash};if(check.offOperations!==0||check.onOperations!==1||!exact||!on.trace)throw Error('ABFeature gateway contract failed');fs.writeFileSync(path.join(outDir,'gateway-receipt.json'),JSON.stringify({runId:on.trace.runId,featureId,traceHash:on.trace.traceHash,off:off.receipt,on:on.receipt,check},null,2));console.log(JSON.stringify(check));})().catch(e=>{console.error(e);process.exitCode=1});
