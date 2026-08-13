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
import Page from '../../src/routes/annotate-round/+page.svelte';
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
