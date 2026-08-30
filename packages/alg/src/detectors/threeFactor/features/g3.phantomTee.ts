// Predecessor-basket phantom tee — the first NEW isolated ABFeature file.
// Ported from the LAB's C01 Complete Occlusion fallback
// (origin/codex/seatac-phantom-tee: src/lib/nuthing/phantomTee.ts), adapted
// to threeFactor semantics: ownership is assignment OUTPUT here, so this is
// a second-pass unit — after assignment, a hole whose badge found no viable
// tee gets one synthesized at its predecessor hole's assigned basket tip,
// and assignment re-runs with the recovered inputs. Phantom evidence keeps
// explicit provenance and must never feed an appearance model (appearance
// is UNKNOWN by construction). Default OFF.

import { assignThreeFactor, type SearchKnobs } from '../assignment';
import type { RibbonKnobs } from '../ribbon';
import type { RoutingKnobs } from '../routing';
import type { ScoringKnobs, ZfitKnobs } from '../scoring';
import type {
	AssignmentEvidence,
	BasketEvidence,
	RecoveredTeeInput,
	ThreeFactorAssignment,
	ThreeFactorMeasurement
} from '../types';
import type { ABFeature, EngineUnit } from './types';
import { zfitFeature } from './g5.zfit';
import { g4ScoringFeature } from './g4.scoring';
import { g4SearchFeature } from './g4.search';
import { g5RibbonFeature } from './g5.ribbon';
import { g5RoutingFeature } from './g5.routing';
import { phantomTeeRender } from './g3.teeReceipts';

/** A basket's `tipYPx` is its POLE-TIP GROUND ANCHOR, not its body: the sprite
 * matcher sets `tipY = spriteY + spriteHeight + tipOffset` (see endpoints.ts
 * `tipY`, documented "Pole-tip annotation point"), so it lands BELOW the drawn
 * basket. That is the right anchor for annotating where a basket meets the
 * ground, and the wrong one for a tee: a tee pad beside a basket reads in the
 * basket's UPPER half. Rise by three quarters of the sprite's own height to
 * land there — expressed as a fraction of that height, not a pixel constant,
 * so it survives capture scale. 0.75 puts the point at ~sprite top + h/4.
 * Dataset-fit estimate from the Dev6 rasters, not physics. */
const PHANTOM_TEE_RISE_FROM_BASKET_TIP = 0.75;

/** whiteBbox is [x, y, widthPx, heightPx] (measure.ts). Falls back to no rise
 * rather than guessing when the sprite height is unusable. */
function basketTipRisePx(basket: BasketEvidence): number {
	const heightPx = basket.whiteBbox?.[3];
	return typeof heightPx === 'number' && Number.isFinite(heightPx) && heightPx > 0
		? PHANTOM_TEE_RISE_FROM_BASKET_TIP * heightPx
		: 0;
}

export const phantomTeeFeature = {
	id: 'phantomTee',
	// This consumes completed G4 assignment evidence, so it must not appear in
	// a G3-only sweep prefix even though it synthesizes a tee coordinate.
	gate: 'G4',
	kind: 'deviation',
	defaultEnabled: false,
	note: 'Assignment-completion fallback: synthesize a missing tee at the predecessor hole\'s assigned basket tip.',
	render: phantomTeeRender,
	knobs: {
		minViableScore: {
			default: 0,
			note: 'a hole whose best assignment score is at or below this counts as tee-less',
			validate: (value: unknown) => (typeof value === 'number' ? null : 'minViableScore must be a number')
		},
		maxCompletions: {
			default: 1,
			note: 'owner policy 2026-08-28: phantom completion is a scalpel, not a spray — synthesize at most this many phantom tees per run; holes beyond the budget stay loudly unresolved. A run wanting more phantoms has a detection problem, not a completion problem.',
			validate: (value: unknown) =>
				Number.isInteger(value) && (value as number) >= 1 ? null : 'maxCompletions must be a positive integer'
		}
	}
} satisfies ABFeature;

interface PhantomSynthesis {
	readonly phantoms: readonly RecoveredTeeInput[];
	readonly phantomHoles: readonly number[];
	readonly unresolvedHoles: readonly number[];
}

function finitePoint(xPx: number, yPx: number): boolean {
	return Number.isFinite(xPx) && Number.isFinite(yPx);
}

/**
 * Deterministic last-resort placement. This is deliberately not an image
 * recovery: when the predecessor route does not exist, a numbered badge is
 * still real finite course geometry. Step away from its nearest basket by
 * the observed badge-frame diagonal, so no unexplained pixel constant or
 * dataset-fit percentage manufactures the fallback scale.
 */
