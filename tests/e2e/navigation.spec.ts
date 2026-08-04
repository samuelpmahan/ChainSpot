import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const SOURCE_ROLE = 'source-overview';
const TARGET_ROLE = 'target-basemap';

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

function fixturePath(name: string): string {
	return fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
}

function attachErrorListener(page: Page): string[] {
	const consoleErrors: string[] = [];
	page.on('console', (message) => {
		if (message.type() === 'error') consoleErrors.push(message.text());
	});
	page.on('pageerror', (error) => consoleErrors.push(String(error)));
	return consoleErrors;
}

async function gotoApp(page: Page): Promise<void> {
	await page.goto('/spot-round');
	await page.waitForFunction(() => document.documentElement.dataset.appReady === 'true');
}

async function loadBoth(page: Page): Promise<void> {
	await page.getByTestId('pane-input-source-overview').setInputFiles(fixturePath('tiny.png'));
	await expect(page.getByTestId('pane-filename-source-overview')).toHaveText('tiny.png');
	await page.getByTestId('pane-input-target-basemap').setInputFiles(fixturePath('tiny.jpg'));
	await expect(page.getByTestId('pane-filename-target-basemap')).toHaveText('tiny.jpg');
}

async function viewState(page: Page, role: string): Promise<ViewState> {
	return page.evaluate((paneRole: string) => {
		const el = document.querySelector<HTMLElement>(`[data-testid="pane-scene-${paneRole}"]`);
		if (!el) throw new Error(`missing pane scene ${paneRole}`);
		return {
			zoom: parseFloat(el.dataset.viewZoom ?? ''),
			panX: parseFloat(el.dataset.viewPanX ?? ''),
			panY: parseFloat(el.dataset.viewPanY ?? '')
		};
	}, role);
}

async function paneGeometry(page: Page, role: string): Promise<PaneGeometry> {
	return page.evaluate((paneRole: string) => {
		const el = document.querySelector<HTMLElement>(`[data-testid="pane-scene-${paneRole}"]`);
		if (!el) throw new Error(`missing pane scene ${paneRole}`);
		const rect = el.getBoundingClientRect();
		return {
			left: rect.left,
			top: rect.top,
			clientLeft: el.clientLeft,
			clientTop: el.clientTop,
			width: el.clientWidth,
			height: el.clientHeight
		};
	}, role);
}

/** Viewport coordinates that place the mouse at a pane-local CSS pixel. */
function panePoint(geometry: PaneGeometry, localX: number, localY: number): { x: number; y: number } {
	return {
		x: geometry.left + geometry.clientLeft + localX,
		y: geometry.top + geometry.clientTop + localY
	};
}

/** Expected default fit computed with the same formula the pane uses. */
function fitFor(geometry: PaneGeometry, imageWidth: number, imageHeight: number): ViewState {
	const zoom = Math.min(geometry.width / imageWidth, geometry.height / imageHeight);
	return {
		zoom,
		panX: (geometry.width - imageWidth * zoom) / 2,
		panY: (geometry.height - imageHeight * zoom) / 2
	};
}

function expectViewClose(actual: ViewState, expected: ViewState, tolerance = 1e-6): void {
	expect(Math.abs(actual.zoom - expected.zoom)).toBeLessThanOrEqual(tolerance);
	expect(Math.abs(actual.panX - expected.panX)).toBeLessThanOrEqual(tolerance);
	expect(Math.abs(actual.panY - expected.panY)).toBeLessThanOrEqual(tolerance);
}

function expectImagePointClose(
	actual: { xPx: number; yPx: number },
	expected: { xPx: number; yPx: number },
	tolerance = 1e-6
): void {
	expect(Math.abs(actual.xPx - expected.xPx)).toBeLessThanOrEqual(tolerance);
	expect(Math.abs(actual.yPx - expected.yPx)).toBeLessThanOrEqual(tolerance);
}

/** Pane-local image-space point under a pane-local screen point. */
function imageUnder(screen: { x: number; y: number }, view: ViewState): { xPx: number; yPx: number } {
	return { xPx: (screen.x - view.panX) / view.zoom, yPx: (screen.y - view.panY) / view.zoom };
}

