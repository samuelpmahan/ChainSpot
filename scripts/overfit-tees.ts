import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { strFromU8, unzipSync } from 'fflate';
import { PNG } from 'pngjs';
import { loadCv } from '../src/lib/stitch/cvMatch';
import { evaluateTruth, loadInput } from './detect-tees';
import type { LoadedInput, TeeTruth } from './detect-tees';
import {
	detectCalibratedOccludedEdgeLoopCandidates,
	detectCalibratedTeePadVariants
} from '../src/lib/autoAnnotation/cvCalibratedDetectors';
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
	readonly uiScalePx: number;
	readonly mapTopPx?: number;
	readonly mapBottomPx?: number;
	readonly maxDistractors: number;
	readonly patchHalfUi: number;
	readonly seed: number;
	readonly verify: OverfitVerifyMode;
	readonly targetHoles: readonly number[];
	readonly slidingStrideUi: number;
}

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = resolve(dirname(scriptPath), '..');

const DEFAULT_UI_SCALE = 1.77;
const TRUTH_EXCLUSION_UI = 10;
const LOCAL_RADIUS_UI = 40;
const NMS_RADIUS_UI = 10;
const RERANK_POOL_SIZE = 80;

function usage(): string {
	return [
		'Usage: npm run overfit:tees -- <image-or-chainspot-zip> --out <directory>',
		'',
		'Options:',
		'  --truth <bundle.chainspot.zip>  Take holes[].tee truth from this bundle (for plain-image inputs)',
		'  --baskets <bundle.chainspot.zip>  Basket truth bundle; enables dash-structure metrics (rings fitted from the image, connectors basket N -> tee N+1)',
		'  --ui-scale <n>                  Source pixels per UI pixel (default: 1.77, the GoldenTeeSet guardrail value)',
		'  --map-top/--map-bottom <px>     Restrict sampling band (default: derived from truth extent)',
		'  --max-distractors <n>           Grid distractor sample cap (default: 500)',
		'  --patch-half-ui <n>             Patch half-size in UI-pixel multiples (default: 6)',
		'  --seed <n>                      Distractor sampling seed (default: 1337)',
		'  --verify <gap-fill|rerank|sliding|both|none>  Post-search verification (default: gap-fill)',
		'  --target-hole <n>               Hole whose margin the search must maximize first (repeatable; default: 5)',
		'  --sliding-stride-ui <n>         Sliding-verify stride in UI pixels (default: 3)',
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
		uiScalePx,
		mapTopPx,
		mapBottomPx,
		maxDistractors,
		patchHalfUi,
		seed,
		verify,
		targetHoles: targetHoles.length > 0 ? targetHoles : [5],
		slidingStrideUi
	};
}

interface BasketTruth {
	readonly number: number;
	readonly xPx: number;
	readonly yPx: number;
}

function loadBasketTruth(bundlePath: string): readonly BasketTruth[] {
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

function buildDashStructures(
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
	const tunedScorer = greedySearchCombination(METRIC_NAMES, samples, neighborhoods, {
		requiredHoleNumbers: args.targetHoles
	});
	console.log(`[overfit] tuned scorer: ${tunedScorer.metrics.map((metric) => `${metric.weight > 0 ? '+' : ''}${metric.weight}*${metric.name}`).join(' ') || '(empty)'}`);

	const verifications: VerifyOutcome[] = [];
	if (args.verify === 'gap-fill') {
		// Mirrors the production integration path: the baseline fused detector
		// keeps every hole it already matches; the tuned scorer only fills the
		// gaps via a local sliding search (radius = the production gap-fallback
		// radius). The truth position stands in for the hole's number badge as
		// the search anchor — same radius, so same difficulty.
		const baseline = detectCalibratedTeePadVariants(cv, raster, { ...detectorOptions, maxCandidates: truth.length }, ['fused'])[0]?.candidates ?? [];
		const baselineEvaluation = evaluateTruth(truth, baseline, tolerancePx);
		const scorerMetrics = new Set(tunedScorer.metrics.map((metric) => metric.name));
		const gapStride = Math.max(1, uiScalePx);
		const searchRadius = LOCAL_RADIUS_UI * uiScalePx;
		const recovered: TeePadCandidate[] = [];
		const gapNotes: string[] = [];
		for (const missedNumber of baselineEvaluation.missedNumbers) {
			const hole = truth.find((entry) => entry.number === missedNumber);
			if (!hole) continue;
			let best: { xPx: number; yPx: number; score: number } | undefined;
			for (let yPx = hole.yPx - searchRadius; yPx <= hole.yPx + searchRadius; yPx += gapStride) {
				for (let xPx = hole.xPx - searchRadius; xPx <= hole.xPx + searchRadius; xPx += gapStride) {
					if (Math.hypot(xPx - hole.xPx, yPx - hole.yPx) > searchRadius) continue;
					const metrics = computePatchMetrics(
						cv,
						raster,
						{ centerXPx: xPx, centerYPx: yPx, halfSizePx, label: 'distractor' },
						context,
						scorerMetrics
					);
					if (!metrics) continue;
					const score = applyTunedScorer(tunedScorer, metrics);
					if (Number.isFinite(score) && (!best || score > best.score)) best = { xPx, yPx, score };
				}
			}
			if (best) {
				const distance = Math.hypot(best.xPx - hole.xPx, best.yPx - hole.yPx);
				gapNotes.push(`hole ${missedNumber}: peak at (${best.xPx.toFixed(1)}, ${best.yPx.toFixed(1)}), score ${best.score.toFixed(3)}, ${distance.toFixed(1)}px from truth (tolerance ${tolerancePx.toFixed(1)}px)`);
				recovered.push({
					xPx: best.xPx,
					yPx: best.yPx,
					widthPx: 2 * halfSizePx,
					heightPx: 2 * halfSizePx,
					orientationDeg: 0,
					score: best.score,
					support: []
				} as unknown as TeePadCandidate);
			} else {
				gapNotes.push(`hole ${missedNumber}: no finite-score window in radius`);
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
