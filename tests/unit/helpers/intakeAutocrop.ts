// Test-only, verbatim-copied subset of the OLD pipeline's single-image
// chrome autocrop, reproduced here ONLY to put a raw corpus screenshot back
// into the frame its annotation truth was made in.
//
// Why this exists: `chainspot-corpus/dev/Annotated/{Heritage,Lenard,
// TowneLake}` ship the RAW, un-autocropped phone screenshot (measured
// 1290x2796px for all three), while their annotation JSON's `sourceImage`
// records the POST-autocrop frame (Heritage 1290x2115, Lenard 1290x2089,
// TowneLake 1290x2012 — top/bottom UDisc app chrome removed). Feeding the
// raw image straight to the engine and comparing against that truth
// produces a ~680-780px systematic vertical offset that is a COORDINATE
// FRAME MISMATCH, not a detection result — exactly the failure mode
// documented in `old-stuff/scripts/pancake-harness.ts`'s file header
// ("~400-530px per-hole coordinate errors... a frame mismatch, not a real
// detection/pipeline failure. DashsTrack needs no autocrop"). DashsTrack
// and AlexClark's raw dims already equal their annotation's dims, so they
// skip this step entirely (see courseFixture.ts).
//
// The functions below are copied, not reimplemented, from:
//   - old-stuff/src/lib/stitch/autoCrop.ts (median, smoothedRowEntropy,
//     analyzeVerticalEntropy, usePerImageEntropyVerticalCrop,
//     proposeSingleImageCrop, and the ENTROPY_*/MAX_INSET_FRACTION/
//     MIN_ORIGINAL_BAND_PX constants they use — the single-image entropy
//     vertical-band detector only; the multi-tile cross-consensus code in
//     that file is not needed here and was not copied)
//   - old-stuff/scripts/toph-run.ts:91-109 (`autocropLikeIntake`: grayscale
//     conversion + applying the proposed insets, and the frame-mismatch
//     validation pattern at toph-run.ts:211-224)
// Copied verbatim (not re-derived) so the crop this test applies is
// byte-identical to what the old pipeline's corpus-benchmark scripts
// already validated against these exact annotations, rather than a new,
// unvalidated reimplementation.
//
// This file is not imported by, and does not modify, any engine/source
// file or old-stuff file.

const ENTROPY_BINS = 16;
const ENTROPY_THRESHOLD_RATIO = 0.74;
const ENTROPY_SMOOTH_RADIUS = 1;
const ENTROPY_RUN_LINES = 6;
const ENTROPY_REQUIRED_LINES = 4;
const ENTROPY_INWARD_SAFETY_PX = 1;
const MAX_INSET_FRACTION = 0.2;
const MIN_ORIGINAL_BAND_PX = 2;

interface AnalysisRaster {
	readonly widthPx: number;
	readonly heightPx: number;
	readonly gray: Uint8Array;
	readonly scale: number;
}

interface CropInsets {
	readonly topPx: number;
	readonly rightPx: number;
	readonly bottomPx: number;
	readonly leftPx: number;
}

interface SingleImageCropProposal {
	readonly insets: CropInsets | null;
	readonly confidence: 'high' | 'low' | 'absent';
}

interface EntropyVerticalBounds {
	readonly topPx: number | null;
	readonly bottomPx: number | null;
}

