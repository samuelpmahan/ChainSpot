// Node-only adapter for the smallest real S0. The frozen browser-safe Stage
// lives under stages/S0/clean; this file contributes filesystem decode.

import { decodeNodeFile } from '../adapters/node';
import type { CompositeResult } from '../g0/composite';
import type { OperationSpec } from './contract';
import {
	createS0Stage,
	executeS0,
	S0_CROP_TICK,
	type S0CropRun,
	type S0FullImageCache
} from '../stages/S0/clean';

/** Compatibility export retained for existing Storybook evidence callers. */
export const NODE_CANONICAL_INPUT_TICK: OperationSpec = S0_CROP_TICK;

export interface NodeCanonicalInputTickResult extends S0CropRun {
	/** The cropped pixels handed to S1. */
	readonly input: CompositeResult;
}

/** Decode outside PxC, sanitize, then make the cropped pixels PxC's first image value. */
export async function executeNodeCanonicalInputTick(
	filePath: string,
	fullImageCache?: S0FullImageCache
): Promise<NodeCanonicalInputTickResult> {
	const run = await executeS0({
		stage: createS0Stage(undefined, fullImageCache),
		source: filePath,
		decode: decodeNodeFile
	});
	return { ...run, input: run.croppedImage };
}
