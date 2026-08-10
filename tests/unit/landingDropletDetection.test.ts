import { beforeAll, describe, expect, it } from 'vitest';
import { loadCv } from '../../src/lib/stitch/cvMatch';
import {
	buildInteriorGlyphSignature,
	classifyLandingDropletGlyph,
	classifyLandingDropletGlyphs,
	findLandingDroplets,
	landingDropletGlyphTemplateFromMask
} from '../../src/lib/autoAnnotation/landingDropletDetection';
import type {
	LandingDropletCv,
	LandingDropletGlyphTemplate,
	LandingDropletRaster
} from '../../src/lib/autoAnnotation/landingDropletDetection';

/**
 * These tests exercise `findLandingDroplets` against the real OpenCV.js
 * runtime (the same `loadCv()` the worker/CLI use), on tiny synthetic RGBA
 * rasters built in-memory. Unlike `basketTemplateDetection.test.ts`'s fake
 * `BasketCv` (which isolates local-maxima/NMS logic from OpenCV's own,
 * expensive multiscale template matching), this detector's only real
 * dependency on OpenCV is a single HSV threshold and one connected-components
 * pass -- both fast and simple enough that reimplementing them as a fake
 * would risk silently drifting from OpenCV's actual semantics. Classification
 * (`buildInteriorGlyphSignature` / `classifyLandingDropletGlyph`) has no
 * OpenCV dependency at all and is tested with plain synthetic data below.
 */

let cv: LandingDropletCv;

beforeAll(async () => {
	cv = (await loadCv()) as unknown as LandingDropletCv;
});

/** UDisc marker blue, safely inside the detector's HSV window. */
const MARKER_BLUE: readonly [number, number, number] = [20, 20, 220];

function makeRaster(widthPx: number, heightPx: number, sourceScale = 1): { raster: LandingDropletRaster; rgba: Uint8Array } {
	const rgba = new Uint8Array(widthPx * heightPx * 4);
	for (let pixel = 0; pixel < widthPx * heightPx; pixel += 1) rgba[pixel * 4 + 3] = 255;
	return { raster: { rgba, widthPx, heightPx, sourceScale }, rgba };
}

function fillRect(
	rgba: Uint8Array,
	widthPx: number,
	x: number,
	y: number,
	w: number,
	h: number,
	color: readonly [number, number, number]
): void {
	for (let row = y; row < y + h; row += 1) {
		for (let col = x; col < x + w; col += 1) {
			const offset = (row * widthPx + col) * 4;
			rgba[offset] = color[0];
			rgba[offset + 1] = color[1];
			rgba[offset + 2] = color[2];
			rgba[offset + 3] = 255;
		}
	}
}

/** A pin whose bottom two rows are offset left of the bounding-box center, so tip-averaging is distinguishable from bbox center. */
function drawPin(rgba: Uint8Array, widthPx: number, x: number, y: number): void {
	fillRect(rgba, widthPx, x, y, 20, 25, MARKER_BLUE); // body: 20 wide, 25 tall
	fillRect(rgba, widthPx, x + 5, y + 25, 5, 5, MARKER_BLUE); // tail: narrower, shifted left, 5 tall
}
const PIN_WIDTH = 20;
const PIN_HEIGHT = 30;
const PIN_AREA = 20 * 25 + 5 * 5;

describe('findLandingDroplets: tip semantics', () => {
	it('reports the bottom-most blue rows average x, not the bounding-box center', () => {
		const { raster, rgba } = makeRaster(80, 80);
		drawPin(rgba, 80, 10, 10);

		const { droplets } = findLandingDroplets(cv, raster);
		expect(droplets).toHaveLength(1);
		const [droplet] = droplets;

		// Bounding box center-x would be 10 + 20/2 = 20; the tail's bottom two
		// rows span x=[15,19], averaging to x=17 -- distinct from bbox center.
		expect(droplet.boundsPx).toEqual({ xPx: 10, yPx: 10, widthPx: PIN_WIDTH, heightPx: PIN_HEIGHT });
		expect(droplet.xPx).toBe(17);
		expect(droplet.yPx).toBe(10 + PIN_HEIGHT - 1);
		expect(droplet.xPx).not.toBe(10 + PIN_WIDTH / 2);
		expect(droplet.areaPx).toBe(PIN_AREA);
	});

	it('never publishes the connected-component centroid as the tip', () => {
		const { raster, rgba } = makeRaster(80, 80);
		drawPin(rgba, 80, 10, 10);
		const { droplets } = findLandingDroplets(cv, raster);
		// The centroid of a droplet-shaped blob sits well above its bottom edge.
		expect(droplets[0].yPx).toBeGreaterThan(10 + PIN_HEIGHT * 0.7);
	});
});

