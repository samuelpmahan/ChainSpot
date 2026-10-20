import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { AnnotatedHole } from '../../src/lib/domain/project';
import {
	HANDLE_HIT_PX,
	LEG_MIN_HIT_PX,
	addBendOnLeg,
	adoptAlternative,
	alternativesDisagree,
	hitTestAlternative,
	hitTestCourse,
	reviewReason,
	routeSeparationPx,
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

	it('golden: every route is confirmed, so the queue is empty; the review fixture queues its four broken holes and the one whose alternative disagrees', () => {
		const load = (name: string) => {
			const result = parseCourseGeometry(readFileSync(new URL(`../fixtures/course-geometry/${name}`, import.meta.url), 'utf8'));
			if (!result.ok) throw new Error(result.error.message);
			return reviewQueue(result.state.holes, new Map(result.geometry.evidence.map((e) => [e.holeId, e])));
		};
		expect(load('golden.course-geometry.json')).toEqual([]);
		expect(load('golden-review.course-geometry.json')).toEqual(['hole-3', 'hole-7', 'hole-10', 'hole-12', 'hole-14']);
	});
});

describe('alternative routes', () => {
	const primary = hole('a', 1); // tee (0,0) -> bend (100,50) -> basket (200,0), corridor 20 px
	const alt = (verts: [number, number][], ruleSets = ['r']) => ({ verts, ruleSets });
	const ev = (alternatives: ReturnType<typeof alt>[]): HoleEvidence => ({ holeId: 'a', status: 'resolved', confidence: { level: 'confirmed' }, reasons: [], alternatives });

	it('measures route separation in source px, symmetric and vertex-to-polyline', () => {
		const line = [{ xPx: 0, yPx: 0 }, { xPx: 100, yPx: 50 }, { xPx: 200, yPx: 0 }];
		expect(routeSeparationPx(line, line)).toBe(0);
		expect(routeSeparationPx(line, [{ xPx: 0, yPx: 0 }, { xPx: 200, yPx: 0 }])).toBeCloseTo(Math.hypot(100, 50) * Math.sin(Math.atan2(50, 100)), 6);
	});

	it('an alternative disagrees when it is more than half the corridor width from the primary', () => {
		expect(alternativesDisagree(primary, ev([alt([[0, 0], [104, 46], [200, 0]])]))).toBe(false);
		expect(alternativesDisagree(primary, ev([alt([[0, 0], [100, 80], [200, 0]])]))).toBe(true);
		expect(alternativesDisagree(primary, ev([]))).toBe(false);
		expect(alternativesDisagree(primary, undefined)).toBe(false);
	});

	it('a disagreeing alternative puts a confirmed hole in the walk; judged against the loaded primary', () => {
		const disagreeing = ev([alt([[0, 0], [100, 80], [200, 0]])]);
		expect(reviewReason(primary, disagreeing)).toBe('alternatives');
		const adopted = adoptAlternative([primary], 'a', disagreeing.alternatives![0])[0];
		expect(reviewReason(adopted, disagreeing, primary)).toBe('alternatives');
		expect(reviewQueue([adopted], new Map([['a', disagreeing]]), new Map([['a', primary]]))).toEqual(['a']);
	});

	it('adopting takes tee, bends and basket from the alternative', () => {
		const next = adoptAlternative([primary], 'a', alt([[1, 2], [50, 60], [120, 70], [199, 3]]));
		expect(next[0]).toMatchObject({ tee: { xPx: 1, yPx: 2 }, basket: { xPx: 199, yPx: 3 }, corridorBends: [{ xPx: 50, yPx: 60 }, { xPx: 120, yPx: 70 }] });
		expect(next[0].corridorWidthPx).toBe(primary.corridorWidthPx);
	});

	it('hits the nearest ghost within the corridor reach (screen px)', () => {
		const alternatives = [alt([[0, 0], [100, 150], [200, 0]]), alt([[0, 0], [100, -150], [200, 0]])];
		expect(hitTestAlternative(primary, alternatives, screenOf({ xPx: 100, yPx: 148 }), view)).toBe(0);
		expect(hitTestAlternative(primary, alternatives, screenOf({ xPx: 100, yPx: -146 }), view)).toBe(1);
		expect(hitTestAlternative(primary, alternatives, screenOf({ xPx: 100, yPx: 400 }), view)).toBeNull();
	});
});

describe('parseCourseGeometry: evidence alternatives', () => {
	const text = readFileSync(new URL('../fixtures/course-geometry/golden.course-geometry.json', import.meta.url), 'utf8');
	const edit = (change: (doc: Record<string, any>) => void) => {
		const doc = JSON.parse(text);
		change(doc);
		return parseCourseGeometry(JSON.stringify(doc));
	};

	it('absent alternatives read as none (exports that predate the field)', () => {
		const result = parseCourseGeometry(text);
		expect(result.ok && result.geometry.evidence.every((e) => e.alternatives?.length === 0)).toBe(true);
	});

	it('reads verts, rule sets, sensor and contrast', () => {
		const result = edit((doc) => (doc.evidence[0].alternatives = [{ verts: [[1, 2], [3, 4]], ruleSets: ['s7-a', 's7-b'], sensor: { passFrac: 0.9, stations: 40 }, contrastLum: 11.5 }]));
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.geometry.evidence[0].alternatives).toEqual([{ verts: [[1, 2], [3, 4]], ruleSets: ['s7-a', 's7-b'], sensor: { passFrac: 0.9, stations: 40 }, contrastLum: 11.5 }]);
	});

	it('a malformed or out-of-frame alternative is a structure error, not a throw', () => {
		const code = (r: ReturnType<typeof parseCourseGeometry>) => (r.ok ? 'ok' : r.error.code);
		expect(code(edit((doc) => (doc.evidence[0].alternatives = [{ verts: [[1, 2]], ruleSets: [] }])))).toBe('structure.invalid');
		expect(code(edit((doc) => (doc.evidence[0].alternatives = [{ verts: [[1, 2], [5000, 4]], ruleSets: [] }])))).toBe('structure.invalid');
		expect(code(edit((doc) => (doc.evidence[0].alternatives = 'x')))).toBe('structure.invalid');
	});
});
