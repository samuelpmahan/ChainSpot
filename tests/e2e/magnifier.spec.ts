import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const SOURCE_ROLE = 'source-overview';
const TARGET_ROLE = 'target-basemap';

function fixturePath(name: string): string {
	return fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
}

interface PaneGeometry {
	left: number;
	top: number;
	clientLeft: number;
	clientTop: number;
	width: number;
	height: number;
}

interface ViewState {
	zoom: number;
	panX: number;
	panY: number;
}

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
	await page.getByTestId('pane-input-target-basemap').setInputFiles(fixturePath('tiny.jpg'));
	await expect(page.getByTestId('add-correspondence')).toBeEnabled();
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

function panePoint(geometry: PaneGeometry, x: number, y: number): { x: number; y: number } {
	return {
		x: geometry.left + geometry.clientLeft + x,
		y: geometry.top + geometry.clientTop + y
	};
}

function imagePoint(view: ViewState, xPx: number, yPx: number): { x: number; y: number } {
	return { x: xPx * view.zoom + view.panX, y: yPx * view.zoom + view.panY };
}

/**
 * Summarizes the magnifier canvas pixels. The tiny.png fixture is solid red, so the
 * preview must be dominated by the ORIGINAL decoded red pixels with the exact
 * crosshair passes visible over them.
 */
async function magnifierPixels(page: Page, role: string): Promise<{
	red: number;
	white: number;
	total: number;
	anchorX: string;
	anchorY: string;
}> {
	return page.evaluate((paneRole) => {
		const canvas = document.querySelector<HTMLCanvasElement>(`[data-testid="pane-magnifier-${paneRole}"]`);
		if (!canvas) throw new Error(`missing magnifier for ${paneRole}`);
		const context = canvas.getContext('2d');
		if (!context) return { red: -1, white: -1, total: -1, anchorX: '', anchorY: '' };
		const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
		let red = 0;
		let white = 0;
		for (let i = 0; i < data.length; i += 4) {
			const r = data[i];
			const g = data[i + 1];
			const b = data[i + 2];
			if (r > 200 && g < 100 && b < 100) red += 1;
			if (r > 220 && g > 220 && b > 220) white += 1;
		}
		return {
			red,
			white,
			total: data.length / 4,
			anchorX: canvas.dataset.magnifierAnchorX ?? '',
			anchorY: canvas.dataset.magnifierAnchorY ?? ''
		};
	}, role);
}

test('the magnifier samples original decoded pixels with an exact anchor crosshair at low and high zoom', async ({
	page
}) => {
	const errors = attachErrorListener(page);
	await gotoApp(page);
	await loadBoth(page);

	const sourceGeometry = await paneGeometry(page, SOURCE_ROLE);
	const sourceView = await viewState(page, SOURCE_ROLE);

	// Enter placement mode: the magnifier follows the pointer.
	await page.getByTestId('add-correspondence').click();
	const center = panePoint(sourceGeometry, sourceGeometry.width / 2, sourceGeometry.height / 2);
	await page.mouse.move(center.x, center.y);
	await expect(page.getByTestId('pane-magnifier-source-overview')).toBeVisible();

	const atFit = await magnifierPixels(page, SOURCE_ROLE);
	// The preview must be dominated by the decoded original's solid red pixels.
	expect(atFit.red / atFit.total).toBeGreaterThan(0.5);
	// The exact crosshair passes are visible over the fixture.
	expect(atFit.white).toBeGreaterThan(40);
	// The anchor is the pointer's original-image coordinate (image fills the pane at fit).
	const pointerImage = {
		xPx: (center.x - sourceGeometry.left - sourceGeometry.clientLeft - sourceView.panX) / sourceView.zoom,
		yPx: (center.y - sourceGeometry.top - sourceGeometry.clientTop - sourceView.panY) / sourceView.zoom
	};
	expect(Number(atFit.anchorX)).toBeCloseTo(pointerImage.xPx, 0);
	expect(Number(atFit.anchorY)).toBeCloseTo(pointerImage.yPx, 0);

	// Zoom in (higher view scale): the magnifier stays readable and keeps sampling.
	const zoomCenter = panePoint(sourceGeometry, sourceGeometry.width / 2, sourceGeometry.height / 2);
	await page.mouse.move(zoomCenter.x, zoomCenter.y);
	await page.mouse.wheel(0, -200);
	await page.mouse.move(zoomCenter.x + 20, zoomCenter.y + 10);
	await expect(page.getByTestId('pane-magnifier-source-overview')).toBeVisible();
	const zoomedView = await viewState(page, SOURCE_ROLE);
	expect(zoomedView.zoom).toBeGreaterThan(sourceView.zoom);
	const atHighZoom = await magnifierPixels(page, SOURCE_ROLE);
	expect(atHighZoom.red / atHighZoom.total).toBeGreaterThan(0.5);
	expect(atHighZoom.white).toBeGreaterThan(40);

	expect(errors).toEqual([]);
});

