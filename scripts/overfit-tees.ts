import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { strFromU8, unzipSync } from 'fflate';
import { PNG } from 'pngjs';
import { loadCv } from '../src/lib/stitch/cvMatch';
import { evaluateTruth, loadInput, loadNumberTemplates, loadValidatedTemplateManifest } from './detect-tees';
import type { LoadedInput, TeeTruth } from './detect-tees';
import {
	detectCalibratedHoleNumberBadges,
	detectCalibratedOccludedEdgeLoopCandidates,
	detectCalibratedTeePadVariants
} from '../src/lib/autoAnnotation/cvCalibratedDetectors';
import type { HoleNumberCvModule } from '../src/lib/autoAnnotation/holeNumberDetection';
import type { CalibratedTeePadDetectionOptions } from '../src/lib/autoAnnotation/cvCalibratedDetectors';
import { asUiScalePx } from '../src/lib/autoAnnotation/cvCalibration';
import type { TeePadCandidate, TeePadCv, TeePadRaster } from '../src/lib/autoAnnotation/teePadDetection';
import {
	METRIC_NAMES,
	computePatchMetrics,
	createTeeMetricContext
} from '../src/lib/autoAnnotation/teeMetricBattery';
import type { DashStructures, TeePatch } from '../src/lib/autoAnnotation/teeMetricBattery';
import {
	applyTunedScorer,
	buildLocalNeighborhoods,
	greedySearchCombination,
	scoreMetricDiscrimination
} from '../src/lib/autoAnnotation/teeMetricSearch';
import type {
	MetricReport,
	MetricSample,
	TunedTeeScorer
} from '../src/lib/autoAnnotation/teeMetricSearch';

/**
 * Tee-detection overfitting harness. Given a labeled course, it measures a
 * battery of per-patch metrics on the truth tees vs distractor patches and
 * searches for the metric (or weighted combination) that separates them ON
 * THIS IMAGE. The output `tuned-scorer.json` is a deliberately course-
 * specific artifact aimed at recovering pads the production detectors miss —
 * canonically hole 5 of GoldenTeeSet, whose rectangle a C2 dash bisects.
 */

export type OverfitVerifyMode = 'gap-fill' | 'rerank' | 'sliding' | 'both' | 'none';

export interface OverfitCliArgs {
	readonly inputPath: string;
	readonly outputDir: string;
	readonly truthPath?: string;
	readonly basketsPath?: string;
	readonly templateDir?: string;
	readonly uiScalePx: number;
	readonly mapTopPx?: number;
	readonly mapBottomPx?: number;
	readonly maxDistractors: number;
	readonly patchHalfUi: number;
	readonly seed: number;
	readonly verify: OverfitVerifyMode;
	readonly targetHoles: readonly number[];
	readonly slidingStrideUi: number;
	/** When set, skip the greedy search and use this frozen scorer for verification. */
	readonly scorerPath?: string;
}

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = resolve(dirname(scriptPath), '..');

const DEFAULT_UI_SCALE = 1.77;
const TRUTH_EXCLUSION_UI = 10;
const LOCAL_RADIUS_UI = 40;
/**
 * Badge-anchored gap search radius. Slightly wider than the production
 * 40-multiple gap-fallback radius: measured on the golden fixture, tee 5 is
 * 71.6px from badge 5 (40.5 UI multiples), just past the production radius.
 */
const GAP_SEARCH_RADIUS_UI = 45;
const GAP_PEAK_CANDIDATES = 8;
const NMS_RADIUS_UI = 10;
const RERANK_POOL_SIZE = 80;

function usage(): string {
	return [
		'Usage: npm run overfit:tees -- <image-or-chainspot-zip> --out <directory>',
		'',
		'Options:',
		'  --truth <bundle.chainspot.zip>  Take holes[].tee truth from this bundle (for plain-image inputs)',
		'  --baskets <bundle.chainspot.zip>  Basket truth bundle; enables dash-structure metrics (rings fitted from the image, connectors basket N -> tee N+1)',
		'  --templates <dir>               CV template pack for number-badge detection; gap-fill then anchors on the missed hole’s badge and validates the badge-ray invariant (default: static/resources/chainspot_cv_templates)',
		'  --ui-scale <n>                  Source pixels per UI pixel (default: 1.77, the GoldenTeeSet guardrail value)',
		'  --map-top/--map-bottom <px>     Restrict sampling band (default: derived from truth extent)',
		'  --max-distractors <n>           Grid distractor sample cap (default: 500)',
		'  --patch-half-ui <n>             Patch half-size in UI-pixel multiples (default: 6)',
		'  --seed <n>                      Distractor sampling seed (default: 1337)',
		'  --verify <gap-fill|rerank|sliding|both|none>  Post-search verification (default: gap-fill)',
		'  --target-hole <n>               Hole whose margin the search must maximize first (repeatable; default: 5)',
		'  --sliding-stride-ui <n>         Sliding-verify stride in UI pixels (default: 3)',
		'  --scorer <tuned-scorer.json>    Skip the greedy search; use this frozen scorer for verification (transfer test)',
		'  --help'
	].join('\n');
}

function requireValue(argv: readonly string[], index: number, option: string): string {
	const value = argv[index + 1];
	if (!value || value.startsWith('--')) throw new Error(`${option} requires a value.\n\n${usage()}`);
	return value;
}

function finiteNumber(value: string, option: string): number {
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) throw new Error(`${option} must be a finite number.`);
	return parsed;
}

export function parseArgs(argv: readonly string[]): OverfitCliArgs {
	if (argv.includes('--help')) throw new Error(usage());
	const positional = argv.find((value) => !value.startsWith('--'));
	if (!positional) throw new Error(`An image or .chainspot.zip input is required.\n\n${usage()}`);
	let outputDir: string | undefined;
	let truthPath: string | undefined;
	let basketsPath: string | undefined;
	let templateDir: string | undefined = join(projectRoot, 'static', 'resources', 'chainspot_cv_templates');
	let uiScalePx = DEFAULT_UI_SCALE;
	let mapTopPx: number | undefined;
	let mapBottomPx: number | undefined;
	let maxDistractors = 500;
	// 6 UI px half-size (~21px window at the golden fixture's scale) measured
	// strictly better than 10: the pad fills enough of the window for the
	// interior/rim statistics to dominate. Larger patches dilute the pad.
	let patchHalfUi = 6;
	let seed = 1337;
	let verify: OverfitVerifyMode = 'gap-fill';
	const targetHoles: number[] = [];
	let slidingStrideUi = 3;
	let scorerPath: string | undefined;
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (!argument.startsWith('--')) continue;
		switch (argument) {
			case '--out':
				outputDir = requireValue(argv, index, argument);
				index += 1;
				break;
			case '--truth':
				truthPath = requireValue(argv, index, argument);
				index += 1;
				break;
			case '--baskets':
				basketsPath = requireValue(argv, index, argument);
				index += 1;
				break;
			case '--templates':
				templateDir = requireValue(argv, index, argument);
				index += 1;
				break;
			case '--ui-scale':
				uiScalePx = finiteNumber(requireValue(argv, index, argument), argument);
				index += 1;
				break;
			case '--map-top':
				mapTopPx = finiteNumber(requireValue(argv, index, argument), argument);
				index += 1;
				break;
			case '--map-bottom':
				mapBottomPx = finiteNumber(requireValue(argv, index, argument), argument);
				index += 1;
				break;
			case '--max-distractors':
				maxDistractors = finiteNumber(requireValue(argv, index, argument), argument);
				index += 1;
				break;
			case '--patch-half-ui':
				patchHalfUi = finiteNumber(requireValue(argv, index, argument), argument);
				index += 1;
				break;
			case '--seed':
				seed = finiteNumber(requireValue(argv, index, argument), argument);
				index += 1;
				break;
			case '--verify': {
				const value = requireValue(argv, index, argument) as OverfitVerifyMode;
				if (value !== 'gap-fill' && value !== 'rerank' && value !== 'sliding' && value !== 'both' && value !== 'none') {
					throw new Error(`Unsupported --verify '${value}'.\n\n${usage()}`);
				}
				verify = value;
				index += 1;
				break;
			}
			case '--target-hole':
				targetHoles.push(finiteNumber(requireValue(argv, index, argument), argument));
				index += 1;
				break;
			case '--sliding-stride-ui':
				slidingStrideUi = finiteNumber(requireValue(argv, index, argument), argument);
				index += 1;
				break;
			case '--scorer':
				scorerPath = requireValue(argv, index, argument);
				index += 1;
				break;
			default:
				throw new Error(`Unknown option '${argument}'.\n\n${usage()}`);
		}
	}
	if (!outputDir) throw new Error(`--out is required.\n\n${usage()}`);
	if ((mapTopPx === undefined) !== (mapBottomPx === undefined)) throw new Error('--map-top and --map-bottom must be provided together.');
	return {
		inputPath: positional,
		outputDir,
		truthPath,
		basketsPath,
		templateDir,
		uiScalePx,
		mapTopPx,
		mapBottomPx,
		maxDistractors,
		patchHalfUi,
		seed,
		verify,
		targetHoles: targetHoles.length > 0 ? targetHoles : [5],
		slidingStrideUi,
		scorerPath
	};
}

