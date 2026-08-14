import { extname, join, resolve } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import { DEFAULT_CORRIDOR_BEND_PARAMS, detectCorridorBends } from '../src/lib/autoAnnotation/corridorBendDetection';
import type { CorridorBendRaster } from '../src/lib/autoAnnotation/corridorBendDetection';
import {
	DEFAULT_RIBBON_MASS_CORRIDOR_BEND_PARAMS,
	detectCorridorBendsRibbonMass
} from '../src/lib/autoAnnotation/corridorBendDetectionRibbonMass';
import type { RibbonMassSegmentationForBends } from '../src/lib/autoAnnotation/corridorBendDetectionRibbonMass';
import { DEFAULT_RIBBON_MASS_PARAMS, segmentRibbonMass } from '../src/lib/autoAnnotation/ribbonMass';
import type { RibbonMassBadgeBox, RibbonMassRaster } from '../src/lib/autoAnnotation/ribbonMass';
import { DEFAULT_CORRIDOR_BEND_RIBBON_PARAMS, detectCorridorBendsRibbon } from '../src/lib/autoAnnotation/corridorBendDetectionRibbon';
import { IMG_5641_GROUND_TRUTH } from '../src/lib/autoAnnotation/courseGroundTruth';
import type { SourcePoint } from '../src/lib/domain/annotatedRound';
import { buildAlexClarkGroundTruth, buildDashGroundTruth, loadAlexClarkFixture } from './corridorBendGroundTruth';
import type { HoleBendTruth } from './corridorBendGroundTruth';

/**
 * Head-to-head benchmark for THREE corridor-bend-detection substrates:
 *
 * - the SHIPPED per-hole color-heuristic detector (`corridorBendDetection.ts`,
 *   already wired into `approveHolePieces` — unmodified here);
 * - the EVALUATION-ONLY ribbon-mass-segmentation detector
 *   (`corridorBendDetectionRibbonMass.ts` — not wired into anything); and
 * - the EVALUATION-ONLY band-targeted detector
 *   (`corridorBendDetectionRibbon.ts` — not wired into anything), the first
 *   of the three built on the CORRECT premise: the grey band on a UDisc
 *   course-map screenshot is not terrain to infer, it is UDisc's own
 *   pre-rendered corridor overlay, alpha-composited over whatever is
 *   underneath. See that module's doc comment and
 *   `scripts/measure-corridor-band.ts` for the empirical measurement its
 *   design is grounded in.
 *
 * All three take the SAME tee/basket ground-truth anchors per hole and the
 * SAME default params-equivalents wherever the substrates share a concept
 * (crop margin geometry, RDP epsilon, turn-angle floor, detour ratio, bend
 * cap) so a difference in results reflects the substrate, not a tuning
 * mismatch. Scoring ports `scripts/cv-probes/hole_path_semantic_bends.py`'s
 * methodology: exact bend-count match, false-bend rate on straight holes
 * specifically, and (only when the count is correct) bend-location error via
 * nearest-truth-point distance, flagged "LOCATION WRONG" past the same 42px
 * diagnostic cutoff that probe used. See `corridorBendGroundTruth.ts`'s doc
 * comment for what is deliberately NOT ported (the frozen-centerline
 * shape-goodness filter — it has no equivalent for a detector that traces its
 * own path from pixels).
 *
 * This script does not mutate `AnnotatedHole`/`corridorBends` state and does
 * not touch the live app — it is read-only analysis over checked-in fixture
 * images and hand-authored label files.
 */

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = resolve(dirname(scriptPath), '..');

const DASH_IMAGE_PATH = join(projectRoot, 'resources/ribbon-reference/IMG_5641.jpg');
const ALEX_IMAGE_PATH = join(projectRoot, 'resources/stitch-annotate/AlexClark/AlexClark-McKinney-TX.jpg');
const DEFAULT_OUTPUT_DIR = '/tmp/chainspot-corridor-bend-benchmark';
const LOCATION_WRONG_PX = 42;
const TIMING_REPETITIONS = 5;
const SEGMENTATION_TIMING_REPETITIONS = 3;

