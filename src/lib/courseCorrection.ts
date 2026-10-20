/**
 * Course correction: the pure half of the correction view (`routes/correct-course`).
 *
 * A course arrives as a `chainspot.course-geometry@1` file (`import/courseGeometry.ts`): holes as ProjectState
 * v7 `AnnotatedHole`s plus per-hole `evidence` the CV left outside the holes. The reviewer fixes the holes on ONE
 * image surface (`ImageEditorPane` -> `ImageViewport`'s claim protocol); this module answers what a pointer is on,
 * what each gesture does to the holes, and which holes to walk first. Nothing here touches the DOM or events.
 *
 * Spaces: hit-testing is in SCREEN px (CSS px of the viewport element) so handles stay the same size at every zoom;
 * geometry is in SOURCE px of the screenshot (`SourcePoint`). `view` converts between them (`coords.ts`).
 */
import { imageToScreen } from './coords';
import type { ScreenSpacePoint, ViewTransformState } from './coords';
import { deriveCorridorCenterline } from './corridor';
import type { AnnotatedHole, SourcePoint } from './domain/project';
import { insertCorridorBend, moveBasket, moveTee, removeCorridorBend, setCorridorBend } from './holeAnnotation';
import { needsReview } from './import/courseGeometry';
import type { HoleEvidence, HoleStatus } from './import/courseGeometry';

/** Grab radius of a tee, basket or bend handle, in screen px (an ergonomic constant, not a map quantity). */
export const HANDLE_HIT_PX = 12;
/** Least grab half-width of a corridor leg, in screen px; at higher zoom the corridor's own half-width wins. */
export const LEG_MIN_HIT_PX = 8;
/** Two clicks on the same bend within this many ms are a double-click (remove the bend). */
export const DOUBLE_CLICK_MS = 450;

export type HandleKind = 'tee' | 'basket' | 'bend';

/** What a pointer-down landed on. `leg` carries the point on the leg nearest the pointer, in source px. */
export type CorrectionHit =
	| { readonly kind: 'tee' | 'basket'; readonly holeId: string }
	| { readonly kind: 'bend'; readonly holeId: string; readonly index: number }
	| { readonly kind: 'leg'; readonly holeId: string; readonly legIndex: number; readonly point: SourcePoint };

/** A selected handle (or a whole hole, `handle` absent). */
export interface CorrectionSelection {
	readonly holeId: string;
	readonly handle?: { readonly kind: 'tee' | 'basket' } | { readonly kind: 'bend'; readonly index: number };
}

function distanceToSegment(p: ScreenSpacePoint, a: ScreenSpacePoint, b: ScreenSpacePoint): { distance: number; t: number } {
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	const lengthSq = dx * dx + dy * dy;
	const t = lengthSq === 0 ? 0 : Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq));
	return { distance: Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy)), t };
}

/**
 * The handle or corridor leg under `pointer`. Handles win over legs (a bend sits on two legs); among handles the
 * nearest wins, ties going to the selected hole; among legs the nearest centerline wins. Null: the background,
 * which the viewport keeps for panning and clicks.
 */
export function hitTestCourse(
	holes: readonly AnnotatedHole[],
	pointer: ScreenSpacePoint,
	view: ViewTransformState,
	selectedHoleId: string | null = null
): CorrectionHit | null {
	let bestHandle: { hit: CorrectionHit; distance: number } | null = null;
	const consider = (hit: CorrectionHit, point: SourcePoint): void => {
		const screen = imageToScreen(point, view);
		const distance = Math.hypot(screen.x - pointer.x, screen.y - pointer.y);
		if (distance > HANDLE_HIT_PX) return;
		const better =
			!bestHandle ||
			distance < bestHandle.distance - 1e-9 ||
			(Math.abs(distance - bestHandle.distance) <= 1e-9 && hit.holeId === selectedHoleId);
		if (better) bestHandle = { hit, distance };
	};
	for (const hole of holes) {
		if (hole.tee) consider({ kind: 'tee', holeId: hole.id }, hole.tee);
		if (hole.basket) consider({ kind: 'basket', holeId: hole.id }, hole.basket);
		hole.corridorBends.forEach((bend, index) => consider({ kind: 'bend', holeId: hole.id, index }, bend));
	}
	if (bestHandle) return (bestHandle as { hit: CorrectionHit }).hit;

	let bestLeg: { hit: CorrectionHit; distance: number } | null = null;
	for (const hole of holes) {
		if (!hole.tee || !hole.basket) continue;
		const centerline = deriveCorridorCenterline(hole);
		const reach = Math.max((hole.corridorWidthPx / 2) * view.zoom, LEG_MIN_HIT_PX);
		for (let legIndex = 0; legIndex < centerline.length - 1; legIndex++) {
			const a = centerline[legIndex];
			const b = centerline[legIndex + 1];
			const { distance, t } = distanceToSegment(pointer, imageToScreen(a, view), imageToScreen(b, view));
			if (distance > reach) continue;
			if (!bestLeg || distance < bestLeg.distance) {
				const point = { xPx: a.xPx + t * (b.xPx - a.xPx), yPx: a.yPx + t * (b.yPx - a.yPx) };
				bestLeg = { hit: { kind: 'leg', holeId: hole.id, legIndex, point }, distance };
			}
		}
	}
	return bestLeg ? (bestLeg as { hit: CorrectionHit }).hit : null;
}

