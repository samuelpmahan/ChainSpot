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

/** Fix contract C4 (docs/seven-whys/g1-badge-digit-garbage.md): named,
 * machine-readable reasons a badge read is not emitted as a label, mirroring
 * old-stuff's `BadgeGlyphAbstention` plus the two failure modes this contract
 * closes (`too-many-digits`, `leading-zero`) and C5's `collision`. */
export type BadgeAbstentionReason =
	| 'empty-glyph'
	| 'low-score'
	| 'ambiguous'
	| 'too-many-digits'
	| 'leading-zero'
	| 'collision';

export interface BadgeEvidence {
	readonly detId: string;
	readonly component: ComponentStats;
	readonly cxPx: number;
	readonly cyPx: number;
	readonly bbox: readonly [number, number, number, number];
	readonly plateBbox?: readonly [number, number, number, number];
	readonly source: 'bright-family' | 'dark-plate-recovery';
	readonly digits: readonly DigitEvidence[];
	/** Raw concatenated digit predictions before any rejection (C2/C3), e.g.
	 * `"1868"`, `"03"` — preserved for the receipt even when rejected. */
	readonly rawLabel: string;
	/** Segmented digit count before any rejection (receipt `digits` column). */
	readonly digitCount: number;
	/** Final emitted hole label, or `null` when UNREAD/CONFLICT (C2/C3/C5) —
	 * never a guess, never the raw out-of-vocabulary string. */
	readonly label: string | null;
	/** The label the detector WOULD have emitted absent abstention/collision
	 * (old-stuff's `bestLabel`, C4) — retained so the receipt can show what a
	 * rejected read would have said. Null only when no candidate exists at all
	 * (e.g. empty glyph). */
	readonly bestLabel: string | null;
	readonly labelCandidates: readonly { label: number; confidence: number }[];
	/** Classifier margin (Math.min per-digit margin), NOT overloaded with a
	 * geometric fill fraction (C4) — Infinity when there were no digits to
	 * score, in which case see `fillFraction`. */
	readonly confidence: number;
	/** Geometric dark-mask fill fraction for a no-digit dark-plate badge; a
	 * fill ratio and a classifier margin are different quantities and must
	 * not share the `confidence` field (C4). Undefined when digits were
	 * segmented (confidence is a real margin in that case). */
	readonly fillFraction?: number;
	/** Null when the read stands (verdict OK); named reason otherwise (C4). */
	readonly abstentionReason: BadgeAbstentionReason | null;
	/** The derived confidence floor applied to THIS run (C4 provenance) —
	 * same value on every badge in one `makeBadges` call. */
	readonly confidenceFloor: number;
	/** Other badges' detIds this badge's (would-be) label collides with (C5);
	 * empty when no collision. Populated on BOTH the winner and the loser(s)
	 * so the receipt never silently ships a resolved collision. */
	readonly conflictWith: readonly string[];
	/** segmentDigits' notes (dropped-blob lines, valley-split lines) that
	 * apply to this badge's glyph — forwarded verbatim so a non-OK verdict
	 * always carries its own explanation (C6). */
	readonly notes: readonly string[];
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
	/** `tee-shard-recovery` is detector-derived; phantom assignment fallbacks
	 * remain explicit injections because no tee pixels were observed.
	 * `tee-border-corner-fit` is the G4 border-adjacency corner fit's claim
	 * (zero-contradiction outline accounting; see g4.teeBorderCornerFit). */
	readonly source:
		| 'manual'
		| 'historical-fixture'
		| 'explicit-injected'
		| 'tee-shard-recovery'
		| 'tee-border-corner-fit';
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
	/**
	 * Optional G3 presentation/localization pose.  The enclosing-component PCA
	 * fields above are deliberately immutable baseline geometry: G4 recovery
	 * still consumes those metrics, while teeMinAreaPose owns this
	 * separate blind minimum-area exact-component pose for visible-pad
	 * consumers and its trace receipt.
	 */
	readonly minAreaPose?: {
		readonly centerXPx: number;
		readonly centerYPx: number;
		readonly angleRad: number;
		readonly majorPx: number;
		readonly minorPx: number;
		readonly orientedCorners: OrientedQuad;
	};
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