// ---------------------------------------------------------------------------
// Raster decoding — copied from scripts/detect-course.ts's `decodeRaster`
// (per that script's convention: PNG via pngjs, JPEG via jpeg-js, both
// already installed). Neither corridor-bend detector's pixel-processing
// entry point touches canvas/DOM, so this Node-decoded raw buffer is all
// either one needs.
// ---------------------------------------------------------------------------

interface DecodedRaster {
	readonly rgba: Uint8Array;
	readonly widthPx: number;
	readonly heightPx: number;
}

function decodeRaster(bytes: Uint8Array, fileName: string): DecodedRaster {
	const extension = extname(fileName).toLowerCase();
	if (extension === '.png') {
		const decoded = PNG.sync.read(Buffer.from(bytes));
		return { rgba: new Uint8Array(decoded.data), widthPx: decoded.width, heightPx: decoded.height };
	}
	if (extension === '.jpg' || extension === '.jpeg') {
		const decoded = jpeg.decode(Buffer.from(bytes), { useTArray: true });
		return { rgba: new Uint8Array(decoded.data), widthPx: decoded.width, heightPx: decoded.height };
	}
	throw new Error(`Unsupported image format '${extension}'.`);
}

function loadImage(path: string): DecodedRaster {
	return decodeRaster(new Uint8Array(readFileSync(path)), path);
}

// ---------------------------------------------------------------------------
// Node-side equivalent of `cropSourceRasterAroundHole` — the shipped
// detector's crop step is canvas-only (drawImage + getImageData), so this
// reproduces the same margin/downscale geometry by array-slicing the
// already-decoded raster instead. Numeric defaults mirror that function's
// own (unexported) DEFAULT_CROP_OPTIONS exactly, so the two detectors are
// compared over identically-sized physical crop windows.
// ---------------------------------------------------------------------------

const CROP_MARGIN_FRACTION = 0.4;
const CROP_MIN_MARGIN_PX = 40;
const CROP_MAX_MARGIN_PX = 260;
const CROP_MAX_DIM = 480;

function cropBounds(
	imageWidthPx: number,
	imageHeightPx: number,
	tee: SourcePoint,
	basket: SourcePoint
): { readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number } {
	const distance = Math.hypot(basket.xPx - tee.xPx, basket.yPx - tee.yPx);
	const margin = Math.min(CROP_MAX_MARGIN_PX, Math.max(CROP_MIN_MARGIN_PX, distance * CROP_MARGIN_FRACTION));
	return {
		x0: Math.max(0, Math.floor(Math.min(tee.xPx, basket.xPx) - margin)),
		y0: Math.max(0, Math.floor(Math.min(tee.yPx, basket.yPx) - margin)),
		x1: Math.min(imageWidthPx, Math.ceil(Math.max(tee.xPx, basket.xPx) + margin)),
		y1: Math.min(imageHeightPx, Math.ceil(Math.max(tee.yPx, basket.yPx) + margin))
	};
}

/** Box-average downscale of an RGBA sub-rectangle — a reasonable Node stand-in for canvas `drawImage`'s bilinear/mipmap downscale (exact pixel-parity with the browser's canvas isn't the point; comparable smoothing behavior is). No-op (scale 1) whenever the crop already fits under `maxDim`, which is the common case. */
function cropAndDownscale(
	full: DecodedRaster,
	bounds: { readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number },
	maxDim: number
): CorridorBendRaster {
	const cropWidth = bounds.x1 - bounds.x0;
	const cropHeight = bounds.y1 - bounds.y0;
	const scale = Math.max(1, Math.max(cropWidth, cropHeight) / maxDim);
	const outWidth = Math.max(1, Math.round(cropWidth / scale));
	const outHeight = Math.max(1, Math.round(cropHeight / scale));
	const channels: 4 = 4;
	const data = new Uint8Array(outWidth * outHeight * channels);

	for (let oy = 0; oy < outHeight; oy += 1) {
		const sy0 = Math.floor(oy * scale);
		const sy1 = Math.max(sy0 + 1, Math.min(cropHeight, Math.floor((oy + 1) * scale)));
		for (let ox = 0; ox < outWidth; ox += 1) {
			const sx0 = Math.floor(ox * scale);
			const sx1 = Math.max(sx0 + 1, Math.min(cropWidth, Math.floor((ox + 1) * scale)));
			let r = 0;
			let g = 0;
			let b = 0;
			let a = 0;
			let count = 0;
			for (let sy = sy0; sy < sy1; sy += 1) {
				const rowBase = (bounds.y0 + sy) * full.widthPx;
				for (let sx = sx0; sx < sx1; sx += 1) {
					const p = (rowBase + bounds.x0 + sx) * 4;
					r += full.rgba[p];
					g += full.rgba[p + 1];
					b += full.rgba[p + 2];
					a += full.rgba[p + 3];
					count += 1;
				}
			}
			const op = (oy * outWidth + ox) * channels;
			data[op] = r / count;
			data[op + 1] = g / count;
			data[op + 2] = b / count;
			data[op + 3] = a / count;
		}
	}

	return { widthPx: outWidth, heightPx: outHeight, originXPx: bounds.x0, originYPx: bounds.y0, scale: cropWidth / outWidth, data, channels };
}

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------

