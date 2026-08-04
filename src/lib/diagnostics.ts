/**
 * ChainSpot point-set diagnostics and readiness guidance (P0-012).
 *
 * Small, pure, deterministic derivations over the existing durable coordinates
 * only. They guide but never block: nothing here mutates domain state, history,
 * dirty state, disables creation/edit/export/import, or estimates a transform or
 * residual. Pending half-pairs are transient editor state and are deliberately
 * EXCLUDED from these durable diagnostics; they are only reflected in the
 * transient pending count.
 *
 * Readiness (count-only, deterministic thresholds):
 * - `SIMILARITY_MIN_PAIRS = 2` complete pairs before a FUTURE similarity
 *   registration could be attempted (Phase 1 scope, never computed here).
 * - `AFFINE_MIN_PAIRS = 3` complete pairs before a FUTURE affine registration
 *   could be attempted. Copy only ever cites pair counts and never claims that
 *   the points are geometrically suitable or aligned.
 *
 * Coverage (normalized bounding-box span):
 * - `CLUSTERED_MIN_NORM_SPAN = 0.4`. A warning fires when BOTH normalized span
 *   axes are below this threshold, i.e. all points occupy a small region in both
 *   dimensions (plan: "warning if all points occupy a small region"). A thin band
 *   spread across one full axis is not flagged; this is intentionally simple and
 *   documented, not a registration-engine precursor. Requires at least two points.
 *
 * Near duplicates (simple image-space distance):
 * - `NEAR_DUPLICATE_MIN_DISTANCE_PX = 12` original-image pixels. A warning fires
 *   when any two points in one image are closer than this. Requires two points.
 */
import { findImageByRole } from './domain/project';
import type { ControlPointPair, ImageAsset, PointCoordinates } from './domain/project';

/** Minimum complete pairs before a future similarity registration is possible. */
export const SIMILARITY_MIN_PAIRS = 2;

/** Minimum complete pairs before a future affine registration is possible. */
export const AFFINE_MIN_PAIRS = 3;

/** Clustered-coverage warning threshold: normalized bbox span must be below this on BOTH axes. */
export const CLUSTERED_MIN_NORM_SPAN = 0.4;

/** Near-duplicate warning threshold in original-image pixels. */
export const NEAR_DUPLICATE_MIN_DISTANCE_PX = 12;

export interface PairCounts {
	/** Durable complete pairs currently in domain state. */
	readonly complete: number;
	/** Transient pending half-pair count: 0 or 1. */
	readonly pending: number;
}

export function derivePairCounts(
	pairs: ReadonlyArray<{ readonly ordinal: number }>,
	hasPendingSource: boolean
): PairCounts {
	return { complete: pairs.length, pending: hasPendingSource ? 1 : 0 };
}

export interface Readiness {
	/** Enough complete pairs for a future similarity registration. */
	readonly similarityReady: boolean;
	/** Enough complete pairs for a future affine registration. */
	readonly affineReady: boolean;
}

export function deriveReadiness(completeCount: number): Readiness {
	if (!Number.isInteger(completeCount) || completeCount < 0) {
		throw new Error(`deriveReadiness: completeCount must be a non-negative integer, got ${completeCount}`);
	}
	return {
		similarityReady: completeCount >= SIMILARITY_MIN_PAIRS,
		affineReady: completeCount >= AFFINE_MIN_PAIRS
	};
}

export interface CoverageDiagnostic {
	readonly pointCount: number;
	/** Normalized x span of the bounding box; null when fewer than two points. */
	readonly normSpanX: number | null;
	/** Normalized y span of the bounding box; null when fewer than two points. */
	readonly normSpanY: number | null;
	readonly clustered: boolean;
}

