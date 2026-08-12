import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import jpeg from 'jpeg-js';
import { strFromU8, unzipSync } from 'fflate';
import { PNG } from 'pngjs';
import { loadCv } from '../src/lib/stitch/cvMatch';
import {
	detectBasketCandidatesAtTemplateScale,
	detectCalibratedBasketOcclusionFallback,
	detectCalibratedHoleNumberBadges,
	detectCalibratedTeeBootstrap,
	detectCalibratedTeePadCandidates
} from '../src/lib/autoAnnotation/cvCalibratedDetectors';
import type { CalibratedBasketCandidate, TeeBootstrapExperiments } from '../src/lib/autoAnnotation/cvCalibratedDetectors';
import {
	basketRecoverySamplesFromGrammar,
	deriveBasketDistanceBand,
	findUnresolvedBasketHoles,
	isSameBasketCandidate
} from '../src/lib/autoAnnotation/basketOcclusionRecovery';
import {
	asUiScalePx,
	deriveBasketTemplateScale,
	deriveUDiscCalibration,
	validateCvTemplateManifest
} from '../src/lib/autoAnnotation/cvCalibration';
import type { CvTemplateManifest, UiScalePx } from '../src/lib/autoAnnotation/cvCalibration';
import type { BasketCv, BasketTemplateRaster } from '../src/lib/autoAnnotation/basketTemplateDetection';
import type { TeePadCandidate, TeePadCv } from '../src/lib/autoAnnotation/teePadDetection';
import type { HoleNumberCvModule, HoleNumberTemplate } from '../src/lib/autoAnnotation/holeNumberDetection';
import { associateCourseGrammar } from '../src/lib/autoAnnotation/courseGrammar';
import type { CourseGrammarResult } from '../src/lib/autoAnnotation/courseGrammar';
import {
	buildActiveReviewMap,
	livePlacementsFromGrammar,
	recommendNextAnchor,
	summarizeTeeInvariant
} from '../src/lib/autoAnnotation/activeReview';
import type { ActiveReviewMap, ActiveReviewRecommendation } from '../src/lib/autoAnnotation/activeReview';
import type { CourseDetectionResult } from '../src/lib/autoAnnotation/basketDetection';

/**
 * End-to-end "what does the real pipeline actually do" CLI: runs number,
 * basket, and tee detection plus course-grammar ownership against one image
 * or `.chainspot.zip`, exactly like `basketDetection.worker.ts`'s
 * `detect-course` request, and renders a single numbered overlay PNG so the
 * result can be eyeballed without opening the app.
 */

export interface CourseCliArgs {
	readonly inputPath: string;
	readonly outputDir: string;
	readonly templateDir: string;
	readonly uiScalePx?: number;
	readonly mapTopPx?: number;
	readonly mapBottomPx?: number;
	readonly maxTeeCandidates: number;
	readonly maxBasketCandidates: number;
	readonly minBasketScore?: number;
	readonly minAutoSuggestScore?: number;
	/** Off-by-default, safe-but-unproven detection levers. See `TeeBootstrapExperiments`. */
	readonly experiments?: TeeBootstrapExperiments;
}

interface DecodedRaster {
	readonly rgba: Uint8Array;
	readonly widthPx: number;
	readonly heightPx: number;
}

interface CourseTruthHole {
	readonly number: number;
	readonly tee?: { readonly xPx: number; readonly yPx: number };
	readonly basket?: { readonly xPx: number; readonly yPx: number };
}

interface LoadedInput extends DecodedRaster {
	readonly sourcePath: string;
	readonly sourceEntry?: string;
	readonly truth?: readonly CourseTruthHole[];
}

interface CourseProjectDocument {
	readonly images?: readonly Readonly<{
		role?: unknown;
		fileName?: unknown;
		bundlePath?: unknown;
	}>[];
	readonly holes?: readonly Readonly<{
		number?: unknown;
		tee?: Readonly<{ xPx?: unknown; yPx?: unknown }>;
		basket?: Readonly<{ xPx?: unknown; yPx?: unknown }>;
	}>[];
}

