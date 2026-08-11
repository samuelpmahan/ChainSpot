import { describe, expect, test } from 'vitest';
import { placementsEqual, requiresReplaceDecision } from '../../src/lib/stitch/rerunGuard';
import type { PlacementMap } from '../../src/lib/stitch/rerunGuard';
import { proposeCropDetailed } from '../../src/lib/stitch/autoCrop';
import { buildGrayRaster } from '../helpers/smartMap';
import type { AnalysisRaster } from '../../src/lib/stitch/analysis';
import type { TilePlacement } from '../../src/lib/stitch/geometry';

const ALL_SLOTS = ['upper-left', 'upper-right', 'lower-left', 'lower-right'] as const;
type Slot2x2 = (typeof ALL_SLOTS)[number];

const PORTRAIT_ORIGINS: Record<Slot2x2, { x: number; y: number }> = {
	'upper-left': { x: 0, y: 0 },
	'upper-right': { x: 150, y: 0 },
	'lower-left': { x: 0, y: 150 },
	'lower-right': { x: 150, y: 150 }
};

/**
 * A portrait phone screenshot raster: 1290x2796 original pixels analyzed at the
 * dedicated crop resolution (1024 long edge, scale ~2.73), so ~3 original
 * pixels per analysis row instead of the stitch matcher's ~11.7. Content is a
 * cheap deterministic per-tile pattern that differs across screenshots at the
 * same screen coordinates (cross-tile agreement is what matters, not realism).
 */
function portraitRaster(
	slot: Slot2x2,
	chromeTopLines: number,
	chromeBottomLines: number
): AnalysisRaster {
	const widthPx = 473;
	const heightPx = 1024;
	const scale = 2796 / 1024;
	const origin = PORTRAIT_ORIGINS[slot];
	const gray = new Uint8Array(widthPx * heightPx);
	for (let y = 0; y < heightPx; y += 1) {
		for (let x = 0; x < widthPx; x += 1) {
			let value;
			if (y < chromeTopLines) value = 12;
			else if (y >= heightPx - chromeBottomLines) value = 30;
			else {
				const h = Math.imul(Math.round(origin.x + x * scale), 2654435761) ^
					Math.imul(Math.round(origin.y + y * scale), 40503);
				value = 40 + ((h >>> 0) % 200);
			}
			gray[y * widthPx + x] = value;
		}
	}
	return { widthPx, heightPx, gray, scale };
}

function placements(
	moves: Record<string, Partial<{ xPx: number; yPx: number; visible: boolean }>> = {}
): PlacementMap {
	const base: Record<Slot2x2, TilePlacement> = {
		'upper-left': { xPx: 0, yPx: 0, visible: true },
		'upper-right': { xPx: 150, yPx: 0, visible: true },
		'lower-left': { xPx: 0, yPx: 150, visible: true },
		'lower-right': { xPx: 150, yPx: 150, visible: true }
	};
	for (const [slot, move] of Object.entries(moves)) {
		const key = slot as Slot2x2;
		base[key] = { ...base[key], ...move };
	}
	return base;
}

