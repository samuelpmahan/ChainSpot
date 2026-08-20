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
import { addShot, reorderShot } from './holeAnnotation';
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

export interface CleanImageBounds {
	readonly widthPx: number;
	readonly heightPx: number;
}

/** Human-readable review validation; ProjectEditor remains the final domain guard. */
export function proposalCoordinateError(
	point: SourcePoint,
	bounds: CleanImageBounds
): string | null {
	if (!Number.isFinite(point.xPx) || !Number.isFinite(point.yPx)) {
		return 'Enter finite X and Y coordinates before accepting this throw.';
	}
	if (
		point.xPx < 0 ||
		point.yPx < 0 ||
		point.xPx >= bounds.widthPx ||
		point.yPx >= bounds.heightPx
	) {
		return `Landing must stay inside the clean course (${bounds.widthPx} × ${bounds.heightPx}px).`;
	}
	return null;
}

/** Converts the one-based review control into a zero-based insertion index. */
export function proposalInsertionIndex(
	explicitOneBasedOrder: number | null,
	currentAuthoritativeShotCount: number
): number {
	if (explicitOneBasedOrder === null) return currentAuthoritativeShotCount;
	return explicitOneBasedOrder - 1;
}

/** Removes only session-tracked detector accepts; ordinary manual shots survive. */
export function discardShotsById(
	holes: readonly AnnotatedHole[],
	shotIds: ReadonlySet<string>
): AnnotatedHole[] {
	return holes.map((hole) => ({
		...hole,
		shots: hole.shots.filter((shot) => !shotIds.has(shot.id))
	}));
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
	maxDistance: number | undefined
): AnnotatedHole | null {
	let best: AnnotatedHole | null = null;
	let bestDistance = Number.POSITIVE_INFINITY;
	for (const hole of holes) {
		const distance = distanceToHole(point, hole);
		const allowedDistance = maxDistance ?? hole.corridorWidthPx / 2;
		if (distance <= allowedDistance && distance < bestDistance) {
			best = hole;
			bestDistance = distance;
		}
	}
	return best;
}

/** Converts detector output into review-only proposals. */
export function createPlayedRoundProposals(
	candidates: readonly LandingMarkerCandidate[],
	registration: UsablePlayedRoundRegistration,
	holes: readonly AnnotatedHole[],
	options: PlayedRoundProposalOptions = {}
): PlayedRoundProposal[] {
	return candidates.map((candidate, index) => {
		const cleanPoint = applyTransform({ xPx: candidate.xPx, yPx: candidate.yPx }, registration.playedToClean);
		const suggestedHole = suggestHole(cleanPoint, holes, options.maxSuggestionDistancePx);
		return {
			// Detector order is not chronology, but it is deterministic for the same
			// result. The ordinal prevents distinct or duplicate candidates from
			// colliding after the readable coordinates are rounded for the ID.
			id: `landing-${candidate.kind}-${candidate.xPx.toFixed(3)}-${candidate.yPx.toFixed(3)}-${index}`,
			kind: 'landing',
			playedPoint: acceptCandidate(candidate),
			cleanPoint: acceptCandidate(cleanPoint),
			suggestedHoleId: suggestedHole?.id ?? null,
			// The detector sees pixels, not time. Ordering is established explicitly
			// during review instead of inventing chronology from scan order.
			suggestedOrder: null,
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
	createId: CreateId,
	toIndex?: number
): AnnotatedHole[] {
	const shotId = createId();
	const accepted = addShot(holes, holeId, acceptCandidate(proposal.cleanPoint), () => shotId);
	return toIndex === undefined ? accepted : reorderShot(accepted, holeId, shotId, toIndex);
}

/** Explicit type guard for callers that need to reject malformed review input. */
export function isUsablePlayedRoundRegistration(
	registration: UsablePlayedRoundRegistration | null
): registration is UsablePlayedRoundRegistration {
	if (!registration) return false;
	const coefficients = registration.playedToClean.coefficients;
	return (
		Boolean(registration.cleanImageId.trim()) &&
		Boolean(registration.source.fileName.trim()) &&
		registration.source.blob instanceof Blob &&
		registration.playedToClean.isInvertible &&
		Number.isFinite(registration.playedToClean.determinant) &&
		Math.abs(registration.playedToClean.determinant) > Number.EPSILON &&
		coefficients.every(Number.isFinite)
	);
}

/** Useful for fixture tests and diagnostics without leaking review evidence. */
export function acceptedLanding(proposal: PlayedRoundProposal): SourcePoint {
	return acceptCandidate(proposal.cleanPoint);
}