export function loadTunedScorer(scorerPath: string): TunedTeeScorer {
	return JSON.parse(readFileSync(resolve(scorerPath), 'utf8')) as TunedTeeScorer;
}

interface BasketTruth {
	readonly number: number;
	readonly xPx: number;
	readonly yPx: number;
}

export function loadBasketTruth(bundlePath: string): readonly BasketTruth[] {
	const entries = unzipSync(new Uint8Array(readFileSync(resolve(bundlePath))));
	const jsonBytes = entries['project.json'];
	if (!jsonBytes) throw new Error(`--baskets bundle '${bundlePath}' does not contain project.json.`);
	const document = JSON.parse(strFromU8(jsonBytes)) as {
		holes?: readonly Readonly<{ number?: unknown; basket?: Readonly<{ xPx?: unknown; yPx?: unknown }> }>[];
	};
	const baskets = (document.holes ?? [])
		.map((hole) => ({
			number: typeof hole.number === 'number' ? hole.number : NaN,
			xPx: typeof hole.basket?.xPx === 'number' ? hole.basket.xPx : NaN,
			yPx: typeof hole.basket?.yPx === 'number' ? hole.basket.yPx : NaN
		}))
		.filter((hole) => Number.isInteger(hole.number) && Number.isFinite(hole.xPx) && Number.isFinite(hole.yPx))
		.sort((a, b) => a.number - b.number);
	if (baskets.length === 0) throw new Error(`--baskets bundle '${bundlePath}' contains no holes[].basket truth.`);
	return baskets;
}

const STRUCTURE_BAND_PX = 6;
const CONNECTOR_TRIM_PX = 15;
const RING_FIT_MIN_R = 30;
const RING_FIT_MAX_R = 110;
const RING_FIT_MIN_DASHES = 6;

function isBrightOverlayPixel(raster: TeePadRaster, xPx: number, yPx: number): boolean {
	const x = Math.round(xPx);
	const y = Math.round(yPx);
	if (x < 0 || y < 0 || x >= raster.widthPx || y >= raster.heightPx) return false;
	const offset = (y * raster.widthPx + x) * 4;
	const red = raster.rgba[offset];
	const green = raster.rgba[offset + 1];
	const blue = raster.rgba[offset + 2];
	const maximum = Math.max(red, green, blue);
	const minimum = Math.min(red, green, blue);
	const saturation = maximum === 0 ? 0 : ((maximum - minimum) * 255) / maximum;
	return maximum >= 185 && saturation <= 50;
}

interface DashBlob {
	readonly xPx: number;
	readonly yPx: number;
}

/**
 * Extracts small bright elongated blobs — the dash-bar population. Simple
 * union-free flood fill over the bright-overlay mask; blobs that are too
 * large (glyphs, badges, intact pad rims) or too small (noise) are dropped.
 */
function extractDashBlobs(raster: TeePadRaster): DashBlob[] {
	const { widthPx, heightPx } = raster;
	const visited = new Uint8Array(widthPx * heightPx);
	const blobs: DashBlob[] = [];
	const stack: number[] = [];
	for (let startY = 0; startY < heightPx; startY += 1) {
		for (let startX = 0; startX < widthPx; startX += 1) {
			const startIndex = startY * widthPx + startX;
			if (visited[startIndex] || !isBrightOverlayPixel(raster, startX, startY)) continue;
			let area = 0;
			let sumX = 0;
			let sumY = 0;
			let minX = startX;
			let maxX = startX;
			let minY = startY;
			let maxY = startY;
			stack.push(startIndex);
			visited[startIndex] = 1;
			while (stack.length > 0) {
				const index = stack.pop() as number;
				const x = index % widthPx;
				const y = (index / widthPx) | 0;
				area += 1;
				sumX += x;
				sumY += y;
				if (x < minX) minX = x;
				if (x > maxX) maxX = x;
				if (y < minY) minY = y;
				if (y > maxY) maxY = y;
				if (area > 400) continue;
				for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
					const nx = x + dx;
					const ny = y + dy;
					if (nx < 0 || ny < 0 || nx >= widthPx || ny >= heightPx) continue;
					const neighborIndex = ny * widthPx + nx;
					if (visited[neighborIndex] || !isBrightOverlayPixel(raster, nx, ny)) continue;
					visited[neighborIndex] = 1;
					stack.push(neighborIndex);
				}
			}
			const spanX = maxX - minX + 1;
			const spanY = maxY - minY + 1;
			if (area < 8 || area > 120 || Math.max(spanX, spanY) > 25) continue;
			blobs.push({ xPx: sumX / area, yPx: sumY / area });
		}
	}
	return blobs;
}

/**
 * Fits COURSE-WIDE putting-circle radii from the dash-bar population: each
 * dash's distance to its nearest basket clusters tightly at the rendered
 * C1/C2 radii (the circles are fixed real-world sizes at one map scale —
 * measured ~44px and ~87px on the golden fixture, per-basket wobble a few
 * px). Histogram peaks over all dashes are far more robust than scanning
 * ring coverage, which the basket glyphs and neighboring overlays pollute.
 */
function fitGlobalRingRadii(blobs: readonly DashBlob[], baskets: readonly BasketTruth[]): number[] {
	const histogram = new Array<number>(RING_FIT_MAX_R + 1).fill(0);
	for (const blob of blobs) {
		let nearest = Number.POSITIVE_INFINITY;
		for (const basket of baskets) {
			const distance = Math.hypot(blob.xPx - basket.xPx, blob.yPx - basket.yPx);
			if (distance < nearest) nearest = distance;
		}
		const bin = Math.round(nearest);
		if (bin >= RING_FIT_MIN_R && bin <= RING_FIT_MAX_R) histogram[bin] += 1;
	}
	const smoothed = histogram.map((_, index) => {
		let total = 0;
		for (let offset = -3; offset <= 3; offset += 1) total += histogram[index + offset] ?? 0;
		return total;
	});
	const peaks: Array<{ radius: number; count: number }> = [];
	for (let radius = RING_FIT_MIN_R; radius <= RING_FIT_MAX_R; radius += 1) {
		if (smoothed[radius] < RING_FIT_MIN_DASHES) continue;
		if (smoothed[radius] < (smoothed[radius - 1] ?? 0) || smoothed[radius] < (smoothed[radius + 1] ?? 0)) continue;
		peaks.push({ radius, count: smoothed[radius] });
	}
	peaks.sort((a, b) => b.count - a.count);
	const kept: number[] = [];
	for (const peak of peaks) {
		if (kept.length >= 2) break;
		if (kept.some((radius) => Math.abs(radius - peak.radius) < 15)) continue;
		kept.push(peak.radius);
	}
	return kept.sort((a, b) => a - b);
}

export function buildDashStructures(
	raster: TeePadRaster,
	baskets: readonly BasketTruth[],
	tees: readonly TeeTruth[]
): DashStructures {
	const circles: Array<{ xPx: number; yPx: number; radiusPx: number }> = [];
	const blobs = extractDashBlobs(raster);
	const globalRadii = fitGlobalRingRadii(blobs, baskets);
	for (const basket of baskets) {
		for (const globalRadius of globalRadii) {
			// Refine each basket's ring to the mean distance of its own nearby
			// dashes — the rendered radius wobbles a few px basket to basket.
			const own = blobs.filter((blob) => {
				const distance = Math.hypot(blob.xPx - basket.xPx, blob.yPx - basket.yPx);
				return Math.abs(distance - globalRadius) <= 6;
			});
			const radiusPx =
				own.length >= 2
					? own.reduce((total, blob) => total + Math.hypot(blob.xPx - basket.xPx, blob.yPx - basket.yPx), 0) / own.length
					: globalRadius;
			circles.push({ xPx: basket.xPx, yPx: basket.yPx, radiusPx });
		}
	}
	const segments: Array<{ axPx: number; ayPx: number; bxPx: number; byPx: number }> = [];
	for (const basket of baskets) {
		const nextTee = tees.find((tee) => tee.number === basket.number + 1);
		if (!nextTee) continue;
		const dx = nextTee.xPx - basket.xPx;
		const dy = nextTee.yPx - basket.yPx;
		const length = Math.hypot(dx, dy);
		if (length <= 2 * CONNECTOR_TRIM_PX) continue;
		const trim = CONNECTOR_TRIM_PX / length;
		segments.push({
			axPx: basket.xPx + dx * trim,
			ayPx: basket.yPx + dy * trim,
			bxPx: nextTee.xPx - dx * trim,
			byPx: nextTee.yPx - dy * trim
		});
	}
	return { circles, segments, bandPx: STRUCTURE_BAND_PX };
}