export interface CourseCliResult {
	readonly input: {
		readonly path: string;
		readonly sourceEntry?: string;
		readonly widthPx: number;
		readonly heightPx: number;
	};
	readonly uiScalePx: number;
	readonly basketTemplateScale: number;
	readonly mapBoundsPx?: Readonly<{ topPx: number; bottomPx: number }>;
	readonly counts: {
		readonly numberCandidates: number;
		readonly labeledNumbers: number;
		readonly basketCandidates: number;
		readonly teeCandidates: number;
		readonly readyHoles: number;
		readonly reviewHoles: number;
		readonly incompleteHoles: number;
		readonly basketFallbackUnresolvedHoles: number;
		readonly basketFallbackRecovered: number;
	};
	readonly teeBootstrap: {
		readonly auto: number;
		readonly review: number;
		readonly unresolved: number;
		readonly holes: readonly Readonly<{
			holeNumber: number;
			decision: 'auto' | 'review' | 'unresolved';
			candidateIndex?: number;
			confidence?: number;
		}>[];
	};
	readonly grammar: CourseGrammarResult;
	readonly teeTruthEvaluation?: {
		readonly tolerancePx: number;
		readonly correctHoles: readonly number[];
		readonly wrongHoles: readonly { holeNumber: number; distancePx: number }[];
		readonly missingHoles: readonly number[];
	};
	readonly basketTruthEvaluation?: {
		readonly tolerancePx: number;
		readonly correctHoles: readonly number[];
		readonly wrongHoles: readonly { holeNumber: number; distancePx: number }[];
		readonly missingHoles: readonly number[];
	};
	/** Same layer the browser's active-review panel runs on acceptance clicks (see activeReview.ts) — surfaced here so a CLI run shows what the reviewer would suggest next, not just raw grammar counts. */
	readonly activeReview: {
		readonly candidateCount: number;
		readonly unassignedTees: number;
		readonly unassignedBaskets: number;
		readonly teeAxisAlignmentMean: number | null;
		readonly teeAxisAlignmentMin: number | null;
		readonly teeAxisAlignmentAtLeast90Pct: number;
		readonly teeDistanceRank1: number;
		readonly teeDistanceMarginMedian: number | null;
		readonly recommendation: Record<string, unknown>;
	};
	readonly overlayPath: string;
	readonly activeReviewPath: string;
	readonly elapsedMs: number;
}

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = resolve(dirname(scriptPath), '..');
const defaultTemplateDir = join(projectRoot, 'static', 'resources', 'chainspot_cv_templates');

