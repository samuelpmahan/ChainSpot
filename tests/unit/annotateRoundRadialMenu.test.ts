import { describe, expect, it } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import Page from '../../src/routes/annotate-round/+page.svelte';
import { ProjectEditor } from '../../src/lib/domain/editor';
import { createProjectState } from '../../src/lib/domain/project';
import type { DecodeImageFile } from '../../src/lib/imageIntake';

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
	const pointerId = 31;
	element.dispatchEvent(
		new PointerEvent('pointerdown', { button: 0, pointerId, clientX: x, clientY: y, bubbles: true })
	);
	window.dispatchEvent(new PointerEvent('pointerup', { pointerId, clientX: x, clientY: y }));
}

/**
 * A touch tap that drifts by `driftPx` before lifting — ordinary finger
 * imprecision, well inside the platform touch-slop norm (~8-10px) but past
 * the flat 4px mouse/trackpad threshold this component used before pointer
 * types were distinguished.
 */
function dispatchTouchTapWithDrift(host: HTMLElement, x: number, y: number, driftPx: number): void {
	const element = scene(host);
	const pointerId = 32;
	element.dispatchEvent(
		new PointerEvent('pointerdown', {
			button: 0,
			pointerId,
			pointerType: 'touch',
			clientX: x,
			clientY: y,
			bubbles: true
		})
	);
	window.dispatchEvent(
		new PointerEvent('pointermove', {
			pointerId,
			pointerType: 'touch',
			clientX: x + driftPx,
			clientY: y
		})
	);
	window.dispatchEvent(
		new PointerEvent('pointerup', {
			pointerId,
			pointerType: 'touch',
			clientX: x + driftPx,
			clientY: y
		})
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

/** Clicks the given action's button in the currently-open radial menu. */
function clickAction(host: HTMLElement, action: string): void {
	const button = host.querySelector<HTMLButtonElement>(`[data-testid="radial-action-${action}"]`);
	if (!button) throw new Error(`missing radial-action-${action}`);
	button.click();
}

async function flush(): Promise<void> {
	for (let i = 0; i < 16; i += 1) {
		await tick();
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

async function setUpHoleWithImage(host: HTMLElement, editor: ProjectEditor): Promise<void> {
	const input = host.querySelector<HTMLInputElement>('[data-testid="pane-input-source-overview"]');
	if (!input) throw new Error('missing source input');
	Object.defineProperty(input, 'files', {
		configurable: true,
		value: [new File([new Uint8Array([1, 2, 3, 4])], 'course.png', { type: 'image/png' })]
	});
	input.dispatchEvent(new Event('change', { bubbles: true }));
	await flush();
	setGeometry(host);
	void editor;

	host.querySelector<HTMLButtonElement>('[data-testid="hole-add"]')?.click();
	await flush();
}

describe('Annotate Round radial menu', () => {
	it('in the default Map mode, opens on an empty-space click with a button per course-geometry kind not yet on the hole (no shot), and places a tee', async () => {
		const editor = makeEditor();
		const { component, host } = mountPage(editor, decodeOf(200, 200));
		await setUpHoleWithImage(host, editor);

		expect(host.querySelector('[data-testid="radial-menu"]')).toBeNull();

		const clickAt = screenPointFor(host, 50, 50);
		dispatchClick(host, clickAt.x, clickAt.y);
		await flush();

		expect(host.querySelector('[data-testid="radial-menu"]')).not.toBeNull();
		expect(host.querySelector('[data-testid="radial-action-tee"]')).not.toBeNull();
		expect(host.querySelector('[data-testid="radial-action-basket"]')).not.toBeNull();
		expect(host.querySelector('[data-testid="radial-action-shot"]')).toBeNull();
		expect(host.querySelector('[data-testid="radial-action-bend"]')).not.toBeNull();
		expect(host.querySelector('[data-testid="tee-marker-1"]')).toBeNull();

		clickAction(host, 'tee');
		await flush();

		expect(host.querySelector('[data-testid="radial-menu"]')).toBeNull();
		expect(host.querySelector('[data-testid="tee-marker-1"]')).not.toBeNull();

		unmount(component);
		host.remove();
	});

	it('opens on a touch tap that drifts 8px before lifting (pointer-type-aware click slop)', async () => {
		// Below the 4px mouse threshold this tap would have crossed into a pan
		// (see docs/imageviewport-event-contract.md, H9): onViewportClick never
		// fires and the radial menu never opens. The touch slop (10px) fixes
		// this — an 8px drift is still an ordinary tap.
		//
		// Geometry is set *before* the first flush (not inside
		// `setUpHoleWithImage`, which sets it only after the image loads) so the
		// viewport's own initial-size effect — this environment has no
		// `ResizeObserver` to correct it later — captures the real 400x400 pane
		// instead of jsdom's default 0x0-falls-back-to-1x1. A drift measured in
		// screen px only stays proportionate to the image's 200x200 bounds at a
		// realistic fit zoom; at the 1x1-pane zoom every other test in this file
		// tolerates (because it round-trips a zero-drift click through the same
		// transform), an 8px screen drift would translate to hundreds of image
		// px and land outside the image regardless of the slop fix under test.
		const editor = makeEditor();
		const { component, host } = mountPage(editor, decodeOf(200, 200));
		setGeometry(host);
		await setUpHoleWithImage(host, editor);

		expect(host.querySelector('[data-testid="radial-menu"]')).toBeNull();

		const clickAt = screenPointFor(host, 50, 50);
		dispatchTouchTapWithDrift(host, clickAt.x, clickAt.y, 8);
		await flush();

		expect(host.querySelector('[data-testid="radial-menu"]')).not.toBeNull();
		expect(host.querySelector('[data-testid="radial-action-tee"]')).not.toBeNull();

		unmount(component);
		host.remove();
	});

	it('does not open on a touch tap that drifts 11px before lifting — that is a real pan', async () => {
		const editor = makeEditor();
		const { component, host } = mountPage(editor, decodeOf(200, 200));
		setGeometry(host);
		await setUpHoleWithImage(host, editor);

		const clickAt = screenPointFor(host, 50, 50);
		dispatchTouchTapWithDrift(host, clickAt.x, clickAt.y, 11);
		await flush();

		expect(host.querySelector('[data-testid="radial-menu"]')).toBeNull();

		unmount(component);
		host.remove();
	});

	it('in Round mode, opens on an empty-space click with a shot action (hole active) and a walk action, and places a shot', async () => {
		const editor = makeEditor();
		const { component, host } = mountPage(editor, decodeOf(200, 200));
		await setUpHoleWithImage(host, editor);
		host.querySelector<HTMLButtonElement>('[data-testid="annotation-mode-round"]')?.click();
		await flush();

		const clickAt = screenPointFor(host, 50, 50);
		dispatchClick(host, clickAt.x, clickAt.y);
		await flush();

		expect(host.querySelector('[data-testid="radial-action-tee"]')).toBeNull();
		expect(host.querySelector('[data-testid="radial-action-basket"]')).toBeNull();
		expect(host.querySelector('[data-testid="radial-action-bend"]')).toBeNull();
		expect(host.querySelector('[data-testid="radial-action-shot"]')).not.toBeNull();
		expect(host.querySelector('[data-testid="radial-action-walk"]')).not.toBeNull();

		clickAction(host, 'shot');
		await flush();

		expect(host.querySelector('[data-testid="radial-menu"]')).toBeNull();
		expect(host.querySelector('[data-testid="shot-marker-1-0"]')).not.toBeNull();

		unmount(component);
		host.remove();
	});

	it('opens a delete-only menu on an existing marker and removes just that point', async () => {
		const editor = makeEditor();
		const { component, host } = mountPage(editor, decodeOf(200, 200));
		await setUpHoleWithImage(host, editor);

		const clickAt = screenPointFor(host, 60, 60);
		dispatchClick(host, clickAt.x, clickAt.y);
		await flush();
		clickAction(host, 'tee');
		await flush();
		expect(host.querySelector('[data-testid="tee-marker-1"]')).not.toBeNull();

		// Click directly on the placed tee (no drag) to open its delete menu.
		dispatchClick(host, clickAt.x, clickAt.y);
		await flush();

		expect(host.querySelector('[data-testid="radial-menu"]')).not.toBeNull();
		expect(host.querySelector('[data-testid="radial-action-delete"]')).not.toBeNull();
		expect(host.querySelector('[data-testid="radial-action-tee"]')).toBeNull();

		clickAction(host, 'delete');
		await flush();

		expect(host.querySelector('[data-testid="radial-menu"]')).toBeNull();
		expect(host.querySelector('[data-testid="tee-marker-1"]')).toBeNull();

		unmount(component);
		host.remove();
	});

	it('a pointerdown outside the menu closes it without acting', async () => {
		const editor = makeEditor();
		const { component, host } = mountPage(editor, decodeOf(200, 200));
		await setUpHoleWithImage(host, editor);

		const clickAt = screenPointFor(host, 40, 40);
		dispatchClick(host, clickAt.x, clickAt.y);
		await flush();
		expect(host.querySelector('[data-testid="radial-menu"]')).not.toBeNull();

		// Outside the popover and outside the canvas entirely — a click that
		// cannot land on any marker or the placement callback either.
		document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
		await flush();

		expect(host.querySelector('[data-testid="radial-menu"]')).toBeNull();
		expect(host.querySelector('[data-testid="tee-marker-1"]')).toBeNull();
		expect(host.querySelector('[data-testid="basket-marker-1"]')).toBeNull();

		unmount(component);
		host.remove();
	});

	it('switching the active hole closes an open empty-space menu instead of leaving it targeting the old hole', async () => {
		const editor = makeEditor();
		const { component, host } = mountPage(editor, decodeOf(200, 200));
		await setUpHoleWithImage(host, editor);

		// Adding a second hole makes it the active one (handleAddHole), so the
		// menu opened below targets hole 2 from the start.
		host.querySelector<HTMLButtonElement>('[data-testid="hole-add"]')?.click();
		await flush();

		const clickAt = screenPointFor(host, 30, 30);
		dispatchClick(host, clickAt.x, clickAt.y);
		await flush();
		expect(host.querySelector('[data-testid="radial-menu"]')).not.toBeNull();

		// Switching back to hole 1 without dismissing the menu must close it.
		host.querySelector<HTMLButtonElement>('[data-testid="hole-select-1"]')?.click();
		await flush();

		expect(host.querySelector('[data-testid="radial-menu"]')).toBeNull();

		// A fresh click now correctly opens a menu for hole 1, and choosing an
		// action places on hole 1, not hole 2 (the stale menu's original target).
		dispatchClick(host, clickAt.x, clickAt.y);
		await flush();
		clickAction(host, 'tee');
		await flush();

		expect(host.querySelector('[data-testid="tee-marker-1"]')).not.toBeNull();
		expect(host.querySelector('[data-testid="tee-marker-2"]')).toBeNull();

		unmount(component);
		host.remove();
	});

	it('Escape dismisses an open menu without acting and returns focus to the viewport', async () => {
		const editor = makeEditor();
		const { component, host } = mountPage(editor, decodeOf(200, 200));
		await setUpHoleWithImage(host, editor);

		const clickAt = screenPointFor(host, 70, 70);
		dispatchClick(host, clickAt.x, clickAt.y);
		await flush();
		expect(host.querySelector('[data-testid="radial-menu"]')).not.toBeNull();

		const menu = host.querySelector<HTMLElement>('[data-testid="radial-menu"]');
		menu?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
		await flush();

		expect(host.querySelector('[data-testid="radial-menu"]')).toBeNull();
		expect(host.querySelector('[data-testid="tee-marker-1"]')).toBeNull();
		expect(document.activeElement).toBe(scene(host));

		unmount(component);
		host.remove();
	});

	it('the menu is a real HTML popover of accessible buttons, not an SVG group', async () => {
		const editor = makeEditor();
		const { component, host } = mountPage(editor, decodeOf(200, 200));
		await setUpHoleWithImage(host, editor);

		const clickAt = screenPointFor(host, 50, 50);
		dispatchClick(host, clickAt.x, clickAt.y);
		await flush();

		const menu = host.querySelector<HTMLElement>('[data-testid="radial-menu"]');
		expect(menu).not.toBeNull();
		expect(menu?.tagName).toBe('DIV');
		expect(menu?.getAttribute('role')).toBe('menu');

		const teeButton = host.querySelector<HTMLButtonElement>('[data-testid="radial-action-tee"]');
		expect(teeButton?.tagName).toBe('BUTTON');
		expect(teeButton?.getAttribute('role')).toBe('menuitem');
		expect(teeButton?.getAttribute('aria-label')).toBe('Tee');
		// Roving tabindex: exactly one item is a tab stop, and focus already
		// moved into the menu on open.
		expect(teeButton?.getAttribute('tabindex')).toBe('0');
		expect(document.activeElement).toBe(teeButton);

		unmount(component);
		host.remove();
	});
});
