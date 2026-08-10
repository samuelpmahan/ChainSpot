import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, tick, unmount } from 'svelte';

// vi.mock is hoisted above every import, so the CV worker module is replaced
// before the page (which imports it directly, not via a prop) ever loads it.
// This is the only way to drive "Detect full course" without a real
// OffscreenCanvas/worker environment, matching this repo's stated jsdom
// canvas limitation (see README.md).
const { mockDetectCourseCandidates } = vi.hoisted(() => ({ mockDetectCourseCandidates: vi.fn() }));
vi.mock('$lib/autoAnnotation/basketDetection', () => ({
	detectCourseCandidates: mockDetectCourseCandidates,
	detectBasketCandidates: vi.fn(),
	detectTees: vi.fn(),
	prewarmBasketDetection: vi.fn()
}));
const { mockGoto } = vi.hoisted(() => ({ mockGoto: vi.fn() }));
vi.mock('$app/navigation', () => ({ goto: mockGoto }));

import Page from '../../src/routes/annotate-round/+page.svelte';
import { ProjectEditor } from '../../src/lib/domain/editor';
import { createProjectState } from '../../src/lib/domain/project';
import type { DecodeImageFile } from '../../src/lib/imageIntake';
import { consumePendingAnnotatedRound, getPendingAnnotatedRound } from '../../src/lib/session';
import { upsertCourse } from '../../src/lib/courseLibrary';
import type { CourseLibraryEntry, CourseLibraryStore } from '../../src/lib/courseLibrary';
import type { LabeledPoint } from '../../src/lib/courseSignature';

const NOW = () => new Date('2026-08-10T00:00:00.000Z');

function decodeOf(widthPx: number, heightPx: number): DecodeImageFile {
	return async () => ({ image: document.createElement('img'), widthPx, heightPx });
}

function makeEditor(): ProjectEditor {
	const state = createProjectState({ createId: () => 'project-1', now: NOW });
	return new ProjectEditor({ state, now: NOW });
}

/** A hand-rolled in-memory fake, per this codebase's injectable-dependency convention. */
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

function transformed(points: readonly LabeledPoint[], scale: number, rotationRad: number, tx: number, ty: number): LabeledPoint[] {
	const cosT = Math.cos(rotationRad);
	const sinT = Math.sin(rotationRad);
	return points.map((point) => ({
		holeNumber: point.holeNumber,
		xPx: scale * (point.xPx * cosT - point.yPx * sinT) + tx,
		yPx: scale * (point.xPx * sinT + point.yPx * cosT) + ty
	}));
}

/** Minimal CourseDetectionResult-shaped mock: only the fields the page actually reads. */
function mockDetectionResult(badges: readonly LabeledPoint[], baskets: readonly LabeledPoint[]) {
	const basketsByHole = new Map(baskets.map((point) => [point.holeNumber, point]));
	const holes = badges.map((badge, i) => {
		const basket = basketsByHole.get(badge.holeNumber);
		return {
			number: badge.holeNumber,
			numberBadge: { candidateIndex: i, xPx: badge.xPx, yPx: badge.yPx, confidence: 0.9, cost: 0 },
			...(basket
				? {
						basket: {
							candidateIndex: i,
							xPx: basket.xPx,
							yPx: basket.yPx,
							detectorConfidence: 0.9,
							confidence: 0.9,
							distancePx: 0,
							polarityCosine: -1,
							cost: 0
						}
					}
				: {}),
			confidence: 0.9,
			status: 'incomplete' as const,
			failures: []
		};
	});
	return {
		numberDetection: { candidates: badges.map(() => ({ label: 1 })) },
		tees: [],
		baskets: baskets.map((point) => ({ xPx: point.xPx, yPx: point.yPx, score: 1, widthPx: 10, heightPx: 10, scale: 1 })),
		grammar: {
			holes,
			failures: [],
			unassigned: { numberBadgeCandidateIndexes: [], teeCandidateIndexes: [], basketCandidateIndexes: [] }
		}
	};
}

interface Mounted {
	editor: ProjectEditor;
	component: ReturnType<typeof mount>;
	host: HTMLDivElement;
}

function mountPage(editor: ProjectEditor, decode: DecodeImageFile, courseLibraryStore: CourseLibraryStore): Mounted {
	const host = document.createElement('div');
	document.body.appendChild(host);
	const component = mount(Page, { target: host, props: { editor, decode, courseLibraryStore } });
	return { editor, component, host };
}

function inputEl(host: HTMLElement, testId: string): HTMLInputElement {
	const input = host.querySelector(`[data-testid="${testId}"]`);
	if (!input || !(input instanceof HTMLInputElement)) throw new Error(`missing input ${testId}`);
	return input;
}

function setFileInput(input: HTMLInputElement, file: File): void {
	Object.defineProperty(input, 'files', { value: [file], configurable: true });
	input.dispatchEvent(new Event('change', { bubbles: true }));
}

