import { canonicalJson } from '../../../../detectors/threeFactor/hash';
import { nullFeatureContext } from '../../../../detectors/threeFactor/features/types';
import { executeCompiledPlan, type OperationRuntime } from '../../../../exec/gateway';
import type { CompiledExecutionPlan } from '../../../../exec/compile';
import { pxFn, pxKey, type PxC } from '../../../../exec/board';
import { composePcr } from '../../../../exec/pcr';
import { sha256HexSyncText } from '../../../../exec/sha256';
import { createMemorySink } from '../../../../exec/sink';
import type { StageContract } from '../../../contract';
import { ComponentPxC } from '../../../componentPxC';
import { BadgePxC } from '../../../S1/clean/Badge';
import { BasketPxC } from '../../../S2/clean/Basket';
import { Tee, TeeFn, TeePxC, registerTee } from '../../clean/Tee';
import { S3_DETECT_RINGS_TICK, S3_FIND_FAMILY_TICK, S3_FIND_PX_TICK } from '../../clean';
import { observeInterior, composeInterior, SENSOR_FN, COMPOSE_FN, type SensorInput, type InteriorObservation, type BenchTee } from './index';

const observation = pxKey<InteriorObservation>('px.tees.exp.interior');
const sensorFn = pxFn<SensorInput,InteriorObservation>(SENSOR_FN);
const composeFn = pxFn<{tees:readonly Tee[];observation:InteriorObservation},readonly BenchTee[]>(COMPOSE_FN);
const ops = [S3_DETECT_RINGS_TICK,S3_FIND_FAMILY_TICK,S3_FIND_PX_TICK,{
  id:'Tee.exp.interiorCore',kind:'measure' as const,gate:'S3' as const,unit:'Tee',
  consumes:[ComponentPxC.image.address,ComponentPxC.fields.address,TeePxC.objects.address,BadgePxC.objects.address,BasketPxC.objects.address],
  produces:[observation.address],calculations:[sensorFn.address],accessConformance:'exact' as const,
  note:'Learn interior-color sensor; preserve accepted/rejected source-pixel components and existing screen-chrome parent testimony.'
},{
  id:'Tee.exp.composeInteriorCore',kind:'transform' as const,gate:'S3' as const,unit:'Tee',
  consumes:[TeePxC.objects.address,observation.address],produces:['px.tees.exp.objects'],calculations:[composeFn.address],accessConformance:'exact' as const,
  note:'Keep non-chrome baseline Tees, add observed interior fragments; never infer an unseen complete pose or claim white-support ownership.'
}];
const plan:CompiledExecutionPlan={ops,bindings:{},planFingerprint:sha256HexSyncText(canonicalJson({experiment:'S3/interior-core',ops}))};
export const stageContract: StageContract = {
  id:'S3',
  async execute(context) {
    if(!context.pxc) throw new Error('S3/interior-core requires upstream PxC.');
    const pxc=context.pxc;
    registerTee(pxc); pxc.register(sensorFn,observeInterior); pxc.register(composeFn,composeInterior);
    const runtime:OperationRuntime={
      implementations:new Map<string,(b:PxC)=>void>([
        [ops[0].id,b=>b.set(TeePxC.rings,Tee.detectRings(b))],
        [ops[1].id,b=>b.set(TeePxC.family,Tee.findFamily(b))],
        [ops[2].id,b=>b.set(TeePxC.objects,Tee.findPx(b))],
        [ops[3].id,b=>b.set(observation,b.call(sensorFn,{image:b.get(ComponentPxC.image),fields:b.get(ComponentPxC.fields),tees:b.get(TeePxC.objects),badges:b.get(BadgePxC.objects),baskets:b.get(BasketPxC.objects)}))],
        [ops[4].id,b=>b.set('px.tees.exp.objects',b.call(composeFn,{tees:b.get(TeePxC.objects),observation:b.get(observation)}))]
      ]),
      calculationBindings:new Map([
        [ops[0].id,[{address:TeeFn.detectRings.address,calculate:Tee.detectRings}]],
        [ops[1].id,[{address:TeeFn.findFamily.address,calculate:Tee.findFamily}]],
        [ops[2].id,[{address:TeeFn.findPx.address,calculate:Tee.findPx}]],
        [ops[3].id,[{address:sensorFn.address,calculate:observeInterior}]],
        [ops[4].id,[{address:composeFn.address,calculate:composeInterior}]]
      ])
    };
    const testimony=executeCompiledPlan(plan,pxc,nullFeatureContext,createMemorySink(),runtime);
    const pcr=composePcr({id:'S3.exp.interior-core',title:'Interior evidence challenges closed-ring completeness',tickIds:ops.map(o=>o.id)},plan,testimony);
    pxc.set('px.tees.exp.pcr',pcr); pxc.set('px.tees.exp.selectionFn',composeFn.address);
    const image=pxc.get(ComponentPxC.image), obs=pxc.get(observation), tees=pxc.get<readonly BenchTee[]>('px.tees.exp.objects');
    const audit={prototype:obs.prototype,palette:obs.palette,prototypeSamples:obs.prototypeSamples,knobs:obs.knobs,chrome:obs.chrome,
      candidates:obs.candidates.map(c=>({id:c.id,component:c.component,ownedInteriorPx:c.pixels.length,whiteSupportPx:c.whiteSupport.length,whiteSupportFraction:c.whiteSupportFraction,uniformCorePixels:c.uniformCorePixels,accepted:c.accepted,reason:c.reason}))};
    pxc.set('px.tees.exp.audit',audit);
    const rgba=new Uint8ClampedArray(image.rgba);
    for(const tee of tees) for(const p of tee.px) rgba[p*4+3]=0;
    const panel={widthPx:image.widthPx,heightPx:image.heightPx,rgba:image.rgba};
    return {pxc,receiptText:['S3 EXPERIMENT RECEIPT','variant: interior-core',`prototype: ${obs.prototype?.join(',') ?? 'UNKNOWN'}`,`Tee objects: ${tees.length}`,`new partial interior observations: ${obs.candidates.filter(c=>c.accepted&&!c.overlapsBaseline).length}`,'complete poses for new objects: UNKNOWN','recovery: PARTIAL OBSERVATION ONLY; no invisible geometry','subtraction: exact retained observed pixels only; white-support ownership not claimed',`plan: ${plan.planFingerprint}`].join('\n'),panels:[
      {...panel,label:'CroppedImage'},
      {...panel,label:'Accepted interior components',boxes:obs.candidates.filter(c=>c.accepted).map(c=>({bbox:[c.component.bboxX,c.component.bboxY,c.component.bboxW,c.component.bboxH] as const,color:[34,211,238,255] as const}))},
      {...panel,label:'Rejected interior components',boxes:obs.candidates.filter(c=>!c.accepted).map(c=>({bbox:[c.component.bboxX,c.component.bboxY,c.component.bboxW,c.component.bboxH] as const,color:[249,115,22,255] as const}))},
      {...panel,label:'Tee objects',boxes:tees.map(t=>({bbox:t.bbox,color:[168,85,247,255] as const}))},
      {...panel,rgba,label:'Observed TeePx subtraction'}
    ]};
  }
};
