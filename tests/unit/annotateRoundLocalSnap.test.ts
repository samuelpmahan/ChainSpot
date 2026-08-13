// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, tick, unmount } from 'svelte';

/**
 * Interaction coverage for "snap-to-detection" wiring: placing/dragging a
 * tee or basket marker in Map mode fires an async local snap and settles the
 * marker onto the result. Driving the REAL worker/OpenCV here would mean a
 * real WASM pipeline (see `annotateRoundCvUx.test.ts`'s own note on this) —
 * too slow and non-deterministic. `requestLocalSnap` is mocked with a
 * deferred promise so each test can inspect the optimistic raw placement
 * before resolving it to the snap result, exactly like `annotateRoundCvUx
 * .test.ts` scripts `detectCourseCandidates`'s progress/resolution. Real CV
 * (`localFeatureSnap` itself) is covered separately in
 * `tests/unit/localSnap.test.ts`.
 */

const { detectCourseCandidatesMock, prewarmBasketDetectionMock, requestLocalSnapMock } = vi.hoisted(() => ({
	detectCourseCandidatesMock: vi.fn(),
	prewarmBasketDetectionMock: vi.fn().mockResolvedValue(undefined),
	requestLocalSnapMock: vi.fn()
}));

vi.mock('$lib/autoAnnotation/basketDetection', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../src/lib/autoAnnotation/basketDetection')>();
	return {
		...actual,
		detectCourseCandidates: detectCourseCandidatesMock,
		prewarmBasketDetection: prewarmBasketDetectionMock,
		requestLocalSnap: requestLocalSnapMock
	};
});

import Page from '../../src/routes/annotate-round/+page.svelte';
import { ProjectEditor } from '../../src/lib/domain/editor';
import { createProjectState } from '../../src/lib/domain/project';
import type { DecodeImageFile } from '../../src/lib/imageIntake';
import { asNumberTemplateScale } from '../../src/lib/autoAnnotation/cvCalibration';
import type { CourseDetectionResult } from '../../src/lib/autoAnnotation/basketDetection';

const NOW = () => new Date('2026-08-10T00:00:00.000Z');

function decodeOf(widthPx: number, heightPx: number): DecodeImageFile {
	return async () => ({ image: document.createElement('img'), widthPx, heightPx });
}

function makeEditor(): ProjectEditor {
	const state = createProjectState({ createId: () => 'project-1', now: NOW });
	return new ProjectEditor({ state, now: NOW });
}

interface Mounted {
	editor: ProjectEditor;
	component: ReturnType<typeof mount>;
	host: HTMLDivElement;
}

function mountPage(editor: ProjectEditor, decode: DecodeImageFile): Mounted {
	const host = document.createElement('div');
	document.body.appendChild(host);
	const component = mount(Page, { target: host, props: { editor, decode } });
	return { editor, component, host };
}

function scene(host: HTMLElement): HTMLElement {
	const element = host.querySelector<HTMLElement>('[data-testid="pane-scene-source-overview"]');
	if (!element) throw new Error('missing source-overview scene');
	return element;
}

function setGeometry(host: HTMLElement): void {
	const element = scene(host);
	Object.defineProperties(element, {
		clientWidth: { configurable: true, value: 400 },
		clientHeight: { configurable: true, value: 400 },
		clientLeft: { configurable: true, value: 0 },
		clientTop: { configurable: true, value: 0 }
	});
	element.getBoundingClientRect = () =>
		({ left: 0, top: 0, width: 400, height: 400, right: 400, bottom: 400 }) as DOMRect;
}

function dispatchClick(host: HTMLElement, x: number, y: number, options: { altKey?: boolean } = {}): void {
	const element = scene(host);
	const pointerId = 61;
	element.dispatchEvent(
		new PointerEvent('pointerdown', {
			button: 0,
			pointerId,
			clientX: x,
			clientY: y,
			altKey: options.altKey ?? false,
			bubbles: true
		})
	);
	window.dispatchEvent(
		new PointerEvent('pointerup', { pointerId, clientX: x, clientY: y, altKey: options.altKey ?? false })
	);
}

/** Presses down on an existing marker, drags past click-slop, and releases at a new point — the drag-RELEASE path `applyLocalSnap` hooks into. */
function dispatchDrag(
	host: HTMLElement,
	from: { x: number; y: number },
	to: { x: number; y: number },
	options: { altKey?: boolean } = {}
): void {
	const element = scene(host);
	const pointerId = 62;
	element.dispatchEvent(
		new PointerEvent('pointerdown', { button: 0, pointerId, clientX: from.x, clientY: from.y, bubbles: true })
	);
	window.dispatchEvent(new PointerEvent('pointermove', { pointerId, clientX: to.x, clientY: to.y }));
	window.dispatchEvent(
		new PointerEvent('pointerup', { pointerId, clientX: to.x, clientY: to.y, altKey: options.altKey ?? false })
	);
}

