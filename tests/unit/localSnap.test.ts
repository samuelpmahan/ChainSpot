import { describe, expect, it } from 'vitest';
import {
	localFeatureSnap,
	LOCAL_SNAP_CROP_FEATURE_MULTIPLE,
	LOCAL_SNAP_RADIUS_FEATURE_MULTIPLE,
	LOCAL_SNAP_MAX_ABSOLUTE_RADIUS_PX,
	LOCAL_SNAP_MIN_SCORE,
	TEE_PAD_MAX_FOOTPRINT_UI_SCALE_MULTIPLE
} from '../../src/lib/cv/localSnap';
import type { LocalSnapCalibration, LocalSnapCv, LocalSnapRaster } from '../../src/lib/cv/localSnap';
import { asBasketTemplateScale, asUiScalePx } from '../../src/lib/autoAnnotation/cvCalibration';
import type { TeePadCv } from '../../src/lib/autoAnnotation/teePadDetection';
import type { BasketCv } from '../../src/lib/autoAnnotation/basketTemplateDetection';

/**
 * A minimal fake tee-pad `cv`: the first `findContours` call (the
 * gray-center pass, which runs first in `detectTeePadCandidates`) reports one
 * synthetic rectangular contour at a caller-chosen crop-local center; the
 * second call (the edge-loop pass) reports none, so the fused result is
 * exactly that one gray-center candidate. This isolates `localFeatureSnap`'s
 * own crop/offset/threshold/radius logic from OpenCV's real contour-finding,
 * the same separation `basketTemplateDetection.test.ts`'s `fakeCv` makes for
 * `matchTemplate`.
 */
function fakeTeeCv(
	localCenter: { x: number; y: number },
	size: { width: number; height: number },
	area: number
): TeePadCv {
	class FakeMat {
		rows: number;
		cols: number;
		data: Uint8Array;
		data32S?: Int32Array;
		constructor(rows = 0, cols = 0) {
			this.rows = rows;
			this.cols = cols;
			this.data = new Uint8Array(Math.max(0, rows * cols));
		}
		delete(): void {}
	}
	class FakeMatVector {
		private items: FakeMat[] = [];
		push(item: FakeMat): void {
			this.items.push(item);
		}
		size(): number {
			return this.items.length;
		}
		get(index: number): FakeMat {
			return this.items[index];
		}
		delete(): void {}
	}
	class FakeSize {
		constructor(
			public readonly width: number,
			public readonly height: number
		) {}
	}
	const contour = new FakeMat(1, 1);
	let findContoursCalls = 0;
	return {
		Mat: FakeMat as unknown as TeePadCv['Mat'],
		MatVector: FakeMatVector as unknown as TeePadCv['MatVector'],
		Size: FakeSize as unknown as TeePadCv['Size'],
		CV_8UC1: 0,
		RETR_LIST: 0,
		CHAIN_APPROX_SIMPLE: 0,
		BORDER_DEFAULT: 0,
		GaussianBlur: () => {},
		Canny: () => {},
		findContours: (_source: unknown, contours: unknown) => {
			findContoursCalls += 1;
			if (findContoursCalls === 1) (contours as FakeMatVector).push(contour);
		},
		contourArea: () => area,
		arcLength: () => 0,
		approxPolyDP: (_curve: unknown, approximation: unknown) => {
			(approximation as FakeMat).rows = 4;
		},
		minAreaRect: () => ({
			center: { x: localCenter.x, y: localCenter.y },
			size,
			angle: 0
		}),
		HoughLinesP: () => {}
	} as unknown as TeePadCv;
}

/**
 * The same fake basket `cv` `basketTemplateDetection.test.ts` uses:
 * `matchTemplate` ignores real pixels and stamps caller-chosen peaks into
 * every scale pass's response map; `resize` honestly reports the requested
 * destination size (which is what determines a peak's template-relative
 * center offset).
 */
