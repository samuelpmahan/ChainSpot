import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * Browser coverage for the Create Graphics "Alignment" panel — the UI wiring
 * around `src/lib/alignment`, which already has its own extensive unit
 * coverage (`tests/unit/alignment.test.ts`) for the math itself. What's new
 * and untested here is the reactive wiring: insufficient-pairs failures per
 * model, switching models recomputing live, and a real residual appearing
 * once a model is overdetermined by the enabled pairs.
 */

const SOURCE_ROLE = 'source-overview';
const TARGET_ROLE = 'target-basemap';

function crc32(bytes: Uint8Array): number {
	let crc = 0xffffffff;
	for (const byte of bytes) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit += 1) {
			crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
		}
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function pngPayload(width: number, height: number): Buffer {
	const rowSize = width * 3 + 1;
	const raw = Buffer.alloc(rowSize * height);
	for (let y = 0; y < height; y += 1) {
		raw[y * rowSize] = 0;
		for (let x = 0; x < width; x += 1) {
			const offset = y * rowSize + 1 + x * 3;
			raw[offset] = 220;
			raw[offset + 1] = 40;
			raw[offset + 2] = 40;
		}
	}
	const chunk = (type: string, data: Buffer): Buffer => {
		const typeBytes = Buffer.from(type, 'ascii');
		const body = Buffer.concat([typeBytes, data]);
		const result = Buffer.alloc(12 + data.length);
		result.writeUInt32BE(data.length, 0);
		body.copy(result, 4);
		result.writeUInt32BE(crc32(body), 8 + data.length);
		return result;
	};
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header[8] = 8;
	header[9] = 2;
	return Buffer.concat([
		Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
		chunk('IHDR', header),
		chunk('IDAT', deflateSync(raw)),
		chunk('IEND', Buffer.alloc(0))
	]);
}

function fixturePath(name: string): string {
	return fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
}

interface PaneGeometry {
	left: number;
	top: number;
	clientLeft: number;
	clientTop: number;
}

interface ViewState {
	zoom: number;
	panX: number;
	panY: number;
}

async function gotoApp(page: Page): Promise<void> {
	await page.goto('/create-graphics');
	await page.waitForFunction(() => document.documentElement.dataset.appReady === 'true');
}

async function paneGeometry(page: Page, role: string): Promise<PaneGeometry> {
	return page.evaluate((paneRole) => {
		const element = document.querySelector<HTMLElement>(`[data-testid="pane-scene-${paneRole}"]`);
		if (!element) throw new Error(`missing pane ${paneRole}`);
		const rect = element.getBoundingClientRect();
		return { left: rect.left, top: rect.top, clientLeft: element.clientLeft, clientTop: element.clientTop };
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
	return { x: geometry.left + geometry.clientLeft + x, y: geometry.top + geometry.clientTop + y };
}

function imagePoint(view: ViewState, xPx: number, yPx: number): { x: number; y: number } {
	return { x: xPx * view.zoom + view.panX, y: yPx * view.zoom + view.panY };
}

/** Same createPair shape as correspondence.spec.ts, plus a scroll-into-view guard: the source pane can end up above the fold once the page grows (more pairs, the alignment panel's own content), and a click at a scrolled-out-of-view coordinate silently lands nowhere. */
async function createPair(
	page: Page,
	sourcePoint: { xPx: number; yPx: number },
	targetPoint: { xPx: number; yPx: number }
): Promise<void> {
	await page.getByTestId(`pane-scene-${SOURCE_ROLE}`).scrollIntoViewIfNeeded();
	const sourceGeometry = await paneGeometry(page, SOURCE_ROLE);
	const targetGeometry = await paneGeometry(page, TARGET_ROLE);
	const sourceView = await viewState(page, SOURCE_ROLE);
	const targetView = await viewState(page, TARGET_ROLE);
	const sourceLocal = imagePoint(sourceView, sourcePoint.xPx, sourcePoint.yPx);
	const targetLocal = imagePoint(targetView, targetPoint.xPx, targetPoint.yPx);
	await page.getByTestId('add-correspondence').click();
	const sourceScreen = panePoint(sourceGeometry, sourceLocal.x, sourceLocal.y);
	const targetScreen = panePoint(targetGeometry, targetLocal.x, targetLocal.y);
	await page.mouse.click(sourceScreen.x, sourceScreen.y);
	await expect(page.getByTestId('app-shell')).toHaveAttribute('data-correspondence-mode', 'add-target');
	await page.mouse.click(targetScreen.x, targetScreen.y);
	await expect(page.getByTestId('app-shell')).toHaveAttribute('data-correspondence-mode', 'neutral');
}

test('alignment panel: insufficient-pairs failures per model, live recompute on model switch, and a real residual once overdetermined', async ({
	page
}) => {
	await gotoApp(page);
	await page.getByTestId('pane-input-source-overview').setInputFiles(fixturePath('tiny.png'));
	await page.getByTestId('pane-input-target-basemap').setInputFiles({
		name: 'target.png',
		mimeType: 'image/png',
		buffer: pngPayload(500, 400)
	});

	await expect(page.getByTestId('alignment-empty')).toBeVisible();

	// One pair: similarity (the default model) needs two.
	await createPair(page, { xPx: 1, yPx: 1 }, { xPx: 60, yPx: 60 });
	await expect(page.getByTestId('alignment-failure')).toHaveText('Not enough enabled, complete pairs yet.');

	// Two pairs exactly determine a similarity transform: zero residual.
	await createPair(page, { xPx: 1, yPx: 2 }, { xPx: 400, yPx: 300 });
	await expect(page.getByTestId('alignment-summary')).toContainText('similarity transform from 2 pairs');
	await expect(page.getByTestId('alignment-summary')).toContainText('mean residual 0.00px');

	// Switching to affine with only two pairs fails (affine needs three).
	await page.getByTestId('alignment-model-affine').check();
	await expect(page.getByTestId('alignment-failure')).toHaveText('Not enough enabled, complete pairs yet.');

	// A third, non-collinear pair makes affine exactly determined too.
	await createPair(page, { xPx: 0, yPx: 2 }, { xPx: 60, yPx: 350 });
	await expect(page.getByTestId('alignment-summary')).toContainText('affine transform from 3 pairs');
	await expect(page.getByTestId('alignment-summary')).toContainText('mean residual 0.00px');

	// Switching back to similarity with three pairs is now overdetermined
	// (4 degrees of freedom fitting 3 points) — a real, nonzero residual.
	await page.getByTestId('alignment-model-similarity').check();
	await expect(page.getByTestId('alignment-summary')).toContainText('similarity transform from 3 pairs');
	const summaryText = await page.getByTestId('alignment-summary').textContent();
	const meanResidualMatch = summaryText?.match(/mean residual ([\d.]+)px/);
	expect(meanResidualMatch).not.toBeNull();
	expect(Number(meanResidualMatch![1])).toBeGreaterThan(0);
});
