import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * The 13-inch viewport budget, asserted at the "must work" certification size.
 *
 * Findings, measurements, and the fix tickets behind every threshold (and every
 * `test.fixme`) live in `docs/13-inch-pass.md`. The suite enforces only the
 * invariants the current UI already meets, so it is green today; the fixme'd
 * cases document the target state without turning CI red. It deliberately never
 * drives CV detection or smart import — the CV-showcase visibility budget is
 * measured in the audit doc and its logic is pinned by
 * `tests/unit/annotateRoundCvUx.test.ts`.
 *
 * The annotate-course/map-round and `/demo` cases were re-measured against the
 * Map/Round mode split (later promoted to two separate routes,
 * `/annotate-course` and `/map-round`) and the two-act "Dash's Track"
 * walkthrough (see the re-audit section of `docs/13-inch-pass.md`); every
 * number quoted in a comment below is from that run, not from the original
 * pass. Two rules for editing this file: a threshold only ever comes from the
 * budget in that doc, and a case only loses its `test.fixme` when the product
 * actually meets the threshold.
 */

// 13″ MacBook logical resolution minus typical browser chrome.
const VIEWPORT = { width: 1280, height: 715 } as const;
test.use({ viewport: { ...VIEWPORT } });

const fixturePath = (name: string): string =>
	fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));

async function gotoApp(page: Page, route: string): Promise<void> {
	await page.goto(route);
	await page.waitForFunction(() => document.documentElement.dataset.appReady === 'true');
}

interface ElementBox {
	x: number;
	y: number;
	width: number;
	height: number;
	right: number;
	bottom: number;
	insideViewport: boolean;
}

async function boxOf(page: Page, selector: string): Promise<ElementBox> {
	return page.evaluate((sel) => {
		const element = document.querySelector(sel);
		if (!element) throw new Error(`missing element ${sel}`);
		const rect = element.getBoundingClientRect();
		return {
			x: rect.x,
			y: rect.y,
			width: rect.width,
			height: rect.height,
			right: rect.right,
			bottom: rect.bottom,
			insideViewport:
				rect.width > 0 &&
				rect.height > 0 &&
				rect.top >= 0 &&
				rect.left >= 0 &&
				rect.bottom <= window.innerHeight &&
				rect.right <= window.innerWidth
		};
	}, selector);
}

/**
 * Annotate Course (course geometry: tee/basket/bend) and Map Round (a played
 * round's shots and walk path) share one implementation
 * (`$lib/components/AnnotationWorkspace.svelte`) and its canvas budget, but
 * are two real routes now, not a toggle over one route — the sizing cases run
 * against both routes directly.
 */
type AnnotationMode = 'map' | 'round';
const ANNOTATION_ROUTE: Record<AnnotationMode, string> = {
	map: '/annotate-course',
	round: '/map-round'
};

async function loadAnnotateSource(page: Page): Promise<void> {
	await page.getByTestId('pane-input-source-overview').setInputFiles(fixturePath('tiny.png'));
	await expect(page.getByTestId('annotation-workspace')).toHaveAttribute('data-source-loaded', 'true');
}

/**
 * The state a user actually annotates in: a hole exists and is selected, so
 * the tools column carries its "Edit hole" section. It matters for geometry —
 * the canvas cell stretches to the tools column, which is what pushes the pane
 * past one screen height (see the re-audit's C-series measurements).
 *
 * There is no "add hole" button in either route's UI — the 'n'/'a' keyboard
 * shortcut is the only way to create one, and it works identically on both
 * (see `AnnotationWorkspace.svelte`'s `handleAnnotationKeyDown`). "Selected"
 * is asserted via the shared "Edit hole" tools-panel heading rather than
 * `hole-select-1`'s `aria-current`, since hole selection UI itself differs
 * between the two routes (Annotate Course: sidebar hole grid; Map Round: the
 * flat 1–18 hole bar).
 */
async function selectFirstHole(page: Page): Promise<void> {
	await page.keyboard.press('n');
	await expect(page.getByRole('heading', { name: 'Edit hole 1' })).toBeVisible();
}

/** The action ids a radial menu is currently offering, in DOM order. */
async function radialActionIds(page: Page): Promise<string[]> {
	return page.evaluate(() =>
		Array.from(document.querySelectorAll('[data-testid^="radial-action-"]')).map(
			(element) => element.getAttribute('data-testid')?.replace('radial-action-', '') ?? ''
		)
	);
}