function fakeBasketCv(
	peaks: readonly { x: number; y: number; score: number }[],
	responseRows: number,
	responseCols: number
): BasketCv {
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

const UI_SCALE_PX = asUiScalePx(1);
const TEE_FOOTPRINT_PX = TEE_PAD_MAX_FOOTPRINT_UI_SCALE_MULTIPLE * UI_SCALE_PX; // 26
const TEE_CROP_SIDE_PX = TEE_FOOTPRINT_PX * LOCAL_SNAP_CROP_FEATURE_MULTIPLE; // 104
const TEE_SNAP_RADIUS_PX = TEE_FOOTPRINT_PX * LOCAL_SNAP_RADIUS_FEATURE_MULTIPLE; // 13

function teeRaster(widthPx = 400, heightPx = 400): LocalSnapRaster {
	return { rgba: new Uint8Array(widthPx * heightPx * 4), widthPx, heightPx, sourceScale: 1 };
}

const TEE_CALIBRATION: LocalSnapCalibration = { uiScalePx: UI_SCALE_PX };
/** A rectangle that clears every one of `detectGrayCenterCandidates`'s own geometry gates (area/size/aspect/rectangularity) at `scale = 1`. */
const TEE_PASSING_RECT = { size: { width: 16, height: 9 }, area: 130 };

describe('localFeatureSnap — tee', () => {
	it('snaps a tee placement to a nearby detected pad center, within the snap radius', () => {
		const raster = teeRaster();
		const clickPx = { xPx: 200, yPx: 200 };
		// Crop origin for this click is (148,148) (click - half the 104px crop,
		// symmetric since the click is far from every raster edge). A pad
		// centered 8px off the click in the raster, well inside the 52px radius.
		const cv = fakeTeeCv({ x: 56, y: 56 }, TEE_PASSING_RECT.size, TEE_PASSING_RECT.area);

		const result = localFeatureSnap('tee', cv as unknown as LocalSnapCv, raster, clickPx, TEE_CALIBRATION);

		expect(result).not.toBeNull();
		expect(result).toEqual({ xPx: 204, yPx: 204 });
		expect(Math.hypot(result!.xPx - clickPx.xPx, result!.yPx - clickPx.yPx)).toBeLessThanOrEqual(
			TEE_SNAP_RADIUS_PX
		);
	});

	it('offsets the snapped coordinate by the (possibly edge-clamped) crop origin correctly', () => {
		const raster = teeRaster();
		// Click near the raster's right edge: the crop clamps against
		// `widthPx - 1` on that side, so the origin is NOT simply
		// `click - halfCrop` -- exercising the clamped-origin arithmetic.
		const clickPx = { xPx: 390, yPx: 200 };
		const cv = fakeTeeCv({ x: 40, y: 56 }, TEE_PASSING_RECT.size, TEE_PASSING_RECT.area);

		const result = localFeatureSnap('tee', cv as unknown as LocalSnapCv, raster, clickPx, TEE_CALIBRATION);

		// x0 = floor(390 - 52) = 338 (not clamped: 338 >= 0); origin.x = 338.
		// y0 = floor(200 - 52) = 148, unaffected by the x-edge.
		expect(result).toEqual({ xPx: 338 + 40, yPx: 148 + 56 });
	});

	it('returns null when the best candidate falls outside the snap radius', () => {
		const raster = teeRaster();
		const clickPx = { xPx: 200, yPx: 200 };
		// Crop is 105x105 (148..252 on each axis); a candidate near its far
		// corner is well inside the crop but outside the tiny 13px snap radius.
		const cv = fakeTeeCv({ x: 100, y: 100 }, TEE_PASSING_RECT.size, TEE_PASSING_RECT.area);

		const result = localFeatureSnap('tee', cv as unknown as LocalSnapCv, raster, clickPx, TEE_CALIBRATION);

		expect(result).toBeNull();
	});

	it('returns null on an empty crop (click far outside the raster)', () => {
		const raster = teeRaster(10, 10);
		const clickPx = { xPx: 5000, yPx: 5000 };
		let called = false;
		const cv = new Proxy(fakeTeeCv({ x: 0, y: 0 }, TEE_PASSING_RECT.size, TEE_PASSING_RECT.area), {
			get(target, prop, receiver) {
				called = true;
				return Reflect.get(target, prop, receiver);
			}
		});

		const result = localFeatureSnap('tee', cv as unknown as LocalSnapCv, raster, clickPx, TEE_CALIBRATION);

		expect(result).toBeNull();
		// The crop bounds are rejected before any detector call is made.
		expect(called).toBe(false);
	});

	it('returns null (never throws) when the raster has no rgba channel', () => {
		const raster: LocalSnapRaster = { widthPx: 400, heightPx: 400, sourceScale: 1 };
		const clickPx = { xPx: 200, yPx: 200 };
		const cv = fakeTeeCv({ x: 56, y: 56 }, TEE_PASSING_RECT.size, TEE_PASSING_RECT.area);

		expect(() =>
			localFeatureSnap('tee', cv as unknown as LocalSnapCv, raster, clickPx, TEE_CALIBRATION)
		).not.toThrow();
		expect(localFeatureSnap('tee', cv as unknown as LocalSnapCv, raster, clickPx, TEE_CALIBRATION)).toBeNull();
	});

	describe('absolute radius cap (real-capture uiScalePx can make the footprint-relative radius huge)', () => {
		// A real higher-resolution capture legitimately produces a uiScalePx > 1.
		// At uiScalePx=3 the footprint-relative radius alone would be
		// 26*3*0.5 = 39px -- this block proves LOCAL_SNAP_MAX_ABSOLUTE_RADIUS_PX
		// (24px) governs instead, matching the feature's actual product intent
		// (a small correction of the user's own click, not a long-range
		// re-detection). The candidate rectangle is scaled up 3x linearly / 9x
		// in area from TEE_PASSING_RECT to keep clearing detectGrayCenterCandidates'
		// own scale-proportional geometry gates at this uiScalePx, isolating the
		// radius cap as the only thing under test.
		const HIGH_UI_SCALE_PX = asUiScalePx(3);
		const HIGH_SCALE_CALIBRATION: LocalSnapCalibration = { uiScalePx: HIGH_UI_SCALE_PX };
		const HIGH_SCALE_FOOTPRINT_PX = TEE_PAD_MAX_FOOTPRINT_UI_SCALE_MULTIPLE * HIGH_UI_SCALE_PX; // 78
		const HIGH_SCALE_CROP_SIDE_PX = HIGH_SCALE_FOOTPRINT_PX * LOCAL_SNAP_CROP_FEATURE_MULTIPLE; // 312
		const HIGH_SCALE_FOOTPRINT_RADIUS_PX = HIGH_SCALE_FOOTPRINT_PX * LOCAL_SNAP_RADIUS_FEATURE_MULTIPLE; // 39
		const SCALED_PASSING_RECT = { size: { width: 48, height: 27 }, area: 1170 };

		it('sanity: the footprint-relative radius really would exceed the absolute cap at this scale', () => {
			expect(HIGH_SCALE_FOOTPRINT_RADIUS_PX).toBeGreaterThan(LOCAL_SNAP_MAX_ABSOLUTE_RADIUS_PX);
		});

		it('rejects a candidate inside the footprint-relative radius but outside the absolute cap', () => {
			const raster = teeRaster(1000, 1000);
			const clickPx = { xPx: 500, yPx: 500 };
			// 30px from the click: inside the 39px footprint-relative radius,
			// but past the 24px absolute cap.
			const cropHalfPx = HIGH_SCALE_CROP_SIDE_PX / 2;
			const originXPx = Math.floor(clickPx.xPx - cropHalfPx);
			const originYPx = Math.floor(clickPx.yPx - cropHalfPx);
			const localCenter = { x: clickPx.xPx + 30 - originXPx, y: clickPx.yPx - originYPx };
			const cv = fakeTeeCv(localCenter, SCALED_PASSING_RECT.size, SCALED_PASSING_RECT.area);

			const result = localFeatureSnap('tee', cv as unknown as LocalSnapCv, raster, clickPx, HIGH_SCALE_CALIBRATION);

			expect(result).toBeNull();
		});

		it('still accepts a candidate inside the absolute cap at the same elevated uiScalePx', () => {
			const raster = teeRaster(1000, 1000);
			const clickPx = { xPx: 500, yPx: 500 };
			// 15px from the click: inside both the footprint-relative radius and
			// the 24px absolute cap.
			const cropHalfPx = HIGH_SCALE_CROP_SIDE_PX / 2;
			const originXPx = Math.floor(clickPx.xPx - cropHalfPx);
			const originYPx = Math.floor(clickPx.yPx - cropHalfPx);
			const localCenter = { x: clickPx.xPx + 15 - originXPx, y: clickPx.yPx - originYPx };
			const cv = fakeTeeCv(localCenter, SCALED_PASSING_RECT.size, SCALED_PASSING_RECT.area);

			const result = localFeatureSnap('tee', cv as unknown as LocalSnapCv, raster, clickPx, HIGH_SCALE_CALIBRATION);

			expect(result).not.toBeNull();
			expect(Math.hypot(result!.xPx - clickPx.xPx, result!.yPx - clickPx.yPx)).toBeLessThanOrEqual(
				LOCAL_SNAP_MAX_ABSOLUTE_RADIUS_PX
			);
		});
	});
});

const TEMPLATE = { gray: new Uint8Array(27 * 41), widthPx: 27, heightPx: 41 };
const BASKET_TEMPLATE_SCALE = asBasketTemplateScale(1);
const BASKET_FOOTPRINT_PX = Math.max(TEMPLATE.widthPx, TEMPLATE.heightPx) * BASKET_TEMPLATE_SCALE; // 41
const BASKET_CROP_SIDE_PX = BASKET_FOOTPRINT_PX * LOCAL_SNAP_CROP_FEATURE_MULTIPLE; // 164
const BASKET_SNAP_RADIUS_PX = BASKET_FOOTPRINT_PX * LOCAL_SNAP_RADIUS_FEATURE_MULTIPLE; // 20.5
// `scaleSamples`'s lowest sample is `templateScale * 0.9`; NMS/sort ties keep
// the first-inserted (lowest-scale) hit, so this is the resized template size
// that actually determines a peak's candidate center in every scenario below.
const LOWEST_SAMPLE_TEMPLATE_WIDTH = Math.round(TEMPLATE.widthPx * 0.9); // 24
const LOWEST_SAMPLE_TEMPLATE_HEIGHT = Math.round(TEMPLATE.heightPx * 0.9); // 37

function basketRaster(widthPx = 400, heightPx = 400): LocalSnapRaster {
	return { gray: new Uint8Array(widthPx * heightPx), widthPx, heightPx, sourceScale: 1 };
}

const BASKET_CALIBRATION: LocalSnapCalibration = {
	uiScalePx: UI_SCALE_PX,
	basket: { template: TEMPLATE, templateScale: BASKET_TEMPLATE_SCALE }
};

describe('localFeatureSnap — basket', () => {
	it('snaps a basket placement to a nearby high-confidence match', () => {
		const raster = basketRaster();
		const clickPx = { xPx: 200, yPx: 200 };
		// Crop origin (118,118); a peak whose center lands ~exactly on the click.
		const localCenterX = 82;
		const localCenterY = 82;
		const peakX = localCenterX - LOWEST_SAMPLE_TEMPLATE_WIDTH / 2;
		const peakY = Math.round(localCenterY - 0.96 * LOWEST_SAMPLE_TEMPLATE_HEIGHT);
		const cv = fakeBasketCv([{ x: peakX, y: peakY, score: 0.9 }], 165, 165);

		const result = localFeatureSnap('basket', cv as unknown as LocalSnapCv, raster, clickPx, BASKET_CALIBRATION);

		expect(result).not.toBeNull();
		expect(Math.hypot(result!.xPx - clickPx.xPx, result!.yPx - clickPx.yPx)).toBeLessThanOrEqual(
			BASKET_SNAP_RADIUS_PX
		);
	});

	it('offsets the snapped coordinate back to source-image pixels correctly', () => {
		const raster = basketRaster();
		const clickPx = { xPx: 200, yPx: 200 };
		const originXPx = 118; // floor(200 - 82)
		const originYPx = 118;
		const peakX = 70;
		const peakY = 46;
		const cv = fakeBasketCv([{ x: peakX, y: peakY, score: 0.9 }], 165, 165);

		const result = localFeatureSnap('basket', cv as unknown as LocalSnapCv, raster, clickPx, BASKET_CALIBRATION);

		expect(result).toEqual({
			xPx: originXPx + peakX + LOWEST_SAMPLE_TEMPLATE_WIDTH / 2,
			yPx: originYPx + peakY + 0.96 * LOWEST_SAMPLE_TEMPLATE_HEIGHT
		});
	});

	it('rejects a candidate below the confidence floor even when it is right at the click', () => {
		const raster = basketRaster();
		const clickPx = { xPx: 200, yPx: 200 };
		const peakX = 82 - LOWEST_SAMPLE_TEMPLATE_WIDTH / 2;
		const peakY = Math.round(82 - 0.96 * LOWEST_SAMPLE_TEMPLATE_HEIGHT);
		const belowFloor = LOCAL_SNAP_MIN_SCORE - 0.1;
		const cv = fakeBasketCv([{ x: peakX, y: peakY, score: belowFloor }], 165, 165);

		const result = localFeatureSnap('basket', cv as unknown as LocalSnapCv, raster, clickPx, BASKET_CALIBRATION);

		expect(result).toBeNull();
	});

	it('rejects a high-confidence candidate that lies outside the snap radius', () => {
		const raster = basketRaster();
		const clickPx = { xPx: 200, yPx: 200 };
		// Near the crop's far corner: well inside the 165x165 crop, but its
		// distance from the click exceeds the tiny 20.5px snap radius.
		const peakX = 138;
		const peakY = 114;
		const cv = fakeBasketCv([{ x: peakX, y: peakY, score: 0.95 }], 165, 165);

		const result = localFeatureSnap('basket', cv as unknown as LocalSnapCv, raster, clickPx, BASKET_CALIBRATION);

		expect(result).toBeNull();
	});

	it('returns null on an empty crop without ever calling the detector', () => {
		const raster = basketRaster(10, 10);
		const clickPx = { xPx: 5000, yPx: 5000 };
		let called = false;
		const cv = new Proxy(fakeBasketCv([], 1, 1), {
			get(target, prop, receiver) {
				called = true;
				return Reflect.get(target, prop, receiver);
			}
		});

		const result = localFeatureSnap('basket', cv as unknown as LocalSnapCv, raster, clickPx, BASKET_CALIBRATION);

		expect(result).toBeNull();
		expect(called).toBe(false);
	});

	it('returns null (never throws) when no basket calibration/template is supplied', () => {
		const raster = basketRaster();
		const clickPx = { xPx: 200, yPx: 200 };
		const cv = fakeBasketCv([{ x: 70, y: 46, score: 0.95 }], 165, 165);

		expect(() =>
			localFeatureSnap('basket', cv as unknown as LocalSnapCv, raster, clickPx, { uiScalePx: UI_SCALE_PX })
		).not.toThrow();
		expect(
			localFeatureSnap('basket', cv as unknown as LocalSnapCv, raster, clickPx, { uiScalePx: UI_SCALE_PX })
		).toBeNull();
	});
});
