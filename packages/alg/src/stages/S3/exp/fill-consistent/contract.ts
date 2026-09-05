import { canonicalJson } from '../../../../detectors/threeFactor/hash';
import { nullFeatureContext } from '../../../../detectors/threeFactor/features/types';
import { executeCompiledPlan, type OperationRuntime } from '../../../../exec/gateway';
import type { CompiledExecutionPlan } from '../../../../exec/compile';
import { pxFn, type PxC } from '../../../../exec/board';
import { composePcr } from '../../../../exec/pcr';
import { sha256HexSyncText } from '../../../../exec/sha256';
import { createMemorySink } from '../../../../exec/sink';
import type { StageContract } from '../../../contract';
import { ComponentPxC } from '../../../componentPxC';
import { Tee, TeeFn, TeePxC, registerTee, type TeeFrameMeasure } from '../../clean/Tee';
import { S3_DETECT_RINGS_TICK, S3_FIND_FAMILY_TICK, S3_FIND_PX_TICK, materializeS3Subtraction } from '../../clean';
import { selectFillConsistentTeeFamily } from './index';

const selectFn = pxFn<readonly TeeFrameMeasure[], ReturnType<typeof selectFillConsistentTeeFamily>>('fn.Tee.exp.fillConsistent');
const ops = [S3_DETECT_RINGS_TICK, {
  ...S3_FIND_FAMILY_TICK,
  id: 'Tee.exp.fillConsistent',
  calculations: [TeeFn.findFamily.address, selectFn.address],
  note: 'Reuse clean ring-to-frame measurement, then select using the retained experimental fill dimension.'
}, S3_FIND_PX_TICK];
const plan: CompiledExecutionPlan = {
  ops, bindings: {},
  planFingerprint: sha256HexSyncText(canonicalJson({ experiment: 'S3/fill-consistent', ops }))
};

export const stageContract: StageContract = {
  id: 'S3',
  async execute(context) {
    if (!context.pxc) throw new Error('S3/fill-consistent requires prior Stage PxC.');
    const pxc = context.pxc;
    registerTee(pxc);
    pxc.register(selectFn, selectFillConsistentTeeFamily);
    const runtime: OperationRuntime = {
      implementations: new Map<string, (board: PxC) => void>([
        [ops[0].id, board => board.set(TeePxC.rings, Tee.detectRings(board))],
        [ops[1].id, board => {
          const measured = Tee.findFamily(board);
          const selected = board.call(selectFn, measured.measured);
          board.set(TeePxC.family, { ...measured, ...selected });
        }],
        [ops[2].id, board => board.set(TeePxC.objects, Tee.findPx(board))]
      ]),
      calculationBindings: new Map([
        [ops[0].id, [{ address: TeeFn.detectRings.address, calculate: Tee.detectRings }]],
        [ops[1].id, [{ address: TeeFn.findFamily.address, calculate: Tee.findFamily },
          { address: selectFn.address, calculate: selectFillConsistentTeeFamily }]],
        [ops[2].id, [{ address: TeeFn.findPx.address, calculate: Tee.findPx }]]
      ])
    };
    const testimonies = executeCompiledPlan(plan, pxc, nullFeatureContext, createMemorySink(), runtime);
    const pcr = composePcr({ id: 'S3.exp.fill-consistent', title: 'Experimental fill-consistent Tee family', tickIds: ops.map(op => op.id) }, plan, testimonies);
    pxc.set('px.tees.exp.pcr', pcr);
    pxc.set('px.tees.exp.selectionFn', selectFn.address);
    const image = pxc.get(ComponentPxC.image);
    const family = pxc.get(TeePxC.family);
    const tees = pxc.get(TeePxC.objects);
    const sub = materializeS3Subtraction(image, tees);
    const panel = { widthPx: image.widthPx, heightPx: image.heightPx, rgba: image.rgba };
    return {
      pxc,
      receiptText: [
        'S3 EXPERIMENT RECEIPT', 'variant: fill-consistent', `input: ${context.inputLabel}`,
        `measured frames: ${family.measured.length}`, `Tee objects: ${tees.length}`,
        `selection: ${selectFn.address}`, `plan: ${plan.planFingerprint}`,
        'recovery: NOT RUN', 'semantic correctness: UNKNOWN',
        'source PxC pixels: unchanged; subtraction is Materialization only'
      ].join('\n'),
      panels: [
        { ...panel, label: 'CroppedImage' },
        { ...panel, label: 'Selected experimental Tees', boxes: tees.map(tee => ({ bbox: tee.bbox, color: [168, 85, 247, 255] as const })) },
        { ...sub, label: 'TeePx subtraction' }
      ]
    };
  }
};
