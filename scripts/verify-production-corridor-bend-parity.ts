import { extname, join, resolve, dirname } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import { detectAndApplyCorridorBendsCapsule, DEFAULT_DETECT_CORRIDOR_BENDS_CAPSULE_PARAMS } from '../src/lib/autoAnnotation/corridorBendDetectionCapsule';
import type { CorridorBendRaster } from '../src/lib/autoAnnotation/corridorBendDetection';
import { DEFAULT_CORRIDOR_WIDTH_PX } from '../src/lib/corridor';
import { IMG_5641_GROUND_TRUTH } from '../src/lib/autoAnnotation/courseGroundTruth';
import type { AnnotatedHole, SourcePoint } from '../src/lib/domain/annotatedRound';
import { aggregate, scoreHole } from './benchmark-corridor-bend-detection';
import type { AggregateStats, HoleScore } from './benchmark-corridor-bend-detection';
import { buildAlexClarkGroundTruth, buildDashGroundTruth, loadAlexClarkFixture } from './corridorBendGroundTruth';
import type { HoleBendTruth } from './corridorBendGroundTruth';

/**
 * Production-parity check: runs the ACTUAL production entry point
 * (`detectAndApplyCorridorBendsCapsule`, the exact function
 * `approveHolePieces` calls in the Annotate Round page — not a reimplemented
 * "production-equivalent" of arm C) against the same Dash/AlexClark
 * ground-truth fixtures `scripts/benchmark-corridor-bend-detection.ts` uses,
 * scored with the SAME imported `scoreHole`/`aggregate` functions that
 * script uses (not a re-derived copy), so this check and that benchmark
 * cannot silently diverge on what "correct" means.
 *
 * Each hole is run through `detectAndApplyCorridorBendsCapsule` exactly as
 * `approveHolePieces` would: a single-hole `AnnotatedHole[]` with an empty
 * `corridorBends`, tee/basket from ground truth, a Node-side crop
 * reproducing `cropSourceRasterAroundHole`'s own geometry (canvas is
 * unavailable in Node — this is the "closest deterministic adapter
 * possible", same convention `benchmark-corridor-bend-detection.ts` and
 * `scripts/cv-probes/_capsule_ts_validation.ts` already use), and the same
 * badge ground truth the benchmark passes to arm C.
 *
 * Exits non-zero if either course falls below the accepted floor (see
 * `FLOOR` below), so this can also run as a regression gate.
 */

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = resolve(dirname(scriptPath), '..');

const DASH_IMAGE_PATH = join(projectRoot, 'resources/ribbon-reference/IMG_5641.jpg');
const ALEX_IMAGE_PATH = join(projectRoot, 'resources/stitch-annotate/AlexClark/AlexClark-McKinney-TX.jpg');

// ---------------------------------------------------------------------------
// Node-side raster decode + crop -- reproduces cropSourceRasterAroundHole's
// geometry exactly (see that function's own DEFAULT_CROP_OPTIONS), same
// pattern scripts/benchmark-corridor-bend-detection.ts and
// scripts/cv-probes/_capsule_ts_validation.ts already use. Read-only
// reproduction; canvas itself doesn't exist in Node.
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

const CROP_MARGIN_FRACTION = 0.4;
const CROP_MIN_MARGIN_PX = 40;
const CROP_MAX_MARGIN_PX = 260;
const CROP_MAX_DIM = 480;

function cropAndDownscale(image: DecodedRaster, tee: SourcePoint, basket: SourcePoint): CorridorBendRaster | null {
	const distance = Math.hypot(basket.xPx - tee.xPx, basket.yPx - tee.yPx);
	const margin = Math.min(CROP_MAX_MARGIN_PX, Math.max(CROP_MIN_MARGIN_PX, distance * CROP_MARGIN_FRACTION));
	const x0 = Math.max(0, Math.floor(Math.min(tee.xPx, basket.xPx) - margin));
	const y0 = Math.max(0, Math.floor(Math.min(tee.yPx, basket.yPx) - margin));
	const x1 = Math.min(image.widthPx, Math.ceil(Math.max(tee.xPx, basket.xPx) + margin));
	const y1 = Math.min(image.heightPx, Math.ceil(Math.max(tee.yPx, basket.yPx) + margin));
	const cropWidth = x1 - x0;
	const cropHeight = y1 - y0;
	if (cropWidth < 2 || cropHeight < 2) return null;

	const scale = Math.max(1, Math.max(cropWidth, cropHeight) / CROP_MAX_DIM);
	const outWidth = Math.max(1, Math.round(cropWidth / scale));
	const outHeight = Math.max(1, Math.round(cropHeight / scale));
	const data = new Uint8Array(outWidth * outHeight * 4);

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
				const rowBase = (y0 + sy) * image.widthPx;
				for (let sx = sx0; sx < sx1; sx += 1) {
					const p = (rowBase + x0 + sx) * 4;
					r += image.rgba[p];
					g += image.rgba[p + 1];
					b += image.rgba[p + 2];
					a += image.rgba[p + 3];
					count += 1;
				}
			}
			const op = (oy * outWidth + ox) * 4;
			data[op] = r / count;
			data[op + 1] = g / count;
			data[op + 2] = b / count;
			data[op + 3] = a / count;
		}
	}
	return { widthPx: outWidth, heightPx: outHeight, originXPx: x0, originYPx: y0, scale: cropWidth / outWidth, data, channels: 4 };
}

// ---------------------------------------------------------------------------
// Per-course run through the REAL production entry point.
// ---------------------------------------------------------------------------

