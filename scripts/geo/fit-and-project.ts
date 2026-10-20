/**
 * Headless fit-and-project: point pairs + a basemap + a course-geometry file -> every hole on the basemap.
 *
 *   npx tsx scripts/geo/fit-and-project.ts --geometry <course-geometry.json> --basemap <image> --out <dir>
 *       [--pairs <alignment-pairs.json>] [--frame <hole number>|all] [--course <name>] [--rc1-px <px> --rc1-note <text>]
 *
 * With --pairs (format `chainspot.alignment-pairs`, see src/lib/geo/alignmentPairs.ts) the screenshot-to-basemap
 * transform is fitted by the app's own estimators and every pair's residual is reported in px of the basemap and,
 * when the pairs file gives the basemap a ground scale (a radius-based NAIP export), in metres.
 * Ground scale, first that exists: the basemap's own (a radius-based NAIP export in the pairs file); else the
 * course-geometry file's `scale` (the C1 putting circle is 10 m in radius: 10 m = rC1 px of the screenshot), carried
 * through the fit; else --rc1-px for a file that predates `scale` (its note says where the radius was measured). With
 * none, lengths stay in px, labelled as px of the basemap.
 * Without --pairs the basemap must BE the screenshot the geometry was read from (its sha256 is checked against
 * `source.sha256`), and the transform is the identity: the "until NAIP" mode.
 *
 * Writes to <out>: fit.json (transform, residuals with units and referents, warnings, per-hole lengths),
 * overview.svg (every hole labelled, pairs and residual vectors, legend), and frame-hole-NN.svg (16:9 1920 x 1080
 * broadcast frames, src/lib/graphics/frame.ts) for --frame. The SVGs embed the basemap as a data URI, so they are
 * self-contained; any SVG rasterizer turns them into PNGs. Data conditions (too few pairs, no ground scale) are
 * recorded in fit.json, not thrown; a hash mismatch (wrong image) stops the run.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { SerializableTransform } from '../../src/lib/alignment/types';
import { fitAlignmentPairs, parseAlignmentPairs } from '../../src/lib/geo/alignmentPairs';
import type { AlignmentFitReport } from '../../src/lib/geo/alignmentPairs';
import { buildCourseOverviewMarkup } from '../../src/lib/graphics/courseOverview';
import { computeCenterlineLengthPx } from '../../src/lib/graphics/distances';
import { composeBroadcastFrame } from '../../src/lib/graphics/frame';
import { planHoleGraphic } from '../../src/lib/holeGraphics';
import type { HoleGraphicPlan } from '../../src/lib/holeGraphics';
import { needsReview, parseCourseGeometry, scaleFromC1Radius } from '../../src/lib/import/courseGeometry';
import type { GroundScale } from '../../src/lib/geo/alignmentPairs';

const FEET_PER_METER = 3.280839895;

function arg(name: string): string | null {
	const index = process.argv.indexOf(name);
	return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}

function die(message: string): never {
	console.error(message);
	process.exit(1);
}

/** Pixel size of a PNG or JPEG, read from its header (no decoder dependency). */
function imageSize(bytes: Buffer): { widthPx: number; heightPx: number; mime: string } {
	if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
		return { widthPx: bytes.readUInt32BE(16), heightPx: bytes.readUInt32BE(20), mime: 'image/png' };
	}
	if (bytes[0] === 0xff && bytes[1] === 0xd8) {
		let offset = 2;
		while (offset < bytes.length) {
			if (bytes[offset] !== 0xff) break;
			const marker = bytes[offset + 1];
			const length = bytes.readUInt16BE(offset + 2);
			if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
				return { heightPx: bytes.readUInt16BE(offset + 5), widthPx: bytes.readUInt16BE(offset + 7), mime: 'image/jpeg' };
			}
			offset += 2 + length;
		}
	}
	return die('basemap must be a PNG or a baseline/progressive JPEG');
}

const IDENTITY: SerializableTransform = {
	model: 'similarity',
	coefficients: [1, 0, 0, 1, 0, 0],
	isInvertible: true,
	determinant: 1,
	orientation: 1,
	majorAxisScale: 1,
	minorAxisScale: 1,
	anisotropy: 1,
	shear: 0
};

const geometryPath = arg('--geometry');
const basemapPath = arg('--basemap');
const outDir = arg('--out');
const pairsPath = arg('--pairs');
const frameArg = arg('--frame');
if (!geometryPath || !basemapPath || !outDir) {
	die('usage: tsx scripts/geo/fit-and-project.ts --geometry <course-geometry.json> --basemap <image> --out <dir> [--pairs <pairs.json>] [--frame <n>|all] [--course <name>]');
}

