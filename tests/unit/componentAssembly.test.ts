import { describe, expect, test } from 'vitest';
import {
	assembleBadgeV1,
	assembleBasketV1,
	assembleTeeV1,
	learnBasketShellFamilyV1
} from '@chainspot/alg/detectors/threeFactor/componentAssembly';
import type { ComponentStats } from '@chainspot/alg/detectors/threeFactor/components';

function component(label: number, x: number, y: number, w: number, h: number, area = 100): ComponentStats {
	return {
		label,
		cx: x + w / 2,
		cy: y + h / 2,
		area,
		bboxX: x,
		bboxY: y,
		bboxW: w,
		bboxH: h,
		major: Math.max(w, h),
		minor: Math.min(w, h),
		angle: 0,
		fill: area / Math.max(1, w * h)
	};
}

describe('component-backed object assembly V1', () => {
	test('badge owns outer white + contained black plate + contained bright glyph components', () => {
		const outer = component(1, 10, 10, 54, 42, 460);
		const glyph = component(3, 30, 20, 8, 20, 50);
		const assembled = assembleBadgeV1(
			outer,
			[outer, glyph],
			[component(2, 13, 13, 48, 36, 1500)]
		);
		expect(assembled.status).toBe('assembled');
		if (assembled.status !== 'assembled') return;
		expect(assembled.bbox).toEqual([10, 10, 54, 42]);
		expect(assembled.outerComponent).toMatchObject({ polarity: 'bright', label: 1 });
		expect(assembled.components.map((part) => [part.polarity, part.label])).toEqual([
			['bright', 1],
			['dark', 2],
			['bright', 3]
		]);
	});

	test('basket learns intact shell geometry and refuses a fused outer dark component', () => {
		const bodies = [
			component(10, 100, 100, 42, 66, 1746),
			component(11, 200, 200, 42, 66, 1746),
			component(12, 300, 300, 42, 66, 1746)
		];
		const dark = [
			component(20, 98, 97, 46, 72, 399),
			component(21, 198, 197, 46, 72, 399),
			component(22, 298, 297, 60, 120, 700)
		];
		const family = learnBasketShellFamilyV1(bodies, dark);
		expect(family).toEqual([2, 3, 2, 3]);
		if (!family) return;
		expect(assembleBasketV1(bodies[0], dark, family).status).toBe('assembled');
		expect(assembleBasketV1(bodies[2], dark, family)).toMatchObject({ status: 'failed' });
	});

	test('intact tee perimeter is exactly its enclosing bright component', () => {
		const assembled = assembleTeeV1(component(30, 5, 7, 27, 18, 320));
		expect(assembled.bbox).toEqual([5, 7, 27, 18]);
		expect(assembled.components).toHaveLength(1);
		expect(assembled.outerComponent).toMatchObject({ polarity: 'bright', label: 30 });
	});
});
