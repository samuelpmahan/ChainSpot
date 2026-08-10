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

const ROUTES = ['/stitch-map', '/annotate-round', '/create-graphics', '/demo', '/ribbon-editor'];

for (const route of ROUTES) {
	test(`no horizontal overflow on ${route} (empty state)`, async ({ page }) => {
		await gotoApp(page, route);
		expect(await horizontalOverflowPx(page)).toBe(0);
	});
}

test('no horizontal overflow on annotate-round with a source loaded, in both rail states', async ({
	page
}) => {
	await gotoApp(page, '/annotate-round');
	await page.getByTestId('pane-input-source-overview').setInputFiles(fixturePath('tiny.png'));
	await expect(page.getByTestId('annotate-round')).toHaveAttribute('data-source-loaded', 'true');
	expect(await horizontalOverflowPx(page)).toBe(0);

	await page.getByTestId('diagnostics-rail-toggle').click();
	await expect(page.getByTestId('diagnostics-rail-toggle')).toHaveAttribute(
		'aria-expanded',
		'false'
	);
	expect(await horizontalOverflowPx(page)).toBe(0);
});

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

test('annotate-round: canvas is ≥55% of viewport width with the diagnostics rail collapsed', async ({
	page
}) => {
	// The stored preference is the supported way to open in the collapsed state
	// (see tests/e2e/annotateRound.spec.ts for the toggle/persistence contract).
	await page.addInitScript(() =>
		localStorage.setItem('chainspot.diagnosticsRail', 'collapsed')
	);
	await gotoApp(page, '/annotate-round');
	await page.getByTestId('pane-input-source-overview').setInputFiles(fixturePath('tiny.png'));
	await expect(page.getByTestId('annotate-round')).toHaveAttribute('data-source-loaded', 'true');

	const canvas = await boxOf(page, '[data-testid="pane-scene-source-overview"]');
	// Measured 914px (71.4%) at audit time — docs/13-inch-pass.md row 2.
	expect(canvas.width).toBeGreaterThanOrEqual(VIEWPORT.width * 0.55);
	// The canvas element itself also meets the height budget (640px = 89.5%).
	expect(canvas.height).toBeGreaterThanOrEqual(VIEWPORT.height * 0.65);
});

// FAILING today: 638px = 49.8% with the rail expanded (the current default).
// Root cause and minimal fix: docs/13-inch-pass.md F1 (ImageEditorPane.svelte:346).
test.fixme(
	'annotate-round: canvas is ≥55% of viewport width with the diagnostics rail expanded',
	async ({ page }) => {
		await gotoApp(page, '/annotate-round');
		await page.getByTestId('pane-input-source-overview').setInputFiles(fixturePath('tiny.png'));
		await expect(page.getByTestId('annotate-round')).toHaveAttribute(
			'data-source-loaded',
			'true'
		);
		await expect(page.getByTestId('diagnostics-rail-toggle')).toHaveAttribute(
			'aria-expanded',
			'true'
		);
		const canvas = await boxOf(page, '[data-testid="pane-scene-source-overview"]');
		expect(canvas.width).toBeGreaterThanOrEqual(VIEWPORT.width * 0.55);
	}
);

test('create-graphics: combined pane area is ≥55% of viewport width', async ({ page }) => {
	await gotoApp(page, '/create-graphics');
	const source = await boxOf(page, '[data-testid="pane-scene-source-overview"]');
	const target = await boxOf(page, '[data-testid="pane-scene-target-basemap"]');
	// Measured 1246px combined (97.3%) at audit time — docs/13-inch-pass.md row 16.
	expect(source.width + target.width).toBeGreaterThanOrEqual(VIEWPORT.width * 0.55);
});

