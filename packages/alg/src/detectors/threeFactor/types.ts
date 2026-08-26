import type { ComponentStats } from './components';
import type { Mask } from './raster';

export const THREE_FACTOR_ALGO = '3factor-dev72';
export const THREE_FACTOR_ALGO_VERSION = '1.0.0';

export interface RgbaImage {
	readonly width: number;
	readonly height: number;
	readonly data: Uint8Array | Uint8ClampedArray;
}

export interface Viewport {
	readonly topPx: number;
	readonly bottomPx: number;
	readonly sourceFrame: 'original-image';
}

export interface CorridorParams {
	readonly corridorWidthPx: number;
	readonly fieldScale: number;
	readonly orientations: number;
	readonly widthsSrc: readonly number[];
	readonly patchBadges: boolean;
	readonly alignmentPower: number;
	readonly worstWindowSrcPx: number;
	readonly supportTau: number;
	readonly zfit?: boolean;
}

export interface ThreeFactorParams {
	readonly viewport?: { topPx: number; bottomPx: number };
	readonly courseKey?: string;
	readonly corridorWidthPx?: number;
	readonly fieldScale?: number;
	readonly orientations?: number;
	readonly widthsSrc?: readonly number[];
	readonly patchBadges?: boolean;
	readonly alignmentPower?: number;
	readonly worstWindowSrcPx?: number;
	readonly supportTau?: number;
	readonly zfit?: boolean;
}

export interface DigitEvidence {
	readonly bbox: readonly [number, number, number, number];
	readonly method: 'cc' | 'valley-split';
	readonly predicted: string;
	readonly runnerUp: string;
	readonly scores: readonly number[];
	readonly margin: number;
	readonly normalized: Uint8Array;
}

export interface BadgeEvidence {
	readonly detId: string;
	readonly component: ComponentStats;
	readonly cxPx: number;
	readonly cyPx: number;
	readonly bbox: readonly [number, number, number, number];
	readonly plateBbox?: readonly [number, number, number, number];
	readonly source: 'bright-family' | 'dark-plate-recovery';
	readonly digits: readonly DigitEvidence[];
	readonly label: string | null;
	readonly labelCandidates: readonly { label: number; confidence: number }[];
	readonly confidence: number;
}

export interface BasketEvidence {
	readonly detId: string;
	/** Full rendered basket footprint, including the dark shell around the
	 * bright body. This is the semantic object box downstream consumers use. */
	readonly bbox: readonly [number, number, number, number];
	/** Tight connected-component bounds of the white/bright detector body.
	 * Detection-local geometry only; never substitute this for `bbox`. */
	readonly whiteBbox: readonly [number, number, number, number];
	readonly centerXPx: number;
	readonly centerYPx: number;
	readonly tipXPx: number;
	readonly tipYPx: number;
	readonly onFrac: number;
	readonly offFrac: number;
	readonly score: number;
	readonly tier?: 'clean-family' | 'occlusion-recovery';
	readonly confidence?: 'high' | 'medium' | 'low';
	readonly identity?: number;
	readonly effectiveVisibility?: number;
	readonly whiteCoverage?: number;
	readonly blackBorderSupport?: number;
	readonly darkCoherence?: number;
	readonly source?: string;
}

export type TeeTier = 'ring' | 'component' | 'recovered';

export interface RecoveryProvenance {
	readonly source: 'manual' | 'historical-fixture' | 'explicit-injected';
	readonly note: string;
	readonly score?: number;
}

export type OrientedQuad = readonly [
	readonly [number, number],
	readonly [number, number],
	readonly [number, number],
	readonly [number, number]
];

/** Full visible tee-pad geometry promoted from the enclosing bright-mask
 * component. The hollow interior remains separately available as
 * `TeeEvidence.ring`; none of the component measurements are discarded. */
export interface TeePadEvidence {
	readonly source: 'bright-mask-component';
	readonly componentLabel: number;
	readonly bbox: readonly [number, number, number, number];
	readonly componentCentroidXPx: number;
	readonly componentCentroidYPx: number;
	readonly centerXPx: number;
	readonly centerYPx: number;
	readonly angleRad: number;
	readonly majorPx: number;
	readonly minorPx: number;
	readonly area: number;
	readonly fill: number;
	readonly axisMajorMin: number;
	readonly axisMajorMax: number;
	readonly axisMinorMin: number;
	readonly axisMinorMax: number;
	readonly orientedCorners: OrientedQuad;
}