async function openRadialMenuAtVisibleScene(page: Page): Promise<void> {
	const scene = page.getByTestId('pane-scene-source-overview');
	await scene.scrollIntoViewIfNeeded();
	const sceneBox = await boxOf(page, '[data-testid="pane-scene-source-overview"]');
	const visibleTop = Math.max(sceneBox.y, 0);
	const visibleBottom = Math.min(sceneBox.bottom, VIEWPORT.height);
	await page.mouse.click(
		sceneBox.x + sceneBox.width / 2,
		visibleTop + (visibleBottom - visibleTop) / 2
	);
}

/** Intersection area of two boxes, in px² — 0 when they do not overlap at all. */
function overlapArea(a: ElementBox, b: ElementBox): number {
	const width = Math.min(a.right, b.right) - Math.max(a.x, b.x);
	const height = Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y);
	if (width <= 0 || height <= 0) return 0;
	return Math.round(width * height);
}

/**
 * What a real mouse hits at a point. Playwright's own `click` auto-scrolls and
 * would happily report success on a control a human cannot reach, so occlusion
 * and clipping cases hit-test the geometry instead of clicking it.
 */
async function testIdAtPoint(page: Page, x: number, y: number): Promise<string | null> {
	return page.evaluate(
		({ px, py }) => {
			const element = document.elementFromPoint(px, py);
			return element?.closest('[data-testid]')?.getAttribute('data-testid') ?? null;
		},
		{ px: x, py: y }
	);
}

async function expectRadialActionsInsideViewport(
	page: Page,
	actions: readonly string[]
): Promise<void> {
	for (const action of actions) {
		const box = await boxOf(page, `[data-testid="radial-action-${action}"]`);
		expect(box.width, `radial ${action} width`).toBeGreaterThanOrEqual(36);
		expect(box.height, `radial ${action} height`).toBeGreaterThanOrEqual(36);
		expect(box.insideViewport, `radial ${action} inside viewport`).toBe(true);
	}
}

async function horizontalOverflowPx(page: Page): Promise<number> {
	return page.evaluate(
		() => document.documentElement.scrollWidth - document.documentElement.clientWidth
	);
}

// ---------------------------------------------------------------------------
// Budget 1 — zero horizontal page scroll, on any route, in any state.
// ---------------------------------------------------------------------------

const ROUTES = [
	'/stitch-map',
	'/annotate-course',
	'/map-round',
	'/create-graphics',
	'/demo',
	'/ribbon-editor'
];

for (const route of ROUTES) {
	test(`no horizontal overflow on ${route} (empty state)`, async ({ page }) => {
		await gotoApp(page, route);
		expect(await horizontalOverflowPx(page)).toBe(0);
	});
}

for (const mode of ['map', 'round'] as const) {
	test(`no horizontal overflow on ${ANNOTATION_ROUTE[mode]} with a source loaded, in both rail states`, async ({
		page
	}) => {
		await gotoApp(page, ANNOTATION_ROUTE[mode]);
		await page.getByTestId('pane-input-source-overview').setInputFiles(fixturePath('tiny.png'));
		await expect(page.getByTestId('annotation-workspace')).toHaveAttribute('data-source-loaded', 'true');
		expect(await horizontalOverflowPx(page)).toBe(0);

		await page.getByTestId('diagnostics-rail-toggle').click();
		await expect(page.getByTestId('diagnostics-rail-toggle')).toHaveAttribute(
			'aria-expanded',
			'false'
		);
		expect(await horizontalOverflowPx(page)).toBe(0);
	});
}

test('no horizontal overflow on create-graphics with both images and a complete pair', async ({
	page
}) => {
	await gotoApp(page, '/create-graphics');
	await loadBothImages(page);
	await createOnePair(page);
	expect(await horizontalOverflowPx(page)).toBe(0);
});

// ---------------------------------------------------------------------------
// Budget 2 — canvas share of the viewport during core interactions.
// Enforced where the current UI passes; fixme'd where it does not.
// ---------------------------------------------------------------------------

