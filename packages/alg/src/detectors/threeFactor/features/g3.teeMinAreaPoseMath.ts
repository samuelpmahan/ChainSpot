/**
 * Deterministic minimum-area pose for one exact tee component.
 *
 * This uses the same minimum-area-rectangle class of geometry as the
 * pre-engine tee detector's OpenCV `minAreaRect(contour)`. It is deliberately
 * not literal OpenCV contour parity: today's input is the exact
 * detector-owned component, expanded into a unit-cell envelope, rather than
 * old gray/Canny contour points. Returned extents can therefore differ from
 * OpenCV's contour-point extents while containing every painted cell.
 * It does not inspect truth, badges, baskets, assignments, paths, neighboring
 * tees, or pixels outside the component.
 */

export interface TeeComponentCell {
	readonly xPx: number;
	readonly yPx: number;
}

export interface TeeMinAreaPoint {
	readonly xPx: number;
	readonly yPx: number;
}

export interface TeeMinimumAreaPoseResult {
	readonly accepted: boolean;
	readonly reason: string;
	readonly pixelCount: number;
	readonly hullVertexCount: number;
	readonly candidateCount: number;
	readonly score: number | null;
	readonly occupancy: number | null;
	readonly areaPx2: number | null;
	readonly center: TeeMinAreaPoint | null;
	readonly angleDeg: number | null;
	readonly majorPx: number | null;
	readonly minorPx: number | null;
	/** Four fitted rectangle corners in cyclic order. */
	readonly corners: readonly TeeMinAreaPoint[] | null;
}

interface Point {
	readonly x: number;
	readonly y: number;
}

interface Candidate {
	readonly angleRad: number;
	readonly center: Point;
	readonly majorPx: number;
	readonly minorPx: number;
	readonly areaPx2: number;
	readonly corners: readonly Point[];
}

const EPSILON = 1e-9;

function finite(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}

function pointKey(point: Point): string {
	return `${point.x},${point.y}`;
}

function comparePoints(a: Point, b: Point): number {
	return a.x - b.x || a.y - b.y;
}

function cross(origin: Point, a: Point, b: Point): number {
	return (a.x - origin.x) * (b.y - origin.y) - (a.y - origin.y) * (b.x - origin.x);
}

/** Convex hull in cyclic order, without duplicated closing vertex. */
function convexHull(points: readonly Point[]): Point[] {
	const unique = [...new Map(points.map((point) => [pointKey(point), point])).values()].sort(
		comparePoints
	);
	if (unique.length <= 1) return unique;
	const lower: Point[] = [];
	for (const point of unique) {
		while (
			lower.length >= 2 &&
			cross(lower[lower.length - 2]!, lower[lower.length - 1]!, point) <= 0
		)
			lower.pop();
		lower.push(point);
	}
	const upper: Point[] = [];
	for (let index = unique.length - 1; index >= 0; index--) {
		const point = unique[index]!;
		while (
			upper.length >= 2 &&
			cross(upper[upper.length - 2]!, upper[upper.length - 1]!, point) <= 0
		)
			upper.pop();
		upper.push(point);
	}
	lower.pop();
	upper.pop();
	return [...lower, ...upper];
}

function canonicalAxialAngleRad(value: number): number {
	return ((value % Math.PI) + Math.PI) % Math.PI;
}

function projections(points: readonly Point[], ux: number, uy: number): readonly [number, number] {
	let minimum = Infinity;
	let maximum = -Infinity;
	for (const point of points) {
		const projection = point.x * ux + point.y * uy;
		if (projection < minimum) minimum = projection;
		if (projection > maximum) maximum = projection;
	}
	return [minimum, maximum];
}

function candidateAt(hull: readonly Point[], edgeAngleRad: number): Candidate | null {
	const edgeX = Math.cos(edgeAngleRad);
	const edgeY = Math.sin(edgeAngleRad);
	const edgeNormalX = -edgeY;
	const edgeNormalY = edgeX;
	const [edgeMin, edgeMax] = projections(hull, edgeX, edgeY);
	const [normalMin, normalMax] = projections(hull, edgeNormalX, edgeNormalY);
	const edgeExtent = edgeMax - edgeMin;
	const normalExtent = normalMax - normalMin;
	if (!(edgeExtent > EPSILON) || !(normalExtent > EPSILON)) return null;

	// Normalize around the major axis, then project again in that frame. This
	// makes perpendicular hull edges produce identical pose testimony.
	const majorAngle = canonicalAxialAngleRad(
		edgeExtent >= normalExtent ? edgeAngleRad : edgeAngleRad + Math.PI / 2
	);
	const majorX = Math.cos(majorAngle);
	const majorY = Math.sin(majorAngle);
	const minorX = -majorY;
	const minorY = majorX;
	const [majorMin, majorMax] = projections(hull, majorX, majorY);
	const [minorMin, minorMax] = projections(hull, minorX, minorY);
	const majorPx = majorMax - majorMin;
	const minorPx = minorMax - minorMin;
	if (!(majorPx > EPSILON) || !(minorPx > EPSILON)) return null;
	const centerMajor = (majorMin + majorMax) / 2;
	const centerMinor = (minorMin + minorMax) / 2;
	const center = {
		x: centerMajor * majorX + centerMinor * minorX,
		y: centerMajor * majorY + centerMinor * minorY
	};
	const corner = (major: number, minor: number): Point => ({
		x: major * majorX + minor * minorX,
		y: major * majorY + minor * minorY
	});
	return {
		angleRad: majorAngle,
		center,
		majorPx,
		minorPx,
		areaPx2: majorPx * minorPx,
		corners: [
			corner(majorMin, minorMin),
			corner(majorMax, minorMin),
			corner(majorMax, minorMax),
			corner(majorMin, minorMax)
		]
	};
}

