import { describe, expect, test } from 'vitest';
import { reconcileEvidence, ticksThrough } from '../../scripts/chainspot-lab/experiments/basketCompositionPcr';

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

	test('fails loudly when a render ignores required evidence', () => {
		expect(reconcileEvidence(['source', 'mask1'], ['source', 'mask1'])).toEqual({
			required: ['source', 'mask1'], consumed: ['mask1', 'source'], unused: []
		});
		expect(() => reconcileEvidence(['source', 'mask1'], ['source'])).toThrow(/mask1/);
	});
});