function usage(): string {
	return [
		'Usage: npm run detect:course -- <image-or-chainspot-zip> --out <directory>',
		'',
		'Runs the same number/basket/tee detection + course-grammar ownership as',
		"the app's \"detect-course\" pipeline and renders a single numbered overlay.",
		'',
		'Options:',
		'  --templates <directory>       CV template pack (default: static/resources/chainspot_cv_templates)',
		'  --ui-scale <source-pixels>    Override the derived UDisc UI scale',
		'  --map-top <source-pixels>     Restrict detection to this source row',
		'  --map-bottom <source-pixels>  Restrict detection to this source row',
		'  --max-tees <count>            Tee candidate cap (default: 18)',
		'  --max-baskets <count>         Basket candidate cap (default: 18)',
		'  --min-basket-score <0..1>     Basket NCC floor (default: detector default)',
		'  --min-auto-suggest-score <0..1>  Active-review auto-suggest floor (default: recommender default)',
		'  --experiment-walking-path-masking  Fold dashed-path chains into tee-recovery occlusion masking (off by default; see docs/deferred-detection-experiments.md)',
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

export function parseArgs(argv: readonly string[]): CourseCliArgs {
	if (argv.includes('--help')) throw new Error(usage());
	const positional = argv.find((value) => !value.startsWith('--'));
	if (!positional) throw new Error(`An image or .chainspot.zip input is required.\n\n${usage()}`);

	let outputDir: string | undefined;
	let templateDir = defaultTemplateDir;
	let uiScalePx: number | undefined;
	let mapTopPx: number | undefined;
	let mapBottomPx: number | undefined;
	let maxTeeCandidates = 18;
	let maxBasketCandidates = 18;
	let minBasketScore: number | undefined;
	let minAutoSuggestScore: number | undefined;
	let experimentWalkingPathMasking = false;

	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (!argument.startsWith('--')) continue;
		switch (argument) {
			case '--out':
				outputDir = requireValue(argv, index, argument);
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
			case '--max-tees':
				maxTeeCandidates = finiteNumber(requireValue(argv, index, argument), argument);
				index += 1;
				if (!Number.isInteger(maxTeeCandidates) || maxTeeCandidates < 1) throw new Error('--max-tees must be a positive integer.');
				break;
			case '--max-baskets':
				maxBasketCandidates = finiteNumber(requireValue(argv, index, argument), argument);
				index += 1;
				if (!Number.isInteger(maxBasketCandidates) || maxBasketCandidates < 1) throw new Error('--max-baskets must be a positive integer.');
				break;
			case '--min-basket-score':
				minBasketScore = finiteNumber(requireValue(argv, index, argument), argument);
				index += 1;
				break;
			case '--min-auto-suggest-score':
				minAutoSuggestScore = finiteNumber(requireValue(argv, index, argument), argument);
				index += 1;
				break;
			case '--experiment-walking-path-masking':
				experimentWalkingPathMasking = true;
				break;
			default:
				throw new Error(`Unknown option '${argument}'.\n\n${usage()}`);
		}
	}
	if (!outputDir) throw new Error(`--out is required.\n\n${usage()}`);
	if (mapTopPx !== undefined && mapBottomPx !== undefined && mapTopPx > mapBottomPx) throw new Error('--map-top cannot be greater than --map-bottom.');
	if ((mapTopPx === undefined) !== (mapBottomPx === undefined)) throw new Error('--map-top and --map-bottom must be provided together.');
	return {
		inputPath: positional,
		outputDir,
		templateDir,
		uiScalePx,
		mapTopPx,
		mapBottomPx,
		maxTeeCandidates,
		maxBasketCandidates,
		minBasketScore,
		minAutoSuggestScore,
		experiments: { walkingPathMasking: experimentWalkingPathMasking }
	};
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
	throw new Error(`Unsupported image format '${extension}'. Use PNG, JPEG, or a .chainspot.zip bundle.`);
}

function truthFromDocument(document: CourseProjectDocument): readonly CourseTruthHole[] {
	return (document.holes ?? [])
		.map((hole) => ({
			number: typeof hole.number === 'number' ? hole.number : NaN,
			tee:
				typeof hole.tee?.xPx === 'number' && typeof hole.tee?.yPx === 'number'
					? { xPx: hole.tee.xPx, yPx: hole.tee.yPx }
					: undefined,
			basket:
				typeof hole.basket?.xPx === 'number' && typeof hole.basket?.yPx === 'number'
					? { xPx: hole.basket.xPx, yPx: hole.basket.yPx }
					: undefined
		}))
		.filter((hole) => Number.isInteger(hole.number))
		.sort((a, b) => a.number - b.number);
}

function loadInput(inputPath: string): LoadedInput {
	const resolvedInput = resolve(inputPath);
	const bytes = new Uint8Array(readFileSync(resolvedInput));
	if (!resolvedInput.toLowerCase().endsWith('.chainspot.zip')) return { ...decodeRaster(bytes, resolvedInput), sourcePath: resolvedInput };
	const entries = unzipSync(bytes);
	const jsonBytes = entries['project.json'];
	if (!jsonBytes) throw new Error(`Bundle '${resolvedInput}' does not contain project.json.`);
	const document = JSON.parse(strFromU8(jsonBytes)) as CourseProjectDocument;
	const sourceManifest = (document.images ?? []).find((image) => image.role === 'source-overview');
	const sourceEntry = sourceManifest?.bundlePath;
	if (typeof sourceEntry !== 'string' || !sourceEntry.startsWith('images/')) throw new Error(`Bundle '${resolvedInput}' does not contain a safe source-overview image path.`);
	const sourceBytes = entries[sourceEntry];
	if (!sourceBytes) throw new Error(`Bundle '${resolvedInput}' is missing ${sourceEntry}.`);
	return {
		...decodeRaster(sourceBytes, typeof sourceManifest?.fileName === 'string' ? sourceManifest.fileName : sourceEntry),
		sourcePath: resolvedInput,
		sourceEntry,
		truth: truthFromDocument(document)
	};
}

function loadValidatedTemplateManifest(templateDir: string): CvTemplateManifest {
	const root = resolve(templateDir);
	const manifestPath = join(root, 'manifest.json');
	if (!existsSync(manifestPath)) throw new Error(`CV template manifest is missing: ${manifestPath}`);
	const manifest = validateCvTemplateManifest(JSON.parse(readFileSync(manifestPath, 'utf8')));
	for (const fileName of [...manifest.templates.holeNumbers, manifest.templates.basket]) {
		const assetPath = join(root, fileName);
		if (!existsSync(assetPath)) throw new Error(`CV template manifest asset is missing: ${assetPath}`);
	}
	return manifest;
}

function loadNumberTemplates(templateDir: string, manifest: CvTemplateManifest): readonly HoleNumberTemplate[] {
	return manifest.templates.holeNumbers.map((fileName, index) => {
		const label = index + 1;
		const path = join(resolve(templateDir), fileName);
		const decoded = decodeRaster(new Uint8Array(readFileSync(path)), path);
		return {
			label,
			raster: { format: 'rgba', widthPx: decoded.widthPx, heightPx: decoded.heightPx, data: decoded.rgba }
		};
	});
}

function toGray(raster: DecodedRaster): Uint8Array {
	const gray = new Uint8Array(raster.widthPx * raster.heightPx);
	for (let pixel = 0, offset = 0; pixel < gray.length; pixel += 1, offset += 4) {
		gray[pixel] = (raster.rgba[offset] * 0.299 + raster.rgba[offset + 1] * 0.587 + raster.rgba[offset + 2] * 0.114 + 0.5) | 0;
	}
	return gray;
}

function loadBasketTemplate(templateDir: string, manifest: CvTemplateManifest): BasketTemplateRaster {
	const path = join(resolve(templateDir), manifest.templates.basket);
	const decoded = decodeRaster(new Uint8Array(readFileSync(path)), path);
	return { gray: toGray(decoded), widthPx: decoded.widthPx, heightPx: decoded.heightPx };
}

function deriveMapBounds(candidates: readonly { readonly yPx: number }[], heightPx: number): Readonly<{ topPx: number; bottomPx: number }> | undefined {
	if (candidates.length < 3) return undefined;
	const ys = candidates.map((candidate) => candidate.yPx);
	const minY = Math.min(...ys);
	const maxY = Math.max(...ys);
	const margin = Math.max(80, Math.min(300, (maxY - minY) * 0.3));
	return { topPx: Math.max(0, minY - margin), bottomPx: Math.min(heightPx, maxY + margin) };
}

// --- minimal 3x5 bitmap digit font, just enough to label holes 1..18 -----

const DIGIT_FONT: Record<string, readonly string[]> = {
	'0': ['111', '101', '101', '101', '111'],
	'1': ['010', '110', '010', '010', '111'],
	'2': ['111', '001', '111', '100', '111'],
	'3': ['111', '001', '111', '001', '111'],
	'4': ['101', '101', '111', '001', '001'],
	'5': ['111', '100', '111', '001', '111'],
	'6': ['111', '100', '111', '101', '111'],
	'7': ['111', '001', '010', '010', '010'],
	'8': ['111', '101', '111', '101', '111'],
	'9': ['111', '101', '111', '001', '111']
};

function setPixel(png: PNG, x: number, y: number, color: readonly [number, number, number, number]): void {
	if (x < 0 || y < 0 || x >= png.width || y >= png.height) return;
	const offset = (y * png.width + x) * 4;
	png.data[offset] = color[0];
	png.data[offset + 1] = color[1];
	png.data[offset + 2] = color[2];
	png.data[offset + 3] = color[3];
}

function fillRect(png: PNG, x0: number, y0: number, x1: number, y1: number, color: readonly [number, number, number, number]): void {
	for (let y = Math.round(y0); y <= Math.round(y1); y += 1) {
		for (let x = Math.round(x0); x <= Math.round(x1); x += 1) setPixel(png, x, y, color);
	}
}

function line(png: PNG, x0: number, y0: number, x1: number, y1: number, color: readonly [number, number, number, number]): void {
	let x = Math.round(x0);
	let y = Math.round(y0);
	const targetX = Math.round(x1);
	const targetY = Math.round(y1);
	const dx = Math.abs(targetX - x);
	const dy = Math.abs(targetY - y);
	const stepX = x < targetX ? 1 : -1;
	const stepY = y < targetY ? 1 : -1;
	let error = dx - dy;
	while (true) {
		setPixel(png, x, y, color);
		if (x === targetX && y === targetY) break;
		const doubled = 2 * error;
		if (doubled > -dy) {
			error -= dy;
			x += stepX;
		}
		if (doubled < dx) {
			error += dx;
			y += stepY;
		}
	}
}

function drawDisc(png: PNG, cx: number, cy: number, radiusPx: number, color: readonly [number, number, number, number]): void {
	const r = Math.round(radiusPx);
	for (let dy = -r; dy <= r; dy += 1) {
		for (let dx = -r; dx <= r; dx += 1) {
			if (dx * dx + dy * dy <= r * r) setPixel(png, Math.round(cx) + dx, Math.round(cy) + dy, color);
		}
	}
}

/** Draws `text` (digits only) with its top-left at (x, y), each font pixel `pixelPx` wide, on a filled background plate for legibility against the aerial photo. */
function drawLabel(
	png: PNG,
	text: string,
	x: number,
	y: number,
	pixelPx: number,
	color: readonly [number, number, number, number],
	background: readonly [number, number, number, number] = [0, 0, 0, 255]
): void {
	const glyphWidth = 3 * pixelPx;
	const glyphHeight = 5 * pixelPx;
	const spacing = pixelPx;
	const totalWidth = text.length * glyphWidth + (text.length - 1) * spacing;
	fillRect(png, x - pixelPx, y - pixelPx, x + totalWidth + pixelPx, y + glyphHeight + pixelPx, background);
	for (let charIndex = 0; charIndex < text.length; charIndex += 1) {
		const glyph = DIGIT_FONT[text[charIndex]];
		if (!glyph) continue;
		const glyphX = x + charIndex * (glyphWidth + spacing);
		for (let row = 0; row < glyph.length; row += 1) {
			for (let col = 0; col < glyph[row].length; col += 1) {
				if (glyph[row][col] !== '1') continue;
				fillRect(
					png,
					glyphX + col * pixelPx,
					y + row * pixelPx,
					glyphX + col * pixelPx + pixelPx - 1,
					y + row * pixelPx + pixelPx - 1,
					color
				);
			}
		}
	}
}

const COLOR_TEE: readonly [number, number, number, number] = [255, 160, 0, 255];
const COLOR_BASKET: readonly [number, number, number, number] = [40, 220, 90, 255];
const COLOR_BADGE: readonly [number, number, number, number] = [80, 160, 255, 255];
const COLOR_LINK: readonly [number, number, number, number] = [255, 255, 255, 180];
const COLOR_RAW_TEE: readonly [number, number, number, number] = [255, 160, 0, 70];
const COLOR_RAW_BASKET: readonly [number, number, number, number] = [40, 220, 90, 70];

function renderOverlay(
	raster: DecodedRaster,
	grammar: CourseGrammarResult,
	rawTees: readonly TeePadCandidate[],
	rawBaskets: readonly CalibratedBasketCandidate[]
): Buffer {
	const png = new PNG({ width: raster.widthPx, height: raster.heightPx });
	png.data.set(raster.rgba);

	// Faint markers for every raw candidate first, so accepted ownership
	// stands out against whatever the detector rejected or reassigned.
	for (const tee of rawTees) drawDisc(png, tee.xPx, tee.yPx, 4, COLOR_RAW_TEE);
	for (const basket of rawBaskets) drawDisc(png, basket.xPx, basket.yPx, 4, COLOR_RAW_BASKET);

	for (const hole of grammar.holes) {
		const label = String(hole.number);
		if (hole.numberBadge && hole.tee) line(png, hole.numberBadge.xPx, hole.numberBadge.yPx, hole.tee.xPx, hole.tee.yPx, COLOR_LINK);
		if (hole.numberBadge && hole.basket) line(png, hole.numberBadge.xPx, hole.numberBadge.yPx, hole.basket.xPx, hole.basket.yPx, COLOR_LINK);

		if (hole.numberBadge) {
			drawDisc(png, hole.numberBadge.xPx, hole.numberBadge.yPx, 5, COLOR_BADGE);
			drawLabel(png, label, hole.numberBadge.xPx + 7, hole.numberBadge.yPx - 9, 2, COLOR_BADGE);
		}
		if (hole.tee) {
			drawDisc(png, hole.tee.xPx, hole.tee.yPx, 6, COLOR_TEE);
			drawLabel(png, label, hole.tee.xPx + 8, hole.tee.yPx - 2, 2, COLOR_TEE);
		}
		if (hole.basket) {
			drawDisc(png, hole.basket.xPx, hole.basket.yPx, 6, COLOR_BASKET);
			drawLabel(png, label, hole.basket.xPx + 8, hole.basket.yPx + 8, 2, COLOR_BASKET);
		}
	}
	return PNG.sync.write(png);
}

function evaluateTeeTruth(
	truth: readonly CourseTruthHole[],
	grammar: CourseGrammarResult,
	tolerancePx: number
): NonNullable<CourseCliResult['teeTruthEvaluation']> {
	const correctHoles: number[] = [];
	const wrongHoles: { holeNumber: number; distancePx: number }[] = [];
	const missingHoles: number[] = [];
	for (const expected of truth) {
		if (!expected.tee) continue;
		const hole = grammar.holes.find((candidate) => candidate.number === expected.number);
		if (!hole?.tee) {
			missingHoles.push(expected.number);
			continue;
		}
		const distancePx = Math.hypot(hole.tee.xPx - expected.tee.xPx, hole.tee.yPx - expected.tee.yPx);
		if (distancePx <= tolerancePx) correctHoles.push(expected.number);
		else wrongHoles.push({ holeNumber: expected.number, distancePx });
	}
	return { tolerancePx, correctHoles, wrongHoles, missingHoles };
}

function evaluateBasketTruth(
	truth: readonly CourseTruthHole[],
	grammar: CourseGrammarResult,
	tolerancePx: number
): NonNullable<CourseCliResult['basketTruthEvaluation']> {
	const correctHoles: number[] = [];
	const wrongHoles: { holeNumber: number; distancePx: number }[] = [];
	const missingHoles: number[] = [];
	for (const expected of truth) {
		if (!expected.basket) continue;
		const hole = grammar.holes.find((candidate) => candidate.number === expected.number);
		if (!hole?.basket) {
			missingHoles.push(expected.number);
			continue;
		}
		const distancePx = Math.hypot(hole.basket.xPx - expected.basket.xPx, hole.basket.yPx - expected.basket.yPx);
		if (distancePx <= tolerancePx) correctHoles.push(expected.number);
		else wrongHoles.push({ holeNumber: expected.number, distancePx });
	}
	return { tolerancePx, correctHoles, wrongHoles, missingHoles };
}

function meanOf(values: readonly number[]): number | null {
	return values.length === 0 ? null : Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(3));
}

