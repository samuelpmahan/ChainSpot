// Node-only S0 adapter. Kept behind @chainspot/alg/exec/node-intake so the
// browser-safe PxC/gateway barrel never imports node:fs or image decoders.

import { decodeNodeFile } from '../adapters/node';
import { canonicalJson } from '../detectors/threeFactor/hash';
import { nullFeatureContext } from '../detectors/threeFactor/features/types';
import type { InputAsset } from '../g0/inputAsset';
import { createExecBoard, type PxC } from './board';
import type { CompiledExecutionPlan } from './compile';
import type { OperationSpec, TickTestimony } from './contract';
import { executeCompiledPlanAsync, type OperationRuntime } from './gateway';
import { sha256HexSyncText } from './sha256';
import { createMemorySink } from './sink';

export const NODE_CANONICAL_INPUT_TICK: OperationSpec = {
	id: 'source.decodeCanonicalInput',
	kind: 'materialize',
	gate: 'shared',
	unit: 'source-intake',
	consumes: ['px.source.selectedFiles'],
	produces: ['px.source.decodedPixels', 'px.course.canonicalPixels'],
	calculations: ['fn.decodeNodeFile'],
	note:
		'Single-source LAB/Storybook intake: real Node decode; decoded pixels are already canonical because no crop/stitch was requested.'
};

const NODE_CANONICAL_INPUT_PLAN: CompiledExecutionPlan = {
	ops: [NODE_CANONICAL_INPUT_TICK],
	planFingerprint: sha256HexSyncText(canonicalJson({ operations: [NODE_CANONICAL_INPUT_TICK] })),
	bindings: {}
};

export interface NodeCanonicalInputTickResult {
	readonly pxc: PxC;
	readonly input: InputAsset;
	readonly plan: CompiledExecutionPlan;
	readonly testimony: TickTestimony;
}

/**
 * Execute the real Node decoder through the production gateway. The supplied
 * PxC is returned so S1 can seed legacy aliases over the exact same RGBA bytes.
 */
export async function executeNodeCanonicalInputTick(
	filePath: string,
	pxc: PxC = createExecBoard()
): Promise<NodeCanonicalInputTickResult> {
	pxc.set('px.source.selectedFiles', [filePath]);
	const runtime: OperationRuntime = {
		implementations: new Map([
			[
				NODE_CANONICAL_INPUT_TICK.id,
				async (board) => {
					const selected = board.get<readonly string[]>('px.source.selectedFiles');
					if (selected.length !== 1)
						throw new Error(
							`source.decodeCanonicalInput requires exactly one selected file; got ${selected.length}.`
						);
					const decoded = await decodeNodeFile(selected[0]);
					board.set('px.source.decodedPixels', decoded);
					board.set('px.course.canonicalPixels', decoded);
				}
			]
		]),
		calculationBindings: new Map([
			[
				NODE_CANONICAL_INPUT_TICK.id,
				[{ address: 'fn.decodeNodeFile', calculate: decodeNodeFile }]
			]
		]),
		artifactExtractors: {
			[NODE_CANONICAL_INPUT_TICK.id](board) {
				const decoded = board.get<InputAsset>('px.course.canonicalPixels');
				return [
					{
						kind: 'rgba',
						id: `px.course.canonicalPixels.${decoded.imageId.slice(0, 12)}`,
						bytes: Uint8Array.from(decoded.rgba),
						dims: { width: decoded.widthPx, height: decoded.heightPx }
					}
				];
			}
		}
	};
	const sink = createMemorySink();
	const [testimony] = await executeCompiledPlanAsync(
		NODE_CANONICAL_INPUT_PLAN,
		pxc,
		nullFeatureContext,
		sink,
		runtime
	);
	const input = pxc.get<InputAsset>('px.course.canonicalPixels');
	return { pxc, input, plan: NODE_CANONICAL_INPUT_PLAN, testimony };
}