interface HoleInput {
	readonly holeNumber: number;
	readonly tee: SourcePoint;
	readonly basket: SourcePoint;
	readonly badge?: SourcePoint;
}

function runCourse(courseName: string, image: DecodedRaster, holeInputs: readonly HoleInput[], truth: readonly HoleBendTruth[]): HoleScore[] {
	const truthByHole = new Map(truth.map((entry) => [entry.holeNumber, entry]));
	return holeInputs.map((input) => {
		const holeTruth = truthByHole.get(input.holeNumber);
		if (!holeTruth) throw new Error(`No ground truth for ${courseName} hole ${input.holeNumber}`);

		// Exactly what approveHolePieces builds: a single hole, no tee/basket
		// missing, no pre-existing manual bends.
		const holes: AnnotatedHole[] = [
			{
				id: `hole-${input.holeNumber}`,
				number: input.holeNumber,
				shots: [],
				corridorBends: [],
				corridorWidthPx: DEFAULT_CORRIDOR_WIDTH_PX,
				tee: input.tee,
				basket: input.basket
			}
		];
		const raster = cropAndDownscale(image, input.tee, input.basket);
		const result = detectAndApplyCorridorBendsCapsule(
			holes,
			holes[0].id,
			raster,
			input.badge,
			DEFAULT_DETECT_CORRIDOR_BENDS_CAPSULE_PARAMS
		);
		const predicted = result[0].corridorBends;
		return scoreHole(holeTruth, predicted);
	});
}

function printReport(courseName: string, scores: readonly HoleScore[]): AggregateStats {
	const a = aggregate(scores);
	console.log(`\n=== ${courseName} (production entry point) ===`);
	console.log(
		`exact count ${(a.exactCountAccuracy * 100).toFixed(0)}% (${a.exactCountMatches}/${a.holesEvaluated}) | ` +
			`false bends ${a.falseBendsOnStraightHoles}/${a.straightHoleCount} | good ${a.goodCount} | loc-wrong ${a.locationWrongCount} | ` +
			`median loc err ${a.medianLocationErrorPx === null ? 'n/a' : `${a.medianLocationErrorPx.toFixed(1)}px`}`
	);
	for (const score of scores) {
		console.log(`  hole ${String(score.holeNumber).padStart(2)}: truth=${score.truthCount} pred=${score.predictedCount} ${score.status}`);
	}
	return a;
}

// Accepted floor per this branch's own experimental result (see
// corridorBendDetectionCapsule.ts's PRODUCTION STATUS note): Dash ~17/18
// exact with zero straight false bends, Alex 3/3. A materially worse result
// here means the production wrapper has drifted from arm C -- diagnose and
// fix parity, do not retune the model (see this script's own doc comment).
const FLOOR = {
	dashMinExactCountMatches: 16,
	dashMaxFalseBends: 0,
	alexMinExactCountMatches: 3
};

async function main(): Promise<void> {
	console.log('Loading fixtures...');
	const dashImage = loadImage(DASH_IMAGE_PATH);
	const alexImage = loadImage(ALEX_IMAGE_PATH);
	const dashTruth = buildDashGroundTruth();
	const alexTruth = buildAlexClarkGroundTruth();
	const alexFixture = loadAlexClarkFixture();

	const dashBadgeByHole = new Map(IMG_5641_GROUND_TRUTH.badges.map((badge) => [badge.number, { xPx: badge.xPx, yPx: badge.yPx }]));
	const dashHoles: HoleInput[] = IMG_5641_GROUND_TRUTH.holes.map((hole) => ({
		holeNumber: hole.number,
		tee: hole.tee,
		basket: hole.basket,
		badge: dashBadgeByHole.get(hole.number)
	}));
	// AlexClark ships no numbered-badge ground truth -- production runs these
	// holes unanchored, exactly like the benchmark's own arm-C column.
	const alexHoles: HoleInput[] = alexFixture.holes.map((hole) => ({ holeNumber: Number(hole.number), tee: hole.tee, basket: hole.basket }));

	const dashScores = runCourse('Dash (IMG_5641)', dashImage, dashHoles, dashTruth);
	const alexScores = runCourse('AlexClark-McKinney-TX', alexImage, alexHoles, alexTruth);

	const dashAgg = printReport('Dash (IMG_5641)', dashScores);
	const alexAgg = printReport('AlexClark-McKinney-TX', alexScores);

	const failures: string[] = [];
	if (dashAgg.exactCountMatches < FLOOR.dashMinExactCountMatches) {
		failures.push(`Dash exact-count matches ${dashAgg.exactCountMatches} < floor ${FLOOR.dashMinExactCountMatches}`);
	}
	if (dashAgg.falseBendsOnStraightHoles > FLOOR.dashMaxFalseBends) {
		failures.push(`Dash false bends ${dashAgg.falseBendsOnStraightHoles} > floor ${FLOOR.dashMaxFalseBends}`);
	}
	if (alexAgg.exactCountMatches < FLOOR.alexMinExactCountMatches) {
		failures.push(`AlexClark exact-count matches ${alexAgg.exactCountMatches} < floor ${FLOOR.alexMinExactCountMatches}`);
	}

	if (failures.length > 0) {
		console.error('\nPRODUCTION PARITY FAILED:');
		for (const failure of failures) console.error(`  - ${failure}`);
		process.exitCode = 1;
		return;
	}
	console.log('\nProduction entry point matches the accepted arm-C floor. No parity regression.');
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
	process.exitCode = 1;
});
