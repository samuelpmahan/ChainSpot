import { resolve } from 'node:path';
import { loadCv } from '../src/lib/stitch/cvMatch';
import { loadInput, evaluateTruth } from './detect-tees';
import type { TeeTruth } from './detect-tees';
import {
	detectCalibratedOccludedEdgeLoopCandidates,
	detectCalibratedTeePadVariants
} from '../src/lib/autoAnnotation/cvCalibratedDetectors';
import type { CalibratedTeePadDetectionOptions } from '../src/lib/autoAnnotation/cvCalibratedDetectors';
import { asUiScalePx } from '../src/lib/autoAnnotation/cvCalibration';
import type { TeePadCv, TeePadRaster } from '../src/lib/autoAnnotation/teePadDetection';

const NOMINAL_UI_SCALE_PX = 1.77;
const TOLERANCE_MULTIPLE = 7;
const SWEEP_FACTORS = [0.75, 1.0, 1.5, 2.0];

// Pre-refactor (Stage 1/2), the off-nominal floor observed on GoldenTeeSet's
// fused variant was 16/18 matched at every swept factor -- this asserts that
// floor holds after Stage 2's uiScalePx-relative occluded-edge-loop rewrite.
const MIN_MATCHED_OFF_NOMINAL = 16;

// Pre-refactor, occluded-edge-loop's rail-pairing thresholds were absolute
// source pixels divided only by sourceScale, never scaling with uiScalePx --
// off-nominal factors either starved the pair search (too-strict thresholds
// at larger factors) or over-admitted noise (too-loose thresholds at smaller
// factors), and only 0-1 of the geometry-stage survivors made it through the
// visual/dedup gates to `final`, well short of 18.
//
// After Stage 2 rederives those thresholds as `K_UI * scale` (uiScalePx-
// relative, matching the gray-center/edge-loop detectors), measured geometry
// counts across [0.75, 1.0, 1.5, 2.0] on GoldenTeeSet are [216, 316, 165,
// 121], all reaching final:18. 90 sits comfortably below that measured floor
// (121 at factor 2.0) while still catching a real collapse back toward the
// pre-refactor single digits/near-zero range.
const MIN_GEOMETRY_COUNT = 90;

interface Dimensions {
	readonly widthPx: number;
	readonly heightPx: number;
}

interface ResizedRaster extends Dimensions {
	readonly rgba: Uint8Array;
}

/**
 * Minimal bilinear resampler for an RGBA raster, used to simulate the same
 * course-map capture at a different pixel resolution without adding a new
 * image-processing dependency. Each output pixel is the bilinear blend of its
 * four nearest source pixels (all four channels, including alpha).
 */
function bilinearResize(rgba: Uint8Array | Uint8ClampedArray, source: Dimensions, factor: number): ResizedRaster {
	const targetWidth = Math.max(1, Math.round(source.widthPx * factor));
	const targetHeight = Math.max(1, Math.round(source.heightPx * factor));
	const output = new Uint8Array(targetWidth * targetHeight * 4);
	const scaleX = source.widthPx / targetWidth;
	const scaleY = source.heightPx / targetHeight;

	for (let y = 0; y < targetHeight; y += 1) {
		const sourceY = (y + 0.5) * scaleY - 0.5;
		const y0 = Math.max(0, Math.min(source.heightPx - 1, Math.floor(sourceY)));
		const y1 = Math.min(source.heightPx - 1, y0 + 1);
		const fy = Math.max(0, Math.min(1, sourceY - y0));
		for (let x = 0; x < targetWidth; x += 1) {
			const sourceX = (x + 0.5) * scaleX - 0.5;
			const x0 = Math.max(0, Math.min(source.widthPx - 1, Math.floor(sourceX)));
			const x1 = Math.min(source.widthPx - 1, x0 + 1);
			const fx = Math.max(0, Math.min(1, sourceX - x0));

			const index00 = (y0 * source.widthPx + x0) * 4;
			const index10 = (y0 * source.widthPx + x1) * 4;
			const index01 = (y1 * source.widthPx + x0) * 4;
			const index11 = (y1 * source.widthPx + x1) * 4;
			const outIndex = (y * targetWidth + x) * 4;

			for (let channel = 0; channel < 4; channel += 1) {
				const top = rgba[index00 + channel] * (1 - fx) + rgba[index10 + channel] * fx;
				const bottom = rgba[index01 + channel] * (1 - fx) + rgba[index11 + channel] * fx;
				output[outIndex + channel] = Math.round(top * (1 - fy) + bottom * fy);
			}
		}
	}
	return { rgba: output, widthPx: targetWidth, heightPx: targetHeight };
}