describe('P1-002 re-run, crop-conflict, and manual-state preservation (case 2)', () => {
	// This one consolidated case also runs cross-tile crop analysis over several
	// synthetic sets (including portrait rasters); under parallel unit-suite
	// load it can exceed the default 5s limit, so it declares its own generous
	// timeout.
	test(
		're-run protection covers x/y and visibility, is deterministic and non-destructive, and crop evidence is shared and bounded',
		() => {
		// placementsEqual matches only when every placement agrees on x/y AND
		// visibility; a hidden tile is manual work that must never be silently
		// replaced by a fresh automatic result.
		const a = placements();
		const b = placements();
		expect(placementsEqual(a, b)).toBe(true);

		const moved = placements({ 'upper-right': { xPx: 151, yPx: 0 } });
		expect(placementsEqual(a, moved)).toBe(false);

		const hidden = placements({ 'lower-left': { visible: false } });
		expect(placementsEqual(a, hidden)).toBe(false);

		// Null or undefined maps never compare equal (defensive default).
		expect(placementsEqual(null, a)).toBe(false);
		expect(placementsEqual(undefined, null)).toBe(false);

		// A re-run over manual edits (a move OR a visibility change) requires an
		// explicit replace decision; an unchanged arrangement or an empty session
		// needs no confirmation.
		const lastAuto = placements();
		const current = placements({ 'upper-right': { xPx: 151, yPx: 0 } });
		expect(requiresReplaceDecision(current, lastAuto)).toBe(true);
		expect(requiresReplaceDecision(placements({ 'lower-left': { visible: false } }), lastAuto)).toBe(
			true
		);
		expect(requiresReplaceDecision(placements(), lastAuto)).toBe(false);
		expect(requiresReplaceDecision(null, lastAuto)).toBe(false);
		expect(requiresReplaceDecision(null, null)).toBe(false);

		// The guard is deterministic and never mutates its inputs, so a cancelled
		// re-run preserves crop, placements, selection, visibility, and export state.
		const guarded = placements({ 'lower-left': { yPx: 152 } });
		const before = JSON.stringify({ lastAuto, current: guarded });
		expect(requiresReplaceDecision(guarded, lastAuto)).toBe(true);
		expect(JSON.stringify({ lastAuto, current: guarded })).toBe(before);

		// Crop confidence is separate from layout confidence and shared-only:
		// full agreement across all four tiles is required for high confidence.
		const fullAgreement = ALL_SLOTS.map((slot) => buildGrayRaster(slot));
		const high = proposeCropDetailed(fullAgreement);
		expect(high.insets).toEqual({ topPx: 4, rightPx: 0, bottomPx: 3, leftPx: 0 });
		expect(high.confidence).toBe('high');
		expect(high.perSide.top).toEqual([4, 4, 4, 4]);
		expect(high.perSide.bottom).toEqual([3, 3, 3, 3]);

		// Partial edge evidence lowers confidence and drops the conflicting side.
		const partial = ALL_SLOTS.map((slot) =>
			buildGrayRaster(slot, { chromeTop: slot === 'lower-left' ? 0 : undefined })
		);
		const low = proposeCropDetailed(partial);
		expect(low.insets).toEqual({ topPx: 0, rightPx: 0, bottomPx: 3, leftPx: 0 });
		expect(low.confidence).toBe('low');

		// Map content that is individually uniform but differs across screenshots
		// is not cropped: each tile has a flat top band with a different
		// luminance, so no shared boundary exists and no proposal is returned.
		const contentLike = ALL_SLOTS.map((slot, index) => {
			const raster = buildGrayRaster(slot, { chromeTop: 0, chromeBottom: 0 });
			const gray = raster.gray.slice();
			const value = 20 + index * 25;
			for (let y = 0; y < 4; y += 1) {
				for (let x = 0; x < raster.widthPx; x += 1) {
					gray[y * raster.widthPx + x] = value;
				}
			}
			return { ...raster, gray };
		});
		const contentDiagnostic = proposeCropDetailed(contentLike);
		expect(contentDiagnostic.insets).toBeNull();
		expect(contentDiagnostic.confidence).toBe('absent');

		// A capture with no shared band gets no crop proposal and absent confidence.
		const none = ALL_SLOTS.map((slot) =>
			buildGrayRaster(slot, { chromeTop: 0, chromeBottom: 0 })
		);
		const absent = proposeCropDetailed(none);
		expect(absent.insets).toBeNull();
		expect(absent.confidence).toBe('absent');

		// Realistic nonuniform fixed chrome (text/icon-like variation) is
		// detected because it repeats at the same screen coordinates across all
		// four screenshots, even though no individual row is uniform.
		const nonuniformChrome = ALL_SLOTS.map((slot) => {
			const raster = buildGrayRaster(slot, { chromeTop: 0, chromeBottom: 0 });
			const gray = raster.gray.slice();
			for (let y = 0; y < 8; y += 1) {
				for (let x = 0; x < raster.widthPx; x += 1) {
					// Deterministic glyph-like pattern: background with a dark
					// "icon" block and per-column texture, identical on every tile.
					const block = x % 24 < 10;
					gray[y * raster.widthPx + x] = block ? 60 + ((y * 37 + x) % 30) : 12;
				}
			}
			return { ...raster, gray };
		});
		const nonuniform = proposeCropDetailed(nonuniformChrome);
		expect(nonuniform.insets).toEqual({ topPx: 8, rightPx: 0, bottomPx: 0, leftPx: 0 });
		expect(nonuniform.confidence).toBe('high');

		// A clear repeated-to-varying transition produces a boundary exactly at
		// the injected ground truth.
		const groundTruth = ALL_SLOTS.map((slot) =>
			buildGrayRaster(slot, { chromeTop: 11, chromeBottom: 0 })
		);
		const truthful = proposeCropDetailed(groundTruth);
		expect(truthful.insets).not.toBeNull();
		if (truthful.insets) expect(truthful.insets.topPx).toBe(11);

		// A small number of locally noisy rows inside a repeated band does not
		// truncate it: the clock row differs across captures, yet the band is
		// still found at its full depth with high confidence.
		const noisyBand = ALL_SLOTS.map((slot, index) => {
			const raster = buildGrayRaster(slot, { chromeTop: 8, chromeBottom: 0 });
			const gray = raster.gray.slice();
			for (let x = 0; x < raster.widthPx; x += 1) {
				gray[3 * raster.widthPx + x] = 90 + index * 30;
			}
			return { ...raster, gray };
		});
		const noisy = proposeCropDetailed(noisyBand);
		expect(noisy.insets).not.toBeNull();
		if (noisy.insets) expect(noisy.insets.topPx).toBe(8);
		expect(noisy.confidence).toBe('high');

		// Scattered clock-like rows on a single tile (a few percent of pixels
		// differing on isolated lines) are noise, not a per-tile boundary: the
		// band stays at its full depth with high confidence.
		const clockLike = ALL_SLOTS.map((slot, index) => {
			const raster = buildGrayRaster(slot, { chromeTop: 8, chromeBottom: 0 });
			if (index !== 0) return raster;
			const gray = raster.gray.slice();
			for (const row of [2, 3, 5]) {
				for (let x = 0; x < raster.widthPx; x += 1) {
					if (x % 10 === 0) gray[row * raster.widthPx + x] = 200;
				}
			}
			return { ...raster, gray };
		});
		const clockResult = proposeCropDetailed(clockLike);
		expect(clockResult.insets).not.toBeNull();
		if (clockResult.insets) expect(clockResult.insets.topPx).toBe(8);
		expect(clockResult.confidence).toBe('high');

		// A sustained run of per-tile divergence (a tile whose chrome genuinely
		// ends early) is not noise: the per-tile boundary spread downgrades the
		// whole side from high to low.
		const earlyChrome = ALL_SLOTS.map((slot, index) => {
			const raster = buildGrayRaster(slot, { chromeTop: 8, chromeBottom: 0 });
			if (index !== 0) return raster;
			const gray = raster.gray.slice();
			for (const row of [2, 3, 4]) {
				for (let x = 0; x < raster.widthPx; x += 1) {
					if (x % 3 === 0) gray[row * raster.widthPx + x] = 200;
				}
			}
			return { ...raster, gray };
		});
		const earlyResult = proposeCropDetailed(earlyChrome);
		expect(earlyResult.confidence).toBe('low');

		// An ambiguous transition (repeated content with no observed end inside
		// the analysis bound) proposes nothing beyond the bounded cap and is
		// never high.
		const endless = ALL_SLOTS.map((slot) => {
			const raster = buildGrayRaster(slot, { chromeTop: 0, chromeBottom: 0 });
			const gray = raster.gray.slice();
			for (let y = 0; y < raster.heightPx; y += 1) {
				for (let x = 0; x < raster.widthPx; x += 1) {
					gray[y * raster.widthPx + x] = 140;
				}
			}
			return { ...raster, gray };
		});
		const ambiguous = proposeCropDetailed(endless);
		expect(ambiguous.confidence).toBe('low');

		// Mismatched per-tile evidence never produces high confidence: three
		// tiles share an 8px top band, the fourth only 4px, so the top side is
		// declined and the overall result is low.
		const mismatched = ALL_SLOTS.map((slot) =>
			buildGrayRaster(slot, { chromeTop: slot === 'lower-left' ? 4 : 8, chromeBottom: 0 })
		);
		const mismatchResult = proposeCropDetailed(mismatched);
		expect(mismatchResult.confidence).toBe('low');
		expect(mismatchResult.insets).toBeNull();

		// Crop values are bounded and expressed in integer original pixels.
		for (const [field, value] of Object.entries(truthful.insets ?? {})) {
			expect(Number.isInteger(value)).toBe(true);
			expect(value).toBeGreaterThanOrEqual(0);
		}

		// Portrait dimensions do not cause coarse 10-12px quantization: a
		// 57px-deep band on a 1290x2796 capture resolves within a few original
		// pixels, not to the nearest 12px analysis step.
		const portrait = ALL_SLOTS.map((slot) => portraitRaster(slot, 21, 11));
		const portraitResult = proposeCropDetailed(portrait);
		expect(portraitResult.insets).not.toBeNull();
		if (portraitResult.insets) {
			expect(Math.abs(portraitResult.insets.topPx - 57)).toBeLessThanOrEqual(4);
			expect(Math.abs(portraitResult.insets.bottomPx - 30)).toBeLessThanOrEqual(4);
		}
		expect(portraitResult.confidence).toBe('high');
		},
		20000
	);
});
