import { describe, expect, it } from 'vitest';
import { score } from '../../src/lib/autoAnnotation/p6AssignmentScoring';
import type { TruthHole } from '../../src/lib/autoAnnotation/p6AssignmentScoring';
import type { RawMaskBasket } from '../../src/lib/autoAnnotation/rawObjectMask';
import type { P6BasketAssignment, P6LowParBasketAssignmentResult } from '../../src/lib/autoAnnotation/p6LowParBasketAssignment';

function basket(xPx: number, yPx: number): Pick<RawMaskBasket, 'centerXPx' | 'centerYPx'> {
	return { centerXPx: xPx, centerYPx: yPx };
}

function assignment(holeNumber: number, assignedBasketIndex: number | null): P6BasketAssignment {
	return {
		holeNumber,
		teeIndex: null,
		p4BasketStatus: 'unresolved',
		p4BasketIndex: null,
		candidateBasketCount: 0,
		candidatesBeforeGate: 0,
		candidatesAfterGate: 0,
		gateFallbackUsed: false,
		assignedBasketIndex,
		assignedForwardAngleDeg: null,
		assignmentReason: assignedBasketIndex === null ? 'noValidAssignment' : 'lowPar',
		lowParScore: null,
		status: assignedBasketIndex === null ? 'unresolved' : 'lowParAssigned'
	};
}

describe('p6AssignmentScoring.score', () => {
	it('counts an assignment within tolerance as correct', () => {
		const p6 = { assignments: [assignment(1, 0)] } as Pick<P6LowParBasketAssignmentResult, 'assignments'>;
		const baskets = [basket(100, 100)];
		const truth: TruthHole[] = [{ number: 1, basket: { xPx: 105, yPx: 100 } }];
		const result = score(p6, baskets, truth, 10);
		expect(result.correct).toBe(1);
		expect(result.incorrect).toEqual([]);
		expect(result.unresolved).toBe(0);
		expect(result.meanErrorPx).toBe(5);
	});

	it('counts an assignment outside tolerance as incorrect, not unresolved', () => {
		const p6 = { assignments: [assignment(1, 0)] } as Pick<P6LowParBasketAssignmentResult, 'assignments'>;
		const baskets = [basket(100, 100)];
		const truth: TruthHole[] = [{ number: 1, basket: { xPx: 200, yPx: 100 } }];
		const result = score(p6, baskets, truth, 10);
		expect(result.correct).toBe(0);
		expect(result.unresolved).toBe(0);
		expect(result.incorrect).toEqual([{ holeNumber: 1, errorPx: 100 }]);
	});

	it('counts a hole with no assignment as unresolved, not incorrect', () => {
		const p6 = { assignments: [assignment(1, null)] } as Pick<P6LowParBasketAssignmentResult, 'assignments'>;
		const truth: TruthHole[] = [{ number: 1, basket: { xPx: 0, yPx: 0 } }];
		const result = score(p6, [], truth, 10);
		expect(result.unresolved).toBe(1);
		expect(result.correct).toBe(0);
		expect(result.incorrect).toEqual([]);
		expect(result.meanErrorPx).toBeNull();
	});

	it('scores multiple holes and averages error over measured holes only', () => {
		const p6 = { assignments: [assignment(1, 0), assignment(2, 1), assignment(3, null)] } as Pick<
			P6LowParBasketAssignmentResult,
			'assignments'
		>;
		const baskets = [basket(0, 0), basket(0, 0)];
		const truth: TruthHole[] = [
			{ number: 1, basket: { xPx: 3, yPx: 4 } }, // errorPx 5
			{ number: 2, basket: { xPx: 6, yPx: 8 } }, // errorPx 10
			{ number: 3, basket: { xPx: 0, yPx: 0 } } // unresolved
		];
		const result = score(p6, baskets, truth, 20);
		expect(result.scoredHoles).toBe(3);
		expect(result.correct).toBe(2);
		expect(result.unresolved).toBe(1);
		expect(result.meanErrorPx).toBeCloseTo(7.5, 5);
	});
});
