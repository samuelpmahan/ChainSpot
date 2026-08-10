import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, tick, unmount } from 'svelte';

/**
 * Component-level coverage for the "Detected CV UX" feature: the status
 * strip, staged candidate reveal, the review summary chip, and click-to-
 * assign. Driving the REAL basket-detection worker here would mean a real
 * OpenCV WASM pipeline against a real UDisc screenshot (measured elsewhere in
 * this codebase's e2e suite at 10-12s+ just for a lighter warm-up) — too slow
 * and non-deterministic for the range of stage-timing and interaction
 * variations this file covers. Per the task's own guidance, the worker
 * boundary (`detectCourseCandidates`) is mocked with a scripted progress
 * sequence and a fixed result, exactly like `$app/navigation` is already
 * mocked in `annotateRoundPage.test.ts` — everything downstream of that
 * boundary (the status strip, the reveal, the summary chip, and every
 * click-to-assign code path) is real, unmocked page code.
 */

const { detectCourseCandidatesMock, prewarmBasketDetectionMock } = vi.hoisted(() => ({
	detectCourseCandidatesMock: vi.fn(),
	prewarmBasketDetectionMock: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('$lib/autoAnnotation/basketDetection', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../src/lib/autoAnnotation/basketDetection')>();
	return {
		...actual,
		detectCourseCandidates: detectCourseCandidatesMock,
		prewarmBasketDetection: prewarmBasketDetectionMock
	};
});

import Page from '../../src/routes/annotate-round/+page.svelte';
import { ProjectEditor } from '../../src/lib/domain/editor';
import { createProjectState } from '../../src/lib/domain/project';
import type { DecodeImageFile } from '../../src/lib/imageIntake';
import { asNumberTemplateScale, asBasketTemplateScale } from '../../src/lib/autoAnnotation/cvCalibration';
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

/** Places the scene's origin at (0,0) in viewport coordinates, one-to-one with clientX/Y. */
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

function dispatchClick(host: HTMLElement, x: number, y: number): void {
	const element = scene(host);
	const pointerId = 41;
	element.dispatchEvent(
		new PointerEvent('pointerdown', { button: 0, pointerId, clientX: x, clientY: y, bubbles: true })
	);
	window.dispatchEvent(new PointerEvent('pointerup', { pointerId, clientX: x, clientY: y }));
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

async function loadImage(host: HTMLElement): Promise<void> {
	// Geometry must be mocked BEFORE the image loads: `ImageEditorPane` calls
	// `vp.fit()` reactively the moment the image resource becomes available,
	// and fit() reads the pane's client size at that exact moment. Mocking
	// geometry afterward leaves that first fit() computed against jsdom's
	// real (zero-sized) layout, producing a degenerate near-zero zoom that
	// makes every marker's screen position collapse toward the same point —
	// harmless for a single-marker click, but it starts mis-hit-testing
	// between distinct nearby candidates, which several tests below click.
	setGeometry(host);
	const input = host.querySelector<HTMLInputElement>('[data-testid="pane-input-source-overview"]');
	if (!input) throw new Error('missing source input');
	Object.defineProperty(input, 'files', {
		configurable: true,
		value: [new File([new Uint8Array([1, 2, 3, 4])], 'course.png', { type: 'image/png' })]
	});
	input.dispatchEvent(new Event('change', { bubbles: true }));
	await flush();
}

/**
 * A two-hole fixture: hole 1 is fully ready (numberBadge + tee + basket, all
 * confident); hole 2 has a badge and a tee but no basket, leaving its basket
 * candidate (courseDetection.baskets[1]) unassigned — the click-to-assign
 * target every interaction test below uses.
 */
function courseDetectionFixture(): CourseDetectionResult {
	return {
		numberDetection: {
			candidates: [
				{ xPx: 40, yPx: 40, widthPx: 20, heightPx: 14, scale: asNumberTemplateScale(1), score: 0.92, badgeScore: 0.92, label: 1 },
				{ xPx: 140, yPx: 40, widthPx: 20, heightPx: 14, scale: asNumberTemplateScale(1), score: 0.92, badgeScore: 0.92, label: 2 }
			],
			anchor: { label: 1, score: 0.92, scale: asNumberTemplateScale(1), xPx: 40, yPx: 40, widthPx: 20, heightPx: 14 },
			labeling: 'assigned'
		},
		tees: [
			{ xPx: 40, yPx: 80, widthPx: 12, heightPx: 12, orientationDeg: 0, score: 0.9, support: ['gray-center'] },
			{ xPx: 140, yPx: 80, widthPx: 12, heightPx: 12, orientationDeg: 0, score: 0.9, support: ['gray-center'] }
		],
		baskets: [
			{ xPx: 40, yPx: 160, widthPx: 10, heightPx: 10, score: 0.9, scale: asBasketTemplateScale(1) },
			{ xPx: 140, yPx: 160, widthPx: 10, heightPx: 10, score: 0.9, scale: asBasketTemplateScale(1) }
		],
		grammar: {
			holes: [
				{
					number: 1,
					numberBadge: { candidateIndex: 0, xPx: 40, yPx: 40, confidence: 0.92, cost: 0.08 },
					tee: { candidateIndex: 0, xPx: 40, yPx: 80, detectorConfidence: 0.9, confidence: 0.9, distancePx: 40 },
					basket: {
						candidateIndex: 0,
						xPx: 40,
						yPx: 160,
						detectorConfidence: 0.9,
						confidence: 0.9,
						distancePx: 80,
						polarityCosine: -1,
						cost: 10
					},
					confidence: 0.9,
					status: 'ready',
					failures: []
				},
				{
					number: 2,
					numberBadge: { candidateIndex: 1, xPx: 140, yPx: 40, confidence: 0.92, cost: 0.08 },
					tee: { candidateIndex: 1, xPx: 140, yPx: 80, detectorConfidence: 0.9, confidence: 0.9, distancePx: 40 },
					confidence: 0.4,
					status: 'review',
					failures: [
						{
							kind: 'missing-basket',
							severity: 'error',
							holeNumber: 2,
							message: 'Hole 2 has no unclaimed basket candidate.'
						}
					]
				}
			],
			failures: [],
			unassigned: { numberBadgeCandidateIndexes: [], teeCandidateIndexes: [], basketCandidateIndexes: [1] }
		}
	};
}

/** Resolves the mocked detection after emitting a couple of real (stubbed) progress messages, so the status strip has stages to render. */
function resolveDetectionWithProgress(): { resolve: () => void } {
	let resolveFn!: () => void;
	detectCourseCandidatesMock.mockImplementationOnce(
		(
			_bytes: Uint8Array,
			_mime: string,
			_w: number,
			_h: number,
			onProgress?: (progress: { stage: string; message: string; elapsedMs?: number }) => void
		) => {
			onProgress?.({ stage: 'numbers', message: '2 templates loaded · matching hole numbers…' });
			return new Promise<CourseDetectionResult>((resolve) => {
				resolveFn = () => {
					onProgress?.({ stage: 'grammar', message: '2 tees found · matching course grammar…' });
					resolve(courseDetectionFixture());
				};
			});
		}
	);
	return {
		resolve: () => resolveFn()
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

let mounted: Mounted | null = null;

beforeEach(() => {
	detectCourseCandidatesMock.mockReset();
	localStorage.clear();
	mockReducedMotion(false);
});

afterEach(() => {
	if (mounted) {
		unmount(mounted.component);
		mounted.host.remove();
		mounted = null;
	}
});

describe('PART A/C — status strip resolves into the review summary chip', () => {
	it('shows the compact status strip while detection runs, then replaces it with the summary chip', async () => {
		mockReducedMotion(true); // Reveal timing isn't under test here; skip the stagger.
		const editor = makeEditor();
		const { component, host } = mountPage(editor, decodeOf(200, 200));
		mounted = { editor, component, host };
		await loadImage(host);

		const gate = resolveDetectionWithProgress();
		host.querySelector<HTMLButtonElement>('[data-testid="detect-course"]')?.click();
		await flush();

		const strip = host.querySelector('[data-testid="course-detection-status-strip"]');
		expect(strip).not.toBeNull();
		expect(strip?.textContent).toContain('Reading hole numbers');
		expect(host.querySelector('[data-testid="course-summary-chip"]')).toBeNull();

		gate.resolve();
		await flush();

		expect(host.querySelector('[data-testid="course-detection-status-strip"]')).toBeNull();
		const chip = host.querySelector('[data-testid="course-summary-chip"]');
		expect(chip).not.toBeNull();
		expect(chip?.textContent).toContain('Found 2 holes');
		expect(chip?.textContent).toContain('1 ready');
		expect(chip?.textContent).toContain('1 need review');
	});

	it('states the overlap/crowding limitation plainly, in the summary chip itself (PART D)', async () => {
		mockReducedMotion(true);
		const editor = makeEditor();
		const { component, host } = mountPage(editor, decodeOf(200, 200));
		mounted = { editor, component, host };
		await loadImage(host);

		detectCourseCandidatesMock.mockResolvedValueOnce(courseDetectionFixture());
		host.querySelector<HTMLButtonElement>('[data-testid="detect-course"]')?.click();
		await flush();

		const chip = host.querySelector('[data-testid="course-summary-chip"]');
		expect(chip?.textContent).toContain('overlap');
		expect(chip?.textContent).toContain('active research');
	});

	it('"Review hole" jumps to (and creates) the first hole that still needs review', async () => {
		mockReducedMotion(true);
		const editor = makeEditor();
		const { component, host } = mountPage(editor, decodeOf(200, 200));
		mounted = { editor, component, host };
		await loadImage(host);

		detectCourseCandidatesMock.mockResolvedValueOnce(courseDetectionFixture());
		host.querySelector<HTMLButtonElement>('[data-testid="detect-course"]')?.click();
		await flush();

		host.querySelector<HTMLButtonElement>('[data-testid="course-summary-jump-review"]')?.click();
		await flush();

		expect(host.querySelector('[data-testid="hole-bar-current-label"]')?.textContent).toContain('Hole 2');
	});
});

describe('PART B — staged candidate reveal', () => {
	it('reveals numbers, then tees, then baskets, then grammar links, staggered ~250ms apart', async () => {
		const editor = makeEditor();
		const { component, host } = mountPage(editor, decodeOf(200, 200));
		mounted = { editor, component, host };
		await loadImage(host);

		detectCourseCandidatesMock.mockResolvedValueOnce(courseDetectionFixture());
		host.querySelector<HTMLButtonElement>('[data-testid="detect-course"]')?.click();
		await flush();

		function revealed(testId: string): boolean {
			const el = host.querySelector(`[data-testid="${testId}"]`);
			return el?.classList.contains('revealed') ?? false;
		}
		function basketRevealed(index: number): boolean {
			const circle = host.querySelector(`[data-testid="basket-candidate-${index}"]`);
			return circle?.parentElement?.classList.contains('revealed') ?? false;
		}

		// Immediately on completion: only numbers are revealed.
		expect(revealed('number-candidate-1')).toBe(true);
		expect(revealed('tee-candidate-1')).toBe(false);
		expect(basketRevealed(1)).toBe(false);
		expect(revealed('grammar-link-1-badge-tee')).toBe(false);

		await wait(260);
		expect(revealed('tee-candidate-1')).toBe(true);
		expect(basketRevealed(1)).toBe(false);

		await wait(260);
		expect(basketRevealed(1)).toBe(true);
		expect(revealed('grammar-link-1-badge-tee')).toBe(false);

		await wait(260);
		expect(revealed('grammar-link-1-badge-tee')).toBe(true);
		expect(revealed('grammar-link-1-tee-basket')).toBe(true);

		// The summary chip only appears once the reveal has fully finished
		// ('done' lands one more stagger step after the last stage's turn).
		await wait(260);
		expect(host.querySelector('[data-testid="course-summary-chip"]')).not.toBeNull();
	});

	it('reduced motion shows every stage at once — exactly today\'s behavior, no stagger', async () => {
		mockReducedMotion(true);
		const editor = makeEditor();
		const { component, host } = mountPage(editor, decodeOf(200, 200));
		mounted = { editor, component, host };
		await loadImage(host);

		detectCourseCandidatesMock.mockResolvedValueOnce(courseDetectionFixture());
		host.querySelector<HTMLButtonElement>('[data-testid="detect-course"]')?.click();
		await flush();

		function revealed(testId: string): boolean {
			const el = host.querySelector(`[data-testid="${testId}"]`);
			return el?.classList.contains('revealed') ?? false;
		}

		expect(revealed('number-candidate-1')).toBe(true);
		expect(revealed('tee-candidate-1')).toBe(true);
		expect(revealed('grammar-link-1-badge-tee')).toBe(true);
		// The summary chip is not gated behind a stagger that no longer exists.
		expect(host.querySelector('[data-testid="course-summary-chip"]')).not.toBeNull();
	});
});

describe('PART C — click-to-assign', () => {
	async function detectReady(host: HTMLElement): Promise<void> {
		mockReducedMotion(true);
		detectCourseCandidatesMock.mockResolvedValueOnce(courseDetectionFixture());
		host.querySelector<HTMLButtonElement>('[data-testid="detect-course"]')?.click();
		await flush();
	}

	it('clicking an unassigned candidate when the active hole is missing that feature assigns it instantly — no dialog, no radial menu', async () => {
		const editor = makeEditor();
		const { component, host } = mountPage(editor, decodeOf(200, 200));
		mounted = { editor, component, host };
		await loadImage(host);
		await detectReady(host);

		// Hole 2's basket candidate (courseDetection.baskets[1], at 140,160) is
		// unassigned by the grammar and not on any draft hole yet.
		host.querySelector<HTMLButtonElement>('[data-testid="course-summary-jump-review"]')?.click();
		await flush();
		expect(host.querySelector('[data-testid="hole-bar-current-label"]')?.textContent).toContain('Hole 2');

		const point = screenPointFor(host, 140, 160);
		dispatchClick(host, point.x, point.y);
		await flush();

		expect(host.querySelector('[data-testid="basket-marker-2"]')).not.toBeNull();
		expect(host.querySelector('[data-testid="candidate-assign-confirm"]')).toBeNull();
		expect(host.querySelector('[data-testid="radial-menu"]')).toBeNull();
	});

	it('clicking a candidate when the active hole already has that feature opens a "Replace" confirmation chip; confirming replaces it', async () => {
		const editor = makeEditor();
		const { component, host } = mountPage(editor, decodeOf(200, 200));
		mounted = { editor, component, host };
		await loadImage(host);
		await detectReady(host);

		host.querySelector<HTMLButtonElement>('[data-testid="course-summary-jump-review"]')?.click();
		await flush();

		// Instant-assign hole 2's own tee candidate first, so hole 2 has a tee.
		const ownTee = screenPointFor(host, 140, 80);
		dispatchClick(host, ownTee.x, ownTee.y);
		await flush();
		expect(host.querySelector('[data-testid="tee-marker-2"]')).not.toBeNull();

		// Clicking a DIFFERENT tee candidate now must ask before overwriting it.
		const otherTee = screenPointFor(host, 40, 80);
		dispatchClick(host, otherTee.x, otherTee.y);
		await flush();

		const confirm = host.querySelector('[data-testid="candidate-assign-confirm"]');
		expect(confirm).not.toBeNull();
		expect(confirm?.textContent).toContain('Replace tee on hole 2');
		expect(host.querySelector('[data-testid="radial-menu"]')).toBeNull();

		host.querySelector<HTMLButtonElement>('[data-testid="candidate-assign-confirm-accept"]')?.click();
		await flush();

		expect(host.querySelector('[data-testid="candidate-assign-confirm"]')).toBeNull();
		expect(host.querySelector('[data-testid="hole-select-2"]')?.textContent).not.toContain('no tee');
	});

	it('clicking a candidate already assigned to a DIFFERENT hole opens a "Move" confirmation chip; confirming moves it, clearing the source hole', async () => {
		const editor = makeEditor();
		const { component, host } = mountPage(editor, decodeOf(200, 200));
		mounted = { editor, component, host };
		await loadImage(host);
		await detectReady(host);

		// Accept hole 1 (ready), which claims tee candidate 0 at (40, 80).
		host.querySelector<HTMLButtonElement>('[data-testid="course-summary-apply-ready"]')?.click();
		await flush();
		expect(host.querySelector('[data-testid="tee-marker-1"]')).not.toBeNull();

		// Make hole 2 active without giving it a tee of its own.
		host.querySelector<HTMLButtonElement>('[data-testid="course-summary-jump-review"]')?.click();
		await flush();
		expect(host.querySelector('[data-testid="hole-bar-current-label"]')?.textContent).toContain('Hole 2');

		const claimedTee = screenPointFor(host, 40, 80);
		dispatchClick(host, claimedTee.x, claimedTee.y);
		await flush();

		const confirm = host.querySelector('[data-testid="candidate-assign-confirm"]');
		expect(confirm).not.toBeNull();
		expect(confirm?.textContent).toContain('Move to hole 2');

		host.querySelector<HTMLButtonElement>('[data-testid="candidate-assign-confirm-accept"]')?.click();
		await flush();

		expect(host.querySelector('[data-testid="tee-marker-2"]')).not.toBeNull();
		expect(host.querySelector('[data-testid="tee-marker-1"]')).toBeNull();
	});

	it('Escape dismisses the confirmation chip without assigning anything', async () => {
		const editor = makeEditor();
		const { component, host } = mountPage(editor, decodeOf(200, 200));
		mounted = { editor, component, host };
		await loadImage(host);
		await detectReady(host);

		host.querySelector<HTMLButtonElement>('[data-testid="course-summary-jump-review"]')?.click();
		await flush();
		const ownTee = screenPointFor(host, 140, 80);
		dispatchClick(host, ownTee.x, ownTee.y);
		await flush();
		const otherTee = screenPointFor(host, 40, 80);
		dispatchClick(host, otherTee.x, otherTee.y);
		await flush();
		expect(host.querySelector('[data-testid="candidate-assign-confirm"]')).not.toBeNull();

		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
		await flush();

		expect(host.querySelector('[data-testid="candidate-assign-confirm"]')).toBeNull();
		// Hole 2 still has its own (140,80) tee, untouched by the dismissed replace.
		expect(host.querySelector('[data-testid="tee-marker-2"]')).not.toBeNull();
	});

	it('clicking the active hole\'s own tee opens a "Delete" confirmation chip; confirming clears the tee', async () => {
		const editor = makeEditor();
		const { component, host } = mountPage(editor, decodeOf(200, 200));
		mounted = { editor, component, host };
		await loadImage(host);
		await detectReady(host);

		host.querySelector<HTMLButtonElement>('[data-testid="course-summary-jump-review"]')?.click();
		await flush();

		// Instant-assign hole 2's own tee candidate first, so hole 2 has a tee.
		const ownTee = screenPointFor(host, 140, 80);
		dispatchClick(host, ownTee.x, ownTee.y);
		await flush();
		expect(host.querySelector('[data-testid="tee-marker-2"]')).not.toBeNull();

		// Clicking the SAME candidate — already this hole's own tee — must offer to delete it.
		// Offset just outside the real marker's fixed hit radius (12px) but still
		// inside the candidate overlay's zoom-scaled hit radius, exactly like a
		// real click landing on the wider "Detected tee" badge rather than dead
		// center on the narrower placed-marker hit target.
		dispatchClick(host, ownTee.x + 16, ownTee.y);
		await flush();

		const confirm = host.querySelector('[data-testid="candidate-assign-confirm"]');
		expect(confirm).not.toBeNull();
		expect(confirm?.textContent).toContain('Delete tee on hole 2');
		expect(host.querySelector('[data-testid="radial-menu"]')).toBeNull();

		host.querySelector<HTMLButtonElement>('[data-testid="candidate-assign-confirm-accept"]')?.click();
		await flush();

		expect(host.querySelector('[data-testid="candidate-assign-confirm"]')).toBeNull();
		expect(host.querySelector('[data-testid="tee-marker-2"]')).toBeNull();
	});

	it('cancelling the delete confirmation chip leaves the tee untouched', async () => {
		const editor = makeEditor();
		const { component, host } = mountPage(editor, decodeOf(200, 200));
		mounted = { editor, component, host };
		await loadImage(host);
		await detectReady(host);

		host.querySelector<HTMLButtonElement>('[data-testid="course-summary-jump-review"]')?.click();
		await flush();

		const ownTee = screenPointFor(host, 140, 80);
		dispatchClick(host, ownTee.x, ownTee.y);
		await flush();
		expect(host.querySelector('[data-testid="tee-marker-2"]')).not.toBeNull();

		dispatchClick(host, ownTee.x + 16, ownTee.y);
		await flush();
		expect(host.querySelector('[data-testid="candidate-assign-confirm"]')).not.toBeNull();

		host.querySelector<HTMLButtonElement>('[data-testid="candidate-assign-confirm-cancel"]')?.click();
		await flush();

		expect(host.querySelector('[data-testid="candidate-assign-confirm"]')).toBeNull();
		expect(host.querySelector('[data-testid="tee-marker-2"]')).not.toBeNull();
	});

	it('a pointerdown outside the confirmation chip dismisses it without acting', async () => {
		const editor = makeEditor();
		const { component, host } = mountPage(editor, decodeOf(200, 200));
		mounted = { editor, component, host };
		await loadImage(host);
		await detectReady(host);

		host.querySelector<HTMLButtonElement>('[data-testid="course-summary-jump-review"]')?.click();
		await flush();
		const ownTee = screenPointFor(host, 140, 80);
		dispatchClick(host, ownTee.x, ownTee.y);
		await flush();
		const otherTee = screenPointFor(host, 40, 80);
		dispatchClick(host, otherTee.x, otherTee.y);
		await flush();
		expect(host.querySelector('[data-testid="candidate-assign-confirm"]')).not.toBeNull();

		document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
		await flush();

		expect(host.querySelector('[data-testid="candidate-assign-confirm"]')).toBeNull();
	});
});

describe('Diagnostics rail collapse', () => {
	it('defaults expanded, toggles aria-expanded, and remembers the choice in localStorage', async () => {
		const editor = makeEditor();
		const { component, host } = mountPage(editor, decodeOf(200, 200));
		mounted = { editor, component, host };
		await flush();

		const toggle = host.querySelector<HTMLButtonElement>('[data-testid="diagnostics-rail-toggle"]');
		expect(toggle?.getAttribute('aria-expanded')).toBe('true');

		toggle?.click();
		await flush();
		expect(toggle?.getAttribute('aria-expanded')).toBe('false');
		expect(localStorage.getItem('chainspot.diagnosticsRail')).toBe('collapsed');

		toggle?.click();
		await flush();
		expect(toggle?.getAttribute('aria-expanded')).toBe('true');
		expect(localStorage.getItem('chainspot.diagnosticsRail')).toBe('expanded');
	});

	it('a fresh mount (simulating reload) reads the collapsed preference back from localStorage', async () => {
		localStorage.setItem('chainspot.diagnosticsRail', 'collapsed');
		const editor = makeEditor();
		const { component, host } = mountPage(editor, decodeOf(200, 200));
		mounted = { editor, component, host };
		await flush();

		const toggle = host.querySelector<HTMLButtonElement>('[data-testid="diagnostics-rail-toggle"]');
		expect(toggle?.getAttribute('aria-expanded')).toBe('false');
	});
});
