import { describe, expect, test } from 'vitest';
import {
	compareMermaidS0Runs,
	S1_OUTPUT_ADDRESSES,
	validateNamedFunctionBindings,
	type MermaidRun
} from '../../packages/alg/src/stages/S0/exp/mermaid-pcr/compare';

const run = (overrides: Partial<MermaidRun> = {}): MermaidRun => ({
	canonicalPixels: { widthPx: 2, heightPx: 1, rgba: Uint8Array.from([1, 2, 3, 255, 4, 5, 6, 255]) },
	badges: [{ id: 'badge-1', label: '12' }],
	outputAddresses: [...S1_OUTPUT_ADDRESSES],
	cropBounds: { left: 0, top: 3, right: 2, bottom: 21 },
	trace: {
		namedCalls: ['fn.decodeFullImage', 'fn.stripChromeProposal', 'fn.applyCrop'],
		decodeCount: 1,
		fullImagePxCPublished: false,
		sameFullImageAtBoundsAndApply: true
	},
	...overrides
});

describe('S0 Mermaid PCR comparison proof', () => {
	test('accepts parity for canonical pixels, S1 outputs, crop, calls, and locality', () => {
		const parity = compareMermaidS0Runs(run(), run());
		expect(parity.ok).toBe(true);
		expect(parity.differences).toEqual([]);
	});

	test('reports pixel, decode, and FullImage publication differences', () => {
		const parity = compareMermaidS0Runs(
			run(),
			run({
				canonicalPixels: { widthPx: 2, heightPx: 1, rgba: Uint8Array.from([9, 2, 3, 255, 4, 5, 6, 255]) },
				trace: {
					namedCalls: ['fn.decodeFullImage'],
					decodeCount: 2,
					fullImagePxCPublished: true,
					sameFullImageAtBoundsAndApply: false
				}
			})
		);
		expect(parity.ok).toBe(false);
		expect(parity.differences).toEqual(
			expect.arrayContaining([
				'canonical pixel bytes or dimensions differ',
				'named call sequence differs',
				'decode count is not exactly one per run',
				'FullImage locality or identity proof failed'
			])
		);
	});

	test('rejects malformed and conflicting function binding metadata', () => {
		expect(() => validateNamedFunctionBindings([{ address: 'stripChrome', implementationId: 'a' }])).toThrow(
			/malformed function address/
		);
		expect(() =>
			validateNamedFunctionBindings([
				{ address: 'fn.crop', implementationId: 'a' },
				{ address: 'fn.crop', implementationId: 'b' }
			])
		).toThrow(/reused with conflicting implementations/);
		expect(() =>
			validateNamedFunctionBindings([
				{ address: 'fn.findRelated', implementationId: 'same' },
				{ address: 'fn.findRelated', implementationId: 'same' }
			])
		).not.toThrow();
	});
});

import { compileMermaidPcr } from '../../packages/alg/src/stages/S0/exp/mermaid-pcr/compiler';
import { executeMermaidYaml, MermaidExecutionError } from '../../packages/alg/src/stages/S0/exp/mermaid-pcr/runner';
import { createExecBoard, pxFn } from '../../packages/alg/src/exec/board';

const directGraph = `flowchart TD
source["px.source"]
subgraph S0["PCR: S0"]
subgraph Decode["Tick: Decode"]
decode["fn.decode"]
end
subgraph Crop["Tick: Crop"]
bounds["fn.bounds"]
crop["fn.crop"]
end
end
source -->|source| decode
decode -->|image| bounds
decode -->|image| crop
bounds -->|bounds| crop
crop --> output["px.output"]`;

test('awaits one decoded result shared across Ticks, and isolates repeated invocations', async () => {
 const pxc = createExecBoard();
 pxc.set('px.source', 'fixture');
 const images: object[] = [];
 pxc.register(pxFn<Record<string, unknown>, Promise<object>>('fn.decode'), async () => { const image = {}; images.push(image); return image; });
 pxc.register(pxFn<{ image: object }, { original: object }>('fn.bounds'), ({ image }) => ({ original: image }));
 pxc.register(pxFn<{ image: object; bounds: { original: object } }, boolean>('fn.crop'), ({ image, bounds }) => image === bounds.original);
 const yaml = compileMermaidPcr(directGraph, '{}');
 const first = await executeMermaidYaml(yaml, pxc);
 const second = await executeMermaidYaml(yaml, pxc);
 expect(images).toHaveLength(2);
 expect(first.calls[0].output).not.toBe(second.calls[0].output);
 expect(pxc.get('px.output')).toBe(true);
 expect(pxc.has('px.source.fullImage')).toBe(false);
});

test('retains successful prefix and actual failing occurrence', async () => {
 const pxc = createExecBoard(); pxc.set('px.source', 1);
 pxc.register(pxFn('fn.decode'), async () => ({ pixels: 1 }));
 pxc.register(pxFn('fn.bounds'), () => { throw new Error('deliberate failure'); });
 try { await executeMermaidYaml(compileMermaidPcr(directGraph, '{}'), pxc); throw new Error('expected failure'); }
 catch (error) {
  expect(error).toBeInstanceOf(MermaidExecutionError);
  const run = (error as MermaidExecutionError).run;
  expect(run.calls.map(c => c.status)).toEqual(['succeeded', 'failed']);
  expect(run.calls[1].inputs.image).toBe(run.calls[0].output);
 }
});

test('rejects ambiguous inputs and forward dependencies', () => {
 expect(() => compileMermaidPcr(directGraph + '\nsource -->|image| crop', '{}')).toThrow(/duplicate input/);
 expect(() => compileMermaidPcr(directGraph + '\ncrop -->|cycle| decode', '{}')).toThrow(/forward dependency or cycle/);
 expect(() => compileMermaidPcr(directGraph, '{"typo":{}}')).toThrow(/unknown argument occurrence/);
});
