import { describe, expect, it } from 'vitest';
import { badgeRayInvariantHolds, fittedPadFromSweep, sweepPadOrientation } from '../../src/lib/autoAnnotation/teePadOrientation';
import type { BadgeAnchor, FittedPad } from '../../src/lib/autoAnnotation/teePadOrientation';
import type { TeePadRaster } from '../../src/lib/autoAnnotation/teePadDetection';

const UI_SCALE = 1.77;

function blankRaster(widthPx = 220, heightPx = 180): TeePadRaster {
	const rgba = new Uint8Array(widthPx * heightPx * 4);
	for (let offset = 0; offset < rgba.length; offset += 4) {
		rgba[offset] = 120;
		rgba[offset + 1] = 120;
		rgba[offset + 2] = 120;
		rgba[offset + 3] = 255;
	}
	return { rgba, widthPx, heightPx, sourceScale: 1 };
}

/** Draws a hollow pad matching the module's canonical 13x8 UI outer rect at the given axis. */
function drawPad(raster: TeePadRaster, centerXPx: number, centerYPx: number, uiScalePx: number, axisDeg: number): void {
	const major = 13 * uiScalePx;
	const minor = 8 * uiScalePx;
	const rim = 1.4 * uiScalePx;
	const radians = (axisDeg * Math.PI) / 180;
	const cosine = Math.cos(radians);
	const sine = Math.sin(radians);
	const half = Math.ceil(major);
	for (let y = Math.floor(centerYPx - half); y <= Math.ceil(centerYPx + half); y += 1) {
		for (let x = Math.floor(centerXPx - half); x <= Math.ceil(centerXPx + half); x += 1) {
			if (x < 0 || y < 0 || x >= raster.widthPx || y >= raster.heightPx) continue;
			const dx = x - centerXPx;
			const dy = y - centerYPx;
			const localX = dx * cosine + dy * sine;
			const localY = -dx * sine + dy * cosine;
			const outer = Math.abs(localX) <= major / 2 && Math.abs(localY) <= minor / 2;
			const inner = Math.abs(localX) <= major / 2 - rim && Math.abs(localY) <= minor / 2 - rim;
			if (!outer) continue;
			const value = inner ? 158 : 235;
			const offset = (y * raster.widthPx + x) * 4;
			raster.rgba[offset] = value;
			raster.rgba[offset + 1] = value;
			raster.rgba[offset + 2] = value;
		}
	}
}

function axisDelta(a: number, b: number): number {
	const difference = Math.abs((a % 180) - (b % 180));
	return Math.min(difference, 180 - difference);
}

function badge(number: number, xPx: number, yPx: number, radiusPx = 15): BadgeAnchor {
	return { number, xPx, yPx, radiusPx };
}