interface BadgeAnchor {
	readonly number: number;
	readonly xPx: number;
	readonly yPx: number;
	readonly radiusPx: number;
}

export function detectBadgeAnchors(cv: TeePadCv, input: LoadedInput, templateDir: string): readonly BadgeAnchor[] {
	const manifest = loadValidatedTemplateManifest(templateDir);
	const detection = detectCalibratedHoleNumberBadges(
		cv as unknown as HoleNumberCvModule,
		{ format: 'rgba', widthPx: input.widthPx, heightPx: input.heightPx, data: input.rgba },
		loadNumberTemplates(templateDir, manifest)
	);
	return detection.candidates
		.filter((candidate) => candidate.label !== undefined)
		.map((candidate) => ({
			number: candidate.label as number,
			xPx: candidate.xPx,
			yPx: candidate.yPx,
			// Ray tests treat the badge as a disc; the short half-side plus a
			// small margin keeps the test meaningfully tight.
			radiusPx: Math.min(candidate.widthPx ?? 54, candidate.heightPx ?? 42) / 2 + 4
		}));
}

interface FittedPad {
	readonly xPx: number;
	readonly yPx: number;
	/** Unit major-axis direction. */
	readonly ux: number;
	readonly uy: number;
	readonly halfMajorPx: number;
	readonly halfMinorPx: number;
	readonly evidenceCount: number;
	/** Rotation-swept template NCC confidence when this pad came from the sweep estimator. */
	readonly orientationScore?: number;
}

export interface PadOrientationSweep {
	readonly axisDeg: number;
	readonly score: number;
	readonly xPx: number;
	readonly yPx: number;
}

interface SweepPadTemplate {
	readonly axisDeg: number;
	readonly width: number;
	readonly height: number;
	readonly halfWidth: number;
	readonly halfHeight: number;
	readonly centered: Float64Array;
	readonly energy: number;
}

interface SweepSearchResult extends PadOrientationSweep {
	readonly template: SweepPadTemplate;
}

interface SweepRoi {
	readonly x0: number;
	readonly y0: number;
	readonly width: number;
	readonly height: number;
	readonly gray: Float64Array;
	readonly trusted: Uint8Array;
	readonly integral: Float64Array;
	readonly integralSq: Float64Array;
}

const SWEEP_ANGLE_STEP_DEG = 2.5;
const SWEEP_SEARCH_RADIUS_UI = 4;
const SWEEP_OCCLUSION_SEARCH_RADIUS_UI = 2;
const SWEEP_RIM_UI = 1.4;
const SWEEP_PAD_MAJOR_UI = 13;
const SWEEP_PAD_MINOR_UI = 8;
const SWEEP_RAW_RELIABLE_SCORE = 0.4;
const SWEEP_MEASURABLE_SCORE = 0.3;
const SWEEP_MASKED_RESCUE_SCORE = 0.4;
const SWEEP_NEAR_RAW_DEG = 10;
const sweepTemplateCache = new Map<string, readonly SweepPadTemplate[]>();

function sweepTemplates(uiScalePx: number): readonly SweepPadTemplate[] {
	const key = uiScalePx.toFixed(6);
	const cached = sweepTemplateCache.get(key);
	if (cached) return cached;

	const rim = Math.max(1, SWEEP_RIM_UI * uiScalePx);
	const margin = Math.ceil(rim) + 1;
	const templates: SweepPadTemplate[] = [];
	// The 13x8 UI canonical rectangle describes the pad body/rim centerline
	// closely, but real UDisc captures in this repo expose two nearby outer
	// footprints. Search both UI-derived interpretations instead of choosing a
	// fixture-specific size: compact adds one rim to each full dimension,
	// full adds a rim on each side. NCC decides from pixels at runtime.
	for (const outerRimMultiples of [1, 2] as const) {
		const major = SWEEP_PAD_MAJOR_UI * uiScalePx + outerRimMultiples * rim;
		const minor = SWEEP_PAD_MINOR_UI * uiScalePx + outerRimMultiples * rim;
		for (let axisDeg = 0; axisDeg < 180 - 1e-9; axisDeg += SWEEP_ANGLE_STEP_DEG) {
			const radians = (axisDeg * Math.PI) / 180;
			const cosine = Math.cos(radians);
			const sine = Math.sin(radians);
			const halfWidth = Math.ceil(Math.abs((major / 2) * cosine) + Math.abs((minor / 2) * sine)) + margin;
			const halfHeight = Math.ceil(Math.abs((major / 2) * sine) + Math.abs((minor / 2) * cosine)) + margin;
			const width = halfWidth * 2 + 1;
			const height = halfHeight * 2 + 1;
			const values = new Float64Array(width * height);
			let mean = 0;
			for (let y = 0; y < height; y += 1) {
				for (let x = 0; x < width; x += 1) {
					const dx = x - halfWidth;
					const dy = y - halfHeight;
					const localX = dx * cosine + dy * sine;
					const localY = -dx * sine + dy * cosine;
					const insideOuter = Math.abs(localX) <= major / 2 && Math.abs(localY) <= minor / 2;
					const insideInner = Math.abs(localX) <= major / 2 - rim && Math.abs(localY) <= minor / 2 - rim;
					const value = insideInner ? 158 : insideOuter ? 235 : 120;
					values[y * width + x] = value;
					mean += value;
				}
			}
			mean /= values.length;
			const centered = new Float64Array(values.length);
			let energy = 0;
			for (let index = 0; index < values.length; index += 1) {
				const value = values[index] - mean;
				centered[index] = value;
				energy += value * value;
			}
			templates.push({ axisDeg, width, height, halfWidth, halfHeight, centered, energy });
		}
	}
	sweepTemplateCache.set(key, templates);
	return templates;
}

function buildSweepRoi(
	raster: TeePadRaster,
	centerXPx: number,
	centerYPx: number,
	searchRadiusPx: number,
	templates: readonly SweepPadTemplate[],
	uiScalePx: number
): SweepRoi | undefined {
	const maxHalfWidth = Math.max(...templates.map((template) => template.halfWidth));
	const maxHalfHeight = Math.max(...templates.map((template) => template.halfHeight));
	const centerX = Math.round(centerXPx);
	const centerY = Math.round(centerYPx);
	const x0 = Math.max(0, centerX - searchRadiusPx - maxHalfWidth);
	const y0 = Math.max(0, centerY - searchRadiusPx - maxHalfHeight);
	const x1 = Math.min(raster.widthPx - 1, centerX + searchRadiusPx + maxHalfWidth);
	const y1 = Math.min(raster.heightPx - 1, centerY + searchRadiusPx + maxHalfHeight);
	const width = x1 - x0 + 1;
	const height = y1 - y0 + 1;
	if (width <= 0 || height <= 0) return undefined;

	const gray = new Float64Array(width * height);
	const black = new Uint8Array(width * height);
	const integralStride = width + 1;
	const integral = new Float64Array((width + 1) * (height + 1));
	const integralSq = new Float64Array((width + 1) * (height + 1));
	for (let y = 0; y < height; y += 1) {
		let rowSum = 0;
		let rowSumSq = 0;
		for (let x = 0; x < width; x += 1) {
			const sourceOffset = ((y0 + y) * raster.widthPx + x0 + x) * 4;
			const red = raster.rgba[sourceOffset];
			const green = raster.rgba[sourceOffset + 1];
			const blue = raster.rgba[sourceOffset + 2];
			const value = red * 0.299 + green * 0.587 + blue * 0.114;
			const index = y * width + x;
			gray[index] = value;
			black[index] = Math.max(red, green, blue) < 70 ? 1 : 0;
			rowSum += value;
			rowSumSq += value * value;
			const above = y * integralStride + x + 1;
			const here = (y + 1) * integralStride + x + 1;
			integral[here] = integral[above] + rowSum;
			integralSq[here] = integralSq[above] + rowSumSq;
		}
	}

	// Black outlines belong overwhelmingly to glyphs/badges/baskets rather
	// than the translucent pad. On weak raw matches only, masked NCC ignores a
	// small UI-scaled halo around those pixels instead of allowing a glyph edge
	// to dictate pad orientation.
	const trusted = new Uint8Array(width * height);
	trusted.fill(1);
	const halo = Math.max(1, Math.round(1.1 * uiScalePx));
	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			if (!black[y * width + x]) continue;
			for (let dy = -halo; dy <= halo; dy += 1) {
				for (let dx = -halo; dx <= halo; dx += 1) {
					const nx = x + dx;
					const ny = y + dy;
					if (nx >= 0 && ny >= 0 && nx < width && ny < height) trusted[ny * width + nx] = 0;
				}
			}
		}
	}
	return { x0, y0, width, height, gray, trusted, integral, integralSq };
}

function sweepAngleDifferenceDeg(a: number, b: number): number {
	const difference = Math.abs(a - b) % 180;
	return Math.min(difference, 180 - difference);
}

