// @vitest-environment jsdom

/**
 * Coverage for the redesigned Annotate Round sidebar: the four-section hole
 * grid, the sidebar-driven placing flow (click a hole, click empty map to
 * place its missing piece), the section-3 approve flow, the marker
 * correction chip (reassign to any hole / delete, not proximity-gated), real
 * drag-vs-click disambiguation on an existing marker, and the completion
 * panel's save/upload gating.
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

function dispatchClick(host: HTMLElement, x: number, y: number, pointerId = 71): void {
	const element = scene(host);
	element.dispatchEvent(
		new PointerEvent('pointerdown', { button: 0, pointerId, clientX: x, clientY: y, bubbles: true })
	);
	window.dispatchEvent(new PointerEvent('pointerup', { pointerId, clientX: x, clientY: y }));
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

/** Loads a source image with mocked geometry, with no course detection scripted — every hole in these tests is created and placed by hand through the sidebar/placing flow. */
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

// jsdom has no real Worker; both the prewarm and auto-detect course-detection
// effects no-op without one (see annotateRoundLocalSnap.test.ts, which stubs
// Worker deliberately to run detection). That's exactly what these tests
// want left alone — every hole here is placed entirely by hand.

let mounted: Mounted | null = null;

afterEach(() => {
	if (mounted) {
		unmount(mounted.component);
		mounted.host.remove();
		mounted = null;
	}
});

describe('sidebar hole grid — sections derive from real hole state', () => {
	it('starts with all 18 holes in "Missing tee", and moves a hole through every section as it is placed and approved', async () => {
		const editor = makeEditor();
		const { component, host } = mountPage(editor, decodeOf(200, 200));
		mounted = { editor, component, host };
		await loadImage(host);

		expect(sidebarSection(host, 1).textContent).toContain('18');
		expect(sidebarHoleButton(host, 1)).not.toBeNull();

		// Click hole 1 in the sidebar: enters placing mode, banner asks for the tee first.
		sidebarHoleButton(host, 1).click();
		await flush();
		expect(host.querySelector('[data-testid="placement-banner"]')?.textContent).toContain('Tee');

		const teeAt = screenPointFor(host, 40, 40);
		dispatchClick(host, teeAt.x, teeAt.y);
		await flush();
		expect(host.querySelector('[data-testid="tee-marker-1"]')).not.toBeNull();
		// Section 2 (missing basket) now — the banner should ask for the basket next, no return trip to the sidebar.
		expect(sidebarSection(host, 2).textContent).toContain('1');
		expect(host.querySelector('[data-testid="placement-banner"]')?.textContent).toContain('Basket');

		const basketAt = screenPointFor(host, 60, 60);
		dispatchClick(host, basketAt.x, basketAt.y);
		await flush();
		expect(host.querySelector('[data-testid="basket-marker-1"]')).not.toBeNull();

		// Both placed but unconfirmed: section 3, with an Approve button near the markers.
		expect(sidebarSection(host, 3).textContent).toContain('1');
		const approveButton = host.querySelector<HTMLButtonElement>('[data-testid="approve-hole-button"]');
		expect(approveButton).not.toBeNull();
		expect(approveButton?.textContent).toContain('1');

		approveButton?.click();
		await flush();

		// Confirmed: section 4.
		expect(sidebarSection(host, 4).textContent).toContain('1');
		expect(sidebarSection(host, 1).textContent).toContain('17');
	});

	it('a tee-only hole waits in Missing basket; a basket-only hole goes back to Missing tee (tees lead the guided flow)', async () => {
		const editor = makeEditor();
		const { component, host } = mountPage(editor, decodeOf(200, 200));
		mounted = { editor, component, host };
		await loadImage(host);

		// Hole 1: place only a tee, then bail out (Cancel) before the basket.
		sidebarHoleButton(host, 1).click();
		await flush();
		const tee1 = screenPointFor(host, 30, 30);
		dispatchClick(host, tee1.x, tee1.y);
		await flush();
		host.querySelector<HTMLButtonElement>('[data-testid="placement-banner-cancel"]')?.click();
		await flush();

		expect(sidebarSection(host, 2).textContent).toContain('1');

		// Hole 2: place a basket directly by reassigning hole 1's future basket
		// is unnecessary — place hole 2's tee, then use the marker chip to
		// delete it, leaving hole 2 with nothing; instead, place hole 2's tee
		// then its basket, then delete just the tee via the chip to land it in
		// "basket only".
		sidebarHoleButton(host, 2).click();
		await flush();
		const tee2 = screenPointFor(host, 100, 30);
		dispatchClick(host, tee2.x, tee2.y);
		await flush();
		const basket2 = screenPointFor(host, 120, 30);
		dispatchClick(host, basket2.x, basket2.y);
		await flush();

		// Click the tee marker (no drag) to open its chip, then delete it.
		dispatchClick(host, tee2.x, tee2.y);
		await flush();
		host.querySelector<HTMLButtonElement>('[data-testid="marker-chip-delete"]')?.click();
		await flush();

		// Basket-only means the tee is still missing — hole 2 rejoins section 1
		// (16 never-touched holes + hole 2 = 17), while tee-only hole 1 stays
		// alone in Missing basket.
		expect(sidebarSection(host, 1).textContent).toContain('17');
		expect(sidebarSection(host, 2).textContent).toContain('1');
		expect(host.querySelector('[data-testid="tee-marker-2"]')).toBeNull();
		expect(host.querySelector('[data-testid="basket-marker-2"]')).not.toBeNull();
	});
});