const parsed = parseCourseGeometry(readFileSync(geometryPath, 'utf8'));
if (!parsed.ok) die(`course geometry: ${parsed.error.code} at ${parsed.error.path}: ${parsed.error.message}`);
const { geometry } = parsed;
const basemapBytes = readFileSync(basemapPath);
const basemapSha = createHash('sha256').update(basemapBytes).digest('hex');
const basemap = imageSize(basemapBytes);
const basemapName = basename(basemapPath);

// The screenshot's own ground scale: the file's C1 scale, else a C1 radius given on the command line.
const rc1Arg = arg('--rc1-px');
let sourceGroundScale: GroundScale | null = null;
if (geometry.scale) {
	sourceGroundScale = {
		metersPerPixel: geometry.scale.metresPerPx,
		referent: `C1 radius 10 m = ${geometry.scale.rC1Px} px on ${geometry.source.fileName}`
	};
	if (rc1Arg) console.error(`--rc1-px ignored: the course-geometry file carries its own scale (rC1 ${geometry.scale.rC1Px} px)`);
} else if (rc1Arg) {
	const rC1Px = Number(rc1Arg);
	if (!(rC1Px > 0)) die('--rc1-px must be a positive number');
	sourceGroundScale = {
		metersPerPixel: scaleFromC1Radius(rC1Px).metresPerPx,
		referent: `C1 radius 10 m = ${rC1Px} px on ${geometry.source.fileName}`
	};
	if (arg('--rc1-note')) console.error(`rC1 ${rC1Px} px: ${arg('--rc1-note')}`);
}

let transform: SerializableTransform;
let fit: AlignmentFitReport | { ok: true; model: 'identity'; reason: string };
let courseName = arg('--course') ?? geometry.source.fileName;
let groundScale: GroundScale | null = null;

if (pairsPath) {
	const pairs = parseAlignmentPairs(readFileSync(pairsPath, 'utf8'));
	if (!pairs.ok) die(`pairs: ${pairs.error.path}: ${pairs.error.message}`);
	const file = pairs.file;
	if (file.basemap.sha256 && file.basemap.sha256 !== basemapSha) {
		die(`integrity: ${basemapPath} hashes to ${basemapSha}, the pairs file names ${file.basemap.sha256}`);
	}
	if (file.basemap.widthPx !== basemap.widthPx || file.basemap.heightPx !== basemap.heightPx) {
		die(`integrity: ${basemapPath} is ${basemap.widthPx} x ${basemap.heightPx} px, the pairs file says ${file.basemap.widthPx} x ${file.basemap.heightPx}`);
	}
	if (file.source.sha256 && file.source.sha256 !== geometry.source.sha256) {
		die(`integrity: the pairs were picked on ${file.source.sha256}, the geometry was read from ${geometry.source.sha256}`);
	}
	courseName = arg('--course') ?? file.course;
	fit = fitAlignmentPairs(file, sourceGroundScale ? { sourceGroundScale } : {});
	groundScale = fit.groundScale;
	transform = fit.ok ? fit.transform : IDENTITY;
} else {
	if (basemapSha !== geometry.source.sha256) {
		die(`integrity: without --pairs the basemap must be the geometry's own screenshot (${geometry.source.sha256}); ${basemapPath} hashes to ${basemapSha}`);
	}
	transform = IDENTITY;
	fit = { ok: true, model: 'identity', reason: 'no pairs: the basemap is the screenshot the geometry was read from' };
	groundScale = sourceGroundScale;
}

mkdirSync(outDir, { recursive: true });
const href = `data:${basemap.mime};base64,${basemapBytes.toString('base64')}`;
const projected = pairsPath && !fit.ok ? [] : parsed.state.holes;
const plans: HoleGraphicPlan[] = projected
	.map((hole) => planHoleGraphic(hole, transform, basemap.widthPx, basemap.heightPx))
	.filter((plan): plan is HoleGraphicPlan => plan !== null);
const review = new Set(parsed.needsReview.map((evidence) => evidence.holeId));
const feetPerPixel = groundScale ? groundScale.metersPerPixel * FEET_PER_METER : undefined;

