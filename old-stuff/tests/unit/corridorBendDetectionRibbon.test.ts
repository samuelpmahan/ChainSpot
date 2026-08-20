import { describe, expect, it } from 'vitest';
import {
	DEFAULT_CORRIDOR_BEND_RIBBON_PARAMS,
	buildResidualMask,
	detectCorridorBendsRibbon,
	fitAlphaComposite
} from '../../src/lib/autoAnnotation/corridorBendDetectionRibbon';
import type {
	AlphaCompositeFit,
	DetectCorridorBendsRibbonParams,
	OnOffColorPair
} from '../../src/lib/autoAnnotation/corridorBendDetectionRibbon';
import type { CorridorBendRaster } from '../../src/lib/autoAnnotation/corridorBendDetection';
import type { SourcePoint } from '../../src/lib/domain/project';

type RGB = readonly [number, number, number];

/**
 * Paints a raster via TRUE alpha compositing -- `isBand(x,y)` pixels are
 * `round(alpha*bandColor + (1-alpha)*background(x,y))`, everything else is
 * plain `background(x,y)` -- mirroring how UDisc's actual overlay works, not
 * a solid-color stand-in the way `corridorBendDetection.test.ts`'s
 * `paintRaster` uses (that detector targets raw color, this one targets the
 * composite itself, so the fixtures must be genuinely composited to mean
 * anything).
 */
function paintCompositedRaster(
	widthPx: number,
	heightPx: number,
	isBand: (x: number, y: number) => boolean,
	background: (x: number, y: number) => RGB,
	alpha: number,
	bandColor: RGB
): CorridorBendRaster {
	const data = new Uint8ClampedArray(widthPx * heightPx * 4);
	for (let y = 0; y < heightPx; y += 1) {
		for (let x = 0; x < widthPx; x += 1) {
			const bg = background(x, y);
			const [r, g, b] = isBand(x, y)
				? [
						alpha * bandColor[0] + (1 - alpha) * bg[0],
						alpha * bandColor[1] + (1 - alpha) * bg[1],
						alpha * bandColor[2] + (1 - alpha) * bg[2]
					]
				: bg;
			const p = (y * widthPx + x) * 4;
			data[p] = r;
			data[p + 1] = g;
			data[p + 2] = b;
			data[p + 3] = 255;
		}
	}
	return { widthPx, heightPx, originXPx: 0, originYPx: 0, scale: 1, data, channels: 4 };
}

/** Perpendicular-distance-to-segment band predicate, for a straight tee-basket band of the given half width. */
function perpendicularDistance(x: number, y: number, a: SourcePoint, b: SourcePoint): number {
	const dx = b.xPx - a.xPx;
	const dy = b.yPx - a.yPx;
	const lenSq = dx * dx + dy * dy;
	const t = ((x - a.xPx) * dx + (y - a.yPx) * dy) / lenSq;
	const projX = a.xPx + t * dx;
	const projY = a.yPx + t * dy;
	return Math.hypot(x - projX, y - projY);
}

const ALPHA = 0.7;
const BAND_COLOR: RGB = [150, 150, 148];

// Smaller-scale params tailored to compact synthetic rasters (the defaults'
// 28-52px calibration distances / 80px off-band offset / 140px background
// window are sized for real, larger crops -- see the module doc comment).
// `localBackgroundWindowSrcPx` is kept at a similar WINDOW:BAND-WIDTH ratio
// to the production default (140:~64, ~2.2x) rather than shrunk in lockstep
// with everything else: the box-mean background estimate is unavoidably
// biased toward the band's own color when the window isn't comfortably wider
// than the band (a long band gives the window no "along-band" access to true
// background at all, only "across-band"), so shrinking the window as
// aggressively as the other distances would silently inflate that bias well
// past what `toleranceFloorPx` is calibrated to absorb.
const TEST_PARAMS: DetectCorridorBendsRibbonParams = {
	...DEFAULT_CORRIDOR_BEND_RIBBON_PARAMS,
	onBandDistancesSrcPx: [10, 16, 22],
	offBandOffsetSrcPx: 30,
	localBackgroundWindowSrcPx: 100,
	toleranceFloorPx: 12,
	minOpeningKernelRasterPx: 2,
	maxWidthWalkRasterPx: 60
};