describe('guided bends phase — after all 18 confirm, before the completion panel', () => {
	/** Image-space placement grid: 6 columns × 3 rows, spaced so no click ever lands within another marker's hit radius. */
	function holeSpots(number: number): { tee: [number, number]; basket: [number, number] } {
		const col = (number - 1) % 6;
		const row = Math.floor((number - 1) / 6);
		const x = 15 + col * 30;
		const y = 15 + row * 60;
		return { tee: [x, y], basket: [x, y + 25] };
	}

	async function confirmAllHoles(host: HTMLElement): Promise<void> {
		for (let number = 1; number <= 18; number += 1) {
			const { tee, basket } = holeSpots(number);
			sidebarHoleButton(host, number).click();
			await flush();
			const teeScreen = screenPointFor(host, ...tee);
			dispatchClick(host, teeScreen.x, teeScreen.y);
			await flush();
			const basketScreen = screenPointFor(host, ...basket);
			dispatchClick(host, basketScreen.x, basketScreen.y);
			await flush();
			host.querySelector<HTMLButtonElement>('[data-testid="approve-hole-button"]')?.click();
			await flush();
		}
	}

	it('walks through bends after the 18th approval, places bends by direct map click, and only then offers the completion panel', async () => {
		const editor = makeEditor();
		const { component, host } = mountPage(editor, decodeOf(200, 200));
		mounted = { editor, component, host };
		await loadImage(host);

		await confirmAllHoles(host);

		// Every hole confirmed: the bends panel appears first — the completion
		// panel must NOT short-circuit past bend annotation.
		expect(host.querySelector('[data-testid="bend-phase-panel"]')).not.toBeNull();
		expect(host.querySelector('[data-testid="course-complete-panel"]')).toBeNull();

		// Pick hole 1 and click empty map twice: each click drops a bend
		// directly — no radial menu involved (it stays off by default).
		host.querySelector<HTMLButtonElement>('[data-testid="bend-phase-hole-1"]')?.click();
		await flush();
		expect(host.querySelector('[data-testid="placement-banner"]')?.textContent).toContain('Bends');

		// Clicking a bends-panel hole zooms the camera onto that hole, so the
		// bend clicks must land near hole 1's own markers (tee 15,15 / basket
		// 15,40) to stay inside the focused viewport — but beyond the 12px
		// marker hit radius so they read as empty-map clicks.
		const bendA = screenPointFor(host, 30, 27);
		dispatchClick(host, bendA.x, bendA.y);
		await flush();
		const bendB = screenPointFor(host, 35, 50);
		dispatchClick(host, bendB.x, bendB.y);
		await flush();
		expect(host.querySelector('[data-testid="radial-menu"]')).toBeNull();
		expect(host.querySelector('[data-testid="bend-marker-1-0"]')).not.toBeNull();
		expect(host.querySelector('[data-testid="bend-marker-1-1"]')).not.toBeNull();
		expect(host.querySelector('[data-testid="bend-phase-hole-1"]')?.textContent).toContain('↯2');

		// Finish bends: only now does the completion panel take over.
		host.querySelector<HTMLButtonElement>('[data-testid="finish-bends"]')?.click();
		await flush();
		expect(host.querySelector('[data-testid="bend-phase-panel"]')).toBeNull();
		expect(host.querySelector('[data-testid="course-complete-panel"]')).not.toBeNull();
	});
});