const holes = plans.map((plan) => {
	const lengthPx = computeCenterlineLengthPx(plan);
	const inside = [plan.tee, plan.basket].every((p) => p && p.xPx >= 0 && p.yPx >= 0 && p.xPx <= basemap.widthPx && p.yPx <= basemap.heightPx);
	const evidence = geometry.evidence.find((e) => e.holeId === plan.holeId);
	return {
		number: plan.number,
		holeId: plan.holeId,
		status: evidence?.status ?? null,
		needsReview: evidence ? needsReview(evidence) : null,
		teeAndBasketOnBasemap: inside,
		centerlineLengthPx: lengthPx === null ? null : Math.round(lengthPx * 10) / 10,
		centerlineLengthFt: lengthPx === null || feetPerPixel === undefined ? null : Math.round(lengthPx * feetPerPixel),
		toolkitLengthFt: evidence?.trace?.lengthFt ?? null
	};
});

const fmt = (value: number, digits = 2) => value.toFixed(digits);
const summary: string[] = [];
if (fit.ok && fit.model !== 'identity' && 'residualsPx' in fit) {
	summary.push(`${fit.model} fit on ${fit.residualsPx.count} pairs (unused: ${fit.unusedPairIds.length})`);
	summary.push(`residual RMS ${fmt(fit.residualsPx.rms)} px, max ${fmt(fit.residualsPx.max)} px (${fit.residualsPx.maxPairId}), px of ${basemapName}`);
	summary.push(
		fit.residualsM
			? `residual RMS ${fmt(fit.residualsM.rms)} m, max ${fmt(fit.residualsM.max)} m (${groundScale!.referent})`
			: 'residuals in m: not available (the basemap has no ground scale)'
	);
	summary.push(`scale ${fmt(fit.transform.majorAxisScale, 4)} basemap px per screenshot px`);
} else if (!fit.ok) {
	summary.push(`no fit: ${fit.reason} (${'availablePairs' in fit ? fit.availablePairs : '?'} complete pairs, ${'requiredPairs' in fit ? fit.requiredPairs : '?'} needed)`);
} else {
	summary.push('identity: the basemap is the screenshot itself (no NAIP yet)');
	summary.push(groundScale ? `ground scale: ${groundScale.referent}` : `lengths in px of ${basemapName}; feet need a ground scale`);
}

writeFileSync(
	join(outDir, 'fit.json'),
	JSON.stringify(
		{
			course: courseName,
			geometry: { file: basename(geometryPath), source: geometry.source.fileName, sha256: geometry.source.sha256, producer: geometry.producer },
			basemap: { file: basemapName, sha256: basemapSha, widthPx: basemap.widthPx, heightPx: basemap.heightPx },
			groundScale,
			sourceGroundScale: sourceGroundScale
				? { ...sourceGroundScale, from: geometry.scale ? 'course-geometry scale' : `--rc1-px${arg('--rc1-note') ? `: ${arg('--rc1-note')}` : ''}` }
				: null,
			units: {
				residual: 'px of the basemap; m on the ground only when groundScale is known',
				centerlineLengthPx: 'px of the basemap along tee, bends, basket',
				centerlineLengthFt: 'feet on the ground, only when groundScale is known',
				toolkitLengthFt: "the toolkit's own route length (evidence trace.lengthFt), when the file carries it"
			},
			fit,
			holes
		},
		null,
		1
	) + '\n'
);

const overview = buildCourseOverviewMarkup(plans, href, basemap.widthPx, basemap.heightPx, {
	needsReview: review,
	title: `${courseName}: ${plans.length} holes on ${basemapName}`,
	summary,
	pairs: fit.ok && 'residuals' in fit ? fit.residuals.map((r) => ({ id: r.pairId, label: r.label, target: r.target, expected: r.expected })) : []
});
writeFileSync(join(outDir, 'overview.svg'), overview);

const frames: string[] = [];
if (frameArg) {
	const wanted = frameArg === 'all' ? plans : plans.filter((plan) => String(plan.number) === frameArg);
	if (wanted.length === 0) console.error(`--frame ${frameArg}: no such projected hole`);
	for (const plan of wanted) {
		const frame = composeBroadcastFrame(plan, href, {
			targetName: basemapName,
			feetPerPixel,
			groundScaleReferent: groundScale?.referent,
			courseName
		});
		const file = join(outDir, `frame-hole-${String(plan.number).padStart(2, '0')}.svg`);
		writeFileSync(file, frame.svg);
		frames.push(file);
	}
}

console.log(JSON.stringify({ out: outDir, holes: plans.length, frames: frames.length, summary }, null, 1));
