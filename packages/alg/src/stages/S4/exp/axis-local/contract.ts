import { canonicalJson } from '../../../../detectors/threeFactor/hash';
import { nullFeatureContext } from '../../../../detectors/threeFactor/features/types';
import { executeCompiledPlan, type OperationRuntime } from '../../../../exec/gateway';
import type { CompiledExecutionPlan } from '../../../../exec/compile';
import type { OperationSpec } from '../../../../exec/contract';
import { pxFn, type PxC } from '../../../../exec/board';
import { composePcr } from '../../../../exec/pcr';
import { sha256HexSyncText } from '../../../../exec/sha256';
import { createMemorySink } from '../../../../exec/sink';
import type { StageContract } from '../../../contract';
import { ComponentPxC } from '../../../componentPxC';
import { TeePxC } from '../../../S3/clean/Tee';
import { BadgePxC } from '../../../S1/clean/Badge';
import { S4PxC, measurePairs, judgePairs } from './index';

const measureFn = pxFn<never, never>('fn.S4.exp.axisLocal.measurePairs');
const judgeFn = pxFn<never, never>('fn.S4.exp.axisLocal.judgePairs');
const ops: OperationSpec[] = [
  {id:'S4.axisLocal.measure',kind:'measure',gate:'S4',unit:'TeeBadge',
    consumes:[TeePxC.objects.address,BadgePxC.objects.address],produces:[S4PxC.pairs.address],
    calculations:[measureFn.address],accessConformance:'exact'},
  {id:'S4.axisLocal.judge',kind:'decide',gate:'S4',unit:'TeeBadge',
    consumes:[S4PxC.pairs.address,TeePxC.objects.address],produces:[S4PxC.state.address],
    calculations:[judgeFn.address],accessConformance:'exact'}
];
const plan: CompiledExecutionPlan = {ops,bindings:{},
  planFingerprint:sha256HexSyncText(canonicalJson({experiment:'S4/axis-local',ops}))};
const runtime: OperationRuntime = {
  implementations:new Map<string,(pxc:PxC)=>void>([
    [ops[0].id,pxc=>pxc.set(S4PxC.pairs,measurePairs(pxc.get(TeePxC.objects),pxc.get(BadgePxC.objects)))],
    [ops[1].id,pxc=>pxc.set(S4PxC.state,judgePairs(pxc.get(S4PxC.pairs),pxc.get(TeePxC.objects)))]]),
  calculationBindings:new Map([
    [ops[0].id,[{address:measureFn.address,calculate:measurePairs}]],
    [ops[1].id,[{address:judgeFn.address,calculate:judgePairs}]]])
};

/** Projection uses retained state only, never reruns measurement or judgment. */
export function renderS4(pxc: PxC) {
  const image=pxc.get(ComponentPxC.image), state=pxc.get(S4PxC.state), tees=pxc.get(TeePxC.objects);
  const rgba=new Uint8ClampedArray(image.rgba);
  const dot=(x:number,y:number,color:readonly number[])=>{
    x=Math.round(x);y=Math.round(y);
    if(x>=0&&y>=0&&x<image.widthPx&&y<image.heightPx) rgba.set(color,(y*image.widthPx+x)*4);
  };
  for(const r of state.resolutions){
    const n=Math.ceil(r.distancePx);
    for(let i=0;i<=n;i++){
      const t=i/Math.max(n,1);
      const x=r.center[0]+t*(r.badgeCenter[0]-r.center[0]);
      const y=r.center[1]+t*(r.badgeCenter[1]-r.center[1]);
      dot(x,y,[0,220,110,255]);dot(x+1,y,[0,220,110,255]);
    }
    for(const pixel of r.ownedPx) rgba.set([0,240,160,255],pixel*4);
  }
  return [{label:'S4 local Tee to Badge rays',widthPx:image.widthPx,heightPx:image.heightPx,rgba,
    boxes:state.unresolvedTees.map(index=>({bbox:tees[index].bbox,color:[255,80,80,255] as const}))}];
}

export const stageContract: StageContract = {
  id:'S4',async execute(context){
    if(!context.pxc)throw new Error('S4/axis-local needs restored S3 PxC.');
    const pxc=context.pxc;
    const testimony=executeCompiledPlan(plan,pxc,nullFeatureContext,createMemorySink(),runtime);
    pxc.set(S4PxC.pcr,composePcr({id:'S4.exp.axis-local',title:'Visible Tee to Badge local resolution',
      tickIds:ops.map(op=>op.id)},plan,testimony));
    const state=pxc.get(S4PxC.state);
    return {pxc,panels:renderS4(pxc),receiptText:[
      'S4 EXPERIMENT: axis-local',`local resolutions: ${state.resolutions.length}`,
      `unresolved holes: ${state.unresolvedHoles.join(',')}`,state.assumption,
      'recovery: NOT RUN; no inferred pixels; no global Basket assignment; not frozen'].join('\n')};
  }
};