describe('sweepPadOrientation', () => {
	it('recovers the axis and center of a clean, unoccluded pad', () => {
		const raster = blankRaster();
		drawPad(raster, 90, 90, UI_SCALE, 35);
		const result = sweepPadOrientation(raster, 90, 90, UI_SCALE);
		expect(result).toBeDefined();
		expect(axisDelta(result!.axisDeg, 35)).toBeLessThanOrEqual(2.5);
		expect(Math.abs(result!.xPx - 90)).toBeLessThanOrEqual(1);
		expect(Math.abs(result!.yPx - 90)).toBeLessThanOrEqual(1);
		expect(result!.score).toBeGreaterThan(0.4);
	});

	it('recovers a pad at an arbitrary axis, not just axis-aligned ones', () => {
		const raster = blankRaster();
		drawPad(raster, 100, 100, UI_SCALE, 112.5);
		const result = sweepPadOrientation(raster, 100, 100, UI_SCALE);
		expect(result).toBeDefined();
		expect(axisDelta(result!.axisDeg, 112.5)).toBeLessThanOrEqual(5);
	});

	it('reports no result on a featureless raster instead of guessing an axis', () => {
		const raster = blankRaster();
		const result = sweepPadOrientation(raster, 90, 90, UI_SCALE);
		// A uniform-gray ROI has zero patch energy everywhere, so the raw search
		// finds nothing and there is no raw axis to anchor a masked retry on.
		expect(result === undefined || result.score < 0.3).toBe(true);
	});

	it('rejects non-finite or non-positive inputs rather than throwing', () => {
		const raster = blankRaster();
		expect(sweepPadOrientation(raster, Number.NaN, 90, UI_SCALE)).toBeUndefined();
		expect(sweepPadOrientation(raster, 90, 90, 0)).toBeUndefined();
		expect(sweepPadOrientation(raster, 90, 90, -1)).toBeUndefined();
	});

	it('caches templates per uiScalePx: repeated calls at the same scale return consistent results', () => {
		const raster = blankRaster();
		drawPad(raster, 90, 90, UI_SCALE, 0);
		const first = sweepPadOrientation(raster, 90, 90, UI_SCALE);
		const second = sweepPadOrientation(raster, 90, 90, UI_SCALE);
		expect(first).toEqual(second);
	});
});

describe('fittedPadFromSweep', () => {
	it('converts a sweep result into a unit-direction FittedPad at the canonical UI half-extents', () => {
		const pad = fittedPadFromSweep({ axisDeg: 0, score: 0.8, xPx: 50, yPx: 60 }, UI_SCALE);
		expect(pad.xPx).toBe(50);
		expect(pad.yPx).toBe(60);
		expect(pad.ux).toBeCloseTo(1, 5);
		expect(pad.uy).toBeCloseTo(0, 5);
		expect(pad.halfMajorPx).toBeCloseTo(6.5 * UI_SCALE, 5);
		expect(pad.halfMinorPx).toBeCloseTo(4 * UI_SCALE, 5);
		expect(pad.orientationScore).toBe(0.8);
	});

	it('produces a unit vector at a non-axis-aligned angle', () => {
		const pad = fittedPadFromSweep({ axisDeg: 90, score: 0.5, xPx: 0, yPx: 0 }, UI_SCALE);
		expect(pad.ux).toBeCloseTo(0, 5);
		expect(pad.uy).toBeCloseTo(1, 5);
	});
});

describe('badgeRayInvariantHolds', () => {
	function padAt(xPx: number, yPx: number, axisDeg: number): FittedPad {
		const radians = (axisDeg * Math.PI) / 180;
		return {
			xPx,
			yPx,
			ux: Math.cos(radians),
			uy: Math.sin(radians),
			halfMajorPx: 6.5 * UI_SCALE,
			halfMinorPx: 4 * UI_SCALE,
			evidenceCount: 0
		};
	}

	it('holds when the pad aims directly at its badge along its major axis', () => {
		const pad = padAt(0, 0, 0);
		expect(badgeRayInvariantHolds(pad, badge(1, 80, 0))).toBe(true);
	});

	it('holds regardless of which way the fitted axis points — the ray is bidirectional', () => {
		const pad = padAt(0, 0, 180);
		expect(badgeRayInvariantHolds(pad, badge(1, 80, 0))).toBe(true);
	});

	it('fails when the badge sits well off the pad axis', () => {
		const pad = padAt(0, 0, 0);
		expect(badgeRayInvariantHolds(pad, badge(1, 80, 40))).toBe(false);
	});

	it('fails when the badge sits behind the pad, inside its own half-major extent', () => {
		const pad = padAt(0, 0, 0);
		expect(badgeRayInvariantHolds(pad, badge(1, 5, 0))).toBe(false);
	});

	it('fails when the badge is too far across for its own radius to reach the ray', () => {
		const pad = padAt(0, 0, 0);
		expect(badgeRayInvariantHolds(pad, badge(1, 80, 25, 5))).toBe(false);
	});
});