// The canvas is the same grid cell in both activities: re-measured 914 × 640
// with the rail collapsed and no hole selected, and 914 × 793.6 once a hole is
// selected (the "Edit hole" tools section stretches the row — the mode makes no
// difference to either number). Both clear the 55%/65% bars. This runs in both
// modes so the mode split cannot silently regress one of them.
for (const mode of ['map', 'round'] as const) {
	test(`${ANNOTATION_ROUTE[mode]}: canvas is ≥55% of viewport width with the diagnostics rail collapsed`, async ({
		page
	}) => {
		// The stored preference is the supported way to open in the collapsed state
		// (see tests/e2e/annotateCourse.spec.ts for the toggle/persistence contract).
		await page.addInitScript(() =>
			localStorage.setItem('chainspot.diagnosticsRail', 'collapsed')
		);
		await gotoApp(page, ANNOTATION_ROUTE[mode]);
		await loadAnnotateSource(page);
		// Measure the state a user annotates in, not the empty one.
		await selectFirstHole(page);

		const canvas = await boxOf(page, '[data-testid="pane-scene-source-overview"]');
		// Re-measured 914px (71.4%) — docs/13-inch-pass.md re-audit rows M2/R2.
		expect(canvas.width).toBeGreaterThanOrEqual(VIEWPORT.width * 0.55);
		// The canvas element itself also clears the height budget (793.6px = 111%;
		// that it *exceeds* one screen is the separate C-series finding below).
		expect(canvas.height).toBeGreaterThanOrEqual(VIEWPORT.height * 0.65);
	});
}

// FAILING today, identically on both routes: re-measured 638px = 49.8% with the
// rail expanded (still the default). The chrome is route-independent — 288px
// tools + 320px rail — so this is one case, not two.
// Root cause and minimal fix: docs/13-inch-pass.md F1 (ImageEditorPane.svelte:346).
for (const mode of ['map', 'round'] as const) {
	test.fixme(
		`${ANNOTATION_ROUTE[mode]}: canvas is ≥55% of viewport width with the diagnostics rail expanded`,
		async ({ page }) => {
			await gotoApp(page, ANNOTATION_ROUTE[mode]);
			await loadAnnotateSource(page);
			await expect(page.getByTestId('diagnostics-rail-toggle')).toHaveAttribute(
				'aria-expanded',
				'true'
			);
			const canvas = await boxOf(page, '[data-testid="pane-scene-source-overview"]');
			expect(canvas.width).toBeGreaterThanOrEqual(VIEWPORT.width * 0.55);
		}
	);
}

test('create-graphics: combined pane area is ≥55% of viewport width', async ({ page }) => {
	await gotoApp(page, '/create-graphics');
	const source = await boxOf(page, '[data-testid="pane-scene-source-overview"]');
	const target = await boxOf(page, '[data-testid="pane-scene-target-basemap"]');
	// Measured 1246px combined (97.3%) at audit time — docs/13-inch-pass.md row 16.
	expect(source.width + target.width).toBeGreaterThanOrEqual(VIEWPORT.width * 0.55);
});

// Fixed by Ticket A: `.scene` was a fixed 420px = 58.7% of height (51.5% at
// 1440); it is now `clamp(420px, round(66vh, 1px), 640px)`, so the pane grows
// with the viewport and never shrinks going 1280 → 1440.
test('create-graphics: pane height is ≥65% of viewport height', async ({ page }) => {
	await gotoApp(page, '/create-graphics');
	const source = await boxOf(page, '[data-testid="pane-scene-source-overview"]');
	expect(source.height).toBeGreaterThanOrEqual(VIEWPORT.height * 0.65);
});

test('stitch-map: alignment workspace is ≥55% of viewport width', async ({ page }) => {
	await gotoApp(page, '/stitch-map');
	const workspace = await boxOf(page, '[data-testid="alignment-workspace"]');
	// Measured 1100px (85.9%) at audit time — docs/13-inch-pass.md row 14.
	expect(workspace.width).toBeGreaterThanOrEqual(VIEWPORT.width * 0.55);
});

// Fixed by Ticket A: crop preview was a fixed 280px = 39.2% of height and the
// alignment workspace a fixed 440px = 61.8%. Both are now viewport-relative
// clamps (`round(66vh, 1px)`), bounded so they never exceed one screen.
test(
	'stitch-map: crop preview and alignment workspace are ≥65% of viewport height',
	async ({ page }) => {
		await gotoApp(page, '/stitch-map');
		const crop = await boxOf(page, '[data-testid="crop-viewport"]');
		const workspace = await boxOf(page, '[data-testid="alignment-workspace"]');
		expect(crop.height).toBeGreaterThanOrEqual(VIEWPORT.height * 0.65);
		expect(workspace.height).toBeGreaterThanOrEqual(VIEWPORT.height * 0.65);
	}
);

// ---------------------------------------------------------------------------
// Budget 3 — no mid-task scroll traps: the controls the current step needs.
// ---------------------------------------------------------------------------

