/**
 * Pure reducers for the round-level walking path — UDisc's purple walking
 * route, captured as one open polyline spanning the whole round. Unlike
 * `holeAnnotation.ts`'s per-hole reducers, these never take a hole id: the
 * walking path is not scoped to any single hole. Mirrors that module's
 * corridor-bend idiom (`addCorridorBend`/`moveCorridorBend`/
 * `removeCorridorBend`/`clearBends`) — every function returns a new array,
 * none mutate their input.
 */
import type { SourcePoint } from './domain/project';

/** Appends a vertex to the end of the path. */
export function addWalkPoint(points: readonly SourcePoint[], point: SourcePoint): SourcePoint[] {
	return [...points, point];
}

/** Moves one existing vertex while preserving its position in the path. */
export function moveWalkPoint(
	points: readonly SourcePoint[],
	index: number,
	point: SourcePoint
): SourcePoint[] {
	if (index < 0 || index >= points.length) return [...points];
	return points.map((existing, existingIndex) => (existingIndex === index ? point : existing));
}

/** Removes one vertex by its position in the ordered path. */
export function removeWalkPoint(points: readonly SourcePoint[], index: number): SourcePoint[] {
	if (index < 0 || index >= points.length) return [...points];
	return points.filter((_, existingIndex) => existingIndex !== index);
}

/** Discards the whole path; an empty path is valid (walk not yet annotated). */
export function clearWalkPath(): SourcePoint[] {
	return [];
}
