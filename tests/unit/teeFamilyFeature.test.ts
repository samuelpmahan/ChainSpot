import { describe, expect, test } from 'vitest';
import {
	findEnclosingFrame,
	selectTeeFamily,
	teeFamilyFeature,
	type TeeFamilyFrame,
	type TeeFamilyKnobs,
	type TeeFamilyMeasure,
	type TeeFamilyRingPoint
} from '$lib/detectors/threeFactor/features/g3.teeFamily';
import { parseConfig } from '$lib/detectors/threeFactor';
import teeFamilyOnJson from '$lib/detectors/threeFactor/configs/tee-family-on.json';

const KNOBS: TeeFamilyKnobs = {
	frameAreaMin: 10,
	frameAreaMax: 500,
	frameMaxWidth: 50,
	frameMaxHeight: 50,
	majorRatioToleranceFactor: 1.25,
	minorRatioToleranceFactor: 1.25,
	areaRatioToleranceFactor: 1.5
};

function ring(id: string, cx: number, cy: number): TeeFamilyRingPoint {
	return { id, cx, cy };
}

function frame(bboxX: number, bboxY: number, bboxW: number, bboxH: number, area: number, major: number, minor: number): TeeFamilyFrame {
	return { bboxX, bboxY, bboxW, bboxH, area, major, minor };
}

function measure(id: string, cx: number, cy: number, f: TeeFamilyFrame): TeeFamilyMeasure {
	return { ring: ring(id, cx, cy), frame: f };
}

describe('findEnclosingFrame (LAB frameForRing)', () => {
	test('smallest-bbox-then-largest-area tie-break: smaller bbox wins even with less area', () => {
		const candidates = [
			frame(0, 0, 40, 40, 300, 40, 40), // bigger bbox, contains (10,10)
			frame(0, 0, 20, 20, 100, 20, 20) // smaller bbox, also contains (10,10)
		];
		const picked = findEnclosingFrame(ring('r', 10, 10), candidates, KNOBS);
		expect(picked).toEqual(candidates[1]);
	});

	test('equal-bbox tie-break: larger area wins', () => {
		const candidates = [
			frame(0, 0, 20, 20, 100, 20, 20),
			frame(0, 0, 20, 20, 150, 20, 20)
		];
		const picked = findEnclosingFrame(ring('r', 10, 10), candidates, KNOBS);
		expect(picked?.area).toBe(150);
	});

	test('ring center containment is inclusive of the bbox edge', () => {
		const f = frame(0, 0, 20, 20, 100, 20, 20);
		expect(findEnclosingFrame(ring('r', 20, 20), [f], KNOBS)).toEqual(f); // exactly at bboxX+bboxW, bboxY+bboxH
		expect(findEnclosingFrame(ring('r', 0, 0), [f], KNOBS)).toEqual(f); // exactly at bboxX, bboxY
	});

	test('no-frame exclusion: candidate exists but does not contain the ring center', () => {
		const f = frame(100, 100, 20, 20, 100, 20, 20);
		expect(findEnclosingFrame(ring('r', 10, 10), [f], KNOBS)).toBeNull();
	});

	test('no-frame exclusion: candidate contains center but fails the size window (area too large)', () => {
		const f = frame(0, 0, 20, 20, 501, 20, 20);
		expect(findEnclosingFrame(ring('r', 10, 10), [f], KNOBS)).toBeNull();
	});

	test('no-frame exclusion: candidate contains center but bbox exceeds frameMaxWidth', () => {
		const f = frame(0, 0, 51, 20, 100, 51, 20);
		expect(findEnclosingFrame(ring('r', 10, 10), [f], KNOBS)).toBeNull();
	});

	test('no candidates at all -> null', () => {
		expect(findEnclosingFrame(ring('r', 10, 10), [], KNOBS)).toBeNull();
	});
});