// Passes in the state this measures: no hole selected, so the canvas cell is
// 640px tall and scrolling it into view leaves the bottom-right zoom cluster at
// y = 666–702, inside the 715px fold. The working state (a hole selected)
// does not — that is the fixme immediately below, not a weakening of this one.
test('annotate-course: on-canvas zoom controls are ≥36px and visible while the canvas is in view', async ({
	page
}) => {
	await gotoApp(page, '/annotate-course');
	await loadAnnotateSource(page);
	await page.getByTestId('pane-scene-source-overview').scrollIntoViewIfNeeded();

	for (const control of ['viewport-zoom-in', 'viewport-zoom-out', 'viewport-zoom-fit']) {
		const box = await boxOf(page, `[data-testid="${control}"]`);
		expect(box.width, `${control} width`).toBeGreaterThanOrEqual(36);
		expect(box.height, `${control} height`).toBeGreaterThanOrEqual(36);
		expect(box.insideViewport, `${control} inside viewport`).toBe(true);
	}
});

// FAILING today, and new in this re-audit: once a hole is selected the tools
// column stretches the canvas cell to 793.6px — taller than the 715px viewport
// — so scrolling the canvas into view puts the whole on-canvas zoom cluster at
// y = 744.6–780.6, entirely below the fold. These are the only mid-task
// controls that survive the hole-bar trap below, so losing them in the working
// state is the trap closing completely. Root cause and minimal fix:
// docs/13-inch-pass.md Ticket C item 2 (cap the canvas cell height).
test.fixme(
	'annotate-course: on-canvas zoom controls stay in view with a hole selected',
	async ({ page }) => {
		await gotoApp(page, '/annotate-course');
		await loadAnnotateSource(page);
		await selectFirstHole(page);
		await page.getByTestId('pane-scene-source-overview').scrollIntoViewIfNeeded();

		const canvas = await boxOf(page, '[data-testid="pane-scene-source-overview"]');
		expect(canvas.height, 'canvas cell fits one screen').toBeLessThanOrEqual(VIEWPORT.height);
		for (const control of ['viewport-zoom-in', 'viewport-zoom-out', 'viewport-zoom-fit']) {
			const box = await boxOf(page, `[data-testid="${control}"]`);
			expect(box.insideViewport, `${control} inside viewport`).toBe(true);
		}
	}
);

// FAILING today: the taller canvas cell pushes the pane further down the page,
// so with the canvas scrolled into view the hole bar and Done both scroll out
// of reach. Switching hole is a large scroll round trip on both routes.
// Root cause and minimal fix: docs/13-inch-pass.md F2 (sticky compact hole-bar
// row). The route split retired the Map/Round toggle this case used to also
// check (mode is now which route you're on, nothing left to keep in reach
// mid-task); only hole navigation is asserted here now.
for (const mode of ['map', 'round'] as const) {
	test.fixme(
		`${ANNOTATION_ROUTE[mode]}: hole navigation stays reachable while the canvas is in view`,
		async ({ page }) => {
			await gotoApp(page, ANNOTATION_ROUTE[mode]);
			await loadAnnotateSource(page);
			await selectFirstHole(page);
			await page.getByTestId('pane-scene-source-overview').scrollIntoViewIfNeeded();

			const holeNav = await boxOf(
				page,
				mode === 'round' ? '[data-testid="hole-bar"]' : '[data-testid="hole-sidebar"]'
			);
			expect(holeNav.insideViewport, 'hole navigation').toBe(true);
		}
	);
}

// FAILING today, unchanged by the mode split: in the collapsed state the
// re-expand toggle measures x = 1339.5–1369.8 on a 1280px viewport — clipped by
// the rail's `overflow: hidden` (rail scrollWidth 150 vs clientWidth 57) and
// off the viewport entirely, so `elementFromPoint` at its centre returns
// nothing at all. Keyboard focus still scrolls it into reach, which is why a
// bare locator click in a test would deceptively pass — this asserts geometry
// instead. Its 30.4 × 30.4 box is also under the 36px target budget.
// Root cause and minimal fix: docs/13-inch-pass.md F3
// ($lib/components/AnnotationWorkspace.svelte).
test.fixme(
	'annotate-course: the collapsed diagnostics rail keeps its re-expand toggle inside the viewport',
	async ({ page }) => {
		await page.addInitScript(() =>
			localStorage.setItem('chainspot.diagnosticsRail', 'collapsed')
		);
		await gotoApp(page, '/annotate-course');
		await loadAnnotateSource(page);
		const toggle = await boxOf(page, '[data-testid="diagnostics-rail-toggle"]');
		expect(toggle.right).toBeLessThanOrEqual(VIEWPORT.width);
		expect(toggle.width, 'toggle width').toBeGreaterThanOrEqual(36);
		expect(toggle.height, 'toggle height').toBeGreaterThanOrEqual(36);
		expect(
			await testIdAtPoint(page, toggle.x + toggle.width / 2, toggle.y + toggle.height / 2),
			'toggle is what a mouse hits at its own centre'
		).toBe('diagnostics-rail-toggle');
	}
);

