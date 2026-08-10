import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

function fixturePath(name: string): string {
	return fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
}

async function gotoApp(page: Page, route: string): Promise<void> {
	await page.goto(route);
	await page.waitForFunction(() => document.documentElement.dataset.appReady === 'true');
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
		if (!element) throw new Error(`missing pane scene ${paneRole}`);
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
		if (!element) throw new Error(`missing pane scene ${paneRole}`);
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
	const point = panePoint(geometry, local.x, local.y);
	await page.mouse.click(point.x, point.y);
}

test('empty-state "Choose image" button opens the native file picker', async ({ page }) => {
	await gotoApp(page, '/annotate-round');

	// Regression test: a pointerdown on a control rendered inside the pannable
	// ImageViewport must not be swallowed by the viewport's own pan-gesture
	// setup (which used to call setPointerCapture on the viewport container
	// and retarget the resulting click away from the button, so the click
	// handler that opens the file input never ran).
	const chooserPromise = page.waitForEvent('filechooser');
	await page.getByTestId('pane-choose-inline-source-overview').click();
	const chooser = await chooserPromise;
	expect(chooser.isMultiple()).toBe(false);
});

test('Annotate Round hands its source image to Create Graphics, where the correspondence workflow still works', async ({
	page
}) => {
	await gotoApp(page, '/annotate-round');

	// Done is gated on a loaded source image.
	await expect(page.getByTestId('annotate-done')).toBeDisabled();
	await page.getByTestId('pane-input-source-overview').setInputFiles(fixturePath('tiny.png'));
	await expect(page.getByTestId('pane-filename-source-overview')).toHaveText('tiny.png · 2 × 3');
	await expect(page.getByTestId('annotate-round')).toHaveAttribute('data-source-loaded', 'true');
	await expect(page.getByTestId('annotate-done')).toBeEnabled();

	// Finishing navigates to Create Graphics with the same source image already
	// loaded there (no re-upload needed).
	await page.getByTestId('annotate-done').click();
	await expect(page).toHaveURL(/\/create-graphics$/);
	await expect(page).toHaveTitle('Create Graphics | ChainSpot');
	await expect(page.getByTestId('pane-filename-source-overview')).toHaveText('tiny.png');
	await expect(page.getByTestId('app-shell')).toHaveAttribute('data-annotated-round', 'present');

	// The existing correspondence workflow is unaffected by the route split:
	// load a target image and create one correspondence pair.
	await page.getByTestId('pane-input-target-basemap').setInputFiles(fixturePath('tiny.jpg'));
	await expect(page.getByTestId('pane-filename-target-basemap')).toHaveText('tiny.jpg');
	await expect(page.getByTestId('add-correspondence')).toBeEnabled();

	const sourceView = await viewState(page, 'source-overview');
	const targetView = await viewState(page, 'target-basemap');
	await page.getByTestId('add-correspondence').click();
	await canvasClick(page, 'source-overview', imagePoint(sourceView, 1, 1));
	await canvasClick(page, 'target-basemap', imagePoint(targetView, 1, 1));
	await expect(page.getByTestId('app-shell')).toHaveAttribute('data-complete-pair-count', '1');
});

test('the diagnostics rail collapse toggle defaults expanded and remembers a collapsed choice across a full page reload', async ({
	page
}) => {
	await gotoApp(page, '/annotate-round');

	const toggle = page.getByTestId('diagnostics-rail-toggle');
	await expect(toggle).toHaveAttribute('aria-expanded', 'true');

	await toggle.click();
	await expect(toggle).toHaveAttribute('aria-expanded', 'false');

	// A full reload clears every in-memory session; only `localStorage` (the
	// preference this toggle writes to) can be what survives it.
	await page.reload();
	await page.waitForFunction(() => document.documentElement.dataset.appReady === 'true');
	await expect(page.getByTestId('diagnostics-rail-toggle')).toHaveAttribute('aria-expanded', 'false');

	// The choice remains user-editable after the reload, in both directions.
	await page.getByTestId('diagnostics-rail-toggle').click();
	await expect(page.getByTestId('diagnostics-rail-toggle')).toHaveAttribute('aria-expanded', 'true');
});
