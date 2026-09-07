import { parse } from 'yaml';
import { createExecBoard, pxFn, type PxC } from '../../../../exec/board';
import { toGrayRaster, type InputAsset } from '../../../../g0/inputAsset';
import { stripChromeProposal, type StripChromeResult } from '../../../../g0/stripChrome';
import { materializeComposite, type CompositeResult } from '../../../../g0/composite';
import { prepareBadgeAssemblyExp } from '../../../S1/exp/badge-assembly';
import { prepareWhiteRecognition } from '../../../S1/exp/badge-assembly/white-recognition';
import { prepareBadgeOwnership } from '../../../S1/exp/badge-assembly/ownership';
import type { RasterPart } from '../../../S1/exp/mask-components';

interface Binding { kind: 'fn' | 'px'; ref: string }
interface Calculation { id: string; call: `fn.${string}`; with: Record<string, Binding>; args: Record<string, unknown>; into?: string }
interface Composition { PrincipleComponentRender: string; Ticks: { name: string; Calculations: Calculation[] }[] }
export interface CallRecord {
 tick: string; id: string; call: string; args: Record<string, unknown>;
 bindings: Record<string, Binding>; inputs: Record<string, unknown>; into?: string;
 output?: unknown; status: 'running' | 'succeeded' | 'failed'; error?: string;
}
export interface RunRecord { name: string; calls: CallRecord[]; status: 'running' | 'succeeded' | 'failed' }
export class MermaidExecutionError extends Error {
 constructor(public readonly run: RunRecord, cause: unknown) {
  super(`Mermaid PCR ${run.name} failed at ${run.calls.at(-1)?.id}`, { cause });
 }
}
/** Experimental interpreter for compiler output. Actual values remain in the returned record,
 * never in a PxC run-record address. This is not yet the shared PQL executor. */
export async function executeMermaidYaml(yaml: string, pxc: PxC): Promise<RunRecord> {
 const composition = parse(yaml) as Composition;
 const run: RunRecord = { name: composition.PrincipleComponentRender, calls: [], status: 'running' };
 const values = new Map<string, unknown>();
 for (const tick of composition.Ticks) for (const calculation of tick.Calculations) {
  const record: CallRecord = { tick: tick.name, id: calculation.id, call: calculation.call,
   bindings: calculation.with, args: calculation.args, inputs: {}, into: calculation.into, status: 'running' };
  run.calls.push(record);
  try {
   if (values.has(calculation.id)) throw new Error(`Duplicate occurrence '${calculation.id}'.`);
   for (const [name, binding] of Object.entries(calculation.with)) {
    if (Object.hasOwn(calculation.args, name)) throw new Error(`Argument shadows '${name}'.`);
    if (binding.kind === 'fn') {
     if (!values.has(binding.ref)) throw new Error(`Missing preceding result '${binding.ref}'.`);
     record.inputs[name] = values.get(binding.ref);
    } else if (binding.kind === 'px') record.inputs[name] = pxc.get(binding.ref);
    else throw new Error(`Unknown binding kind for '${name}'.`);
   }
   record.output = await pxc.call(pxFn<Record<string, unknown>, unknown>(calculation.call), { ...calculation.args, ...record.inputs });
   values.set(calculation.id, record.output);
   if (calculation.into) pxc.set(calculation.into, record.output);
   record.status = 'succeeded';
  } catch (cause) {
   record.status = 'failed'; record.error = String(cause); run.status = 'failed';
   throw new MermaidExecutionError(run, cause);
  }
 }
 run.status = 'succeeded';
 return run;
}

export function asMaskRaster(image: CompositeResult): RasterPart {
 return { id: 'cropped-raster', address: 'px.s1.exp.maskComponents.part.croppedRaster', kind: 'cropped-raster',
  widthPx: image.widthPx, heightPx: image.heightPx, coordinateFrameId: 'px.course.canonicalPixels', pixels: image.rgba,
  pixelFormat: 'rgba-8', sourceAddress: 'px.course.canonicalPixels', sourceTickId: null };
}
export function prepareS1(pxc: PxC): void {
 prepareBadgeAssemblyExp(pxc); prepareWhiteRecognition(pxc); prepareBadgeOwnership(pxc);
 pxc.register(pxFn<{ image: CompositeResult }, RasterPart>('fn.s0.asMaskRaster'), ({ image }) => asMaskRaster(image));
}
export async function runMermaidS0<Source>(source: Source, decode: (source: Source) => Promise<InputAsset>, yaml: string) {
 const pxc = createExecBoard();
 pxc.set('px.source.selectedInput', source);
 pxc.register(pxFn<{ source: Source }, Promise<InputAsset>>('fn.s0.decodeFullImage'), ({ source }) => decode(source));
 pxc.register(pxFn<{ image: InputAsset }, StripChromeResult>('fn.s0.findChromeBounds'), ({ image }) => stripChromeProposal([toGrayRaster(image)]));
 pxc.register(pxFn<{ image: InputAsset; bounds: StripChromeResult }, Promise<CompositeResult>>('fn.s0.applyCrop'),
  ({ image, bounds }) => materializeComposite([{ rgba: image.rgba, widthPx: image.widthPx, heightPx: image.heightPx, placement: { x: 0, y: 0 } }], bounds.insets));
 const run = await executeMermaidYaml(yaml, pxc);
 return { pxc, run };
}