function view(host: HTMLElement): { zoom: number; panX: number; panY: number } {
	const dataset = scene(host).dataset;
	return {
		zoom: Number(dataset.viewZoom),
		panX: Number(dataset.viewPanX),
		panY: Number(dataset.viewPanY)
	};
}

function screenPointFor(host: HTMLElement, imageX: number, imageY: number): { x: number; y: number } {
	const { zoom, panX, panY } = view(host);
	return { x: imageX * zoom + panX, y: imageY * zoom + panY };
}

async function flush(): Promise<void> {
	for (let i = 0; i < 16; i += 1) {
		await tick();
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** There is no "add hole" button in the current UI -- handleAnnotationKeyDown wires it to the 'n'/'a' keyboard shortcut only, dispatched on window to match how the app's own window-level listener receives it. */
function addHoleViaShortcut(): void {
	window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', bubbles: true }));
}

/**
 * Geometry must be mocked BEFORE the image loads (not after): `ImageEditorPane`
 * calls `vp.fit()` reactively the moment the image resource becomes
 * available, and `fit()` reads the pane's client size at that exact moment.
 * Mocking geometry afterward leaves that first `fit()` computed against
 * jsdom's real (zero-sized) layout, producing a degenerate near-zero zoom
 * that collapses every image-space point onto nearly the same screen pixel —
 * harmless for a single isolated click, but it makes every hit-test (the
 * number-badge candidate this file's fixture always carries included) fire
 * regardless of how far apart two points actually are in image space, which
 * several tests here rely on distinguishing.
 *
 * Course detection now auto-runs the instant the image loads (there is no
 * "Detect course" button anymore) — the caller must script
 * `detectCourseCandidatesMock` BEFORE calling this, so the auto-detect effect
 * that fires during image load resolves to it.
 */
async function setUpHoleWithImage(host: HTMLElement, editor: ProjectEditor): Promise<void> {
	setGeometry(host);
	const input = host.querySelector<HTMLInputElement>('[data-testid="pane-input-source-overview"]');
	if (!input) throw new Error('missing source input');
	Object.defineProperty(input, 'files', {
		configurable: true,
		value: [new File([new Uint8Array([1, 2, 3, 4])], 'course.png', { type: 'image/png' })]
	});
	input.dispatchEvent(new Event('change', { bubbles: true }));
	await flush();
	void editor;

	addHoleViaShortcut();
	await flush();
}

/** A minimal course-detection result carrying only what snap-to-detection needs: a number-badge anchor to calibrate from. Tees/baskets/grammar are deliberately empty so it never auto-applies anything onto the manually-added hole these tests place markers on. */
function courseDetectionFixture(): CourseDetectionResult {
	return {
		numberDetection: {
			candidates: [
				{ xPx: 40, yPx: 40, widthPx: 20, heightPx: 14, scale: asNumberTemplateScale(1), score: 0.92, badgeScore: 0.92, label: 1 }
			],
			anchor: { label: 1, score: 0.92, scale: asNumberTemplateScale(1), xPx: 40, yPx: 40, widthPx: 20, heightPx: 14 },
			labeling: 'assigned'
		},
		tees: [],
		baskets: [],
		grammar: { holes: [], failures: [], unassigned: { numberBadgeCandidateIndexes: [], teeCandidateIndexes: [], basketCandidateIndexes: [] } }
	};
}

function mockReducedMotion(matches: boolean): void {
	Object.defineProperty(window, 'matchMedia', {
		configurable: true,
		writable: true,
		value: (query: string) => ({
			matches,
			media: query,
			onchange: null,
			addEventListener: () => {},
			removeEventListener: () => {},
			addListener: () => {},
			removeListener: () => {},
			dispatchEvent: () => false
		})
	});
}

/** Resolves a mocked `requestLocalSnap` call on demand, so a test can inspect the optimistic raw placement before the snap result lands. */
function deferredLocalSnap(): { resolve: (point: { xPx: number; yPx: number } | null) => void } {
	let resolveFn!: (point: { xPx: number; yPx: number } | null) => void;
	requestLocalSnapMock.mockImplementationOnce(
		() =>
			new Promise<{ xPx: number; yPx: number } | null>((resolve) => {
				resolveFn = resolve;
			})
	);
	return { resolve: (point) => resolveFn(point) };
}

/** Scripts the mocked course-detection result and loads the image, so the auto-detect effect that fires during image load resolves to a number-badge anchor to calibrate snap requests from. */
async function setUpDetectedHole(host: HTMLElement, editor: ProjectEditor): Promise<void> {
	detectCourseCandidatesMock.mockResolvedValueOnce(courseDetectionFixture());
	await setUpHoleWithImage(host, editor);
	await flush();
}

let mounted: Mounted | null = null;

beforeEach(() => {
	detectCourseCandidatesMock.mockReset();
	requestLocalSnapMock.mockReset();
	// Safe default so any call a test doesn't explicitly script (e.g. the
	// mid-drag/never-called assertions below still trigger a real request on
	// eventual release) resolves to "nothing found" instead of leaving the
	// mock's default `undefined` return crashing `applyLocalSnap`'s `.then`.
	requestLocalSnapMock.mockResolvedValue(null);
	localStorage.clear();
	mockReducedMotion(false);
	// jsdom has no real Worker; course detection now only ever runs via the
	// page's own auto-detect effect (no manual "Detect course" button
	// remains), and that effect no-ops without `Worker` defined — same stub
	// pattern as tests/unit/basketDetection.test.ts. `detectCourseCandidates`
	// itself is fully mocked above, so this stub is never actually
	// constructed; it only needs to make `typeof Worker !== 'undefined'` true.
	vi.stubGlobal('Worker', class {});
});

afterEach(() => {
	if (mounted) {
		unmount(mounted.component);
		mounted.host.remove();
		mounted = null;
	}
});

describe('snap-to-detection — placement via the sidebar-driven placing flow', () => {
	// Tee/basket placement no longer goes through the radial menu — clicking
	// empty map space directly places the missing piece (tee first, then
	// basket) for whichever hole is active, per the redesigned sidebar's
	// placing flow. A single click is the whole interaction now.
	it('places the raw click immediately, then settles onto the snap result', async () => {
		const editor = makeEditor();
		const { component, host } = mountPage(editor, decodeOf(200, 200));
		mounted = { editor, component, host };
		await setUpDetectedHole(host, editor);

		const gate = deferredLocalSnap();
		const clickAt = screenPointFor(host, 150, 150);
		dispatchClick(host, clickAt.x, clickAt.y);
		await tick();

		// Optimistic placement: the marker is already at the raw click before
		// the (still-pending) snap request resolves.
		const marker = () => host.querySelector('[data-testid="tee-marker-1"]');
		expect(marker()?.getAttribute('cx')).toBe('150');
		expect(marker()?.getAttribute('cy')).toBe('150');
		expect(requestLocalSnapMock).toHaveBeenCalledTimes(1);
		expect(requestLocalSnapMock.mock.calls[0]?.[2]).toMatchObject({ kind: 'tee', clickPx: { xPx: 150, yPx: 150 } });

		gate.resolve({ xPx: 65, yPx: 82 });
		await tick();

		expect(marker()?.getAttribute('cx')).toBe('65');
		expect(marker()?.getAttribute('cy')).toBe('82');
		expect(marker()?.classList.contains('settling')).toBe(true);

		await wait(200);
		expect(marker()?.classList.contains('settling')).toBe(false);
	});

	it('a null snap result (no confident feature nearby) leaves the raw placement untouched', async () => {
		const editor = makeEditor();
		const { component, host } = mountPage(editor, decodeOf(200, 200));
		mounted = { editor, component, host };
		await setUpDetectedHole(host, editor);

		// First click places the tee (asked for first, per the placing flow's
		// ordering); the basket this test is actually about is the second.
		requestLocalSnapMock.mockResolvedValueOnce(null);
		const teeAt = screenPointFor(host, 40, 150);
		dispatchClick(host, teeAt.x, teeAt.y);
		await flush();

		requestLocalSnapMock.mockResolvedValueOnce(null);
		const clickAt = screenPointFor(host, 150, 150);
		dispatchClick(host, clickAt.x, clickAt.y);
		await flush();

		const marker = host.querySelector('[data-testid="basket-marker-1"]');
		expect(marker?.getAttribute('cx')).toBe('150');
		expect(marker?.getAttribute('cy')).toBe('150');
		expect(marker?.classList.contains('settling')).toBe(false);
	});

	it('holding Alt on the placement click suppresses the snap request entirely', async () => {
		const editor = makeEditor();
		const { component, host } = mountPage(editor, decodeOf(200, 200));
		mounted = { editor, component, host };
		await setUpDetectedHole(host, editor);

		const clickAt = screenPointFor(host, 150, 150);
		dispatchClick(host, clickAt.x, clickAt.y, { altKey: true });
		await flush();

		expect(requestLocalSnapMock).not.toHaveBeenCalled();
		const marker = host.querySelector('[data-testid="tee-marker-1"]');
		expect(marker?.getAttribute('cx')).toBe('150');
		expect(marker?.getAttribute('cy')).toBe('150');
	});

	it('under prefers-reduced-motion, the settled marker never carries the transition class', async () => {
		mockReducedMotion(true);
		const editor = makeEditor();
		const { component, host } = mountPage(editor, decodeOf(200, 200));
		mounted = { editor, component, host };
		await setUpDetectedHole(host, editor);

		const gate = deferredLocalSnap();
		const clickAt = screenPointFor(host, 150, 150);
		dispatchClick(host, clickAt.x, clickAt.y);
		await tick();

		gate.resolve({ xPx: 65, yPx: 82 });
		await tick();

		const marker = host.querySelector('[data-testid="tee-marker-1"]');
		expect(marker?.getAttribute('cx')).toBe('65');
		expect(marker?.getAttribute('cy')).toBe('82');
		expect(marker?.classList.contains('settling')).toBe(false);
	});
});

describe('snap-to-detection — drag-release of an existing marker', () => {
	/** Places a tee via the placing flow's direct empty-click (the snap request stubbed to resolve null so the marker starts exactly at a known point unaffected by any snap), then clears the mock's call history so the drag-release assertions below see only their own request. */
	async function placeTeeAt(host: HTMLElement, imageX: number, imageY: number): Promise<void> {
		requestLocalSnapMock.mockResolvedValueOnce(null);
		const clickAt = screenPointFor(host, imageX, imageY);
		dispatchClick(host, clickAt.x, clickAt.y);
		await flush();
		requestLocalSnapMock.mockClear();
	}

	it('applies the raw drag endpoint immediately, then settles onto the snap result', async () => {
		const editor = makeEditor();
		const { component, host } = mountPage(editor, decodeOf(200, 200));
		mounted = { editor, component, host };
		await setUpDetectedHole(host, editor);
		await placeTeeAt(host, 150, 150);

		const gate = deferredLocalSnap();
		const from = screenPointFor(host, 150, 150);
		const to = screenPointFor(host, 170, 180);
		dispatchDrag(host, from, to);
		await tick();

		const marker = () => host.querySelector('[data-testid="tee-marker-1"]');
		expect(marker()?.getAttribute('cx')).toBe('170');
		expect(marker()?.getAttribute('cy')).toBe('180');
		expect(requestLocalSnapMock).toHaveBeenCalledTimes(1);
		expect(requestLocalSnapMock.mock.calls[0]?.[2]).toMatchObject({ kind: 'tee', clickPx: { xPx: 170, yPx: 180 } });

		gate.resolve({ xPx: 175, yPx: 178 });
		await tick();

		expect(marker()?.getAttribute('cx')).toBe('175');
		expect(marker()?.getAttribute('cy')).toBe('178');
		expect(marker()?.classList.contains('settling')).toBe(true);
	});

	it('never requests a snap mid-drag — only on release', async () => {
		const editor = makeEditor();
		const { component, host } = mountPage(editor, decodeOf(200, 200));
		mounted = { editor, component, host };
		await setUpDetectedHole(host, editor);
		await placeTeeAt(host, 150, 150);

		const element = scene(host);
		const pointerId = 63;
		const from = screenPointFor(host, 150, 150);
		const mid = screenPointFor(host, 165, 160);
		element.dispatchEvent(
			new PointerEvent('pointerdown', { button: 0, pointerId, clientX: from.x, clientY: from.y, bubbles: true })
		);
		window.dispatchEvent(new PointerEvent('pointermove', { pointerId, clientX: mid.x, clientY: mid.y }));
		await tick();

		expect(requestLocalSnapMock).not.toHaveBeenCalled();

		window.dispatchEvent(new PointerEvent('pointerup', { pointerId, clientX: mid.x, clientY: mid.y }));
		await flush();
		expect(requestLocalSnapMock).toHaveBeenCalledTimes(1);
	});

	it('holding Alt on release suppresses the snap request entirely', async () => {
		const editor = makeEditor();
		const { component, host } = mountPage(editor, decodeOf(200, 200));
		mounted = { editor, component, host };
		await setUpDetectedHole(host, editor);
		await placeTeeAt(host, 150, 150);

		const from = screenPointFor(host, 150, 150);
		const to = screenPointFor(host, 170, 180);
		dispatchDrag(host, from, to, { altKey: true });
		await flush();

		expect(requestLocalSnapMock).not.toHaveBeenCalled();
		const marker = host.querySelector('[data-testid="tee-marker-1"]');
		expect(marker?.getAttribute('cx')).toBe('170');
		expect(marker?.getAttribute('cy')).toBe('180');
	});
});