function medianOf(values: readonly number[]): number | null {
	if (values.length === 0) return null;
	const sorted = values.slice().sort((left, right) => left - right);
	return sorted[Math.floor(sorted.length / 2)];
}

function recommendationSummary(recommendation: ActiveReviewRecommendation): Record<string, unknown> {
	return {
		kind: recommendation.kind,
		candidateKind: recommendation.kind === 'candidate' ? recommendation.candidateKind : null,
		candidateId: recommendation.kind === 'candidate' ? recommendation.candidateId : null,
		holeNumber: recommendation.holeNumber ?? null,
		score: recommendation.score,
		belowThreshold: recommendation.kind === 'candidate' ? recommendation.belowThreshold : null,
		timedOut: recommendation.timedOut,
		...(recommendation.kind === 'none' ? { reason: recommendation.reason } : {})
	};
}

/** Same snapshot the browser's active-review panel logs on every recompute (+page.svelte's logActiveReviewStats) — surfaced here so a CLI run exercises and reports on the recommender layer instead of stopping at grammar association. */
function summarizeActiveReview(
	detection: CourseDetectionResult,
	reviewMap: ActiveReviewMap,
	recommendation: ActiveReviewRecommendation
): CourseCliResult['activeReview'] {
	const teeInvariant = summarizeTeeInvariant(detection);
	const alignments = teeInvariant.map((stat) => stat.axisAlignment);
	const distanceMargins = teeInvariant
		.map((stat) => stat.distanceMarginPx)
		.filter((margin): margin is number => margin !== null);
	return {
		candidateCount: reviewMap.candidates.length,
		unassignedTees: detection.grammar.unassigned.teeCandidateIndexes.length,
		unassignedBaskets: detection.grammar.unassigned.basketCandidateIndexes.length,
		teeAxisAlignmentMean: meanOf(alignments),
		teeAxisAlignmentMin: alignments.length === 0 ? null : Math.min(...alignments),
		teeAxisAlignmentAtLeast90Pct: alignments.filter((value) => value >= 0.9).length,
		teeDistanceRank1: teeInvariant.filter((stat) => stat.distanceRank === 1).length,
		teeDistanceMarginMedian: medianOf(distanceMargins),
		recommendation: recommendationSummary(recommendation)
	};
}

