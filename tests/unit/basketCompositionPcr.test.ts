import { describe, expect, test } from 'vitest';
import { classifyUnsubtractedRings, reconcileEvidence, ticksThrough } from '../../scripts/chainspot-lab/experiments/basketCompositionPcr';

describe('basket Progressive Composition Render contract', () => {
	test('Tick 1 contains only the first cumulative transformation', () => {
		expect(ticksThrough('T1')).toEqual(['T1']);
	});

	test('Tick 2 preserves Tick 1 before adding the second mask', () => {
		expect(ticksThrough('T2')).toEqual(['T1', 'T2']);
	});

	test('Tick 5 composes the complete ordered handoff spine', () => {
		expect(ticksThrough('T5')).toEqual(['T1', 'T2', 'T3', 'T4', 'T5']);
	});

	test('classifies enclosed and exterior-reachable unsubtracted rings separately', () => {
		const composed = new Uint8Array([
			0, 0, 0, 0, 0,
			0, 1, 1, 1, 0,
			0, 1, 0, 1, 0,
			0, 1, 1, 1, 0,
			0, 0, 0, 0, 0
		]);
		const rings = classifyUnsubtractedRings(composed, 5, 5);
		expect(rings.inner[2 * 5 + 2]).toBe(1);
		expect(rings.outer[0 * 5 + 2]).toBe(1);
		expect(rings.inner[0 * 5 + 2]).toBe(0);
	});

	test('fails loudly when a render ignores required evidence', () => {
		expect(reconcileEvidence(['source', 'mask1'], ['source', 'mask1'])).toEqual({
			required: ['source', 'mask1'], consumed: ['mask1', 'source'], unused: []
		});
		expect(() => reconcileEvidence(['source', 'mask1'], ['source'])).toThrow(/mask1/);
	});
});
