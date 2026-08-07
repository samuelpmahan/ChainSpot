import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

const SOURCE_ROLE = 'source-overview';
const TARGET_ROLE = 'target-basemap';

const fixturePath = (name: string): string => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));

function attachErrorListener(page: Page): string[] {
	const errors: string[] = [];
	page.on('console', (message) => {
		if (message.type() === 'error') errors.push(message.text());
	});
	page.on('pageerror', (error) => errors.push(String(error)));
	return errors;
}

async function gotoApp(page: Page): Promise<void> {
	await page.goto('/create-graphics');
	await page.waitForFunction(() => document.documentElement.dataset.appReady === 'true');
}

async function loadBoth(page: Page): Promise<void> {
	await page.getByTestId('pane-input-source-overview').setInputFiles(fixturePath('tiny.png'));
	await expect(page.getByTestId('pane-filename-source-overview')).toHaveText('tiny.png');
	await page.getByTestId('pane-input-target-basemap').setInputFiles(fixturePath('tiny.jpg'));
	await expect(page.getByTestId('pane-filename-target-basemap')).toHaveText('tiny.jpg');
}

interface ViewState {
	zoom: number;
	panX: number;
	panY: number;
}

interface PaneGeometry {
	left: number;
	top: number;
	clientLeft: number;
	clientTop: number;
	width: number;
	height: number;
}

async function viewState(page: Page, role: string): Promise<ViewState> {
	return page.evaluate((paneRole) => {
		const element = document.querySelector<HTMLElement>(`[data-testid="pane-scene-${paneRole}"]`);
		if (!element) throw new Error(`missing pane ${paneRole}`);
		return {
			zoom: Number(element.dataset.viewZoom),
			panX: Number(element.dataset.viewPanX),
			panY: Number(element.dataset.viewPanY)
		};
	}, role);
}

async function paneGeometry(page: Page, role: string): Promise<PaneGeometry> {
	return page.evaluate((paneRole) => {
		const element = document.querySelector<HTMLElement>(`[data-testid="pane-scene-${paneRole}"]`);
		if (!element) throw new Error(`missing pane ${paneRole}`);
		const rect = element.getBoundingClientRect();
		return {
			left: rect.left,
			top: rect.top,
			clientLeft: element.clientLeft,
			clientTop: element.clientTop,
			width: element.clientWidth,
			height: element.clientHeight
		};
	}, role);
}

function panePoint(geometry: PaneGeometry, x: number, y: number): { x: number; y: number } {
	return {
		x: geometry.left + geometry.clientLeft + x,
		y: geometry.top + geometry.clientTop + y
	};
}

function imagePoint(view: ViewState, xPx: number, yPx: number): { x: number; y: number } {
	return { x: xPx * view.zoom + view.panX, y: yPx * view.zoom + view.panY };
}

async function canvasClick(page: Page, role: string, local: { x: number; y: number }): Promise<void> {
	await page.getByTestId(`pane-scene-${role}`).scrollIntoViewIfNeeded();
	const geometry = await paneGeometry(page, role);
	await page.mouse.click(...(Object.values(panePoint(geometry, local.x, local.y)) as [number, number]));
}

async function createPair(
	page: Page,
	sourcePoint: { xPx: number; yPx: number },
	targetPoint: { xPx: number; yPx: number }
): Promise<void> {
	const sourceView = await viewState(page, SOURCE_ROLE);
	const targetView = await viewState(page, TARGET_ROLE);
	await page.getByTestId('add-correspondence').click();
	await canvasClick(page, SOURCE_ROLE, imagePoint(sourceView, sourcePoint.xPx, sourcePoint.yPx));
	await canvasClick(page, TARGET_ROLE, imagePoint(targetView, targetPoint.xPx, targetPoint.yPx));
	await expect(page.getByTestId('app-shell')).toHaveAttribute('data-correspondence-mode', 'neutral');
}

/** A list row by its current presentation ordinal (stable, unlike random pair ids). */
function row(page: Page, ordinal: number): Locator {
	return page.locator(`[data-testid="pair-row"][data-ordinal="${ordinal}"]`);
}

/** A control inside a row whose test id starts with the given prefix. */
function inRow(row: Locator, testIdPrefix: string): Locator {
	return row.locator(`[data-testid^="${testIdPrefix}-"]`);
}

