/**
 * Pure geometry helpers for locking a hole's traced centerline shape against
 * a known-good reference ("golden shape" regression) and for sanity-checking
 * that holes known to be physically straight fairways trace out close to a
 * straight line ("hello world" smoke test). Kept separate from
 * `centerlineDetection.ts` so these comparison helpers can be unit-tested
 * without the real-fixture image/CV pipeline the tracker itself needs.
 */

export interface GoldenPoint {
	readonly xPx: number;
	readonly yPx: number;
}

/**
 * Resamples a polyline to exactly `sampleCount` points at even arc-length
 * intervals, so two traces with different point counts (e.g. after an
 * unrelated change to line-sampling density) can still be compared
 * point-for-point by shape rather than by raw index.
 */
export function resamplePolyline(points: readonly GoldenPoint[], sampleCount: number): GoldenPoint[] {
	if (points.length === 0) throw new Error('resamplePolyline requires at least one point.');
	if (sampleCount < 2) throw new Error('resamplePolyline requires sampleCount >= 2.');
	if (points.length === 1) return Array.from({ length: sampleCount }, () => points[0]);

	const segmentLengths: number[] = [];
	let totalLength = 0;
	for (let index = 0; index < points.length - 1; index += 1) {
		const length = Math.hypot(points[index + 1].xPx - points[index].xPx, points[index + 1].yPx - points[index].yPx);
		segmentLengths.push(length);
		totalLength += length;
	}
	if (totalLength === 0) return Array.from({ length: sampleCount }, () => points[0]);

	const result: GoldenPoint[] = [];
	for (let sample = 0; sample < sampleCount; sample += 1) {
		const targetDistance = (totalLength * sample) / (sampleCount - 1);
		let traveled = 0;
		let segmentIndex = 0;
		while (segmentIndex < segmentLengths.length - 1 && traveled + segmentLengths[segmentIndex] < targetDistance) {
			traveled += segmentLengths[segmentIndex];
			segmentIndex += 1;
		}
		const segmentLength = segmentLengths[segmentIndex];
		const t = segmentLength > 0 ? (targetDistance - traveled) / segmentLength : 0;
		const a = points[segmentIndex];
		const b = points[segmentIndex + 1];
		result.push({ xPx: a.xPx + (b.xPx - a.xPx) * t, yPx: a.yPx + (b.yPx - a.yPx) * t });
	}
	return result;
}

export interface GoldenShapeComparison {
	readonly maxDistancePx: number;
	readonly withinTolerance: boolean;
}

/**
 * Compares a traced polyline's shape against a golden reference by resampling
 * both to a shared number of arc-length-even points and taking the worst
 * pointwise distance. Point-count-independent, so it only fails when the
 * actual shape drifts, not when sampling density happens to change.
 */
export function compareToGoldenShape(
	traced: readonly GoldenPoint[],
	golden: readonly GoldenPoint[],
	tolerancePx: number,
	sampleCount = 40
): GoldenShapeComparison {
	const resampledTraced = resamplePolyline(traced, sampleCount);
	const resampledGolden = resamplePolyline(golden, sampleCount);
	let maxDistancePx = 0;
	for (let index = 0; index < sampleCount; index += 1) {
		const distance = Math.hypot(
			resampledTraced[index].xPx - resampledGolden[index].xPx,
			resampledTraced[index].yPx - resampledGolden[index].yPx
		);
		if (distance > maxDistancePx) maxDistancePx = distance;
	}
	return { maxDistancePx, withinTolerance: maxDistancePx <= tolerancePx };
}

export interface StraightnessCheck {
	readonly lengthPx: number;
	readonly maxDeviationPx: number;
	readonly deviationFraction: number;
	readonly withinTolerance: boolean;
}

/**
 * Measures how far a traced polyline bows away from the straight line
 * between its first and last point, as a fraction of that line's length.
 * A hole with a genuinely straight fairway should stay well under the
 * fraction a real dogleg produces, even accounting for the fixed kink every
 * hole takes routing around its own number badge.
 */
export function checkStraightness(points: readonly GoldenPoint[], maxDeviationFraction: number): StraightnessCheck {
	if (points.length < 2) throw new Error('checkStraightness requires at least two points.');
	const start = points[0];
	const end = points[points.length - 1];
	const lineDx = end.xPx - start.xPx;
	const lineDy = end.yPx - start.yPx;
	const lengthPx = Math.hypot(lineDx, lineDy);
	let maxDeviationPx = 0;
	if (lengthPx > 0) {
		for (const point of points) {
			const cross = Math.abs((point.xPx - start.xPx) * lineDy - (point.yPx - start.yPx) * lineDx) / lengthPx;
			if (cross > maxDeviationPx) maxDeviationPx = cross;
		}
	}
	const deviationFraction = lengthPx > 0 ? maxDeviationPx / lengthPx : 0;
	return { lengthPx, maxDeviationPx, deviationFraction, withinTolerance: deviationFraction <= maxDeviationFraction };
}
