import { describe, expect, it } from 'vitest';
import { createPlayedRoundProposals, acceptPlayedRoundProposal, isUsablePlayedRoundRegistration } from '../../src/lib/playedRoundReview';
import type { LandingMarkerCandidate } from '../../src/lib/autoAnnotation/landingDropletDetection';
import type { AnnotatedHole } from '../../src/lib/domain/annotatedRound';
import type { UsablePlayedRoundRegistration } from '../../src/lib/playedRoundContract';
import { DEFAULT_CORRIDOR_WIDTH_PX } from '../../src/lib/corridor';

const hole = (id: string, number: number, tee: { xPx: number; yPx: number }, basket: { xPx: number; yPx: number }): AnnotatedHole => ({
	id, number, tee, basket, shots: [], corridorBends: [], corridorWidthPx: DEFAULT_CORRIDOR_WIDTH_PX
});

const registration: UsablePlayedRoundRegistration = {
	source: { blob: new Blob(['played']), fileName: 'played.png' },
	cleanImageId: 'clean-1',
	playedToClean: {
		model: 'affine', coefficients: [1, 0, 0, 1, 10, 20], isInvertible: true,
		determinant: 1, orientation: 1, majorAxisScale: 1, minorAxisScale: 1, anisotropy: 1, shear: 0
	}
};

function candidate(xPx: number, yPx: number, kind: LandingMarkerCandidate['kind'] = 'c1'): LandingMarkerCandidate {
	return { xPx, yPx, boundsPx: { xPx, yPx, widthPx: 10, heightPx: 20 }, kind, glyphConfidence: 0.82 };
}

describe('played round proposal seam', () => {
	it('transforms fixture candidates, suggests geometry, and keeps evidence review-only', () => {
		const holes = [hole('h1', 1, { xPx: 0, yPx: 20 }, { xPx: 100, yPx: 20 }), hole('h2', 2, { xPx: 0, yPx: 200 }, { xPx: 100, yPx: 200 })];
		const proposals = createPlayedRoundProposals([candidate(20, 0), candidate(50, 0)], registration, holes);
		expect(proposals.map((proposal) => proposal.cleanPoint)).toEqual([{ xPx: 30, yPx: 20 }, { xPx: 60, yPx: 20 }]);
		expect(proposals.map((proposal) => proposal.suggestedHoleId)).toEqual(['h1', 'h1']);
		expect(proposals.map((proposal) => proposal.suggestedOrder)).toEqual([null, null]);
		expect(proposals[0].evidence).toEqual({ detector: 'landing-droplet-v1', markerKind: 'c1', glyphScore: 0.82 });
	});

	it('uses stable evidence ids and rejects singular registration input', () => {
		const candidates = [candidate(20, 0)];
		const first = createPlayedRoundProposals(candidates, registration, [hole('h1', 1, { xPx: 0, yPx: 20 }, { xPx: 100, yPx: 20 })]);
		const second = createPlayedRoundProposals(candidates, registration, [hole('h1', 1, { xPx: 0, yPx: 20 }, { xPx: 100, yPx: 20 })]);
		expect(first[0].id).toBe(second[0].id);
		expect(isUsablePlayedRoundRegistration(registration)).toBe(true);
		expect(isUsablePlayedRoundRegistration({
			...registration,
			playedToClean: { ...registration.playedToClean, isInvertible: false, determinant: 0 }
		})).toBe(false);
	});

	it('allows wrong assignment correction before acceptance and strips proposal evidence', () => {
		const holes = [hole('h1', 1, { xPx: 0, yPx: 20 }, { xPx: 100, yPx: 20 }), hole('h2', 2, { xPx: 0, yPx: 200 }, { xPx: 100, yPx: 200 })];
		const [proposal] = createPlayedRoundProposals([candidate(20, 0)], registration, holes);
		const accepted = acceptPlayedRoundProposal(holes, proposal, 'h2', () => 'shot-1');
		expect(accepted[1].shots).toEqual([{ id: 'shot-1', landing: { xPx: 30, yPx: 20 } }]);
		expect(Object.keys(accepted[1].shots[0])).toEqual(['id', 'landing']);
	});

	it('returns no assignment when the supplied geometry is outside the review distance', () => {
		const proposals = createPlayedRoundProposals([candidate(20, 0)], registration, [hole('h1', 1, { xPx: 0, yPx: 200 }, { xPx: 100, yPx: 200 })], { maxSuggestionDistancePx: 10 });
		expect(proposals[0].suggestedHoleId).toBeNull();
		expect(proposals[0].suggestedOrder).toBeNull();
	});
});