test('create-graphics: correspondence placement controls and both panes share one screen', async ({
	page
}) => {
	await gotoApp(page, '/create-graphics');
	await loadBothImages(page);
	// At scrollY 0: Add correspondence, the guidance line, and both pane scenes
	// are simultaneously fully visible (audit rows 16–17) — the core placement
	// loop has no scroll trap. Protect that.
	for (const selector of [
		'[data-testid="add-correspondence"]',
		'[data-testid="correspondence-guidance"]',
		'[data-testid="pane-scene-source-overview"]',
		'[data-testid="pane-scene-target-basemap"]'
	]) {
		const box = await boxOf(page, selector);
		expect(box.insideViewport, `${selector} fully on-screen at scrollY 0`).toBe(true);
	}
});

// ---------------------------------------------------------------------------
// Budget 4 — target sizes and dialog containment.
// ---------------------------------------------------------------------------

// The radial menu itself is gated on the "Enable radial menu" dev toggle
// regardless of route (`AnnotationWorkspace.svelte`'s `openRadialMenu` is the
// single check) — off by default.
async function enableRadialMenu(page: Page): Promise<void> {
	await page.getByTestId('radial-menu-toggle').click();
}

// Annotate Course's empty-space menu is bend-only: tee/basket creation no
// longer opens the radial menu at all — it goes through the sidebar-driven
// placing flow (see tests/unit/annotationRadialMenu.test.ts). So hole 1 needs
// its tee and basket placed first (two placing-flow clicks at opposite
// corners) before a further empty click reaches the bend-only menu. All
// wedges re-measured 44 × 44.
test('annotate-course: the geometry radial menu (bend) keeps its action fully on-screen', async ({
	page
}) => {
	await gotoApp(page, '/annotate-course');
	await loadAnnotateSource(page);
	await selectFirstHole(page);
	await enableRadialMenu(page);

	const scene = await boxOf(page, '[data-testid="pane-scene-source-overview"]');
	await page.mouse.click(scene.x + 20, Math.max(scene.y, 0) + 20); // tee (placing flow)
	await page.mouse.click(scene.x + scene.width - 20, Math.max(scene.y, 0) + 20); // basket (placing flow)

	await openRadialMenuAtVisibleScene(page);

	await expect(page.getByTestId('radial-action-bend')).toBeVisible();
	expect(await radialActionIds(page)).toEqual(['bend']);
	await expectRadialActionsInsideViewport(page, ['bend']);
	await page.keyboard.press('Escape');
});

// Map Round offers shot (needs an active hole) and walk (never does).
test('map-round: the round radial menu keeps throw actions fully on-screen', async ({
	page
}) => {
	await gotoApp(page, '/map-round');
	await loadAnnotateSource(page);
	await selectFirstHole(page);
	await enableRadialMenu(page);

	await openRadialMenuAtVisibleScene(page);

	await expect(page.getByTestId('radial-action-shot')).toBeVisible();
	expect(await radialActionIds(page)).toEqual(['shot', 'walk']);
	await expectRadialActionsInsideViewport(page, ['shot', 'walk']);
	await page.keyboard.press('Escape');
});

// The walk path deliberately needs no hole selected, so it is reachable in the
// one Map Round state where nothing else is: re-measured 44 × 44, on-screen.
test('map-round: the round radial menu offers the walk path with no hole selected', async ({
	page
}) => {
	await gotoApp(page, '/map-round');
	await loadAnnotateSource(page);
	await enableRadialMenu(page);

	await openRadialMenuAtVisibleScene(page);

	await expect(page.getByTestId('radial-action-walk')).toBeVisible();
	expect(await radialActionIds(page)).toEqual(['walk']);
	await expectRadialActionsInsideViewport(page, ['walk']);
	await page.keyboard.press('Escape');
});