function better(candidate: Candidate, current: Candidate | null): boolean {
	if (!current) return true;
	const areaTolerance = EPSILON * Math.max(1, candidate.areaPx2, current.areaPx2);
	if (candidate.areaPx2 < current.areaPx2 - areaTolerance) return true;
	if (candidate.areaPx2 > current.areaPx2 + areaTolerance) return false;
	// Exact-area ties are resolved only from the candidate geometry. No ring,
	// badge, path, or neighboring-object angle is allowed to choose the pose.
	if (candidate.majorPx !== current.majorPx) return candidate.majorPx > current.majorPx;
	if (candidate.angleRad !== current.angleRad) return candidate.angleRad < current.angleRad;
	if (candidate.center.y !== current.center.y) return candidate.center.y < current.center.y;
	return candidate.center.x < current.center.x;
}

function rejected(
	reason: string,
	pixelCount: number,
	hullVertexCount = 0,
	candidateCount = 0
): TeeMinimumAreaPoseResult {
	return {
		accepted: false,
		reason,
		pixelCount,
		hullVertexCount,
		candidateCount,
		score: null,
		occupancy: null,
		areaPx2: null,
		center: null,
		angleDeg: null,
		majorPx: null,
		minorPx: null,
		corners: null
	};
}

/**
 * Fit the minimum-area rectangle enclosing every exact owned pixel cell.
 * The exact component cells are the complete input, including tie-breaking.
 */
export function fitMinimumAreaPixelRect(
	pixels: readonly TeeComponentCell[]
): TeeMinimumAreaPoseResult {
	if (!Array.isArray(pixels) || pixels.length < 2)
		return rejected(
			'at least two exact component pixels are required',
			Array.isArray(pixels) ? pixels.length : 0
		);
	if (
		pixels.some(
			(pixel) =>
				!pixel ||
				!finite(pixel.xPx) ||
				!finite(pixel.yPx) ||
				!Number.isInteger(pixel.xPx) ||
				!Number.isInteger(pixel.yPx)
		)
	)
		return rejected('component pixels must be finite integer detector cells', pixels.length);
	const uniqueCells = new Set(pixels.map((pixel) => `${pixel.xPx},${pixel.yPx}`));
	if (uniqueCells.size !== pixels.length)
		return rejected('component pixels must be unique detector cells', pixels.length);

	// A detector pixel is a unit square centered at its integer coordinate.
	// Fitting square corners contains the full painted cells, not just centers.
	const cellCorners: Point[] = [];
	for (const pixel of pixels) {
		cellCorners.push(
			{ x: pixel.xPx - 0.5, y: pixel.yPx - 0.5 },
			{ x: pixel.xPx + 0.5, y: pixel.yPx - 0.5 },
			{ x: pixel.xPx + 0.5, y: pixel.yPx + 0.5 },
			{ x: pixel.xPx - 0.5, y: pixel.yPx + 0.5 }
		);
	}
	const hull = convexHull(cellCorners);
	if (hull.length < 3)
		return rejected('component cell hull is degenerate', pixels.length, hull.length);

	const seenAngles = new Set<string>();
	let best: Candidate | null = null;
	let candidateCount = 0;
	for (let index = 0; index < hull.length; index++) {
		const a = hull[index]!;
		const b = hull[(index + 1) % hull.length]!;
		const edgeAngle = Math.atan2(b.y - a.y, b.x - a.x);
		// Rectangle orientation repeats every 90 degrees. Quantization only
		// de-duplicates mathematically identical parallel edges.
		const rectangleAngle = ((edgeAngle % (Math.PI / 2)) + Math.PI / 2) % (Math.PI / 2);
		const key = rectangleAngle.toFixed(12);
		if (seenAngles.has(key)) continue;
		seenAngles.add(key);
		const candidate = candidateAt(hull, rectangleAngle);
		if (!candidate) continue;
		candidateCount++;
		if (better(candidate, best)) best = candidate;
	}
	if (!best)
		return rejected(
			'no non-degenerate hull-edge rectangle exists',
			pixels.length,
			hull.length,
			candidateCount
		);

	const occupancy = pixels.length / best.areaPx2;
	return {
		accepted: true,
		reason: 'accepted minimum-area rectangle over exact detector-owned pixel cells',
		pixelCount: pixels.length,
		hullVertexCount: hull.length,
		candidateCount,
		score: occupancy,
		occupancy,
		areaPx2: best.areaPx2,
		center: { xPx: best.center.x, yPx: best.center.y },
		angleDeg: (best.angleRad * 180) / Math.PI,
		majorPx: best.majorPx,
		minorPx: best.minorPx,
		corners: best.corners.map((point) => ({ xPx: point.x, yPx: point.y }))
	};
}
