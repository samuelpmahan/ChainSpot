// @vitest-environment jsdom

/**
 * Coverage for Annotate Course's keyboard-first correction workflow:
 * Tab-driven TEE → BASKET → BENDS → next-hole review order, the
 * current-step indicator, step-determined empty-map clicks, X rejection,
 * Ctrl-Z/Ctrl-Shift-Z/Ctrl-Y workflow undo+redo (annotation + workflow +
 * camera), WASD/Q/E camera keys, the 1–6 course-wide corridor-width keys
 * with on-map feedback, and CHSPT-55's X-bend priority fix (the most
 * recently manually-added bend outranks an untouched eager AutoBend
 * proposal, regardless of the array's own geometric sort order).
 *
 * `detectAndApplyCorridorBendsCapsuleAsync` is mocked (same technique as
 * `annotateCourseLocalSnap.test.ts`'s `requestLocalSnap` mock) so a test can
 * get a deterministic eager "AutoBend" proposal onto a hole without a real
 * canvas/worker pipeline — jsdom's canvas 2D is stubbed to null
 * (`tests/setup.ts`), so the real detector is always a no-op here (see
 * `annotateCourseBendDetection.test.ts`).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, tick, unmount } from 'svelte';

const { detectAndApplyCorridorBendsCapsuleAsyncMock } = vi.hoisted(() => ({
	detectAndApplyCorridorBendsCapsuleAsyncMock: vi.fn()
}));

vi.mock('$lib/autoAnnotation/corridorBendDetectionCapsuleWorker', async (importOriginal) => {
	const actual =
		await importOriginal<typeof import('../../src/lib/autoAnnotation/corridorBendDetectionCapsuleWorker')>();
	return {
		...actual,
		detectAndApplyCorridorBendsCapsuleAsync: detectAndApplyCorridorBendsCapsuleAsyncMock
	};
});

import AnnotationWorkspace from '../../src/lib/components/AnnotationWorkspace.svelte';
import { ProjectEditor } from '../../src/lib/domain/editor';
import { createImageAsset, createProjectState } from '../../src/lib/domain/project';
import type { AnnotatedHole } from '../../src/lib/domain/project';
import { applyDetectedCorridorBends } from '../../src/lib/autoAnnotation/corridorBendDetection';
import type { DecodeImageFile } from '../../src/lib/imageIntake';

const NOW = () => new Date('2026-08-16T00:00:00.000Z');

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
	const component = mount(AnnotationWorkspace, {
		target: host,
		props: { mode: 'map', sessionKey: 'annotate-course', editor, decode }
	});
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

function dispatchClick(host: HTMLElement, x: number, y: number, pointerId = 81): void {
	const element = scene(host);
	element.dispatchEvent(
		new PointerEvent('pointerdown', { button: 0, pointerId, clientX: x, clientY: y, bubbles: true })
	);
	window.dispatchEvent(new PointerEvent('pointerup', { pointerId, clientX: x, clientY: y }));
}

/** Presses down, drags past click-slop, and releases at a new point — a real drag (moves an existing marker), not a click (which would open its correction chip/menu instead). */
function dispatchDrag(
	host: HTMLElement,
	from: { x: number; y: number },
	to: { x: number; y: number },
	pointerId = 82
): void {
	const element = scene(host);
	element.dispatchEvent(
		new PointerEvent('pointerdown', { button: 0, pointerId, clientX: from.x, clientY: from.y, bubbles: true })
	);
	window.dispatchEvent(new PointerEvent('pointermove', { pointerId, clientX: to.x, clientY: to.y }));
	window.dispatchEvent(new PointerEvent('pointerup', { pointerId, clientX: to.x, clientY: to.y }));
}

function sidebarHoleButton(host: HTMLElement, number: number): HTMLButtonElement {
	const button = host.querySelector<HTMLButtonElement>(`[data-testid="sidebar-hole-${number}"]`);
	if (!button) throw new Error(`missing sidebar-hole-${number}`);
	return button;
}

/**
 * A `ProjectEditor` with its source-overview image already loaded (bypassing
 * the file-input intake flow) so `editor.setHoles(...)` can seed a hole
 * BEFORE mounting — the mounted component hydrates its own `holes` state
 * from `editor.state.holes` once, at construction (see
 * `AnnotationWorkspace.svelte`'s own doc comment on that field), so this is
 * the only way to have an existing tee/basket present the instant review
 * starts, without going through a real CV detection pass.
 */
