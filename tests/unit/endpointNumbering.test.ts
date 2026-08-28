import { describe, expect, test } from 'vitest';
import type { HoleLabeledAssignment } from '@chainspot/alg/exec';
import type { RunTrace } from '@chainspot/alg/detectors/threeFactor/features/types';
import { endpointNumberLabels } from '../../scripts/chainspot-lab/sweep/endpointNumbering';

function trace(units: RunTrace['units']): RunTrace {
	return { units } as RunTrace;
}

function row(hole: number, teeId: string, basketId: string): HoleLabeledAssignment {
	return { hole, teeId, basketId } as HoleLabeledAssignment;
}

describe('Sweep endpoint numbering', () => {
	test('numbers selected tee and basket by hole, never detector ordinal', () => {
		const run = trace([
			{
				id: 'teeFamily',
				drawables: [{
					type: 'polyline', verdict: 'accepted', visualRole: 'tee-border', ref: 'tee-12',
					path: [[10, 10], [20, 10], [20, 20], [10, 20], [10, 10]]
				}]
			},
			{
				id: 'baskets',
				drawables: [{
					type: 'point', verdict: 'info', ref: 'basket-3:semantic-tip', xPx: 100, yPx: 80
				}]
			}
		] as RunTrace['units']);

		const labels = endpointNumberLabels(run, [row(5, 'tee-12', 'basket-3')]);
		expect(labels.map((label) => label.text)).toEqual(['T5', 'B5']);
		expect(labels.map((label) => label.endpointId)).toEqual(['tee-12', 'basket-3']);
		expect(labels.some((label) => label.text === 'T12' || label.text === 'B3')).toBe(false);
	});

	test('numbers a recovered tee from the final recovered-tee id ordering', () => {
		const run = trace([
			{
				id: 'teeRecovery',
				drawables: [{
					type: 'pixelSet', verdict: 'accepted', visualRole: 'tee-shard', pixels: [[1, 1]],
					values: { localizedCenterXPx: 45, localizedCenterYPx: 60 }
				}]
			},
			{
				id: 'baskets',
				drawables: [{
					type: 'point', verdict: 'info', ref: 'basket-9:semantic-tip', xPx: 90, yPx: 90
				}]
			}
		] as RunTrace['units']);

		const labels = endpointNumberLabels(run, [row(5, 'tee-recovered-0', 'basket-9')]);
		expect(labels).toEqual([
			expect.objectContaining({ text: 'T5', endpointId: 'tee-recovered-0', xPx: 45, yPx: 60 }),
			expect.objectContaining({ text: 'B5', endpointId: 'basket-9', xPx: 90, yPx: 90 })
		]);
	});
});
