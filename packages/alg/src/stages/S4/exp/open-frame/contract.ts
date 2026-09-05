import { canonicalJson } from '../../../../detectors/threeFactor/hash';
import { nullFeatureContext } from '../../../../detectors/threeFactor/features/types';
import { executeCompiledPlan, type OperationRuntime } from '../../../../exec/gateway';
import type { CompiledExecutionPlan } from '../../../../exec/compile';
import type { OperationSpec } from '../../../../exec/contract';
import type { PxC } from '../../../../exec/board';
import { composePcr } from '../../../../exec/pcr';
import { sha256HexSyncText } from '../../../../exec/sha256';
import { createMemorySink } from '../../../../exec/sink';
import type { StageContract } from '../../../contract';
import { ComponentPxC } from '../../../componentPxC';
import { TeePxC } from '../../../S3/clean/Tee';
import { BadgePxC } from '../../../S1/clean/Badge';
import { BasketPxC } from '../../../S2/clean/Basket';
import { S4PxC } from '../axis-local';
import { stageContract as base, renderS4 } from '../axis-local/contract';
import { findOpenFrames, resolveOpenFrames, OpenFramePxC } from './index';
const ops: OperationSpec[]=[
  {id:'S4.openFrame.measure',kind:'measure',gate:'S4',unit:'TeeBorder',
    consumes:[ComponentPxC.fields.address,BadgePxC.objects.address,BasketPxC.objects.address,TeePxC.objects.address],
    produces:[OpenFramePxC.candidates.address,OpenFramePxC.measures.address],
    calculations:['fn.S4.findOpenFrames'],accessConformance:'exact'},
  {id:'S4.openFrame.resolve',kind:'decide',gate:'S4',unit:'TeeBorder',
    consumes:[S4PxC.state.address,OpenFramePxC.candidates.address,BadgePxC.objects.address,TeePxC.objects.address],
    produces:[S4PxC.state.address],calculations:['fn.S4.resolveOpenFrames'],accessConformance:'exact'}];
const plan:CompiledExecutionPlan={ops,bindings:{},planFingerprint:sha256HexSyncText(canonicalJson({experiment:'S4/open-frame',ops}))};
const runtime:OperationRuntime={
  implementations:new Map<string,(pxc:PxC)=>void>([
    [ops[0].id,pxc=>{const result=findOpenFrames(pxc.get(ComponentPxC.fields),pxc.get(BadgePxC.objects),pxc.get(BasketPxC.objects),pxc.get(TeePxC.objects));
      pxc.set(OpenFramePxC.candidates,result.candidates);pxc.set(OpenFramePxC.measures,result.tested);}],
    [ops[1].id,pxc=>pxc.set(S4PxC.state,resolveOpenFrames(pxc.get(S4PxC.state),pxc.get(OpenFramePxC.candidates),pxc.get(BadgePxC.objects),pxc.get(TeePxC.objects).length))]]),
  calculationBindings:new Map([
    [ops[0].id,[{address:'fn.S4.findOpenFrames' as const,calculate:findOpenFrames}]],
    [ops[1].id,[{address:'fn.S4.resolveOpenFrames' as const,calculate:resolveOpenFrames}]]])};
export const stageContract:StageContract={id:'S4',async execute(context){
  await base.execute(context);const pxc=context.pxc!;
  const initial=pxc.get(S4PxC.pcr);pxc.set('px.s4.basePcr',initial);
  const testimony=executeCompiledPlan(plan,pxc,nullFeatureContext,createMemorySink(),runtime);
  pxc.set(S4PxC.pcr,composePcr({id:'S4.exp.open-frame',title:'Composed open-border recovery',tickIds:ops.map(op=>op.id)},plan,testimony));
  const state=pxc.get(S4PxC.state);const image=pxc.get(ComponentPxC.image);
  return {pxc,receiptText:['S4 EXPERIMENT open-frame',`resolutions: ${state.resolutions.length}`,
    `unresolved: ${state.unresolvedHoles.join(',')}`,'No frozen changes; visible S3 debt is retained, not declared solved.'].join('\n'),
    panels:[...renderS4(pxc),{label:'Composed open frame candidates',widthPx:image.widthPx,heightPx:image.heightPx,rgba:image.rgba,
      boxes:pxc.get(OpenFramePxC.candidates).map(c=>({bbox:c.bbox,color:[255,180,40,255] as const}))}]};
}};
