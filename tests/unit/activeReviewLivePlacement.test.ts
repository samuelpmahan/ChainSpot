import { describe, expect, it } from 'vitest';
import {
	buildActiveReviewMap,
	exhaustedLandmarkKey,
	livePlacementsFromGrammar,
	recommendNextAnchor
} from '../../src/lib/autoAnnotation/activeReview';
import { asBasketTemplateScale, asNumberTemplateScale } from '../../src/lib/autoAnnotation/cvCalibration';
import type { CourseDetectionResult } from '../../src/lib/autoAnnotation/basketDetection';
import type { CourseHoleProposal } from '../../src/lib/autoAnnotation/courseGrammar';

/**
 * Reproduces the "premature exhaustion" bug: a course where every hole's
 * tee/basket assignment is weak (`status: 'review'`, uncontested by any
 * other hole) but never actually placed in the live draft. Before the fix,
 * `buildActiveReviewMap` computed `missing` from the frozen proposal's own
 * tee/basket presence, so these holes were never `missing` and, being
 * uncontested, never scored by `recommendNextAnchor`'s main loop either --
 * the guided queue would report "nothing left" while both holes sat
 * completely unresolved. Both landmark kinds get a real (if weak) candidate
 * here so the fixture isn't accidentally caught by the pre-existing
 * "zero candidates anywhere" orphaned-hole path instead of the bug this is
 * meant to isolate.
 */
function weakUncontestedFixture(): CourseDetectionResult {
	const holeProposal = (number: number, teeIndex: number, teeX: number, basketIndex: number, basketX: number): CourseHoleProposal => ({
		number,
		tee: { candidateIndex: teeIndex, xPx: teeX, yPx: 100, detectorConfidence: 0.6, confidence: 0.45, distancePx: 40 },
		basket: {
			candidateIndex: basketIndex,
			xPx: basketX,
			yPx: 100,
			detectorConfidence: 0.6,
			confidence: 0.45,
			distancePx: 40,
			polarityCosine: -1,
			cost: 40
		},
		confidence: 0.45,
		status: 'review',
		failures: [
			{ kind: 'weak-tee-confidence', severity: 'warning', holeNumber: number, candidateKind: 'tee', message: 'weak' },
			{ kind: 'weak-basket-confidence', severity: 'warning', holeNumber: number, candidateKind: 'basket', message: 'weak' }
		]
	});

	return {
		numberDetection: {
			candidates: [],
			anchor: { label: 1, score: 0.92, scale: asNumberTemplateScale(1), xPx: 40, yPx: 40, widthPx: 20, heightPx: 14 },
			labeling: 'assigned'
		},
		tees: [
			{ xPx: 60, yPx: 100, widthPx: 20, heightPx: 12, orientationDeg: 0, score: 0.6, support: [] },
			{ xPx: 340, yPx: 100, widthPx: 20, heightPx: 12, orientationDeg: 0, score: 0.6, support: [] }
		],
		baskets: [
			{ xPx: 20, yPx: 100, widthPx: 16, heightPx: 16, score: 0.6, scale: asBasketTemplateScale(1) },
			{ xPx: 380, yPx: 100, widthPx: 16, heightPx: 16, score: 0.6, scale: asBasketTemplateScale(1) }
		],
		grammar: {
			holes: [holeProposal(1, 0, 60, 0, 20), holeProposal(2, 1, 340, 1, 380)],
			failures: [],
			unassigned: { numberBadgeCandidateIndexes: [], teeCandidateIndexes: [], basketCandidateIndexes: [] }
		}
	};
}

describe('active review live-placement (premature exhaustion fix)', () => {
	it('keeps surfacing a weak, uncontested hole while nothing has actually been placed for it', () => {
		const detection = weakUncontestedFixture();
		// Neither hole has anything in the live draft -- both are genuinely
		// unresolved, matching the diagnostics rail's own "N holes need review"
		// definition, even though each already has a weak detected proposal.
		const map = buildActiveReviewMap(detection, new Map());
		const recommendation = recommendNextAnchor(map);
		expect(recommendation.kind).toBe('candidate');
		if (recommendation.kind === 'candidate') {
			expect([1, 2]).toContain(recommendation.holeNumber);
			expect(recommendation.rationale.missingTee).toBe(true);
		}
	});

	it('stops surfacing a landmark once it is actually live-placed, even if the original proposal was weak, while its still-unplaced sibling keeps surfacing', () => {
		const detection = weakUncontestedFixture();
		// Hole 1's tee is live-placed; its basket is not.
		const map = buildActiveReviewMap(detection, new Map([[1, { tee: true, basket: false }]]));
		const recommendation = recommendNextAnchor(map);
		expect(recommendation.kind).toBe('candidate');
		if (recommendation.kind === 'candidate') {
			// Hole 1's tee must never be offered again now that it's placed --
			// only its still-missing basket (or hole 2, entirely unplaced) can win.
			expect(recommendation).not.toMatchObject({ holeNumber: 1, candidateKind: 'tee' });
		}
	});

	it('stops proposing a candidate for an exhausted hole/kind and routes it to "needs manual placement" instead, while its sibling keeps getting real suggestions', () => {
		const detection = weakUncontestedFixture();
		// Hole 1's tee has been guessed wrong twice already; nothing else on
		// this fixture is exhausted.
		const exhausted = new Set([exhaustedLandmarkKey(1, 'tee')]);
		const map = buildActiveReviewMap(detection, new Map(), [], exhausted);

		const hole1 = map.holes.find((hole) => hole.number === 1);
		expect(hole1?.associations.some((association) => association.kind === 'tee')).toBe(false);
		expect(hole1?.associations.some((association) => association.kind === 'basket')).toBe(true);

		const recommendation = recommendNextAnchor(map);
		// The exhausted hole's tee must never be recommended again -- either
		// something else (hole 1's basket, or hole 2) wins, or the queue
		// explicitly asks for hole 1's tee to be placed manually.
		expect(recommendation).not.toMatchObject({ kind: 'candidate', holeNumber: 1, candidateKind: 'tee' });
	});

	it('livePlacementsFromGrammar (no live session) reproduces the pre-fix behavior for a fresh CLI preview', () => {
		// The CLI has no live annotation session at all -- treating the
		// detection's own proposals as "placed" is the correct, faithful
		// preview of a freshly-detected, unreviewed course, and intentionally
		// leaves weak-but-uncontested holes unflagged exactly as before.
		const detection = weakUncontestedFixture();
		const map = buildActiveReviewMap(detection, livePlacementsFromGrammar(detection));
		const recommendation = recommendNextAnchor(map);
		expect(recommendation.kind).toBe('none');
	});
});