test('critical controls, status, and canvas alternatives have accessible names', async ({ page }) => {
	await gotoApp(page);

	await expect(page.getByRole('button', { name: 'Add correspondence' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Save project' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Open project' })).toBeVisible();
	await expect(page.getByLabel('Project name')).toBeVisible();
	await expect(page.getByRole('region', { name: 'Control point pairs' })).toBeVisible();
	await expect(page.getByTestId('correspondence-status')).toHaveAttribute('aria-live', 'polite');
	await expect(page.getByTestId('pair-diagnostics')).toHaveAttribute('aria-live', 'polite');
	await expect(page.getByTestId('pane-scene-source-overview')).toHaveAttribute('role', 'img');
	await expect(page.getByTestId('pane-choose-source-overview')).toHaveAccessibleName(
		'Choose a UDisc source image'
	);
});

test('narrow desktop stacks inspectable panes without changing their canvas accessibility', async ({
	page
}) => {
	await page.setViewportSize({ width: 800, height: 900 });
	await gotoApp(page);
	await loadBoth(page);

	const geometry = await page.evaluate(() => {
		const source = document.querySelector<HTMLElement>('[data-testid="pane-source-overview"]');
		const target = document.querySelector<HTMLElement>('[data-testid="pane-target-basemap"]');
		const sourceScene = document.querySelector<HTMLElement>('[data-testid="pane-scene-source-overview"]');
		const targetScene = document.querySelector<HTMLElement>('[data-testid="pane-scene-target-basemap"]');
		if (!source || !target || !sourceScene || !targetScene) throw new Error('missing pane');
		return {
			sourceTop: source.getBoundingClientRect().top,
			targetTop: target.getBoundingClientRect().top,
			sourceWidth: sourceScene.clientWidth,
			targetWidth: targetScene.clientWidth,
			sourceRole: sourceScene.getAttribute('role'),
			targetRole: targetScene.getAttribute('role')
		};
	});

	expect(geometry.targetTop).toBeGreaterThan(geometry.sourceTop);
	expect(geometry.sourceWidth).toBeGreaterThan(0);
	expect(geometry.targetWidth).toBeGreaterThan(0);
	expect(geometry.sourceRole).toBe('img');
	expect(geometry.targetRole).toBe('img');
});

test('narrow reflow keeps every required control reachable and marker coordinates fixed', async ({
	page
}) => {
	const errors = attachErrorListener(page);
	await gotoApp(page);

	// Build the pair at the desktop layout first, then reflow to the narrow baseline.
	await loadBoth(page);
	await createPair(page, { xPx: 1, yPx: 1 }, { xPx: 2, yPx: 2 });
	await expect(page.getByTestId('app-shell')).toHaveAttribute('data-complete-pair-count', '1');
	await expect(inRow(row(page, 1), 'pair-source-px')).toHaveText('(1, 1)');
	await expect(inRow(row(page, 1), 'pair-target-px')).toHaveText('(2, 2)');

	// Reflow to the documented narrow desktop baseline (media query <= 900px).
	await page.setViewportSize({ width: 800, height: 900 });

	// Authoritative coordinates cannot change through the reflow.
	await expect(inRow(row(page, 1), 'pair-source-px')).toHaveText('(1, 1)');
	await expect(inRow(row(page, 1), 'pair-target-px')).toHaveText('(2, 2)');

	// The panes stack without horizontal overlap and both remain inspectable.
	const geometry = await page.evaluate(() => {
		const source = document.querySelector<HTMLElement>('[data-testid="pane-source-overview"]');
		const target = document.querySelector<HTMLElement>('[data-testid="pane-target-basemap"]');
		if (!source || !target) throw new Error('missing pane');
		return {
			sourceTop: source.getBoundingClientRect().top,
			targetTop: target.getBoundingClientRect().top,
			sourceLeft: source.getBoundingClientRect().left,
			targetLeft: target.getBoundingClientRect().left
		};
	});
	expect(geometry.targetTop).toBeGreaterThan(geometry.sourceTop);
	expect(geometry.sourceLeft).toBeCloseTo(geometry.targetLeft, 0);

	// Every required control stays visible and reachable at the narrow width.
	const controls: Array<[string, boolean]> = [
		['add-correspondence', true],
		['save-project', true],
		['open-project', true],
		['undo', false],
		['redo', false],
		['toggle-markers', true],
		[`pane-choose-${SOURCE_ROLE}`, true],
		[`pane-fit-${SOURCE_ROLE}`, true],
		[`pane-choose-${TARGET_ROLE}`, true],
		[`pane-fit-${TARGET_ROLE}`, true]
	];
	for (const [testId, enabled] of controls) {
		const control = page.getByTestId(testId);
		await expect(control).toBeVisible();
		if (enabled) await expect(control).toBeEnabled();
	}

	// Both images can still be inspected sequentially at the narrow width.
	await page.getByTestId(`pane-fit-${SOURCE_ROLE}`).click();
	await expect(page.getByTestId(`pane-scene-${SOURCE_ROLE}`)).toBeVisible();
	await page.getByTestId(`pane-fit-${TARGET_ROLE}`).click();
	await expect(page.getByTestId(`pane-scene-${TARGET_ROLE}`)).toBeVisible();

	// No horizontal page overflow and no console/page errors through the reflow.
	const overflow = await page.evaluate(
		() => document.documentElement.scrollWidth - document.documentElement.clientWidth
	);
	expect(overflow).toBeLessThanOrEqual(1);
	expect(errors).toEqual([]);
});