describe('findLandingDroplets: GPS/UI rejection', () => {
	it('rejects a circular GPS-location blob and wide MAP/SAT chrome, keeping only the standalone pin', () => {
		const { raster, rgba } = makeRaster(220, 120);
		drawPin(rgba, 220, 10, 10);
		// Roughly circular GPS dot: aspect ~1, well clear of the pin's aspect ratio.
		fillRect(rgba, 220, 60, 10, 24, 24, MARKER_BLUE);
		// Very wide MAP/SAT-style control.
		fillRect(rgba, 220, 100, 60, 100, 20, MARKER_BLUE);

		const { droplets, deferredOverlaps } = findLandingDroplets(cv, raster);
		expect(droplets).toHaveLength(1);
		expect(droplets[0].boundsPx.xPx).toBe(10);
		expect(deferredOverlaps).toHaveLength(0);
	});

	it('ignores small antialiasing fragments below the minimum component area', () => {
		const { raster, rgba } = makeRaster(80, 80);
		drawPin(rgba, 80, 10, 10);
		fillRect(rgba, 80, 60, 60, 3, 3, MARKER_BLUE); // 9px, far under the noise floor
		const { droplets } = findLandingDroplets(cv, raster);
		expect(droplets).toHaveLength(1);
	});
});

describe('findLandingDroplets: resolution-relative size bounds', () => {
	it('detects a proportionally larger droplet on a much higher-resolution screenshot', () => {
		// A droplet this large (200x300px) would exceed the old fixed absolute
		// caps (160x220px) that this module used before switching to bounds
		// expressed as a fraction of the raster's own shorter side -- on a
		// ~4000px-wide screenshot it is still a small UI glyph, proportionally
		// smaller than the 45x61px droplet in the real fixture (~2359px wide).
		const { raster, rgba } = makeRaster(4000, 4500);
		fillRect(rgba, 4000, 100, 100, 200, 250, MARKER_BLUE); // body
		fillRect(rgba, 4000, 150, 350, 100, 50, MARKER_BLUE); // tail, 300px total height

		const { droplets } = findLandingDroplets(cv, raster);
		expect(droplets).toHaveLength(1);
		expect(droplets[0].boundsPx).toEqual({ xPx: 100, yPx: 100, widthPx: 200, heightPx: 300 });
	});
});

describe('findLandingDroplets: deferred overlap', () => {
	it('flags a plausible merged-droplet blob as a deferred overlap, not a confident split pair', () => {
		const { raster, rgba } = makeRaster(160, 120);
		drawPin(rgba, 160, 10, 10);
		drawPin(rgba, 160, 60, 10);
		// A single wider/taller blob, roughly 1.5x one pin's area/footprint --
		// plausible as two overlapping droplets, unlike wide UI chrome.
		fillRect(rgba, 160, 110, 10, 28, 33, MARKER_BLUE);

		const { droplets, deferredOverlaps } = findLandingDroplets(cv, raster);
		expect(droplets).toHaveLength(2);
		expect(deferredOverlaps).toHaveLength(1);
		expect(deferredOverlaps[0].boundsPx.xPx).toBe(110);
		expect(deferredOverlaps[0].reason).toMatch(/document & defer/);
	});

	it('does not flag wide UI chrome as a deferred overlap even when its area alone would qualify', () => {
		const { raster, rgba } = makeRaster(260, 120);
		drawPin(rgba, 260, 10, 10);
		drawPin(rgba, 260, 60, 10);
		// Area-wise "big enough" (>1.45x a pin), but far wider than two droplets ever would be.
		fillRect(rgba, 260, 110, 30, 130, 26, MARKER_BLUE);

		const { droplets, deferredOverlaps } = findLandingDroplets(cv, raster);
		expect(droplets).toHaveLength(2);
		expect(deferredOverlaps).toHaveLength(0);
	});
});