describe('fitAlphaComposite', () => {
	it('recovers the exact alpha/bandColor from noiseless synthetic pairs spanning varied backgrounds', () => {
		const backgrounds: RGB[] = [
			[80, 160, 80],
			[40, 60, 30],
			[190, 180, 150],
			[70, 70, 90]
		];
		const pairs: OnOffColorPair[] = backgrounds.map((bg) => ({
			onBand: [
				ALPHA * BAND_COLOR[0] + (1 - ALPHA) * bg[0],
				ALPHA * BAND_COLOR[1] + (1 - ALPHA) * bg[1],
				ALPHA * BAND_COLOR[2] + (1 - ALPHA) * bg[2]
			],
			offBand: bg
		}));
		const fit = fitAlphaComposite(pairs) as AlphaCompositeFit;
		expect(fit).not.toBeNull();
		expect(fit.alpha).toBeCloseTo(ALPHA, 6);
		expect(fit.bandColor[0]).toBeCloseTo(BAND_COLOR[0], 4);
		expect(fit.bandColor[1]).toBeCloseTo(BAND_COLOR[1], 4);
		expect(fit.bandColor[2]).toBeCloseTo(BAND_COLOR[2], 4);
		expect(fit.rmse).toBeLessThan(1e-6);
	});

	it('returns null with fewer than two pairs', () => {
		expect(fitAlphaComposite([])).toBeNull();
		expect(fitAlphaComposite([{ onBand: [1, 2, 3], offBand: [4, 5, 6] }])).toBeNull();
	});

	it('returns null (not NaN/Infinity) for a degenerate fit where every off-band sample is identical', () => {
		const pairs: OnOffColorPair[] = [
			{ onBand: [100, 100, 100], offBand: [80, 80, 80] },
			{ onBand: [110, 105, 95], offBand: [80, 80, 80] },
			{ onBand: [90, 95, 105], offBand: [80, 80, 80] }
		];
		// off-band never varies -> ATA singular (no information to separate
		// alpha from bandColor along that axis).
		expect(fitAlphaComposite(pairs)).toBeNull();
	});
});

describe('buildResidualMask', () => {
	it('marks composited on-band pixels open and plain background pixels closed', () => {
		// Window (100) kept at roughly the same WINDOW:BAND-WIDTH ratio (40px
		// full width here) as the production default (140:~64) -- see
		// `TEST_PARAMS`'s comment on why: a window too close to the band's own
		// width biases the local background estimate toward the band's color
		// (a long band gives the window no "along-band" access to true
		// background, only "across-band"), inflating the residual past a
		// too-tight tolerance even for genuinely on-band pixels.
		const width = 200;
		const height = 200;
		const tee: SourcePoint = { xPx: 20, yPx: 100 };
		const basket: SourcePoint = { xPx: 180, yPx: 100 };
		const halfWidth = 20;
		const isBand = (x: number, y: number) => perpendicularDistance(x, y, tee, basket) <= halfWidth;
		const background = (): RGB => [80, 160, 80];
		const raster = paintCompositedRaster(width, height, isBand, background, ALPHA, BAND_COLOR);

		const fit: Pick<AlphaCompositeFit, 'alpha' | 'bandColor'> = { alpha: ALPHA, bandColor: BAND_COLOR };
		const mask = buildResidualMask(raster, fit, 12, 100);

		// Well inside the band.
		expect(mask[100 * width + 60]).toBe(1);
		expect(mask[100 * width + 100]).toBe(1);
		// Well outside the band (corners, far from the corridor).
		expect(mask[10 * width + 10]).toBe(0);
		expect(mask[190 * width + 190]).toBe(0);
	});
});

