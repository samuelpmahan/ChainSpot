/**
 * Fit-and-project as a function, shared by scripts/geo/fit-and-project.ts (one basemap) and scripts/geo/slice.ts (the
 * whole slice). See fit-and-project.ts for the contract. Integrity failures (wrong image, wrong size) throw
 * `IntegrityError`; data conditions (too few pairs, no ground scale) are recorded in fit.json.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { SerializableTransform } from '../../src/lib/alignment/types';
import { fitAlignmentPairs, parseAlignmentPairs } from '../../src/lib/geo/alignmentPairs';
import type { AlignmentFitReport, GroundScale } from '../../src/lib/geo/alignmentPairs';
import { buildCourseOverviewMarkup } from '../../src/lib/graphics/courseOverview';
import { computeCenterlineLengthPx } from '../../src/lib/graphics/distances';
import { composeBroadcastFrame } from '../../src/lib/graphics/frame';
import { planHoleGraphic } from '../../src/lib/holeGraphics';
import type { HoleGraphicPlan } from '../../src/lib/holeGraphics';
import { needsReview, parseCourseGeometry, scaleFromC1Radius } from '../../src/lib/import/courseGeometry';
import type { CourseGeometryParseResult } from '../../src/lib/import/courseGeometry';

export const FEET_PER_METER = 1 / 0.3048;

export class IntegrityError extends Error {}

export const IDENTITY: SerializableTransform = {
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

/** Pixel size of a PNG or JPEG, read from its header (no decoder dependency). */
export function imageSize(bytes: Buffer): { widthPx: number; heightPx: number; mime: string } {
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
	throw new IntegrityError('image must be a PNG or a baseline/progressive JPEG');
}

export const sha256Of = (bytes: Buffer | Uint8Array) => createHash('sha256').update(bytes).digest('hex');

export function loadGeometry(path: string): Extract<CourseGeometryParseResult, { ok: true }> {
	const parsed = parseCourseGeometry(readFileSync(path, 'utf8'));
	if (!parsed.ok) throw new IntegrityError(`course geometry: ${parsed.error.code} at ${parsed.error.path}: ${parsed.error.message}`);
	return parsed;
}

/** The screenshot's own ground scale: the file's C1 scale, else a C1 radius given by the caller. */
export function screenshotGroundScale(
	geometry: Extract<CourseGeometryParseResult, { ok: true }>['geometry'],
	rc1Px?: number
): (GroundScale & { from: string; rC1Px: number }) | null {
	if (geometry.scale) {
		return {
			metersPerPixel: geometry.scale.metresPerPx,
			rC1Px: geometry.scale.rC1Px,
			referent: `C1 radius 10 m = ${geometry.scale.rC1Px} px on ${geometry.source.fileName}`,
			from: 'course-geometry scale'
		};
	}
	if (rc1Px !== undefined) {
		if (!(rc1Px > 0)) throw new IntegrityError('rC1 must be a positive number of px');
		return {
			metersPerPixel: scaleFromC1Radius(rc1Px).metresPerPx,
			rC1Px: rc1Px,
			referent: `C1 radius 10 m = ${rc1Px} px on ${geometry.source.fileName}`,
			from: 'given rC1 (the file predates its scale field)'
		};
	}
	return null;
}

export interface FitProjectOptions {
	readonly geometryPath: string;
	readonly basemapPath: string;
	readonly outDir: string;
	/** A chainspot.alignment-pairs file; absent: identity onto the geometry's own screenshot. */
	readonly pairsPath?: string;
	/** Hole numbers for broadcast frames, or 'all'. */
	readonly frames?: readonly number[] | 'all';
	readonly courseName?: string;
	readonly rc1Px?: number;
	readonly rc1Note?: string;
	/** Extra lines for fit.json (e.g. the slice's locate step). */
	readonly extra?: Record<string, unknown>;
}

export interface FitProjectResult {
	readonly outDir: string;
	readonly fit: AlignmentFitReport | { ok: true; model: 'identity'; reason: string };
	readonly transform: SerializableTransform;
	readonly plans: readonly HoleGraphicPlan[];
	readonly groundScale: GroundScale | null;
	readonly sourceGroundScale: (GroundScale & { from: string; rC1Px: number }) | null;
	readonly summary: readonly string[];
	readonly frameFiles: readonly string[];
	readonly holes: readonly Record<string, unknown>[];
}