function rawSweepSearch(
	roi: SweepRoi,
	centerXPx: number,
	centerYPx: number,
	searchRadiusPx: number,
	templates: readonly SweepPadTemplate[],
	angleNearDeg?: number
): SweepSearchResult | undefined {
	const integralStride = roi.width + 1;
	const rectSum = (table: Float64Array, x: number, y: number, width: number, height: number): number => {
		const a = y * integralStride + x;
		const b = y * integralStride + x + width;
		const c = (y + height) * integralStride + x;
		const d = (y + height) * integralStride + x + width;
		return table[d] - table[b] - table[c] + table[a];
	};
	const centerX = Math.round(centerXPx);
	const centerY = Math.round(centerYPx);
	let best: SweepSearchResult | undefined;
	for (const template of templates) {
		if (angleNearDeg !== undefined && sweepAngleDifferenceDeg(template.axisDeg, angleNearDeg) > SWEEP_NEAR_RAW_DEG) continue;
		if (template.energy <= 0) continue;
		const count = template.width * template.height;
		for (let refinedY = centerY - searchRadiusPx; refinedY <= centerY + searchRadiusPx; refinedY += 1) {
			const localTop = refinedY - template.halfHeight - roi.y0;
			if (localTop < 0 || localTop + template.height > roi.height) continue;
			for (let refinedX = centerX - searchRadiusPx; refinedX <= centerX + searchRadiusPx; refinedX += 1) {
				const localLeft = refinedX - template.halfWidth - roi.x0;
				if (localLeft < 0 || localLeft + template.width > roi.width) continue;
				const sum = rectSum(roi.integral, localLeft, localTop, template.width, template.height);
				const sumSq = rectSum(roi.integralSq, localLeft, localTop, template.width, template.height);
				const patchEnergy = sumSq - (sum * sum) / count;
				if (patchEnergy <= 1e-9) continue;
				let cross = 0;
				for (let y = 0; y < template.height; y += 1) {
					const rasterRow = (localTop + y) * roi.width + localLeft;
					const templateRow = y * template.width;
					for (let x = 0; x < template.width; x += 1) {
						cross += roi.gray[rasterRow + x] * template.centered[templateRow + x];
					}
				}
				const score = cross / Math.sqrt(patchEnergy * template.energy);
				if (!best || score > best.score) best = { axisDeg: template.axisDeg, score, xPx: refinedX, yPx: refinedY, template };
			}
		}
	}
	return best;
}

function maskedSweepSearch(
	roi: SweepRoi,
	centerXPx: number,
	centerYPx: number,
	searchRadiusPx: number,
	templates: readonly SweepPadTemplate[],
	angleNearDeg?: number
): SweepSearchResult | undefined {
	const centerX = Math.round(centerXPx);
	const centerY = Math.round(centerYPx);
	let best: SweepSearchResult | undefined;
	for (const template of templates) {
		if (angleNearDeg !== undefined && sweepAngleDifferenceDeg(template.axisDeg, angleNearDeg) > SWEEP_NEAR_RAW_DEG) continue;
		for (let refinedY = centerY - searchRadiusPx; refinedY <= centerY + searchRadiusPx; refinedY += 1) {
			const localTop = refinedY - template.halfHeight - roi.y0;
			if (localTop < 0 || localTop + template.height > roi.height) continue;
			for (let refinedX = centerX - searchRadiusPx; refinedX <= centerX + searchRadiusPx; refinedX += 1) {
				const localLeft = refinedX - template.halfWidth - roi.x0;
				if (localLeft < 0 || localLeft + template.width > roi.width) continue;
				let count = 0;
				let patchSum = 0;
				let templateSum = 0;
				for (let y = 0; y < template.height; y += 1) {
					const rasterRow = (localTop + y) * roi.width + localLeft;
					const templateRow = y * template.width;
					for (let x = 0; x < template.width; x += 1) {
						const rasterIndex = rasterRow + x;
						if (!roi.trusted[rasterIndex]) continue;
						count += 1;
						patchSum += roi.gray[rasterIndex];
						templateSum += template.centered[templateRow + x];
					}
				}
				if (count < template.width * template.height * 0.45) continue;
				const patchMean = patchSum / count;
				const templateCenteredMean = templateSum / count;
				let cross = 0;
				let patchEnergy = 0;
				let templateEnergy = 0;
				for (let y = 0; y < template.height; y += 1) {
					const rasterRow = (localTop + y) * roi.width + localLeft;
					const templateRow = y * template.width;
					for (let x = 0; x < template.width; x += 1) {
						const rasterIndex = rasterRow + x;
						if (!roi.trusted[rasterIndex]) continue;
						const patchValue = roi.gray[rasterIndex] - patchMean;
						const templateValue = template.centered[templateRow + x] - templateCenteredMean;
						cross += patchValue * templateValue;
						patchEnergy += patchValue * patchValue;
						templateEnergy += templateValue * templateValue;
					}
				}
				if (patchEnergy <= 1e-9 || templateEnergy <= 1e-9) continue;
				const score = cross / Math.sqrt(patchEnergy * templateEnergy);
				if (!best || score > best.score) best = { axisDeg: template.axisDeg, score, xPx: refinedX, yPx: refinedY, template };
			}
		}
	}
	return best;
}

/**
 * Measure pad orientation with a rotation sweep of synthesized hollow-pad
 * templates. The ordinary path is TM_CCOEFF_NORMED-equivalent grayscale NCC
 * over a +-4 UI search window. Only weak raw matches invoke a second,
 * conservative pass that ignores black-glyph halos; no badge or basket
 * geometry enters the orientation estimate.
 */
export function sweepPadOrientation(
	raster: TeePadRaster,
	centerXPx: number,
	centerYPx: number,
	uiScalePx: number
): PadOrientationSweep | undefined {
	if (!Number.isFinite(centerXPx) || !Number.isFinite(centerYPx) || !Number.isFinite(uiScalePx) || uiScalePx <= 0) return undefined;
	const templates = sweepTemplates(uiScalePx);
	if (templates.length === 0) return undefined;
	const rawRadius = Math.max(1, Math.round(SWEEP_SEARCH_RADIUS_UI * uiScalePx));
	const roi = buildSweepRoi(raster, centerXPx, centerYPx, rawRadius, templates, uiScalePx);
	if (!roi) return undefined;
	const raw = rawSweepSearch(roi, centerXPx, centerYPx, rawRadius, templates);
	if (!raw || raw.score >= SWEEP_RAW_RELIABLE_SCORE) return raw;

	const maskedRadius = Math.max(1, Math.round(SWEEP_OCCLUSION_SEARCH_RADIUS_UI * uiScalePx));
	const maskedNear = maskedSweepSearch(roi, centerXPx, centerYPx, maskedRadius, templates, raw.axisDeg);
	const maskedGlobal = maskedSweepSearch(roi, centerXPx, centerYPx, maskedRadius, templates);

	// A strongly better free-axis masked match means the raw axis itself was
	// the glyph casualty. Require both reliable absolute evidence and a clear
	// margin over the near-raw alternative before rotating freely (Alex tee 11).
	if (
		maskedGlobal &&
		maskedGlobal.score >= SWEEP_MASKED_RESCUE_SCORE &&
		sweepAngleDifferenceDeg(maskedGlobal.axisDeg, raw.axisDeg) > SWEEP_NEAR_RAW_DEG &&
		maskedGlobal.score > (maskedNear?.score ?? -1) + 0.05
	) {
		return maskedGlobal;
	}

	// Strong masked evidence close to the raw axis may refine the angle and
	// center (Golden tee 12). With merely measurable evidence, keep the raw
	// angle/center and use the masked score only as confidence: that avoids
	// over-rotating a partly visible pad when the two independent estimates
	// already agree locally (Alex tee 13).
	if (maskedNear && maskedNear.score >= SWEEP_MASKED_RESCUE_SCORE) return maskedNear;
	if (maskedNear && maskedNear.score >= SWEEP_MEASURABLE_SCORE) {
		return { axisDeg: raw.axisDeg, xPx: raw.xPx, yPx: raw.yPx, score: maskedNear.score };
	}
	if (maskedGlobal && maskedGlobal.score >= SWEEP_MASKED_RESCUE_SCORE) return maskedGlobal;

	// No trustworthy orientation survived occlusion cleanup. Deliberately
	// force the confidence below the measurable threshold so callers report
	// UNMEASURABLE rather than a false invariant verdict (Alex tee 12).
	const fallbackScore = Math.max(maskedNear?.score ?? -1, maskedGlobal?.score ?? -1);
	return fallbackScore >= 0 ? { ...raw, score: Math.min(fallbackScore, SWEEP_MEASURABLE_SCORE - 1e-6) } : raw;
}

function fittedPadFromSweep(sweep: PadOrientationSweep, uiScalePx: number): FittedPad {
	const radians = (sweep.axisDeg * Math.PI) / 180;
	return {
		xPx: sweep.xPx,
		yPx: sweep.yPx,
		ux: Math.cos(radians),
		uy: Math.sin(radians),
		halfMajorPx: 6.5 * uiScalePx,
		halfMinorPx: 4 * uiScalePx,
		evidenceCount: 0,
		orientationScore: sweep.score
	};
}

