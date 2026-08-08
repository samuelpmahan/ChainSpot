import { describe, expect, it } from 'vitest';
import { detectBasketTemplateCandidates, findBasketAnchorScale } from '../../src/lib/autoAnnotation/basketTemplateDetection';
import type { BasketCv } from '../../src/lib/autoAnnotation/basketTemplateDetection';

interface Peak {
	readonly x: number;
	readonly y: number;
	readonly score: number;
}

/**
 * A minimal fake OpenCV: `matchTemplate` ignores the actual template pixels
 * and just stamps the requested peaks into every response map (so every one
 * of the 9 scale passes "sees" the same peaks), and `resize` fills in the
 * destination Mat's dimensions/data without needing real interpolation.
 * This isolates the module's own local-maxima/NMS/scale-fusion logic from
 * OpenCV's actual template-matching, which is exercised for real by the CLI
 * against real images instead.
 */
function fakeCv(peaks: readonly Peak[], responseRows = 300, responseCols = 300): BasketCv {
	class FakeMat {
		rows: number;
		cols: number;
		data: Uint8Array;
		data32F?: Float32Array;
		constructor(rows = 0, cols = 0) {
			this.rows = rows;
			this.cols = cols;
			this.data = new Uint8Array(Math.max(0, rows * cols));
		}
		delete(): void {}
	}
	class FakeSize {
		constructor(
			public readonly width: number,
			public readonly height: number
		) {}
	}
	return {
		Mat: FakeMat as unknown as BasketCv['Mat'],
		Size: FakeSize as unknown as BasketCv['Size'],
		CV_8UC1: 0,
		TM_CCOEFF_NORMED: 0,
		INTER_AREA: 0,
		INTER_CUBIC: 1,
		matchTemplate: (_image: unknown, _templ: unknown, result: unknown) => {
			const mat = result as unknown as FakeMat;
			mat.rows = responseRows;
			mat.cols = responseCols;
			const data = new Float32Array(responseRows * responseCols);
			for (const peak of peaks) data[peak.y * responseCols + peak.x] = peak.score;
			mat.data32F = data;
		},
		resize: (_source: unknown, destination: unknown, size: unknown) => {
			const mat = destination as unknown as FakeMat;
			const { width, height } = size as unknown as FakeSize;
			mat.cols = width;
			mat.rows = height;
			mat.data = new Uint8Array(width * height);
		}
	} as unknown as BasketCv;
}

const RASTER = { gray: new Uint8Array(400 * 400), widthPx: 400, heightPx: 400, sourceScale: 1 };
const TEMPLATE = { gray: new Uint8Array(27 * 41), widthPx: 27, heightPx: 41 };

describe('detectBasketTemplateCandidates', () => {
	it('fuses the same peak seen across all 9 scale passes into one candidate at the stem-base fraction', () => {
		const cv = fakeCv([{ x: 10, y: 10, score: 0.9 }]);
		const candidates = detectBasketTemplateCandidates(cv, RASTER, TEMPLATE, { uiScalePx: 1 });

		expect(candidates).toHaveLength(1);
		expect(candidates[0].score).toBeCloseTo(0.9, 5);
		// The semantic point is the bottom-center stem base (0.96 of template height),
		// self-consistently derived regardless of which scale pass "won" NMS.
		expect(candidates[0].yPx).toBeCloseTo(10 + 0.96 * candidates[0].heightPx, 5);
		expect(candidates[0].xPx).toBeCloseTo(10 + candidates[0].widthPx / 2, 5);
	});

	it('keeps two peaks far enough apart as separate candidates', () => {
		const cv = fakeCv([
			{ x: 10, y: 10, score: 0.9 },
			{ x: 200, y: 200, score: 0.8 }
		]);
		const candidates = detectBasketTemplateCandidates(cv, RASTER, TEMPLATE, { uiScalePx: 1 });
		expect(candidates).toHaveLength(2);
		const scores = candidates.map((c) => c.score).sort((a, b) => a - b);
		expect(scores[0]).toBeCloseTo(0.8, 5);
		expect(scores[1]).toBeCloseTo(0.9, 5);
	});

	it('drops candidates below minScore', () => {
		const cv = fakeCv([{ x: 10, y: 10, score: 0.3 }]);
		const candidates = detectBasketTemplateCandidates(cv, RASTER, TEMPLATE, { uiScalePx: 1 });
		expect(candidates).toHaveLength(0);
	});

	it('restricts detection to the map-bounds row band', () => {
		const cv = fakeCv([{ x: 10, y: 10, score: 0.9 }]);
		const candidates = detectBasketTemplateCandidates(cv, RASTER, TEMPLATE, {
			uiScalePx: 1,
			mapBoundsPx: { topPx: 100, bottomPx: 300 }
		});
		expect(candidates).toHaveLength(0);
	});

	it('caps the result at maxCandidates, keeping the highest scores', () => {
		const cv = fakeCv([
			{ x: 10, y: 10, score: 0.9 },
			{ x: 200, y: 10, score: 0.8 },
			{ x: 10, y: 200, score: 0.7 }
		]);
		const candidates = detectBasketTemplateCandidates(cv, RASTER, TEMPLATE, { uiScalePx: 1, maxCandidates: 2 });
		expect(candidates).toHaveLength(2);
		expect(candidates[0].score).toBeCloseTo(0.9, 5);
		expect(candidates[1].score).toBeCloseTo(0.8, 5);
	});
});

