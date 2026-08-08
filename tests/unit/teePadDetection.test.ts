import { describe, expect, it } from 'vitest';
import { filterSizeConsistentCandidates } from '../../src/lib/autoAnnotation/teePadDetection';
import type { TeePadCandidate } from '../../src/lib/autoAnnotation/teePadDetection';

function pad(xPx: number, yPx: number, heightPx: number, widthPx = 24): TeePadCandidate {
	return {
		xPx,
		yPx,
		orientationDeg: 0,
		widthPx,
		heightPx,
		score: 0.9,
		support: ['edge-loop']
	};
}

describe('filterSizeConsistentCandidates', () => {
	it('drops candidates about half the width of the rest of the set (C2 dash artifacts)', () => {
		// Real-fixture measurement: true pads cluster around heightPx ~15.5;
		// C2 putting-circle dash segments land around heightPx ~6-8, roughly
		// half that, despite otherwise passing the rectangle/aspect filters.
		const realPads = [
			pad(100, 100, 15.9),
			pad(200, 200, 15.6),
			pad(300, 300, 15.8),
			pad(400, 400, 15.5),
			pad(500, 500, 15.4)
		];
		const c2Dashes = [pad(150, 150, 6.4), pad(250, 250, 6.0), pad(350, 350, 7.8)];

		const filtered = filterSizeConsistentCandidates([...realPads, ...c2Dashes]);

		expect(filtered).toHaveLength(realPads.length);
		expect(filtered.every((candidate) => candidate.heightPx >= 10)).toBe(true);
	});

	it('leaves a too-small sample alone rather than guessing at a typical size', () => {
		const tooFewToJudge = [pad(0, 0, 15.5), pad(10, 10, 6)];
		expect(filterSizeConsistentCandidates(tooFewToJudge)).toHaveLength(2);
	});

	it('keeps consistently-sized candidates untouched', () => {
		const consistent = [pad(0, 0, 15.5), pad(10, 10, 15.4), pad(20, 20, 15.9), pad(30, 30, 15.6)];
		expect(filterSizeConsistentCandidates(consistent)).toHaveLength(4);
	});
});