// FAILING today, in both modes, and new in this re-audit: an existing marker is
// re-opened (to delete or replace it) by hitting `MARKER_HIT_RADIUS_PX = 12` in
// *screen* space — probed empirically at 12px away (marker menu) versus 13px
// away (placement menu), i.e. an effective 24 × 24px target for every tee,
// basket, bend, shot and walk vertex, against a 36px budget. The drawn marker
// is 14 × 14. Root cause and minimal fix: docs/13-inch-pass.md F4
// ($lib/components/AnnotationWorkspace.svelte).
//
// NOTE: written against an older placing flow where an empty click opened a
// radial menu with a `tee` wedge. Since the sidebar-driven placing flow
// (annotateCourseSidebar.spec equivalent), an empty click places a hole's
// missing tee/basket directly, and re-clicking an existing tee/basket marker
// opens the marker *chip* (`marker-chip`), not the radial delete menu — only
// bend/shot/walk markers still use the radial menu. This body needs
// re-deriving against that flow before its `.fixme` is lifted.
test.fixme('annotate-course: an existing marker is a ≥36px pointer target', async ({ page }) => {
	await gotoApp(page, '/annotate-course');
	await loadAnnotateSource(page);
	await selectFirstHole(page);
	await enableRadialMenu(page);
	await openRadialMenuAtVisibleScene(page);
	await page.getByTestId('radial-action-tee').click();
	await expect(page.getByTestId('tee-marker-1')).toBeVisible();

	// The marker's own centre, then one budget-radius (18px) away: both must
	// re-open the marker's menu for the target to measure 36px across.
	const scene = await boxOf(page, '[data-testid="pane-scene-source-overview"]');
	const centreX = scene.x + scene.width / 2;
	const centreY = Math.max(scene.y, 0) + (Math.min(scene.bottom, VIEWPORT.height) - Math.max(scene.y, 0)) / 2;
	await page.mouse.click(centreX + 17, centreY);
	expect(await radialActionIds(page)).toEqual(['delete']);
	await page.keyboard.press('Escape');
});

test('create-graphics: the discard-confirmation dialog is fully contained on-screen', async ({
	page
}) => {
	await gotoApp(page, '/create-graphics');
	await loadBothImages(page);
	await createOnePair(page);

	// Replacing an image that participates in a pair raises the confirmation.
	await page.getByTestId('pane-input-source-overview').setInputFiles(fixturePath('tiny.jpg'));
	await expect(page.getByTestId('discard-confirmation')).toBeVisible();
	const dialog = await boxOf(page, '[data-testid="discard-confirmation"]');
	expect(dialog.insideViewport).toBe(true);
	await page.keyboard.press('Escape');
	await expect(page.getByTestId('discard-confirmation')).toBeHidden();
});

// ---------------------------------------------------------------------------
// Budget 5 — the two-act `/demo` rail must not occlude critical controls.
//
// The rail is a fixed 386 × 514 panel docked bottom-right (49.2px tall when
// collapsed, docked in the same corner). These cases start the tour at a step
// whose arming is `none`, so they cost no asset fetch and no CV: the rail's
// geometry is identical on every step, which is the whole point of the finding.
// ---------------------------------------------------------------------------

const DEMO_RAIL_CONTROLS = ['demo-collapse', 'demo-exit', 'demo-previous', 'demo-next'] as const;

async function startDemoAt(page: Page, stepId: string, route: RegExp): Promise<void> {
	await gotoApp(page, '/demo');
	await page.getByTestId(`demo-start-step-${stepId}`).click();
	await page.waitForURL(route);
	await expect(page.getByTestId('demo-guide')).toBeVisible();
}

test('demo: the guide rail is fully inside the viewport and leaves no horizontal overflow', async ({
	page
}) => {
	await startDemoAt(page, 'annotate-course', /\/annotate-course$/);
	const rail = await boxOf(page, '[data-testid="demo-guide"]');
	// Re-measured 386 × 514 at (878, 185) — docs/13-inch-pass.md re-audit D1.
	expect(rail.insideViewport, 'rail on annotate-course').toBe(true);
	expect(await horizontalOverflowPx(page)).toBe(0);

	await page.getByTestId('demo-next').click();
	await page.waitForURL(/\/create-graphics$/);
	const graphicsRail = await boxOf(page, '[data-testid="demo-guide"]');
	expect(graphicsRail.insideViewport, 'rail on create-graphics').toBe(true);
	expect(await horizontalOverflowPx(page)).toBe(0);
});

