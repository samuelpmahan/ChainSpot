import { beforeAll, describe, expect, it } from 'vitest';
import { loadCv } from '../../src/lib/stitch/cvMatch';
import {
	deriveWalkingPathMasksPx,
	detectDashedPathChains
} from '../../src/lib/autoAnnotation/teePadDetection';
import type { TeePadCv, TeePadRaster } from '../../src/lib/autoAnnotation/teePadDetection';
import { asUiScalePx } from '../../src/lib/autoAnnotation/cvCalibration';

/**
 * Exercises `detectDashedPathChains` against the real OpenCV.js runtime (its
 * only dependency is Canny + HoughLinesP, the same as the rest of this
 * file's detectors), on tiny synthetic RGBA rasters. The one property that
 * matters -- periodicity distinguishing a path from an isolated pad-like
 * rectangle -- is exactly what's tested: a repeating dash sequence should
 * chain, a single dash should not.
 */

let cv: TeePadCv;

beforeAll(async () => {
	cv = (await loadCv()) as unknown as TeePadCv;
});

const WIDTH = 300;
const HEIGHT = 300;
const UI_SCALE_PX = asUiScalePx(1.8);
// Matches this module's calibrated constants at UI_SCALE_PX = 1.8.
const DASH_LENGTH_PX = 9.5 * 1.8; // ~17px
const DASH_PERIOD_PX = 13.6 * 1.8; // ~24.5px

function makeRaster(): { raster: TeePadRaster; rgba: Uint8Array } {
	const rgba = new Uint8Array(WIDTH * HEIGHT * 4);
	for (let pixel = 0; pixel < WIDTH * HEIGHT; pixel += 1) {
		rgba[pixel * 4] = 75;
		rgba[pixel * 4 + 1] = 95;
		rgba[pixel * 4 + 2] = 70; // dull green terrain background
		rgba[pixel * 4 + 3] = 255;
	}
	return { raster: { rgba, widthPx: WIDTH, heightPx: HEIGHT, sourceScale: 1 }, rgba };
}

function drawDash(rgba: Uint8Array, centerX: number, centerY: number, lengthPx: number, angleDeg: number): void {
	const radians = (angleDeg * Math.PI) / 180;
	const cosine = Math.cos(radians);
	const sine = Math.sin(radians);
	const halfLength = lengthPx / 2;
	const halfWidth = 3;
	for (let t = -halfLength; t <= halfLength; t += 0.5) {
		for (let w = -halfWidth; w <= halfWidth; w += 0.5) {
			const x = Math.round(centerX + t * cosine - w * sine);
			const y = Math.round(centerY + t * sine + w * cosine);
			if (x < 0 || x >= WIDTH || y < 0 || y >= HEIGHT) continue;
			const offset = (y * WIDTH + x) * 4;
			rgba[offset] = 235;
			rgba[offset + 1] = 235;
			rgba[offset + 2] = 235;
		}
	}
}

describe('detectDashedPathChains', () => {
	it('chains a repeating dash sequence into one path', () => {
		const { raster, rgba } = makeRaster();
		const startX = 60;
		const startY = 150;
		for (let index = 0; index < 6; index += 1) {
			drawDash(rgba, startX + index * DASH_PERIOD_PX, startY, DASH_LENGTH_PX, 0);
		}
		const chains = detectDashedPathChains(cv, raster, { uiScalePx: UI_SCALE_PX });
		expect(chains.length).toBeGreaterThanOrEqual(1);
		const longest = [...chains].sort((a, b) => b.dashes.length - a.dashes.length)[0];
		expect(longest.dashes.length).toBeGreaterThanOrEqual(4);
		// orientationDeg is undirected mod 180, so 0 and ~180 are the same
		// horizontal direction -- compare circular distance from 0, not the
		// raw value, to avoid failing on which side of that seam it landed.
		const circularDistanceFromZero = Math.min(longest.orientationDeg, 180 - longest.orientationDeg);
		expect(circularDistanceFromZero).toBeLessThan(5);
	});

	it('does not chain a single isolated dash (indistinguishable from a real pad edge)', () => {
		const { raster, rgba } = makeRaster();
		drawDash(rgba, 150, 150, DASH_LENGTH_PX, 30);
		const chains = detectDashedPathChains(cv, raster, { uiScalePx: UI_SCALE_PX });
		expect(chains).toHaveLength(0);
	});

	it('does not chain two dashes with no periodic continuation', () => {
		const { raster, rgba } = makeRaster();
		drawDash(rgba, 100, 100, DASH_LENGTH_PX, 0);
		drawDash(rgba, 100 + DASH_PERIOD_PX, 100, DASH_LENGTH_PX, 0);
		const chains = detectDashedPathChains(cv, raster, { uiScalePx: UI_SCALE_PX });
		expect(chains).toHaveLength(0);
	});

	it('produces one exclusion mask per dash', () => {
		const { raster, rgba } = makeRaster();
		const startX = 60;
		const startY = 150;
		for (let index = 0; index < 5; index += 1) {
			drawDash(rgba, startX + index * DASH_PERIOD_PX, startY, DASH_LENGTH_PX, 0);
		}
		const chains = detectDashedPathChains(cv, raster, { uiScalePx: UI_SCALE_PX });
		const masks = deriveWalkingPathMasksPx(chains, UI_SCALE_PX);
		const totalDashes = chains.reduce((sum, chain) => sum + chain.dashes.length, 0);
		expect(masks).toHaveLength(totalDashes);
		expect(masks.every((mask) => mask.radiusPx > 0)).toBe(true);
	});
});