/**
 * Fits a pad rectangle at a window via PCA over the RIM pixels only: clean
 * bright (off-structure, not black-adjacent). The interior soft-gray mask is
 * useless for orientation — a pad sitting on a gray path floods the window
 * (exactly tee 5's situation) — but the rim outline, even bisected, keeps
 * its fragments aligned along the pad's major axis.
 */
export function fitPadAt(
	raster: TeePadRaster,
	centerXPx: number,
	centerYPx: number,
	halfWindowPx: number,
	structures: DashStructures | undefined
): FittedPad | undefined {
	const points: Array<{ x: number; y: number }> = [];
	const x0 = Math.max(0, Math.round(centerXPx - halfWindowPx));
	const x1 = Math.min(raster.widthPx - 1, Math.round(centerXPx + halfWindowPx));
	const y0 = Math.max(0, Math.round(centerYPx - halfWindowPx));
	const y1 = Math.min(raster.heightPx - 1, Math.round(centerYPx + halfWindowPx));
	const brightAt = (x: number, y: number): boolean => {
		const offset = (y * raster.widthPx + x) * 4;
		const red = raster.rgba[offset];
		const green = raster.rgba[offset + 1];
		const blue = raster.rgba[offset + 2];
		const maximum = Math.max(red, green, blue);
		const minimum = Math.min(red, green, blue);
		const saturation = maximum === 0 ? 0 : ((maximum - minimum) * 255) / maximum;
		return maximum >= 185 && saturation <= 50;
	};
	const nearBlackAt = (x: number, y: number): boolean => {
		for (let dy = -3; dy <= 3; dy += 1) {
			for (let dx = -3; dx <= 3; dx += 1) {
				const nx = x + dx;
				const ny = y + dy;
				if (nx < 0 || ny < 0 || nx >= raster.widthPx || ny >= raster.heightPx) continue;
				const offset = (ny * raster.widthPx + nx) * 4;
				if (Math.max(raster.rgba[offset], raster.rgba[offset + 1], raster.rgba[offset + 2]) < 70) return true;
			}
		}
		return false;
	};
	// Component-level filtering. Per-pixel on-structure suppression is too
	// blunt for the fit: measured on tee 14, basket 13's ring runs nearly
	// tangent along BOTH long edges of the pad, so per-pixel suppression
	// deletes the rails and leaves only the short edges. A dash is a SMALL
	// blob sitting on a structure; a rim is a large component that may merely
	// graze one. So classify whole components: drop small mostly-on-structure
	// blobs (dashes) and black-adjacent components (glyphs/badges), keep the
	// rest intact.
	const margin = 10;
	const cx0 = Math.max(0, x0 - margin);
	const cx1 = Math.min(raster.widthPx - 1, x1 + margin);
	const cy0 = Math.max(0, y0 - margin);
	const cy1 = Math.min(raster.heightPx - 1, y1 + margin);
	const width = cx1 - cx0 + 1;
	const height = cy1 - cy0 + 1;
	const visited = new Uint8Array(width * height);
	const stack: number[] = [];
	for (let y = cy0; y <= cy1; y += 1) {
		for (let x = cx0; x <= cx1; x += 1) {
			const startIndex = (y - cy0) * width + (x - cx0);
			if (visited[startIndex] || !brightAt(x, y)) continue;
			const component: Array<{ x: number; y: number }> = [];
			let minX = x;
			let maxX = x;
			let minY = y;
			let maxY = y;
			let onStructure = 0;
			let blackAdjacent = 0;
			visited[startIndex] = 1;
			stack.push(startIndex);
			while (stack.length > 0) {
				const index = stack.pop() as number;
				const px = cx0 + (index % width);
				const py = cy0 + ((index / width) | 0);
				component.push({ x: px, y: py });
				if (px < minX) minX = px;
				if (px > maxX) maxX = px;
				if (py < minY) minY = py;
				if (py > maxY) maxY = py;
				if (structures && distanceToStructuresAt(px, py, structures) <= structures.bandPx) onStructure += 1;
				if (nearBlackAt(px, py)) blackAdjacent += 1;
				for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
					const nx = px + dx;
					const ny = py + dy;
					if (nx < cx0 || ny < cy0 || nx > cx1 || ny > cy1) continue;
					const neighborIndex = (ny - cy0) * width + (nx - cx0);
					if (visited[neighborIndex] || !brightAt(nx, ny)) continue;
					visited[neighborIndex] = 1;
					stack.push(neighborIndex);
				}
			}
			const span = Math.max(maxX - minX + 1, maxY - minY + 1);
			const isDash = span <= 25 && onStructure / component.length >= 0.5;
			// Glyph/badge white bodies are hugely black-adjacent; but a pad rim
			// over dark canopy also touches near-black pixels, so the black
			// test must stay PER-PIXEL — dropping whole components on it
			// deletes entire rims (measured: tees 1, 3, 11, 12).
			const isGlyphLike = blackAdjacent / component.length >= 0.6;
			if (isDash || isGlyphLike) continue;
			for (const point of component) {
				if (point.x < x0 || point.x > x1 || point.y < y0 || point.y > y1) continue;
				if (nearBlackAt(point.x, point.y)) continue;
				points.push(point);
			}
		}
	}
	if (points.length < 20) return undefined;
	// Dominant-line RANSAC: blob PCA is wrecked when the ring band swallows
	// part of the rim and leaves disjoint fragments, but the longest
	// collinear fragment IS a long-side ray — the direction the invariant
	// needs. Deterministic sampling keeps runs reproducible.
	const random = mulberry32(0xc0ffee);
	let bestInliers: Array<{ x: number; y: number }> = [];
	for (let iteration = 0; iteration < 300; iteration += 1) {
		const first = points[Math.floor(random() * points.length)];
		const second = points[Math.floor(random() * points.length)];
		const dx = second.x - first.x;
		const dy = second.y - first.y;
		const length = Math.hypot(dx, dy);
		if (length < 6) continue;
		const nx = -dy / length;
		const ny = dx / length;
		// A genuine long-side line runs within about the pad's half-minor of
		// the pad center (the scoring peak). Without this constraint, a long
		// bright feature at the window edge — measured: a basket-glyph cup
		// top 16px below tee 14's center — can out-inlier the pad's own
		// ring-bisected rails.
		if (Math.abs((centerXPx - first.x) * nx + (centerYPx - first.y) * ny) > 9) continue;
		const inliers = points.filter((point) => Math.abs((point.x - first.x) * nx + (point.y - first.y) * ny) <= 1.5);
		if (inliers.length > bestInliers.length) bestInliers = inliers;
	}
	if (bestInliers.length < 12) return undefined;
	let meanX = 0;
	let meanY = 0;
	for (const point of bestInliers) {
		meanX += point.x;
		meanY += point.y;
	}
	meanX /= bestInliers.length;
	meanY /= bestInliers.length;
	let covXx = 0;
	let covXy = 0;
	let covYy = 0;
	for (const point of bestInliers) {
		const dx = point.x - meanX;
		const dy = point.y - meanY;
		covXx += dx * dx;
		covXy += dx * dy;
		covYy += dy * dy;
	}
	const trace = covXx + covYy;
	const det = covXx * covYy - covXy * covXy;
	const lambda = trace / 2 + Math.sqrt(Math.max(0, (trace * trace) / 4 - det));
	let ux = lambda - covYy;
	let uy = covXy;
	const norm = Math.hypot(ux, uy);
	if (norm < 1e-9) {
		ux = 1;
		uy = 0;
	} else {
		ux /= norm;
		uy /= norm;
	}
	let maxAlong = 0;
	for (const point of bestInliers) {
		maxAlong = Math.max(maxAlong, Math.abs((point.x - meanX) * ux + (point.y - meanY) * uy));
	}
	// Center at the scoring peak (interior evidence centers better than the
	// surviving rim's centroid); minor half-axis from the canonical pad.
	return {
		xPx: centerXPx,
		yPx: centerYPx,
		ux,
		uy,
		halfMajorPx: Math.max(maxAlong, 10),
		halfMinorPx: 7,
		evidenceCount: bestInliers.length
	};
}

/** Same math as the battery's structure distance; local copy for the fitter. */
function distanceToStructuresAt(xPx: number, yPx: number, structures: DashStructures): number {
	let best = Number.POSITIVE_INFINITY;
	for (const circle of structures.circles) {
		const distance = Math.abs(Math.hypot(xPx - circle.xPx, yPx - circle.yPx) - circle.radiusPx);
		if (distance < best) best = distance;
	}
	for (const segment of structures.segments) {
		const vx = segment.bxPx - segment.axPx;
		const vy = segment.byPx - segment.ayPx;
		const lengthSquared = vx * vx + vy * vy;
		const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((xPx - segment.axPx) * vx + (yPx - segment.ayPx) * vy) / lengthSquared));
		const distance = Math.hypot(xPx - (segment.axPx + t * vx), yPx - (segment.ayPx + t * vy));
		if (distance < best) best = distance;
	}
	return best;
}

