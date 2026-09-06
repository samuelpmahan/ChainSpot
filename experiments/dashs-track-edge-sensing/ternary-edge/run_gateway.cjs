'use strict';
/* Actual production-gateway execution for this experimental diagnostic.
 * The operation owns the Python RGB producer, calls it inside operation.run,
 * then writes its returned trace to the exec board.  This keeps the ABFeature
 * descriptor, gate, timing and declared slot custody in the archived gateway.
 */
const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const runtime = path.join(__dirname,'runtime','archive','ChainSpot-Sweep-Ready','chainspot','packages','alg','dist');
const {compileABFeatureSet, executeABFeatureSet} = require(path.join(runtime,'exec','feature-set.js'));
const {createExecBoard} = require(path.join(runtime,'exec','board.js'));
const outDir = path.resolve(process.argv[2] || path.join(__dirname,'output','gateway'));
const python = process.env.PYTHON || 'python3';
const operation = {
  spec:{id:'ternary-edge.sample-and-classify',unit:'G5',gate:'G5',features:['ternaryEdgeSensing'],consumes:['ternary.sourceSpec'],produces:['ternary.materialTrace'],calculations:['fn.ternary-edge.sample-and-classify'],accessConformance:'exact'},
  run(board){
    const sourceSpec=board.get('ternary.sourceSpec');
    fs.mkdirSync(sourceSpec.outDir,{recursive:true});
    execFileSync(python,[path.join(__dirname,'run.py'),'--out',sourceSpec.outDir],{cwd:__dirname,stdio:'pipe'});
    const trace=JSON.parse(fs.readFileSync(path.join(sourceSpec.outDir,'trace.json'),'utf8'));
    board.set('ternary.materialTrace',trace);
  }
};
const feature={id:'ternaryEdgeSensing',gate:'G5',kind:'deviation',defaultEnabled:false,note:'Experimental fixed-ray ternary material sensor; no tracker.',knobs:{observationWindowPx:{default:96,validate:v=>Number.isFinite(v)&&v>0?null:'must be positive'}},operations:[operation]};
const definition={id:'ternary-edge.experimental',features:[feature],seededSlots:['ternary.sourceSpec']};
async function run(enabled){
  const compiled=compileABFeatureSet(definition,{ternaryEdgeSensing:{enabled,knobs:{observationWindowPx:96}}},'ternary-edge-v1');
  const board=createExecBoard(); board.set('ternary.sourceSpec',{outDir});
  const receipt=await executeABFeatureSet(compiled,board,{}, {runId:'ternary-edge-gateway-v1',invocation:enabled?'ON':'OFF'});
  return {receipt,trace:enabled?board.get('ternary.materialTrace'):null};
}
(async()=>{
  const off=await run(false),on=await run(true);
  const check={offOperations:off.receipt.operations.length,onOperations:on.receipt.operations.length,offEnabled:off.receipt.enabledFeatureIds,onEnabled:on.receipt.enabledFeatureIds,accessExact:on.receipt.operations[0]?.declaredConsumes.join(',')===on.receipt.operations[0]?.actualConsumes.join(',')&&on.receipt.operations[0]?.declaredProduces.join(',')===on.receipt.operations[0]?.actualProduces.join(','),actualTraceHash:on.trace?.traceHash};
  if(check.offOperations!==0||check.onOperations!==1||!check.accessExact||!on.trace) throw new Error('gateway ABFeature contract failed');
  const receiptPath=path.join(outDir,'gateway-receipt.json');
  fs.writeFileSync(receiptPath,JSON.stringify({featureId:feature.id,traceHash:on.trace.traceHash,off:off.receipt,on:on.receipt,check},null,2));
  execFileSync(python,[path.join(__dirname,'lib','render_trace.py'),path.join(outDir,'trace.json'),'--source',path.join(__dirname,'..','restored','edge-diagnostic','edge-readings-work','DashsTrack-source.png'),'--output',path.join(outDir,'overlay.png')],{cwd:__dirname,stdio:'ignore'});
  execFileSync(python,[path.join(__dirname,'lib','render_trace.py'),path.join(outDir,'trace.json'),'--format'],{cwd:__dirname,stdio:['ignore',fs.openSync(path.join(outDir,'receipt.txt'),'w'),'pipe']});
  console.log(JSON.stringify(check));
})().catch(e=>{console.error(e);process.exitCode=1});
