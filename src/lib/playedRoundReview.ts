/**
 * Narrow CHSPT-35 seam between the landing detector and round annotation.
 *
 * Detector candidates are proposals only. This module maps their played-image
 * tips through the supplied played->clean registration, suggests a hole from
 * existing tee/basket/corridor geometry, and provides the review-to-domain
 * boundary. Evidence stops at that boundary; accepted shots are ordinary
 * OrderedShot values in AnnotatedHole.shots.
 */
import { applyTransform } from './alignment/transform';
import { deriveCorridorCenterline } from './corridor';
import type { AnnotatedHole, SourcePoint } from './domain/annotatedRound';
import { addShot, reorderShot, reassignShot, moveShot } from './holeAnnotation';
import type { CreateId } from './holeAnnotation';
import { acceptCandidate } from './cv/types';
import type { LandingMarkerCandidate } from './autoAnnotation/landingDropletDetection';
import type {
	PlayedRoundProposal,
	UsablePlayedRoundRegistration
} from './playedRoundContract';

export interface PlayedRoundProposalOptions {
	/** Maximum clean-image distance from a hole centerline for a suggestion. */
	readonly maxSuggestionDistancePx?: number;
}

function distanceToSegment(point: SourcePoint, start: SourcePoint, end: SourcePoint): number {
	const dx = end.xPx - start.xPx;
	const dy = end.yPx - start.yPx;
	const lengthSq = dx * dx + dy * dy;
	if (lengthSq === 0) return Math.hypot(point.xPx - start.xPx, point.yPx - start.yPx);
	const t = Math.max(0, Math.min(1, ((point.xPx - start.xPx) * dx + (point.yPx - start.yPx) * dy) / lengthSq));
	return Math.hypot(point.xPx - (start.xPx + t * dx), point.yPx - (start.yPx + t * dy));
}

function distanceToHole(point: SourcePoint, hole: AnnotatedHole): number {
	const centerline = deriveCorridorCenterline(hole);
	if (centerline.length === 0) return Number.POSITIVE_INFINITY;
	if (centerline.length === 1) return Math.hypot(point.xPx - centerline[0].xPx, point.yPx - centerline[0].yPx);
	let distance = Number.POSITIVE_INFINITY;
	for (let index = 1; index < centerline.length; index += 1) {
		distance = Math.min(distance, distanceToSegment(point, centerline[index - 1], centerline[index]));
	}
	return distance;
}

function suggestHole(
	point: SourcePoint,
	holes: readonly AnnotatedHole[],
	maxDistance: number
): AnnotatedHole | null {
	let best: AnnotatedHole | null = null;
	let bestDistance = Number.POSITIVE_INFINITY;
	for (const hole of holes) {
		const distance = distanceToHole(point, hole);
		if (distance < bestDistance) {
			best = hole;
			bestDistance = distance;
		}
	}
	return best && bestDistance <= maxDistance ? best : null;
}

/** Converts detector output into review-only proposals. */
export function createPlayedRoundProposals(
	candidates: readonly LandingMarkerCandidate[],
	registration: UsablePlayedRoundRegistration,
	holes: readonly AnnotatedHole[],
	options: PlayedRoundProposalOptions = {}
): PlayedRoundProposal[] {
	const maxDistance = options.maxSuggestionDistancePx ?? Number.POSITIVE_INFINITY;
	const suggestedCounts = new Map<string, number>();
	return candidates.map((candidate, index) => {
		const cleanPoint = applyTransform({ xPx: candidate.xPx, yPx: candidate.yPx }, registration.playedToClean);
		const suggestedHole = suggestHole(cleanPoint, holes, maxDistance);
		const count = suggestedHole ? (suggestedCounts.get(suggestedHole.id) ?? suggestedHole.shots.length) + 1 : 0;
		if (suggestedHole) suggestedCounts.set(suggestedHole.id, count);
		return {
			id: `landing-${index + 1}`,
			kind: 'landing',
			playedPoint: acceptCandidate(candidate),
			cleanPoint: acceptCandidate(cleanPoint),
			suggestedHoleId: suggestedHole?.id ?? null,
			suggestedOrder: suggestedHole ? count : null,
			evidence: {
				detector: 'landing-droplet-v1',
				markerKind: candidate.kind,
				glyphScore: candidate.glyphConfidence
			}
		};
	});
}

/** Accepts one reviewed proposal into authoritative round state. */
export function acceptPlayedRoundProposal(
	holes: readonly AnnotatedHole[],
	proposal: PlayedRoundProposal,
	holeId: string,
	createId: CreateId
): AnnotatedHole[] {
	return addShot(holes, holeId, acceptCandidate(proposal.cleanPoint), createId);
}

/** Review reducers re-exported at this seam for route-local UI state. */
export { moveShot, reorderShot, reassignShot };

/** Explicit type guard for callers that need to reject malformed review input. */
export function isUsablePlayedRoundRegistration(
	registration: UsablePlayedRoundRegistration | null
): registration is UsablePlayedRoundRegistration {
	if (!registration) return false;
	const coefficients = registration.playedToClean.coefficients;
	return Boolean(registration.cleanImageId) && coefficients.every(Number.isFinite);
}

/** Useful for fixture tests and diagnostics without leaking review evidence. */
export function acceptedLanding(proposal: PlayedRoundProposal): SourcePoint {
	return acceptCandidate(proposal.cleanPoint);
}