// FAILING today: the panes are a fixed 420px = 58.7% of height (51.5% at 1440).
// Root cause and minimal fix: docs/13-inch-pass.md, ANNOYING table + Ticket A
// (ImagePane.svelte:692 `.scene { height: 420px }`).
test.fixme('create-graphics: pane height is ≥65% of viewport height', async ({ page }) => {
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

// FAILING today: crop preview is a fixed 280px = 39.2% of height, and the
// alignment workspace a fixed 440px = 61.8%. Root cause and minimal fix:
// docs/13-inch-pass.md row 13 + Ticket A (stitch-map/+page.svelte:1867, :1947).
test.fixme(
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

test('annotate-round: on-canvas zoom controls are ≥36px and visible while the canvas is in view', async ({
	page
}) => {
	await gotoApp(page, '/annotate-round');
	await page.getByTestId('pane-input-source-overview').setInputFiles(fixturePath('tiny.png'));
	await expect(page.getByTestId('annotate-round')).toHaveAttribute('data-source-loaded', 'true');
	await page.getByTestId('pane-scene-source-overview').scrollIntoViewIfNeeded();

	for (const control of ['viewport-zoom-in', 'viewport-zoom-out', 'viewport-zoom-fit']) {
		const box = await boxOf(page, `[data-testid="${control}"]`);
		expect(box.width, `${control} width`).toBeGreaterThanOrEqual(36);
		expect(box.height, `${control} height`).toBeGreaterThanOrEqual(36);
		expect(box.insideViewport, `${control} inside viewport`).toBe(true);
	}
});

// FAILING today: with the canvas scrolled into view (scrollY ≈ 310) the hole bar
// ends at y = −7 and Done at y = −200; every hole switch is a 300–520px scroll
// round trip. Root cause and minimal fix: docs/13-inch-pass.md F2 (sticky
// compact hole-bar row, annotate-round/+page.svelte:1627/2811).
test.fixme(
	'annotate-round: hole navigation stays reachable while the canvas is in view',
	async ({ page }) => {
		await gotoApp(page, '/annotate-round');
		await page.getByTestId('pane-input-source-overview').setInputFiles(fixturePath('tiny.png'));
		await expect(page.getByTestId('annotate-round')).toHaveAttribute(
			'data-source-loaded',
			'true'
		);
		await page.getByTestId('pane-scene-source-overview').scrollIntoViewIfNeeded();
		const compactBar = await boxOf(page, '[data-testid="hole-bar-current-label"]');
		expect(compactBar.insideViewport).toBe(true);
	}
);

// FAILING today: in the collapsed state the re-expand toggle measures x = 1339
// on a 1280px viewport — clipped by the rail's `overflow: hidden` and
// unreachable by pointer (keyboard focus still scrolls it into reach, which is
// why a bare locator click in a test would deceptively pass — this asserts
// geometry instead). Root cause and minimal fix: docs/13-inch-pass.md F3
// (annotate-round/+page.svelte:3433).
test.fixme(
	'annotate-round: the collapsed diagnostics rail keeps its re-expand toggle inside the viewport',
	async ({ page }) => {
		await page.addInitScript(() =>
			localStorage.setItem('chainspot.diagnosticsRail', 'collapsed')
		);
		await gotoApp(page, '/annotate-round');
		await page.getByTestId('pane-input-source-overview').setInputFiles(fixturePath('tiny.png'));
		await expect(page.getByTestId('annotate-round')).toHaveAttribute(
			'data-source-loaded',
			'true'
		);
		const toggle = await boxOf(page, '[data-testid="diagnostics-rail-toggle"]');
		expect(toggle.right).toBeLessThanOrEqual(VIEWPORT.width);
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

test('annotate-round: the map radial menu keeps geometry actions fully on-screen', async ({
	page
}) => {
	await gotoApp(page, '/annotate-round');
	await page.getByTestId('pane-input-source-overview').setInputFiles(fixturePath('tiny.png'));
	await expect(page.getByTestId('annotate-round')).toHaveAttribute('data-source-loaded', 'true');
	await page.getByTestId('hole-add').click();

	await openRadialMenuAtVisibleScene(page);

	await expect(page.getByTestId('radial-action-tee')).toBeVisible();
	await expectRadialActionsInsideViewport(page, ['tee', 'basket', 'bend']);
	await page.keyboard.press('Escape');
});

test('annotate-round: the round radial menu keeps throw actions fully on-screen', async ({
	page
}) => {
	await gotoApp(page, '/annotate-round');
	await page.getByTestId('pane-input-source-overview').setInputFiles(fixturePath('tiny.png'));
	await expect(page.getByTestId('annotate-round')).toHaveAttribute('data-source-loaded', 'true');
	await page.getByTestId('hole-add').click();
	await page.getByTestId('annotation-mode-round').click();
	await expect(page.getByTestId('annotation-mode-round')).toHaveAttribute('aria-pressed', 'true');

	await openRadialMenuAtVisibleScene(page);

	await expect(page.getByTestId('radial-action-shot')).toBeVisible();
	await expectRadialActionsInsideViewport(page, ['shot', 'walk']);
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
