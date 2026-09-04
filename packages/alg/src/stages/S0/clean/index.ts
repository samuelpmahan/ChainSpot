import { materializeComposite, type CompositeResult } from '../../../g0/composite';
import type { InputAsset } from '../../../g0/inputAsset';
import { toGrayRaster } from '../../../g0/inputAsset';
import { stripChromeProposal, type StripChromeResult } from '../../../g0/stripChrome';
import { canonicalJson } from '../../../detectors/threeFactor/hash';
import { nullFeatureContext } from '../../../detectors/threeFactor/features/types';
import { createExecBoard, type PxC } from '../../../exec/board';
import type { CompiledExecutionPlan } from '../../../exec/compile';
import type { OperationSpec, TickTestimony } from '../../../exec/contract';
import { executeCompiledPlanAsync, type OperationRuntime } from '../../../exec/gateway';
import { composePcr, type Pcr } from '../../../exec/pcr';
import { sha256HexSyncText } from '../../../exec/sha256';
import { createMemorySink } from '../../../exec/sink';

export const S0_SELECTED_INPUT_ADDRESS = 'px.source.selectedInput' as const;
export const S0_FULL_IMAGE_ADDRESS = 'px.source.fullImage' as const;
export const S0_CROPPED_IMAGE_ADDRESS = 'px.course.canonicalPixels' as const;

export const S0_DECODE_TICK: OperationSpec = {
	id: 'source.decodeFullImage',
	kind: 'materialize',
	gate: 'shared',
	unit: 'source-intake',
	consumes: [S0_SELECTED_INPUT_ADDRESS],
	produces: [S0_FULL_IMAGE_ADDRESS],
	calculations: ['fn.decodeFullImage'],
	accessConformance: 'exact',
	note: 'Decode is S0 sanitation: selected input becomes one usable FullImage.'
};

export const S0_CROP_TICK: OperationSpec = {
	id: 'source.cropUDiscChrome',
	kind: 'materialize',
	gate: 'shared',
	unit: 'source-intake',
	consumes: [S0_FULL_IMAGE_ADDRESS],
	produces: [S0_CROPPED_IMAGE_ADDRESS],
	calculations: ['fn.stripChromeProposal', 'fn.materializeComposite'],
	accessConformance: 'exact',
	note: 'Crop the decoded FullImage and materialize the CroppedImage in PxC.'
};

export const S0_CACHE_TICK: OperationSpec = {
	id: 'source.cacheFullImage',
	kind: 'materialize',
	gate: 'shared',
	unit: 'source-intake',
	consumes: [S0_FULL_IMAGE_ADDRESS],
	produces: [],
	calculations: ['fn.cacheFullImage'],
	accessConformance: 'exact',
	note: 'Write the decoded FullImage to cache after the CroppedImage has materialized.'
};

const S0_PLAN: CompiledExecutionPlan = {
	ops: [S0_DECODE_TICK, S0_CROP_TICK, S0_CACHE_TICK],
	planFingerprint: sha256HexSyncText(
		canonicalJson({ operations: [S0_DECODE_TICK, S0_CROP_TICK, S0_CACHE_TICK] })
	),
	bindings: {}
};

export interface S0FullImageCache {
	write(fullImage: InputAsset): void | Promise<void>;
}

export interface MemoryS0FullImageCache extends S0FullImageCache {
	get(imageId: string): InputAsset | undefined;
	has(imageId: string): boolean;
}

export function createMemoryS0FullImageCache(): MemoryS0FullImageCache {
	const images = new Map<string, InputAsset>();
	return {
		write(fullImage) {
			images.set(fullImage.imageId, fullImage);
		},
		get: (imageId) => images.get(imageId),
		has: (imageId) => images.has(imageId)
	};
}

export interface S0Stage {
	readonly pxc: PxC;
	readonly fullImageCache: S0FullImageCache;
}

