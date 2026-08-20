// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, tick, unmount } from 'svelte';

const { mockGoto } = vi.hoisted(() => ({ mockGoto: vi.fn() }));
vi.mock('$app/navigation', () => ({ goto: mockGoto }));

import AnnotationWorkspace from '../../src/lib/components/AnnotationWorkspace.svelte';
import { ProjectEditor } from '../../src/lib/domain/editor';
import { createProjectState } from '../../src/lib/domain/project';
import type { DecodeImageFile } from '../../src/lib/imageIntake';
import {
	consumePendingAnnotatedRound,
	getPendingAnnotatedRound,
	setPendingHandoff
} from '../../src/lib/session';
import { annotationNavState, requestAnnotationDone } from '../../src/lib/annotationNav.svelte';

const NOW = () => new Date('2026-08-06T00:00:00.000Z');

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

/** Mounts the shared workspace with `mode="round"` — this file exercises the Map Round route. */
function mountPage(editor: ProjectEditor, decode: DecodeImageFile): Mounted {
	const host = document.createElement('div');
	document.body.appendChild(host);
	const component = mount(AnnotationWorkspace, {
		target: host,
		props: { mode: 'round', sessionKey: 'map-round', editor, decode }
	});
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

afterEach(() => {
	document.body.replaceChildren();
	consumePendingAnnotatedRound();
	mockGoto.mockClear();
});

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

async function loadImage(host: HTMLElement): Promise<void> {
	const input = inputEl(host, 'pane-input-source-overview');
	setFileInput(input, new File([new Uint8Array([1, 2, 3, 4])], 'round.png', { type: 'image/png' }));
	await flush();
	setGeometry(host);
}

// There is no "add hole" button in the current UI — handleAnnotationKeyDown
// wires it to the 'n'/'a' keyboard shortcut only, dispatched on window to
// match how the app's own window-level listener receives it. Hole *removal*
// has no UI entry point at all in the current sidebar-grid design (the
// standalone flat hole-bar's remove control it used to have is gone), so this
// file — unlike the pre-split annotateRoundPage.test.ts it replaces — does
// not test removing a hole.
function addHoleViaShortcut(): void {
	window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', bubbles: true }));
}

describe('Map Round keyboard hole creation', () => {
	it('adds holes via the A/N keyboard shortcut and lists them on the round hole bar', async () => {
		const editor = makeEditor();
		const { component, host } = mountPage(editor, decodeOf(640, 480));
		await flush();

		expect(host.querySelectorAll('[data-testid^="hole-select-"]')).toHaveLength(18);

		for (const [key, expectedCount] of [
			['a', '1'],
			['A', '2'],
			['n', '3'],
			['N', '4']
		] as const) {
			const addEvent = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
			window.dispatchEvent(addEvent);
			await flush();
			expect(addEvent.defaultPrevented).toBe(true);
			expect(host.querySelector('[data-testid="annotation-workspace"]')?.getAttribute('data-hole-count')).toBe(
				expectedCount
			);
		}

		// A repeated keydown (held key) must not add a second hole.
		const repeated = new KeyboardEvent('keydown', { key: 'n', repeat: true, bubbles: true, cancelable: true });
		window.dispatchEvent(repeated);
		await flush();
		expect(host.querySelector('[data-testid="annotation-workspace"]')?.getAttribute('data-hole-count')).toBe('4');

		// The same key, while focus is inside an editable field, must be ignored.
		const widthInput = inputEl(host, 'corridor-width');
		widthInput.focus();
		const inputEvent = new KeyboardEvent('keydown', { key: 'n', bubbles: true, cancelable: true });
		widthInput.dispatchEvent(inputEvent);
		await flush();
		expect(inputEvent.defaultPrevented).toBe(false);
		expect(host.querySelector('[data-testid="annotation-workspace"]')?.getAttribute('data-hole-count')).toBe('4');

		unmount(component);
		host.remove();
	});

	// `nextHoleNumber` (`$lib/holeAnnotation.ts`) caps at 18, and nothing in
	// the current UI wires up `addHoleBeyondStandardCourse` — a 19th shortcut
	// press is a no-op, not a 19th hole. (Standard-course-length rounds are
	// the only ones this route currently supports creating from scratch.)
	it('the keyboard shortcut stops at 18 holes — a 19th press is a no-op', async () => {
		const editor = makeEditor();
		const { component, host } = mountPage(editor, decodeOf(640, 480));
		await flush();

		for (let i = 0; i < 18; i += 1) {
			addHoleViaShortcut();
			await flush();
		}
		expect(host.querySelector('[data-testid="annotation-workspace"]')?.getAttribute('data-hole-count')).toBe('18');

		addHoleViaShortcut();
		await flush();
		expect(host.querySelector('[data-testid="annotation-workspace"]')?.getAttribute('data-hole-count')).toBe('18');

		unmount(component);
		host.remove();
	});
});

describe('Map Round corridor width — applies to all holes', () => {
	it('changing the width control updates every hole, not just the active one', async () => {
		const editor = makeEditor();
		const { component, host } = mountPage(editor, decodeOf(640, 480));
		await flush();

		addHoleViaShortcut();
		await flush();
		addHoleViaShortcut();
		await flush();
		expect(host.querySelector('[data-testid="annotation-workspace"]')?.getAttribute('data-hole-count')).toBe('2');

		// Hole 2 is active (most recently added). Changing the width here must
		// carry over to hole 1 as well, per UDisc-parity: one width, every hole.
		const widthInput = inputEl(host, 'corridor-width');
		widthInput.value = '120';
		widthInput.dispatchEvent(new Event('change', { bubbles: true }));
		await flush();

		host.querySelector<HTMLButtonElement>('[data-testid="hole-select-1"]')?.click();
		await flush();
		expect(inputEl(host, 'corridor-width').value).toBe('120');

		host.querySelector<HTMLButtonElement>('[data-testid="hole-select-2"]')?.click();
		await flush();
		expect(inputEl(host, 'corridor-width').value).toBe('120');

		unmount(component);
		host.remove();
	});

	it('a newly added hole inherits the width currently in use, not the bare default', async () => {
		const editor = makeEditor();
		const { component, host } = mountPage(editor, decodeOf(640, 480));
		await flush();

		addHoleViaShortcut();
		await flush();

		const widthInput = inputEl(host, 'corridor-width');
		widthInput.value = '95';
		widthInput.dispatchEvent(new Event('change', { bubbles: true }));
		await flush();

		// Hole 2 is created after the width change, and must start life at 95
		// (the width in use) rather than the DEFAULT_CORRIDOR_WIDTH_PX fallback.
		addHoleViaShortcut();
		await flush();
		expect(host.querySelector('[data-testid="annotation-workspace"]')?.getAttribute('data-hole-count')).toBe('2');
		expect(inputEl(host, 'corridor-width').value).toBe('95');

		unmount(component);
		host.remove();
	});
});

describe('Map Round walking path', () => {
	it('with no hole selected, an empty-space click offers only the walk action and places a walk vertex', async () => {
		const editor = makeEditor();
		const { component, host } = mountPage(editor, decodeOf(200, 200));
		await loadImage(host);

		// No hole exists yet (none was added), so nothing in the hole bar is
		// the active hole — confirmed by no hole-select tab carrying
		// aria-current.
		expect(host.querySelector('[data-testid="hole-bar"] [aria-current="true"]')).toBeNull();

		// The radial menu itself is gated on this dev toggle regardless of mode
		// (`openRadialMenu`'s single check) — off by default.
		host.querySelector<HTMLInputElement>('[data-testid="radial-menu-toggle"]')?.click();
		await flush();

		const clickAt = screenPointFor(host, 40, 40);
		dispatchClick(host, clickAt.x, clickAt.y);
		await flush();

		expect(host.querySelector('[data-testid="radial-action-shot"]')).toBeNull();
		expect(host.querySelector('[data-testid="radial-action-walk"]')).not.toBeNull();

		host.querySelector<HTMLButtonElement>('[data-testid="radial-action-walk"]')?.click();
		await flush();

		expect(host.querySelector('[data-testid="radial-menu"]')).toBeNull();
		expect(host.querySelector('[data-testid="walk-vertex-0"]')).not.toBeNull();

		unmount(component);
		host.remove();
	});

	it('Done includes walkingPath once at least one vertex was captured', async () => {
		// The "Done" control lives in the shared app header, not in this
		// component — see annotateCoursePage.test.ts's Done-gate test for the
		// same note.
		const editor = makeEditor();
		const { component, host } = mountPage(editor, decodeOf(200, 200));
		await loadImage(host);
		host.querySelector<HTMLInputElement>('[data-testid="radial-menu-toggle"]')?.click();
		await flush();

		const clickAt = screenPointFor(host, 60, 60);
		dispatchClick(host, clickAt.x, clickAt.y);
		await flush();
		host.querySelector<HTMLButtonElement>('[data-testid="radial-action-walk"]')?.click();
		await flush();
		expect(host.querySelector('[data-testid="walk-vertex-0"]')).not.toBeNull();

		expect(annotationNavState.canFinish).toBe(true);
		requestAnnotationDone();
		await flush();

		expect(mockGoto).toHaveBeenCalledWith('/create-graphics');
		const pending = getPendingAnnotatedRound();
		expect(pending?.walkingPath).toBeDefined();
		expect(pending?.walkingPath).toHaveLength(1);

		unmount(component);
		host.remove();
	});
});

describe('Map Round pending-handoff destination filtering', () => {
	// Mirrors annotateCoursePage.test.ts's equivalent describe block — see its
	// comment for why these two mount without an injected editor.
	function mountForHandoff(decode: DecodeImageFile): { component: ReturnType<typeof mount>; host: HTMLDivElement } {
		const host = document.createElement('div');
		document.body.appendChild(host);
		const component = mount(AnnotationWorkspace, {
			target: host,
			props: { mode: 'round', sessionKey: 'map-round', decode }
		});
		return { component, host };
	}

	afterEach(() => {
		document.body.replaceChildren();
	});

	it('ignores a pending handoff destined for Annotate Course — no auto-import', async () => {
		setPendingHandoff({
			blob: new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/png' }),
			fileName: 'course.png',
			targetRole: 'source-overview',
			destination: 'annotate-course'
		});
		const { component, host } = mountForHandoff(decodeOf(200, 200));
		await flush();

		expect(host.querySelector('[data-testid="pending-handoff"]')).toBeNull();
		expect(host.querySelector('[data-testid="pane-filename-source-overview"]')).toBeNull();

		unmount(component);
	});

	it('auto-imports a pending handoff destined for Map Round (safe arrival: no image, no holes yet)', async () => {
		setPendingHandoff({
			blob: new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/png' }),
			fileName: 'round.png',
			targetRole: 'source-overview',
			destination: 'map-round'
		});
		const { component, host } = mountForHandoff(decodeOf(200, 200));
		await flush();

		expect(host.querySelector('[data-testid="pending-handoff"]')).toBeNull();
		expect(host.querySelector('[data-testid="pane-filename-source-overview"]')?.textContent).toContain(
			'round.png'
		);

		unmount(component);
	});
});