describe('findLandingDroplets: scale variation', () => {
	it('scales tip and bounds by sourceScale, representing a downsampled analysis raster', () => {
		const full = makeRaster(80, 80, 1);
		drawPin(full.rgba, 80, 10, 10);
		const downsampled = makeRaster(80, 80, 2.5);
		drawPin(downsampled.rgba, 80, 10, 10);

		const atFullRes = findLandingDroplets(cv, full.raster).droplets[0];
		const atDownsampledRes = findLandingDroplets(cv, downsampled.raster).droplets[0];

		expect(atDownsampledRes.xPx).toBeCloseTo(atFullRes.xPx * 2.5, 5);
		expect(atDownsampledRes.yPx).toBeCloseTo(atFullRes.yPx * 2.5, 5);
		expect(atDownsampledRes.boundsPx.widthPx).toBeCloseTo(atFullRes.boundsPx.widthPx * 2.5, 5);
		expect(atDownsampledRes.areaPx).toBeCloseTo(atFullRes.areaPx * 2.5 * 2.5, 5);
	});

	it('restricts detections to an optional map bounds window, expressed in source pixels', () => {
		const { raster, rgba } = makeRaster(80, 160, 2);
		drawPin(rgba, 80, 10, 10); // raster-space tip around y=39 -> source y ~78
		drawPin(rgba, 80, 10, 60); // raster-space tip around y=89 -> source y ~178, outside a tight window

		const restricted = findLandingDroplets(cv, raster, { mapBoundsPx: { topPx: 0, bottomPx: 100 } });
		expect(restricted.droplets).toHaveLength(1);

		const unrestricted = findLandingDroplets(cv, raster);
		expect(unrestricted.droplets).toHaveLength(2);
	});
});

describe('buildInteriorGlyphSignature', () => {
	function whiteRaster(widthPx: number, heightPx: number): { raster: LandingDropletRaster; rgba: Uint8Array } {
		const { raster, rgba } = makeRaster(widthPx, heightPx);
		return { raster, rgba };
	}

	function paintWhite(rgba: Uint8Array, widthPx: number, x: number, y: number, w: number, h: number): void {
		fillRect(rgba, widthPx, x, y, w, h, [255, 255, 255]);
	}

	it('keeps an interior white fragment and discards fragments touching the crop border', () => {
		const { raster, rgba } = whiteRaster(40, 40);
		// Droplet bounds: (0,0,20,20). Interior fragment, well clear of every edge.
		paintWhite(rgba, 40, 6, 4, 4, 4);
		// Border-touching fragment (starts at crop column 0).
		paintWhite(rgba, 40, 0, 2, 3, 3);

		const signature = buildInteriorGlyphSignature(raster, { xPx: 0, yPx: 0, widthPx: 20, heightPx: 20 }, 8);
		const onPixels = Array.from(signature).filter((value) => value > 0).length;
		expect(onPixels).toBeGreaterThan(0);

		// A signature built from only the border-touching fragment should be empty --
		// proving the border-connected fragment above was excluded, not just downsampled away.
		const { raster: borderOnlyRaster, rgba: borderOnlyRgba } = whiteRaster(40, 40);
		paintWhite(borderOnlyRgba, 40, 0, 2, 3, 3);
		const borderOnlySignature = buildInteriorGlyphSignature(borderOnlyRaster, { xPx: 0, yPx: 0, widthPx: 20, heightPx: 20 }, 8);
		expect(Array.from(borderOnlySignature).every((value) => value === 0)).toBe(true);
	});

	it('ignores the bottom ~quarter of the bounding box, which contains the tip rather than the glyph', () => {
		const { raster, rgba } = whiteRaster(40, 40);
		// Bottom quarter of a 20-tall crop is roughly rows 15-19; place white there only.
		paintWhite(rgba, 40, 6, 16, 4, 3);
		const signature = buildInteriorGlyphSignature(raster, { xPx: 0, yPx: 0, widthPx: 20, heightPx: 20 }, 8);
		expect(Array.from(signature).every((value) => value === 0)).toBe(true);
	});
});