function makeEditorWithSourceImage(widthPx: number, heightPx: number): ProjectEditor {
	const state = createProjectState({ createId: () => 'project-1', now: NOW });
	const asset = createImageAsset({
		id: 'source-1',
		role: 'source-overview',
		fileName: 'course.png',
		mimeType: 'image/png',
		widthPx,
		heightPx
	});
	state.images = [asset];
	return new ProjectEditor({
		state,
		now: NOW,
		assets: new Map([[asset.id, { bytes: new Uint8Array([1, 2, 3, 4]), decoded: document.createElement('img') }]])
	});
}

function view(host: HTMLElement): { zoom: number; panX: number; panY: number } {
	const dataset = scene(host).dataset;
	return { zoom: Number(dataset.viewZoom), panX: Number(dataset.viewPanX), panY: Number(dataset.viewPanY) };
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

async function loadImage(host: HTMLElement): Promise<void> {
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

function pressKey(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
	const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
	window.dispatchEvent(event);
	return event;
}

function stepIndicator(host: HTMLElement): string {
	return host.querySelector('[data-testid="review-step-indicator"]')?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
}

let mounted: Mounted | null = null;

beforeEach(() => {
	// Default: no proposal (matches the real detector's jsdom no-op — see
	// `annotateCourseBendDetection.test.ts`). Individual CHSPT-55 tests
	// override this to inject a deterministic AutoBend.
	detectAndApplyCorridorBendsCapsuleAsyncMock.mockReset();
	detectAndApplyCorridorBendsCapsuleAsyncMock.mockImplementation(async (holes: readonly AnnotatedHole[]) =>
		holes.slice()
	);
});

afterEach(() => {
	if (mounted) {
		unmount(mounted.component);
		mounted.host.remove();
		mounted = null;
	}
});

describe('Tab-driven review order', () => {
	it('Tab alone advances TEE → BASKET → BENDS → next hole; clicks edit the current step without advancing', async () => {
		const editor = makeEditor();
		const { component, host } = mountPage(editor, decodeOf(200, 200));
		mounted = { editor, component, host };
		await loadImage(host);

		// No hole is active until review starts (no detection runs in jsdom).
		expect(host.querySelector('[data-testid="review-step-indicator"]')).toBeNull();

		pressKey('Tab');
		await flush();
		expect(stepIndicator(host)).toBe('HOLE 1 · TEE');

		// Empty clicks place/re-place the current step, but NEVER advance it.
		const teeAt = screenPointFor(host, 40, 40);
		dispatchClick(host, teeAt.x, teeAt.y);
		await flush();
		expect(host.querySelector('[data-testid="tee-marker-1"]')).not.toBeNull();
		expect(stepIndicator(host)).toBe('HOLE 1 · TEE');

		const teeReplacement = screenPointFor(host, 70, 40);
		dispatchClick(host, teeReplacement.x, teeReplacement.y);
		await flush();
		expect(host.querySelector('[data-testid="tee-marker-1"]')?.getAttribute('cx')).toBe('70');
		expect(stepIndicator(host)).toBe('HOLE 1 · TEE');

		pressKey('Tab');
		await flush();
		expect(stepIndicator(host)).toBe('HOLE 1 · BASKET');

		const basketAt = screenPointFor(host, 100, 100);
		dispatchClick(host, basketAt.x, basketAt.y);
		await flush();
		expect(host.querySelector('[data-testid="basket-marker-1"]')).not.toBeNull();
		expect(stepIndicator(host)).toBe('HOLE 1 · BASKET');

		pressKey('Tab');
		await flush();
		expect(stepIndicator(host)).toBe('HOLE 1 · BENDS');

		const bendAt = screenPointFor(host, 80, 130);
		dispatchClick(host, bendAt.x, bendAt.y);
		await flush();
		expect(host.querySelector('[data-testid="bend-marker-1-0"]')).not.toBeNull();
		expect(stepIndicator(host)).toBe('HOLE 1 · BENDS');

		pressKey('Tab');
		await flush();
		expect(stepIndicator(host)).toBe('HOLE 2 · TEE');
	});

	it('Tab accepts an existing proposed piece without moving it; Shift+Tab is swallowed without advancing', async () => {
		const editor = makeEditorWithSourceImage(200, 200);
		editor.setHoles([
			{
				id: 'hole-1',
				number: 1,
				tee: { xPx: 40, yPx: 40 },
				basket: { xPx: 100, yPx: 100 },
				shots: [],
				corridorBends: [],
				corridorWidthPx: 60
			}
		]);
		const { component, host } = mountPage(editor, decodeOf(200, 200));
		mounted = { editor, component, host };
		setGeometry(host);
		await flush();

		expect(stepIndicator(host)).toBe('HOLE 1 · TEE');
		const shiftTab = pressKey('Tab', { shiftKey: true });
		await flush();
		expect(shiftTab.defaultPrevented).toBe(true);
		expect(stepIndicator(host)).toBe('HOLE 1 · TEE');

		const plainTab = pressKey('Tab');
		await flush();
		expect(plainTab.defaultPrevented).toBe(true);
		expect(stepIndicator(host)).toBe('HOLE 1 · BASKET');
		expect(host.querySelector('[data-testid="tee-marker-1"]')?.getAttribute('cx')).toBe('40');
	});

	it('an existing marker always wins over GuidedReview: while reviewing H1 TEE/BASKET, H2 points remain freely draggable', async () => {
		const editor = makeEditorWithSourceImage(200, 200);
		editor.setHoles([
			{
				id: 'hole-1',
				number: 1,
				tee: { xPx: 40, yPx: 40 },
				basket: { xPx: 90, yPx: 100 },
				shots: [],
				corridorBends: [],
				corridorWidthPx: 60
			},
			{
				id: 'hole-2',
				number: 2,
				tee: { xPx: 140, yPx: 40 },
				basket: { xPx: 150, yPx: 120 },
				shots: [],
				corridorBends: [],
				corridorWidthPx: 60
			}
		]);
		const { component, host } = mountPage(editor, decodeOf(200, 200));
		mounted = { editor, component, host };
		setGeometry(host);
		await flush();

		expect(stepIndicator(host)).toBe('HOLE 1 · TEE');

		// Drag H2's tee even though GuidedReview is asking about H1's tee.
		const h2TeeFrom = screenPointFor(host, 140, 40);
		const h2TeeTo = screenPointFor(host, 165, 60);
		dispatchDrag(host, h2TeeFrom, h2TeeTo);
		await flush();
		expect(host.querySelector('[data-testid="tee-marker-2"]')?.getAttribute('cx')).toBe('165');
		expect(host.querySelector('[data-testid="tee-marker-2"]')?.getAttribute('cy')).toBe('60');
		expect(stepIndicator(host)).toBe('HOLE 1 · TEE');

		// Empty space still belongs to the current GuidedReview step: replace H1 tee.
		const h1Replacement = screenPointFor(host, 20, 25);
		dispatchClick(host, h1Replacement.x, h1Replacement.y);
		await flush();
		expect(host.querySelector('[data-testid="tee-marker-1"]')?.getAttribute('cx')).toBe('20');
		expect(host.querySelector('[data-testid="tee-marker-1"]')?.getAttribute('cy')).toBe('25');
		expect(stepIndicator(host)).toBe('HOLE 1 · TEE');

		pressKey('Tab');
		await flush();
		expect(stepIndicator(host)).toBe('HOLE 1 · BASKET');

		// Same rule on the next step: an H2 basket drag wins over H1 basket placement.
		const h2BasketFrom = screenPointFor(host, 150, 120);
		const h2BasketTo = screenPointFor(host, 170, 145);
		dispatchDrag(host, h2BasketFrom, h2BasketTo);
		await flush();
		expect(host.querySelector('[data-testid="basket-marker-2"]')?.getAttribute('cx')).toBe('170');
		expect(host.querySelector('[data-testid="basket-marker-2"]')?.getAttribute('cy')).toBe('145');
		expect(stepIndicator(host)).toBe('HOLE 1 · BASKET');
	});
});

describe('X — reject the current step\'s obvious proposal', () => {
	it('rejects the step tee/basket without a selection click, and Ctrl-Z restores it', async () => {
		const editor = makeEditor();
		const { component, host } = mountPage(editor, decodeOf(200, 200));
		mounted = { editor, component, host };
		await loadImage(host);

		pressKey('Tab');
		await flush();
		const teeAt = screenPointFor(host, 40, 40);
		dispatchClick(host, teeAt.x, teeAt.y);
		await flush();
		expect(host.querySelector('[data-testid="tee-marker-1"]')).not.toBeNull();
		// Placement never advances GuidedReview (499ef3e) -- still TEE.
		expect(stepIndicator(host)).toBe('HOLE 1 · TEE');

		// X rejects the just-placed tee with no selection click needed.
		pressKey('x');
		await flush();
		expect(host.querySelector('[data-testid="tee-marker-1"]')).toBeNull();

		pressKey('z', { ctrlKey: true });
		await flush();
		expect(host.querySelector('[data-testid="tee-marker-1"]')).not.toBeNull();
		expect(stepIndicator(host)).toBe('HOLE 1 · TEE');

		// Tab accepts the tee and moves the step to BASKET; X there with no
		// basket placed yet is a no-op.
		pressKey('Tab');
		await flush();
		expect(stepIndicator(host)).toBe('HOLE 1 · BASKET');
		pressKey('x');
		await flush();
		expect(host.querySelector('[data-testid="tee-marker-1"]')).not.toBeNull();

		// Place the basket, then X rejects IT (the current step), again with
		// no selection click; Ctrl-Z restores it.
		const basketAt = screenPointFor(host, 80, 80);
		dispatchClick(host, basketAt.x, basketAt.y);
		await flush();
		expect(host.querySelector('[data-testid="basket-marker-1"]')).not.toBeNull();
		pressKey('x');
		await flush();
		expect(host.querySelector('[data-testid="basket-marker-1"]')).toBeNull();

		pressKey('z', { ctrlKey: true });
		await flush();
		expect(host.querySelector('[data-testid="basket-marker-1"]')).not.toBeNull();
	});

	it('on the BENDS step, X rejects the most recent bend and Ctrl-Z restores it', async () => {
		const editor = makeEditor();
		const { component, host } = mountPage(editor, decodeOf(200, 200));
		mounted = { editor, component, host };
		await loadImage(host);

		pressKey('Tab');
		await flush();
		dispatchClick(host, ...(({ x, y }) => [x, y] as const)(screenPointFor(host, 40, 40)));
		await flush();
		pressKey('Tab');
		await flush();
		dispatchClick(host, ...(({ x, y }) => [x, y] as const)(screenPointFor(host, 80, 80)));
		await flush();
		pressKey('Tab');
		await flush();
		const bendAt = screenPointFor(host, 30, 90);
		dispatchClick(host, bendAt.x, bendAt.y);
		await flush();
		expect(host.querySelector('[data-testid="bend-marker-1-0"]')).not.toBeNull();

		pressKey('x');
		await flush();
		expect(host.querySelector('[data-testid="bend-marker-1-0"]')).toBeNull();

		pressKey('z', { ctrlKey: true });
		await flush();
		expect(host.querySelector('[data-testid="bend-marker-1-0"]')).not.toBeNull();
	});
});

describe('camera keys', () => {
	it('WASD pans and Q/E zoom about the center; zoom keys are reciprocal', async () => {
		const editor = makeEditor();
		const { component, host } = mountPage(editor, decodeOf(200, 200));
		mounted = { editor, component, host };
		await loadImage(host);

		const before = view(host);
		pressKey('d');
		await flush();
		const afterPan = view(host);
		expect(afterPan.panX).toBeLessThan(before.panX);
		expect(afterPan.zoom).toBe(before.zoom);

		pressKey('w');
		await flush();
		expect(view(host).panY).toBeGreaterThan(afterPan.panY);

		const zoomBefore = view(host).zoom;
		pressKey('q');
		await flush();
		expect(view(host).zoom).toBeGreaterThan(zoomBefore);
		pressKey('e');
		await flush();
		expect(view(host).zoom).toBeCloseTo(zoomBefore, 10);
	});

	it('"a" pans in Map mode instead of adding a hole', async () => {
		const editor = makeEditor();
		const { component, host } = mountPage(editor, decodeOf(200, 200));
		mounted = { editor, component, host };
		await loadImage(host);

		const before = view(host);
		pressKey('a');
		await flush();
		expect(view(host).panX).toBeGreaterThan(before.panX);
		// No hole was created by the keypress.
		expect(host.querySelector('[data-testid="annotation-workspace"]')?.getAttribute('data-hole-count')).toBe('0');
	});
});

describe('1–6 — course-wide corridor width from the keyboard', () => {
	it('adjusts every hole\'s width by the key\'s delta and shows on-map WIDTH feedback', async () => {
		const editor = makeEditor();
		const { component, host } = mountPage(editor, decodeOf(200, 200));
		mounted = { editor, component, host };
		await loadImage(host);

		pressKey('Tab');
		await flush();
		const widthInput = () =>
			host.querySelector<HTMLInputElement>('[data-testid="corridor-width"]');
		expect(widthInput()?.value).toBe('60');

		pressKey('6'); // +5
		await flush();
		expect(widthInput()?.value).toBe('65');
		const feedback = host.querySelector('[data-testid="corridor-width-feedback"]');
		expect(feedback?.textContent?.replace(/\s+/g, ' ')).toContain('WIDTH 60 → 65');

		pressKey('1'); // −5 — same burst, feedback keeps the original "from"
		await flush();
		expect(widthInput()?.value).toBe('60');
		expect(
			host.querySelector('[data-testid="corridor-width-feedback"]')?.textContent?.replace(/\s+/g, ' ')
		).toContain('WIDTH 60 → 60');

		pressKey('3'); // −1
		await flush();
		expect(widthInput()?.value).toBe('59');
	});
});

describe('Ctrl-Z / Ctrl-Shift-Z — workflow undo and redo', () => {
	it('undoes a Tab advancement (step, active hole, and camera view) and a geometry edit in reverse order, then Ctrl-Shift-Z redoes each step forward', async () => {
		const editor = makeEditor();
		const { component, host } = mountPage(editor, decodeOf(200, 200));
		mounted = { editor, component, host };
		await loadImage(host);

		pressKey('Tab'); // enter Hole 1 · TEE
		await flush();
		const teeAt = screenPointFor(host, 40, 40);
		dispatchClick(host, teeAt.x, teeAt.y);
		await flush();
		pressKey('Tab'); // accept tee -> BASKET
		await flush();
		const basketAt = screenPointFor(host, 80, 80);
		dispatchClick(host, basketAt.x, basketAt.y);
		await flush();
		pressKey('Tab'); // accept basket -> BENDS
		await flush();
		expect(stepIndicator(host)).toBe('HOLE 1 · BENDS');

		// Pan the camera before completing hole 1. WASD panning is never its
		// own undo step (see the "camera keys" tests below), so this pan gets
		// captured as part of whatever mutation follows it — proving the
		// completing Tab's snapshot really does carry the camera, not just
		// the hole/step.
		const viewBeforeCompletingHole1 = view(host);
		pressKey('d');
		await flush();
		const viewAfterPan = view(host);
		expect(viewAfterPan.panX).not.toBe(viewBeforeCompletingHole1.panX);

		// The completing Tab: approves hole 1 (tee+basket+bends) and enters
		// hole 2. A further Tab on hole 2's still-empty TEE step just advances
		// the step (nothing to confirm yet).
		pressKey('Tab');
		await flush();
		expect(stepIndicator(host)).toBe('HOLE 2 · TEE');
		const viewAtHole2Tee = view(host);
		pressKey('Tab');
		await flush();
		expect(stepIndicator(host)).toBe('HOLE 2 · BASKET');

		// One Ctrl-Z per Tab press walks back exactly, camera included.
		pressKey('z', { ctrlKey: true });
		await flush();
		expect(stepIndicator(host)).toBe('HOLE 2 · TEE');
		expect(view(host)).toEqual(viewAtHole2Tee);

		pressKey('z', { ctrlKey: true });
		await flush();
		expect(stepIndicator(host)).toBe('HOLE 1 · BENDS');
		// Hole 1's tee+basket were already confirmed by their own Tab presses
		// earlier (each an independent undo step) — undoing only the
		// completing Tab leaves that confirmation in place.
		expect(host.querySelector('[data-testid="sidebar-section-4"]')?.textContent).toContain('1');
		// The pan that happened between accepting hole 1's basket and
		// completing the hole is restored right along with the hole/step.
		expect(view(host)).toEqual(viewAfterPan);

		// Next Ctrl-Z undoes the Tab that accepted the basket (BASKET -> BENDS);
		// the basket marker itself is a separate, earlier undo step.
		pressKey('z', { ctrlKey: true });
		await flush();
		expect(host.querySelector('[data-testid="basket-marker-1"]')).not.toBeNull();
		expect(stepIndicator(host)).toBe('HOLE 1 · BASKET');

		// Then the basket PLACEMENT itself.
		pressKey('z', { ctrlKey: true });
		await flush();
		expect(host.querySelector('[data-testid="basket-marker-1"]')).toBeNull();
		expect(stepIndicator(host)).toBe('HOLE 1 · BASKET');

		// Ctrl-Shift-Z redo walks every step back forward, camera included.
		pressKey('Z', { ctrlKey: true, shiftKey: true });
		await flush();
		expect(host.querySelector('[data-testid="basket-marker-1"]')).not.toBeNull();
		expect(stepIndicator(host)).toBe('HOLE 1 · BASKET');

		pressKey('Z', { ctrlKey: true, shiftKey: true });
		await flush();
		expect(stepIndicator(host)).toBe('HOLE 1 · BENDS');
		expect(view(host)).toEqual(viewAfterPan);

		pressKey('Z', { ctrlKey: true, shiftKey: true });
		await flush();
		expect(stepIndicator(host)).toBe('HOLE 2 · TEE');
		expect(host.querySelector('[data-testid="sidebar-section-4"]')?.textContent).toContain('1');
		expect(view(host)).toEqual(viewAtHole2Tee);

		pressKey('Z', { ctrlKey: true, shiftKey: true });
		await flush();
		expect(stepIndicator(host)).toBe('HOLE 2 · BASKET');
	});

	it('corridor-width change: Ctrl-Z restores the previous width and Ctrl-Y redoes it (the other historyShortcut redo binding)', async () => {
		const editor = makeEditor();
		const { component, host } = mountPage(editor, decodeOf(200, 200));
		mounted = { editor, component, host };
		await loadImage(host);

		pressKey('Tab');
		await flush();
		const widthInput = () => host.querySelector<HTMLInputElement>('[data-testid="corridor-width"]');
		expect(widthInput()?.value).toBe('60');

		pressKey('6'); // +5
		await flush();
		expect(widthInput()?.value).toBe('65');

		pressKey('z', { ctrlKey: true });
		await flush();
		expect(widthInput()?.value).toBe('60');

		// Ctrl-Y (not Ctrl-Shift-Z) is the other redo binding this component
		// now honors — see `historyShortcut` in `$lib/pointListShortcuts`.
		pressKey('y', { ctrlKey: true });
		await flush();
		expect(widthInput()?.value).toBe('65');
	});

	it('tee placement and a drag-move: Ctrl-Z restores each and Ctrl-Shift-Z redoes each', async () => {
		const editor = makeEditor();
		const { component, host } = mountPage(editor, decodeOf(200, 200));
		mounted = { editor, component, host };
		await loadImage(host);

		pressKey('Tab');
		await flush();
		const teeAt = screenPointFor(host, 40, 40);
		dispatchClick(host, teeAt.x, teeAt.y);
		await flush();
		expect(host.querySelector('[data-testid="tee-marker-1"]')?.getAttribute('cx')).toBe('40');
		// Placement never advances GuidedReview (499ef3e) -- still TEE.
		expect(stepIndicator(host)).toBe('HOLE 1 · TEE');

		pressKey('z', { ctrlKey: true });
		await flush();
		expect(host.querySelector('[data-testid="tee-marker-1"]')).toBeNull();
		expect(stepIndicator(host)).toBe('HOLE 1 · TEE');

		pressKey('Z', { ctrlKey: true, shiftKey: true });
		await flush();
		expect(host.querySelector('[data-testid="tee-marker-1"]')?.getAttribute('cx')).toBe('40');
		expect(stepIndicator(host)).toBe('HOLE 1 · TEE');

		// A real drag (past click-slop) moves the existing tee marker.
		const teeMoveTo = screenPointFor(host, 55, 60);
		dispatchDrag(host, teeAt, teeMoveTo);
		await flush();
		expect(host.querySelector('[data-testid="tee-marker-1"]')?.getAttribute('cx')).toBe('55');
		expect(host.querySelector('[data-testid="tee-marker-1"]')?.getAttribute('cy')).toBe('60');

		pressKey('z', { ctrlKey: true });
		await flush();
		expect(host.querySelector('[data-testid="tee-marker-1"]')?.getAttribute('cx')).toBe('40');
		expect(host.querySelector('[data-testid="tee-marker-1"]')?.getAttribute('cy')).toBe('40');

		pressKey('Z', { ctrlKey: true, shiftKey: true });
		await flush();
		expect(host.querySelector('[data-testid="tee-marker-1"]')?.getAttribute('cx')).toBe('55');
		expect(host.querySelector('[data-testid="tee-marker-1"]')?.getAttribute('cy')).toBe('60');
	});

	it('X-rejection of an already-placed tee, then basket: Ctrl-Z restores each and Ctrl-Shift-Z re-rejects each', async () => {
		// Seeds the hole directly (via `editor.setHoles`, before mount) so both
		// pieces exist the instant review starts — no CV pipeline needed, and
		// no fragile Ctrl-Z/replace choreography just to get a piece in place
		// while still standing on its own review step.
		const seededHole: AnnotatedHole = {
			id: 'hole-1',
			number: 1,
			tee: { xPx: 40, yPx: 40 },
			basket: { xPx: 120, yPx: 150 },
			shots: [],
			corridorBends: [],
			corridorWidthPx: 60
		};
		const editor = makeEditorWithSourceImage(200, 200);
		editor.setHoles([seededHole]);
		const { component, host } = mountPage(editor, decodeOf(200, 200));
		mounted = { editor, component, host };

		pressKey('Tab');
		await flush();
		expect(stepIndicator(host)).toBe('HOLE 1 · TEE');
		expect(host.querySelector('[data-testid="tee-marker-1"]')).not.toBeNull();

		pressKey('x');
		await flush();
		expect(host.querySelector('[data-testid="tee-marker-1"]')).toBeNull();

		pressKey('z', { ctrlKey: true });
		await flush();
		expect(host.querySelector('[data-testid="tee-marker-1"]')).not.toBeNull();

		pressKey('Z', { ctrlKey: true, shiftKey: true });
		await flush();
		expect(host.querySelector('[data-testid="tee-marker-1"]')).toBeNull();

		// Undo once more to get the tee back before stepping past it — the
		// rejection (and its undo/redo) never advanced the review step, so
		// `reviewStep` is still TEE throughout.
		pressKey('z', { ctrlKey: true });
		await flush();
		expect(host.querySelector('[data-testid="tee-marker-1"]')).not.toBeNull();

		// Missing or present, Tab always accepts the current step and moves on.
		pressKey('Tab');
		await flush();
		expect(stepIndicator(host)).toBe('HOLE 1 · BASKET');
		expect(host.querySelector('[data-testid="basket-marker-1"]')).not.toBeNull();

		pressKey('x');
		await flush();
		expect(host.querySelector('[data-testid="basket-marker-1"]')).toBeNull();

		pressKey('z', { ctrlKey: true });
		await flush();
		expect(host.querySelector('[data-testid="basket-marker-1"]')).not.toBeNull();

		pressKey('Z', { ctrlKey: true, shiftKey: true });
		await flush();
		expect(host.querySelector('[data-testid="basket-marker-1"]')).toBeNull();
	});
});

describe('X — bend priority (CHSPT-55): the most recently manually-added bend outranks an untouched AutoBend', () => {
	it('X removes the manual bend, not an AutoBend that sits farther along the corridor; undo restores it, redo re-removes it, and a fresh edit clears the redo trail', async () => {
		const editor = makeEditor();
		const { component, host } = mountPage(editor, decodeOf(200, 200));
		mounted = { editor, component, host };
		await loadImage(host);

		pressKey('Tab'); // enter Hole 1 · TEE
		await flush();
		const teeAt = screenPointFor(host, 40, 40);
		dispatchClick(host, teeAt.x, teeAt.y);
		await flush();
		pressKey('Tab'); // accept tee -> BASKET
		await flush();
		const basketAt = screenPointFor(host, 80, 80);
		dispatchClick(host, basketAt.x, basketAt.y);
		await flush();
		pressKey('Tab'); // accept basket -> BENDS
		await flush();
		expect(stepIndicator(host)).toBe('HOLE 1 · BENDS');

		// Completing hole 1 (the 3rd Tab, on BENDS) fires the eager auto-bend
		// detector's "immediate" path (`approveHolePieces`) — mocked here to
		// propose one bend at (70,70), geometrically FARTHER toward the
		// basket than the manual bend placed next at (50,50). This is the
		// exact geometry CHSPT-55 describes: `sortBendsByPosition`
		// (tee→basket projection) puts the manual bend first and the
		// AutoBend last, so the old code's `removeLastBend` popped the
		// AutoBend instead of the bend the user actually just added.
		detectAndApplyCorridorBendsCapsuleAsyncMock.mockImplementation(
			async (currentHoles: readonly AnnotatedHole[], holeId: string) =>
				applyDetectedCorridorBends(currentHoles, holeId, [{ xPx: 70, yPx: 70 }])
		);
		pressKey('Tab'); // completing Tab: approveHolePieces + advance to hole 2
		await flush();

		// Completing auto-advances to hole 2 — come back to hole 1 to see (and
		// act on) its AutoBend.
		sidebarHoleButton(host, 1).click();
		await flush();
		expect(host.querySelector('[data-testid="bend-marker-1-0"]')?.getAttribute('cx')).toBe('70');
		expect(host.querySelector('[data-testid="bend-marker-1-1"]')).toBeNull();

		// Manually add a second bend closer to the tee — CHSPT-55's "Bend2".
		// Sorted by geometric position: [Bend2@0 (t≈0.25), AutoBend@1 (t≈0.75)].
		host.querySelector<HTMLButtonElement>('[data-testid="add-bend-button"]')?.click();
		await flush();
		const bend2At = screenPointFor(host, 50, 50);
		dispatchClick(host, bend2At.x, bend2At.y);
		await flush();
		expect(host.querySelector('[data-testid="bend-marker-1-0"]')?.getAttribute('cx')).toBe('50');
		expect(host.querySelector('[data-testid="bend-marker-1-1"]')?.getAttribute('cx')).toBe('70');

		// X must remove Bend2 (the bend just added), leaving the untouched
		// AutoBend in place — the actual CHSPT-55 regression case.
		pressKey('x');
		await flush();
		expect(host.querySelector('[data-testid="bend-marker-1-0"]')?.getAttribute('cx')).toBe('70');
		expect(host.querySelector('[data-testid="bend-marker-1-1"]')).toBeNull();

		// Ctrl-Z restores Bend2.
		pressKey('z', { ctrlKey: true });
		await flush();
		expect(host.querySelector('[data-testid="bend-marker-1-0"]')?.getAttribute('cx')).toBe('50');
		expect(host.querySelector('[data-testid="bend-marker-1-1"]')?.getAttribute('cx')).toBe('70');

		// Ctrl-Shift-Z redo re-removes Bend2.
		pressKey('Z', { ctrlKey: true, shiftKey: true });
		await flush();
		expect(host.querySelector('[data-testid="bend-marker-1-0"]')?.getAttribute('cx')).toBe('70');
		expect(host.querySelector('[data-testid="bend-marker-1-1"]')).toBeNull();

		// Undo once more (Bend2 restored again) — this leaves one entry on the
		// redo stack. A fresh, unrelated mutation must clear it: standard
		// undo/redo semantics.
		pressKey('z', { ctrlKey: true });
		await flush();
		expect(host.querySelector('[data-testid="bend-marker-1-0"]')?.getAttribute('cx')).toBe('50');
		expect(host.querySelector('[data-testid="bend-marker-1-1"]')?.getAttribute('cx')).toBe('70');

		const widthInput = () => host.querySelector<HTMLInputElement>('[data-testid="corridor-width"]');
		expect(widthInput()?.value).toBe('60');
		pressKey('6'); // +5 — an unrelated mutation, hole 1 is still active
		await flush();
		expect(widthInput()?.value).toBe('65');

		// The redo trail from the X/undo above is gone: Ctrl-Shift-Z is a
		// no-op now — neither the width nor the bends change.
		pressKey('Z', { ctrlKey: true, shiftKey: true });
		await flush();
		expect(widthInput()?.value).toBe('65');
		expect(host.querySelector('[data-testid="bend-marker-1-0"]')?.getAttribute('cx')).toBe('50');
		expect(host.querySelector('[data-testid="bend-marker-1-1"]')?.getAttribute('cx')).toBe('70');
	});
});