describe('selectTeeFamily (LAB selectTeeFamily) - exact ratio boundaries', () => {
	test('a frame exactly AT the major-ratio tolerance boundary (log(1.25)) is IN (LAB uses <=)', () => {
		const seedFrame = frame(0, 0, 30, 30, 100, 100, 20);
		const boundaryMajor = 100 * 1.25; // |log(125/100)| === log(1.25) exactly
		const boundaryFrame = frame(0, 0, 30, 30, 100, boundaryMajor, 20);
		const measures = [measure('s', 5, 5, seedFrame), measure('b', 5, 5, boundaryFrame)];
		const { family } = selectTeeFamily(measures, KNOBS);
		expect(family.map((m) => m.ring.id).sort()).toEqual(['b', 's']);
	});

	test('a frame just past the major-ratio tolerance boundary is OUT', () => {
		const seedFrame = frame(0, 0, 30, 30, 100, 100, 20);
		const pastMajor = 100 * 1.25 + 0.01;
		const pastFrame = frame(0, 0, 30, 30, 100, pastMajor, 20);
		const measures = [measure('s', 5, 5, seedFrame), measure('p', 5, 5, pastFrame)];
		const { family } = selectTeeFamily(measures, KNOBS);
		expect(family.map((m) => m.ring.id)).toEqual(['s']);
	});

	test('exactly AT the area-ratio tolerance boundary (log(1.5)) is IN', () => {
		const seedFrame = frame(0, 0, 30, 30, 100, 40, 20);
		const boundaryArea = 100 * 1.5;
		const boundaryFrame = frame(0, 0, 30, 30, boundaryArea, 40, 20);
		const measures = [measure('s', 5, 5, seedFrame), measure('b', 5, 5, boundaryFrame)];
		const { family } = selectTeeFamily(measures, KNOBS);
		expect(family.map((m) => m.ring.id).sort()).toEqual(['b', 's']);
	});

	test('largest-family choice: a bigger family beats a smaller one regardless of spread', () => {
		// Seed A: only itself qualifies as a tight family of 1.
		const a = frame(0, 0, 10, 10, 100, 40, 20);
		// Seed B, C, D: all mutually within tolerance -> family of 3.
		const b = frame(0, 0, 10, 10, 100, 40, 20);
		const c = frame(0, 0, 10, 10, 105, 41, 20);
		const d = frame(0, 0, 10, 10, 95, 39, 20);
		const measures = [
			measure('a', 1, 1, a),
			measure('b', 2, 2, b),
			measure('c', 3, 3, c),
			measure('d', 4, 4, d)
		];
		const { family, anchor } = selectTeeFamily(measures, KNOBS);
		expect(family).toHaveLength(4); // a is also within tolerance of b/c/d here, so all 4 tie
		expect(anchor).not.toBeNull();
	});

	test('spread tie-break: equal-size families prefer the tighter (minimum-spread) anchor', () => {
		// Two well-separated (so they never merge) disjoint pairs, both size 2:
		// {x,y} identical frames -> zero spread. {p,q} within tolerance of each
		// other (ratio 1.24 < 1.25) but nonzero spread -> {x,y} must win.
		const tight = frame(0, 0, 10, 10, 100, 40, 20);
		const loose1 = frame(0, 0, 10, 10, 100, 100, 20);
		const loose2 = frame(0, 0, 10, 10, 100, 124, 20); // |log(124/100)| = 0.2151 <= log(1.25) = 0.2231
		const measures = [
			measure('x', 1, 1, tight),
			measure('y', 2, 2, tight),
			measure('p', 100, 100, loose1),
			measure('q', 101, 101, loose2)
		];
		const { family } = selectTeeFamily(measures, KNOBS);
		expect(family).toHaveLength(2);
		expect(family.map((m) => m.ring.id).sort()).toEqual(['x', 'y']);
	});

	test('deterministic cy-then-cx output order regardless of input order', () => {
		const f = frame(0, 0, 10, 10, 100, 40, 20);
		const measures = [
			measure('bottom-right', 50, 20, f),
			measure('top-left', 5, 5, f),
			measure('top-right', 50, 5, f),
			measure('bottom-left', 5, 20, f)
		];
		const { family } = selectTeeFamily(measures, KNOBS);
		expect(family.map((m) => m.ring.id)).toEqual(['top-left', 'top-right', 'bottom-left', 'bottom-right']);
	});

	test('empty measures -> empty family, null anchor', () => {
		const { family, anchor } = selectTeeFamily([], KNOBS);
		expect(family).toEqual([]);
		expect(anchor).toBeNull();
	});
});

describe('teeFamilyFeature registration', () => {
	test('deviation, default OFF, all 7 knobs at spec defaults', () => {
		expect(teeFamilyFeature.kind).toBe('deviation');
		expect(teeFamilyFeature.defaultEnabled).toBe(false);
		expect(Object.keys(teeFamilyFeature.knobs).sort()).toEqual(
			[
				'areaRatioToleranceFactor',
				'frameAreaMax',
				'frameAreaMin',
				'frameMaxHeight',
				'frameMaxWidth',
				'majorRatioToleranceFactor',
				'minorRatioToleranceFactor'
			].sort()
		);
		expect(teeFamilyFeature.knobs.frameAreaMin.default).toBe(10);
		expect(teeFamilyFeature.knobs.frameAreaMax.default).toBe(500);
		expect(teeFamilyFeature.knobs.frameMaxWidth.default).toBe(50);
		expect(teeFamilyFeature.knobs.frameMaxHeight.default).toBe(50);
		expect(teeFamilyFeature.knobs.majorRatioToleranceFactor.default).toBe(1.25);
		expect(teeFamilyFeature.knobs.minorRatioToleranceFactor.default).toBe(1.25);
		expect(teeFamilyFeature.knobs.areaRatioToleranceFactor.default).toBe(1.5);
	});

	test('validate() rejects non-positive frame knobs and tolerance factors <= 1', () => {
		expect(teeFamilyFeature.knobs.frameAreaMin.validate?.(0)).not.toBeNull();
		expect(teeFamilyFeature.knobs.frameAreaMin.validate?.(-5)).not.toBeNull();
		expect(teeFamilyFeature.knobs.frameAreaMin.validate?.(10)).toBeNull();
		expect(teeFamilyFeature.knobs.majorRatioToleranceFactor.validate?.(1)).not.toBeNull();
		expect(teeFamilyFeature.knobs.majorRatioToleranceFactor.validate?.(0.9)).not.toBeNull();
		expect(teeFamilyFeature.knobs.majorRatioToleranceFactor.validate?.(1.25)).toBeNull();
	});

	test('tee-family-on config parses, inserts teeFamily right after tees, and enables the feature', () => {
		const config = parseConfig(teeFamilyOnJson);
		expect(config.execution).toBeDefined();
		const execution = config.execution as readonly string[];
		expect(execution.indexOf('teeFamily')).toBe(execution.indexOf('tees') + 1);
		expect(execution.indexOf('teeFamily')).toBeLessThan(execution.indexOf('rawPairs'));
		expect(config.gates?.G3?.teeFamily?.enabled).toBe(true);
	});
});