export interface TeeEvidence {
	readonly detId: string;
	readonly xPx: number;
	readonly yPx: number;
	readonly tier: TeeTier;
	readonly angleRad: number | null;
	readonly ring?: {
		readonly bbox: readonly [number, number, number, number];
		readonly area: number;
		readonly elongation: number;
		readonly ringFrac: number;
	};
	/** Full visible pad AABB after intact-family promotion. Before that phase,
	 * this is candidate-local geometry; `ring.bbox` remains the hollow
	 * detector's tight interior box either way. */
	readonly bbox: readonly [number, number, number, number];
	/** Present when G3 found the enclosing visible pad component. Carries the
	 * component-derived orientation and exact quadrilateral used by renderers. */
	readonly pad?: TeePadEvidence;
	readonly area: number;
	readonly fill: number;
	readonly onRing: boolean;
	readonly recovery?: RecoveryProvenance;
}

export interface SupportFieldEvidence {
	readonly width: number;
	readonly height: number;
	readonly scale: number;
	readonly support: Float32Array;
	readonly bestTheta: Float32Array;
	readonly parameters: {
		readonly orientations: number;
		readonly widthsSrc: readonly number[];
		readonly gaussianSigma: number;
		readonly normalizationPercentile: number;
		readonly gamma: number;
	};
}

export interface LegEvidence {
	readonly endpointId: string;
	readonly geodesic: number;
	readonly path: readonly [number, number][];
	readonly reachable: boolean;
}

export interface RawPairEvidence {
	readonly pairId: string;
	readonly badgeId: string;
	readonly teeId: string;
	readonly basketId: string;
	readonly teeLeg: LegEvidence;
	readonly basketLeg: LegEvidence;
	readonly supportMean: number;
	readonly supportMin: number;
	readonly supportedFraction: number;
	readonly worstWindowMean: number;
	readonly weakSpanCount: number;
	readonly weakSpanLongestPx: number;
	readonly pathLengthPx: number;
	readonly straightDistancePx: number;
	readonly efficiency: number;
	readonly endpointSupportTee: number;
	readonly endpointSupportBasket: number;
	readonly failureReason: string | null;
}

export interface PairFactorBreakdown {
	readonly alignment: number;
	readonly zone: number;
	readonly simplePath: number;
	readonly teeOrientation: number;
	readonly badgeFraction: number;
	readonly collinearity: number;
	readonly basketIdentity: number;
	readonly recoveredPrior: number;
	readonly zfit: number;
}

export interface ScoredPairEvidence {
	readonly raw: RawPairEvidence;
	readonly score: number;
	readonly rank: number;
	readonly factors: PairFactorBreakdown;
}

export interface RecoveredTeeInput {
	readonly xPx: number;
	readonly yPx: number;
	readonly bbox?: readonly [number, number, number, number];
	readonly area?: number;
	readonly fill?: number;
	readonly score?: number;
	readonly provenance: RecoveryProvenance;
}

export interface ThreeFactorMeasurement {
	readonly algo: typeof THREE_FACTOR_ALGO;
	readonly algoVersion: typeof THREE_FACTOR_ALGO_VERSION;
	readonly widthPx: number;
	readonly heightPx: number;
	readonly viewport: Viewport;
	readonly parameters: CorridorParams;
	readonly brightMask: Mask;
	readonly darkMask: Mask;
	readonly badges: readonly BadgeEvidence[];
	readonly baskets: readonly BasketEvidence[];
	readonly tees: readonly TeeEvidence[];
	readonly field: SupportFieldEvidence;
	readonly rawPairs: readonly RawPairEvidence[];
}

export interface AssignmentEvidence {
	readonly badgeId: string;
	readonly teeId: string;
	readonly basketId: string;
	readonly score: number;
	readonly rank: number;
	readonly ownership: 'selected';
	readonly alternatives: readonly { teeId: string; basketId: string; score: number }[];
}

export interface ThreeFactorAssignment {
	readonly measurement: ThreeFactorMeasurement;
	readonly tees: readonly TeeEvidence[];
	readonly scoredPairs: readonly ScoredPairEvidence[];
	readonly assignments: readonly AssignmentEvidence[];
}
