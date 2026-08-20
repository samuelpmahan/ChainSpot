// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import AnnotationWorkspace from '../../src/lib/components/AnnotationWorkspace.svelte';
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

function mountPage(
	editor: ProjectEditor,
	decode: DecodeImageFile,
	mode: 'map' | 'round' = 'map'
): Mounted {
	const host = document.createElement('div');
	document.body.appendChild(host);
	const sessionKey = mode === 'map' ? 'annotate-course' : 'map-round';
	const component = mount(AnnotationWorkspace, {
		target: host,
		props: { mode, sessionKey, editor, decode }
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

/** Placement never auto-advances GuidedReview (CHSPT-48 hotfix, 499ef3e) -- Tab accepts the step. */
function pressTab(): void {
	window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
}

/** Clicks the given action's button in the currently-open radial menu. */
function clickAction(host: HTMLElement, action: string): void {
	const button = host.querySelector<HTMLButtonElement>(`[data-testid="radial-action-${action}"]`);
	if (!button) throw new Error(`missing radial-action-${action}`);
	button.click();
}

/** There is no "add hole" button in the current UI -- handleAnnotationKeyDown wires it to the 'n'/'a' keyboard shortcut only, dispatched on window to match how the app's own window-level listener receives it. */
function addHoleViaShortcut(): void {
	window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', bubbles: true }));
}

async function flush(): Promise<void> {
	for (let i = 0; i < 16; i += 1) {
		await tick();
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

async function setUpHoleWithImage(host: HTMLElement, editor: ProjectEditor): Promise<void> {
	// Geometry must be mocked BEFORE the image loads: ImageEditorPane calls
	// vp.fit() reactively the moment the image resource becomes available, and
	// fit() reads the pane's client size at that exact moment. Mocking it
	// afterward leaves that first fit() computed against jsdom's real
	// (zero-sized) layout, producing a degenerate near-zero zoom.
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
	// Radial menu is off by default; every test in this file exercises it directly.
	host.querySelector<HTMLInputElement>('[data-testid="radial-menu-toggle"]')?.click();
	await flush();

	// An empty-space Map-mode click on a hole still missing its tee or basket
	// bypasses the radial menu entirely now (it places that piece directly via
	// the sidebar-driven placing flow — see annotateRoundSidebar.test.ts). This
	// file is only about what the radial menu itself still does (bends, and
	// Round mode's shot/walk), so hole 1 is pre-completed with a tee and basket
	// — opposite corners, well outside MARKER_HIT_RADIUS_PX of each other (else
	// the second click would hit the first marker instead of empty space) and
	// away from every test's own 30-70 range click coordinates — putting it in
	// section 4/5 where an empty click reaches the radial menu again (bend
	// only in Map mode).
	const tee = screenPointFor(host, 2, 2);
	dispatchClick(host, tee.x, tee.y);
	await flush();
	pressTab();
	await flush();
	const basket = screenPointFor(host, 198, 2);
	dispatchClick(host, basket.x, basket.y);
	await flush();
	pressTab();
	await flush();
}

describe('Annotation radial menu (Annotate Course / Map Round)', () => {
	// Tee/basket creation no longer opens the radial menu at all — the
	// redesigned sidebar's placing flow (see annotateRoundSidebar.test.ts)
	// intercepts an empty-space Map-mode click and places the missing piece
	// directly whenever the active hole is still missing a tee or basket.
	// The radial menu's Map-mode empty-space wedge set is now bend-only.
	it('in the default Map mode, opens on an empty-space click with only a bend action (tee/basket bypass the menu entirely), and places a bend', async () => {
		const editor = makeEditor();
		const { component, host } = mountPage(editor, decodeOf(200, 200));
		await setUpHoleWithImage(host, editor);

		expect(host.querySelector('[data-testid="radial-menu"]')).toBeNull();

		const clickAt = screenPointFor(host, 50, 50);
		dispatchClick(host, clickAt.x, clickAt.y);
		await flush();

		expect(host.querySelector('[data-testid="radial-menu"]')).not.toBeNull();
		expect(host.querySelector('[data-testid="radial-action-tee"]')).toBeNull();
		expect(host.querySelector('[data-testid="radial-action-basket"]')).toBeNull();
		expect(host.querySelector('[data-testid="radial-action-shot"]')).toBeNull();
		expect(host.querySelector('[data-testid="radial-action-bend"]')).not.toBeNull();
		expect(host.querySelector('[data-testid="bend-marker-1-0"]')).toBeNull();

		clickAction(host, 'bend');
		await flush();

		expect(host.querySelector('[data-testid="radial-menu"]')).toBeNull();
		expect(host.querySelector('[data-testid="bend-marker-1-0"]')).not.toBeNull();

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
		expect(host.querySelector('[data-testid="radial-action-bend"]')).not.toBeNull();

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

	it('on Map Round, opens on an empty-space click with a shot action (hole active) and a walk action, and places a shot', async () => {
		const editor = makeEditor();
		// Mode is a fixed prop set once by the mounting route (Annotate Course vs.
		// Map Round), not a runtime toggle — this instance mounts directly in
		// round mode rather than mounting in map mode and switching afterward.
		// `setUpHoleWithImage`'s tail (placing tee/basket via empty-space clicks)
		// is Map-mode-only wiring, so this test only reuses its image-load half
		// and adds a hole directly — Round mode's `shot` wedge only needs an
		// active hole, never a placed tee/basket.
		const { component, host } = mountPage(editor, decodeOf(200, 200), 'round');
		setGeometry(host);
		const input = host.querySelector<HTMLInputElement>('[data-testid="pane-input-source-overview"]');
		if (!input) throw new Error('missing source input');
		Object.defineProperty(input, 'files', {
			configurable: true,
			value: [new File([new Uint8Array([1, 2, 3, 4])], 'course.png', { type: 'image/png' })]
		});
		input.dispatchEvent(new Event('change', { bubbles: true }));
		await flush();
		addHoleViaShortcut();
		// The radial menu itself is gated on this dev toggle regardless of mode
		// (`openRadialMenu`'s single check) — off by default, exercised directly.
		host.querySelector<HTMLInputElement>('[data-testid="radial-menu-toggle"]')?.click();
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

	it('on Map Round, deletes an existing shot by clicking it directly, with the radial-menu dev toggle left OFF', async () => {
		const editor = makeEditor();
		const { component, host } = mountPage(editor, decodeOf(200, 200), 'round');
		setGeometry(host);
		const input = host.querySelector<HTMLInputElement>('[data-testid="pane-input-source-overview"]');
		if (!input) throw new Error('missing source input');
		Object.defineProperty(input, 'files', {
			configurable: true,
			value: [new File([new Uint8Array([1, 2, 3, 4])], 'course.png', { type: 'image/png' })]
		});
		input.dispatchEvent(new Event('change', { bubbles: true }));
		await flush();
		addHoleViaShortcut();
		const toggle = host.querySelector<HTMLInputElement>('[data-testid="radial-menu-toggle"]');
		toggle?.click();
		await flush();

		const clickAt = screenPointFor(host, 50, 50);
		dispatchClick(host, clickAt.x, clickAt.y);
		await flush();
		clickAction(host, 'shot');
		await flush();
		expect(host.querySelector('[data-testid="shot-marker-1-0"]')).not.toBeNull();

		// Flip the dev toggle back off, then prove the on-marker delete menu
		// still opens (it's no longer gated by it).
		toggle?.click();
		await flush();
		expect(toggle?.checked).toBe(false);

		dispatchClick(host, clickAt.x, clickAt.y);
		await flush();

		expect(host.querySelector('[data-testid="radial-menu"]')).not.toBeNull();
		expect(host.querySelector('[data-testid="radial-action-delete"]')).not.toBeNull();

		clickAction(host, 'delete');
		await flush();

		expect(host.querySelector('[data-testid="radial-menu"]')).toBeNull();
		expect(host.querySelector('[data-testid="shot-marker-1-0"]')).toBeNull();

		unmount(component);
		host.remove();
	});

	it('opens a delete-only menu on an existing bend marker and removes just that point', async () => {
		const editor = makeEditor();
		const { component, host } = mountPage(editor, decodeOf(200, 200));
		await setUpHoleWithImage(host, editor);

		const clickAt = screenPointFor(host, 60, 60);
		dispatchClick(host, clickAt.x, clickAt.y);
		await flush();
		clickAction(host, 'bend');
		await flush();
		expect(host.querySelector('[data-testid="bend-marker-1-0"]')).not.toBeNull();

		// Click directly on the placed bend (no drag) to open its delete menu.
		dispatchClick(host, clickAt.x, clickAt.y);
		await flush();

		expect(host.querySelector('[data-testid="radial-menu"]')).not.toBeNull();
		expect(host.querySelector('[data-testid="radial-action-delete"]')).not.toBeNull();
		expect(host.querySelector('[data-testid="radial-action-bend"]')).toBeNull();

		clickAction(host, 'delete');
		await flush();

		expect(host.querySelector('[data-testid="radial-menu"]')).toBeNull();
		expect(host.querySelector('[data-testid="bend-marker-1-0"]')).toBeNull();

		unmount(component);
		host.remove();
	});

	it('deletes an existing bend by clicking it directly, with the radial-menu dev toggle left OFF — the on-marker delete menu is never gated', async () => {
		const editor = makeEditor();
		const { component, host } = mountPage(editor, decodeOf(200, 200));
		await setUpHoleWithImage(host, editor);

		// Placing the bend is still the empty-space case, so it needs the
		// toggle on (matching every other test in this file); flip it back off
		// immediately after to prove the *delete* menu doesn't need it.
		const clickAt = screenPointFor(host, 60, 60);
		dispatchClick(host, clickAt.x, clickAt.y);
		await flush();
		clickAction(host, 'bend');
		await flush();
		expect(host.querySelector('[data-testid="bend-marker-1-0"]')).not.toBeNull();

		const toggle = host.querySelector<HTMLInputElement>('[data-testid="radial-menu-toggle"]');
		toggle?.click();
		await flush();
		expect(toggle?.checked).toBe(false);

		dispatchClick(host, clickAt.x, clickAt.y);
		await flush();

		expect(host.querySelector('[data-testid="radial-menu"]')).not.toBeNull();
		expect(host.querySelector('[data-testid="radial-action-delete"]')).not.toBeNull();

		clickAction(host, 'delete');
		await flush();

		expect(host.querySelector('[data-testid="radial-menu"]')).toBeNull();
		expect(host.querySelector('[data-testid="bend-marker-1-0"]')).toBeNull();

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
		expect(host.querySelector('[data-testid="bend-marker-1-0"]')).toBeNull();

		unmount(component);
		host.remove();
	});

	it('switching the active hole closes an open empty-space menu instead of leaving it targeting the old hole', async () => {
		const editor = makeEditor();
		const { component, host } = mountPage(editor, decodeOf(200, 200));
		await setUpHoleWithImage(host, editor);

		// Adding a second hole makes it the active one (handleAddHole), so the
		// menu opened below targets hole 2 from the start. It also needs its own
		// tee+basket first (off-path points, same reasoning as setUpHoleWithImage)
		// so its own empty clicks reach the bend radial menu instead of the
		// placing flow claiming them.
		addHoleViaShortcut();
		await flush();
		const hole2Tee = screenPointFor(host, 2, 198);
		dispatchClick(host, hole2Tee.x, hole2Tee.y);
		await flush();
		pressTab();
		await flush();
		const hole2Basket = screenPointFor(host, 198, 198);
		dispatchClick(host, hole2Basket.x, hole2Basket.y);
		await flush();
		pressTab();
		await flush();

		const clickAt = screenPointFor(host, 30, 30);
		dispatchClick(host, clickAt.x, clickAt.y);
		await flush();
		expect(host.querySelector('[data-testid="radial-menu"]')).not.toBeNull();

		// Switching back to hole 1 without dismissing the menu must close it. In
		// Map mode hole selection now lives in the sidebar grid, not the flat bar
		// — and, unlike the old flat bar, clicking a sidebar hole also zooms the
		// camera to it, so screen coordinates computed before this click are
		// stale afterward.
		host.querySelector<HTMLButtonElement>('[data-testid="sidebar-hole-1"]')?.click();
		await flush();

		expect(host.querySelector('[data-testid="radial-menu"]')).toBeNull();

		// A fresh click now correctly opens a menu for hole 1, and choosing an
		// action places on hole 1, not hole 2 (the stale menu's original target).
		// The sidebar click also panned the camera to hole 1's canonical focus
		// anchor (its badge if one exists, else its tee — see CHSPT-47), at
		// whatever zoom was already in effect — so screen coordinates computed
		// before this click are stale afterward. This hole has no CV-detected
		// badge (it was placed by hand), so focus lands on its tee; clicking
		// well away from the tee, in image space where nothing is placed, is
		// the realistic empty-space click, recomputed live via `screenPointFor`
		// rather than assuming a fixed pane-center coordinate.
		const emptySpaceOnHole1 = screenPointFor(host, 100, 100);
		dispatchClick(host, emptySpaceOnHole1.x, emptySpaceOnHole1.y);
		await flush();
		clickAction(host, 'bend');
		await flush();

		expect(host.querySelector('[data-testid="bend-marker-1-0"]')).not.toBeNull();
		expect(host.querySelector('[data-testid="bend-marker-2-0"]')).toBeNull();

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
		expect(host.querySelector('[data-testid="bend-marker-1-0"]')).toBeNull();
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

		const bendButton = host.querySelector<HTMLButtonElement>('[data-testid="radial-action-bend"]');
		expect(bendButton?.tagName).toBe('BUTTON');
		expect(bendButton?.getAttribute('role')).toBe('menuitem');
		expect(bendButton?.getAttribute('aria-label')).toBe('Corridor bend');
		// Roving tabindex: exactly one item is a tab stop, and focus already
		// moved into the menu on open.
		expect(bendButton?.getAttribute('tabindex')).toBe('0');
		expect(document.activeElement).toBe(bendButton);

		unmount(component);
		host.remove();
	});
});