export function fitAndProject(options: FitProjectOptions): FitProjectResult {
	const { geometryPath, basemapPath, outDir, pairsPath } = options;
	const parsed = loadGeometry(geometryPath);
	const { geometry } = parsed;
	const basemapBytes = readFileSync(basemapPath);
	const basemapSha = sha256Of(basemapBytes);
	const basemap = imageSize(basemapBytes);
	const basemapName = basename(basemapPath);
	const sourceGroundScale = screenshotGroundScale(geometry, options.rc1Px);

	let transform: SerializableTransform;
	let fit: FitProjectResult['fit'];
	let courseName = options.courseName ?? geometry.source.fileName;
	let groundScale: GroundScale | null = null;

	if (pairsPath) {
		const pairs = parseAlignmentPairs(readFileSync(pairsPath, 'utf8'));
		if (!pairs.ok) throw new IntegrityError(`pairs: ${pairs.error.path}: ${pairs.error.message}`);
		const file = pairs.file;
		if (file.basemap.sha256 && file.basemap.sha256 !== basemapSha) {
			throw new IntegrityError(`integrity: ${basemapPath} hashes to ${basemapSha}, the pairs file names ${file.basemap.sha256}`);
		}
		if (file.basemap.widthPx !== basemap.widthPx || file.basemap.heightPx !== basemap.heightPx) {
			throw new IntegrityError(
				`integrity: ${basemapPath} is ${basemap.widthPx} x ${basemap.heightPx} px, the pairs file says ${file.basemap.widthPx} x ${file.basemap.heightPx}`
			);
		}
		if (file.source.sha256 && file.source.sha256 !== geometry.source.sha256) {
			throw new IntegrityError(`integrity: the pairs were picked on ${file.source.sha256}, the geometry was read from ${geometry.source.sha256}`);
		}
		courseName = options.courseName ?? file.course;
		fit = fitAlignmentPairs(file, sourceGroundScale ? { sourceGroundScale } : {});
		groundScale = fit.groundScale;
		transform = fit.ok ? fit.transform : IDENTITY;
	} else {
		if (basemapSha !== geometry.source.sha256) {
			throw new IntegrityError(
				`integrity: without pairs the basemap must be the geometry's own screenshot (${geometry.source.sha256}); ${basemapPath} hashes to ${basemapSha}`
			);
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
		const inside = [plan.tee, plan.basket].every(
			(p) => p && p.xPx >= 0 && p.yPx >= 0 && p.xPx <= basemap.widthPx && p.yPx <= basemap.heightPx
		);
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
				sourceGroundScale: sourceGroundScale ? { ...sourceGroundScale, ...(options.rc1Note ? { note: options.rc1Note } : {}) } : null,
				units: {
					residual: 'px of the basemap; m on the ground only when groundScale is known',
					centerlineLengthPx: 'px of the basemap along tee, bends, basket',
					centerlineLengthFt: 'feet on the ground, only when groundScale is known',
					toolkitLengthFt: "the toolkit's own route length (evidence trace.lengthFt), when the file carries it"
				},
				fit,
				holes,
				...(options.extra ?? {})
			},
			null,
			1
		) + '\n'
	);

	writeFileSync(
		join(outDir, 'overview.svg'),
		buildCourseOverviewMarkup(plans, href, basemap.widthPx, basemap.heightPx, {
			needsReview: review,
			title: `${courseName}: ${plans.length} holes on ${basemapName}`,
			summary,
			pairs: fit.ok && 'residuals' in fit ? fit.residuals.map((r) => ({ id: r.pairId, label: r.pairId, target: r.target, expected: r.expected })) : []
		})
	);

	const frameFiles: string[] = [];
	if (options.frames) {
		const wanted = options.frames === 'all' ? plans : plans.filter((plan) => (options.frames as readonly number[]).includes(plan.number));
		for (const plan of wanted) {
			const frame = composeBroadcastFrame(plan, href, { targetName: basemapName, feetPerPixel, groundScaleReferent: groundScale?.referent, courseName });
			const file = join(outDir, `frame-hole-${String(plan.number).padStart(2, '0')}.svg`);
			writeFileSync(file, frame.svg);
			frameFiles.push(file);
		}
	}
	return { outDir, fit, transform, plans, groundScale, sourceGroundScale, summary, frameFiles, holes };
}
