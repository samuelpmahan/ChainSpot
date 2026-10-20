import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { AnnotatedHole } from '../../src/lib/domain/project';
import {
	HANDLE_HIT_PX,
	LEG_MIN_HIT_PX,
	addBendOnLeg,
	hitTestCourse,
	holeBounds,
	holeEdited,
	moveHandle,
	removeBend,
	reviewOrder,
	reviewQueue,
	stepReviewQueue
} from '../../src/lib/courseCorrection';
import { insertCorridorBend, setCorridorBend } from '../../src/lib/holeAnnotation';
import { parseCourseGeometry } from '../../src/lib/import/courseGeometry';
import type { HoleEvidence } from '../../src/lib/import/courseGeometry';

const view = { zoom: 2, panX: 10, panY: 20 };
const screenOf = (p: { xPx: number; yPx: number }) => ({ x: p.xPx * view.zoom + view.panX, y: p.yPx * view.zoom + view.panY });

const hole = (id: string, number: number, extra: Partial<AnnotatedHole> = {}): AnnotatedHole => ({
	id,
	number,
	tee: { xPx: 0, yPx: 0 },
	basket: { xPx: 200, yPx: 0 },
	shots: [],
	corridorBends: [{ xPx: 100, yPx: 50 }],
	corridorWidthPx: 20,
	...extra
});

describe('hitTestCourse (screen px)', () => {
	const holes = [hole('a', 1)];

	it('finds a handle within HANDLE_HIT_PX of the pointer, and nothing beyond it on empty image', () => {
		const bend = screenOf({ xPx: 100, yPx: 50 });
		expect(hitTestCourse(holes, { x: bend.x + HANDLE_HIT_PX - 1, y: bend.y }, view)).toEqual({ kind: 'bend', holeId: 'a', index: 0 });
		expect(hitTestCourse(holes, screenOf({ xPx: 0, yPx: 0 }), view)).toEqual({ kind: 'tee', holeId: 'a' });
		expect(hitTestCourse(holes, screenOf({ xPx: 200, yPx: 0 }), view)).toEqual({ kind: 'basket', holeId: 'a' });
		expect(hitTestCourse(holes, screenOf({ xPx: 100, yPx: 200 }), view)).toBeNull();
	});

	it('a press on a corridor leg names the leg and the nearest point on its centerline', () => {
		// leg 1 runs bend (100,50) -> basket (200,0); its midpoint is (150,25); 5 px off it is still inside the 10 px half-width.
		const hit = hitTestCourse(holes, screenOf({ xPx: 152, yPx: 29 }), view);
		expect(hit?.kind).toBe('leg');
		if (hit?.kind !== 'leg') return;
		expect(hit.legIndex).toBe(1);
		expect(hit.point.xPx).toBeCloseTo(150, 0);
		expect(hit.point.yPx).toBeCloseTo(25, 0);
	});

	it('the leg reach is the corridor half-width at this zoom, never under LEG_MIN_HIT_PX', () => {
		const zoomedOut = { zoom: 0.1, panX: 0, panY: 0 };
		const long = [hole('a', 1, { basket: { xPx: 2000, yPx: 0 }, corridorBends: [] })];
		// half-width 10 px * 0.1 = 1 screen px; the floor keeps the leg grabbable LEG_MIN_HIT_PX - 1 screen px away
		expect(hitTestCourse(long, { x: 100, y: LEG_MIN_HIT_PX - 1 }, zoomedOut)?.kind).toBe('leg');
		expect(hitTestCourse(long, { x: 100, y: LEG_MIN_HIT_PX + 1 }, zoomedOut)).toBeNull();
		// zoomed in, the corridor itself is the reach: 10 px half-width * 2 = 20 screen px
		expect(hitTestCourse(long, { x: 1000 * 2 + 10, y: 20 + 18 }, view)?.kind).toBe('leg');
	});

	it('ties between holes go to the selected hole', () => {
		const two = [hole('a', 1), hole('b', 2)];
		expect(hitTestCourse(two, screenOf({ xPx: 0, yPx: 0 }), view, 'b')).toEqual({ kind: 'tee', holeId: 'b' });
	});
});

