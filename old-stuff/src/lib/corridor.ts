/**
 * ChainSpot constant-width corridor band derivation.
 *
 * A hole's authoritative geometry is a segmented centerline — tee, zero or
 * more bend points, basket — plus one constant corridor width in source-image
 * pixels. The renderable corridor band (a closed polygon) is always DERIVED
 * from that data; it is never persisted.
 *
 * The derivation is a small offset-polyline construction: each centerline
 * segment is offset left and right by half the width, adjacent offset lines
 * are intersected at bends (miter joins), a miter limit falls back to a bevel
 * join for sharp folds, and the band is closed with butt caps at tee and
 * basket. No third-party geometry dependency.
 *
 * If either tee or basket is absent, no complete band is derived — the
 * independent tee/basket/shot annotation behavior is unaffected.
 */
import type { SourcePoint } from './domain/project';

/** Initial corridor width (source-image pixels) assigned when a hole is created. */
export const DEFAULT_CORRIDOR_WIDTH_PX = 60;

/** Miter ratio beyond which a join falls back to a bevel (standard 2–4 range). */
const MITER_LIMIT = 4;

/** The subset of AnnotatedHole the corridor derivation needs. */
export interface CorridorShape {
	readonly tee?: SourcePoint;
	readonly basket?: SourcePoint;
	readonly corridorBends: readonly SourcePoint[];
	readonly corridorWidthPx: number;
}

/**
 * The conceptual centerline [tee, ...corridorBends, basket] with absent
 * endpoints filtered out. Bends are never duplicated inside `corridorBends`,
 * so tee/basket appear here at most once each.
 */
export function deriveCorridorCenterline(hole: CorridorShape): SourcePoint[] {
	const centerline: SourcePoint[] = [];
	if (hole.tee) centerline.push(hole.tee);
	for (const bend of hole.corridorBends) centerline.push(bend);
	if (hole.basket) centerline.push(hole.basket);
	return centerline;
}

function pointEquals(a: SourcePoint, b: SourcePoint): boolean {
	return a.xPx === b.xPx && a.yPx === b.yPx;
}

/** Drops consecutive duplicates so zero-length segments can never occur. */
function collapseConsecutiveDuplicates(points: readonly SourcePoint[]): SourcePoint[] {
	const result: SourcePoint[] = [];
	for (const point of points) {
		const last = result[result.length - 1];
		if (!last || !pointEquals(last, point)) result.push(point);
	}
	return result;
}

interface Segment {
	readonly dirX: number;
	readonly dirY: number;
	readonly normalX: number;
	readonly normalY: number;
}

function buildSegments(centerline: readonly SourcePoint[]): Segment[] {
	const segments: Segment[] = [];
	for (let index = 0; index < centerline.length - 1; index++) {
		const start = centerline[index];
		const end = centerline[index + 1];
		const dx = end.xPx - start.xPx;
		const dy = end.yPx - start.yPx;
		const length = Math.hypot(dx, dy);
		if (length === 0) continue;
		const dirX = dx / length;
		const dirY = dy / length;
		segments.push({ dirX, dirY, normalX: -dirY, normalY: dirX });
	}
	return segments;
}

interface Vec {
	readonly x: number;
	readonly y: number;
}

function offsetStart(point: SourcePoint, segment: Segment, halfWidth: number, sign: 1 | -1): Vec {
	return {
		x: point.xPx + sign * segment.normalX * halfWidth,
		y: point.yPx + sign * segment.normalY * halfWidth
	};
}

/**
 * Intersection of two lines (p1 + t*d1, p2 + t*d2). Returns null when the
 * lines are parallel (or nearly so) — the caller falls back to the shared
 * offset endpoint, which is exact for a straight continuation or a U-turn.
 */
function intersectLines(p1: Vec, d1: Vec, p2: Vec, d2: Vec): Vec | null {
	const cross = d1.x * d2.y - d1.y * d2.x;
	if (Math.abs(cross) < 1e-12) return null;
	const t = ((p2.x - p1.x) * d2.y - (p2.y - p1.y) * d2.x) / cross;
	return { x: p1.x + t * d1.x, y: p1.y + t * d1.y };
}

/**
 * Builds one side of the offset boundary. `sign` is +1 for the left side
 * (from tee toward basket) and -1 for the right. Each interior joint is a
 * miter intersection of the two adjacent offset lines, capped by MITER_LIMIT;
 * a capped join (or a parallel one) falls back to a bevel — the two plain
 * offset endpoints, producing a flat notch instead of an enormous spike.
 */
function buildSide(
	centerline: readonly SourcePoint[],
	segments: readonly Segment[],
	halfWidth: number,
	sign: 1 | -1
): Vec[] {
	const boundary: Vec[] = [];
	const first = offsetStart(centerline[0], segments[0], halfWidth, sign);
	boundary.push(first);

	for (let index = 0; index < segments.length - 1; index++) {
		const segment = segments[index];
		const next = segments[index + 1];
		const joint = centerline[index + 1];

		const lineAStart = offsetStart(joint, segment, halfWidth, sign);
		const lineBStart = offsetStart(joint, next, halfWidth, sign);
		const intersection = intersectLines(
			lineAStart,
			{ x: segment.dirX, y: segment.dirY },
			lineBStart,
			{ x: next.dirX, y: next.dirY }
		);

		if (!intersection) {
			// Parallel offset lines (straight continuation or U-turn): the
			// shared offset endpoint is the exact joint vertex.
			boundary.push(lineAStart);
			continue;
		}

		const miterLength = Math.hypot(intersection.x - joint.xPx, intersection.y - joint.yPx);
		if (miterLength > MITER_LIMIT * halfWidth) {
			boundary.push(lineAStart, lineBStart); // bevel
		} else {
			boundary.push(intersection); // miter
		}
	}

	const last = offsetStart(centerline[centerline.length - 1], segments[segments.length - 1], halfWidth, sign);
	boundary.push(last);
	return boundary;
}

/**
 * Derives the closed constant-width corridor band around
 * [tee, ...corridorBends, basket] as a polygon (the last vertex is not a
 * repeat of the first, matching the old corridor polygon convention). Returns
 * null when a complete band cannot be derived: either tee or basket absent, or
 * fewer than two distinct centerline points after collapsing duplicates.
 */
export function deriveCorridorBand(hole: CorridorShape): SourcePoint[] | null {
	if (!hole.tee || !hole.basket) return null;
	const centerline = collapseConsecutiveDuplicates(deriveCorridorCenterline(hole));
	if (centerline.length < 2) return null;

	const halfWidth = hole.corridorWidthPx / 2;
	const segments = buildSegments(centerline);
	if (segments.length === 0) return null;

	const left = buildSide(centerline, segments, halfWidth, 1);
	const right = buildSide(centerline, segments, halfWidth, -1);

	const polygon: SourcePoint[] = left.map((point) => ({ xPx: point.x, yPx: point.y }));
	for (let index = right.length - 1; index >= 0; index--) {
		polygon.push({ xPx: right[index].x, yPx: right[index].y });
	}
	return polygon;
}
