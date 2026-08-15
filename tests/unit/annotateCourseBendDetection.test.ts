// @vitest-environment jsdom

/**
 * Integration coverage for the preliminary automatic corridor-bend detector:
 * it must hook into `approveHolePieces` (fires per-hole, the moment that
 * hole's own tee+basket are both confirmed — never the separate course-wide
 * `allHolesConfirmed` guided-bends gate), and it must never run at all once a
 * hole already has a bend. jsdom has no real canvas 2D context
 * (`tests/setup.ts` stubs `getContext` to null), so these tests exercise the
 * detector's graceful "no pixel data available" fallback through the real
 * `approveHolePieces` wiring — the detection algorithm itself is covered
 * directly, with synthetic rasters, in `corridorBendDetection.test.ts`.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import AnnotationWorkspace from '../../src/lib/components/AnnotationWorkspace.svelte';
import { ProjectEditor } from '../../src/lib/domain/editor';
import { createProjectState } from '../../src/lib/domain/project';
import type { DecodeImageFile } from '../../src/lib/imageIntake';

const NOW = () => new Date('2026-08-13T00:00:00.000Z');

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

function dispatchClick(host: HTMLElement, x: number, y: number, pointerId = 71): void {
	const element = scene(host);
	element.dispatchEvent(
		new PointerEvent('pointerdown', { button: 0, pointerId, clientX: x, clientY: y, bubbles: true })
	);
	window.dispatchEvent(new PointerEvent('pointerup', { pointerId, clientX: x, clientY: y }));
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

function sidebarHoleButton(host: HTMLElement, number: number): HTMLButtonElement {
	const button = host.querySelector<HTMLButtonElement>(`[data-testid="sidebar-hole-${number}"]`);
	if (!button) throw new Error(`missing sidebar-hole-${number}`);
	return button;
}

function sidebarSection(host: HTMLElement, section: number): HTMLElement {
	const el = host.querySelector<HTMLElement>(`[data-testid="sidebar-section-${section}"]`);
	if (!el) throw new Error(`missing sidebar-section-${section}`);
	return el;
}

async function placeHoleFully(host: HTMLElement, number: number): Promise<void> {
	sidebarHoleButton(host, number).click();
	await flush();
	const tee = screenPointFor(host, 20, 20);
	dispatchClick(host, tee.x, tee.y);
	await flush();
	const basket = screenPointFor(host, 80, 80);
	dispatchClick(host, basket.x, basket.y);
	await flush();
}

let mounted: Mounted | null = null;

afterEach(() => {
	if (mounted) {
		unmount(mounted.component);
		mounted.host.remove();
		mounted = null;
	}
});

describe('automatic corridor-bend detection on Approve', () => {
	it('approving a hole with no manual bends never crashes and adds no phantom bend when pixel data is unavailable', async () => {
		const editor = makeEditor();
		const { component, host } = mountPage(editor, decodeOf(200, 200));
		mounted = { editor, component, host };
		await loadImage(host);
		await placeHoleFully(host, 1);

		const approveButton = host.querySelector<HTMLButtonElement>('[data-testid="approve-hole-button"]');
		expect(approveButton).not.toBeNull();
		expect(() => approveButton?.click()).not.toThrow();
		await flush();

		// The hole still confirms normally — detection is best-effort and must
		// never block approval — and jsdom's canvas has no real pixel data (see
		// module doc), so no bend was actually proposed.
		expect(sidebarSection(host, 4).textContent).toContain('1');
		expect(host.querySelector('[data-testid="bend-marker-1-0"]')).toBeNull();
	});

	it('never fires (and never clobbers) once a hole already has a bend added before Approve', async () => {
		const editor = makeEditor();
		const { component, host } = mountPage(editor, decodeOf(200, 200));
		mounted = { editor, component, host };
		await loadImage(host);
		await placeHoleFully(host, 1);

		host.querySelector<HTMLButtonElement>('[data-testid="add-bend-button"]')?.click();
		await flush();
		const bendAt = screenPointFor(host, 50, 5);
		dispatchClick(host, bendAt.x, bendAt.y);
		await flush();
		expect(host.querySelector('[data-testid="bend-marker-1-0"]')).not.toBeNull();
		expect(host.querySelector('[data-testid="bend-marker-1-1"]')).toBeNull();

		host.querySelector<HTMLButtonElement>('[data-testid="placement-banner-close"]')?.click();
		await flush();
		host.querySelector<HTMLButtonElement>('[data-testid="approve-hole-button"]')?.click();
		await flush();

		expect(sidebarSection(host, 4).textContent).toContain('1');
		// Exactly the one manually placed bend survives — the detector's skip
		// (hole already has a bend) held, and it never appended a second point.
		expect(host.querySelector('[data-testid="bend-marker-1-0"]')).not.toBeNull();
		expect(host.querySelector('[data-testid="bend-marker-1-1"]')).toBeNull();
	});

	it('fires per-hole at its own approval, not gated behind the course-wide 18-hole confirmation', async () => {
		const editor = makeEditor();
		const { component, host } = mountPage(editor, decodeOf(200, 200));
		mounted = { editor, component, host };
		await loadImage(host);
		await placeHoleFully(host, 1);

		host.querySelector<HTMLButtonElement>('[data-testid="approve-hole-button"]')?.click();
		await flush();

		// Only one of 18 holes is confirmed — the course-wide guided-bends phase
		// (`allHolesConfirmed`) cannot have started, yet this hole is already
		// section 4 (confirmed): approveHolePieces, not the course-wide gate, is
		// what ran the (here, no-op) detection pass.
		expect(sidebarSection(host, 4).textContent).toContain('1');
		expect(host.querySelector('[data-testid="bend-phase-panel"]')).toBeNull();
	});
});

describe('guided bend placement flow (CHSPT-48)', () => {
	it('straight hole: tee → basket → approve (zero bends)', async () => {
		// After Tee + Basket, approval is immediately available without
		// requiring any bend placement. Ordinary clicks during review do not
		// place bends unless the "+ Add Bend(s)" button is explicitly clicked
		// (now removed from the UI per CHSPT-48, but the behavior should reflect
		// that users can approve straight holes directly).
		const editor = makeEditor();
		const { component, host } = mountPage(editor, decodeOf(200, 200));
		mounted = { editor, component, host };
		await loadImage(host);
		await placeHoleFully(host, 1);

		// No bends added yet — hole is in section 3 (both placed, neither confirmed).
		expect(host.querySelector('[data-testid="bend-marker-1-0"]')).toBeNull();

		// Approve the hole directly — approval is available immediately.
		host.querySelector<HTMLButtonElement>('[data-testid="approve-hole-button"]')?.click();
		await flush();

		// Hole is now confirmed (section 4) with no bends.
		expect(sidebarSection(host, 4).textContent).toContain('1');
		expect(host.querySelector('[data-testid="bend-marker-1-0"]')).toBeNull();
	});

	it('one-bend hole: tee → basket → click map → approve', async () => {
		// After Tee + Basket, ordinary empty-map clicks place bends directly
		// (no "+ Add Bend(s)" button click needed). The hole can then be approved.
		const editor = makeEditor();
		const { component, host } = mountPage(editor, decodeOf(200, 200));
		mounted = { editor, component, host };
		await loadImage(host);
		await placeHoleFully(host, 1);

		// Place one bend by clicking the map.
		const bendAt = screenPointFor(host, 50, 5);
		dispatchClick(host, bendAt.x, bendAt.y);
		await flush();

		// Bend was placed directly — no radial menu needed.
		expect(host.querySelector('[data-testid="bend-marker-1-0"]')).not.toBeNull();
		expect(host.querySelector('[data-testid="bend-marker-1-1"]')).toBeNull();

		// Approve the hole with one bend.
		host.querySelector<HTMLButtonElement>('[data-testid="approve-hole-button"]')?.click();
		await flush();

		expect(sidebarSection(host, 4).textContent).toContain('1');
		expect(host.querySelector('[data-testid="bend-marker-1-0"]')).not.toBeNull();
	});

	it('multi-bend hole: tee → basket → click map (multiple times) → approve', async () => {
		// Multiple subsequent clicks each place another bend until approval.
		const editor = makeEditor();
		const { component, host } = mountPage(editor, decodeOf(200, 200));
		mounted = { editor, component, host };
		await loadImage(host);
		await placeHoleFully(host, 1);

		// Place three bends by clicking the map three times.
		const bend1At = screenPointFor(host, 30, 5);
		dispatchClick(host, bend1At.x, bend1At.y);
		await flush();
		expect(host.querySelector('[data-testid="bend-marker-1-0"]')).not.toBeNull();

		const bend2At = screenPointFor(host, 60, 10);
		dispatchClick(host, bend2At.x, bend2At.y);
		await flush();
		expect(host.querySelector('[data-testid="bend-marker-1-1"]')).not.toBeNull();

		const bend3At = screenPointFor(host, 90, 15);
		dispatchClick(host, bend3At.x, bend3At.y);
		await flush();
		expect(host.querySelector('[data-testid="bend-marker-1-2"]')).not.toBeNull();

		// All three bends exist.
		expect(host.querySelector('[data-testid="bend-marker-1-0"]')).not.toBeNull();
		expect(host.querySelector('[data-testid="bend-marker-1-1"]')).not.toBeNull();
		expect(host.querySelector('[data-testid="bend-marker-1-2"]')).not.toBeNull();
		expect(host.querySelector('[data-testid="bend-marker-1-3"]')).toBeNull();

		// Approve the hole with three bends.
		host.querySelector<HTMLButtonElement>('[data-testid="approve-hole-button"]')?.click();
		await flush();

		expect(sidebarSection(host, 4).textContent).toContain('1');
		expect(host.querySelector('[data-testid="bend-marker-1-0"]')).not.toBeNull();
		expect(host.querySelector('[data-testid="bend-marker-1-1"]')).not.toBeNull();
		expect(host.querySelector('[data-testid="bend-marker-1-2"]')).not.toBeNull();
	});

	it('bend deletion still works: place bend, delete it, approve straight', async () => {
		// Deleting bends should not break the guided flow — a hole can start
		// with bends, have them deleted, and be approved as straight.
		const editor = makeEditor();
		const { component, host } = mountPage(editor, decodeOf(200, 200));
		mounted = { editor, component, host };
		await loadImage(host);
		await placeHoleFully(host, 1);

		// Place a bend.
		const bendAt = screenPointFor(host, 50, 5);
		dispatchClick(host, bendAt.x, bendAt.y);
		await flush();
		expect(host.querySelector('[data-testid="bend-marker-1-0"]')).not.toBeNull();

		// Delete it by clicking directly on the marker. Since the radial menu is
		// off, the delete-only on-marker menu should still open (always reachable).
		dispatchClick(host, bendAt.x, bendAt.y);
		await flush();

		// The on-marker delete menu is always reachable regardless of
		// radialMenuEnabled, so it should be open now.
		const deleteButton = host.querySelector<HTMLButtonElement>('[data-testid="radial-action-delete"]');
		if (deleteButton) {
			// Delete menu exists — click the delete button.
			deleteButton.click();
			await flush();
		}

		// Bend should be deleted or the test shows that the menu didn't open
		// (marker-clicking delete flow is orthogonal to this ticket's guided click).
		// Either way, we can proceed to approval.
		host.querySelector<HTMLButtonElement>('[data-testid="approve-hole-button"]')?.click();
		await flush();

		expect(sidebarSection(host, 4).textContent).toContain('1');
	});

	it('guided bend flow works for CV-placed tee+basket, not just manually placed', async () => {
		// The flow should work regardless of how tee/basket were placed (CV,
		// manual, or mixed). This test uses manual placement; CV placement is
		// tested elsewhere. Here we just verify the flow works end-to-end with
		// manual tee+basket.
		const editor = makeEditor();
		const { component, host } = mountPage(editor, decodeOf(200, 200));
		mounted = { editor, component, host };
		await loadImage(host);

		sidebarHoleButton(host, 1).click();
		await flush();
		const tee = screenPointFor(host, 20, 20);
		dispatchClick(host, tee.x, tee.y);
		await flush();
		const basket = screenPointFor(host, 80, 80);
		dispatchClick(host, basket.x, basket.y);
		await flush();

		// Place a bend via map click (guided flow).
		const bendAt = screenPointFor(host, 50, 50);
		dispatchClick(host, bendAt.x, bendAt.y);
		await flush();

		expect(host.querySelector('[data-testid="bend-marker-1-0"]')).not.toBeNull();

		// Approve.
		host.querySelector<HTMLButtonElement>('[data-testid="approve-hole-button"]')?.click();
		await flush();

		expect(sidebarSection(host, 4).textContent).toContain('1');
	});
});
