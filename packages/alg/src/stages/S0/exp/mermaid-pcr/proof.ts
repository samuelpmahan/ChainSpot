import { isDeepStrictEqual } from 'node:util';
import { createS0Stage, executeS0 } from '../../clean';
import { invokePql, readPql } from '../../../../exec/pql';
import type { InputAsset } from '../../../../g0/inputAsset';
import type { CompositeResult } from '../../../../g0/composite';
import { compileMermaidPcr } from './compiler';
import { executeMermaidYaml, prepareS1, runMermaidS0 } from './runner';
import { S1_OUTPUT_ADDRESSES } from './compare';

export async function compareProof<Source>(args: {
 source: Source; decode: (source: Source) => Promise<InputAsset>;
 s0Graph: string; s0Args: string; s1Graph: string; s1Args: string; existingS1: string;
}) {
 const s0Yaml = compileMermaidPcr(args.s0Graph, args.s0Args);
 const s1Yaml = compileMermaidPcr(args.s1Graph, args.s1Args);
 let baselineDecodes = 0, generatedDecodes = 0;
 const baseline = await executeS0({ stage: createS0Stage(), source: args.source,
  decode: async source => { baselineDecodes++; return args.decode(source); } });
 const generated = await runMermaidS0(args.source, async source => { generatedDecodes++; return args.decode(source); }, s0Yaml);
 const canonical = generated.pxc.get<CompositeResult>('px.course.canonicalPixels');
 prepareS1(baseline.pxc); prepareS1(generated.pxc);
 const baselineS1 = invokePql(readPql(args.existingS1), { pxc: baseline.pxc });
 const generatedS1 = await executeMermaidYaml(s1Yaml, generated.pxc);
 const baselineCalls = baselineS1.Ticks.flatMap(t => t.Calculations);
 const generatedCalls = generatedS1.calls.filter(c => c.call !== 'fn.s0.asMaskRaster');
 const decode = generated.run.calls.find(c => c.id === 'decode');
 const bounds = generated.run.calls.find(c => c.id === 'bounds');
 const crop = generated.run.calls.find(c => c.id === 'crop');
 const checks = {
  canonicalPixels: canonical.widthPx === baseline.croppedImage.widthPx && canonical.heightPx === baseline.croppedImage.heightPx && isDeepStrictEqual(canonical.rgba, baseline.croppedImage.rgba),
  cropBounds: isDeepStrictEqual(bounds?.output, baseline.crop),
  decodeOnce: baselineDecodes === 1 && generatedDecodes === 1,
  directImageIdentity: !!decode && !!bounds && !!crop && decode.output === bounds.inputs.image && decode.output === crop.inputs.image,
  fullImageLocal: !generated.pxc.has('px.source.fullImage'),
  s1Composition: baselineCalls.length === generatedCalls.length && baselineCalls.every((c, i) => {
   const g = generatedCalls[i];
   return c.call === g.call && c.into === g.into && isDeepStrictEqual(c.args, g.args) &&
    isDeepStrictEqual(c.with, Object.fromEntries(Object.entries(g.bindings).map(([key, b]) => [key, b.ref])));
  }),
  s1IntermediateValues: baselineCalls.length === generatedCalls.length && baselineCalls.every((c, i) => isDeepStrictEqual(c.output, generatedCalls[i].output)),
  ...Object.fromEntries(S1_OUTPUT_ADDRESSES.map(address => [address, isDeepStrictEqual(baseline.pxc.get(address), generated.pxc.get(address))]))
 };
 return { ok: Object.values(checks).every(Boolean), checks, s0Yaml, s1Yaml, baseline, generated, generatedS1 };
}
