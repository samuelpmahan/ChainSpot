import type { SerializableTransform } from './alignment/types';
import type { SourcePoint } from './domain/project';
import type { ThrownRoundSource } from './session';
import type { LandingMarkerKind } from './autoAnnotation/landingDropletDetection';

/**
 * The narrow Gate 1 -> Gate 2 boundary.
 *
 * `playedToClean` always maps original played-round image pixels into the
 * existing clean UDisc source image's original pixels. It never maps directly
 * to the satellite/target image; Create Graphics composes that separately with
 * its existing clean-source -> target registration.
 */
export interface UsablePlayedRoundRegistration {
	readonly source: ThrownRoundSource;
	readonly cleanImageId: string;
	readonly playedToClean: SerializableTransform;
}

/** Detector evidence remains review-only and is stripped at acceptance. */
export interface PlayedRoundProposalEvidence {
	readonly detector: 'landing-droplet-v1';
	readonly markerKind: LandingMarkerKind;
	/** Template-overlap score, not a calibrated probability. */
	readonly glyphScore: number;
}

/**
 * One correctable observation expressed in both evidence and production
 * coordinate spaces. Suggested assignment/order are proposals, never truth.
 */
export interface PlayedRoundProposal {
	readonly id: string;
	readonly kind: 'landing';
	readonly playedPoint: SourcePoint;
	readonly cleanPoint: SourcePoint;
	readonly suggestedHoleId: string | null;
	readonly suggestedOrder: number | null;
	readonly evidence: PlayedRoundProposalEvidence;
}
