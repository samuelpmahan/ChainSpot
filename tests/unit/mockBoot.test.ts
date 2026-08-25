import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fromAnnotationJson, type CorpusAnnotation, type MockCourseFixture } from '$lib/mockBoot';

function annotation(holes: CorpusAnnotation['holes']): CorpusAnnotation {
	return { schemaVersion: 1, holes };
}

describe('fromAnnotationJson', () => {
	test('badge is the midpoint of tee and basket when both exist', () => {
		const holes = fromAnnotationJson(
			annotation([
				{ number: 1, tee: { xPx: 0, yPx: 0 }, basket: { xPx: 10, yPx: 20 } }
			])
		);
		expect(holes[0].badge).toEqual({ xPx: 5, yPx: 10 });
	});

	test('badge falls back to tee when basket is missing', () => {
		const holes = fromAnnotationJson(
			annotation([{ number: 2, tee: { xPx: 3, yPx: 4 }, basket: null }])
		);
		expect(holes[0].badge).toEqual({ xPx: 3, yPx: 4 });
		expect(holes[0].basket).toBeNull();
	});

	test('badge falls back to basket when tee is missing', () => {
		const holes = fromAnnotationJson(
			annotation([{ number: 3, tee: null, basket: { xPx: 7, yPx: 8 } }])
		);
		expect(holes[0].badge).toEqual({ xPx: 7, yPx: 8 });
		expect(holes[0].tee).toBeNull();
	});

	test('throws when a hole has neither tee nor basket', () => {
		expect(() => fromAnnotationJson(annotation([{ number: 4, tee: null, basket: null }]))).toThrow(
			/hole 4/
		);
	});

	test('corridorBends pass through unchanged, defaulting to empty array', () => {
		const bends = [
			{ xPx: 1, yPx: 2 },
			{ xPx: 3, yPx: 4 }
		];
		const holes = fromAnnotationJson(
			annotation([
				{
					number: 5,
					tee: { xPx: 0, yPx: 0 },
					basket: { xPx: 10, yPx: 10 },
					corridorBends: bends
				},
				{ number: 6, tee: { xPx: 0, yPx: 0 }, basket: { xPx: 10, yPx: 10 } }
			])
		);
		expect(holes[0].bends).toEqual(bends);
		expect(holes[1].bends).toEqual([]);
	});

	test('every translated hole is status accepted with zero replacements', () => {
		const holes = fromAnnotationJson(
			annotation([{ number: 7, tee: { xPx: 0, yPx: 0 }, basket: { xPx: 1, yPx: 1 } }])
		);
		expect(holes[0].status).toBe('accepted');
		expect(holes[0].replacements).toEqual({ tee: 0, basket: 0, bend: 0 });
	});

	test('translates the full HeritagePark corpus annotation 1:1 by hole count', () => {
		const raw = readFileSync(
			resolve('../chainspot-corpus/dev/Annotated/Heritage/HeritagePark-full.annotation.json'),
			'utf-8'
		);
		const corpus = JSON.parse(raw) as CorpusAnnotation;
		const holes = fromAnnotationJson(corpus);
		expect(holes.length).toBe(corpus.holes.length);
		expect(holes.map((h) => h.n)).toEqual(corpus.holes.map((h) => h.number));
	});
});

describe.each([
	['heritage', 'static/mock/heritage.json'],
	['dashstrack', 'static/mock/dashstrack.json']
])('%s fixture', (name, path) => {
	test('parses to the MockCourseFixture shape', () => {
		const raw = readFileSync(path, 'utf-8');
		const fixture = JSON.parse(raw) as MockCourseFixture;

		expect(fixture.name).toBe(name);
		expect(Array.isArray(fixture.holes)).toBe(true);
		expect(fixture.holes.length).toBe(18);
		expect(fixture.transform).toBeNull();
		expect(fixture.round).toEqual({ walk: [], droplets: [] });

		for (const hole of fixture.holes) {
			expect(typeof hole.n).toBe('number');
			expect(hole.badge).toHaveProperty('xPx');
			expect(hole.badge).toHaveProperty('yPx');
			expect(hole.status).toBe('accepted');
			expect(Array.isArray(hole.bends)).toBe(true);
		}
	});
});