test('the magnifier anchor crosshair stays readable over dark fixture imagery', async ({ page }) => {
	const errors = attachErrorListener(page);
	await gotoApp(page);
	await loadBoth(page);

	const targetGeometry = await paneGeometry(page, TARGET_ROLE);
	await page.getByTestId('add-correspondence').click();
	const center = panePoint(targetGeometry, targetGeometry.width / 2, targetGeometry.height / 2);
	await page.mouse.move(center.x, center.y);
	await expect(page.getByTestId('pane-magnifier-target-basemap')).toBeVisible();

	const pixels = await magnifierPixels(page, TARGET_ROLE);
	// tiny.jpg is solid black: the preview samples original dark pixels and the
	// light crosshair pass must remain clearly visible over them.
	expect(pixels.total).toBeGreaterThan(0);
	expect(pixels.white).toBeGreaterThan(40);

	expect(errors).toEqual([]);
});

test('the magnifier anchors on a selected stored marker in correction mode', async ({ page }) => {
	const errors = attachErrorListener(page);
	await gotoApp(page);
	await loadBoth(page);

	const sourceGeometry = await paneGeometry(page, SOURCE_ROLE);
	const targetGeometry = await paneGeometry(page, TARGET_ROLE);
	const sourceView = await viewState(page, SOURCE_ROLE);
	const targetView = await viewState(page, TARGET_ROLE);

	// Create one pair on both fixtures.
	await page.getByTestId('add-correspondence').click();
	const sourceLocal = imagePoint(sourceView, 1, 1);
	const targetLocal = imagePoint(targetView, 2, 2);
	await page.mouse.click(...Object.values(panePoint(sourceGeometry, sourceLocal.x, sourceLocal.y)) as [number, number]);
	await page.mouse.click(...Object.values(panePoint(targetGeometry, targetLocal.x, targetLocal.y)) as [number, number]);
	await expect(page.getByTestId('app-shell')).toHaveAttribute('data-complete-pair-count', '1');

	// Select the stored source marker: the magnifier anchors exactly on it.
	await page.mouse.click(...Object.values(panePoint(sourceGeometry, sourceLocal.x, sourceLocal.y)) as [number, number]);
	await expect(page.getByTestId('point-inspector')).toContainText('Pair 1 · Source point');
	await expect(page.getByTestId('pane-magnifier-source-overview')).toBeVisible();
	const pixels = await magnifierPixels(page, SOURCE_ROLE);
	// Anchor is the exact stored/original image coordinate of the marker.
	expect(Number(pixels.anchorX)).toBeCloseTo(1, 3);
	expect(Number(pixels.anchorY)).toBeCloseTo(1, 3);
	expect(pixels.red / pixels.total).toBeGreaterThan(0.5);

	expect(errors).toEqual([]);
});