test('every required pair-management action has a keyboard-operable visible control', async ({
	page
}) => {
	await gotoApp(page);
	await loadBoth(page);
	await createPair(page, { xPx: 1, yPx: 1 }, { xPx: 2, yPx: 2 });
	await createPair(page, { xPx: 0, yPx: 0 }, { xPx: 1, yPx: 1 });

	// Label, select-source, select-target, reorder, enable, and delete are native controls.
	for (const ordinal of [1, 2]) {
		await expect(inRow(row(page, ordinal), 'pair-label')).toBeVisible();
	}
	await expect(row(page, 1).locator('[data-side="source"]')).toHaveAccessibleName(
		'Select the source point of pair 1'
	);
	await expect(row(page, 2).locator('[data-side="target"]')).toHaveAccessibleName(
		'Select the target point of pair 2'
	);
	await expect(inRow(row(page, 2), 'pair-up')).toHaveAccessibleName('Move pair 2 up');
	await expect(inRow(row(page, 1), 'pair-down')).toHaveAccessibleName('Move pair 1 down');
	await expect(inRow(row(page, 2), 'pair-delete')).toHaveAccessibleName('Delete pair 2');
	await expect(inRow(row(page, 2), 'pair-enabled')).toHaveAccessibleName('Enable pair 2');
});

test('selected and disabled list states are conveyed beyond color alone', async ({ page }) => {
	await gotoApp(page);
	await loadBoth(page);
	await createPair(page, { xPx: 1, yPx: 1 }, { xPx: 2, yPx: 2 });
	await createPair(page, { xPx: 0, yPx: 0 }, { xPx: 1, yPx: 1 });

	// Select pair 1's source side from the list.
	const sourceButton = row(page, 1).locator('[data-side="source"]');
	await sourceButton.focus();
	await sourceButton.press('Enter');
	await expect(row(page, 1).locator('[data-side="source"]')).toHaveAttribute('aria-pressed', 'true');
	await expect(page.getByTestId('point-inspector')).toContainText('Pair 1 · Source point');

	// The selected row exposes aria-current and a non-color selected mark.
	await expect(inRow(row(page, 1), 'pair-selected-mark')).toBeVisible();
	await expect(row(page, 1)).toHaveAttribute('aria-current', 'true');

	// A disabled pair exposes a visible text badge (non-color state signal).
	const enabledToggle = inRow(row(page, 2), 'pair-enabled');
	await enabledToggle.uncheck();
	await expect(inRow(row(page, 2), 'pair-disabled')).toHaveText('Disabled');
	await expect(row(page, 2)).toHaveAttribute('aria-label', /disabled/);
});

test('status guidance and outcomes are announced through polite live regions', async ({ page }) => {
	await gotoApp(page);
	await loadBoth(page);

	// Add-step guidance is announced politely when creation starts.
	await page.getByTestId('add-correspondence').click();
	await expect(page.getByTestId('correspondence-guidance')).toHaveText(
		'Click a landmark in the UDisc source image.'
	);
	await expect(page.getByTestId('activity-message')).toHaveText(
		'Add correspondence started. Select a landmark in the source image.'
	);

	// Escape cancels the pending creation and announces it.
	await page.keyboard.press('Escape');
	await expect(page.getByTestId('app-shell')).toHaveAttribute('data-correspondence-mode', 'neutral');
	await expect(page.getByTestId('activity-message')).toHaveText('Pending correspondence cancelled.');

	// The status live regions are polite and the region structure is present.
	await expect(page.getByTestId('activity-status')).toHaveAttribute('aria-live', 'polite');
	await expect(page.getByTestId('activity-message')).toHaveAttribute('role', 'status');
});