describe('gesture reducers', () => {
	it('a leg click inserts the bend at that leg, keeping the order (no re-sort)', () => {
		const holes = [hole('a', 1)];
		const next = addBendOnLeg(holes, 'a', 0, { xPx: 40, yPx: 30 });
		expect(next[0].corridorBends).toEqual([{ xPx: 40, yPx: 30 }, { xPx: 100, yPx: 50 }]);
		expect(insertCorridorBend(holes, 'a', 5, { xPx: 1, yPx: 1 })).toEqual(holes);
	});

	it('a drag moves the grabbed bend in place, even past another bend', () => {
		const holes = [hole('a', 1, { corridorBends: [{ xPx: 50, yPx: 10 }, { xPx: 150, yPx: 10 }] })];
		const moved = moveHandle(holes, 'a', { kind: 'bend', index: 0 }, { xPx: 180, yPx: 10 });
		expect(moved[0].corridorBends).toEqual([{ xPx: 180, yPx: 10 }, { xPx: 150, yPx: 10 }]);
		expect(setCorridorBend(holes, 'a', 9, { xPx: 0, yPx: 0 })).toEqual(holes);
	});

	it('moves a tee or basket, and removes a bend', () => {
		const holes = [hole('a', 1)];
		expect(moveHandle(holes, 'a', { kind: 'tee' }, { xPx: 5, yPx: 6 })[0].tee).toEqual({ xPx: 5, yPx: 6 });
		expect(moveHandle(holes, 'a', { kind: 'basket' }, { xPx: 7, yPx: 8 })[0].basket).toEqual({ xPx: 7, yPx: 8 });
		expect(removeBend(holes, 'a', 0)[0].corridorBends).toEqual([]);
	});

	it('holeBounds pads by the corridor half-width; holeEdited compares to the loaded hole', () => {
		expect(holeBounds(hole('a', 1))).toEqual({ xPx: -10, yPx: -10, widthPx: 220, heightPx: 70 });
		expect(holeEdited(hole('a', 1), hole('a', 1))).toBe(false);
		expect(holeEdited(removeBend([hole('a', 1)], 'a', 0)[0], hole('a', 1))).toBe(true);
	});
});

describe('review order', () => {
	const ev = (holeId: string, status: HoleEvidence['status'], level: HoleEvidence['confidence']['level']): HoleEvidence => ({ holeId, status, confidence: { level }, reasons: [] });
	const holes = [hole('h1', 1), hole('h2', 2), hole('h3', 3), hole('h4', 4), hole('h5', 5)];

	it('queues partial / unresolved holes AND any route the sensor left unconfirmed or unread, by hole number', () => {
		const evidence = new Map([
			['h1', ev('h1', 'resolved', 'confirmed')],
			['h2', ev('h2', 'resolved', 'unconfirmed')],
			['h3', ev('h3', 'straight', 'noReading')],
			['h4', ev('h4', 'partial', 'confirmed')],
			['h5', ev('h5', 'unresolved', 'noReading')]
		]);
		expect(reviewQueue(holes, evidence)).toEqual(['h2', 'h3', 'h4', 'h5']);
		expect(reviewOrder(holes, evidence).map((h) => h.id)).toEqual(['h2', 'h3', 'h4', 'h5', 'h1']);
	});

	it('N and P walk the queue, wrapping; from outside it N starts first and P last', () => {
		const queue = ['h2', 'h4', 'h5'];
		expect(stepReviewQueue(queue, null, 1)).toBe('h2');
		expect(stepReviewQueue(queue, null, -1)).toBe('h5');
		expect(stepReviewQueue(queue, 'h2', 1)).toBe('h4');
		expect(stepReviewQueue(queue, 'h5', 1)).toBe('h2');
		expect(stepReviewQueue(queue, 'h2', -1)).toBe('h5');
		expect(stepReviewQueue(queue, 'h1', 1)).toBe('h2');
		expect(stepReviewQueue([], 'h1', 1)).toBeNull();
	});

	it('golden: every route is confirmed, so the queue is empty; the review fixture queues its four broken holes', () => {
		const load = (name: string) => {
			const result = parseCourseGeometry(readFileSync(new URL(`../fixtures/course-geometry/${name}`, import.meta.url), 'utf8'));
			if (!result.ok) throw new Error(result.error.message);
			return reviewQueue(result.state.holes, new Map(result.geometry.evidence.map((e) => [e.holeId, e])));
		};
		expect(load('golden.course-geometry.json')).toEqual([]);
		expect(load('golden-review.course-geometry.json')).toEqual(['hole-7', 'hole-10', 'hole-12', 'hole-14']);
	});
});
