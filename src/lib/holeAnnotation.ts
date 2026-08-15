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
 *
 * Bend ordering is derived from geometry, not insertion order: bends are
 * sorted by their projection along the tee→basket centerline so that
 * correctness depends only on spatial relationships, not placement chronology.
 */
import { DEFAULT_CORRIDOR_WIDTH_PX } from './corridor';
import type { AnnotatedHole, OrderedShot, SourcePoint } from './domain/annotatedRound';

export type HolePlacementMode = 'tee' | 'basket' | 'shot' | 'bend';

export type CreateId = () => string;

const defaultCreateId: CreateId = () => globalThis.crypto.randomUUID();

/** Lowest missing hole number in the supported 1–18 range, or null when full. */
export function nextHoleNumber(holes: readonly AnnotatedHole[]): number | null {
	const presentNumbers = new Set(holes.map((hole) => hole.number));
	for (let number = 1; number <= 18; number += 1) {
		if (!presentNumbers.has(number)) return number;
	}
	return null;
}

function emptyHole(number: number, createId: CreateId): AnnotatedHole {
	return {
		id: createId(),
		number,
		shots: [],
		corridorBends: [],
		corridorWidthPx: DEFAULT_CORRIDOR_WIDTH_PX
	};
}

function insertHoleInNumberOrder(holes: readonly AnnotatedHole[], hole: AnnotatedHole): AnnotatedHole[] {
	const next = [...holes, hole];
	next.sort((left, right) => left.number - right.number);
	return next;
}

// ---------------------------------------------------------------------------
// Geometry-based bend ordering: derive bend position along tee→basket path.
// ---------------------------------------------------------------------------

/**
 * Projects a point onto the line segment from start to end, returning a
 * parameter t where 0 is at start, 1 is at end, <0 is before start, >1 is
 * after end. Used to sort bends by their position along the tee→basket path.
 */
function projectPointOntoSegment(point: SourcePoint, start: SourcePoint, end: SourcePoint): number {
	const dx = end.xPx - start.xPx;
	const dy = end.yPx - start.yPx;
	const lengthSq = dx * dx + dy * dy;
	if (lengthSq === 0) {
		// Start and end are the same point; return 0 as a neutral value.
		return 0;
	}
	const t = ((point.xPx - start.xPx) * dx + (point.yPx - start.yPx) * dy) / lengthSq;
	return t;
}

/**
 * Calculates the position of a bend along the hole's centerline [tee, basket].
 * Returns a scalar representing position along the path: 0 at tee, 1 at basket.
 * If tee or basket is missing, returns a fallback based on distance to the
 * available endpoint (defensive, should not happen in normal operation).
 */
function bendPositionOnCenterline(bend: SourcePoint, tee: SourcePoint | undefined, basket: SourcePoint | undefined): number {
	if (!tee || !basket) {
		// Fallback for incomplete hole geometry: use distance as proxy.
		if (tee) {
			const dx = bend.xPx - tee.xPx;
			const dy = bend.yPx - tee.yPx;
			return Math.hypot(dx, dy);
		}
		if (basket) {
			const dx = bend.xPx - basket.xPx;
			const dy = bend.yPx - basket.yPx;
			return -Math.hypot(dx, dy);
		}
		return 0;
	}
	return projectPointOntoSegment(bend, tee, basket);
}

/**
 * Sorts `bends` by their geometric position along the tee→basket centerline.
 * Preserves the input array if already sorted (stable, no unnecessary mutations).
 * Returns a new sorted array only if reordering is required.
 */
function sortBendsByPosition(bends: readonly SourcePoint[], tee: SourcePoint | undefined, basket: SourcePoint | undefined): SourcePoint[] {
	if (bends.length <= 1) return bends.slice();

	const indexed = bends.map((bend, originalIndex) => ({
		bend,
		position: bendPositionOnCenterline(bend, tee, basket),
		originalIndex
	}));

	// Check if already sorted; if so, return original array reference to avoid unnecessary mutation.
	let isSorted = true;
	for (let i = 1; i < indexed.length; i++) {
		if (indexed[i].position < indexed[i - 1].position) {
			isSorted = false;
			break;
		}
	}

	if (isSorted) {
		return bends.slice();
	}

	// Sort by position and return just the bend points.
	indexed.sort((a, b) => a.position - b.position);
	return indexed.map((item) => item.bend);
}