// What is genuinely good and worth protecting: the rail is docked clear of
// Annotate Course's page-level controls (all re-measured at zero overlap).
// The controls it *does* cover are the fixme'd cases below. The Map/Round
// mode toggle this used to also check no longer exists post-route-split.
test('demo: the guide rail clears Annotate Course’s page-level controls', async ({ page }) => {
	await startDemoAt(page, 'annotate-course', /\/annotate-course$/);
	await loadAnnotateSource(page);
	const rail = await boxOf(page, '[data-testid="demo-guide"]');
	for (const control of ['annotate-done']) {
		const box = await boxOf(page, `[data-testid="${control}"]`);
		expect(overlapArea(rail, box), `rail overlaps ${control}`).toBe(0);
	}
});

// FAILING today, new in this re-audit: every control the rail owns is under the
// 36px target budget — collapse 67.4 × 24, exit 77 × 24, back/next 57–58.4 ×
// 30.8, "Load the real inputs"/"Reload the page" 360 × 30.8, Finish 64.2 ×
// 30.8. The ≤640px media query already gives them `min-height: 2.5rem`; a 13″
// laptop gets nothing. Root cause and minimal fix: docs/13-inch-pass.md
// Ticket E item 1 (DemoGuide.svelte:371-425).
test.fixme('demo: the guide rail’s own controls are ≥36px', async ({ page }) => {
	await startDemoAt(page, 'annotate-course', /\/annotate-course$/);
	for (const control of DEMO_RAIL_CONTROLS) {
		const box = await boxOf(page, `[data-testid="${control}"]`);
		expect(box.width, `${control} width`).toBeGreaterThanOrEqual(36);
		expect(box.height, `${control} height`).toBeGreaterThanOrEqual(36);
	}
});

// FAILING today, unchanged since the original pass: with the canvas scrolled
// into view the rail covers Fit entirely (36 × 33 of a 36 × 36 button) and
// zoom-out partially (12 × 33); zoom-in stays clear. Collapsing the rail does
// *not* clear them — the collapsed 49.2px header still spans the same corner,
// covering exactly the same two buttons — so "start collapsed" alone would not
// close this. Keyboard `0`/`+`/`-` still work. Root cause and minimal fix:
// docs/13-inch-pass.md Ticket D (DemoGuide.svelte:244-259).
test.fixme('demo: the guide rail does not cover the on-canvas zoom cluster', async ({ page }) => {
	await startDemoAt(page, 'annotate-course', /\/annotate-course$/);
	await loadAnnotateSource(page);
	await page.getByTestId('pane-scene-source-overview').scrollIntoViewIfNeeded();
	const rail = await boxOf(page, '[data-testid="demo-guide"]');
	for (const control of ['viewport-zoom-in', 'viewport-zoom-out', 'viewport-zoom-fit']) {
		const box = await boxOf(page, `[data-testid="${control}"]`);
		expect(overlapArea(rail, box), `rail overlaps ${control}`).toBe(0);
	}
});

// FAILING today, new in this re-audit: on the 18-hole course the demo itself
// produces in step 2, the rail sits on top of hole tabs 15–18 (63 × 44 each,
// fully covered at 1280 — `elementFromPoint` at their centres returns the rail)
// and on the compact row's "Next hole" cycle button (44 × 46, fully covered).
// Those are the controls the step-2 script tells a visitor to use to reach the
// hole flagged for review. Root cause and minimal fix: docs/13-inch-pass.md
// Ticket E item 2.
//
// NOTE: written against the old flat hole-bar, which Annotate Course no
// longer has (hole selection moved to the sidebar grid — `sidebar-hole-N`,
// see annotateCourseSidebar tests); the "compact ‹/current/› row" this
// referenced is gone too. Rebased onto the sidebar grid's own hole boxes, but
// unverified — this needs a real re-measure against the sidebar layout before
// its `.fixme` is lifted.
test.fixme('demo: the guide rail does not cover the hole sidebar’s own controls', async ({ page }) => {
	await startDemoAt(page, 'annotate-course', /\/annotate-course$/);
	await loadAnnotateSource(page);
	for (let index = 0; index < 18; index += 1) await page.keyboard.press('n');
	await expect(page.getByTestId('annotation-workspace')).toHaveAttribute('data-hole-count', '18');

	const rail = await boxOf(page, '[data-testid="demo-guide"]');
	for (const number of [15, 16, 17, 18]) {
		const tab = await boxOf(page, `[data-testid="sidebar-hole-${number}"]`);
		expect(overlapArea(rail, tab), `rail overlaps hole ${number}`).toBe(0);
	}
	const nextHole = await boxOf(page, '.hole-bar-compact-nav:last-of-type');
	expect(overlapArea(rail, nextHole), 'rail overlaps the next-hole control').toBe(0);
});

