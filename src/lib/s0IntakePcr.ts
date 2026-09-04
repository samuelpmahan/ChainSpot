import { decodeBrowserFile } from '@chainspot/alg/adapters/browser';
import type { InputAsset } from '@chainspot/alg/g0/inputAsset';
import {
	createS0Stage,
	executeS0,
	S0_CROPPED_IMAGE_ADDRESS,
	type S0CropRun,
	type S0Stage
} from '@chainspot/alg/exec';

export const S0_TO_S1_ADDRESS = S0_CROPPED_IMAGE_ADDRESS;

export type BrowserImageDecoder = (file: File) => Promise<InputAsset>;

export interface S0IntakeRunArgs {
	readonly selectedFiles: readonly File[];
	readonly stage?: S0Stage;
	readonly decode?: BrowserImageDecoder;
}

export interface S0IntakePcrRun extends S0CropRun {
	readonly file: File;
}

/** Smallest S0: one full browser image enters PxC; one real Tick crops UDisc chrome. */
export async function runS0IntakePcr(args: S0IntakeRunArgs): Promise<S0IntakePcrRun> {
	if (args.selectedFiles.length !== 1) {
		throw new Error(
			`S0 full-to-cropped requires exactly one image; got ${args.selectedFiles.length}.`
		);
	}
	const file = args.selectedFiles[0];
	const run = await executeS0({
		stage: args.stage ?? createS0Stage(),
		source: file,
		decode: args.decode ?? decodeBrowserFile
	});
	return { ...run, file };
}
