// Shared Straight Test (S0) receipt seam.
//
// This file deliberately contains only data contracts. It is the boundary
// between the geometry producer and the trace/CLI/VisualRender consumers:
// neither consumer may recreate an angle, projection, candidate, or verdict.
// All coordinates are source-image pixels in the canonical execution frame.

export const STRAIGHT_TEST_FEATURE_ID = 'straightTest' as const;
export const STRAIGHT_TEST_COORDINATE_FRAME = 'original-image-px' as const;

export type StraightTestVerdict = 'PROVISIONAL' | 'ABSTAIN';
export type StraightTestGateStatus = 'PASS' | 'FAIL' | 'UNKNOWN';
export type StraightTestTruthMode = 'blind' | 'verified-canonical';

/** Endpoint coordinates supplied by a verified canonical annotation in the
 * explicit comparison run. They are a separate, loudly-tainted geometry
 * input: they never replace detector evidence, alpha-composited pixels, or
 * values on the shared evidence board. */
export interface StraightTestCanonicalEndpoint {
	readonly xPx: number;
	readonly yPx: number;
	readonly provenance: 'canonical-annotation-tee' | 'canonical-annotation-basket';
}

/** Whether a lock names an already-detected endpoint or an annotation-only
 * endpoint. The latter is permitted solely so the explicit comparison can
 * cover holes whose G3 tee is absent; it is never materialized on the
 * detector evidence board. */
export type StraightTestEndpointReference = 'detector' | 'canonical-annotation';

/** A canonical annotation may lock the detector IDs and retain its verified
 * tee/basket coordinates only in the explicit comparison run. The feature
 * may use these coordinates for its own tainted S0 geometry, but must never
 * write them back as detector/raster evidence or downstream ownership input. */
export interface StraightTestTruthLock {
	readonly holeNumber: number;
	readonly badgeId: string;
	readonly teeId: string;
	readonly basketId: string;
	readonly teeReference: StraightTestEndpointReference;
	readonly basketReference: StraightTestEndpointReference;
	readonly canonicalTee: StraightTestCanonicalEndpoint;
	readonly canonicalBasket: StraightTestCanonicalEndpoint;
	readonly provenance: 'canonical-annotation-endpoint-lock';
}

/** Always seeded. `verified-canonical` is issued only after the existing
 * canonical truth-match firewall accepts the supplied annotation. */
export interface StraightTestTruthAssistance {
	readonly mode: StraightTestTruthMode;
	readonly locks: readonly StraightTestTruthLock[];
	/** Present only in the explicit comparison run; it must be printed verbatim. */
	readonly taint?: 'TRUTH-TAINT';
	/** Existing truth-match/firewall decision, not a new classifier. */
	readonly provenance?: string;
}

export interface StraightTestEndpointProvenance {
	readonly badge: string;
	readonly tee: string;
	readonly basket: string;
}

/** The exact endpoints used to make the recorded S0 geometry. VisualRender
 * receives these values from the reviewed trace and must not derive them
 * again. In assisted mode only tee/basket are canonical-annotation values;
 * badge evidence always remains detector-derived. */
export interface StraightTestGeometryEndpoints {
	readonly badge: {
		readonly xPx: number;
		readonly yPx: number;
		readonly provenance: string;
	};
	readonly tee: {
		readonly xPx: number;
		readonly yPx: number;
		readonly provenance: string;
		/** Exact detector-emitted tee axis. `null` is a loud absence; a
		 * renderer must never substitute the tee→badge direction. */
		readonly axisAngleRad: number | null;
	};
	readonly basket: {
		readonly xPx: number;
		readonly yPx: number;
		readonly provenance: string;
	};
}

/** Minimal pure-input shape. The feature maps detector evidence into this
 * shape before measuring; exposing it lets tests prove equations without an
 * image, board, truth file, or renderer. */
export interface StraightTestCandidateInput {
	readonly holeLabel: string | null;
	readonly badge: {
		readonly detId: string;
		readonly xPx: number;
		readonly yPx: number;
		readonly label: string | null;
		readonly provenance: string;
	};
	readonly tee: {
		readonly detId: string;
		readonly xPx: number;
		readonly yPx: number;
		readonly tier: string;
		readonly angleRad: number | null;
		readonly provenance: string;
	} | null;
	readonly basket: {
		readonly detId: string;
		readonly xPx: number;
		readonly yPx: number;
		readonly strongIdentity: boolean;
		readonly provenance: string;
	} | null;
}

/** Exact geometry measurements. `null` means UNKNOWN because evidence was
 * missing; it never means zero. Degrees are source-image-pixel geometry
 * angles, while dPerpPx is a source-image-pixel distance. */
export interface StraightTestMeasurements {
	readonly f: number | null;
	readonly dPerpPx: number | null;
	readonly axialResidualDeg: number | null;
	readonly directionalResidualDeg: number | null;
	readonly collinearityResidualDeg: number | null;
}

export interface StraightTestGateStatuses {
	readonly identifiedBadge: StraightTestGateStatus;
	readonly strongBasketIdentity: StraightTestGateStatus;
	readonly semanticStrongRingTee: StraightTestGateStatus;
	readonly teeAxisToBadgeAgreement: StraightTestGateStatus;
	readonly badgeLongitudinalFraction: StraightTestGateStatus;
	readonly teeBadgeBasketCollinearity: StraightTestGateStatus;
	readonly oneToOneUniqueness: StraightTestGateStatus;
}

/** One receipt row per identified hole/badge. In blind mode tee/basket and
 * every dependent measurement may be UNKNOWN instead of silently choosing a
 * likely-looking candidate. */
export interface StraightTestProposal {
	readonly proposalId: string;
	readonly holeLabel: string | null;
	readonly badgeId: string;
	/** Count of category-valid endpoint combinations considered before any
	 * uniqueness decision. It is evidence of ambiguity, never a score or
	 * an implicit first-candidate selection. */
	readonly candidateCount: number;
	readonly teeId: string | null;
	readonly basketId: string | null;
	readonly endpointProvenance: StraightTestEndpointProvenance;
	readonly geometryEndpoints: StraightTestGeometryEndpoints | null;
	readonly coordinateFrame: typeof STRAIGHT_TEST_COORDINATE_FRAME;
	readonly verdict: StraightTestVerdict;
	readonly selected: boolean;
	readonly runnerUpProposalId: string | null;
	readonly measurements: StraightTestMeasurements;
	readonly gates: StraightTestGateStatuses;
	readonly reasons: readonly string[];
	readonly truthTainted: boolean;
}

/** The reviewed, renderer-ready S0 payload. Corresponding geometry lives in
 * the same UnitTrace as detector-emitted drawables keyed by `proposalId`; a
 * renderer may select those drawables but may not calculate replacements. */
export interface StraightTestTrace {
	readonly featureId: typeof STRAIGHT_TEST_FEATURE_ID;
	readonly coordinateFrame: typeof STRAIGHT_TEST_COORDINATE_FRAME;
	readonly truthAssistance: StraightTestTruthAssistance;
	readonly proposals: readonly StraightTestProposal[];
}