describe('findBasketAnchorScale', () => {
	/**
	 * Score peaks at `targetScale` (as a multiple of the template's own pixel
	 * size) and falls off with distance from it, independent of any UI-derived
	 * scale — exercising the same "basket icon can be a very different
	 * multiple of its canonical template than the number badge is" scenario
	 * the real GoldenTeeSet fixture measurement found.
	 */
	function fakeCvWithScorePeakAt(targetScale: number, templateWidthPx: number): BasketCv {
		class FakeMat {
			rows: number;
			cols: number;
			data: Uint8Array;
			data32F?: Float32Array;
			constructor(rows = 0, cols = 0) {
				this.rows = rows;
				this.cols = cols;
				this.data = new Uint8Array(Math.max(0, rows * cols));
			}
			delete(): void {}
		}
		class FakeSize {
			constructor(
				public readonly width: number,
				public readonly height: number
			) {}
		}
		let lastResizedWidth = 0;
		return {
			Mat: FakeMat as unknown as BasketCv['Mat'],
			Size: FakeSize as unknown as BasketCv['Size'],
			CV_8UC1: 0,
			TM_CCOEFF_NORMED: 0,
			INTER_AREA: 0,
			INTER_CUBIC: 1,
			resize: (_source: unknown, destination: unknown, size: unknown) => {
				const mat = destination as unknown as FakeMat;
				const { width, height } = size as unknown as FakeSize;
				mat.cols = width;
				mat.rows = height;
				mat.data = new Uint8Array(width * height);
				lastResizedWidth = width;
			},
			matchTemplate: (_image: unknown, _templ: unknown, result: unknown) => {
				const mat = result as unknown as FakeMat;
				mat.rows = 4;
				mat.cols = 4;
				const impliedScale = lastResizedWidth / templateWidthPx;
				const score = Math.max(0, 1 - Math.abs(impliedScale - targetScale) * 2);
				mat.data32F = new Float32Array(16).fill(score);
			},
			minMaxLoc: (mat: unknown) => {
				const data = (mat as unknown as FakeMat).data32F!;
				let maxVal = -Infinity;
				for (const value of data) if (value > maxVal) maxVal = value;
				return { minVal: 0, maxVal, minLoc: { x: 0, y: 0 }, maxLoc: { x: 0, y: 0 } };
			}
		} as unknown as BasketCv;
	}

	it('finds the true peak scale via a blind sweep, independent of any assumed UI scale', () => {
		const cv = fakeCvWithScorePeakAt(2.0, TEMPLATE.widthPx);
		const anchor = findBasketAnchorScale(cv, RASTER, TEMPLATE, {
			scaleRangeLow: 0.4,
			scaleRangeHigh: 4.0,
			scaleStep: 0.1
		});
		expect(anchor).not.toBeNull();
		expect(anchor!.scale).toBeCloseTo(2.0, 1);
		expect(anchor!.score).toBeGreaterThan(0.9);
	});

	it('rejects an invalid sweep range', () => {
		const cv = fakeCvWithScorePeakAt(1, TEMPLATE.widthPx);
		expect(() => findBasketAnchorScale(cv, RASTER, TEMPLATE, { scaleRangeLow: 2, scaleRangeHigh: 1 })).toThrow(
			/scaleRangeHigh/
		);
	});
});
