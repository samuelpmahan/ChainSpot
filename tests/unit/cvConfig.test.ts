import { describe, expect, it } from 'vitest';
import { CV_PARAM_SCHEMA, DEFAULT_CV_CONFIG } from '../../src/lib/autoAnnotation/cvConfig';
import { MIN_RIBBON_IMPROVEMENT_PX, P6_FORWARD_GATE_ANGLE_DEG } from '../../src/lib/autoAnnotation/p6LowParBasketAssignment';

function readPath(root: unknown, path: string): unknown {
	return path.split('.').reduce<unknown>((node, key) => {
		if (node === null || typeof node !== 'object') return undefined;
		return (node as Record<string, unknown>)[key];
	}, root);
}

describe('DEFAULT_CV_CONFIG', () => {
	it('matches the pre-existing hidden P6 constants exactly', () => {
		expect(DEFAULT_CV_CONFIG.p6.forwardGateAngleDeg).toBe(P6_FORWARD_GATE_ANGLE_DEG);
		expect(DEFAULT_CV_CONFIG.p6.swap.minRibbonImprovementPx).toBe(MIN_RIBBON_IMPROVEMENT_PX);
		expect(DEFAULT_CV_CONFIG.p6.swap.enabled).toBe(true);
	});

	it('has today\'s exact production values', () => {
		expect(DEFAULT_CV_CONFIG.p6.forwardGateAngleDeg).toBe(80);
		expect(DEFAULT_CV_CONFIG.p6.swap.minRibbonImprovementPx).toBe(20);
	});

	it('is deep-frozen', () => {
		expect(Object.isFrozen(DEFAULT_CV_CONFIG)).toBe(true);
		expect(Object.isFrozen(DEFAULT_CV_CONFIG.p6)).toBe(true);
		expect(Object.isFrozen(DEFAULT_CV_CONFIG.p6.swap)).toBe(true);
	});

	it('rejects mutation attempts (strict mode: assignment to a frozen property throws)', () => {
		expect(() => {
			(DEFAULT_CV_CONFIG.p6.swap as { enabled: boolean }).enabled = false;
		}).toThrow();
	});

	it('has reserved, empty P1-P5 config objects', () => {
		for (const key of ['p1', 'p2', 'p3', 'p4', 'p5'] as const) {
			expect(DEFAULT_CV_CONFIG[key]).toEqual({});
		}
	});
});

describe('CV_PARAM_SCHEMA', () => {
	it('is non-empty and covers the minimum required paths', () => {
		const paths = CV_PARAM_SCHEMA.map((spec) => spec.path);
		expect(paths).toContain('p6.swap.enabled');
		expect(paths).toContain('p6.swap.minRibbonImprovementPx');
		expect(paths).toContain('p6.forwardGateAngleDeg');
	});

	it('every entry\'s path resolves to a real leaf in DEFAULT_CV_CONFIG whose value matches `default`', () => {
		for (const spec of CV_PARAM_SCHEMA) {
			const actual = readPath(DEFAULT_CV_CONFIG, spec.path);
			expect(actual, `path ${spec.path} should resolve in DEFAULT_CV_CONFIG`).not.toBeUndefined();
			expect(actual).toBe(spec.default);
		}
	});

	it('the minRibbonImprovementPx spec has the documented bounds', () => {
		const spec = CV_PARAM_SCHEMA.find((s) => s.path === 'p6.swap.minRibbonImprovementPx');
		expect(spec?.type).toBe('number');
		if (spec?.type === 'number') {
			expect(spec.min).toBe(0);
			expect(spec.max).toBe(200);
			expect(spec.step).toBe(5);
		}
	});

	it('the forwardGateAngleDeg spec has the documented bounds', () => {
		const spec = CV_PARAM_SCHEMA.find((s) => s.path === 'p6.forwardGateAngleDeg');
		expect(spec?.type).toBe('number');
		if (spec?.type === 'number') {
			expect(spec.min).toBe(0);
			expect(spec.max).toBe(180);
			expect(spec.step).toBe(5);
		}
	});

	it('does not expose a "zero-bend shortcut" P6 lever', () => {
		expect(CV_PARAM_SCHEMA.some((spec) => /zero.?bend/i.test(spec.path) || /zero.?bend/i.test(spec.label))).toBe(false);
	});
});