function fallbackForBadge(
	hole: number,
	badge: ThreeFactorMeasurement['badges'][number],
	baskets: readonly BasketEvidence[]
): RecoveredTeeInput | null {
	if (!finitePoint(badge.cxPx, badge.cyPx)) return null;
	const nearest = baskets
		.filter((basket) => finitePoint(basket.tipXPx, basket.tipYPx))
		.map((basket) => ({
			basket,
			distance: Math.hypot(badge.cxPx - basket.tipXPx, badge.cyPx - basket.tipYPx)
		}))
		.sort((a, b) => a.distance - b.distance || a.basket.detId.localeCompare(b.basket.detId))[0];
	const badgeDiagonal = Math.hypot(badge.bbox[2], badge.bbox[3]);
	if (!nearest || nearest.distance === 0 || !Number.isFinite(badgeDiagonal) || badgeDiagonal <= 0) return null;
	const distance = badgeDiagonal;
	return {
		xPx: badge.cxPx + ((badge.cxPx - nearest.basket.tipXPx) / nearest.distance) * distance,
		yPx: badge.cyPx + ((badge.cyPx - nearest.basket.tipYPx) / nearest.distance) * distance,
		provenance: {
			source: 'explicit-injected',
			note: `phantom-fallback hole ${hole}: badge frame diagonal ${distance.toFixed(1)}px stepped away from nearest basket ${nearest.basket.detId}; appearance UNKNOWN`,
			score: 0
		}
	};
}

function synthesizePhantomTeeResult(
	measurement: ThreeFactorMeasurement,
	assignments: readonly AssignmentEvidence[],
	minViableScore: number,
	maxCompletions = 1
): PhantomSynthesis {
	const badgeById = new Map(measurement.badges.map((badge) => [badge.detId, badge]));
	const basketById = new Map(measurement.baskets.map((basket) => [basket.detId, basket]));
	const assignmentByHole = new Map<number, AssignmentEvidence>();
	for (const assignment of assignments) {
		const label = badgeById.get(assignment.badgeId)?.label;
		const hole = label === null || label === undefined ? NaN : Number(label);
		if (Number.isInteger(hole)) assignmentByHole.set(hole, assignment);
	}
	const holes = [...assignmentByHole.keys()].sort((a, b) => a - b);
	const missing = new Set<number>();
	for (const badge of measurement.badges) {
		const hole = badge.label === null ? NaN : Number(badge.label);
		if (!Number.isInteger(hole)) continue;
		const assignment = assignmentByHole.get(hole);
		if (!assignment || assignment.score <= minViableScore) missing.add(hole);
	}

	const phantoms: RecoveredTeeInput[] = [];
	const phantomHoles: number[] = [];
	const unresolvedHoles: number[] = [];
	for (const hole of [...missing].sort((a, b) => a - b)) {
		// Owner budget (maxCompletions knob): phantom completion is a scalpel.
		// Holes beyond the budget stay loudly unresolved rather than sprayed.
		if (phantoms.length >= maxCompletions) {
			unresolvedHoles.push(hole);
			continue;
		}
		const badge = measurement.badges.find((candidate) => Number(candidate.label) === hole);
		const predecessor = assignmentByHole.get(hole - 1);
		if (!predecessor || missing.has(hole - 1)) {
			const fallback = badge ? fallbackForBadge(hole, badge, measurement.baskets) : null;
			if (fallback) {
				phantoms.push(fallback);
				phantomHoles.push(hole);
			}
			else unresolvedHoles.push(hole);
			continue;
		}
		const basket: BasketEvidence | undefined = basketById.get(predecessor.basketId);
		if (basket && finitePoint(basket.tipXPx, basket.tipYPx)) {
			phantoms.push({
				xPx: basket.tipXPx,
				yPx: basket.tipYPx - basketTipRisePx(basket),
				provenance: {
					source: 'explicit-injected',
					note: `phantom-predecessor-basket hole ${hole} from B${hole - 1} tip risen ${PHANTOM_TEE_RISE_FROM_BASKET_TIP} of sprite height; appearance UNKNOWN`,
					score: 0.5
				}
			});
			phantomHoles.push(hole);
			continue;
		}
		const fallback = badge ? fallbackForBadge(hole, badge, measurement.baskets) : null;
		if (fallback) {
			phantoms.push(fallback);
			phantomHoles.push(hole);
		}
		else unresolvedHoles.push(hole);
	}
	void holes;
	return { phantoms, phantomHoles, unresolvedHoles };
}

/** Assignment-only completion after normal scoring. A zero-score row says
 * exactly what it is: deterministic UNKNOWN-appearance continuity, never
 * detector evidence. Reuse is allowed here because this is the explicit
 * terminal fallback for imperfect/cropped inputs, not a global optimizer. */