/** Rounds to 0.01 px: a screen gesture is never more precise than that, and saved files stay readable. */
export function roundPoint(point: SourcePoint): SourcePoint {
	return { xPx: Math.round(point.xPx * 100) / 100, yPx: Math.round(point.yPx * 100) / 100 };
}

/** Moves the grabbed handle to `point` (a bend keeps its place in the order). */
export function moveHandle(holes: readonly AnnotatedHole[], holeId: string, handle: CorrectionSelection['handle'], point: SourcePoint): AnnotatedHole[] {
	if (!handle) return [...holes];
	if (handle.kind === 'bend') return setCorridorBend(holes, holeId, handle.index, point);
	return handle.kind === 'tee' ? moveTee(holes, holeId, point) : moveBasket(holes, holeId, point);
}

/** A click on corridor leg `legIndex` adds a bend there; the new bend's index is `legIndex`. */
export function addBendOnLeg(holes: readonly AnnotatedHole[], holeId: string, legIndex: number, point: SourcePoint): AnnotatedHole[] {
	return insertCorridorBend(holes, holeId, legIndex, point);
}

export function removeBend(holes: readonly AnnotatedHole[], holeId: string, index: number): AnnotatedHole[] {
	return removeCorridorBend(holes, holeId, index);
}

// ---------------------------------------------------------------------------
// Review order
// ---------------------------------------------------------------------------

export type ReviewStatus = HoleStatus | 'none';

/** The evidence status the view colours a hole by; `none` when the file carried no evidence for it (or the project was reopened without the file). */
export function reviewStatus(evidence: HoleEvidence | undefined): ReviewStatus {
	return evidence ? evidence.status : 'none';
}

/** Colour per status. Resolved and straight are the CV's confirmed answers; partial and unresolved need a look. */
export const STATUS_COLOURS: Readonly<Record<ReviewStatus, string>> = {
	resolved: '#22c55e',
	straight: '#38bdf8',
	partial: '#f59e0b',
	unresolved: '#ef4444',
	none: '#a1a1aa'
};

export const STATUS_LABELS: Readonly<Record<ReviewStatus, string>> = {
	resolved: 'resolved',
	straight: 'straight',
	partial: 'partial',
	unresolved: 'unresolved',
	none: 'no evidence'
};

/**
 * Holes in review order: the ones whose evidence asks for a look (`needsReview`: status not resolved/straight, or a
 * route the sensor did not confirm) first, then the rest; each group by hole number.
 */
export function reviewOrder(holes: readonly AnnotatedHole[], evidenceByHole: ReadonlyMap<string, HoleEvidence>): AnnotatedHole[] {
	const flagged = (hole: AnnotatedHole): boolean => {
		const evidence = evidenceByHole.get(hole.id);
		return evidence ? needsReview(evidence) : false;
	};
	const byNumber = (a: AnnotatedHole, b: AnnotatedHole) => a.number - b.number;
	return [...holes.filter(flagged).sort(byNumber), ...holes.filter((hole) => !flagged(hole)).sort(byNumber)];
}

/** The ids of the holes that need review, in review order. */
export function reviewQueue(holes: readonly AnnotatedHole[], evidenceByHole: ReadonlyMap<string, HoleEvidence>): string[] {
	return reviewOrder(holes, evidenceByHole)
		.filter((hole) => {
			const evidence = evidenceByHole.get(hole.id);
			return evidence ? needsReview(evidence) : false;
		})
		.map((hole) => hole.id);
}

/**
 * The next (`step` 1) or previous (`step` -1) hole of the queue from `currentHoleId`, wrapping. From a hole outside
 * the queue (or none), N starts at the first and P at the last. Null when nothing needs review.
 */
export function stepReviewQueue(queue: readonly string[], currentHoleId: string | null, step: 1 | -1): string | null {
	if (queue.length === 0) return null;
	const index = currentHoleId === null ? -1 : queue.indexOf(currentHoleId);
	if (index === -1) return step === 1 ? queue[0] : queue[queue.length - 1];
	return queue[(index + step + queue.length) % queue.length];
}

/** Source-px bounding box of a hole's points (tee, bends, basket), padded by its corridor half-width. */
export function holeBounds(hole: AnnotatedHole): { xPx: number; yPx: number; widthPx: number; heightPx: number } | null {
	const points = deriveCorridorCenterline(hole);
	if (points.length === 0) return null;
	const pad = hole.corridorWidthPx / 2;
	const xs = points.map((p) => p.xPx);
	const ys = points.map((p) => p.yPx);
	const minX = Math.min(...xs) - pad;
	const minY = Math.min(...ys) - pad;
	return { xPx: minX, yPx: minY, widthPx: Math.max(...xs) + pad - minX, heightPx: Math.max(...ys) + pad - minY };
}

/** Whether a hole differs from the geometry it was loaded with (the reviewer changed it). */
export function holeEdited(hole: AnnotatedHole, original: AnnotatedHole | undefined): boolean {
	if (!original) return true;
	return JSON.stringify(hole) !== JSON.stringify(original);
}
