// @vitest-environment jsdom

/**
 * CHSPT-46 — coverage for the mounted component's own guide/corridor
 * rendering, not just the pure domain functions it's built from. Investigated
 * as a reported staleness bug (blue guide lines not updating after a
 * tee/basket/bend edit); driving real pointer interactions against the
 * mounted `AnnotationWorkspace` and reading the actual rendered SVG found
 * every path already correct — `holes` is reassigned on every edit (manual
 * drag, add, delete, and the eager CV bend-detection path alike), and
 * Svelte's reactivity already re-derives `visibleHoles` and the per-hole
 * guide/centerline/band geometry from it on every change. These tests pin
 * that behavior down so a future refactor can't quietly reintroduce the
 * staleness the ticket described.
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

/** Placement never auto-advances GuidedReview (CHSPT-48 hotfix, 499ef3e) -- Tab accepts the step. */
function pressTab(): void {
	window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
}

/** Presses down, drags past click-slop, and releases at a new point — real drag, not a click. */
function dispatchDrag(host: HTMLElement, from: { x: number; y: number }, to: { x: number; y: number }): void {
	const element = scene(host);
	const pointerId = 72;
	element.dispatchEvent(
		new PointerEvent('pointerdown', { button: 0, pointerId, clientX: from.x, clientY: from.y, bubbles: true })
	);
	window.dispatchEvent(new PointerEvent('pointermove', { pointerId, clientX: to.x, clientY: to.y }));
	window.dispatchEvent(new PointerEvent('pointerup', { pointerId, clientX: to.x, clientY: to.y }));
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

let mounted: Mounted | null = null;
afterEach(() => {
	if (mounted) {
		unmount(mounted.component);
		mounted.host.remove();
	}
	mounted = null;
});

describe('CHSPT-46: guide/corridor geometry reflects current points with no stale segments', () => {
	it('dragging an existing tee updates the rendered guide line endpoint immediately', async () => {
		const editor = makeEditor();
		const { component, host } = mountPage(editor, decodeOf(200, 200));
		mounted = { editor, component, host };
		await loadImage(host);

		host.querySelector<HTMLButtonElement>('[data-testid="sidebar-hole-1"]')?.click();
		await flush();
		const teeAt = screenPointFor(host, 20, 20);
		dispatchClick(host, teeAt.x, teeAt.y);
		await flush();
		pressTab();
		await flush();
		const basketAt = screenPointFor(host, 80, 80);
		dispatchClick(host, basketAt.x, basketAt.y);
		await flush();
		pressTab();
		await flush();

		const guideBefore = host.querySelector('line.guide');
		expect(guideBefore?.getAttribute('x1')).toBe('20');
		expect(guideBefore?.getAttribute('y1')).toBe('20');

		const from = screenPointFor(host, 20, 20);
		const to = screenPointFor(host, 5, 5);
		dispatchDrag(host, from, to);
		await flush();

		const guideAfter = host.querySelector('line.guide');
		expect(guideAfter?.getAttribute('x1')).toBe('5');
		expect(guideAfter?.getAttribute('y1')).toBe('5');
	});

	it('dragging an existing basket updates the rendered guide line endpoint immediately', async () => {
		const editor = makeEditor();
		const { component, host } = mountPage(editor, decodeOf(200, 200));
		mounted = { editor, component, host };
		await loadImage(host);

		host.querySelector<HTMLButtonElement>('[data-testid="sidebar-hole-1"]')?.click();
		await flush();
		const teeAt = screenPointFor(host, 20, 20);
		dispatchClick(host, teeAt.x, teeAt.y);
		await flush();
		pressTab();
		await flush();
		const basketAt = screenPointFor(host, 80, 80);
		dispatchClick(host, basketAt.x, basketAt.y);
		await flush();
		pressTab();
		await flush();

		const guideBefore = host.querySelector('line.guide');
		expect(guideBefore?.getAttribute('x2')).toBe('80');
		expect(guideBefore?.getAttribute('y2')).toBe('80');

		const from = screenPointFor(host, 80, 80);
		const to = screenPointFor(host, 95, 95);
		dispatchDrag(host, from, to);
		await flush();

		const guideAfter = host.querySelector('line.guide');
		expect(guideAfter?.getAttribute('x2')).toBe('95');
		expect(guideAfter?.getAttribute('y2')).toBe('95');
	});

	it('dragging an existing bend updates the rendered corridor centerline and band immediately', async () => {
		const editor = makeEditor();
		const { component, host } = mountPage(editor, decodeOf(200, 200));
		mounted = { editor, component, host };
		await loadImage(host);

		host.querySelector<HTMLButtonElement>('[data-testid="sidebar-hole-1"]')?.click();
		await flush();
		const teeAt = screenPointFor(host, 10, 10);
		dispatchClick(host, teeAt.x, teeAt.y);
		await flush();
		pressTab();
		await flush();
		const basketAt = screenPointFor(host, 90, 90);
		dispatchClick(host, basketAt.x, basketAt.y);
		await flush();
		pressTab();
		await flush();
		const bendAt = screenPointFor(host, 50, 10);
		dispatchClick(host, bendAt.x, bendAt.y);
		await flush();

		const centerlineBefore = host.querySelector('[data-testid="corridor-centerline-1"]')?.getAttribute('points');
		const bandBefore = host.querySelector('[data-testid="corridor-band-1"]')?.getAttribute('points');

		const from = screenPointFor(host, 50, 10);
		const to = screenPointFor(host, 50, 90);
		dispatchDrag(host, from, to);
		await flush();

		expect(host.querySelector('[data-testid="bend-marker-1-0"]')?.getAttribute('cy')).toBe('90');
		const centerlineAfter = host.querySelector('[data-testid="corridor-centerline-1"]')?.getAttribute('points');
		const bandAfter = host.querySelector('[data-testid="corridor-band-1"]')?.getAttribute('points');
		expect(centerlineAfter).not.toBe(centerlineBefore);
		expect(bandAfter).not.toBe(bandBefore);
		expect(centerlineAfter).toBe('10,10 50,90 90,90');
	});

	it('adding a bend by clicking the map renders the corridor centerline immediately, no reload needed', async () => {
		const editor = makeEditor();
		const { component, host } = mountPage(editor, decodeOf(200, 200));
		mounted = { editor, component, host };
		await loadImage(host);

		host.querySelector<HTMLButtonElement>('[data-testid="sidebar-hole-1"]')?.click();
		await flush();
		const teeAt = screenPointFor(host, 10, 10);
		dispatchClick(host, teeAt.x, teeAt.y);
		await flush();
		pressTab();
		await flush();
		const basketAt = screenPointFor(host, 90, 90);
		dispatchClick(host, basketAt.x, basketAt.y);
		await flush();
		pressTab();
		await flush();

		// Straight hole: centerline is just tee-to-basket, no bend yet.
		expect(host.querySelector('[data-testid="corridor-centerline-1"]')?.getAttribute('points')).toBe('10,10 90,90');

		const bendAt = screenPointFor(host, 50, 10);
		dispatchClick(host, bendAt.x, bendAt.y);
		await flush();

		expect(host.querySelector('[data-testid="bend-marker-1-0"]')).not.toBeNull();
		expect(host.querySelector('[data-testid="corridor-centerline-1"]')?.getAttribute('points')).toBe(
			'10,10 50,10 90,90'
		);
	});

	it('deleting a bend via the radial menu removes it from the rendered centerline immediately', async () => {
		const editor = makeEditor();
		const { component, host } = mountPage(editor, decodeOf(200, 200));
		mounted = { editor, component, host };
		await loadImage(host);

		host.querySelector<HTMLButtonElement>('[data-testid="sidebar-hole-1"]')?.click();
		await flush();
		const teeAt = screenPointFor(host, 10, 10);
		dispatchClick(host, teeAt.x, teeAt.y);
		await flush();
		pressTab();
		await flush();
		const basketAt = screenPointFor(host, 90, 90);
		dispatchClick(host, basketAt.x, basketAt.y);
		await flush();
		pressTab();
		await flush();
		const bendAt = screenPointFor(host, 50, 10);
		dispatchClick(host, bendAt.x, bendAt.y);
		await flush();
		expect(host.querySelector('[data-testid="bend-marker-1-0"]')).not.toBeNull();

		// Clicking directly on the bend marker (not dragging) opens its delete menu.
		dispatchClick(host, bendAt.x, bendAt.y);
		await flush();
		host.querySelector<HTMLButtonElement>('[data-testid="radial-action-delete"]')?.click();
		await flush();

		expect(host.querySelector('[data-testid="bend-marker-1-0"]')).toBeNull();
		expect(host.querySelector('[data-testid="corridor-centerline-1"]')?.getAttribute('points')).toBe('10,10 90,90');
	});
});