async function expectViewPollClose(
	page: Page,
	role: string,
	expected: ViewState,
	tolerance = 1e-6
): Promise<void> {
	await expect
		.poll(
			() =>
				page.evaluate(
					({ paneRole, zoom, panX, panY, tol }) => {
						const el = document.querySelector<HTMLElement>(
							`[data-testid="pane-scene-${paneRole}"]`
						);
						if (!el) return false;
						const current = {
							zoom: parseFloat(el.dataset.viewZoom ?? ''),
							panX: parseFloat(el.dataset.viewPanX ?? ''),
							panY: parseFloat(el.dataset.viewPanY ?? '')
						};
						return (
							Math.abs(current.zoom - zoom) <= tol &&
							Math.abs(current.panX - panX) <= tol &&
							Math.abs(current.panY - panY) <= tol
						);
					},
					{ paneRole: role, zoom: expected.zoom, panX: expected.panX, panY: expected.panY, tol: tolerance }
				),
			{ timeout: 5000 }
		)
		.toBe(true);
}

test('loads two differently sized fixtures and zooms the source around a known pointer without moving the target', async ({
	page
}) => {
	const consoleErrors = attachErrorListener(page);

	await gotoApp(page);
	await loadBoth(page);
	await expect(page.getByTestId('pane-dimensions-source-overview')).toContainText('2 × 3 px');
	await expect(page.getByTestId('pane-dimensions-target-basemap')).toContainText('5 × 4 px');

	const targetBefore = await viewState(page, TARGET_ROLE);
	const sourceBefore = await viewState(page, SOURCE_ROLE);
	const geometry = await paneGeometry(page, SOURCE_ROLE);
	expectViewClose(sourceBefore, fitFor(geometry, 2, 3));

	// Wheel at pane-local (30, 30): deltaY -400 => zoom factor 2^(400/200) = 4.
	const point = panePoint(geometry, 30, 30);
	await page.mouse.move(point.x, point.y);
	await page.mouse.wheel(0, -400);

	const factor = 4;
	const expectedZoom = sourceBefore.zoom * factor;
	const k = expectedZoom / sourceBefore.zoom;
	const expected: ViewState = {
		zoom: expectedZoom,
		panX: 30 - (30 - sourceBefore.panX) * k,
		panY: 30 - (30 - sourceBefore.panY) * k
	};
	await expectViewPollClose(page, SOURCE_ROLE, expected);

	// Only the source transform changed.
	expect(await viewState(page, TARGET_ROLE)).toEqual(targetBefore);

	// The image-space location under the pointer is unchanged.
	const pointerBefore = imageUnder({ x: 30, y: 30 }, sourceBefore);
	const pointerAfter = imageUnder({ x: 30, y: 30 }, await viewState(page, SOURCE_ROLE));
	expectImagePointClose(pointerAfter, pointerBefore);

	// Zooming back out at the same pointer returns to the original view.
	await page.mouse.wheel(0, 400);
	const backExpected: ViewState = {
		zoom: sourceBefore.zoom,
		panX: 30 - (30 - expected.panX) * 0.25,
		panY: 30 - (30 - expected.panY) * 0.25
	};
	await expectViewPollClose(page, SOURCE_ROLE, backExpected);
	expect(await viewState(page, TARGET_ROLE)).toEqual(targetBefore);
	expect(consoleErrors).toEqual([]);
});

test('pans the source pane with a drag and leaves the target fixed', async ({ page }) => {
	const consoleErrors = attachErrorListener(page);

	await gotoApp(page);
	await loadBoth(page);

	const sourceBefore = await viewState(page, SOURCE_ROLE);
	const targetBefore = await viewState(page, TARGET_ROLE);
	const geometry = await paneGeometry(page, SOURCE_ROLE);

	const start = panePoint(geometry, 100, 100);
	await page.mouse.move(start.x, start.y);
	await page.mouse.down();
	await page.mouse.move(start.x + 40, start.y + 15, { steps: 5 });
	await page.mouse.up();

	const expected: ViewState = {
		zoom: sourceBefore.zoom,
		panX: sourceBefore.panX + 40,
		panY: sourceBefore.panY + 15
	};
	await expectViewPollClose(page, SOURCE_ROLE, expected);
	expect(await viewState(page, TARGET_ROLE)).toEqual(targetBefore);
	expect(consoleErrors).toEqual([]);
});