describe('landingDropletGlyphTemplateFromMask and classification', () => {
	function checkerTemplate(kind: 'c1' | 'c2' | 'off-fairway', onIndices: readonly number[], size = 4): LandingDropletGlyphTemplate {
		const gray = new Uint8Array(size * size);
		for (const index of onIndices) gray[index] = 255;
		return landingDropletGlyphTemplateFromMask(kind, gray, size, size);
	}

	it('throws for a non-square template mask', () => {
		expect(() => landingDropletGlyphTemplateFromMask('c1', new Uint8Array(6), 3, 2)).toThrow();
	});

	it('picks the exactly-matching template via the public classification API', () => {
		const size = 6;
		// Each template occupies a distinct interior 2x2 block, away from the
		// crop's own border (which `buildInteriorGlyphSignature` discards, just
		// like the droplet's real white outer rim).
		const templates = [
			checkerTemplate('c1', [7, 8, 13, 14], size), // rows 1-2, cols 1-2
			checkerTemplate('c2', [9, 10, 15, 16], size), // rows 1-2, cols 3-4
			checkerTemplate('off-fairway', [19, 20, 25, 26], size) // rows 3-4, cols 1-2
		];

		// A droplet bounding box of (0, 0, 6, 8): `buildInteriorGlyphSignature`
		// crops the top round(8 * 0.76) = 6 rows, which maps 1:1 (no resize
		// distortion) onto the 6x6 template grid -- painting white at rows
		// 1-2/cols 3-4 exactly reproduces the c2 template's on-pixels.
		const { raster, rgba } = makeRaster(10, 10);
		for (let row = 1; row < 3; row += 1) {
			for (let col = 3; col < 5; col += 1) {
				const offset = (row * 10 + col) * 4;
				rgba[offset] = 255;
				rgba[offset + 1] = 255;
				rgba[offset + 2] = 255;
				rgba[offset + 3] = 255;
			}
		}

		const localization = { xPx: 0, yPx: 7, boundsPx: { xPx: 0, yPx: 0, widthPx: size, heightPx: 8 }, areaPx: 48 };
		const classification = classifyLandingDropletGlyph(raster, localization, templates);
		expect(classification.kind).toBe('c2');
		expect(classification.glyphConfidence).toBeCloseTo(1, 5);
	});

	it('classifies a droplet whose interior glyph matches a bundled template, via the public API', () => {
		const size = 8;
		const c1Mask = new Uint8Array(size * size);
		const c2Mask = new Uint8Array(size * size);
		const offMask = new Uint8Array(size * size);
		// c1: a small tight block near the center.
		for (let row = 3; row < 5; row += 1) for (let col = 3; col < 5; col += 1) c1Mask[row * size + col] = 255;
		// c2: a larger ring-ish spread, clearly more "on" pixels than c1.
		for (let row = 1; row < 7; row += 1)
			for (let col = 1; col < 7; col += 1) if (row === 1 || row === 6 || col === 1 || col === 6) c2Mask[row * size + col] = 255;
		// off-fairway: nearly the whole interior filled.
		for (let row = 0; row < size; row += 1) for (let col = 0; col < size; col += 1) offMask[row * size + col] = 255;

		const templates = [
			landingDropletGlyphTemplateFromMask('c1', c1Mask, size, size),
			landingDropletGlyphTemplateFromMask('c2', c2Mask, size, size),
			landingDropletGlyphTemplateFromMask('off-fairway', offMask, size, size)
		];

		const { raster, rgba } = makeRaster(40, 40);
		// Paint a c2-like ring inside a droplet bounding box of (0,0,20,20) (glyph area = top 76%).
		const dropletBounds = { xPx: 0, yPx: 0, widthPx: 20, heightPx: 20 };
		for (let row = 2; row < 13; row += 1) {
			for (let col = 2; col < 13; col += 1) {
				if (row === 2 || row === 12 || col === 2 || col === 12) {
					const offset = (row * 40 + col) * 4;
					rgba[offset] = 255;
					rgba[offset + 1] = 255;
					rgba[offset + 2] = 255;
					rgba[offset + 3] = 255;
				}
			}
		}

		const classification = classifyLandingDropletGlyph(raster, { xPx: 0, yPx: 19, boundsPx: dropletBounds, areaPx: 400 }, templates);
		expect(classification.kind).toBe('c2');
		expect(classification.glyphConfidence).toBeGreaterThan(0);

		const combined = classifyLandingDropletGlyphs(
			raster,
			[{ xPx: 0, yPx: 19, boundsPx: dropletBounds, areaPx: 400 }],
			templates
		);
		expect(combined).toHaveLength(1);
		expect(combined[0].kind).toBe('c2');
		expect(combined[0].xPx).toBe(0);
		expect(combined[0].yPx).toBe(19);
	});
});
