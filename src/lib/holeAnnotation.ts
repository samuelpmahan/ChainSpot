/**
 * Pure hole-annotation editing operations for Annotate Round.
 *
 * Operates on draft `AnnotatedHole[]` arrays in source-image pixel space — the
 * same authoritative coordinate convention `createAnnotatedRound` validates
 * against at the Done boundary. Every function returns a new array; none
 * mutate their input, matching the rest of the domain layer's pure-reducer
 * style (`correspondenceState.ts`, `pointCorrection.ts`).
 *
 * Bounds checking is deliberately NOT duplicated here — the caller (the
 * viewport click handler, mirroring `ImagePane`'s own `onViewportClick`)
 * already rejects an out-of-bounds click before it reaches these functions,
 * and `createAnnotatedRound` performs the final authoritative validation.
 */
import { DEFAULT_CORRIDOR_WIDTH_PX } from './corridor';
import type { AnnotatedHole, OrderedShot, SourcePoint } from './domain/annotatedRound';

export type HolePlacementMode = 'tee' | 'basket' | 'shot' | 'bend';

export type CreateId = () => string;

const defaultCreateId: CreateId = () => globalThis.crypto.randomUUID();

/** Next sequential hole number — mirrors `nextPairOrdinal`'s max-plus-one convention. */
export function nextHoleNumber(holes: readonly AnnotatedHole[]): number {
	return holes.reduce((max, hole) => Math.max(max, hole.number), 0) + 1;
}

/** Appends a new, entirely empty hole with the next sequential number. */
export function addHole(holes: readonly AnnotatedHole[], createId: CreateId = defaultCreateId): AnnotatedHole[] {
	const hole: AnnotatedHole = {
		id: createId(),
		number: nextHoleNumber(holes),
		shots: [],
		corridorBends: [],
		corridorWidthPx: DEFAULT_CORRIDOR_WIDTH_PX
	};
	return [...holes, hole];
}

export function removeHole(holes: readonly AnnotatedHole[], holeId: string): AnnotatedHole[] {
	return holes.filter((hole) => hole.id !== holeId);
}

function updateHole(
	holes: readonly AnnotatedHole[],
	holeId: string,
	update: (hole: AnnotatedHole) => AnnotatedHole
): AnnotatedHole[] {
	return holes.map((hole) => (hole.id === holeId ? update(hole) : hole));
}

export function setTee(holes: readonly AnnotatedHole[], holeId: string, point: SourcePoint): AnnotatedHole[] {
	return updateHole(holes, holeId, (hole) => ({ ...hole, tee: point }));
}

export function setBasket(holes: readonly AnnotatedHole[], holeId: string, point: SourcePoint): AnnotatedHole[] {
	return updateHole(holes, holeId, (hole) => ({ ...hole, basket: point }));
}

export function addShot(
	holes: readonly AnnotatedHole[],
	holeId: string,
	point: SourcePoint,
	createId: CreateId = defaultCreateId
): AnnotatedHole[] {
	const shot: OrderedShot = { id: createId(), landing: point };
	return updateHole(holes, holeId, (hole) => ({ ...hole, shots: [...hole.shots, shot] }));
}

export function removeLastShot(holes: readonly AnnotatedHole[], holeId: string): AnnotatedHole[] {
	return updateHole(holes, holeId, (hole) => ({ ...hole, shots: hole.shots.slice(0, -1) }));
}

export function addCorridorBend(holes: readonly AnnotatedHole[], holeId: string, point: SourcePoint): AnnotatedHole[] {
	return updateHole(holes, holeId, (hole) => ({ ...hole, corridorBends: [...hole.corridorBends, point] }));
}

/** Pops the last bend; an empty bend list is a valid straight hole. */
export function removeLastBend(holes: readonly AnnotatedHole[], holeId: string): AnnotatedHole[] {
	return updateHole(holes, holeId, (hole) => ({ ...hole, corridorBends: hole.corridorBends.slice(0, -1) }));
}

export function clearBends(holes: readonly AnnotatedHole[], holeId: string): AnnotatedHole[] {
	return updateHole(holes, holeId, (hole) => ({ ...hole, corridorBends: [] }));
}

export function setCorridorWidth(holes: readonly AnnotatedHole[], holeId: string, corridorWidthPx: number): AnnotatedHole[] {
	return updateHole(holes, holeId, (hole) => ({ ...hole, corridorWidthPx }));
}

/**
 * Places `point` on `holeId` according to `mode` — the one entry point the UI
 * click handler needs, so it doesn't have to branch on mode itself.
 */
export function placeByMode(
	holes: readonly AnnotatedHole[],
	holeId: string,
	mode: HolePlacementMode,
	point: SourcePoint,
	createId: CreateId = defaultCreateId
): AnnotatedHole[] {
	switch (mode) {
		case 'tee':
			return setTee(holes, holeId, point);
		case 'basket':
			return setBasket(holes, holeId, point);
		case 'shot':
			return addShot(holes, holeId, point, createId);
		case 'bend':
			return addCorridorBend(holes, holeId, point);
	}
}