export async function runCourseDetection(args: CourseCliArgs): Promise<CourseCliResult> {
	const startedAt = performance.now();
	const input = loadInput(args.inputPath);
	const cv = (await loadCv()) as unknown as TeePadCv & BasketCv & HoleNumberCvModule;
	const manifest = loadValidatedTemplateManifest(args.templateDir);
	const numberTemplates = loadNumberTemplates(args.templateDir, manifest);
	const basketTemplate = loadBasketTemplate(args.templateDir, manifest);

	const numberDetection = detectCalibratedHoleNumberBadges(cv, { format: 'rgba', widthPx: input.widthPx, heightPx: input.heightPx, data: input.rgba }, numberTemplates);
	if (!numberDetection.anchor) throw new Error(numberDetection.note ?? 'Could not derive UI scale from hole-number templates; pass --ui-scale.');

	const calibration = deriveUDiscCalibration(numberDetection.anchor, manifest.calibration.canonicalNumberBadge);
	const uiScalePx: UiScalePx = args.uiScalePx !== undefined ? asUiScalePx(args.uiScalePx, 'CLI --ui-scale') : calibration.uiScalePx;
	const basketTemplateScale = deriveBasketTemplateScale(numberDetection.anchor.scale, manifest.calibration);
	const mapBoundsPx =
		args.mapTopPx !== undefined && args.mapBottomPx !== undefined
			? { topPx: args.mapTopPx, bottomPx: args.mapBottomPx }
			: deriveMapBounds(numberDetection.candidates, input.heightPx);

	const basketRaster = { gray: toGray(input), widthPx: input.widthPx, heightPx: input.heightPx, sourceScale: 1 };
	const primaryBasketCandidates = detectBasketCandidatesAtTemplateScale(cv, basketRaster, basketTemplate, {
		templateScale: basketTemplateScale,
		mapBoundsPx,
		maxCandidates: args.maxBasketCandidates,
		minScore: args.minBasketScore
	});

	const teeRaster = { rgba: input.rgba, widthPx: input.widthPx, heightPx: input.heightPx, sourceScale: 1 };
	const teeBadges = numberDetection.candidates
		.filter((candidate): candidate is typeof candidate & { label: number } => candidate.label !== undefined)
		.map((candidate) => ({
			holeNumber: candidate.label,
			xPx: candidate.xPx,
			yPx: candidate.yPx,
			widthPx: candidate.widthPx,
			heightPx: candidate.heightPx
		}));
	const teeBootstrap = detectCalibratedTeeBootstrap(cv, teeRaster, {
		uiScalePx,
		mapBoundsPx,
		maxCandidates: args.maxTeeCandidates
	}, teeBadges, primaryBasketCandidates, args.experiments ?? {});
	const teeCandidates = teeBootstrap.candidates;
	const grammarTees = teeBootstrap.assignments.map((assignment) => ({
		...assignment.candidate,
		holeNumber: assignment.holeNumber,
		bootstrapDecision: assignment.decision,
		confidence: assignment.decision === 'auto'
			? Math.max(0.75, assignment.confidence)
			: Math.min(0.49, assignment.confidence),
		// assignments is compacted (one entry per resolved hole), not
		// positionally aligned with teeCandidates -- carry the real raw index
		// through so associateCourseGrammar's reported candidateIndex stays a
		// valid index into teeCandidates. Mirrors basketDetection.worker.ts.
		candidateIndex: assignment.candidateIndex
	}));

	const numberBadges = numberDetection.candidates.map((candidate) => ({
		xPx: candidate.xPx,
		yPx: candidate.yPx,
		score: candidate.score,
		holeNumber: candidate.label,
		widthPx: candidate.widthPx,
		heightPx: candidate.heightPx
	}));
	const primaryGrammar = associateCourseGrammar({ numberBadges, tees: grammarTees, baskets: primaryBasketCandidates });

	// Occlusion-tolerant basket recovery -- mirrors basketDetection.worker.ts's
	// production `detectCourse` exactly, so this CLI stays a faithful preview
	// of what the app actually does. See basketOcclusionRecovery.ts's module
	// doc comment for the two-question policy this implements.
	const basketRecoverySamples = basketRecoverySamplesFromGrammar(primaryGrammar.holes);
	const basketDistanceBand = deriveBasketDistanceBand(basketRecoverySamples);
	const unresolvedBasketHoleNumbers = basketDistanceBand
		? findUnresolvedBasketHoles(basketRecoverySamples, basketDistanceBand)
		: new Set<number>();
	let basketCandidates = primaryBasketCandidates;
	let grammar = primaryGrammar;
	let basketFallbackRecoveredCount = 0;
	if (basketDistanceBand && unresolvedBasketHoleNumbers.size > 0) {
		const unresolvedBadges = numberDetection.candidates
			.filter(
				(candidate): candidate is typeof candidate & { label: number } =>
					candidate.label !== undefined && unresolvedBasketHoleNumbers.has(candidate.label)
			)
			.map((candidate) => ({ holeNumber: candidate.label, xPx: candidate.xPx, yPx: candidate.yPx }));
		const occlusionBoxes = numberDetection.candidates.map((candidate) => ({
			xPx: candidate.xPx,
			yPx: candidate.yPx,
			widthPx: candidate.widthPx,
			heightPx: candidate.heightPx
		}));
		const basketFallbackRaster = { gray: toGray(input), widthPx: input.widthPx, heightPx: input.heightPx };
		const recovered = detectCalibratedBasketOcclusionFallback(
			basketFallbackRaster,
			basketTemplate,
			unresolvedBadges,
			occlusionBoxes,
			basketDistanceBand,
			basketTemplateScale
		);
		const nonDuplicateRecovered = recovered.filter(
			(candidate) => !primaryBasketCandidates.some((existing) => isSameBasketCandidate(existing, candidate))
		);
		basketFallbackRecoveredCount = nonDuplicateRecovered.length;
		if (nonDuplicateRecovered.length > 0) {
			basketCandidates = [...primaryBasketCandidates, ...nonDuplicateRecovered];
			const grammarBaskets = [
				...primaryBasketCandidates,
				...nonDuplicateRecovered.map((candidate) => ({ ...candidate, bootstrapDecision: 'review' as const }))
			];
			grammar = associateCourseGrammar({ numberBadges, tees: grammarTees, baskets: grammarBaskets });
		}
	}

	const outputDir = resolve(args.outputDir);
	mkdirSync(outputDir, { recursive: true });
	const overlayPath = join(outputDir, 'course.png');
	const jsonPath = join(outputDir, 'course.json');
	const activeReviewPath = join(outputDir, 'activeReview.json');

	const readyHoles = grammar.holes.filter((hole) => hole.status === 'ready').length;
	const reviewHoles = grammar.holes.filter((hole) => hole.status === 'review').length;
	const incompleteHoles = grammar.holes.filter((hole) => hole.status === 'incomplete').length;

	const detectionResult: CourseDetectionResult = { numberDetection, tees: teeCandidates, baskets: basketCandidates, grammar };
	// No live annotation session exists in this CLI preview -- treat the
	// detection's own proposals as "placed" so this stays a faithful preview
	// of a freshly-detected, unreviewed course (see livePlacementsFromGrammar's
	// doc comment).
	const reviewMap = buildActiveReviewMap(detectionResult, livePlacementsFromGrammar(detectionResult), []);
	const recommendation = recommendNextAnchor(reviewMap, { deadlineMs: 4000, minAutoSuggestScore: args.minAutoSuggestScore });
	const activeReview = summarizeActiveReview(detectionResult, reviewMap, recommendation);

	const output: CourseCliResult = {
		input: { path: input.sourcePath, sourceEntry: input.sourceEntry, widthPx: input.widthPx, heightPx: input.heightPx },
		uiScalePx,
		basketTemplateScale,
		mapBoundsPx,
		counts: {
			numberCandidates: numberDetection.candidates.length,
			labeledNumbers: numberDetection.candidates.filter((candidate) => candidate.label !== undefined).length,
			basketCandidates: basketCandidates.length,
			teeCandidates: teeCandidates.length,
			readyHoles,
			reviewHoles,
			incompleteHoles,
			basketFallbackUnresolvedHoles: unresolvedBasketHoleNumbers.size,
			basketFallbackRecovered: basketFallbackRecoveredCount
		},
		teeBootstrap: {
			...teeBootstrap.counts,
			holes: teeBootstrap.holes.map((hole) => ({
				holeNumber: hole.holeNumber,
				decision: hole.decision,
				...(hole.assignment ? {
					candidateIndex: hole.assignment.candidateIndex,
					confidence: hole.assignment.confidence
				} : {})
			}))
		},
		grammar,
		teeTruthEvaluation: input.truth ? evaluateTeeTruth(input.truth, grammar, 7 * uiScalePx) : undefined,
		basketTruthEvaluation: input.truth ? evaluateBasketTruth(input.truth, grammar, 7 * uiScalePx) : undefined,
		activeReview,
		overlayPath,
		activeReviewPath,
		elapsedMs: performance.now() - startedAt
	};

	writeFileSync(overlayPath, renderOverlay(input, grammar, teeCandidates, basketCandidates));
	writeFileSync(jsonPath, `${JSON.stringify(output, null, 2)}\n`);
	writeFileSync(activeReviewPath, `${JSON.stringify({ map: reviewMap, recommendation: recommendationSummary(recommendation) }, null, 2)}\n`);
	console.log(JSON.stringify({ ...output, jsonPath }, null, 2));
	return output;
}

async function main(): Promise<void> {
	await runCourseDetection(parseArgs(process.argv.slice(2)));
}

if (resolve(process.argv[1] ?? '') === resolve(scriptPath)) {
	main().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
