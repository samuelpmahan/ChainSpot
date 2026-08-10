import { describe, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import {
	applyLibraryEntry,
	findExactMatches,
	findFuzzyMatches,
	IndexedDbCourseLibraryStore,
	upsertCourse
} from '../../src/lib/courseLibrary';
import type { CourseLibraryEntry, CourseLibraryHole, CourseLibraryStore } from '../../src/lib/courseLibrary';
import type { LabeledPoint } from '../../src/lib/courseSignature';
import { matchSignatures } from '../../src/lib/courseSignature';
import type { AnnotatedHole } from '../../src/lib/domain/project';

const NOW = () => new Date('2026-08-10T00:00:00.000Z');
const LATER = () => new Date('2026-08-10T01:00:00.000Z');

/** A hand-rolled in-memory fake, per this codebase's injectable-dependency convention — no real IndexedDB needed. */
function fakeStore(seed: readonly CourseLibraryEntry[] = []): CourseLibraryStore {
	const entries = new Map(seed.map((entry) => [entry.id, entry]));
	return {
		async getAll() {
			return [...entries.values()];
		},
		async put(entry) {
			entries.set(entry.id, entry);
		},
		async delete(id) {
			entries.delete(id);
		}
	};
}

function syntheticBadges(n: number): LabeledPoint[] {
	return Array.from({ length: n }, (_, i) => ({
		holeNumber: i + 1,
		xPx: 100 * (i + 1) + 60 * Math.sin((i + 1) * 1.7),
		yPx: 200 + 45 * Math.cos((i + 1) * 0.9) + 15 * (i + 1)
	}));
}

function syntheticBaskets(n: number): LabeledPoint[] {
	return syntheticBadges(n).map((badge) => ({
		holeNumber: badge.holeNumber,
		xPx: badge.xPx + 80 * Math.cos(badge.holeNumber * 1.3) + 40,
		yPx: badge.yPx + 60 * Math.sin(badge.holeNumber * 1.3) + 55
	}));
}

function transformed(points: readonly LabeledPoint[], scale: number, rotationRad: number, tx: number, ty: number): LabeledPoint[] {
	const cosT = Math.cos(rotationRad);
	const sinT = Math.sin(rotationRad);
	return points.map((point) => ({
		holeNumber: point.holeNumber,
		xPx: scale * (point.xPx * cosT - point.yPx * sinT) + tx,
		yPx: scale * (point.xPx * sinT + point.yPx * cosT) + ty
	}));
}

describe('upsertCourse', () => {
	it('inserts a fresh entry when the library is empty', async () => {
		const store = fakeStore();
		const entry = await upsertCourse(
			store,
			{ projectName: 'Round 1', numberBadges: syntheticBadges(10), baskets: syntheticBaskets(10), holes: [] },
			{ createId: () => 'course-1', now: NOW }
		);
		expect(entry).not.toBeNull();
		expect(entry?.id).toBe('course-1');
		expect(entry?.name).toBe('Round 1');
		expect(entry?.createdAt).toBe(NOW().toISOString());
		expect(await store.getAll()).toHaveLength(1);
	});

	it('returns null and writes nothing when badges are below MIN_SIGNATURE_HOLES', async () => {
		const store = fakeStore();
		const entry = await upsertCourse(store, {
			projectName: 'Too few holes',
			numberBadges: syntheticBadges(3),
			baskets: [],
			holes: []
		});
		expect(entry).toBeNull();
		expect(await store.getAll()).toHaveLength(0);
	});

	it('updates the existing entry in place (same id) on a near-identical re-save, instead of duplicating', async () => {
		const store = fakeStore();
		const first = await upsertCourse(
			store,
			{ projectName: 'Round 1', numberBadges: syntheticBadges(12), baskets: syntheticBaskets(12), holes: [] },
			{ createId: () => 'course-1', now: NOW }
		);
		expect(first).not.toBeNull();

		// A slightly different screenshot of the SAME course: transformed, plus one extra hole annotated.
		const resavedBadges = transformed(syntheticBadges(12), 1.05, 0.02, 15, -8);
		const resavedBaskets = transformed(syntheticBaskets(12), 1.05, 0.02, 15, -8);
		const second = await upsertCourse(
			store,
			{ projectName: 'Round 1 (resaved)', numberBadges: resavedBadges, baskets: resavedBaskets, holes: [] },
			{ createId: () => 'course-2', now: LATER }
		);

		expect(second?.id).toBe('course-1');
		expect(second?.createdAt).toBe(NOW().toISOString());
		expect(second?.updatedAt).toBe(LATER().toISOString());
		expect(second?.name).toBe('Round 1 (resaved)');
		expect(await store.getAll()).toHaveLength(1);
	});

	it('inserts a second, independent entry for a geometrically unrelated course', async () => {
		const store = fakeStore();
		await upsertCourse(
			store,
			{ projectName: 'Course A', numberBadges: syntheticBadges(10), baskets: syntheticBaskets(10), holes: [] },
			{ createId: () => 'course-a', now: NOW }
		);
		const unrelatedBadges: LabeledPoint[] = Array.from({ length: 10 }, (_, i) => ({
			holeNumber: i + 1,
			xPx: 40 * (i % 5) + 7 * Math.sin(i * 5.1),
			yPx: 40 * Math.floor(i / 5) + 7 * Math.cos(i * 3.3)
		}));
		await upsertCourse(
			store,
			{ projectName: 'Course B', numberBadges: unrelatedBadges, baskets: [], holes: [] },
			{ createId: () => 'course-b', now: LATER }
		);
		expect(await store.getAll()).toHaveLength(2);
	});
});

describe('findExactMatches / findFuzzyMatches', () => {
	it('finds an exact hash match and excludes non-matching entries', async () => {
		const store = fakeStore();
		const entry = await upsertCourse(
			store,
			{ projectName: 'Round 1', numberBadges: syntheticBadges(8), baskets: syntheticBaskets(8), holes: [] },
			{ createId: () => 'course-1', now: NOW }
		);
		expect(entry?.signatureHash).not.toBeNull();

		const exact = await findExactMatches(store, entry!.signatureHash!);
		expect(exact.map((match) => match.id)).toEqual(['course-1']);

		const noMatch = await findExactMatches(store, 'deadbeef'.repeat(8));
		expect(noMatch).toHaveLength(0);
	});

	it('finds a fuzzy match against a differently cropped/zoomed screenshot and sorts by confidence', async () => {
		const store = fakeStore();
		await upsertCourse(
			store,
			{ projectName: 'Round 1', numberBadges: syntheticBadges(14), baskets: syntheticBaskets(14), holes: [] },
			{ createId: () => 'course-1', now: NOW }
		);

		const target = {
			badges: transformed(syntheticBadges(14), 1.4, 0.3, 200, -60),
			baskets: transformed(syntheticBaskets(14), 1.4, 0.3, 200, -60)
		};
		const results = await findFuzzyMatches(store, target);
		expect(results).toHaveLength(1);
		expect(results[0].entry.id).toBe('course-1');
		expect(results[0].matched).toBe(true);
	});

	it('excludes an unrelated course from fuzzy results', async () => {
		const store = fakeStore();
		await upsertCourse(
			store,
			{ projectName: 'Round 1', numberBadges: syntheticBadges(10), baskets: syntheticBaskets(10), holes: [] },
			{ createId: () => 'course-1', now: NOW }
		);
		const unrelated = {
			badges: Array.from({ length: 10 }, (_, i) => ({ holeNumber: i + 1, xPx: 5 * i, yPx: 900 - 3 * i })),
			baskets: []
		};
		expect(await findFuzzyMatches(store, unrelated)).toHaveLength(0);
	});
});

describe('applyLibraryEntry', () => {
	function libraryEntry(holes: readonly CourseLibraryHole[]): CourseLibraryEntry {
		return {
			id: 'course-1',
			name: 'Round 1',
			createdAt: NOW().toISOString(),
			updatedAt: NOW().toISOString(),
			signatureHash: 'a'.repeat(64),
			badges: syntheticBadges(6),
			baskets: syntheticBaskets(6),
			holes
		};
	}

	it('transforms tee/basket/corridorBends into the new pixel space and scales corridorWidthPx', () => {
		const entry = libraryEntry([
			{
				number: 1,
				tee: { xPx: 10, yPx: 20 },
				basket: { xPx: 110, yPx: 220 },
				corridorBends: [{ xPx: 50, yPx: 100 }],
				corridorWidthPx: 60
			}
		]);
		const source = { badges: syntheticBadges(6), baskets: syntheticBaskets(6) };
		const target = {
			badges: transformed(syntheticBadges(6), 2, Math.PI / 6, 40, -30),
			baskets: transformed(syntheticBaskets(6), 2, Math.PI / 6, 40, -30)
		};
		const match = matchSignatures(source, target);
		expect(match.matched).toBe(true);

		const result = applyLibraryEntry(entry, match, []);
		expect(result).toHaveLength(1);
		const hole = result[0];
		expect(hole.number).toBe(1);
		expect(hole.shots).toEqual([]);

		const cosT = Math.cos(Math.PI / 6);
		const sinT = Math.sin(Math.PI / 6);
		const expectedTee = { xPx: 2 * (10 * cosT - 20 * sinT) + 40, yPx: 2 * (10 * sinT + 20 * cosT) - 30 };
		expect(hole.tee!.xPx).toBeCloseTo(expectedTee.xPx, 1);
		expect(hole.tee!.yPx).toBeCloseTo(expectedTee.yPx, 1);
		expect(hole.corridorWidthPx).toBeCloseTo(120, 0); // scaled by the recovered ~2x transform
	});

	it('is a no-op copy when the match is not confident', () => {
		const entry = libraryEntry([{ number: 1, corridorBends: [], corridorWidthPx: 60 }]);
		const unmatched = matchSignatures(
			{ badges: syntheticBadges(6), baskets: [] },
			{ badges: [{ holeNumber: 1, xPx: 0, yPx: 0 }], baskets: [] }
		);
		expect(unmatched.matched).toBe(false);
		const existing: AnnotatedHole[] = [{ id: 'h1', number: 5, shots: [], corridorBends: [], corridorWidthPx: 40 }];
		expect(applyLibraryEntry(entry, unmatched, existing)).toEqual(existing);
	});

	it('skipExisting protects already-populated fields on an existing hole', () => {
		const entry = libraryEntry([
			{
				number: 1,
				tee: { xPx: 10, yPx: 20 },
				basket: { xPx: 110, yPx: 220 },
				corridorBends: [{ xPx: 50, yPx: 100 }],
				corridorWidthPx: 60
			}
		]);
		const source = { badges: syntheticBadges(6), baskets: syntheticBaskets(6) };
		const target = { badges: transformed(syntheticBadges(6), 1, 0, 5, 5), baskets: transformed(syntheticBaskets(6), 1, 0, 5, 5) };
		const match = matchSignatures(source, target);
		expect(match.matched).toBe(true);

		const existingTee = { xPx: 999, yPx: 999 };
		const existing: AnnotatedHole[] = [
			{ id: 'h1', number: 1, shots: [{ id: 's1', landing: { xPx: 1, yPx: 1 } }], tee: existingTee, corridorBends: [], corridorWidthPx: 77 }
		];

		const kept = applyLibraryEntry(entry, match, existing, { skipExisting: true });
		expect(kept[0].tee).toEqual(existingTee);
		expect(kept[0].shots).toEqual(existing[0].shots);
		// basket had no existing value, so it's still filled from the library.
		expect(kept[0].basket).toBeDefined();
		// corridorBends had no existing value (empty), so it's still filled.
		expect(kept[0].corridorBends).toHaveLength(1);

		const replaced = applyLibraryEntry(entry, match, existing, { skipExisting: false });
		expect(replaced[0].tee).not.toEqual(existingTee);
	});
});

describe('IndexedDbCourseLibraryStore', () => {
	function freshFactory(): IDBFactory {
		// jsdom has no real IndexedDB; a fresh fake-indexeddb factory per test
		// keeps this suite isolated from any other test's database state.
		return new IDBFactory();
	}

	function entryOf(id: string): CourseLibraryEntry {
		return {
			id,
			name: `Course ${id}`,
			createdAt: NOW().toISOString(),
			updatedAt: NOW().toISOString(),
			signatureHash: 'a'.repeat(64),
			badges: syntheticBadges(6),
			baskets: syntheticBaskets(6),
			holes: []
		};
	}

	it('round-trips put/getAll/delete against the real IndexedDB request/transaction API', async () => {
		const store = new IndexedDbCourseLibraryStore(freshFactory());
		expect(await store.getAll()).toEqual([]);

		await store.put(entryOf('course-1'));
		await store.put(entryOf('course-2'));
		const all = await store.getAll();
		expect(all.map((entry) => entry.id).sort()).toEqual(['course-1', 'course-2']);

		await store.delete('course-1');
		expect((await store.getAll()).map((entry) => entry.id)).toEqual(['course-2']);
	});

	it('put overwrites an entry with the same id rather than duplicating it', async () => {
		const store = new IndexedDbCourseLibraryStore(freshFactory());
		await store.put(entryOf('course-1'));
		await store.put({ ...entryOf('course-1'), name: 'Renamed' });
		const all = await store.getAll();
		expect(all).toHaveLength(1);
		expect(all[0].name).toBe('Renamed');
	});

	it('works as the store behind upsertCourse/findExactMatches end to end', async () => {
		const store = new IndexedDbCourseLibraryStore(freshFactory());
		const entry = await upsertCourse(
			store,
			{ projectName: 'Round 1', numberBadges: syntheticBadges(10), baskets: syntheticBaskets(10), holes: [] },
			{ createId: () => 'course-1', now: NOW }
		);
		expect(entry).not.toBeNull();
		const exact = await findExactMatches(store, entry!.signatureHash!);
		expect(exact.map((match) => match.id)).toEqual(['course-1']);
	});
});