function median(values: readonly number[]): number | null {
	if (values.length === 0) return null;
	const sorted = values.slice().sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function mean(values: readonly number[]): number | null {
	return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Runs `fn` `repetitions` times, returning the LAST result (detectors here are pure/deterministic, so any repetition's result is representative) plus the median wall-clock time across all repetitions. */
function timedMedian<T>(fn: () => T, repetitions: number): { readonly result: T; readonly medianMs: number } {
	let result: T | undefined;
	const times: number[] = [];
	for (let i = 0; i < repetitions; i += 1) {
		const start = performance.now();
		result = fn();
		times.push(performance.now() - start);
	}
	return { result: result as T, medianMs: median(times) ?? 0 };
}

// ---------------------------------------------------------------------------
// Scoring — ports hole_path_semantic_bends.py's per-hole status logic.
// ---------------------------------------------------------------------------

interface HoleScore {
	readonly holeNumber: number;
	readonly truthCount: number;
	readonly predictedCount: number;
	readonly status: 'GOOD' | 'COUNT WRONG' | 'LOCATION WRONG';
	readonly errorsPx: readonly number[];
	readonly isStraightTruth: boolean;
	readonly falseBend: boolean;
}

function nearestTruthDistancePx(point: SourcePoint, truthBends: readonly SourcePoint[]): number {
	return Math.min(...truthBends.map((truth) => Math.hypot(truth.xPx - point.xPx, truth.yPx - point.yPx)));
}

function scoreHole(truth: HoleBendTruth, predicted: readonly SourcePoint[]): HoleScore {
	const predictedCount = predicted.length;
	const isStraightTruth = truth.truthCount === 0;
	const falseBend = isStraightTruth && predictedCount > 0;

	if (predictedCount !== truth.truthCount) {
		return { holeNumber: truth.holeNumber, truthCount: truth.truthCount, predictedCount, status: 'COUNT WRONG', errorsPx: [], isStraightTruth, falseBend };
	}
	if (truth.truthCount === 0) {
		return { holeNumber: truth.holeNumber, truthCount: truth.truthCount, predictedCount, status: 'GOOD', errorsPx: [], isStraightTruth, falseBend };
	}
	const errorsPx = predicted.map((point) => nearestTruthDistancePx(point, truth.truthBends));
	const status = Math.max(...errorsPx) > LOCATION_WRONG_PX ? 'LOCATION WRONG' : 'GOOD';
	return { holeNumber: truth.holeNumber, truthCount: truth.truthCount, predictedCount, status, errorsPx, isStraightTruth, falseBend };
}

interface AggregateStats {
	readonly holesEvaluated: number;
	readonly exactCountMatches: number;
	readonly exactCountAccuracy: number;
	readonly straightHoleCount: number;
	readonly falseBendsOnStraightHoles: number;
	readonly falseBendRate: number | null;
	readonly goodCount: number;
	readonly locationWrongCount: number;
	readonly medianLocationErrorPx: number | null;
	readonly maxLocationErrorPx: number | null;
}

function aggregate(scores: readonly HoleScore[]): AggregateStats {
	const exactCountMatches = scores.filter((score) => score.predictedCount === score.truthCount).length;
	const straight = scores.filter((score) => score.isStraightTruth);
	const falseBends = straight.filter((score) => score.falseBend).length;
	const errors = scores.flatMap((score) => score.errorsPx);
	return {
		holesEvaluated: scores.length,
		exactCountMatches,
		exactCountAccuracy: scores.length === 0 ? NaN : exactCountMatches / scores.length,
		straightHoleCount: straight.length,
		falseBendsOnStraightHoles: falseBends,
		falseBendRate: straight.length === 0 ? null : falseBends / straight.length,
		goodCount: scores.filter((score) => score.status === 'GOOD').length,
		locationWrongCount: scores.filter((score) => score.status === 'LOCATION WRONG').length,
		medianLocationErrorPx: median(errors),
		maxLocationErrorPx: errors.length === 0 ? null : Math.max(...errors)
	};
}

// ---------------------------------------------------------------------------
// Per-course run
// ---------------------------------------------------------------------------

interface HoleInput {
	readonly holeNumber: number;
	readonly tee: SourcePoint;
	readonly basket: SourcePoint;
}

interface DetectorHoleResult {
	readonly holeNumber: number;
	readonly predicted: SourcePoint[];
	readonly medianMs: number;
	readonly score: HoleScore;
}

interface CourseResult {
	readonly course: string;
	readonly holeCount: number;
	readonly colorHeuristic: {
		readonly perHole: readonly DetectorHoleResult[];
		readonly aggregate: AggregateStats;
		readonly medianMsPerHole: number | null;
		readonly meanMsPerHole: number | null;
	};
	readonly ribbonMass: {
		readonly perHole: readonly DetectorHoleResult[];
		readonly aggregate: AggregateStats;
		readonly segmentationMedianMs: number;
		readonly perHoleMedianMs: number | null;
		readonly perHoleMeanMs: number | null;
		/** Scenario (a): segmentation re-run independently for every hole (segmentationMedianMs + per-hole cost). */
		readonly rawIndependentMsPerHole: number;
		/** Scenario (b): segmentation computed once for the whole course, amortized across its holes, plus per-hole cost. */
		readonly amortizedMsPerHole: number;
	};
	/** The new band-targeted detector (`corridorBendDetectionRibbon.ts`) -- per-hole cost shape like `colorHeuristic` (crop + self-calibrate + detect, no whole-course precomputation to amortize). */
	readonly ribbonBand: {
		readonly perHole: readonly DetectorHoleResult[];
		readonly aggregate: AggregateStats;
		readonly medianMsPerHole: number | null;
		readonly meanMsPerHole: number | null;
	};
}

function runCourse(course: string, image: DecodedRaster, holes: readonly HoleInput[], truth: readonly HoleBendTruth[], badges: readonly RibbonMassBadgeBox[]): CourseResult {
	const truthByHole = new Map(truth.map((entry) => [entry.holeNumber, entry]));

	// --- Color heuristic: crop + detect, per hole, exactly the shipped cost shape. ---
	const colorPerHole: DetectorHoleResult[] = holes.map((hole) => {
		const bounds = cropBounds(image.widthPx, image.heightPx, hole.tee, hole.basket);
		const { result, medianMs } = timedMedian(() => {
			const raster = cropAndDownscale(image, bounds, CROP_MAX_DIM);
			return detectCorridorBends(raster, hole.tee, hole.basket, DEFAULT_CORRIDOR_BEND_PARAMS);
		}, TIMING_REPETITIONS);
		const holeTruth = truthByHole.get(hole.holeNumber);
		if (!holeTruth) throw new Error(`No ground truth for ${course} hole ${hole.holeNumber}`);
		return { holeNumber: hole.holeNumber, predicted: result, medianMs, score: scoreHole(holeTruth, result) };
	});

	// --- Ribbon mass: whole-course segmentation once (timed separately), then cheap per-hole seeding/windowing/pathfinding. ---
	const raster: RibbonMassRaster = { data: image.rgba, widthPx: image.widthPx, heightPx: image.heightPx, channels: 4 };
	let segmentation: RibbonMassSegmentationForBends | undefined;
	const segmentationTimes: number[] = [];
	for (let i = 0; i < SEGMENTATION_TIMING_REPETITIONS; i += 1) {
		const start = performance.now();
		segmentation = segmentRibbonMass(raster, badges, DEFAULT_RIBBON_MASS_PARAMS);
		segmentationTimes.push(performance.now() - start);
	}
	const segmentationMedianMs = median(segmentationTimes) ?? 0;

	const ribbonPerHole: DetectorHoleResult[] = holes.map((hole) => {
		const { result, medianMs } = timedMedian(
			() => detectCorridorBendsRibbonMass(segmentation as RibbonMassSegmentationForBends, hole.tee, hole.basket, DEFAULT_RIBBON_MASS_CORRIDOR_BEND_PARAMS),
			TIMING_REPETITIONS
		);
		const holeTruth = truthByHole.get(hole.holeNumber);
		if (!holeTruth) throw new Error(`No ground truth for ${course} hole ${hole.holeNumber}`);
		return { holeNumber: hole.holeNumber, predicted: result, medianMs, score: scoreHole(holeTruth, result) };
	});

	// --- Ribbon band (new, band-targeted): crop + self-calibrate + detect, per hole -- same cost shape as the color heuristic (no whole-course precomputation). ---
	const ribbonBandPerHole: DetectorHoleResult[] = holes.map((hole) => {
		const bounds = cropBounds(image.widthPx, image.heightPx, hole.tee, hole.basket);
		const { result, medianMs } = timedMedian(() => {
			const cropped = cropAndDownscale(image, bounds, CROP_MAX_DIM);
			return detectCorridorBendsRibbon(cropped, hole.tee, hole.basket, DEFAULT_CORRIDOR_BEND_RIBBON_PARAMS);
		}, TIMING_REPETITIONS);
		const holeTruth = truthByHole.get(hole.holeNumber);
		if (!holeTruth) throw new Error(`No ground truth for ${course} hole ${hole.holeNumber}`);
		return { holeNumber: hole.holeNumber, predicted: result, medianMs, score: scoreHole(holeTruth, result) };
	});

	const colorMs = colorPerHole.map((entry) => entry.medianMs);
	const ribbonMs = ribbonPerHole.map((entry) => entry.medianMs);
	const ribbonPerHoleMean = mean(ribbonMs) ?? 0;
	const ribbonBandMs = ribbonBandPerHole.map((entry) => entry.medianMs);

	return {
		course,
		holeCount: holes.length,
		colorHeuristic: {
			perHole: colorPerHole,
			aggregate: aggregate(colorPerHole.map((entry) => entry.score)),
			medianMsPerHole: median(colorMs),
			meanMsPerHole: mean(colorMs)
		},
		ribbonBand: {
			perHole: ribbonBandPerHole,
			aggregate: aggregate(ribbonBandPerHole.map((entry) => entry.score)),
			medianMsPerHole: median(ribbonBandMs),
			meanMsPerHole: mean(ribbonBandMs)
		},
		ribbonMass: {
			perHole: ribbonPerHole,
			aggregate: aggregate(ribbonPerHole.map((entry) => entry.score)),
			segmentationMedianMs,
			perHoleMedianMs: median(ribbonMs),
			perHoleMeanMs: mean(ribbonMs),
			rawIndependentMsPerHole: segmentationMedianMs + ribbonPerHoleMean,
			amortizedMsPerHole: segmentationMedianMs / Math.max(1, holes.length) + ribbonPerHoleMean
		}
	};
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function formatPct(value: number | null): string {
	return value === null || Number.isNaN(value) ? 'n/a' : `${(value * 100).toFixed(0)}%`;
}

function formatPx(value: number | null): string {
	return value === null ? 'n/a' : `${value.toFixed(1)}px`;
}

function formatMs(value: number | null): string {
	return value === null ? 'n/a' : `${value.toFixed(2)}ms`;
}

function printCourseReport(result: CourseResult): void {
	console.log(`\n=== ${result.course} (${result.holeCount} holes) ===`);
	console.log(
		'detector          | exact count | false-bend rate (straight) | good | loc-wrong | median loc err | max loc err'
	);
	for (const [label, run] of [
		['color-heuristic', result.colorHeuristic] as const,
		['ribbon-mass', result.ribbonMass] as const,
		['ribbon-band', result.ribbonBand] as const
	]) {
		const a = run.aggregate;
		console.log(
			`${label.padEnd(18)} | ${formatPct(a.exactCountAccuracy).padEnd(11)} | ${`${a.falseBendsOnStraightHoles}/${a.straightHoleCount} (${formatPct(a.falseBendRate)})`.padEnd(27)} | ${String(a.goodCount).padEnd(4)} | ${String(a.locationWrongCount).padEnd(9)} | ${formatPx(a.medianLocationErrorPx).padEnd(14)} | ${formatPx(a.maxLocationErrorPx)}`
		);
	}
	console.log(
		`color-heuristic speed: median ${formatMs(result.colorHeuristic.medianMsPerHole)}/hole, mean ${formatMs(result.colorHeuristic.meanMsPerHole)}/hole`
	);
	console.log(
		`ribbon-mass speed: whole-course segmentation median ${formatMs(result.ribbonMass.segmentationMedianMs)}, per-hole median ${formatMs(result.ribbonMass.perHoleMedianMs)} ` +
			`(raw independent-per-hole: ${formatMs(result.ribbonMass.rawIndependentMsPerHole)}/hole; amortized reuse: ${formatMs(result.ribbonMass.amortizedMsPerHole)}/hole)`
	);
	console.log(
		`ribbon-band speed: median ${formatMs(result.ribbonBand.medianMsPerHole)}/hole, mean ${formatMs(result.ribbonBand.meanMsPerHole)}/hole`
	);
	console.log('\nper-hole detail:');
	console.log('hole | truth | color pred/status | ribbon-mass pred/status | ribbon-band pred/status');
	for (const hole of result.colorHeuristic.perHole) {
		const ribbon = result.ribbonMass.perHole.find((entry) => entry.holeNumber === hole.holeNumber)!;
		const band = result.ribbonBand.perHole.find((entry) => entry.holeNumber === hole.holeNumber)!;
		console.log(
			`${String(hole.holeNumber).padStart(4)} | ${String(hole.score.truthCount).padStart(5)} | ${String(hole.score.predictedCount)}/${hole.score.status.padEnd(13)} | ${String(ribbon.score.predictedCount)}/${ribbon.score.status.padEnd(13)} | ${String(band.score.predictedCount)}/${band.score.status}`
		);
	}
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
	const outputDir = resolve(process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : DEFAULT_OUTPUT_DIR);
	mkdirSync(outputDir, { recursive: true });

	console.log('Loading fixtures...');
	const dashImage = loadImage(DASH_IMAGE_PATH);
	const alexImage = loadImage(ALEX_IMAGE_PATH);
	const dashTruth = buildDashGroundTruth();
	const alexTruth = buildAlexClarkGroundTruth();
	const alexFixture = loadAlexClarkFixture();

	const dashHoles: HoleInput[] = IMG_5641_GROUND_TRUTH.holes.map((hole) => ({ holeNumber: hole.number, tee: hole.tee, basket: hole.basket }));
	const alexHoles: HoleInput[] = alexFixture.holes.map((hole) => ({ holeNumber: Number(hole.number), tee: hole.tee, basket: hole.basket }));
	const dashBadges: RibbonMassBadgeBox[] = IMG_5641_GROUND_TRUTH.badges.map((badge) => ({ xPx: badge.xPx, yPx: badge.yPx }));
	// No numbered-badge ground truth ships for AlexClark -- segmentRibbonMass
	// simply gets no badge pre-fill boxes for this course (see that module's
	// doc comment on what badge pre-fill is for). Noted as a fairness caveat
	// in the benchmark's report, not silently glossed over.
	const alexBadges: RibbonMassBadgeBox[] = [];

	console.log(`Dash: ${dashHoles.length} holes, ${dashImage.widthPx}x${dashImage.heightPx}px`);
	console.log(`AlexClark: ${alexHoles.length} holes, ${alexImage.widthPx}x${alexImage.heightPx}px`);

	console.log('\nRunning Dash...');
	const dashResult = runCourse('Dash (IMG_5641)', dashImage, dashHoles, dashTruth, dashBadges);
	console.log('Running AlexClark...');
	const alexResult = runCourse('AlexClark-McKinney-TX', alexImage, alexHoles, alexTruth, alexBadges);

	printCourseReport(dashResult);
	printCourseReport(alexResult);

	const reportPath = join(outputDir, 'corridor-bend-benchmark-report.json');
	writeFileSync(reportPath, `${JSON.stringify({ dash: dashResult, alexClark: alexResult }, null, 2)}\n`);
	console.log(`\nFull report: ${reportPath}`);
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
	process.exitCode = 1;
});