/** Create S0's live world. Browser callers do this on page load. */
export function createS0Stage(
	pxc: PxC = createExecBoard(),
	fullImageCache: S0FullImageCache = createMemoryS0FullImageCache()
): S0Stage {
	return { pxc, fullImageCache };
}

export interface S0CropReceipt {
	readonly originalPx: { readonly width: number; readonly height: number };
	readonly cropMethod: StripChromeResult['source'];
	readonly upperRowsRemoved: number;
	readonly lowerRowsRemoved: number;
	readonly croppedPx: { readonly width: number; readonly height: number };
	readonly totalPxRemoved: number;
	readonly pctPxRemoved: number;
}

interface CropComputation {
	readonly croppedImage: CompositeResult;
	readonly crop: StripChromeResult;
	readonly receipt: S0CropReceipt;
}

export interface S0CropRun {
	readonly pxc: PxC;
	readonly fullImage: InputAsset;
	readonly croppedImage: CompositeResult;
	readonly crop: StripChromeResult;
	readonly cropReceipt: S0CropReceipt;
	readonly plan: CompiledExecutionPlan;
	readonly testimonies: readonly TickTestimony[];
	readonly decodeTestimony: TickTestimony;
	readonly testimony: TickTestimony;
	readonly cacheTestimony: TickTestimony;
	readonly pcr: Pcr;
}

export interface S0ReceiptTextContext {
	readonly inputLabel: string;
	readonly progression?: string;
}

export interface ExecuteS0Args<Source> {
	readonly stage: S0Stage;
	readonly source: Source;
	readonly decode: (source: Source) => Promise<InputAsset>;
}

/** Human replay of S0 in execution order. */
export function formatS0ReceiptText(run: S0CropRun, context: S0ReceiptTextContext): string {
	const cropWrites = run.testimony.writes
		.map((write) => `${write.address} (${write.kind})`)
		.join(', ');
	return [
		'S0 RECEIPT',
		`progression: ${context.progression ?? 'page load → decode FullImage → crop → PxC → cache FullImage'}`,
		`input: ${context.inputLabel}`,
		'sanitation: decode selected image → FullImage',
		`originalPx: ${run.cropReceipt.originalPx.width}x${run.cropReceipt.originalPx.height}`,
		`crop: UDisc chrome · ${run.cropReceipt.cropMethod}`,
		`rowsRemoved: upper=${run.cropReceipt.upperRowsRemoved} lower=${run.cropReceipt.lowerRowsRemoved}`,
		`croppedPx: ${run.cropReceipt.croppedPx.width}x${run.cropReceipt.croppedPx.height}`,
		`totalPxRemoved: ${run.cropReceipt.totalPxRemoved}`,
		`pctPxRemoved: ${run.cropReceipt.pctPxRemoved.toFixed(2)}%`,
		`PxC write: ${cropWrites}`,
		'cache write: FullImage (last)',
		`output: PxC · available=[${S0_CROPPED_IMAGE_ADDRESS}]`
	].join('\n');
}

async function cropFullImage(fullImage: InputAsset): Promise<CropComputation> {
	const crop = stripChromeProposal([toGrayRaster(fullImage)]);
	const croppedImage = await materializeComposite(
		[
			{
				rgba: fullImage.rgba,
				widthPx: fullImage.widthPx,
				heightPx: fullImage.heightPx,
				placement: { x: 0, y: 0 }
			}
		],
		crop.insets
	);
	const upperRowsRemoved = crop.insets?.top ?? 0;
	const lowerRowsRemoved = crop.insets?.bottom ?? 0;
	const originalPixelCount = fullImage.widthPx * fullImage.heightPx;
	const croppedPixelCount = croppedImage.widthPx * croppedImage.heightPx;
	const totalPxRemoved = originalPixelCount - croppedPixelCount;
	return {
		crop,
		croppedImage,
		receipt: {
			originalPx: { width: fullImage.widthPx, height: fullImage.heightPx },
			cropMethod: crop.source,
			upperRowsRemoved,
			lowerRowsRemoved,
			croppedPx: { width: croppedImage.widthPx, height: croppedImage.heightPx },
			totalPxRemoved,
			pctPxRemoved:
				originalPixelCount === 0 ? 0 : (totalPxRemoved / originalPixelCount) * 100
		}
	};
}