// FAILING today, new in this re-audit: on Create Graphics — the route the
// two-act script visits twice, and the one where the visitor must click
// landmarks in *both* panes — the rail covers 385 × 420px of the target
// basemap pane, 62.7% of its width. Collapsing the rail does clear this one.
// Root cause and minimal fix: docs/13-inch-pass.md Ticket E item 3.
test.fixme('demo: the guide rail does not cover the Create Graphics target pane', async ({
	page
}) => {
	await startDemoAt(page, 'basemap-and-export', /\/create-graphics$/);
	const rail = await boxOf(page, '[data-testid="demo-guide"]');
	for (const role of ['source-overview', 'target-basemap']) {
		const pane = await boxOf(page, `[data-testid="pane-scene-${role}"]`);
		expect(overlapArea(rail, pane), `rail overlaps ${role}`).toBe(0);
	}
});

// FAILING today, new in this re-audit: the last step's "Finish" is a link back
// to `/demo` that leaves the tour running, and on that page the rail covers the
// final step card's own "Start here" button at every scroll position the page
// allows (the card's x-range 833–927 sits inside the rail's 878–1264, and its
// y never leaves the rail's 185–699 band) — `elementFromPoint` returns the
// rail. Same at 1152; at 1440 the card clears the rail. Root cause and minimal
// fix: docs/13-inch-pass.md Ticket E item 4.
test.fixme('demo: the cover page’s own controls stay reachable while a tour is running', async ({
	page
}) => {
	await startDemoAt(page, 'annotate-course', /\/annotate-course$/);
	await gotoApp(page, '/demo');
	await expect(page.getByTestId('demo-guide')).toBeVisible();
	const card = page.getByTestId('demo-start-step-export-round');
	await card.scrollIntoViewIfNeeded();
	const box = await boxOf(page, '[data-testid="demo-start-step-export-round"]');
	expect(
		await testIdAtPoint(page, box.x + box.width / 2, box.y + box.height / 2),
		'the last step card is what a mouse hits at its own centre'
	).toBe('demo-start-step-export-round');
});

// ---------------------------------------------------------------------------
// Shared flows (same conventions as tests/e2e/annotateRound.spec.ts /
// keyboardFocus.spec.ts — image-space clicks through the pane's view state).
// ---------------------------------------------------------------------------

async function loadBothImages(page: Page): Promise<void> {
	await page.getByTestId('pane-input-source-overview').setInputFiles(fixturePath('tiny.png'));
	await expect(page.getByTestId('pane-filename-source-overview')).toHaveText('tiny.png');
	await page.getByTestId('pane-input-target-basemap').setInputFiles(fixturePath('tiny.jpg'));
	await expect(page.getByTestId('pane-filename-target-basemap')).toHaveText('tiny.jpg');
}

async function createOnePair(page: Page): Promise<void> {
	await expect(page.getByTestId('add-correspondence')).toBeEnabled();
	await page.getByTestId('add-correspondence').click();
	await canvasClickAtImagePoint(page, 'source-overview', 1, 1);
	await canvasClickAtImagePoint(page, 'target-basemap', 1, 1);
	await expect(page.getByTestId('app-shell')).toHaveAttribute('data-complete-pair-count', '1');
}

async function canvasClickAtImagePoint(
	page: Page,
	role: string,
	xPx: number,
	yPx: number
): Promise<void> {
	await page.getByTestId(`pane-scene-${role}`).scrollIntoViewIfNeeded();
	const point = await page.evaluate(
		({ paneRole, x, y }) => {
			const element = document.querySelector<HTMLElement>(
				`[data-testid="pane-scene-${paneRole}"]`
			);
			if (!element) throw new Error(`missing pane scene ${paneRole}`);
			const rect = element.getBoundingClientRect();
			const zoom = Number(element.dataset.viewZoom);
			const panX = Number(element.dataset.viewPanX);
			const panY = Number(element.dataset.viewPanY);
			return {
				x: rect.left + element.clientLeft + x * zoom + panX,
				y: rect.top + element.clientTop + y * zoom + panY
			};
		},
		{ paneRole: role, x: xPx, y: yPx }
	);
	await page.mouse.click(point.x, point.y);
}
