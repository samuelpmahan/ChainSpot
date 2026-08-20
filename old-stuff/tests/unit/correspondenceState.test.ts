import { describe, expect, it } from 'vitest';
import {
	activateCorrespondence,
	cancelCorrespondence,
	completeCorrespondence,
	createCorrespondenceState,
	nextPairOrdinal,
	placeCorrespondence
} from '../../src/lib/correspondenceState';

const sourcePlacement = { role: 'source-overview' as const, coordinates: { xPx: 12, yPx: 18 } };
const targetPlacement = { role: 'target-basemap' as const, coordinates: { xPx: 31, yPx: 44 } };

describe('correspondence state machine', () => {
	it('activates only from neutral when adding is available', () => {
		const initial = createCorrespondenceState();
		expect(activateCorrespondence(initial, false, 1)).toBe(initial);
		expect(activateCorrespondence(initial, true, 1)).toEqual({
			mode: 'add-source',
			pendingPlacement: null
		});
	});

	it('accepts either image as the first placement and retains its identity and ordinal', () => {
		const addingSource = activateCorrespondence(createCorrespondenceState(), true, 1);
		const transition = placeCorrespondence(addingSource, sourcePlacement, 'source-1', 1);

		expect(transition.accepted).toBe(true);
		expect(transition.completion).toBeNull();
		expect(transition.state).toEqual({
			mode: 'add-target',
			pendingPlacement: {
				role: 'source-overview',
				imageId: 'source-1',
				coordinates: sourcePlacement.coordinates,
				ordinal: 1
			}
		});
	});

	it('accepts a target placement as the first endpoint', () => {
		const addingSource = activateCorrespondence(createCorrespondenceState(), true, 1);
		const transition = placeCorrespondence(addingSource, targetPlacement, 'target-1', 1);

		expect(transition).toEqual({
			state: {
				mode: 'add-target',
				pendingPlacement: {
					role: 'target-basemap',
					imageId: 'target-1',
					coordinates: targetPlacement.coordinates,
					ordinal: 1
				}
			},
			accepted: true,
			completion: null
		});
	});

	it('does not replace the pending placement when another click uses the same image', () => {
		const addingSource = activateCorrespondence(createCorrespondenceState(), true, 1);
		const awaitingTarget = placeCorrespondence(addingSource, sourcePlacement, 'source-1', 1).state;
		const secondSource = placeCorrespondence(
			awaitingTarget,
			{ role: 'source-overview', coordinates: { xPx: 90, yPx: 91 } },
			'source-1',
			1
		);

		expect(secondSource).toEqual({
			state: awaitingTarget,
			accepted: false,
			completion: null
		});
	});

	it('creates a completion intent without leaving add-target', () => {
		const addingSource = activateCorrespondence(createCorrespondenceState(), true, 1);
		const awaitingTarget = placeCorrespondence(addingSource, sourcePlacement, 'source-1', 1).state;
		const completion = placeCorrespondence(awaitingTarget, targetPlacement, 'target-1', 1);

		expect(completion.accepted).toBe(true);
		expect(completion.state).toBe(awaitingTarget);
		expect(completion.completion).toEqual({
			source: awaitingTarget.pendingPlacement,
			target: {
				role: 'target-basemap',
				imageId: 'target-1',
				coordinates: targetPlacement.coordinates,
				ordinal: 1
			}
		});
	});

	it('maps a target-first completion into source and target endpoints', () => {
		const addingFirst = activateCorrespondence(createCorrespondenceState(), true, 1);
		const awaitingSource = placeCorrespondence(addingFirst, targetPlacement, 'target-1', 1).state;
		const completion = placeCorrespondence(awaitingSource, sourcePlacement, 'source-1', 1);

		expect(completion.accepted).toBe(true);
		expect(completion.completion).toEqual({
			source: {
				role: 'source-overview',
				imageId: 'source-1',
				coordinates: sourcePlacement.coordinates,
				ordinal: 1
			},
			target: awaitingSource.pendingPlacement
		});
	});

	it('returns to neutral only after a separate successful completion event', () => {
		const addingSource = activateCorrespondence(createCorrespondenceState(), true, 1);
		const awaitingTarget = placeCorrespondence(addingSource, sourcePlacement, 'source-1', 1).state;
		const completionIntent = placeCorrespondence(awaitingTarget, targetPlacement, 'target-1', 1);

		expect(completeCorrespondence(completionIntent.state)).toEqual({
			mode: 'neutral',
			pendingPlacement: null
		});
	});

	it('ignores a second placement on the same side', () => {
		const addingSource = activateCorrespondence(createCorrespondenceState(), true, 1);
		const awaitingTarget = placeCorrespondence(addingSource, sourcePlacement, 'source-1', 1).state;

		expect(placeCorrespondence(awaitingTarget, sourcePlacement, 'source-1', 1)).toEqual({
			state: awaitingTarget,
			accepted: false,
			completion: null
		});
	});

	it('cancels from either add state without creating a durable concept', () => {
		const addingSource = activateCorrespondence(createCorrespondenceState(), true, 1);
		const awaitingTarget = placeCorrespondence(addingSource, sourcePlacement, 'source-1', 1).state;

		expect(cancelCorrespondence(addingSource)).toEqual(createCorrespondenceState());
		expect(cancelCorrespondence(awaitingTarget)).toEqual(createCorrespondenceState());
	});

	it('computes the next ordinal from the largest existing ordinal', () => {
		expect(nextPairOrdinal([])).toBe(1);
		expect(nextPairOrdinal([{ ordinal: 2 }, { ordinal: 7 }, { ordinal: 4 }])).toBe(8);
	});
});