describe('marker correction chip — reassign and delete, not proximity-gated', () => {
	async function placeHoleFully(host: HTMLElement, number: number, teeImg: [number, number], basketImg: [number, number]): Promise<void> {
		sidebarHoleButton(host, number).click();
		await flush();
		const tee = screenPointFor(host, ...teeImg);
		dispatchClick(host, tee.x, tee.y);
		await flush();
		const basket = screenPointFor(host, ...basketImg);
		dispatchClick(host, basket.x, basket.y);
		await flush();
	}

	it('reassigns a marker to an arbitrary hole number, resetting confirmed status even if it was confirmed before', async () => {
		const editor = makeEditor();
		const { component, host } = mountPage(editor, decodeOf(200, 200));
		mounted = { editor, component, host };
		await loadImage(host);

		await placeHoleFully(host, 1, [30, 30], [40, 40]);
		host.querySelector<HTMLButtonElement>('[data-testid="approve-hole-button"]')?.click();
		await flush();
		expect(sidebarSection(host, 4).textContent).toContain('1');

		// Click hole 1's confirmed tee — the marker chip opens for ANY marker at
		// any time, not just an actively-placing one.
		const teeScreen = screenPointFor(host, 30, 30);
		dispatchClick(host, teeScreen.x, teeScreen.y);
		await flush();
		const chip = host.querySelector('[data-testid="marker-chip"]');
		expect(chip).not.toBeNull();
		expect(chip?.textContent).toContain('confirmed');

		const input = host.querySelector<HTMLInputElement>('[data-testid="marker-chip-reassign-input"]');
		if (!input) throw new Error('missing reassign input');
		input.value = '5';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		host.querySelector<HTMLButtonElement>('[data-testid="marker-chip-reassign-go"]')?.click();
		await flush();

		// The point genuinely moved: hole 1 no longer has a tee, hole 5 does.
		expect(host.querySelector('[data-testid="tee-marker-1"]')).toBeNull();
		expect(host.querySelector('[data-testid="tee-marker-5"]')).not.toBeNull();
		// Hole 1 drops out of Confirmed (its tee is missing again, so it's back
		// in section 1 with the 16 untouched holes); hole 5 is tee-only, pending
		// its basket — a correction never carries over a stale confirmation.
		expect(sidebarSection(host, 4).textContent).toContain('0');
		expect(sidebarSection(host, 1).textContent).toContain('17');
		expect(sidebarSection(host, 2).textContent).toContain('1');
	});

	it('the quick "reassign to the active hole" shortcut targets whichever hole the sidebar currently has active', async () => {
		const editor = makeEditor();
		const { component, host } = mountPage(editor, decodeOf(200, 200));
		mounted = { editor, component, host };
		await loadImage(host);

		// Hole 9 gets a stray basket that actually belongs to hole 3.
		sidebarHoleButton(host, 9).click();
		await flush();
		const misplaced = screenPointFor(host, 80, 80);
		dispatchClick(host, misplaced.x, misplaced.y);
		await flush();
		host.querySelector<HTMLButtonElement>('[data-testid="placement-banner-cancel"]')?.click();
		await flush();

		// Hole 3 is now the sidebar's active hole.
		sidebarHoleButton(host, 3).click();
		await flush();

		// Click the misplaced marker — it's hole 9's, drawn at the same point.
		dispatchClick(host, misplaced.x, misplaced.y);
		await flush();
		const quick = host.querySelector<HTMLButtonElement>('[data-testid="marker-chip-quick-reassign"]');
		expect(quick).not.toBeNull();
		expect(quick?.textContent).toContain('3');
		quick?.click();
		await flush();

		expect(host.querySelector('[data-testid="tee-marker-9"]')).toBeNull();
		expect(host.querySelector('[data-testid="tee-marker-3"]')).not.toBeNull();
	});

	it('deleting a marker via the chip removes its data entirely, not just its visual', async () => {
		const editor = makeEditor();
		const { component, host } = mountPage(editor, decodeOf(200, 200));
		mounted = { editor, component, host };
		await loadImage(host);

		sidebarHoleButton(host, 4).click();
		await flush();
		const teeAt = screenPointFor(host, 50, 50);
		dispatchClick(host, teeAt.x, teeAt.y);
		await flush();
		host.querySelector<HTMLButtonElement>('[data-testid="placement-banner-cancel"]')?.click();
		await flush();
		expect(sidebarSection(host, 2).textContent).toContain('1');

		dispatchClick(host, teeAt.x, teeAt.y);
		await flush();
		host.querySelector<HTMLButtonElement>('[data-testid="marker-chip-delete"]')?.click();
		await flush();

		expect(host.querySelector('[data-testid="tee-marker-4"]')).toBeNull();
		// Back to section 1 — the data is gone, not merely hidden.
		expect(sidebarSection(host, 1).textContent).toContain('18');
	});
});

