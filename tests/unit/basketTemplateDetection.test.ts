import { describe, expect, it } from 'vitest';
import { detectBasketTemplateCandidates, findBasketAnchorScale } from '../../src/lib/autoAnnotation/basketTemplateDetection';
import type { BasketCv } from '../../src/lib/autoAnnotation/basketTemplateDetection';

interface Peak {
	readonly x: number;
	readonly y: number;
	readonly score: number;
}

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
		matchTemplate: (_image: unknown, _template: unknown, result: unknown) => {
			const mat = result as FakeMat;
			mat.rows = responseRows;
			mat.cols = responseCols;
			const data = new Float32Array(responseRows * responseCols);
			for (const peak of peaks) data[peak.y * responseCols + peak.x] = peak.score;
			mat.data32F = data;
		},
		resize: (_source: unknown, destination: unknown, size: unknown) => {
			const mat = destination as FakeMat;
			const { width, height } = size as FakeSize;
			mat.cols = width;
			mat.rows = height;
			mat.data = new Uint8Array(width * height);
		}
	} as unknown as BasketCv;
}

const RASTER = { gray: new Uint8Array(400 * 400), widthPx: 400, heightPx: 400, sourceScale: 1 };
const TEMPLATE = { gray: new Uint8Array(27 * 41), widthPx: 27, heightPx: 41 };

describe('detectBasketTemplateCandidates', () => {
	it('uses the 11x11 local-max window and the 0.96 bottom-stem anchor', () => {
		const cv = fakeCv([
			{ x: 10, y: 10, score: 0.9 },
			{ x: 15, y: 10, score: 0.8 }
		]);
		const candidates = detectBasketTemplateCandidates(cv, RASTER, TEMPLATE, { uiScalePx: 1 });

		expect(candidates).toHaveLength(1);
		expect(candidates[0].score).toBeCloseTo(0.9, 5);
		expect(candidates[0].xPx).toBeCloseTo(10 + candidates[0].widthPx / 2, 5);
		expect(candidates[0].yPx).toBeCloseTo(10 + 0.96 * candidates[0].heightPx, 5);
	});

	it('fuses the same physical peak across scale samples and keeps distant peaks', () => {
		const cv = fakeCv([
			{ x: 10, y: 10, score: 0.9 },
			{ x: 200, y: 200, score: 0.8 }
		]);
		const candidates = detectBasketTemplateCandidates(cv, RASTER, TEMPLATE, { uiScalePx: 1 });

		expect(candidates).toHaveLength(2);
		expect(candidates[0].score).toBeCloseTo(0.9, 5);
		expect(candidates[1].score).toBeCloseTo(0.8, 5);
	});

	it('honors score, map-band, and candidate-count bounds', () => {
		const cv = fakeCv([
			{ x: 10, y: 10, score: 0.9 },
			{ x: 200, y: 10, score: 0.8 },
			{ x: 10, y: 200, score: 0.3 }
		]);
		const candidates = detectBasketTemplateCandidates(cv, RASTER, TEMPLATE, {
			uiScalePx: 1,
			mapBoundsPx: { topPx: 0, bottomPx: 100 },
			maxCandidates: 1
		});
		expect(candidates).toHaveLength(1);
		expect(candidates[0].score).toBeCloseTo(0.9, 5);
	});

	it('accepts an explicit bounded scale list for the browser fallback', () => {
		let matchCount = 0;
		const cv = fakeCv([]);
		const original = cv.matchTemplate;
		cv.matchTemplate = ((...args: Parameters<NonNullable<typeof original>>) => {
			matchCount += 1;
			original(...args);
		}) as typeof cv.matchTemplate;
		detectBasketTemplateCandidates(cv, RASTER, TEMPLATE, {
			uiScalePx: 1,
			templateScales: [0.65, 0.8, 0.95, 1.1, 1.3]
		});
		expect(matchCount).toBe(5);
	});
});

	describe('findBasketAnchorScale', () => {
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
				const mat = destination as FakeMat;
				const { width, height } = size as FakeSize;
				mat.cols = width;
				mat.rows = height;
				mat.data = new Uint8Array(width * height);
				lastResizedWidth = width;
			},
			matchTemplate: (_image: unknown, _template: unknown, result: unknown) => {
				const mat = result as FakeMat;
				mat.rows = 2;
				mat.cols = 2;
				const impliedScale = lastResizedWidth / templateWidthPx;
				mat.data32F = new Float32Array(4).fill(Math.max(0, 1 - Math.abs(impliedScale - targetScale) * 2));
			},
			minMaxLoc: (source: unknown) => {
				const data = (source as FakeMat).data32F!;
				return { minVal: 0, maxVal: Math.max(...data), minLoc: { x: 0, y: 0 }, maxLoc: { x: 0, y: 0 } };
			}
		} as unknown as BasketCv;
	}

	it('finds the basket scale with the CLI-only blind sweep', () => {
		const anchor = findBasketAnchorScale(fakeCvWithScorePeakAt(2, TEMPLATE.widthPx), RASTER, TEMPLATE, {
			scaleRangeLow: 0.4,
			scaleRangeHigh: 4,
			scaleStep: 0.1
		});
		expect(anchor).not.toBeNull();
		expect(anchor!.scale).toBeCloseTo(2, 1);
		expect(anchor!.score).toBeGreaterThan(0.9);
	});

	it('rejects an invalid sweep range', () => {
		expect(() => findBasketAnchorScale(fakeCvWithScorePeakAt(1, TEMPLATE.widthPx), RASTER, TEMPLATE, {
			scaleRangeLow: 2,
			scaleRangeHigh: 1
	})).toThrow(/scaleRangeHigh/);
	});
});
