import { describe, expect, it } from 'vitest';
import { detectTeePadCandidates } from '../../src/lib/autoAnnotation/teePadDetection';
import type { TeePadCv } from '../../src/lib/autoAnnotation/teePadDetection';

class FakeMat {
	readonly rows: number;
	readonly cols: number;
	readonly data: Uint8Array;
	data32S?: Int32Array;

	constructor(rows = 0, cols = 0) {
		this.rows = rows;
		this.cols = cols;
		this.data = new Uint8Array(Math.max(0, rows * cols));
	}

	delete(): void {}
}

class FakeMatVector {
	private readonly items: FakeMat[] = [];
	size(): number {
		return this.items.length;
	}
	get(index: number): FakeMat {
		return this.items[index];
	}
	delete(): void {}
}

/**
 * findContours always reports zero contours, so gray-center and edge-loop -
 * both of which depend on it - never produce a candidate. This isolates the
 * occluded-edge-loop detector (which uses HoughLinesP instead) as the only
 * source of candidates in `detectTeePadCandidates`'s fused output.
 */
function fakeCvWithNoContours(): TeePadCv {
	return {
		Mat: FakeMat,
		MatVector: FakeMatVector,
		Size: class {
			constructor(readonly width: number, readonly height: number) {}
		},
		CV_8UC1: 0,
		RETR_LIST: 0,
		CHAIN_APPROX_SIMPLE: 0,
		BORDER_DEFAULT: 0,
		GaussianBlur: () => {},
		Canny: () => {},
		findContours: () => {},
		contourArea: () => 0,
		arcLength: () => 0,
		approxPolyDP: () => {},
		minAreaRect: () => ({ center: { x: 0, y: 0 }, size: { width: 0, height: 0 }, angle: 0 }),
		HoughLinesP: (_edges: unknown, lines: FakeMat) => {
			lines.data32S = new Int32Array([20, 20, 38, 20, 20, 26, 38, 26]);
		}
	} as unknown as TeePadCv;
}

describe('detectTeePadCandidates production fusion', () => {
	it('includes occluded-edge-loop recoveries alongside gray-center/edge-loop', () => {
		const cv = fakeCvWithNoContours();
		const raster = {
			rgba: new Uint8Array(80 * 80 * 4).fill(255),
			widthPx: 80,
			heightPx: 80,
			sourceScale: 1
		};

		const candidates = detectTeePadCandidates(cv, raster, { uiScalePx: 1 });

		expect(candidates).toHaveLength(1);
		expect(candidates[0]).toMatchObject({
			xPx: 29,
			yPx: 23,
			support: ['occluded-edge-loop']
		});
	});
});