test('navigates both panes to different independent transforms', async ({ page }) => {
	const consoleErrors = attachErrorListener(page);

	await gotoApp(page);
	await loadBoth(page);

	const sourceFit = await viewState(page, SOURCE_ROLE);
	const targetFit = await viewState(page, TARGET_ROLE);
	const sourceGeometry = await paneGeometry(page, SOURCE_ROLE);
	const targetGeometry = await paneGeometry(page, TARGET_ROLE);

	const sourcePoint = panePoint(sourceGeometry, 25, 40);
	await page.mouse.move(sourcePoint.x, sourcePoint.y);
	await page.mouse.wheel(0, -400);
	await page.mouse.wheel(0, -400);

	const targetPoint = panePoint(targetGeometry, 60, 20);
	await page.mouse.move(targetPoint.x, targetPoint.y);
	await page.mouse.wheel(0, -200);
	await page.mouse.wheel(0, -200);
	await page.mouse.wheel(0, -200);

	const sourceAfter = await viewState(page, SOURCE_ROLE);
	const targetAfter = await viewState(page, TARGET_ROLE);
	expect(sourceAfter.zoom).toBeGreaterThan(sourceFit.zoom);
	expect(targetAfter.zoom).toBeGreaterThan(targetFit.zoom);
	expect(sourceAfter.zoom).not.toBeCloseTo(targetAfter.zoom, 6);
	expect(sourceAfter).not.toEqual(sourceFit);
	expect(targetAfter).not.toEqual(targetFit);
	expect(consoleErrors).toEqual([]);
});

test('Fit and Reset act on one pane without moving the other', async ({ page }) => {
	const consoleErrors = attachErrorListener(page);

	await gotoApp(page);
	await loadBoth(page);

	const sourceGeometry = await paneGeometry(page, SOURCE_ROLE);
	const targetBefore = await viewState(page, TARGET_ROLE);

	// Navigate the source away from fit, then Fit it back.
	const point = panePoint(sourceGeometry, 40, 50);
	await page.mouse.move(point.x, point.y);
	await page.mouse.wheel(0, -400);
	await expect
		.poll(() => viewState(page, SOURCE_ROLE))
		.toMatchObject({})
		.then(() => undefined);
	await page.getByTestId('pane-fit-source-overview').click();
	await expectViewPollClose(page, SOURCE_ROLE, fitFor(await paneGeometry(page, SOURCE_ROLE), 2, 3));
	expect(await viewState(page, TARGET_ROLE)).toEqual(targetBefore);

	// Navigate again, then Reset; the target must not move.
	await page.mouse.move(point.x, point.y);
	await page.mouse.wheel(0, -400);
	await page.mouse.wheel(0, -400);
	await page.getByTestId('pane-reset-source-overview').click();
	await expectViewPollClose(page, SOURCE_ROLE, fitFor(await paneGeometry(page, SOURCE_ROLE), 2, 3));
	expect(await viewState(page, TARGET_ROLE)).toEqual(targetBefore);

	// The target pane can also be Fit without moving the source.
	await page.getByTestId('pane-fit-target-basemap').click();
	const sourceStillFit = await viewState(page, SOURCE_ROLE);
	expectViewClose(sourceStillFit, fitFor(await paneGeometry(page, SOURCE_ROLE), 2, 3));
	expectViewClose(
		await viewState(page, TARGET_ROLE),
		fitFor(await paneGeometry(page, TARGET_ROLE), 5, 4)
	);
	expect(consoleErrors).toEqual([]);
});

test('resize keeps image-space probes anchored and never changes metadata', async ({ page }) => {
	const consoleErrors = attachErrorListener(page);

	await gotoApp(page);
	await loadBoth(page);

	const dimensionsBefore = await page.getByTestId('pane-dimensions-source-overview').textContent();
	const fileNameBefore = await page.getByTestId('pane-filename-source-overview').textContent();

	// Custom view on the source; target remains at default fit.
	const geometry = await paneGeometry(page, SOURCE_ROLE);
	const point = panePoint(geometry, 30, 30);
	await page.mouse.move(point.x, point.y);
	await page.mouse.wheel(0, -400);
	await expect
		.poll(() => viewState(page, SOURCE_ROLE))
		.toMatchObject({})
		.then(() => undefined);
	const sourceCustom = await viewState(page, SOURCE_ROLE);
	const sourceGeometry = await paneGeometry(page, SOURCE_ROLE);
	const probe = imageUnder({ x: sourceGeometry.width / 2, y: sourceGeometry.height / 2 }, sourceCustom);
	const targetFitBefore = await viewState(page, TARGET_ROLE);
	expectViewClose(targetFitBefore, fitFor(await paneGeometry(page, TARGET_ROLE), 5, 4));

	// Shrink the viewport: both pane widths change; the fixed 420px scene height does not.
	await page.setViewportSize({ width: 1000, height: 700 });

	await expect
		.poll(async () => {
			const current = await viewState(page, SOURCE_ROLE);
			const newGeometry = await paneGeometry(page, SOURCE_ROLE);
			const currentProbe = imageUnder(
				{ x: newGeometry.width / 2, y: newGeometry.height / 2 },
				current
			);
			return (
				Math.abs(current.zoom - sourceCustom.zoom) <= 1e-6 &&
				Math.abs(currentProbe.xPx - probe.xPx) <= 1e-6 &&
				Math.abs(currentProbe.yPx - probe.yPx) <= 1e-6
			);
		})
		.toBe(true);

	// At-fit target recomputed its fit for the new pane size.
	await expectViewPollClose(
		page,
		TARGET_ROLE,
		fitFor(await paneGeometry(page, TARGET_ROLE), 5, 4)
	);

	// Durable metadata is untouched by navigation and resize.
	expect(await page.getByTestId('pane-dimensions-source-overview').textContent()).toBe(
		dimensionsBefore
	);
	expect(await page.getByTestId('pane-filename-source-overview').textContent()).toBe(fileNameBefore);
	expect(consoleErrors).toEqual([]);
});