/**
 * The badge-ray invariant: a valid tee pad AIMS at its own number badge —
 * the rays along both long sides and the ray perpendicular to the front
 * (short) edge, i.e. the major-axis ray from the front-edge midpoint, all
 * intersect the badge. Checked as: the badge disc lies ahead of the pad
 * along its major axis, and all three parallel rays (center and the two
 * long-side offsets) pass within the badge disc.
 */
export function badgeRayInvariantHolds(pad: FittedPad, badge: BadgeAnchor): boolean {
	const toBadgeX = badge.xPx - pad.xPx;
	const toBadgeY = badge.yPx - pad.yPx;
	let ux = pad.ux;
	let uy = pad.uy;
	if (toBadgeX * ux + toBadgeY * uy < 0) {
		ux = -ux;
		uy = -uy;
	}
	const along = toBadgeX * ux + toBadgeY * uy;
	if (along <= pad.halfMajorPx) return false;
	const across = Math.abs(-toBadgeX * uy + toBadgeY * ux);
	const halfMinor = Math.min(Math.max(pad.halfMinorPx, 4), 16);
	// All three parallel rays — the front-perpendicular ray through the pad
	// center and the two long-side rays offset +/- halfMinor — must pass
	// within the badge disc.
	return (
		across <= badge.radiusPx &&
		Math.abs(across - halfMinor) <= badge.radiusPx &&
		across + halfMinor <= badge.radiusPx
	);
}

/** Deterministic PRNG so distractor sampling is reproducible run to run. */
function mulberry32(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let mixed = state;
		mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
		mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
		return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
	};
}

interface Bounds {
	readonly topPx: number;
	readonly bottomPx: number;
}

function deriveBounds(args: OverfitCliArgs, truth: readonly TeeTruth[], heightPx: number): Bounds {
	if (args.mapTopPx !== undefined && args.mapBottomPx !== undefined) {
		return { topPx: args.mapTopPx, bottomPx: args.mapBottomPx };
	}
	if (truth.length >= 3) {
		const ys = truth.map((hole) => hole.yPx);
		return {
			topPx: Math.max(0, Math.min(...ys) - 80),
			bottomPx: Math.min(heightPx, Math.max(...ys) + 80)
		};
	}
	return { topPx: 0, bottomPx: heightPx };
}

interface VerifyOutcome {
	readonly mode: 'gap-fill' | 'rerank' | 'sliding';
	readonly note?: string;
	readonly matchedNumbers: readonly number[];
	readonly missedNumbers: readonly number[];
	readonly falsePositiveCount: number;
	readonly candidates: readonly Readonly<{ xPx: number; yPx: number; score: number }>[];
}

export interface OverfitResult {
	readonly input: { path: string; widthPx: number; heightPx: number };
	readonly uiScalePx: number;
	readonly boundsPx: Bounds;
	readonly counts: { truth: number; distractors: number; hardNegatives: number; skipped: number };
	readonly metricReports: readonly MetricReport[];
	readonly tunedScorer: TunedTeeScorer;
	readonly targetHoles: readonly number[];
	readonly verifications: readonly VerifyOutcome[];
}

function candidateMatchesTruth(candidate: TeePadCandidate, truth: readonly TeeTruth[], tolerancePx: number): boolean {
	return truth.some((hole) => Math.hypot(candidate.xPx - hole.xPx, candidate.yPx - hole.yPx) <= tolerancePx);
}

function markdownReport(result: OverfitResult): string {
	const lines: string[] = [];
	lines.push('# Tee overfit report');
	lines.push('');
	lines.push(`Input: \`${result.input.path}\` (${result.input.widthPx}x${result.input.heightPx}), uiScalePx ${result.uiScalePx}`);
	lines.push(`Samples: ${result.counts.truth} truth, ${result.counts.distractors} distractors, ${result.counts.hardNegatives} hard negatives (${result.counts.skipped} skipped at image edge)`);
	lines.push(`Target holes (margin maximized first): ${result.targetHoles.join(', ')}`);
	lines.push('');
	lines.push('This scorer is deliberately overfit to this one image; there is no holdout.');
	lines.push('');
	lines.push('## Per-metric discrimination (sorted by hard-negative AUC)');
	lines.push('');
	lines.push('| metric | AUC all | AUC hard-neg | worst truth pct | truth local ranks (hole:rank/of) | direction |');
	lines.push('|---|---|---|---|---|---|');
	for (const report of result.metricReports) {
		const ranks = report.localRanks
			.map((entry) => `${entry.holeNumber ?? '?'}:${entry.rank}/${entry.localCount}`)
			.join(' ');
		lines.push(
			`| ${report.name} | ${report.aucAll.toFixed(3)} | ${report.aucHardNegatives.toFixed(3)} | ${report.worstTruthPercentile.toFixed(3)} | ${ranks} | ${report.higherIsTruth ? 'higher=tee' : 'lower=tee'} |`
		);
	}
	lines.push('');
	lines.push('## Tuned scorer');
	lines.push('');
	for (const metric of result.tunedScorer.metrics) {
		lines.push(`- ${metric.name}: weight ${metric.weight} (z-scored, mean ${metric.mean.toFixed(3)}, std ${metric.std.toFixed(3)})`);
	}
	lines.push(`- threshold: ${result.tunedScorer.threshold.toFixed(4)}`);
	lines.push(`- min local margin at fit: ${result.tunedScorer.minLocalMargin.toFixed(4)}`);
	lines.push('');
	for (const verification of result.verifications) {
		lines.push(`## Verification: ${verification.mode}`);
		lines.push('');
		lines.push(`Matched ${verification.matchedNumbers.length}/${verification.matchedNumbers.length + verification.missedNumbers.length}; missed: [${verification.missedNumbers.join(', ')}]; false positives: ${verification.falsePositiveCount}`);
		if (verification.note) lines.push(`\n${verification.note}`);
		lines.push('');
	}
	return `${lines.join('\n')}\n`;
}

function writeOverlay(
	input: LoadedInput,
	samples: readonly MetricSample[],
	verified: readonly VerifyOutcome[],
	outputPath: string
): void {
	const png = new PNG({ width: input.widthPx, height: input.heightPx });
	png.data.set(input.rgba);
	const mark = (xPx: number, yPx: number, radius: number, color: readonly [number, number, number]) => {
		for (let dy = -radius; dy <= radius; dy += 1) {
			for (let dx = -radius; dx <= radius; dx += 1) {
				const onRing = Math.abs(Math.hypot(dx, dy) - radius) < 0.8;
				if (!onRing) continue;
				const x = Math.round(xPx) + dx;
				const y = Math.round(yPx) + dy;
				if (x < 0 || y < 0 || x >= png.width || y >= png.height) continue;
				const offset = (y * png.width + x) * 4;
				png.data[offset] = color[0];
				png.data[offset + 1] = color[1];
				png.data[offset + 2] = color[2];
				png.data[offset + 3] = 255;
			}
		}
	};
	for (const sample of samples) {
		if (sample.label === 'truth') mark(sample.xPx, sample.yPx, 12, [0, 200, 0]);
		else if (sample.label === 'hard-negative') mark(sample.xPx, sample.yPx, 9, [220, 40, 40]);
	}
	for (const verification of verified) {
		for (const candidate of verification.candidates) {
			mark(candidate.xPx, candidate.yPx, verification.mode === 'rerank' ? 6 : 4, [40, 90, 255]);
		}
	}
	writeFileSync(outputPath, PNG.sync.write(png));
}

