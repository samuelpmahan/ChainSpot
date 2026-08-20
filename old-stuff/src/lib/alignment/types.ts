/**
 * ChainSpot alignment mathematics (P1-003).
 *
 * Coordinate space: original image pixels are authoritative. Transforms map
 * source-image pixels to target-image pixels through one canonical
 * six-coefficient affine application form used by both models:
 *
 *   xTarget = a*xSource + c*ySource + e
 *   yTarget = b*xSource + d*ySource + f
 *
 * Coefficient order is always [a, b, c, d, e, f] and direction is always
 * source -> target. Values are JSON-safe plain numbers; no Konva/canvas
 * matrix objects cross this boundary.
 */

export type AlignmentModel = 'similarity' | 'affine';

/**
 * The alignment module's own `{xPx, yPx}` point shape. Deliberately not the
 * domain's `PointCoordinates` (`domain/project.ts`) — alignment stays
 * standalone and structurally compatible rather than importing the domain;
 * named `AlignmentPoint` (not `PointCoordinates`) purely so the two shapes
 * don't collide by name.
 */
export interface AlignmentPoint {
	readonly xPx: number;
	readonly yPx: number;
}

/**
 * A correspondence pair as consumed by the alignment boundary. `target` is
 * null for an incomplete pair; incomplete and disabled pairs are never used
 * in estimation or residual calculation. Extra fields on the real
 * correspondence objects (labels, ordinals, timestamps) are ignored.
 */
export interface AlignmentPairInput {
	readonly id: string;
	readonly enabled: boolean;
	readonly source: AlignmentPoint;
	readonly target: AlignmentPoint | null;
}

/** Serializable source-to-target transform, shared by both models. */
export interface SerializableTransform {
	readonly model: AlignmentModel;
	readonly coefficients: readonly [a: number, b: number, c: number, d: number, e: number, f: number];
	readonly isInvertible: boolean;
	readonly determinant: number;
	/** Sign of the determinant: +1 direct orientation, -1 reflection. */
	readonly orientation: number;
	/** Singular value of the linear part: uniform for similarity. */
	readonly majorAxisScale: number;
	/** Second singular value of the linear part. */
	readonly minorAxisScale: number;
	/** minorAxisScale / majorAxisScale, in [0, 1]. */
	readonly anisotropy: number;
	/** Deviation of the mapped axes from orthogonality (0 for similarity). */
	readonly shear: number;
}

/** Typed, user-translatable failure reasons for estimation. */
export const AlignmentFailureReason = {
	INSUFFICIENT_PAIRS: 'INSUFFICIENT_PAIRS',
	ZERO_SPREAD: 'ZERO_SPREAD',
	COLLINEAR_GEOMETRY: 'COLLINEAR_GEOMETRY',
	NON_INVERTIBLE: 'NON_INVERTIBLE',
	NON_FINITE_COORDINATES: 'NON_FINITE_COORDINATES',
	REFLECTION_REQUIRED: 'REFLECTION_REQUIRED',
	NUMERICAL_SOLVE_FAILURE: 'NUMERICAL_SOLVE_FAILURE'
} as const;

export type AlignmentFailureReason = (typeof AlignmentFailureReason)[keyof typeof AlignmentFailureReason];

export interface EstimationFailure {
	readonly model: AlignmentModel;
	readonly reason: AlignmentFailureReason;
	readonly requiredPairs?: number;
	readonly availablePairs?: number;
}

export interface ResidualPair {
	readonly pairId: string;
	readonly source: AlignmentPoint;
	readonly target: AlignmentPoint;
	/** Transform of the source coordinate in target-image pixels. */
	readonly expected: AlignmentPoint;
	/** expected - target, in target-image pixels. */
	readonly dx: number;
	readonly dy: number;
	readonly distance: number;
}

export interface ResidualMetrics {
	readonly count: number;
	readonly meanDistance: number;
	readonly medianDistance: number;
	readonly rmsDistance: number;
	readonly maxDistance: number;
	/** ID of the pair achieving maxDistance; null when count is 0. */
	readonly maxPairId: string | null;
}

export interface EstimationResult {
	readonly model: AlignmentModel;
	readonly transform: SerializableTransform;
	readonly residuals: readonly ResidualPair[];
	readonly metrics: ResidualMetrics;
	/** Stable IDs of the enabled complete pairs used by the calculation. */
	readonly usedPairIds: readonly string[];
}

export type EstimationResultOrFailure = EstimationResult | EstimationFailure;

export interface ValidationWarning {
	readonly type: string;
	readonly message: string;
	readonly severity: 'low' | 'medium' | 'high';
}