/** Adds an empty hole in numeric order, using the lowest missing 1–18 number. */
export function addHole(holes: readonly AnnotatedHole[], createId: CreateId = defaultCreateId): AnnotatedHole[] {
	const number = nextHoleNumber(holes);
	if (number === null) return [...holes];
	return insertHoleInNumberOrder(holes, emptyHole(number, createId));
}

/** Adds the next hole after the current maximum, for courses longer than 18 holes. */
export function addHoleBeyondStandardCourse(
	holes: readonly AnnotatedHole[],
	createId: CreateId = defaultCreateId
): AnnotatedHole[] {
	const number = Math.max(18, ...holes.map((hole) => hole.number)) + 1;
	return insertHoleInNumberOrder(holes, emptyHole(number, createId));
}

/**
 * Adds a hole with a caller-supplied number, e.g. one read off a course map
 * via number detection. No-op if that number is invalid or already present.
 */
export function addHoleWithNumber(
	holes: readonly AnnotatedHole[],
	number: number,
	createId: CreateId = defaultCreateId
): AnnotatedHole[] {
	if (!Number.isInteger(number) || number < 1) return [...holes];
	if (holes.some((hole) => hole.number === number)) return [...holes];
	return insertHoleInNumberOrder(holes, emptyHole(number, createId));
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

/** Moves the existing tee on a hole without changing any other annotation. */
export function moveTee(holes: readonly AnnotatedHole[], holeId: string, point: SourcePoint): AnnotatedHole[] {
	return updateHole(holes, holeId, (hole) => (hole.tee ? { ...hole, tee: point } : hole));
}

/** Moves the existing basket on a hole without changing any other annotation. */
export function moveBasket(holes: readonly AnnotatedHole[], holeId: string, point: SourcePoint): AnnotatedHole[] {
	return updateHole(holes, holeId, (hole) => (hole.basket ? { ...hole, basket: point } : hole));
}

/** Removes the tee from a hole, leaving every other annotation untouched. */
export function removeTee(holes: readonly AnnotatedHole[], holeId: string): AnnotatedHole[] {
	return updateHole(holes, holeId, (hole) => ({ ...hole, tee: undefined }));
}

/** Removes the basket from a hole, leaving every other annotation untouched. */
export function removeBasket(holes: readonly AnnotatedHole[], holeId: string): AnnotatedHole[] {
	return updateHole(holes, holeId, (hole) => ({ ...hole, basket: undefined }));
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

/** Removes one specific shot by id, wherever it falls in the ordered list. */
export function removeShot(holes: readonly AnnotatedHole[], holeId: string, shotId: string): AnnotatedHole[] {
	return updateHole(holes, holeId, (hole) => ({
		...hole,
		shots: hole.shots.filter((shot) => shot.id !== shotId)
	}));
}

/** Moves one existing shot landing while preserving the shot id and order. */
export function moveShot(
	holes: readonly AnnotatedHole[],
	holeId: string,
	shotId: string,
	point: SourcePoint
): AnnotatedHole[] {
	return updateHole(holes, holeId, (hole) => ({
		...hole,
		shots: hole.shots.map((shot) => (shot.id === shotId ? { ...shot, landing: point } : shot))
	}));
}

export function addCorridorBend(holes: readonly AnnotatedHole[], holeId: string, point: SourcePoint): AnnotatedHole[] {
	return updateHole(holes, holeId, (hole) => {
		const newBends = [...hole.corridorBends, point];
		const sortedBends = sortBendsByPosition(newBends, hole.tee, hole.basket);
		return { ...hole, corridorBends: sortedBends };
	});
}

/**
 * Moves one existing bend to a new position and reorders the array if the
 * new geometry places it before/after other bends. Identifies the bend to move
 * by its current index in the corridorBends array, updates its coordinates,
 * and re-sorts all bends by their position along the tee→basket centerline.
 */
export function moveCorridorBend(
	holes: readonly AnnotatedHole[],
	holeId: string,
	index: number,
	point: SourcePoint
): AnnotatedHole[] {
	return updateHole(holes, holeId, (hole) => {
		if (index < 0 || index >= hole.corridorBends.length) return hole;
		const newBends = hole.corridorBends.map((bend, bendIndex) =>
			bendIndex === index ? point : bend
		);
		const sortedBends = sortBendsByPosition(newBends, hole.tee, hole.basket);
		return {
			...hole,
			corridorBends: sortedBends
		};
	});
}

/** Pops the last bend; an empty bend list is a valid straight hole. */
export function removeLastBend(holes: readonly AnnotatedHole[], holeId: string): AnnotatedHole[] {
	return updateHole(holes, holeId, (hole) => ({ ...hole, corridorBends: hole.corridorBends.slice(0, -1) }));
}

/** Removes one specific bend by its position in the ordered list. */
export function removeCorridorBend(holes: readonly AnnotatedHole[], holeId: string, index: number): AnnotatedHole[] {
	return updateHole(holes, holeId, (hole) => {
		if (index < 0 || index >= hole.corridorBends.length) return hole;
		return {
			...hole,
			corridorBends: hole.corridorBends.filter((_, bendIndex) => bendIndex !== index)
		};
	});
}

export function clearBends(holes: readonly AnnotatedHole[], holeId: string): AnnotatedHole[] {
	return updateHole(holes, holeId, (hole) => ({ ...hole, corridorBends: [] }));
}

export function setCorridorWidth(holes: readonly AnnotatedHole[], holeId: string, corridorWidthPx: number): AnnotatedHole[] {
	return updateHole(holes, holeId, (hole) => ({ ...hole, corridorWidthPx }));
}

/**
 * Sets every hole's corridor width to the same value. UDisc renders a
 * course's corridor ribbon at one width across the whole map, not per hole,
 * so this — not the single-hole `setCorridorWidth` — is what the Annotate
 * Round width control now drives by default. `setCorridorWidth` stays
 * exported: the domain remains per-hole capable (imported Course Memory
 * geometry, for instance, can still carry mixed widths), this is just the
 * bulk operation layered on top of it.
 */
export function setAllCorridorWidths(holes: readonly AnnotatedHole[], corridorWidthPx: number): AnnotatedHole[] {
	return holes.map((hole) => ({ ...hole, corridorWidthPx }));
}

/**
 * Assigns a CV candidate's already-reduced `{xPx, yPx}` (see `acceptCandidate`
 * in `cv/types.ts` — no score/confidence ever reaches this function) to
 * `holeId`'s tee or basket, first clearing that exact point from any OTHER
 * hole that currently holds it. That clear pass is what makes this the single
 * primitive behind Annotate Round's click-to-assign interaction: a plain
 * assign or an in-place replace (the point isn't currently placed elsewhere)
 * degenerates to the clear pass being a no-op, and a move is just the clear
 * pass finding a match. Callers never need to branch on which case they're
 * in — every mutation still flows through the same `holes = fn(holes, ...)`
 * reassignment as `setTee`/`setBasket`/`moveTee`/`moveBasket`, so it is
 * covered by any future undo/redo work exactly as those already are.
 */
export function assignCandidateToHole(
	holes: readonly AnnotatedHole[],
	holeId: string,
	kind: 'tee' | 'basket',
	point: SourcePoint
): AnnotatedHole[] {
	const cleared = holes.map((hole) => {
		if (hole.id === holeId) return hole;
		const existing = kind === 'tee' ? hole.tee : hole.basket;
		if (!existing || existing.xPx !== point.xPx || existing.yPx !== point.yPx) return hole;
		return kind === 'tee' ? { ...hole, tee: undefined } : { ...hole, basket: undefined };
	});
	return kind === 'tee' ? setTee(cleared, holeId, point) : setBasket(cleared, holeId, point);
}

/**
 * Moves an existing tee/basket from one hole to another, by hole id rather
 * than by matching coordinates — the primitive behind the marker-correction
 * chip's "reassign to hole" action. Delegates to `assignCandidateToHole`,
 * which already clears the point from any hole currently holding it (so a
 * marker already sitting on `toHoleId`'s own tee/basket is silently
 * replaced, matching a plain `setTee`/`setBasket` overwrite). A no-op if
 * `fromHoleId` has no such point, or if `fromHoleId === toHoleId`.
 */
export function reassignMarker(
	holes: readonly AnnotatedHole[],
	fromHoleId: string,
	toHoleId: string,
	kind: 'tee' | 'basket'
): AnnotatedHole[] {
	if (fromHoleId === toHoleId) return holes.slice();
	const fromHole = holes.find((hole) => hole.id === fromHoleId);
	const point = kind === 'tee' ? fromHole?.tee : fromHole?.basket;
	if (!point) return holes.slice();
	return assignCandidateToHole(holes, toHoleId, kind, point);
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