describe('drag vs click on an existing marker', () => {
	it('a real drag past the slop threshold repositions the marker instead of opening the chip', async () => {
		const editor = makeEditor();
		const { component, host } = mountPage(editor, decodeOf(200, 200));
		mounted = { editor, component, host };
		await loadImage(host);

		sidebarHoleButton(host, 1).click();
		await flush();
		const teeAt = screenPointFor(host, 50, 50);
		dispatchClick(host, teeAt.x, teeAt.y);
		await flush();
		host.querySelector<HTMLButtonElement>('[data-testid="placement-banner-cancel"]')?.click();
		await flush();

		const from = screenPointFor(host, 50, 50);
		const to = screenPointFor(host, 90, 90);
		dispatchDrag(host, from, to);
		await flush();

		expect(host.querySelector('[data-testid="marker-chip"]')).toBeNull();
		const marker = host.querySelector('[data-testid="tee-marker-1"]');
		expect(marker?.getAttribute('cx')).toBe('90');
		expect(marker?.getAttribute('cy')).toBe('90');
	});

	it('a click with no movement opens the chip instead of moving the marker', async () => {
		const editor = makeEditor();
		const { component, host } = mountPage(editor, decodeOf(200, 200));
		mounted = { editor, component, host };
		await loadImage(host);

		sidebarHoleButton(host, 1).click();
		await flush();
		const teeAt = screenPointFor(host, 50, 50);
		dispatchClick(host, teeAt.x, teeAt.y);
		await flush();
		host.querySelector<HTMLButtonElement>('[data-testid="placement-banner-cancel"]')?.click();
		await flush();

		dispatchClick(host, teeAt.x, teeAt.y);
		await flush();

		expect(host.querySelector('[data-testid="marker-chip"]')).not.toBeNull();
		const marker = host.querySelector('[data-testid="tee-marker-1"]');
		expect(marker?.getAttribute('cx')).toBe('50');
		expect(marker?.getAttribute('cy')).toBe('50');
	});
});

describe('completion panel', () => {
	it('appears only once all 18 holes are confirmed, and gates uploading a round on saving the course first', async () => {
		const editor = makeEditor();
		const { component, host } = mountPage(editor, decodeOf(200, 200));
		mounted = { editor, component, host };
		await loadImage(host);

		for (let number = 1; number <= 18; number += 1) {
			sidebarHoleButton(host, number).click();
			await flush();
			// Spread points across the image so no two holes' markers collide.
			const col = ((number - 1) % 6) * 30 + 10;
			const row = Math.floor((number - 1) / 6) * 30 + 10;
			const tee = screenPointFor(host, col, row);
			dispatchClick(host, tee.x, tee.y);
			await flush();
			const basket = screenPointFor(host, col + 10, row);
			dispatchClick(host, basket.x, basket.y);
			await flush();
			host.querySelector<HTMLButtonElement>('[data-testid="approve-hole-button"]')?.click();
			await flush();
		}

		// The guided bends phase now sits between the 18th approval and the
		// completion panel; finish it (doubles as skip) to reach completion.
		expect(host.querySelector('[data-testid="bend-phase-panel"]')).not.toBeNull();
		host.querySelector<HTMLButtonElement>('[data-testid="finish-bends"]')?.click();
		await flush();

		const panel = host.querySelector('[data-testid="course-complete-panel"]');
		expect(panel).not.toBeNull();
		expect(host.querySelector('[data-testid="sidebar-section-1"]')).toBeNull();

		const uploadButton = host.querySelector<HTMLButtonElement>('[data-testid="upload-round-from-course"]');
		expect(uploadButton?.disabled).toBe(true);

		host.querySelector<HTMLButtonElement>('[data-testid="save-course-to-memory"]')?.click();
		await flush();

		expect(host.querySelector<HTMLButtonElement>('[data-testid="upload-round-from-course"]')?.disabled).toBe(false);
	});
});