export function coverageDiagnostic(
	points: readonly PointCoordinates[],
	imageWidth: number,
	imageHeight: number
): CoverageDiagnostic {
	if (!Number.isFinite(imageWidth) || imageWidth <= 0 || !Number.isFinite(imageHeight) || imageHeight <= 0) {
		throw new Error(
			`coverageDiagnostic: image dimensions must be positive finite, got ${imageWidth}x${imageHeight}`
		);
	}
	if (points.length < 2) {
		return { pointCount: points.length, normSpanX: null, normSpanY: null, clustered: false };
	}
	let minX = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;
	for (const point of points) {
		minX = Math.min(minX, point.xPx);
		maxX = Math.max(maxX, point.xPx);
		minY = Math.min(minY, point.yPx);
		maxY = Math.max(maxY, point.yPx);
	}
	const normSpanX = (maxX - minX) / imageWidth;
	const normSpanY = (maxY - minY) / imageHeight;
	return {
		pointCount: points.length,
		normSpanX,
		normSpanY,
		clustered: normSpanX < CLUSTERED_MIN_NORM_SPAN && normSpanY < CLUSTERED_MIN_NORM_SPAN
	};
}

export interface NearDuplicateDiagnostic {
	readonly pointCount: number;
	/** Minimum pairwise image-space distance in original pixels; null below two points. */
	readonly minDistancePx: number | null;
	readonly nearDuplicate: boolean;
	/** Pair ordinals of the closest pair; null below two points. */
	readonly ordinals: readonly [number, number] | null;
}

export function nearDuplicateDiagnostic(points: readonly PointCoordinates[]): NearDuplicateDiagnostic {
	if (points.length < 2) {
		return { pointCount: points.length, minDistancePx: null, nearDuplicate: false, ordinals: null };
	}
	let minDistance = Number.POSITIVE_INFINITY;
	let closest: [number, number] | null = null;
	for (let i = 0; i < points.length; i += 1) {
		for (let j = i + 1; j < points.length; j += 1) {
			const distance = Math.hypot(points[i].xPx - points[j].xPx, points[i].yPx - points[j].yPx);
			if (distance < minDistance) {
				minDistance = distance;
				closest = [i, j];
			}
		}
	}
	return {
		pointCount: points.length,
		minDistancePx: minDistance,
		nearDuplicate: minDistance < NEAR_DUPLICATE_MIN_DISTANCE_PX,
		ordinals: closest
	};
}

export interface OrdinalPoint {
	readonly ordinal: number;
	readonly point: PointCoordinates;
}

/** Durable points on one image in pair order, carrying pair ordinals for warnings. */
export function ordinalPointsForImage(
	pairs: readonly ControlPointPair[],
	image: ImageAsset
): OrdinalPoint[] {
	const result: OrdinalPoint[] = [];
	for (const pair of pairs) {
		if (pair.source.imageId === image.id) {
			result.push({ ordinal: pair.ordinal, point: pair.source });
		} else if (pair.target.imageId === image.id) {
			result.push({ ordinal: pair.ordinal, point: pair.target });
		}
	}
	return result;
}

export interface ImageDiagnostics {
	readonly coverage: CoverageDiagnostic;
	readonly nearDuplicate: NearDuplicateDiagnostic;
}

export function imageDiagnostics(
	pairs: readonly ControlPointPair[],
	image: ImageAsset
): ImageDiagnostics {
	const ordinalPoints = ordinalPointsForImage(pairs, image);
	const points = ordinalPoints.map((entry) => entry.point);
	const coverage = coverageDiagnostic(points, image.widthPx, image.heightPx);
	const rawNear = nearDuplicateDiagnostic(points);
	const ordinals = rawNear.ordinals
		? ([ordinalPoints[rawNear.ordinals[0]].ordinal, ordinalPoints[rawNear.ordinals[1]].ordinal] as [number, number])
		: null;
	const nearDuplicate: NearDuplicateDiagnostic = {
		pointCount: rawNear.pointCount,
		minDistancePx: rawNear.minDistancePx,
		nearDuplicate: rawNear.nearDuplicate,
		ordinals
	};
	return { coverage, nearDuplicate };
}

export interface DiagnosticsSummary {
	readonly counts: PairCounts;
	readonly readiness: Readiness;
	readonly source: ImageDiagnostics;
	readonly target: ImageDiagnostics;
}

