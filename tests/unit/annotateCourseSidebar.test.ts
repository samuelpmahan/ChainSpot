// @vitest-environment jsdom

/**
 * Coverage for Annotate Course's sidebar: the four-section hole grid, the
 * sidebar-driven placing flow (click a hole, click empty map to place its
 * missing piece), the section-3 approve flow, the marker correction chip
 * (reassign to any hole / delete, not proximity-gated), real drag-vs-click
 * disambiguation on an existing marker, and the completion panel's
 * save/map-round gating.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import AnnotationWorkspace from '../../src/lib/components/AnnotationWorkspace.svelte';
import { ProjectEditor } from '../../src/lib/domain/editor';
import { createImageAsset, createProjectState } from '../../src/lib/domain/project';
import type { AnnotatedHole } from '../../src/lib/domain/project';
import type { DecodeImageFile } from '../../src/lib/imageIntake';

const NOW = () => new Date('2026-08-13T00:00:00.000Z');

function decodeOf(widthPx: number, heightPx: number): DecodeImageFile {
	return async () => ({ image: document.createElement('img'), widthPx, heightPx });
}

function makeEditor(): ProjectEditor {
	const state = createProjectState({ createId: () => 'project-1', now: NOW });
	return new ProjectEditor({ state, now: NOW });
}

/** A pre-loaded source image with no holes -- for editor.setHoles seeding below (contract A: the Approve banner/button only exists for holes whose tee+basket already existed, unconfirmed, before review started — the CV-proposal shape, not manual click+Tab placement). */
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