test('wheel over a pane never scrolls the page and is prevented by default', async ({ page }) => {
	const consoleErrors = attachErrorListener(page);

	await gotoApp(page);
	await loadBoth(page);

	const geometry = await paneGeometry(page, SOURCE_ROLE);
	const point = panePoint(geometry, 50, 50);
	await page.mouse.move(point.x, point.y);

	const scrollBefore = await page.evaluate(() => document.scrollingElement?.scrollTop ?? 0);
	await page.mouse.wheel(0, 500);
	await expect
		.poll(() => viewState(page, SOURCE_ROLE))
		.toMatchObject({})
		.then(() => undefined);
	const scrollAfter = await page.evaluate(() => document.scrollingElement?.scrollTop ?? 0);
	expect(scrollAfter).toBe(scrollBefore);

	// The wheel listener must call preventDefault for handled gestures: a synthetic
	// wheel dispatched over the pane returns false (not canceled) only when no
	// listener prevented it.
	const prevented = await page.evaluate(
		({ paneRole }) => {
			const el = document.querySelector<HTMLElement>(`[data-testid="pane-scene-${paneRole}"]`);
			if (!el) throw new Error('missing pane scene');
			const rect = el.getBoundingClientRect();
			const event = new WheelEvent('wheel', {
				deltaY: 300,
				clientX: rect.left + 10,
				clientY: rect.top + 10,
				cancelable: true,
				bubbles: true
			});
			el.dispatchEvent(event);
			return event.defaultPrevented;
		},
		{ paneRole: SOURCE_ROLE }
	);
	expect(prevented).toBe(true);
	expect(consoleErrors).toEqual([]);
});

test('the full interaction set stays console-clean and Add correspondence still has no behavior', async ({
	page
}) => {
	const consoleErrors = attachErrorListener(page);

	await gotoApp(page);
	await loadBoth(page);

	const sourceFit = await viewState(page, SOURCE_ROLE);
	const targetFit = await viewState(page, TARGET_ROLE);

	// Exercise wheel, drag, Fit, and Reset across both panes.
	const geometry = await paneGeometry(page, SOURCE_ROLE);
	const point = panePoint(geometry, 60, 70);
	await page.mouse.move(point.x, point.y);
	await page.mouse.wheel(0, -400);
	await page.mouse.down();
	await page.mouse.move(point.x + 30, point.y + 10, { steps: 4 });
	await page.mouse.up();
	await page.getByTestId('pane-fit-source-overview').click();
	await page.getByTestId('pane-reset-source-overview').click();
	await page.getByTestId('pane-fit-target-basemap').click();
	await expectViewPollClose(page, SOURCE_ROLE, sourceFit);
	await expectViewPollClose(page, TARGET_ROLE, targetFit);

	// Add correspondence is enabled but still has no behavior in Phase 0.
	await page.getByTestId('add-correspondence').click();
	await expect(page.getByTestId('discard-confirmation')).toHaveCount(0);
	await expect(page.getByTestId('pane-status-source-overview')).toHaveText('Image loaded');
	await expect(page.getByTestId('pane-status-target-basemap')).toHaveText('Image loaded');

	expect(consoleErrors).toEqual([]);
});