function completePhantomAssignments(
	measurement: ThreeFactorMeasurement,
	assignment: ThreeFactorAssignment,
	synthesis: PhantomSynthesis
): ThreeFactorAssignment {
	const byBadge = new Map(assignment.assignments.map((row) => [row.badgeId, row]));
	const phantomByHole = new Map(synthesis.phantomHoles.map((hole, index) => [hole, synthesis.phantoms[index]]));
	const completed = [...assignment.assignments];
	for (const badge of measurement.badges) {
		const hole = badge.label === null ? NaN : Number(badge.label);
		if (!Number.isInteger(hole) || !finitePoint(badge.cxPx, badge.cyPx) || byBadge.has(badge.detId)) continue;
		const phantom = phantomByHole.get(hole);
		const tee = phantom
			? assignment.tees
				.filter((candidate) => finitePoint(candidate.xPx, candidate.yPx))
				.map((candidate) => ({ candidate, d: Math.hypot(candidate.xPx - phantom.xPx, candidate.yPx - phantom.yPx) }))
				.sort((a, b) => a.d - b.d || a.candidate.detId.localeCompare(b.candidate.detId))[0]?.candidate
			: undefined;
		const basket = measurement.baskets
			.filter((candidate) => finitePoint(candidate.tipXPx, candidate.tipYPx))
			.map((candidate) => ({ candidate, d: Math.hypot(candidate.tipXPx - badge.cxPx, candidate.tipYPx - badge.cyPx) }))
			.sort((a, b) => a.d - b.d || a.candidate.detId.localeCompare(b.candidate.detId))[0]?.candidate;
		if (!tee || !basket) continue;
		const row: AssignmentEvidence = {
			badgeId: badge.detId,
			teeId: tee.detId,
			basketId: basket.detId,
			score: 0,
			rank: 0,
			ownership: 'selected',
			alternatives: []
		};
		completed.push(row);
		byBadge.set(row.badgeId, row);
	}
	return { ...assignment, assignments: completed.sort((a, b) => a.badgeId.localeCompare(b.badgeId)) };
}

/** Pure core, exported for tests: which phantom tees would be synthesized. */
export function synthesizePhantomTees(
	measurement: ThreeFactorMeasurement,
	assignments: readonly AssignmentEvidence[],
	minViableScore: number,
	maxCompletions = 1
): RecoveredTeeInput[] {
	return [...synthesizePhantomTeeResult(measurement, assignments, minViableScore, maxCompletions).phantoms];
}

export const phantomTeeUnit: EngineUnit = {
	id: 'phantomTee',
	gate: 'G4',
	consumes: ['measurement', 'assignment', 'recoveredTees'],
	produces: ['recoveredTees', 'assignment'],
	note: 'synthesize predecessor-basket phantom tees for tee-less holes, then re-assign',
	run(board, ctx) {
		const stop = ctx.span('phantomTee');
		const state = ctx.resolve(phantomTeeFeature);
		if (state.enabled) {
			const measurement = board.get<ThreeFactorMeasurement>('measurement');
			const assignment = board.get<ThreeFactorAssignment>('assignment');
			const existing = board.get<readonly RecoveredTeeInput[]>('recoveredTees');
			const synthesis = synthesizePhantomTeeResult(
				measurement,
				assignment.assignments,
				state.knobs['minViableScore'] as number,
				state.knobs['maxCompletions'] as number
			);
			for (const phantom of synthesis.phantoms) {
				ctx.overlay('phantomTee', {
					type: 'point',
					xPx: phantom.xPx,
					yPx: phantom.yPx,
					verdict: 'accepted',
					ref: `phantom:${phantom.provenance.note}`,
					visualRole: 'phantom-center',
					reason: phantom.provenance.note
				});
			}
			ctx.measure('phantomTee', 'synthesized', synthesis.phantoms.length);
			ctx.measure('phantomTee', 'unresolved', synthesis.unresolvedHoles.length);
			for (const hole of synthesis.unresolvedHoles) ctx.measure('phantomTee', 'unresolvedNoFiniteGeometryHole', hole);
			if (synthesis.phantoms.length > 0) {
				const merged = [...existing, ...synthesis.phantoms];
				const zfit = ctx.resolve(zfitFeature);
				const scoringKnobs = ctx.resolve(g4ScoringFeature).knobs as unknown as ScoringKnobs;
				const searchKnobs = ctx.resolve(g4SearchFeature).knobs as unknown as SearchKnobs;
				const ribbonKnobs = ctx.resolve(g5RibbonFeature).knobs as unknown as RibbonKnobs;
				const routingKnobs = ctx.resolve(g5RoutingFeature).knobs as unknown as RoutingKnobs;
				board.set('recoveredTees', merged);
				const reassigned = assignThreeFactor(
						measurement,
						merged,
						zfit.knobs as unknown as ZfitKnobs,
						scoringKnobs,
						searchKnobs,
						ribbonKnobs,
						routingKnobs
					);
				board.set('assignment', completePhantomAssignments(measurement, reassigned, synthesis));
			}
		}
		stop();
	}
};