async function flush(): Promise<void> {
	for (let i = 0; i < 16; i += 1) {
		await tick();
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

async function loadSourceImage(host: HTMLElement): Promise<void> {
	const fileInput = inputEl(host, 'pane-input-source-overview');
	setFileInput(fileInput, new File([new Uint8Array([1, 2, 3, 4])], 'udisc-round.png', { type: 'image/png' }));
	await flush();
}

afterEach(() => {
	document.body.replaceChildren();
	consumePendingAnnotatedRound();
	mockGoto.mockClear();
	mockDetectCourseCandidates.mockClear();
});

describe('course recognition banner (Course Memory)', () => {
	it('recognizes a differently cropped/zoomed screenshot of a saved course, and Import carries the transformed geometry through to Done', async () => {
		const store = fakeStore();
		const savedBadges = syntheticBadges(10);
		const savedBaskets = syntheticBaskets(10);
		await upsertCourse(
			store,
			{
				projectName: 'My Home Course',
				numberBadges: savedBadges,
				baskets: savedBaskets,
				holes: [
					{
						number: 1,
						tee: { xPx: savedBadges[0].xPx - 20, yPx: savedBadges[0].yPx - 20 },
						basket: { xPx: savedBaskets[0].xPx, yPx: savedBaskets[0].yPx },
						corridorBends: [],
						corridorWidthPx: 60
					}
				]
			},
			{ createId: () => 'course-1', now: NOW }
		);

		// A new screenshot of the SAME course, scaled/rotated/translated (a
		// different crop/zoom), is what the mocked CV pipeline "detects".
		const newBadges = transformed(savedBadges, 1.6, 0.25, 300, -80);
		const newBaskets = transformed(savedBaskets, 1.6, 0.25, 300, -80);
		mockDetectCourseCandidates.mockResolvedValue(mockDetectionResult(newBadges, newBaskets));

		const editor = makeEditor();
		const { host, component } = mountPage(editor, decodeOf(2000, 2000), store);
		await loadSourceImage(host);

		const detectButton = host.querySelector<HTMLButtonElement>('[data-testid="detect-course"]');
		if (!detectButton) throw new Error('missing detect-course button');
		detectButton.click();
		await flush();

		const banner = host.querySelector('[data-testid="course-recognized"]');
		expect(banner).not.toBeNull();
		expect(banner?.textContent).toContain('My Home Course');

		const importButton = host.querySelector<HTMLButtonElement>('[data-testid="course-recognized-import"]');
		if (!importButton) throw new Error('missing course-recognized-import button');
		importButton.click();
		await flush();

		expect(host.querySelector('[data-testid="course-recognized"]')).toBeNull();

		const doneButton = host.querySelector<HTMLButtonElement>('[data-testid="annotate-done"]');
		if (!doneButton) throw new Error('missing annotate-done button');
		doneButton.click();
		await flush();

		const round = getPendingAnnotatedRound();
		expect(round).not.toBeNull();
		const importedHole = round?.holes.find((hole) => hole.number === 1);
		expect(importedHole).toBeDefined();
		expect(importedHole?.basket?.xPx).toBeCloseTo(newBaskets[0].xPx, 0);
		expect(importedHole?.basket?.yPx).toBeCloseTo(newBaskets[0].yPx, 0);

		unmount(component);
		host.remove();
	});

	it('Dismiss clears the banner without importing anything', async () => {
		const store = fakeStore();
		const savedBadges = syntheticBadges(10);
		const savedBaskets = syntheticBaskets(10);
		await upsertCourse(
			store,
			{
				projectName: 'My Home Course',
				numberBadges: savedBadges,
				baskets: savedBaskets,
				holes: [{ number: 1, basket: { xPx: savedBaskets[0].xPx, yPx: savedBaskets[0].yPx }, corridorBends: [], corridorWidthPx: 60 }]
			},
			{ createId: () => 'course-1', now: NOW }
		);
		const newBadges = transformed(savedBadges, 1.1, 0, 10, 10);
		const newBaskets = transformed(savedBaskets, 1.1, 0, 10, 10);
		mockDetectCourseCandidates.mockResolvedValue(mockDetectionResult(newBadges, newBaskets));

		const editor = makeEditor();
		const { host, component } = mountPage(editor, decodeOf(2000, 2000), store);
		await loadSourceImage(host);

		const detectButton = host.querySelector<HTMLButtonElement>('[data-testid="detect-course"]');
		detectButton?.click();
		await flush();
		expect(host.querySelector('[data-testid="course-recognized"]')).not.toBeNull();

		const dismissButton = host.querySelector<HTMLButtonElement>('[data-testid="course-recognized-dismiss"]');
		dismissButton?.click();
		await flush();
		expect(host.querySelector('[data-testid="course-recognized"]')).toBeNull();

		const doneButton = host.querySelector<HTMLButtonElement>('[data-testid="annotate-done"]');
		doneButton?.click();
		await flush();
		expect(getPendingAnnotatedRound()?.holes).toEqual([]);

		unmount(component);
		host.remove();
	});

	it('shows no banner when the detected course does not match anything in the library', async () => {
		const store = fakeStore();
		await upsertCourse(
			store,
			{ projectName: 'Unrelated Course', numberBadges: syntheticBadges(10), baskets: syntheticBaskets(10), holes: [] },
			{ createId: () => 'course-1', now: NOW }
		);

		const differentCourseBadges: LabeledPoint[] = Array.from({ length: 10 }, (_, i) => ({
			holeNumber: i + 1,
			xPx: 30 * (i % 4) + 5 * Math.sin(i * 4.7),
			yPx: 30 * Math.floor(i / 4) + 5 * Math.cos(i * 2.1)
		}));
		mockDetectCourseCandidates.mockResolvedValue(mockDetectionResult(differentCourseBadges, []));

		const editor = makeEditor();
		const { host, component } = mountPage(editor, decodeOf(2000, 2000), store);
		await loadSourceImage(host);

		const detectButton = host.querySelector<HTMLButtonElement>('[data-testid="detect-course"]');
		detectButton?.click();
		await flush();

		expect(host.querySelector('[data-testid="course-recognized"]')).toBeNull();

		unmount(component);
		host.remove();
	});
});