function invariant(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(`Tee scale-sweep regression failed: ${message}`);
}

async function main(): Promise<void> {
	const projectRoot = resolve(import.meta.dirname, '..');
	const teeFixture = resolve(projectRoot, 'resources', 'GoldenTeeSet.chainspot.zip');
	const input = loadInput(teeFixture);
	invariant(input.truth && input.truth.length === 18, `GoldenTeeSet truth has ${input.truth?.length ?? 0} holes, expected 18`);
	const truth = input.truth;

	const cv = (await loadCv()) as unknown as TeePadCv;

	const rows: Array<{
		factor: number;
		widthPx: number;
		heightPx: number;
		matched: number;
		missed: readonly number[];
		fusedStageCounts: unknown;
		occludedStageCounts: unknown;
	}> = [];

	for (const factor of SWEEP_FACTORS) {
		const resized = bilinearResize(input.rgba, { widthPx: input.widthPx, heightPx: input.heightPx }, factor);
		const raster: TeePadRaster = { rgba: resized.rgba, widthPx: resized.widthPx, heightPx: resized.heightPx, sourceScale: 1 };
		const uiScalePx = asUiScalePx(NOMINAL_UI_SCALE_PX * factor, `scale-sweep factor ${factor}`);
		const scaledTruth: readonly TeeTruth[] = truth.map((hole) => ({
			number: hole.number,
			xPx: hole.xPx * factor,
			yPx: hole.yPx * factor
		}));
		const options: CalibratedTeePadDetectionOptions = { uiScalePx, maxCandidates: 18, ignoreCirclesPx: [] };

		const [fusedResult] = detectCalibratedTeePadVariants(cv, raster, options, ['fused']);
		const truthEvaluation = evaluateTruth(scaledTruth, fusedResult.candidates, TOLERANCE_MULTIPLE * uiScalePx);

		const occludedResult = detectCalibratedOccludedEdgeLoopCandidates(cv, raster, options);

		rows.push({
			factor,
			widthPx: resized.widthPx,
			heightPx: resized.heightPx,
			matched: truthEvaluation.matchedNumbers.length,
			missed: truthEvaluation.missedNumbers,
			fusedStageCounts: fusedResult.stageCounts,
			occludedStageCounts: occludedResult.stageCounts
		});

		if (factor === 1.0) {
			invariant(
				truthEvaluation.matchedNumbers.length >= 17 && truthEvaluation.matchedNumbers.length <= 18,
				`at factor 1.0, matched ${truthEvaluation.matchedNumbers.length}/18, expected 17-18`
			);
			invariant(
				truthEvaluation.missedNumbers.every((number) => number === 5),
				`at factor 1.0, unexpected misses: ${truthEvaluation.missedNumbers.join(',')}`
			);
		} else {
			invariant(
				truthEvaluation.matchedNumbers.length >= MIN_MATCHED_OFF_NOMINAL,
				`at factor ${factor}, matched ${truthEvaluation.matchedNumbers.length}/18, expected >= ${MIN_MATCHED_OFF_NOMINAL}`
			);
		}
		invariant(
			(occludedResult.stageCounts.geometry ?? 0) >= MIN_GEOMETRY_COUNT,
			`at factor ${factor}, occluded-edge-loop geometry stage produced ${occludedResult.stageCounts.geometry ?? 0}, expected >= ${MIN_GEOMETRY_COUNT}`
		);
	}

	const header = ['factor', 'dims', 'matched/18', 'missed', 'fused stageCounts', 'occluded geometry'];
	console.log(header.join('\t'));
	for (const row of rows) {
		console.log(
			[
				row.factor,
				`${row.widthPx}x${row.heightPx}`,
				`${row.matched}/18`,
				row.missed.length ? row.missed.join(',') : '-',
				JSON.stringify(row.fusedStageCounts),
				JSON.stringify(row.occludedStageCounts)
			].join('\t')
		);
	}
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
