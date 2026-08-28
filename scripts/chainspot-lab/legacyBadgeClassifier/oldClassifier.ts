/**
 * Standalone offline port of the PRE-REBUILD pure-TS badge glyph classifier
 * (old-stuff/src/lib/autoAnnotation/badgeGlyphClassifier.ts,
 * classifyKnownBadgeBodiesPureTs + normalizeBadgeGlyphMask + shiftedDice).
 *
 * This is a resurrection for a one-shot A/B harness, NOT a wiring into the
 * current engine. It is deliberately NOT imported by packages/alg.
 *
 * Adaptation notes (every shim is a change from the original, nothing else
 * was altered — logic, thresholds, and constants are copied verbatim):
 *
 *  1. Original loaded PNG templates via `fetch()` + `createImageBitmap()` +
 *     `<canvas>` (browser-only). This port loads them with `pngjs` from the
 *     local filesystem instead (`loadTemplatesFromDisk`) — same output shape
 *     (`HoleNumberTemplate[]` with an `{format:'rgba', widthPx, heightPx,
 *     data}` raster), same manifest.json contract (schemaVersion 1,
 *     `templates.holeNumbers`, `hole-NN.png` naming), same
 *     `resourceRoot`-relative layout old-stuff/tests/unit/
 *     badgeGlyphClassifier.test.ts exercises.
 *  2. Original used `performance.now()` (browser) with a `Date.now()`
 *     fallback for timing; Node's `perf_hooks.performance` is used here,
 *     matching the fallback branch the original already had for a
 *     non-browser host.
 *  3. `classifyKnownBadgeBodiesWithOpenCv` (the roi-opencv escalation path)
 *     was NOT ported: it requires the browser OpenCV.js runtime
 *     (`loadCv()` from old-stuff/src/lib/stitch/cvMatch.ts) which this
 *     harness has no host for. Only the pure-TS path — the classifier's
 *     FIRST and, per its own unit test, 100%-correct-on-canonical-templates
 *     tier — is exercised. `badgeGlyphBatchIsComplete` incompleteness (a
 *     pure-TS abstention, or a non-bijective label set) is reported as a
 *     'roi-opencv-would-have-run' flag rather than silently resolved, so no
 *     comparison is misattributed to a code path we didn't run.
 *  4. Everything else below (mask normalization, Dice scoring, thresholds:
 *     minScore 0.58, minMargin 0.045, foregroundThreshold 150, 24x18
 *     normalized canvas, maxShiftPx 1) is copied verbatim from
 *     old-stuff/src/lib/autoAnnotation/badgeGlyphClassifier.ts.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { PNG } from 'pngjs';

export interface BadgeGlyphRaster {
	readonly data: Uint8Array | Uint8ClampedArray;
	readonly widthPx: number;
	readonly heightPx: number;
}

export interface HoleNumberTemplate {
	readonly label: number;
	readonly raster: {
		readonly format: 'rgba' | 'gray';
		readonly widthPx: number;
		readonly heightPx: number;
		readonly data: Uint8Array | Uint8ClampedArray;
	};
}

export interface KnownBadgeBody {
	readonly xPx: number;
	readonly yPx: number;
	readonly widthPx: number;
	readonly heightPx: number;
	readonly fill?: number;
}

export type BadgeGlyphMethod = 'pure-ts';
export type BadgeGlyphAbstention = 'empty-glyph' | 'low-score' | 'ambiguous';

export interface BadgeGlyphClassification {
	readonly badgeIndex: number;
	readonly method: BadgeGlyphMethod;
	readonly label?: number;
	readonly bestLabel?: number;
	readonly bestScore: number;
	readonly runnerUpScore: number;
	readonly ambiguityMargin: number;
	readonly abstention: BadgeGlyphAbstention | null;
	readonly elapsedMs: number;
}

export interface BadgeGlyphClassifierOptions {
	readonly minScore?: number;
	readonly minMargin?: number;
	readonly foregroundThreshold?: number;
	readonly normalizedWidthPx?: number;
	readonly normalizedHeightPx?: number;
	readonly maxShiftPx?: number;
}

// Verbatim from old-stuff/src/lib/autoAnnotation/badgeGlyphClassifier.ts DEFAULTS.
const DEFAULTS: Required<BadgeGlyphClassifierOptions> = Object.freeze({
	minScore: 0.58,
	minMargin: 0.045,
	foregroundThreshold: 150,
	normalizedWidthPx: 24,
	normalizedHeightPx: 18,
	maxShiftPx: 1
});

function nowMs(): number {
	return performance.now();
}

// --- Shim 1: filesystem template loading (original used fetch + canvas). ---
export function loadTemplatesFromDisk(templatesDir: string): {
	templates: HoleNumberTemplate[];
	vocabularyLabels: number[];
} {
	const manifest = JSON.parse(readFileSync(join(templatesDir, 'manifest.json'), 'utf8')) as {
		schemaVersion: number;
		templates: { holeNumbers: string[] };
	};
	if (manifest.schemaVersion !== 1) throw new Error('CV template manifest schemaVersion must be 1.');
	const templates = manifest.templates.holeNumbers.map((fileName, index) => {
		const label = index + 1;
		const expected = `hole-${String(label).padStart(2, '0')}.png`;
		if (fileName !== expected) {
			throw new Error(`Hole-number template ${label} must be ${expected}; received ${fileName}.`);
		}
		const png = PNG.sync.read(readFileSync(join(templatesDir, fileName)));
		return {
			label,
			raster: {
				format: 'rgba' as const,
				widthPx: png.width,
				heightPx: png.height,
				data: new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.byteLength)
			}
		};
	});
	return { templates, vocabularyLabels: templates.map((t) => t.label) };
}

// --- Everything below is a verbatim (imports-only-adapted) copy of
// old-stuff/src/lib/autoAnnotation/badgeGlyphClassifier.ts. ---

function rgbaAt(raster: BadgeGlyphRaster, x: number, y: number): readonly [number, number, number] {
	const clampedX = Math.max(0, Math.min(raster.widthPx - 1, x));
	const clampedY = Math.max(0, Math.min(raster.heightPx - 1, y));
	const offset = (clampedY * raster.widthPx + clampedX) * 4;
	return [raster.data[offset], raster.data[offset + 1], raster.data[offset + 2]];
}

function brightNeutral(r: number, g: number, b: number, threshold: number): boolean {
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	return max >= threshold && max - min <= 90;
}

interface BinaryMask {
	readonly widthPx: number;
	readonly heightPx: number;
	readonly data: Uint8Array;
	readonly foreground: number;
}

function rawBadgeGlyphMask(
	raster: BadgeGlyphRaster,
	badge: Readonly<{ xPx: number; yPx: number; widthPx: number; heightPx: number }>,
	threshold: number,
	sampleWidthPx: number,
	sampleHeightPx: number
): BinaryMask {
	const data = new Uint8Array(sampleWidthPx * sampleHeightPx);
	const left = badge.xPx - badge.widthPx / 2;
	const top = badge.yPx - badge.heightPx / 2;
	const marginX = 0.14;
	const marginY = 0.16;
	let foreground = 0;
	for (let y = 0; y < sampleHeightPx; y += 1) {
		const v = (y + 0.5) / sampleHeightPx;
		if (v < marginY || v > 1 - marginY) continue;
		for (let x = 0; x < sampleWidthPx; x += 1) {
			const u = (x + 0.5) / sampleWidthPx;
			if (u < marginX || u > 1 - marginX) continue;
			const sourceX = Math.round(left + u * badge.widthPx - 0.5);
			const sourceY = Math.round(top + v * badge.heightPx - 0.5);
			const [r, g, b] = rgbaAt(raster, sourceX, sourceY);
			if (!brightNeutral(r, g, b, threshold)) continue;
			data[y * sampleWidthPx + x] = 1;
			foreground += 1;
		}
	}
	return { widthPx: sampleWidthPx, heightPx: sampleHeightPx, data, foreground };
}

function tightBounds(mask: BinaryMask): { minX: number; minY: number; maxX: number; maxY: number } | null {
	let minX = mask.widthPx;
	let minY = mask.heightPx;
	let maxX = -1;
	let maxY = -1;
	for (let y = 0; y < mask.heightPx; y += 1) {
		for (let x = 0; x < mask.widthPx; x += 1) {
			if (!mask.data[y * mask.widthPx + x]) continue;
			minX = Math.min(minX, x);
			maxX = Math.max(maxX, x);
			minY = Math.min(minY, y);
			maxY = Math.max(maxY, y);
		}
	}
	return maxX < 0 ? null : { minX, minY, maxX, maxY };
}

export function normalizeBadgeGlyphMask(
	raster: BadgeGlyphRaster,
	badge: Readonly<{ xPx: number; yPx: number; widthPx: number; heightPx: number }>,
	options: BadgeGlyphClassifierOptions = {}
): BinaryMask | null {
	const p = { ...DEFAULTS, ...options };
	const sampled = rawBadgeGlyphMask(raster, badge, p.foregroundThreshold, 48, 36);
	const bounds = tightBounds(sampled);
	if (!bounds) return null;
	const sourceWidth = bounds.maxX - bounds.minX + 1;
	const sourceHeight = bounds.maxY - bounds.minY + 1;
	const innerWidth = Math.max(1, p.normalizedWidthPx - 2);
	const innerHeight = Math.max(1, p.normalizedHeightPx - 2);
	const scale = Math.min(innerWidth / sourceWidth, innerHeight / sourceHeight);
	const drawWidth = Math.max(1, Math.round(sourceWidth * scale));
	const drawHeight = Math.max(1, Math.round(sourceHeight * scale));
	const offsetX = Math.floor((p.normalizedWidthPx - drawWidth) / 2);
	const offsetY = Math.floor((p.normalizedHeightPx - drawHeight) / 2);
	const data = new Uint8Array(p.normalizedWidthPx * p.normalizedHeightPx);
	let foreground = 0;
	for (let y = 0; y < drawHeight; y += 1) {
		const sourceY = Math.min(bounds.maxY, bounds.minY + Math.floor(((y + 0.5) * sourceHeight) / drawHeight));
		for (let x = 0; x < drawWidth; x += 1) {
			const sourceX = Math.min(bounds.maxX, bounds.minX + Math.floor(((x + 0.5) * sourceWidth) / drawWidth));
			if (!sampled.data[sourceY * sampled.widthPx + sourceX]) continue;
			const index = (offsetY + y) * p.normalizedWidthPx + offsetX + x;
			data[index] = 1;
			foreground += 1;
		}
	}
	return { widthPx: p.normalizedWidthPx, heightPx: p.normalizedHeightPx, data, foreground };
}

function templateRaster(template: HoleNumberTemplate): BadgeGlyphRaster {
	if (template.raster.format === 'rgba') {
		return { data: template.raster.data, widthPx: template.raster.widthPx, heightPx: template.raster.heightPx };
	}
	const rgba = new Uint8Array(template.raster.widthPx * template.raster.heightPx * 4);
	for (let index = 0; index < template.raster.data.length; index += 1) {
		const value = template.raster.data[index];
		const offset = index * 4;
		rgba[offset] = value;
		rgba[offset + 1] = value;
		rgba[offset + 2] = value;
		rgba[offset + 3] = 255;
	}
	return { data: rgba, widthPx: template.raster.widthPx, heightPx: template.raster.heightPx };
}

function wholeRasterBadge(raster: BadgeGlyphRaster): { xPx: number; yPx: number; widthPx: number; heightPx: number } {
	return { xPx: raster.widthPx / 2, yPx: raster.heightPx / 2, widthPx: raster.widthPx, heightPx: raster.heightPx };
}

function shiftedDice(a: BinaryMask, b: BinaryMask, dx: number, dy: number): number {
	let intersection = 0;
	let aCount = 0;
	let bCount = 0;
	for (let y = 0; y < a.heightPx; y += 1) {
		for (let x = 0; x < a.widthPx; x += 1) {
			const av = a.data[y * a.widthPx + x];
			const bx = x + dx;
			const by = y + dy;
			const bv = bx >= 0 && by >= 0 && bx < b.widthPx && by < b.heightPx ? b.data[by * b.widthPx + bx] : 0;
			if (av) aCount += 1;
			if (bv) bCount += 1;
			if (av && bv) intersection += 1;
		}
	}
	if (aCount === 0 || bCount === 0) return 0;
	return (2 * intersection) / (aCount + bCount);
}

function bestMaskScore(a: BinaryMask, b: BinaryMask, maxShiftPx: number): number {
	let best = 0;
	for (let dy = -maxShiftPx; dy <= maxShiftPx; dy += 1) {
		for (let dx = -maxShiftPx; dx <= maxShiftPx; dx += 1) {
			best = Math.max(best, shiftedDice(a, b, dx, dy));
		}
	}
	return best;
}

export function classifyKnownBadgeBodiesPureTs(
	source: BadgeGlyphRaster,
	templates: readonly HoleNumberTemplate[],
	badges: readonly KnownBadgeBody[],
	options: BadgeGlyphClassifierOptions = {}
): readonly BadgeGlyphClassification[] {
	const p = { ...DEFAULTS, ...options };
	const normalizedTemplates = templates.map((template) => {
		const raster = templateRaster(template);
		return { label: template.label, mask: normalizeBadgeGlyphMask(raster, wholeRasterBadge(raster), p) };
	});
	return badges.map((badge, badgeIndex) => {
		const started = nowMs();
		const candidate = normalizeBadgeGlyphMask(source, badge, p);
		if (!candidate) {
			return {
				badgeIndex,
				method: 'pure-ts' as const,
				bestScore: 0,
				runnerUpScore: 0,
				ambiguityMargin: 0,
				abstention: 'empty-glyph' as const,
				elapsedMs: nowMs() - started
			};
		}
		const ranked = normalizedTemplates
			.flatMap((template) =>
				template.mask ? [{ label: template.label, score: bestMaskScore(candidate, template.mask, p.maxShiftPx) }] : []
			)
			.sort((a, b) => b.score - a.score || a.label - b.label);
		const winner = ranked[0];
		const runnerUp = ranked[1];
		const bestScore = winner?.score ?? 0;
		const runnerUpScore = runnerUp?.score ?? 0;
		const ambiguityMargin = bestScore - runnerUpScore;
		const abstention: BadgeGlyphAbstention | null =
			!winner ? 'empty-glyph' : bestScore < p.minScore ? 'low-score' : ambiguityMargin < p.minMargin ? 'ambiguous' : null;
		return {
			badgeIndex,
			method: 'pure-ts',
			...(abstention === null && winner ? { label: winner.label } : {}),
			...(winner ? { bestLabel: winner.label } : {}),
			bestScore,
			runnerUpScore,
			ambiguityMargin,
			abstention,
			elapsedMs: nowMs() - started
		};
	});
}

export function badgeGlyphBatchIsComplete(classifications: readonly BadgeGlyphClassification[]): boolean {
	if (classifications.length === 0) return false;
	const labels = classifications.flatMap((c) => (c.label === undefined ? [] : [c.label]));
	return labels.length === classifications.length && new Set(labels).size === labels.length;
}