/** Run S0 inside the PxC created for it on page load; cache FullImage only after crop. */
export async function executeS0<Source>(args: ExecuteS0Args<Source>): Promise<S0CropRun> {
	const { stage, source, decode } = args;
	stage.pxc.set(S0_SELECTED_INPUT_ADDRESS, source);
	let crop: StripChromeResult | undefined;
	let cropReceipt: S0CropReceipt | undefined;

	const decodeFullImage = async (selected: Source) => decode(selected);
	const cacheFullImage = async (fullImage: InputAsset) => stage.fullImageCache.write(fullImage);
	const runtime: OperationRuntime = {
		implementations: new Map([
			[
				S0_DECODE_TICK.id,
				async (board) => {
					const selected = board.get<Source>(S0_SELECTED_INPUT_ADDRESS);
					board.set(S0_FULL_IMAGE_ADDRESS, await decodeFullImage(selected));
				}
			],
			[
				S0_CROP_TICK.id,
				async (board) => {
					const fullImage = board.get<InputAsset>(S0_FULL_IMAGE_ADDRESS);
					const computed = await cropFullImage(fullImage);
					crop = computed.crop;
					cropReceipt = computed.receipt;
					board.set(S0_CROPPED_IMAGE_ADDRESS, computed.croppedImage);
				}
			],
			[
				S0_CACHE_TICK.id,
				async (board) => {
					await cacheFullImage(board.get<InputAsset>(S0_FULL_IMAGE_ADDRESS));
				}
			]
		]),
		calculationBindings: new Map([
			[S0_DECODE_TICK.id, [{ address: 'fn.decodeFullImage', calculate: decodeFullImage }]],
			[
				S0_CROP_TICK.id,
				[
					{ address: 'fn.stripChromeProposal', calculate: stripChromeProposal },
					{ address: 'fn.materializeComposite', calculate: materializeComposite }
				]
			],
			[S0_CACHE_TICK.id, [{ address: 'fn.cacheFullImage', calculate: cacheFullImage }]]
		]),
		artifactExtractors: {
			[S0_CROP_TICK.id](board) {
				const output = board.get<CompositeResult>(S0_CROPPED_IMAGE_ADDRESS);
				return [
					{
						kind: 'rgba',
						id: `${S0_CROPPED_IMAGE_ADDRESS}.${output.imageId.slice(0, 12)}`,
						bytes: Uint8Array.from(output.rgba),
						dims: { width: output.widthPx, height: output.heightPx }
					}
				];
			}
		}
	};
	const sink = createMemorySink();
	const testimonies = await executeCompiledPlanAsync(
		S0_PLAN,
		stage.pxc,
		nullFeatureContext,
		sink,
		runtime
	);
	const fullImage = stage.pxc.get<InputAsset>(S0_FULL_IMAGE_ADDRESS);
	const croppedImage = stage.pxc.get<CompositeResult>(S0_CROPPED_IMAGE_ADDRESS);
	if (!crop || !cropReceipt) throw new Error('S0 crop completed without its inspection receipt.');
	const pcr = composePcr(
		{
			id: 'S0.full-to-cropped',
			title: 'Page load → decoded FullImage → cropped PxC',
			tickIds: S0_PLAN.ops.map((operation) => operation.id)
		},
		S0_PLAN,
		testimonies
	);
	return {
		pxc: stage.pxc,
		fullImage,
		croppedImage,
		crop,
		cropReceipt,
		plan: S0_PLAN,
		testimonies,
		decodeTestimony: testimonies[0],
		testimony: testimonies[1],
		cacheTestimony: testimonies[2],
		pcr
	};
}