export function deriveDiagnostics(
	pairs: readonly ControlPointPair[],
	images: readonly ImageAsset[],
	hasPendingSource: boolean
): DiagnosticsSummary {
	const sourceImage = findImageByRole(images, 'source-overview');
	const targetImage = findImageByRole(images, 'target-basemap');
	return {
		counts: derivePairCounts(pairs, hasPendingSource),
		readiness: deriveReadiness(pairs.length),
		source: sourceImage ? imageDiagnostics(pairs, sourceImage) : emptyImageDiagnostics(),
		target: targetImage ? imageDiagnostics(pairs, targetImage) : emptyImageDiagnostics()
	};
}

function emptyImageDiagnostics(): ImageDiagnostics {
	return {
		coverage: { pointCount: 0, normSpanX: null, normSpanY: null, clustered: false },
		nearDuplicate: { pointCount: 0, minDistancePx: null, nearDuplicate: false, ordinals: null }
	};
}

function plural(noun: string, count: number): string {
	return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/** Count-only summary: "N complete pairs" plus "· 1 pending point" when present. */
export function countText(counts: PairCounts): string {
	const complete = plural('complete pair', counts.complete);
	return counts.pending === 1 ? `${complete} · ${plural('pending point', counts.pending)}` : complete;
}

/**
 * Count-only readiness copy. Cites only pair counts at the documented thresholds;
 * never claims geometric suitability or alignment and never reports a transform.
 */
export function readinessText(completeCount: number): string {
	if (completeCount >= AFFINE_MIN_PAIRS) {
		return `Enough complete pairs (${completeCount}) for a future affine registration.`;
	}
	if (completeCount >= SIMILARITY_MIN_PAIRS) {
		return `Enough complete pairs (${completeCount}) for a future similarity registration.`;
	}
	return `A future similarity registration will need ${SIMILARITY_MIN_PAIRS} complete pairs.`;
}

function percent(value: number): string {
	return `${Math.round(value * 100)}%`;
}

/** Non-blocking clustered-coverage warning copy, or null when the points are distributed. */
export function coverageWarningText(
	imageLabel: string,
	coverage: CoverageDiagnostic
): string | null {
	if (!coverage.clustered || coverage.normSpanX === null || coverage.normSpanY === null) return null;
	return `${imageLabel}: coverage warning — landmarks are concentrated in a small region (${percent(
		coverage.normSpanX
	)} × ${percent(coverage.normSpanY)} of the image).`;
}

/** Non-blocking near-duplicate warning copy, or null when no two points are close. */
export function nearDuplicateWarningText(
	imageLabel: string,
	diagnostic: NearDuplicateDiagnostic
): string | null {
	if (!diagnostic.nearDuplicate || diagnostic.minDistancePx === null || !diagnostic.ordinals) return null;
	return `${imageLabel}: near-duplicate warning — pairs ${diagnostic.ordinals[0]} and ${diagnostic.ordinals[1]} are ${diagnostic.minDistancePx.toFixed(1)} px apart.`;
}

export interface DiagnosticsCopy {
	readonly count: string;
	readonly readiness: string;
	readonly warnings: readonly string[];
}

/** Renders a summary into the display copy for the diagnostics panel. */
export function diagnosticsCopy(summary: DiagnosticsSummary): DiagnosticsCopy {
	const warnings: string[] = [];
	const sourceCoverage = coverageWarningText('UDisc source', summary.source.coverage);
	const sourceNear = nearDuplicateWarningText('UDisc source', summary.source.nearDuplicate);
	const targetCoverage = coverageWarningText('Clean target', summary.target.coverage);
	const targetNear = nearDuplicateWarningText('Clean target', summary.target.nearDuplicate);
	for (const warning of [sourceCoverage, sourceNear, targetCoverage, targetNear]) {
		if (warning) warnings.push(warning);
	}
	return {
		count: countText(summary.counts),
		readiness: readinessText(summary.counts.complete),
		warnings
	};
}
