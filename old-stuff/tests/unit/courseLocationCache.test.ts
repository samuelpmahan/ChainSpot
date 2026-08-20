// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import Page from '../../src/routes/create-graphics/+page.svelte';
import type { DecodeImageFile } from '../../src/lib/imageIntake';
import { attachCourseLocation, upsertCourse } from '../../src/lib/courseLibrary';
import type { CourseLibraryEntry, CourseLibraryStore } from '../../src/lib/courseLibrary';
import type { LabeledPoint } from '../../src/lib/courseSignature';
import { createAnnotatedRound } from '../../src/lib/domain/annotatedRound';
import type { AnnotatedHole } from '../../src/lib/domain/project';
import {
	consumePendingAnnotatedRound,
	consumePendingCourseBadges,
	setPendingAnnotatedRound,
	setPendingCourseBadges,
	takeRetainedEditor
} from '../../src/lib/session';

const NOW = () => new Date('2026-08-10T00:00:00.000Z');
const SOURCE_SIZE = 2000;

function decodeOf(widthPx: number, heightPx: number): DecodeImageFile {
	return async () => ({ image: document.createElement('img'), widthPx, heightPx });
}

function fakeStore(): CourseLibraryStore {
	const entries = new Map<string, CourseLibraryEntry>();
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

interface Mounted {
	component: ReturnType<typeof mount>;
	host: HTMLDivElement;
}

/**
 * Mounts WITHOUT an injected editor so `participatesInSession` stays true and
 * the page reads the real module-level pending-round/pending-badges session
 * slots on mount — the same mounting shape `annotatedRoundReceipt.test.ts`
 * uses for the same reason. `courseLibraryStore` IS injected (the page's prop
 * for it is independent of session participation) so the library content is
 * fully test-controlled instead of hitting a real IndexedDB.
 */
function mountPage(decode: DecodeImageFile, courseLibraryStore: CourseLibraryStore): Mounted {
	takeRetainedEditor('create-graphics'); // clears any editor a prior test in this file retained
	const host = document.createElement('div');
	document.body.appendChild(host);
	const component = mount(Page, { target: host, props: { decode, courseLibraryStore } });
	return { component, host };
}

async function flush(): Promise<void> {
	for (let i = 0; i < 16; i += 1) {
		await tick();
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

function inputValue(host: HTMLElement, testId: string): string | undefined {
	return host.querySelector<HTMLInputElement>(`[data-testid="${testId}"]`)?.value;
}

/** CHSPT-68: the prefilled inputs and the saved-location note live in the location modal. */
async function openLocationModal(host: HTMLElement): Promise<void> {
	const open = host.querySelector<HTMLButtonElement>('[data-testid="open-location-search"]');
	if (!open) throw new Error('missing open-location-search button');
	open.click();
	await flush();
}

afterEach(() => {
	document.body.replaceChildren();
	consumePendingAnnotatedRound();
	consumePendingCourseBadges();
	vi.unstubAllGlobals();
});

describe('Course Library location cache — import-path prefill', () => {
	it("prefills lat/lon/radius and shows a dismissible note when the imported round's badges match a library entry with a saved location", async () => {
		const store = fakeStore();
		const badges = syntheticBadges(10);
		const baskets = syntheticBaskets(10);
		await upsertCourse(
			store,
			{ projectName: "Dash's Track", numberBadges: badges, baskets, holes: [] },
			{ createId: () => 'course-1', now: NOW }
		);
		await attachCourseLocation(store, badges, baskets, { lat: 33.1255, lon: -96.861, radiusMeters: 900 });

		const holes: AnnotatedHole[] = baskets.map((basket, i) => ({
			id: `hole-${i}`,
			number: basket.holeNumber,
			shots: [],
			basket: { xPx: basket.xPx, yPx: basket.yPx },
			corridorBends: [],
			corridorWidthPx: 40
		}));
		const round = createAnnotatedRound({
			sourceImage: {
				fileName: 'udisc-round.png',
				mimeType: 'image/png',
				widthPx: SOURCE_SIZE,
				heightPx: SOURCE_SIZE,
				blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' })
			},
			holes
		});
		setPendingAnnotatedRound(round);
		setPendingCourseBadges({
			numberBadges: badges.map((badge) => ({ number: badge.holeNumber, xPx: badge.xPx, yPx: badge.yPx, confidence: 0.9 })),
			baskets: []
		});

		const fetchSpy = vi.fn(async (url: string | URL | Request) => {
			expect(String(url)).toContain('imagery.nationalmap.gov');
			return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
				status: 200,
				headers: { 'content-type': 'image/png' }
			});
		});
		vi.stubGlobal('fetch', fetchSpy);

		const { host, component } = mountPage(decodeOf(SOURCE_SIZE, SOURCE_SIZE), store);
		await flush();

		// CHSPT-68 "known state shortens the path": the recognized course
		// surfaces directly on the empty-pane invite — zero extra clicks to see
		// it, and NO imagery fetched without an explicit action.
		const note = host.querySelector('[data-testid="saved-location-note"]');
		expect(note).not.toBeNull();
		expect(note?.textContent).toContain("Dash's Track");
		expect(fetchSpy).not.toHaveBeenCalled();

		// The prefilled coordinate/radius are visible via the modal too.
		await openLocationModal(host);
		expect(inputValue(host, 'naip-lat')).toBe('33.1255');
		expect(inputValue(host, 'naip-lon')).toBe('-96.861');
		expect(inputValue(host, 'naip-radius')).toBe('900');
		host.querySelector<HTMLButtonElement>('[data-testid="location-modal-close"]')?.click();
		await flush();

		// One explicit click fetches at the SAVED geometry (center + 900m radius).
		host.querySelector<HTMLButtonElement>('[data-testid="saved-location-fetch"]')?.click();
		await flush();
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		const bboxParam = new URL(String(fetchSpy.mock.calls[0][0])).searchParams.get('bbox');
		const [minLon, minLat, maxLon, maxLat] = (bboxParam as string).split(',').map(Number);
		expect((minLat + maxLat) / 2).toBeCloseTo(33.1255, 6);
		expect((minLon + maxLon) / 2).toBeCloseTo(-96.861, 6);
		expect(((maxLat - minLat) / 2) * 111_320).toBeCloseTo(900, 3);
		expect(host.querySelector('[data-testid="naip-preview"]')).not.toBeNull();

		// Back on the invite (preview discarded), dismissing the note never
		// reverts the prefilled coordinate.
		host.querySelector<HTMLButtonElement>('[data-testid="naip-discard"]')?.click();
		await flush();
		host.querySelector<HTMLButtonElement>('[data-testid="saved-location-dismiss"]')?.click();
		await flush();
		expect(host.querySelector('[data-testid="saved-location-note"]')).toBeNull();
		await openLocationModal(host);
		expect(inputValue(host, 'naip-lat')).toBe('33.1255');

		unmount(component);
		host.remove();
	});

	it('fetching a DIFFERENT location clears the saved-location note so it never lies about the inputs (review round 2)', async () => {
		const store = fakeStore();
		const badges = syntheticBadges(10);
		const baskets = syntheticBaskets(10);
		await upsertCourse(
			store,
			{ projectName: "Dash's Track", numberBadges: badges, baskets, holes: [] },
			{ createId: () => 'course-1', now: NOW }
		);
		await attachCourseLocation(store, badges, baskets, { lat: 33.1255, lon: -96.861, radiusMeters: 900 });

		const holes: AnnotatedHole[] = baskets.map((basket, i) => ({
			id: `hole-${i}`,
			number: basket.holeNumber,
			shots: [],
			basket: { xPx: basket.xPx, yPx: basket.yPx },
			corridorBends: [],
			corridorWidthPx: 40
		}));
		const round = createAnnotatedRound({
			sourceImage: {
				fileName: 'udisc-round.png',
				mimeType: 'image/png',
				widthPx: SOURCE_SIZE,
				heightPx: SOURCE_SIZE,
				blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' })
			},
			holes
		});
		setPendingAnnotatedRound(round);
		setPendingCourseBadges({
			numberBadges: badges.map((badge) => ({ number: badge.holeNumber, xPx: badge.xPx, yPx: badge.yPx, confidence: 0.9 })),
			baskets: []
		});

		vi.stubGlobal(
			'fetch',
			vi.fn(async () =>
				new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
					status: 200,
					headers: { 'content-type': 'image/png' }
				})
			)
		);

		const { host, component } = mountPage(decodeOf(SOURCE_SIZE, SOURCE_SIZE), store);
		await flush();
		expect(host.querySelector('[data-testid="saved-location-note"]')).not.toBeNull();

		// Fetch some OTHER spot via the modal's manual entry, then discard it.
		await openLocationModal(host);
		const latInput = host.querySelector<HTMLInputElement>('[data-testid="naip-lat"]');
		if (!latInput) throw new Error('missing naip-lat input');
		latInput.value = '40.0';
		latInput.dispatchEvent(new Event('input', { bubbles: true }));
		host.querySelector<HTMLButtonElement>('[data-testid="naip-fetch-button"]')?.click();
		await flush();
		expect(host.querySelector('[data-testid="naip-preview"]')).not.toBeNull();
		host.querySelector<HTMLButtonElement>('[data-testid="naip-discard"]')?.click();
		await flush();

		// The invite is back, but the note must NOT resurface: the inputs no
		// longer point at the saved course, and the one-click button would
		// fetch the wrong place under the saved course's name.
		expect(host.querySelector('[data-testid="clean-target-invite"]')).not.toBeNull();
		expect(host.querySelector('[data-testid="saved-location-note"]')).toBeNull();
		expect(host.querySelector('[data-testid="saved-location-fetch"]')).toBeNull();

		unmount(component);
		host.remove();
	});

	it('shows no note and leaves the default coordinate untouched when no library entry matches', async () => {
		const store = fakeStore();
		const unrelatedBadges: LabeledPoint[] = Array.from({ length: 10 }, (_, i) => ({
			holeNumber: i + 1,
			xPx: 30 * (i % 4) + 5 * Math.sin(i * 4.7) + 500,
			yPx: 30 * Math.floor(i / 4) + 5 * Math.cos(i * 2.1) + 500
		}));
		await upsertCourse(
			store,
			{ projectName: 'Some Other Course', numberBadges: syntheticBadges(10), baskets: syntheticBaskets(10), holes: [] },
			{ createId: () => 'course-1', now: NOW }
		);
		await attachCourseLocation(
			store,
			syntheticBadges(10),
			syntheticBaskets(10),
			{ lat: 1, lon: 1 }
		);

		const round = createAnnotatedRound({
			sourceImage: {
				fileName: 'udisc-round.png',
				mimeType: 'image/png',
				widthPx: SOURCE_SIZE,
				heightPx: SOURCE_SIZE,
				blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' })
			},
			holes: []
		});
		setPendingAnnotatedRound(round);
		setPendingCourseBadges({
			numberBadges: unrelatedBadges.map((badge) => ({
				number: badge.holeNumber,
				xPx: badge.xPx,
				yPx: badge.yPx,
				confidence: 0.9
			})),
			baskets: []
		});

		const defaultLat = '33.12551979622626';
		const { host, component } = mountPage(decodeOf(SOURCE_SIZE, SOURCE_SIZE), store);
		await flush();
		await openLocationModal(host);

		expect(host.querySelector('[data-testid="saved-location-note"]')).toBeNull();
		expect(inputValue(host, 'naip-lat')).toBe(defaultLat);

		unmount(component);
		host.remove();
	});

	it('imports fine (no note, no throw) when the library is entirely empty', async () => {
		const store = fakeStore();
		const badges = syntheticBadges(10);
		const round = createAnnotatedRound({
			sourceImage: {
				fileName: 'udisc-round.png',
				mimeType: 'image/png',
				widthPx: SOURCE_SIZE,
				heightPx: SOURCE_SIZE,
				blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' })
			},
			holes: []
		});
		setPendingAnnotatedRound(round);
		setPendingCourseBadges({
			numberBadges: badges.map((badge) => ({ number: badge.holeNumber, xPx: badge.xPx, yPx: badge.yPx, confidence: 0.9 })),
			baskets: []
		});

		const { host, component } = mountPage(decodeOf(SOURCE_SIZE, SOURCE_SIZE), store);
		await flush();

		expect(host.querySelector('[data-testid="saved-location-note"]')).toBeNull();
		expect(host.querySelector('[data-testid="app-shell"]')).not.toBeNull();

		unmount(component);
		host.remove();
	});
});