describe('detectCorridorBendsRibbon', () => {
	it('falls back to zero bends when the whole crop is one uniform background color (calibration is genuinely unidentifiable)', () => {
		// With a single background color everywhere, alpha and bandColor are NOT
		// jointly identifiable from (onBand, offBand) pairs alone: infinitely
		// many (alpha, bandColor) pairs explain the same single-background data
		// equally well (see `fitAlphaComposite`'s doc comment and the degenerate
		// unit tests below). This is a known, understood limitation of a
		// self-calibrating fit -- it needs genuine terrain variety near the
		// endpoints to pin down alpha/bandColor, same as the empirical
		// measurement in `scripts/measure-corridor-band.ts` needed variety
		// across multiple holes. The safe behavior is exactly this: propose
		// nothing rather than trust an unidentifiable fit.
		const width = 200;
		const height = 200;
		const tee: SourcePoint = { xPx: 20, yPx: 100 };
		const basket: SourcePoint = { xPx: 180, yPx: 100 };
		const halfWidth = 20;
		const isBand = (x: number, y: number) => perpendicularDistance(x, y, tee, basket) <= halfWidth;
		const raster = paintCompositedRaster(width, height, isBand, () => [80, 160, 80], ALPHA, BAND_COLOR);

		const bends = detectCorridorBendsRibbon(raster, tee, basket, TEST_PARAMS);
		expect(bends).toEqual([]);
	});

	// A gentle, spatially-varying background -- not a single flat color (that
	// would make the calibration genuinely unidentifiable, see the test
	// above), but also not a sharp step between two very different colors:
	// `buildResidualMask`'s local background is a box-mean average, which is
	// only unbiased near a step discontinuity for a window centered well away
	// from it. A hard step running perpendicular through the corridor itself
	// (plausible-sounding as a "shadow line", but a needlessly adversarial
	// synthetic fixture) leaves a real, physically-correct gap in the mask
	// right at the step -- a genuine, documented limitation (see this
	// module's doc comment and the task's own note that the local-homogeneity
	// assumption "breaks down near terrain-type boundaries"), not a bug to
	// paper over here. A smooth gradient still gives real variety between the
	// tee-area and basket-area samples (enough for identifiability) without
	// manufacturing that discontinuity.
	function gentleGradientBackground(x: number, y: number): RGB {
		return [60 + 0.5 * x, 100 + 0.3 * y, 50 + 0.4 * x];
	}

	it('proposes zero (interior) bends for a straight composited band over a smoothly varying background', () => {
		const width = 200;
		const height = 200;
		const tee: SourcePoint = { xPx: 20, yPx: 100 };
		const basket: SourcePoint = { xPx: 180, yPx: 100 };
		const halfWidth = 20;
		const isBand = (x: number, y: number) => perpendicularDistance(x, y, tee, basket) <= halfWidth;
		const raster = paintCompositedRaster(width, height, isBand, gentleGradientBackground, ALPHA, BAND_COLOR);

		const bends = detectCorridorBendsRibbon(raster, tee, basket, TEST_PARAMS);
		expect(bends).toEqual([]);
	});

	// Same "L" shape as corridorBendDetection.test.ts's dogleg fixture: a
	// vertical leg near the left edge joined to a horizontal leg near the
	// bottom edge, this time genuinely alpha-composited rather than
	// solid-filled, over the same smoothly-varying background.
	function doglegRaster(): CorridorBendRaster {
		const width = 200;
		const height = 200;
		const isBand = (x: number, y: number) =>
			(x >= 10 && x <= 50 && y >= 10 && y <= 190) || (y >= 150 && y <= 190 && x >= 10 && x <= 190);
		return paintCompositedRaster(width, height, isBand, gentleGradientBackground, ALPHA, BAND_COLOR);
	}
	const tee: SourcePoint = { xPx: 30, yPx: 30 };
	const basket: SourcePoint = { xPx: 170, yPx: 170 };

	it('proposes one or more bends clustered near the turn for a genuine dogleg', () => {
		const bends = detectCorridorBendsRibbon(doglegRaster(), tee, basket, TEST_PARAMS);
		expect(bends.length).toBeGreaterThanOrEqual(1);
		expect(bends.length).toBeLessThanOrEqual(3);
		for (const bend of bends) {
			expect(bend.xPx).toBeGreaterThanOrEqual(5);
			expect(bend.xPx).toBeLessThanOrEqual(155);
			expect(bend.yPx).toBeGreaterThanOrEqual(120);
			expect(bend.yPx).toBeLessThanOrEqual(195);
		}
	});

	it('suppresses the same dogleg bend when maxDetourRatio is tightened below the traced detour', () => {
		const bends = detectCorridorBendsRibbon(doglegRaster(), tee, basket, { ...TEST_PARAMS, maxDetourRatio: 1.05 });
		expect(bends).toEqual([]);
	});

	it('suppresses the same dogleg bend when minTurnAngleDeg is raised above the actual turn', () => {
		const bends = detectCorridorBendsRibbon(doglegRaster(), tee, basket, { ...TEST_PARAMS, minTurnAngleDeg: 95 });
		expect(bends).toEqual([]);
	});

	it('proposes zero bends when tee and basket sit in disconnected composited islands', () => {
		const width = 200;
		const height = 200;
		const isBand = (x: number, y: number) => (x >= 10 && x <= 50 && y >= 10 && y <= 50) || (x >= 150 && x <= 190 && y >= 150 && y <= 190);
		const raster = paintCompositedRaster(width, height, isBand, () => [80, 160, 80], ALPHA, BAND_COLOR);
		const bends = detectCorridorBendsRibbon(raster, { xPx: 30, yPx: 30 }, { xPx: 170, yPx: 170 }, TEST_PARAMS);
		expect(bends).toEqual([]);
	});

	it('proposes zero bends when tee or basket falls outside the raster bounds', () => {
		const raster = paintCompositedRaster(50, 50, () => true, () => [80, 160, 80], ALPHA, BAND_COLOR);
		const bends = detectCorridorBendsRibbon(raster, { xPx: -5, yPx: 10 }, { xPx: 40, yPx: 40 }, TEST_PARAMS);
		expect(bends).toEqual([]);
	});

	it('proposes zero bends when there is no band at all (plain uniform terrain, nothing to calibrate against)', () => {
		const raster = paintCompositedRaster(200, 200, () => false, () => [80, 160, 80], ALPHA, BAND_COLOR);
		const bends = detectCorridorBendsRibbon(raster, { xPx: 20, yPx: 100 }, { xPx: 180, yPx: 100 }, TEST_PARAMS);
		expect(bends).toEqual([]);
	});

	it('proposes zero bends when the tee-basket distance is too short to sample any calibration points', () => {
		const raster = paintCompositedRaster(200, 200, () => true, () => [80, 160, 80], ALPHA, BAND_COLOR);
		// Straight-line distance is 10px; maxOnBandFractionOfLength caps every
		// configured on-band distance (10, 16, 22) below all but none of them,
		// and minCalibrationPairs should reject what little survives.
		const bends = detectCorridorBendsRibbon(raster, { xPx: 20, yPx: 100 }, { xPx: 30, yPx: 100 }, TEST_PARAMS);
		expect(bends).toEqual([]);
	});
});