export async function runOverfit(args: OverfitCliArgs): Promise<OverfitResult> {
	const input = loadInput(args.inputPath);
	let truth = input.truth ?? [];
	if (args.truthPath) {
		const truthInput = loadInput(args.truthPath);
		if (!truthInput.truth || truthInput.truth.length === 0) throw new Error(`--truth bundle '${args.truthPath}' contains no holes[].tee truth.`);
		truth = truthInput.truth;
	}
	if (truth.length === 0) {
		throw new Error('No tee truth available. Provide a .chainspot.zip with holes[].tee, or pass --truth <bundle>.');
	}
	const uiScalePx = asUiScalePx(args.uiScalePx, 'overfit --ui-scale');
	const tolerancePx = 7 * uiScalePx;
	const cv = (await loadCv()) as unknown as TeePadCv;
	const raster: TeePadRaster = { rgba: input.rgba, widthPx: input.widthPx, heightPx: input.heightPx, sourceScale: 1 };
	const bounds = deriveBounds(args, truth, input.heightPx);
	const halfSizePx = args.patchHalfUi * uiScalePx;
	let dashStructures: DashStructures | undefined;
	if (args.basketsPath) {
		const baskets = loadBasketTruth(args.basketsPath);
		dashStructures = buildDashStructures(raster, baskets, truth);
		const radii = [...new Set(dashStructures.circles.map((circle) => Math.round(circle.radiusPx)))].sort((a, b) => a - b);
		console.log(`[overfit] dash structures: ${dashStructures.circles.length} rings (radii ${radii.join(',')}px) on ${baskets.length} baskets, ${dashStructures.segments.length} connectors`);
	}
	const context = createTeeMetricContext(uiScalePx, 16, dashStructures);

	console.log(`[overfit] input ${input.widthPx}x${input.heightPx}, ${truth.length} truth tees, band ${Math.round(bounds.topPx)}..${Math.round(bounds.bottomPx)}`);

	// Existing-detector candidates: hard negatives + the rerank pool.
	const detectorOptions: CalibratedTeePadDetectionOptions = {
		uiScalePx,
		mapBoundsPx: bounds,
		maxCandidates: RERANK_POOL_SIZE
	};
	const fused = detectCalibratedTeePadVariants(cv, raster, detectorOptions, ['fused'])[0]?.candidates ?? [];
	const occluded = detectCalibratedOccludedEdgeLoopCandidates(cv, raster, detectorOptions).candidates;
	const pool: TeePadCandidate[] = [...fused];
	for (const candidate of occluded) {
		if (!pool.some((existing) => Math.hypot(existing.xPx - candidate.xPx, existing.yPx - candidate.yPx) < 4)) {
			pool.push(candidate);
		}
	}
	console.log(`[overfit] detector pool: ${fused.length} fused + ${occluded.length} occluded -> ${pool.length} pooled candidates`);

	const patches: TeePatch[] = [];
	for (const hole of truth) {
		patches.push({ centerXPx: hole.xPx, centerYPx: hole.yPx, halfSizePx, label: 'truth', holeNumber: hole.number });
	}
	for (const candidate of pool) {
		if (candidateMatchesTruth(candidate, truth, tolerancePx)) continue;
		patches.push({ centerXPx: candidate.xPx, centerYPx: candidate.yPx, halfSizePx, label: 'hard-negative' });
	}

	// Grid distractors: everywhere in the band except right on a truth tee.
	const stride = 4 * uiScalePx;
	const exclusionPx = TRUTH_EXCLUSION_UI * uiScalePx;
	const gridCandidates: Array<{ xPx: number; yPx: number }> = [];
	for (let yPx = bounds.topPx + halfSizePx; yPx <= bounds.bottomPx - halfSizePx; yPx += stride) {
		for (let xPx = halfSizePx; xPx <= input.widthPx - halfSizePx; xPx += stride) {
			if (truth.some((hole) => Math.hypot(hole.xPx - xPx, hole.yPx - yPx) < exclusionPx)) continue;
			gridCandidates.push({ xPx, yPx });
		}
	}
	// Every grid point near a truth tee is kept: the search's local margins
	// must be measured against the full local competition, or the gap-fill
	// sliding peak will land on a distractor the fit never saw. Only the far
	// background is reservoir-sampled down to the cap.
	const localRadiusPx = LOCAL_RADIUS_UI * uiScalePx;
	const nearTruth = (point: { xPx: number; yPx: number }) =>
		truth.some((hole) => Math.hypot(hole.xPx - point.xPx, hole.yPx - point.yPx) <= localRadiusPx);
	const sampled: Array<{ xPx: number; yPx: number }> = gridCandidates.filter(nearTruth);
	const random = mulberry32(args.seed);
	let seen = 0;
	const localCount = sampled.length;
	for (const point of gridCandidates) {
		if (nearTruth(point)) continue;
		if (sampled.length - localCount < args.maxDistractors) sampled.push(point);
		else {
			const slot = Math.floor(random() * (seen + 1));
			if (slot < args.maxDistractors) sampled[localCount + slot] = point;
		}
		seen += 1;
	}
	for (const point of sampled) {
		patches.push({ centerXPx: point.xPx, centerYPx: point.yPx, halfSizePx, label: 'distractor' });
	}
	console.log(`[overfit] ${patches.length} patches (${truth.length} truth, ${sampled.length} grid distractors, ${patches.length - truth.length - sampled.length} hard negatives)`);

	const samples: MetricSample[] = [];
	let skipped = 0;
	for (let index = 0; index < patches.length; index += 1) {
		const patch = patches[index];
		const metrics = computePatchMetrics(cv, raster, patch, context);
		if (!metrics) {
			skipped += 1;
			continue;
		}
		samples.push({ label: patch.label, holeNumber: patch.holeNumber, xPx: patch.centerXPx, yPx: patch.centerYPx, metrics });
		if ((index + 1) % 100 === 0) console.log(`[overfit] metrics ${index + 1}/${patches.length}`);
	}
	console.log(`[overfit] metrics complete: ${samples.length} samples, ${skipped} skipped`);

	const neighborhoods = buildLocalNeighborhoods(samples, LOCAL_RADIUS_UI * uiScalePx);
	const metricReports = scoreMetricDiscrimination(METRIC_NAMES, samples, neighborhoods);
	let tunedScorer: TunedTeeScorer;
	if (args.scorerPath) {
		tunedScorer = loadTunedScorer(args.scorerPath);
		console.log(`[overfit] using frozen scorer from ${args.scorerPath} (greedy search skipped): ${tunedScorer.metrics.map((metric) => `${metric.weight > 0 ? '+' : ''}${metric.weight}*${metric.name}`).join(' ') || '(empty)'}`);
	} else {
		tunedScorer = greedySearchCombination(METRIC_NAMES, samples, neighborhoods, {
			requiredHoleNumbers: args.targetHoles
		});
		console.log(`[overfit] tuned scorer: ${tunedScorer.metrics.map((metric) => `${metric.weight > 0 ? '+' : ''}${metric.weight}*${metric.name}`).join(' ') || '(empty)'}`);
	}

	const verifications: VerifyOutcome[] = [];
	if (args.verify === 'gap-fill') {
		// Mirrors the production integration path: the baseline fused detector
		// keeps every hole it already matches; the tuned scorer only fills the
		// gaps via a local sliding search. When number-badge detection is
		// available the search anchors on the missed hole's BADGE (what
		// production would do) and validates candidates with the badge-ray
		// invariant: a valid pad's long-side rays and front-perpendicular ray
		// all intersect its own badge. Truth is used only for evaluation.
		let badges: readonly BadgeAnchor[] = [];
		if (args.templateDir) {
			try {
				badges = detectBadgeAnchors(cv, input, args.templateDir);
				console.log(`[overfit] badge anchors: ${badges.length} labeled badges`);
			} catch (error) {
				console.log(`[overfit] badge detection unavailable (${error instanceof Error ? error.message : String(error)}); gap-fill falls back to truth anchors`);
			}
		}
		const baseline = detectCalibratedTeePadVariants(cv, raster, { ...detectorOptions, maxCandidates: truth.length }, ['fused'])[0]?.candidates ?? [];
		const baselineEvaluation = evaluateTruth(truth, baseline, tolerancePx);
		const scorerMetrics = new Set(tunedScorer.metrics.map((metric) => metric.name));
		const gapStride = Math.max(1, uiScalePx);
		const searchRadius = GAP_SEARCH_RADIUS_UI * uiScalePx;
		const nmsRadius = NMS_RADIUS_UI * uiScalePx;
		const recovered: TeePadCandidate[] = [];
		const gapNotes: string[] = [];
		for (const missedNumber of baselineEvaluation.missedNumbers) {
			const hole = truth.find((entry) => entry.number === missedNumber);
			const badge = badges.find((entry) => entry.number === missedNumber);
			const anchor = badge ?? hole;
			if (!anchor) continue;
			const windows: Array<{ xPx: number; yPx: number; score: number }> = [];
			for (let yPx = anchor.yPx - searchRadius; yPx <= anchor.yPx + searchRadius; yPx += gapStride) {
				for (let xPx = anchor.xPx - searchRadius; xPx <= anchor.xPx + searchRadius; xPx += gapStride) {
					if (Math.hypot(xPx - anchor.xPx, yPx - anchor.yPx) > searchRadius) continue;
					const metrics = computePatchMetrics(
						cv,
						raster,
						{ centerXPx: xPx, centerYPx: yPx, halfSizePx, label: 'distractor' },
						context,
						scorerMetrics
					);
					if (!metrics) continue;
					const score = applyTunedScorer(tunedScorer, metrics);
					if (Number.isFinite(score)) windows.push({ xPx, yPx, score });
				}
			}
			windows.sort((a, b) => b.score - a.score);
			const peaks: Array<{ xPx: number; yPx: number; score: number }> = [];
			for (const window of windows) {
				if (peaks.length >= GAP_PEAK_CANDIDATES) break;
				if (peaks.some((peak) => Math.hypot(peak.xPx - window.xPx, peak.yPx - window.yPx) < nmsRadius)) continue;
				peaks.push(window);
			}
			let chosen: { xPx: number; yPx: number; score: number; validated: boolean } | undefined;
			for (const peak of peaks) {
				const sweep = sweepPadOrientation(raster, peak.xPx, peak.yPx, uiScalePx);
				if (!sweep) continue;
				const pad = fittedPadFromSweep(sweep, uiScalePx);
				if (badge) {
					const toX = badge.xPx - pad.xPx;
					const toY = badge.yPx - pad.yPx;
					const sign = toX * pad.ux + toY * pad.uy < 0 ? -1 : 1;
					const along = (toX * pad.ux + toY * pad.uy) * sign;
					const across = Math.abs(-toX * pad.uy + toY * pad.ux);
					console.log(
						`[overfit]   tee ${missedNumber} peak (${peak.xPx.toFixed(0)},${peak.yPx.toFixed(0)}) s=${peak.score.toFixed(2)}: sweep center (${pad.xPx.toFixed(1)},${pad.yPx.toFixed(1)}) axis ${sweep.axisDeg.toFixed(1)}deg ncc=${sweep.score.toFixed(3)} half ${pad.halfMajorPx.toFixed(1)}x${pad.halfMinorPx.toFixed(1)} | along ${along.toFixed(1)} across ${across.toFixed(1)} badgeR ${badge.radiusPx.toFixed(1)}`
					);
				}
				// The validator can report an axis as measurable at 0.3, but
				// auto-approving a NEW gap-fill location is a stronger claim. Use
				// the sweep's high-confidence regime here: weak/marginal axes still
				// fall through to the existing UNVALIDATED-top diagnostic path.
				if (!badge || sweep.score < 0.5) continue;
				if (badgeRayInvariantHolds(pad, badge)) {
					chosen = { xPx: pad.xPx, yPx: pad.yPx, score: peak.score, validated: true };
					break;
				}
			}
			if (!chosen && peaks[0]) chosen = { ...peaks[0], validated: false };
			if (chosen) {
				const anchorKind = badge ? `badge ${missedNumber}` : 'truth (no badge)';
				const distance = hole ? Math.hypot(chosen.xPx - hole.xPx, chosen.yPx - hole.yPx) : Number.NaN;
				gapNotes.push(
					`tee ${missedNumber}: ${chosen.validated ? 'badge-ray-validated' : 'UNVALIDATED top'} peak at (${chosen.xPx.toFixed(1)}, ${chosen.yPx.toFixed(1)}), score ${chosen.score.toFixed(3)}, anchored on ${anchorKind}, ${distance.toFixed(1)}px from truth (tolerance ${tolerancePx.toFixed(1)}px)`
				);
				recovered.push({
					xPx: chosen.xPx,
					yPx: chosen.yPx,
					widthPx: 2 * halfSizePx,
					heightPx: 2 * halfSizePx,
					orientationDeg: 0,
					score: chosen.score,
					support: []
				} as unknown as TeePadCandidate);
			} else {
				gapNotes.push(`tee ${missedNumber}: no finite-score window in radius`);
			}
		}
		const evaluation = evaluateTruth(truth, [...baseline, ...recovered], tolerancePx);
		verifications.push({
			mode: 'gap-fill',
			note: `baseline matched ${baselineEvaluation.matchedNumbers.length}/${truth.length} (missed [${baselineEvaluation.missedNumbers.join(', ')}]); ${gapNotes.join('; ') || 'no gaps'}`,
			matchedNumbers: evaluation.matchedNumbers,
			missedNumbers: evaluation.missedNumbers,
			falsePositiveCount: evaluation.falsePositiveCount,
			candidates: recovered.map((candidate) => ({ xPx: candidate.xPx, yPx: candidate.yPx, score: candidate.score }))
		});
		console.log(`[overfit] gap-fill: baseline ${baselineEvaluation.matchedNumbers.length}/${truth.length} -> combined ${evaluation.matchedNumbers.length}/${truth.length}, missed [${evaluation.missedNumbers.join(',')}]`);
		for (const note of gapNotes) console.log(`[overfit]   ${note}`);
	}
	if (args.verify === 'rerank' || args.verify === 'both') {
		const scored = pool
			.map((candidate) => {
				const metrics = computePatchMetrics(
					cv,
					raster,
					{ centerXPx: candidate.xPx, centerYPx: candidate.yPx, halfSizePx, label: 'distractor' },
					context
				);
				return metrics ? { candidate, score: applyTunedScorer(tunedScorer, metrics) } : undefined;
			})
			.filter((entry): entry is { candidate: TeePadCandidate; score: number } => entry !== undefined)
			.sort((a, b) => b.score - a.score)
			.slice(0, truth.length)
			.map((entry) => ({ ...entry.candidate, score: entry.score }));
		const evaluation = evaluateTruth(truth, scored, tolerancePx);
		verifications.push({
			mode: 'rerank',
			matchedNumbers: evaluation.matchedNumbers,
			missedNumbers: evaluation.missedNumbers,
			falsePositiveCount: evaluation.falsePositiveCount,
			candidates: scored.map((candidate) => ({ xPx: candidate.xPx, yPx: candidate.yPx, score: candidate.score }))
		});
		console.log(`[overfit] rerank: matched ${evaluation.matchedNumbers.length}/${truth.length}, missed [${evaluation.missedNumbers.join(',')}]`);
	}
	if (args.verify === 'sliding' || args.verify === 'both') {
		const slidingStride = Math.max(1, args.slidingStrideUi * uiScalePx);
		const scorerMetrics = new Set(tunedScorer.metrics.map((metric) => metric.name));
		const scoredPoints: Array<{ xPx: number; yPx: number; score: number }> = [];
		let visited = 0;
		for (let yPx = bounds.topPx + halfSizePx; yPx <= bounds.bottomPx - halfSizePx; yPx += slidingStride) {
			for (let xPx = halfSizePx; xPx <= input.widthPx - halfSizePx; xPx += slidingStride) {
				const metrics = computePatchMetrics(
					cv,
					raster,
					{ centerXPx: xPx, centerYPx: yPx, halfSizePx, label: 'distractor' },
					context,
					scorerMetrics
				);
				visited += 1;
				if (visited % 2000 === 0) console.log(`[overfit] sliding ${visited} windows...`);
				if (!metrics) continue;
				const score = applyTunedScorer(tunedScorer, metrics);
				if (Number.isFinite(score)) scoredPoints.push({ xPx, yPx, score });
			}
		}
		scoredPoints.sort((a, b) => b.score - a.score);
		const nmsRadius = NMS_RADIUS_UI * uiScalePx;
		const kept: Array<{ xPx: number; yPx: number; score: number }> = [];
		for (const point of scoredPoints) {
			if (kept.length >= truth.length) break;
			if (kept.some((existing) => Math.hypot(existing.xPx - point.xPx, existing.yPx - point.yPx) < nmsRadius)) continue;
			kept.push(point);
		}
		const asCandidates = kept.map((point) => ({
			xPx: point.xPx,
			yPx: point.yPx,
			widthPx: 2 * halfSizePx,
			heightPx: 2 * halfSizePx,
			orientationDeg: 0,
			score: point.score,
			support: [] as const
		}));
		const evaluation = evaluateTruth(truth, asCandidates as unknown as readonly TeePadCandidate[], tolerancePx);
		verifications.push({
			mode: 'sliding',
			matchedNumbers: evaluation.matchedNumbers,
			missedNumbers: evaluation.missedNumbers,
			falsePositiveCount: evaluation.falsePositiveCount,
			candidates: kept
		});
		console.log(`[overfit] sliding: matched ${evaluation.matchedNumbers.length}/${truth.length}, missed [${evaluation.missedNumbers.join(',')}]`);
	}

	const result: OverfitResult = {
		input: { path: input.sourcePath, widthPx: input.widthPx, heightPx: input.heightPx },
		uiScalePx,
		boundsPx: bounds,
		counts: {
			truth: samples.filter((sample) => sample.label === 'truth').length,
			distractors: samples.filter((sample) => sample.label === 'distractor').length,
			hardNegatives: samples.filter((sample) => sample.label === 'hard-negative').length,
			skipped
		},
		metricReports,
		tunedScorer,
		targetHoles: args.targetHoles,
		verifications
	};

	const outputDir = resolve(args.outputDir);
	mkdirSync(outputDir, { recursive: true });
	writeFileSync(join(outputDir, 'overfit-report.json'), `${JSON.stringify(result, null, 2)}\n`);
	writeFileSync(join(outputDir, 'samples.json'), `${JSON.stringify(samples)}\n`);
	writeFileSync(join(outputDir, 'overfit-report.md'), markdownReport(result));
	writeFileSync(join(outputDir, 'tuned-scorer.json'), `${JSON.stringify(tunedScorer, null, 2)}\n`);
	writeOverlay(input, samples, verifications, join(outputDir, 'overfit-overlay.png'));
	console.log(`[overfit] report written to ${outputDir}`);
	return result;
}

async function main(): Promise<void> {
	await runOverfit(parseArgs(process.argv.slice(2)));
}

if (resolve(process.argv[1] ?? '') === resolve(scriptPath)) {
	main().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