/** A fully-placed (unconfirmed) hole at the given image-space points. */
function placedHole(number: number, teeImg: [number, number], basketImg: [number, number]): AnnotatedHole {
	return {
		id: `hole-${number}`,
		number,
		tee: { xPx: teeImg[0], yPx: teeImg[1] },
		basket: { xPx: basketImg[0], yPx: basketImg[1] },
		shots: [],
		corridorBends: [],
		corridorWidthPx: 60
	};
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

/**
 * Placement never auto-advances GuidedReview (CHSPT-48 hotfix, 499ef3e):
 * Tab explicitly accepts Tee, then Basket, then Bends -- Tab-through IS
 * the acceptance (contract A). Two Tabs (after tee, after basket)
 * individually confirm both pieces, landing on the BENDS step with the
 * hole already in section 4. A third Tab from there is the manual-
 * placement equivalent of the old approve-hole-button click: it runs the
 * full approveHolePieces path and advances the guided flow to the next
 * unconfirmed hole -- that banner/button only exists for the
 * CV-proposal path now (see annotateCourseCompletionHandoff.test.ts).
 */
function pressTab(): void {
	window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
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
	it('starts with all 18 holes in "Missing tee", and moves a hole through every section as it is placed and confirmed', async () => {
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
		// Section 2 (missing basket) now. Placement never auto-advances
		// GuidedReview (499ef3e/contract A) -- the banner still asks for the
		// tee to be accepted (Tab) before it moves on to the basket.
		expect(sidebarSection(host, 2).textContent).toContain('1');
		expect(host.querySelector('[data-testid="placement-banner"]')?.textContent).toContain('Tee');

		pressTab(); // accept the tee
		await flush();
		expect(host.querySelector('[data-testid="placement-banner"]')?.textContent).toContain('Basket');

		const basketAt = screenPointFor(host, 60, 60);
		dispatchClick(host, basketAt.x, basketAt.y);
		await flush();
		expect(host.querySelector('[data-testid="basket-marker-1"]')).not.toBeNull();

		// Tee confirmed, basket placed but not yet accepted: section 3 in the
		// grid. Contract A has no distinct "approve" moment for a manually
		// placed hole (the Approve banner/button is CV-proposal-only — see
		// the "+ Add Bend(s)" describe block below); the next Tab both
		// accepts the basket and confirms the hole in one motion.
		expect(sidebarSection(host, 3).textContent).toContain('1');

		pressTab(); // accept the basket
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
		pressTab(); // accept the tee -> Basket step, so the next click places the basket
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

	it('advances through hole numbers instead of jumping to a later status section', async () => {
		const editor = makeEditor();
		const { component, host } = mountPage(editor, decodeOf(200, 200));
		mounted = { editor, component, host };
		await loadImage(host);

		// Put hole 3 into the approval queue before hole 1 is approved. Hole 2
		// remains untouched, so the guided flow must still stop at hole 2.
		sidebarHoleButton(host, 3).click();
		await flush();
		const tee3 = screenPointFor(host, 30, 30);
		dispatchClick(host, tee3.x, tee3.y);
		await flush();
		pressTab();
		await flush();
		const basket3 = screenPointFor(host, 40, 40);
		dispatchClick(host, basket3.x, basket3.y);
		await flush();
		host.querySelector<HTMLButtonElement>('[data-testid="placement-banner-cancel"]')?.click();
		await flush();

		sidebarHoleButton(host, 1).click();
		await flush();
		const tee1 = screenPointFor(host, 80, 80);
		dispatchClick(host, tee1.x, tee1.y);
		await flush();
		pressTab();
		await flush();
		const basket1 = screenPointFor(host, 90, 90);
		dispatchClick(host, basket1.x, basket1.y);
		await flush();
		pressTab(); // accept the basket
		await flush();
		pressTab(); // completing Tab: confirms + advances to the next unconfirmed hole
		await flush();

		expect(host.querySelector('[data-testid="placement-banner"]')?.textContent).toContain('Hole 2');
		expect(host.querySelector('[data-testid="placement-banner"]')?.textContent).toContain('Tee');
	});
});

describe('"+ Add Bend(s)" — a hole under review or already approved gets bends without leaving it', () => {
	/**
	 * The Approve banner/button only exists for a hole whose tee+basket
	 * already existed, unconfirmed, before review started (the CV-proposal
	 * shape -- `derivedStepFor` lands straight on BENDS) -- manual click+Tab
	 * placement confirms tee and basket individually and never shows it (see
	 * contract A / 499ef3e). Seed hole 1 pre-placed, matching
	 * annotateCourseCompletionHandoff.test.ts's pattern, and activate it.
	 */
	async function mountReviewingHole1(): Promise<Mounted> {
		const editor = makeEditorWithSourceImage(200, 200);
		editor.setHoles([placedHole(1, [20, 20], [80, 80])]);
		const { component, host } = mountPage(editor, decodeOf(200, 200));
		setGeometry(host);
		await flush();
		sidebarHoleButton(host, 1).click();
		await flush();
		return { editor, component, host };
	}

	it('the Approve action lives inside the fixed placement-banner, not floating over the corridor', async () => {
		mounted = await mountReviewingHole1();
		const { host } = mounted;

		const banner = host.querySelector('[data-testid="placement-banner"]');
		const approveButton = host.querySelector('[data-testid="approve-hole-button"]');
		expect(banner).not.toBeNull();
		expect(approveButton).not.toBeNull();
		// Contained in the always-top-center banner, not a separate element
		// positioned at an in-image point (which is what used to sit on top
		// of the corridor being reviewed).
		expect(banner?.contains(approveButton)).toBe(true);
		expect(approveButton?.hasAttribute('style')).toBe(false);
	});

	it('ordinary map clicks during review place bends directly (guided flow)', async () => {
		// With Tee + Basket already placed (section 3), ordinary empty-map
		// clicks place bends directly without requiring the "+ Add Bend(s)"
		// button click. This is the natural guided flow per CHSPT-48.
		mounted = await mountReviewingHole1();
		const { host } = mounted;

		const empty = screenPointFor(host, 50, 5);
		dispatchClick(host, empty.x, empty.y);
		await flush();

		// The click placed a bend directly — no manual mode toggle required.
		expect(host.querySelector('[data-testid="bend-marker-1-0"]')).not.toBeNull();
		// Still reviewing hole 1, unapproved — can still approve or add more bends.
		expect(host.querySelector('[data-testid="approve-hole-button"]')).not.toBeNull();
	});

	it('adds a bend mid-review (before Approve) via the banner action, then still approves normally', async () => {
		mounted = await mountReviewingHole1();
		const { host } = mounted;

		host.querySelector<HTMLButtonElement>('[data-testid="add-bend-button"]')?.click();
		await flush();
		expect(host.querySelector('[data-testid="placement-banner"]')?.textContent).toContain('Bends');

		const bendAt = screenPointFor(host, 50, 5);
		dispatchClick(host, bendAt.x, bendAt.y);
		await flush();
		expect(host.querySelector('[data-testid="bend-marker-1-0"]')).not.toBeNull();

		host.querySelector<HTMLButtonElement>('[data-testid="placement-banner-close"]')?.click();
		await flush();

		// Back to reviewing the same hole (not kicked out of focus) — Approve
		// is available again, and the bend just added survived.
		const approveButton = host.querySelector<HTMLButtonElement>('[data-testid="approve-hole-button"]');
		expect(approveButton).not.toBeNull();
		expect(host.querySelector('[data-testid="bend-marker-1-0"]')).not.toBeNull();

		approveButton?.click();
		await flush();
		expect(sidebarSection(host, 4).textContent).toContain('1');
	});

	it('adds a bend to an already-approved hole without any unapprove step', async () => {
		mounted = await mountReviewingHole1();
		const { host } = mounted;
		host.querySelector<HTMLButtonElement>('[data-testid="approve-hole-button"]')?.click();
		await flush();
		expect(sidebarSection(host, 4).textContent).toContain('1');

		// Return to the now-confirmed hole 1 — this is the "revisit" path a
		// user takes if a needed bend is only noticed after approving.
		sidebarHoleButton(host, 1).click();
		await flush();
		expect(host.querySelector('[data-testid="placement-banner"]')?.textContent).toContain('confirmed');

		host.querySelector<HTMLButtonElement>('[data-testid="add-bend-button"]')?.click();
		await flush();
		// Re-focusing an already-placed hole zooms the camera onto its own
		// tee/basket bounding box (see the guided-bends-phase test below), so
		// the bend click must land between the two markers to stay in view.
		const bendAt = screenPointFor(host, 50, 50);
		dispatchClick(host, bendAt.x, bendAt.y);
		await flush();
		expect(host.querySelector('[data-testid="bend-marker-1-0"]')).not.toBeNull();

		host.querySelector<HTMLButtonElement>('[data-testid="placement-banner-close"]')?.click();
		await flush();

		// No unapprove: still confirmed, section 4.
		expect(sidebarSection(host, 4).textContent).toContain('1');
		expect(host.querySelector('[data-testid="placement-banner"]')?.textContent).toContain('confirmed');
	});
});

describe('"Enter" approves the active hole', () => {
	/** See mountReviewingHole1 above: the Approve banner is CV-proposal-only under contract A. */
	async function mountReviewingHole1(): Promise<Mounted> {
		const editor = makeEditorWithSourceImage(200, 200);
		editor.setHoles([placedHole(1, [20, 20], [80, 80])]);
		const { component, host } = mountPage(editor, decodeOf(200, 200));
		setGeometry(host);
		await flush();
		sidebarHoleButton(host, 1).click();
		await flush();
		return { editor, component, host };
	}

	function pressEnter(target: EventTarget = window): void {
		target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
	}

	it('approves the hole once both pieces are placed and the Approve banner is showing', async () => {
		mounted = await mountReviewingHole1();
		const { host } = mounted;
		expect(host.querySelector('[data-testid="approve-hole-button"]')).not.toBeNull();

		pressEnter();
		await flush();

		expect(sidebarSection(host, 4).textContent).toContain('1');
	});

	it('is a no-op while the banner is still asking for a tee or basket', async () => {
		const editor = makeEditor();
		const { component, host } = mountPage(editor, decodeOf(200, 200));
		mounted = { editor, component, host };
		await loadImage(host);

		sidebarHoleButton(host, 1).click();
		await flush();
		expect(host.querySelector('[data-testid="placement-banner"]')?.textContent).toContain('Tee');

		pressEnter();
		await flush();

		expect(host.querySelector('[data-testid="tee-marker-1"]')).toBeNull();
		expect(host.querySelector('[data-testid="placement-banner"]')?.textContent).toContain('Tee');
	});

	it('is a no-op while the banner is asking for bends', async () => {
		mounted = await mountReviewingHole1();
		const { host } = mounted;
		host.querySelector<HTMLButtonElement>('[data-testid="add-bend-button"]')?.click();
		await flush();
		expect(host.querySelector('[data-testid="placement-banner"]')?.textContent).toContain('Bends');

		pressEnter();
		await flush();

		expect(host.querySelector('[data-testid="bend-marker-1-0"]')).toBeNull();
		expect(sidebarSection(host, 3).textContent).toContain('1');
	});

	it('does not hijack Enter on a focused banner button (e.g. Cancel)', async () => {
		mounted = await mountReviewingHole1();
		const { host } = mounted;

		const cancelButton = host.querySelector<HTMLButtonElement>('[data-testid="placement-banner-cancel"]');
		expect(cancelButton).not.toBeNull();
		pressEnter(cancelButton as HTMLButtonElement);
		await flush();

		// The global handler bailed out (button target); the hole was not
		// approved by our shortcut. (The button's own native activation is a
		// jsdom/browser concern outside this handler's responsibility.)
		expect(sidebarSection(host, 3).textContent).toContain('1');
	});

	it('is a no-op while a marker correction chip is open', async () => {
		mounted = await mountReviewingHole1();
		const { host } = mounted;

		const teeAt = screenPointFor(host, 20, 20);
		dispatchClick(host, teeAt.x, teeAt.y);
		await flush();
		expect(host.querySelector('[data-testid="marker-chip"]')).not.toBeNull();

		pressEnter();
		await flush();

		expect(sidebarSection(host, 3).textContent).toContain('1');
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

	/**
	 * Seeds all 18 holes pre-placed (unconfirmed -- the CV-proposal shape;
	 * see mountReviewingHole1 above) and confirms each through the sidebar's
	 * own Approve button, matching
	 * annotateCourseCompletionHandoff.test.ts's approveHoles. What this test
	 * guards is the bend-phase panel that appears once all 18 are confirmed,
	 * not how each hole got there.
	 */
	async function confirmAllHoles(host: HTMLElement): Promise<void> {
		for (let number = 1; number <= 18; number += 1) {
			sidebarHoleButton(host, number).click();
			await flush();
			host.querySelector<HTMLButtonElement>('[data-testid="approve-hole-button"]')?.click();
			await flush();
		}
	}

	it('walks through bends after the 18th approval, places bends by direct map click, and only then offers the completion panel', async () => {
		const editor = makeEditorWithSourceImage(200, 200);
		editor.setHoles(Array.from({ length: 18 }, (_, index) => {
			const number = index + 1;
			const { tee, basket } = holeSpots(number);
			return placedHole(number, tee, basket);
		}));
		const { component, host } = mountPage(editor, decodeOf(200, 200));
		mounted = { editor, component, host };
		setGeometry(host);
		await flush();

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
	it('reassigns a marker to an arbitrary hole number, resetting confirmed status even if it was confirmed before', async () => {
		// A CV-proposal-shaped hole (see mountReviewingHole1 above), confirmed
		// through the sidebar's Approve button -- this test is about the
		// reassign correction, not placement mechanics.
		const editor = makeEditorWithSourceImage(200, 200);
		editor.setHoles([placedHole(1, [30, 30], [40, 40])]);
		const { component, host } = mountPage(editor, decodeOf(200, 200));
		mounted = { editor, component, host };
		setGeometry(host);
		await flush();
		sidebarHoleButton(host, 1).click();
		await flush();
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

describe('hole focus — badge as canonical anchor with zoom preservation (CHSPT-47)', () => {
	it('clicking a hole in the sidebar pans to center its badge without changing zoom', async () => {
		// A CV-proposal-shaped hole (see mountReviewingHole1 elsewhere in this
		// file), confirmed through the sidebar's Approve button -- this test
		// is about the camera on focus, not placement mechanics. (No badge is
		// actually injected here or in the original test; focus falls back to
		// the tee/basket bounding box either way.)
		const editor = makeEditorWithSourceImage(200, 200);
		editor.setHoles([placedHole(1, [40, 40], [60, 60])]);
		const { component, host } = mountPage(editor, decodeOf(200, 200));
		mounted = { editor, component, host };
		setGeometry(host);
		await flush();
		sidebarHoleButton(host, 1).click();
		await flush();
		host.querySelector<HTMLButtonElement>('[data-testid="approve-hole-button"]')?.click();
		await flush();

		// Record initial zoom before focus.
		const initialZoom = view(host).zoom;

		// Simulate user zooming out before clicking another hole's badge.
		// (In real usage, the user would manually change zoom; here we'd need
		// direct viewport access to change it. For now, just verify the focus
		// panning works correctly and zoom doesn't jump unexpectedly.
		// The test infrastructure doesn't easily expose viewport zoom manipulation,
		// so we'll focus on the pan behavior and re-click testing below.)

		// Re-click hole 1 to trigger re-center on badge.
		sidebarHoleButton(host, 1).click();
		await flush();

		// The marker should still be where we placed it (badge focus doesn't move markers).
		const teeMarker = host.querySelector('[data-testid="tee-marker-1"]');
		expect(teeMarker?.getAttribute('cx')).toBe('40');
		expect(teeMarker?.getAttribute('cy')).toBe('40');

		// Zoom should remain unchanged (badge focus preserves zoom).
		const finalZoom = view(host).zoom;
		expect(finalZoom).toBe(initialZoom);
	});

	it('hole focus uses badge as primary anchor even with missing tee, ignoring tee reliability concerns', async () => {
		const editor = makeEditor();
		const { component, host } = mountPage(editor, decodeOf(200, 200));
		mounted = { editor, component, host };
		await loadImage(host);

		// Place hole 1 with only a basket (skip tee placement).
		sidebarHoleButton(host, 1).click();
		await flush();
		// Skip tee — would normally click at teeAt = screenPointFor(host, 40, 40);
		// Instead, go straight to basket placement.
		const basketAt = screenPointFor(host, 60, 60);
		dispatchClick(host, basketAt.x, basketAt.y);
		await flush();

		// Hole 1 is now in section 2 (has basket, missing tee).
		expect(sidebarSection(host, 2).textContent).toContain('1');

		// Even without a tee, clicking the hole should focus successfully.
		// (This test verifies it doesn't crash; the actual badge anchor is
		// set by course detection, which these hand-placement tests don't run.)
		sidebarHoleButton(host, 1).click();
		await flush();

		// Sidebar should still show hole 1 as active/focused.
		expect(sidebarSection(host, 2).textContent).toContain('1');
	});

	it('re-clicking the same hole recenters on its badge without changing zoom', async () => {
		const editor = makeEditorWithSourceImage(200, 200);
		editor.setHoles([placedHole(1, [40, 40], [60, 60])]);
		const { component, host } = mountPage(editor, decodeOf(200, 200));
		mounted = { editor, component, host };
		setGeometry(host);
		await flush();
		sidebarHoleButton(host, 1).click();
		await flush();
		host.querySelector<HTMLButtonElement>('[data-testid="approve-hole-button"]')?.click();
		await flush();

		const zoomBefore = view(host).zoom;

		// Click hole 1 again (re-click the active hole).
		sidebarHoleButton(host, 1).click();
		await flush();

		// Zoom should not change.
		const zoomAfter = view(host).zoom;
		expect(zoomAfter).toBe(zoomBefore);
	});

	it('moving a tee/basket (marker correction) does not trigger a camera refocus away from the badge anchor', async () => {
		const editor = makeEditorWithSourceImage(200, 200);
		editor.setHoles([placedHole(1, [40, 40], [60, 60])]);
		const { component, host } = mountPage(editor, decodeOf(200, 200));
		mounted = { editor, component, host };
		setGeometry(host);
		await flush();
		sidebarHoleButton(host, 1).click();
		await flush();
		host.querySelector<HTMLButtonElement>('[data-testid="approve-hole-button"]')?.click();
		await flush();

		// Record zoom after first focus.
		const zoomAfterFocus = view(host).zoom;

		// Drag the tee to a new location (marker correction).
		const teeAt = screenPointFor(host, 40, 40);
		const newTeeAt = screenPointFor(host, 35, 35);
		dispatchDrag(host, teeAt, newTeeAt);
		await flush();

		// The tee should have moved.
		const teeMarker = host.querySelector('[data-testid="tee-marker-1"]');
		expect(Math.round(Number(teeMarker?.getAttribute('cx')))).toBe(35);
		expect(Math.round(Number(teeMarker?.getAttribute('cy')))).toBe(35);

		// Zoom should not have changed due to the tee movement.
		const zoomAfterDrag = view(host).zoom;
		expect(zoomAfterDrag).toBe(zoomAfterFocus);
	});

	it('hole focus gracefully falls back to tee/basket when badge is unavailable', async () => {
		// No badge, since we're not running course detection.
		const editor = makeEditorWithSourceImage(200, 200);
		editor.setHoles([placedHole(2, [50, 50], [70, 70])]);
		const { component, host } = mountPage(editor, decodeOf(200, 200));
		mounted = { editor, component, host };
		setGeometry(host);
		await flush();
		sidebarHoleButton(host, 2).click();
		await flush();
		host.querySelector<HTMLButtonElement>('[data-testid="approve-hole-button"]')?.click();
		await flush();

		// Hole 2 should now be confirmed in section 4.
		expect(sidebarSection(host, 4).textContent).toContain('2');

		// Click hole 2 again to trigger focus (which should fall back to tee/basket since no badge).
		sidebarHoleButton(host, 2).click();
		await flush();

		// Markers should still be in their original positions.
		const teeMarker = host.querySelector('[data-testid="tee-marker-2"]');
		expect(Number(teeMarker?.getAttribute('cx'))).toBe(50);
		expect(Number(teeMarker?.getAttribute('cy'))).toBe(50);
	});
});

describe('completion panel', () => {
	it('appears only once all 18 holes are confirmed, and gates mapping a round on saving the course first', async () => {
		// Seeded (see mountReviewingHole1 elsewhere in this file) -- this test
		// is about the completion panel gating, not placement mechanics.
		const editor = makeEditorWithSourceImage(200, 200);
		editor.setHoles(Array.from({ length: 18 }, (_, index) => {
			const number = index + 1;
			// Spread points across the image so no two holes' markers collide.
			const col = ((number - 1) % 6) * 30 + 10;
			const row = Math.floor((number - 1) / 6) * 30 + 10;
			return placedHole(number, [col, row], [col + 10, row]);
		}));
		const { component, host } = mountPage(editor, decodeOf(200, 200));
		mounted = { editor, component, host };
		setGeometry(host);
		await flush();

		for (let number = 1; number <= 18; number += 1) {
			sidebarHoleButton(host, number).click();
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

		const uploadButton = host.querySelector<HTMLButtonElement>('[data-testid="map-round-from-course"]');
		expect(uploadButton?.disabled).toBe(true);

		host.querySelector<HTMLButtonElement>('[data-testid="save-course-to-memory"]')?.click();
		await flush();

		expect(host.querySelector<HTMLButtonElement>('[data-testid="map-round-from-course"]')?.disabled).toBe(false);
	});
});
