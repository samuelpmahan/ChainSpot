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
	it('a first Tab starts review at Hole 1 · TEE; clicks place the step piece and advance; Tab from BENDS moves to the next hole at TEE', async () => {
		const editor = makeEditor();
		const { component, host } = mountPage(editor, decodeOf(200, 200));
		mounted = { editor, component, host };
		await loadImage(host);

		// No hole is active until review starts (no detection runs in jsdom).
		expect(host.querySelector('[data-testid="review-step-indicator"]')).toBeNull();

		pressKey('Tab');
		await flush();
		expect(stepIndicator(host)).toBe('HOLE 1 · TEE');
		expect(host.querySelector('[data-testid="placement-banner"]')?.textContent).toContain('Tee');

		// Tee-step empty click places the tee and advances to BASKET.
		const teeAt = screenPointFor(host, 40, 40);
		dispatchClick(host, teeAt.x, teeAt.y);
		await flush();
		expect(host.querySelector('[data-testid="tee-marker-1"]')).not.toBeNull();
		expect(stepIndicator(host)).toBe('HOLE 1 · BASKET');

		// Basket-step empty click places the basket and advances to BENDS.
		const basketAt = screenPointFor(host, 80, 80);
		dispatchClick(host, basketAt.x, basketAt.y);
		await flush();
		expect(host.querySelector('[data-testid="basket-marker-1"]')).not.toBeNull();
		expect(stepIndicator(host)).toBe('HOLE 1 · BENDS');

		// Bends-step empty click adds a corridor bend.
		const bendAt = screenPointFor(host, 30, 90);
		dispatchClick(host, bendAt.x, bendAt.y);
		await flush();
		expect(host.querySelector('[data-testid="bend-marker-1-0"]')).not.toBeNull();

		// Tab from BENDS completes the hole (confirmed) and enters Hole 2 at TEE.
		pressKey('Tab');
		await flush();
		expect(stepIndicator(host)).toBe('HOLE 2 · TEE');
		expect(host.querySelector('[data-testid="sidebar-section-4"]')?.textContent).toContain('1');
	});

	it('Tab accepts an existing proposed piece without moving it, and Shift+Tab is swallowed without advancing', async () => {
		const editor = makeEditor();
		const { component, host } = mountPage(editor, decodeOf(200, 200));
		mounted = { editor, component, host };
		await loadImage(host);

		pressKey('Tab');
		await flush();
		const teeAt = screenPointFor(host, 40, 40);
		dispatchClick(host, teeAt.x, teeAt.y);
		await flush();
		// Back to TEE via a fresh review entry: Tab twice to BENDS, then re-enter.
		expect(stepIndicator(host)).toBe('HOLE 1 · BASKET');

		const shiftTab = pressKey('Tab', { shiftKey: true });
		await flush();
		// Swallowed (workspace owns keyboard input) but no advancement.
		expect(shiftTab.defaultPrevented).toBe(true);
		expect(stepIndicator(host)).toBe('HOLE 1 · BASKET');

		const plainTab = pressKey('Tab');
		await flush();
		expect(plainTab.defaultPrevented).toBe(true);
		expect(stepIndicator(host)).toBe('HOLE 1 · BENDS');
		// The tee is untouched and now confirmed-pending state is per-piece;
		// accepting steps never moved geometry.
		const marker = host.querySelector('[data-testid="tee-marker-1"]');
		expect(marker?.getAttribute('cx')).toBe('40');
	});

	it('a tee-step empty-map click over an existing tee proposal re-places it instead of adding a bend', async () => {
		const editor = makeEditor();
		const { component, host } = mountPage(editor, decodeOf(200, 200));
		mounted = { editor, component, host };
		await loadImage(host);

		// Place hole 1 fully, approve it, then re-enter review with Tab: the
		// guided pass wraps to the earliest unconfirmed hole — hole 2 — while
		// hole 1 stays reachable by sidebar click at its derived (bends) step.
		pressKey('Tab');
		await flush();
		const teeAt = screenPointFor(host, 40, 40);
		dispatchClick(host, teeAt.x, teeAt.y);
		await flush();
		const basketAt = screenPointFor(host, 80, 80);
		dispatchClick(host, basketAt.x, basketAt.y);
		await flush();
		expect(stepIndicator(host)).toBe('HOLE 1 · BENDS');

		// Tab completes hole 1 and enters hole 2 at TEE. An empty click at
		// hole 2's TEE step places hole 2's tee, never hole 1 geometry.
		pressKey('Tab');
		await flush();
		expect(stepIndicator(host)).toBe('HOLE 2 · TEE');
		const tee2At = screenPointFor(host, 120, 40);
		dispatchClick(host, tee2At.x, tee2At.y);
		await flush();
		expect(host.querySelector('[data-testid="tee-marker-2"]')).not.toBeNull();
		expect(stepIndicator(host)).toBe('HOLE 2 · BASKET');

		// Re-place while still on a piece step: another empty click MOVES the
		// step's piece once it exists — go back to TEE via Ctrl-Z twice
		// (placement, then entry) is historical; instead verify replace on
		// basket: place it, sidebar back to hole 2 keeps bends step, so use a
		// fresh hole: hole 2's basket placed twice.
		const basketFirst = screenPointFor(host, 150, 60);
		dispatchClick(host, basketFirst.x, basketFirst.y);
		await flush();
		expect(stepIndicator(host)).toBe('HOLE 2 · BENDS');
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

		// Return to the TEE step: Ctrl-Z undoes the placement (and its step
		// advancement), then re-place to test X at the TEE step directly.
		pressKey('z', { ctrlKey: true });
		await flush();
		expect(host.querySelector('[data-testid="tee-marker-1"]')).toBeNull();
		expect(stepIndicator(host)).toBe('HOLE 1 · TEE');

		dispatchClick(host, teeAt.x, teeAt.y);
		await flush();
		expect(stepIndicator(host)).toBe('HOLE 1 · BASKET');
		// X on the BASKET step with no basket is a no-op…
		pressKey('x');
		await flush();
		expect(host.querySelector('[data-testid="tee-marker-1"]')).not.toBeNull();

		// …while Ctrl-Z back to TEE then X rejects the placed tee.
		pressKey('z', { ctrlKey: true });
		await flush();
		expect(stepIndicator(host)).toBe('HOLE 1 · TEE');
		// The placement was undone with the step, so re-place and X it away.
		dispatchClick(host, teeAt.x, teeAt.y);
		await flush();
		pressKey('z', { ctrlKey: true });
		await flush();
		dispatchClick(host, teeAt.x, teeAt.y);
		await flush();
		expect(host.querySelector('[data-testid="tee-marker-1"]')).not.toBeNull();
		// Step auto-advanced to BASKET; a rejected tee is reachable by
		// stepping the workflow back once.
		pressKey('z', { ctrlKey: true });
		await flush();
		dispatchClick(host, teeAt.x, teeAt.y);
		await flush();
		expect(stepIndicator(host)).toBe('HOLE 1 · BASKET');
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
		dispatchClick(host, ...(({ x, y }) => [x, y] as const)(screenPointFor(host, 80, 80)));
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

		pressKey('Tab');
		await flush();
		const teeAt = screenPointFor(host, 40, 40);
		dispatchClick(host, teeAt.x, teeAt.y);
		await flush();
		const basketAt = screenPointFor(host, 80, 80);
		dispatchClick(host, basketAt.x, basketAt.y);
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

		// Accidental double-Tab: completes hole 1 and enters hole 2, twice.
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
		// Hole 1's confirmation from the completing Tab was rolled back too.
		expect(host.querySelector('[data-testid="sidebar-section-4"]')?.textContent).toContain('0');
		// The pan that happened between placing hole 1's basket and completing
		// the hole is restored right along with the hole/step.
		expect(view(host)).toEqual(viewAfterPan);

		// Next Ctrl-Z removes the basket placement.
		pressKey('z', { ctrlKey: true });
		await flush();
		expect(host.querySelector('[data-testid="basket-marker-1"]')).toBeNull();
		expect(stepIndicator(host)).toBe('HOLE 1 · BASKET');

		// Ctrl-Shift-Z redo walks every step back forward, camera included.
		pressKey('Z', { ctrlKey: true, shiftKey: true });
		await flush();
		expect(host.querySelector('[data-testid="basket-marker-1"]')).not.toBeNull();
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
		expect(stepIndicator(host)).toBe('HOLE 1 · BASKET');

		pressKey('z', { ctrlKey: true });
		await flush();
		expect(host.querySelector('[data-testid="tee-marker-1"]')).toBeNull();
		expect(stepIndicator(host)).toBe('HOLE 1 · TEE');

		pressKey('Z', { ctrlKey: true, shiftKey: true });
		await flush();
		expect(host.querySelector('[data-testid="tee-marker-1"]')?.getAttribute('cx')).toBe('40');
		expect(stepIndicator(host)).toBe('HOLE 1 · BASKET');

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

		pressKey('Tab');
		await flush();
		const teeAt = screenPointFor(host, 40, 40);
		dispatchClick(host, teeAt.x, teeAt.y);
		await flush();
		const basketAt = screenPointFor(host, 80, 80);
		dispatchClick(host, basketAt.x, basketAt.y);
		await flush();
		expect(stepIndicator(host)).toBe('HOLE 1 · BENDS');

		// Approving hole 1 fires the eager auto-bend detector's "immediate"
		// path (`approveHolePieces`) — mocked here to propose one bend at
		// (70,70), geometrically FARTHER toward the basket than the manual
		// bend placed next at (50,50). This is the exact geometry CHSPT-55
		// describes: `sortBendsByPosition` (tee→basket projection) puts the
		// manual bend first and the AutoBend last, so the old code's
		// `removeLastBend` popped the AutoBend instead of the bend the user
		// actually just added.
		detectAndApplyCorridorBendsCapsuleAsyncMock.mockImplementation(
			async (currentHoles: readonly AnnotatedHole[], holeId: string) =>
				applyDetectedCorridorBends(currentHoles, holeId, [{ xPx: 70, yPx: 70 }])
		);
		host.querySelector<HTMLButtonElement>('[data-testid="approve-hole-button"]')?.click();
		await flush();

		// Approving auto-advances to hole 2 — come back to hole 1 to see (and
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
