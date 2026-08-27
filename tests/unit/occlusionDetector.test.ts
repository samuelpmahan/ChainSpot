import { describe, expect, test } from 'vitest';
import {
	parseConfig,
	resolveConfig,
	DEFAULT_EXECUTION
} from '@chainspot/alg/detectors/threeFactor';
import { createTraceContext } from '@chainspot/alg/detectors/threeFactor/engine';
import { OcclusionDetector } from '@chainspot/alg/detectors/threeFactor/occlusion';
import defaultConfigJson from '@chainspot/alg/detectors/threeFactor/configs/default.json';

describe('run-scoped OcclusionDetector', () => {
	test('OPAQUE wins over ALPHA while ALPHA remains distinct vocabulary', () => {
		const detector = new OcclusionDetector();
		detector.registerAlpha({ kindAt: () => 'ALPHA' });
		detector.registerOpaque({ kindAt: (x) => (x === 4 ? 'OPAQUE' : 'UNKNOWN') });
		expect(detector.kindAt(4, 7)).toBe('OPAQUE');
		expect(detector.kindAt(5, 7)).toBe('ALPHA');
	});

	test('separate trace runs receive fresh services', () => {
		const resolved = resolveConfig(parseConfig(defaultConfigJson), DEFAULT_EXECUTION);
		const first = createTraceContext(resolved, 'first');
		const second = createTraceContext(resolved, 'second');
		first.ctx.occlusion.registerOpaque({ kindAt: () => 'OPAQUE' });
		expect(first.ctx.occlusion.kindAt(1, 1)).toBe('OPAQUE');
		expect(first.ctx.occlusion).not.toBe(second.ctx.occlusion);
		expect(second.ctx.occlusion.kindAt(1, 1)).toBe('UNKNOWN');
	});
});