function median(values: readonly number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function smoothedRowEntropy(raster: AnalysisRaster): number[] {
	const { widthPx: width, heightPx: height, gray } = raster;
	const entropy = new Array<number>(height);
	const shift = 8 - Math.log2(ENTROPY_BINS);

	for (let y = 0; y < height; y += 1) {
		const histogram = new Uint32Array(ENTROPY_BINS);
		const base = y * width;
		let samples = 0;
		for (let x = 0; x < width; x += 2) {
			histogram[gray[base + x] >> shift] += 1;
			samples += 1;
		}
		let value = 0;
		for (const count of histogram) {
			if (count === 0) continue;
			const p = count / samples;
			value -= p * Math.log2(p);
		}
		entropy[y] = value;
	}

	return entropy.map((_, y) => {
		let sum = 0;
		let count = 0;
		for (
			let row = Math.max(0, y - ENTROPY_SMOOTH_RADIUS);
			row <= Math.min(height - 1, y + ENTROPY_SMOOTH_RADIUS);
			row += 1
		) {
			sum += entropy[row];
			count += 1;
		}
		return sum / count;
	});
}

function analyzeVerticalEntropy(raster: AnalysisRaster): EntropyVerticalBounds {
	const entropy = smoothedRowEntropy(raster);
	const height = raster.heightPx;
	const reference = median(entropy.slice(Math.floor(height * 0.35), Math.floor(height * 0.65)));
	const threshold = reference * ENTROPY_THRESHOLD_RATIO;

	let topBoundary: number | null = null;
	const topLimit = Math.floor(height * 0.32);
	for (let y = 1; y < topLimit - ENTROPY_RUN_LINES; y += 1) {
		let passing = 0;
		for (let k = 0; k < ENTROPY_RUN_LINES; k += 1) {
			if (entropy[y + k] >= threshold) passing += 1;
		}
		if (passing >= ENTROPY_REQUIRED_LINES) {
			topBoundary = y;
			break;
		}
	}

	let bottomBoundary: number | null = null;
	const bottomLimit = Math.floor(height * 0.68);
	for (let y = height - 2; y > bottomLimit + ENTROPY_RUN_LINES; y -= 1) {
		let passing = 0;
		for (let k = 0; k < ENTROPY_RUN_LINES; k += 1) {
			if (entropy[y - k] >= threshold) passing += 1;
		}
		if (passing >= ENTROPY_REQUIRED_LINES) {
			bottomBoundary = y;
			break;
		}
	}

	return {
		topPx: topBoundary === null ? null : Math.round(topBoundary * raster.scale) + ENTROPY_INWARD_SAFETY_PX,
		bottomPx:
			bottomBoundary === null
				? null
				: Math.round((height - 1 - bottomBoundary) * raster.scale) + ENTROPY_INWARD_SAFETY_PX
	};
}

function usePerImageEntropyVerticalCrop(rasters: readonly AnalysisRaster[]): boolean {
	return rasters.every(
		(raster) =>
			raster.heightPx >= 1000 && raster.widthPx >= 500 && raster.heightPx > raster.widthPx && raster.scale <= 1.01
	);
}

function proposeSingleImageCrop(raster: AnalysisRaster): SingleImageCropProposal {
	if (!usePerImageEntropyVerticalCrop([raster])) {
		return { insets: null, confidence: 'absent' };
	}

	const bounds = analyzeVerticalEntropy(raster);
	const maxInset = Math.floor(raster.heightPx * raster.scale * MAX_INSET_FRACTION);

	const insets: { topPx: number; bottomPx: number } = { topPx: 0, bottomPx: 0 };
	let anyProposed = false;
	let anyWeak = false;

	for (const side of ['topPx', 'bottomPx'] as const) {
		const detected = side === 'topPx' ? bounds.topPx : bounds.bottomPx;
		if (detected === null) {
			anyWeak = true;
			continue;
		}
		const clamped = Math.max(0, Math.min(detected, maxInset));
		if (clamped < MIN_ORIGINAL_BAND_PX) {
			anyWeak = true;
			continue;
		}
		insets[side] = clamped;
		anyProposed = true;
	}

	if (!anyProposed) {
		return { insets: null, confidence: anyWeak ? 'low' : 'absent' };
	}

	return {
		insets: { topPx: insets.topPx, rightPx: 0, bottomPx: insets.bottomPx, leftPx: 0 },
		confidence: anyWeak ? 'low' : 'high'
	};
}

export interface AutocroppedRaster {
	readonly rgba: Uint8ClampedArray;
	readonly widthPx: number;
	readonly heightPx: number;
	readonly topPx: number;
	readonly bottomPx: number;
}

/** Copied from old-stuff/scripts/toph-run.ts:91-109 (`autocropLikeIntake`). */
export function autocropLikeIntake(raster: {
	rgba: Uint8ClampedArray;
	widthPx: number;
	heightPx: number;
}): AutocroppedRaster {
	const { rgba, widthPx, heightPx } = raster;
	const gray = new Uint8Array(widthPx * heightPx);
	for (let i = 0, j = 0; j < gray.length; i += 4, j += 1) {
		gray[j] = (rgba[i] * 0.299 + rgba[i + 1] * 0.587 + rgba[i + 2] * 0.114 + 0.5) | 0;
	}
	const proposal = proposeSingleImageCrop({ widthPx, heightPx, gray, scale: 1 });
	const topPx = proposal.insets?.topPx ?? 0;
	const bottomPx = proposal.insets?.bottomPx ?? 0;
	if (topPx === 0 && bottomPx === 0) return { rgba, widthPx, heightPx, topPx, bottomPx };
	const croppedHeight = heightPx - topPx - bottomPx;
	const cropped = new Uint8ClampedArray(widthPx * croppedHeight * 4);
	cropped.set(rgba.subarray(topPx * widthPx * 4, (topPx + croppedHeight) * widthPx * 4));
	return { rgba: cropped, widthPx, heightPx: croppedHeight, topPx, bottomPx };
}
