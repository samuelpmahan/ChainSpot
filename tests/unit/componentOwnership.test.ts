import { describe, expect, test } from 'vitest';
import {
	assembleTeeV1,
	materializeComponentAssembly
} from '@chainspot/alg/detectors/threeFactor/componentAssembly';
import type { ComponentStats } from '@chainspot/alg/detectors/threeFactor/components';

function component(label: number, x: number, y: number, w: number, h: number): ComponentStats {
	return {
		label,
		cx: x + (w - 1) / 2,
		cy: y + (h - 1) / 2,
		area: w * h,
		bboxX: x,
		bboxY: y,
		bboxW: w,
		bboxH: h,
		major: Math.max(w, h),
		minor: Math.min(w, h),
		angle: 0,
		fill: 1
	};
}

describe('materialized component ownership', () => {
	test('stores exact owned pixels, perimeter pixels, and bbox on the acquired object', () => {
		const width = 8;
		const height = 6;
		const topPx = 10;
		const brightLabels = new Int32Array(width * height);
		// 3x2 component at local x=2..4, y=1..2 => original y=11..12.
		for (let y = 1; y <= 2; y++) {
			for (let x = 2; x <= 4; x++) brightLabels[y * width + x] = 7;
		}
		const outer = component(7, 2, 1, 3, 2);
		const plan = assembleTeeV1(outer, topPx);
		const acquired = materializeComponentAssembly(plan, {
			width,
			height,
			topPx,
			brightLabels,
			darkLabels: new Int32Array(width * height)
		});
		expect(acquired.bbox).toEqual([2, 11, 3, 2]);
		expect([...acquired.ownedPixels]).toEqual([
			11 * width + 2,
			11 * width + 3,
			11 * width + 4,
			12 * width + 2,
			12 * width + 3,
			12 * width + 4
		]);
		// Every pixel of a 3x2 rectangle is on its boundary.
		expect([...acquired.perimeterPixels]).toEqual([...acquired.ownedPixels]);
	});
});
