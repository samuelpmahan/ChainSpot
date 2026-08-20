import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

const SOURCE_ROLE = 'source-overview';
const TARGET_ROLE = 'target-basemap';

function fixturePath(name: string): string {
	return fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
}

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
			raw[offset] = 40;
			raw[offset + 1] = 180;
			raw[offset + 2] = 90;
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
	await page.getByTestId('pane-input-source-overview').setInputFiles({
		name: 'source-map.png',
		mimeType: 'image/png',
		buffer: pngPayload(20, 20)
	});
	await expect(page.getByTestId('pane-filename-source-overview')).toHaveText('source-map.png');
	await page.getByTestId('pane-input-target-basemap').setInputFiles({
		name: 'target-map.png',
		mimeType: 'image/png',
		buffer: pngPayload(40, 20)
	});
	await expect(page.getByTestId('pane-filename-target-basemap')).toHaveText('target-map.png');
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
 * Clicks a pane-local canvas point. The pane is scrolled into view first so list
 * interactions (which auto-scroll) cannot leave the panes off-screen, then the
 * current geometry is read so the absolute click position is never stale.
 */
async function canvasClick(page: Page, role: string, local: { x: number; y: number }): Promise<void> {
	await page.getByTestId(`pane-scene-${role}`).scrollIntoViewIfNeeded();
	const geometry = await paneGeometry(page, role);
	await page.mouse.click(...Object.values(panePoint(geometry, local.x, local.y)) as [number, number]);
}

async function createPair(
	page: Page,
	sourcePoint: { xPx: number; yPx: number },
	targetPoint: { xPx: number; yPx: number }
): Promise<{ sourceLocal: { x: number; y: number }; targetLocal: { x: number; y: number } }> {
	const sourceView = await viewState(page, SOURCE_ROLE);
	const targetView = await viewState(page, TARGET_ROLE);
	const sourceLocal = imagePoint(sourceView, sourcePoint.xPx, sourcePoint.yPx);
	const targetLocal = imagePoint(targetView, targetPoint.xPx, targetPoint.yPx);
	await page.getByTestId('add-correspondence').click();
	await canvasClick(page, SOURCE_ROLE, sourceLocal);
	await canvasClick(page, TARGET_ROLE, targetLocal);
	await expect(page.getByTestId('app-shell')).toHaveAttribute('data-correspondence-mode', 'neutral');
	return { sourceLocal, targetLocal };
}

async function seedThreePairs(page: Page): Promise<void> {
	await createPair(page, { xPx: 5, yPx: 5 }, { xPx: 10, yPx: 5 });
	await createPair(page, { xPx: 10, yPx: 10 }, { xPx: 20, yPx: 10 });
	await createPair(page, { xPx: 15, yPx: 15 }, { xPx: 30, yPx: 15 });
	await expect(page.getByTestId('app-shell')).toHaveAttribute('data-complete-pair-count', '3');
}

/** A list row by its current presentation ordinal (stable, unlike random pair ids). */
function row(page: Page, ordinal: number): Locator {
	return page.locator(`[data-testid="pair-row"][data-ordinal="${ordinal}"]`);
}

function inRow(row: Locator, testIdPrefix: string): Locator {
	return row.locator(`[data-testid^="${testIdPrefix}-"]`);
}

test('manages labels, reorder, enable, and delete with undo/redo from the pair list', async ({ page }) => {
	const errors = attachErrorListener(page);
	await gotoApp(page);
	await loadBoth(page);
	await seedThreePairs(page);

	// Every pair appears exactly once with derived normalized values for both sizes.
	await expect(page.getByTestId('pair-row')).toHaveCount(3);
	await expect(inRow(row(page, 1), 'pair-ordinal')).toHaveText('1');
	await expect(inRow(row(page, 2), 'pair-ordinal')).toHaveText('2');
	await expect(inRow(row(page, 3), 'pair-ordinal')).toHaveText('3');
	// pair 1 source (5,5)/20x20 -> (0.25, 0.25); target (10,5)/40x20 -> (0.25, 0.25).
	await expect(inRow(row(page, 1), 'pair-source-norm')).toHaveText('(0.25, 0.25)');
	await expect(inRow(row(page, 1), 'pair-target-norm')).toHaveText('(0.25, 0.25)');
	// pair 2 source (10,10)/20x20 -> (0.5, 0.5); target (20,10)/40x20 -> (0.5, 0.5).
	await expect(inRow(row(page, 2), 'pair-source-px')).toHaveText('(10, 10)');
	await expect(inRow(row(page, 2), 'pair-target-px')).toHaveText('(20, 10)');

	// Label add/change/clear commits once per coherent edit and participates in history.
	const labelInput = inRow(row(page, 2), 'pair-label');
	await labelInput.fill('Pond edge');
	await labelInput.blur();
	await expect(page.getByTestId('dirty-indicator')).toContainText('Unsaved changes');
	await expect(labelInput).toHaveValue('Pond edge');

	await page.getByTestId('undo').click();
	await expect(labelInput).toHaveValue('');
	// The project is still dirty because the three pairs were never saved; only the label reverted.
	await expect(page.getByTestId('dirty-indicator')).toContainText('Unsaved changes');
	await page.getByTestId('redo').click();
	await expect(labelInput).toHaveValue('Pond edge');

	// Reorder pair 3 up: the labeled pair moves from row 2 to row 3, ordinals regenerate.
	await inRow(row(page, 3), 'pair-up').click();
	await expect(inRow(row(page, 3), 'pair-label')).toHaveValue('Pond edge');
	await expect(inRow(row(page, 2), 'pair-label')).toHaveValue('');
	await page.getByTestId('undo').click();
	await expect(inRow(row(page, 2), 'pair-label')).toHaveValue('Pond edge');

	// Enable/disable toggles a distinct row state without hiding or deleting the pair.
	await inRow(row(page, 3), 'pair-enabled').uncheck();
	await expect(row(page, 3)).toHaveClass(/disabled-pair/);
	await expect(page.getByTestId('pair-row')).toHaveCount(3);
	await inRow(row(page, 3), 'pair-enabled').check();
	await expect(row(page, 3)).not.toHaveClass(/disabled-pair/);

	// Visible delete removes exactly one pair and undo restores it.
	await inRow(row(page, 1), 'pair-delete').click();
	await expect(page.getByTestId('pair-row')).toHaveCount(2);
	await page.getByTestId('undo').click();
	await expect(page.getByTestId('pair-row')).toHaveCount(3);
	await expect(inRow(row(page, 1), 'pair-ordinal')).toHaveText('1');

	expect(errors).toEqual([]);
});

test('synchronizes list and canvas selection with exact sides and keeps console clean', async ({ page }) => {
	const errors = attachErrorListener(page);
	await gotoApp(page);
	await loadBoth(page);
	const first = await createPair(page, { xPx: 5, yPx: 5 }, { xPx: 10, yPx: 5 });
	await createPair(page, { xPx: 10, yPx: 10 }, { xPx: 20, yPx: 10 });

	// Selecting a canvas marker highlights the same row and side in the list.
	await canvasClick(page, SOURCE_ROLE, first.sourceLocal);
	await expect(page.getByTestId('point-inspector')).toContainText('Pair 1 · Source point');
	await expect(row(page, 1)).toHaveClass(/selected/);
	await expect(row(page, 1).locator('[data-side="source"]')).toHaveClass(/selected/);
	await expect(row(page, 1).locator('[data-side="target"]')).not.toHaveClass(/selected/);

	// Selecting from the list drives the inspector with the exact pair and side.
	await row(page, 2).locator('[data-side="source"]').click();
	await expect(page.getByTestId('point-inspector')).toContainText('Pair 2 · Source point');
	await expect(row(page, 2)).toHaveClass(/selected/);
	await row(page, 2).locator('[data-side="target"]').click();
	await expect(page.getByTestId('point-inspector')).toContainText('Pair 2 · Target point');

	expect(errors).toEqual([]);
});

test('hide/show markers is transient and does not cancel pending creation', async ({ page }) => {
	const errors = attachErrorListener(page);
	await gotoApp(page);
	await loadBoth(page);
	await seedThreePairs(page);

	await row(page, 1).locator('[data-side="source"]').click();
	await expect(page.getByTestId('point-inspector')).toBeVisible();

	// Hiding is rendering-only: pair count, dirty state, and selection stay unchanged.
	await page.getByTestId('toggle-markers').click();
	await expect(page.getByTestId('toggle-markers')).toHaveAttribute('aria-pressed', 'false');
	await expect(page.getByTestId('app-shell')).toHaveAttribute('data-complete-pair-count', '3');
	await expect(page.getByTestId('dirty-indicator')).toContainText('Unsaved changes');
	await expect(page.getByTestId('point-inspector')).toBeVisible();
	await expect(row(page, 1)).toHaveClass(/selected/);

	// Start a pending correspondence, hide again, and complete it while hidden.
	await page.getByTestId('toggle-markers').click();
	await page.getByTestId('add-correspondence').click();
	const sourceView = await viewState(page, SOURCE_ROLE);
	await canvasClick(page, SOURCE_ROLE, imagePoint(sourceView, 8, 8));
	await expect(page.getByTestId('app-shell')).toHaveAttribute('data-correspondence-mode', 'add-target');

	await page.getByTestId('toggle-markers').click();
	await expect(page.getByTestId('app-shell')).toHaveAttribute('data-correspondence-mode', 'add-target');

	const targetView = await viewState(page, TARGET_ROLE);
	await canvasClick(page, TARGET_ROLE, imagePoint(targetView, 16, 8));
	await expect(page.getByTestId('app-shell')).toHaveAttribute('data-complete-pair-count', '4');

	expect(errors).toEqual([]);
});

test('undo/redo and delete shortcuts work and are suppressed inside editable fields', async ({ page }) => {
	const errors = attachErrorListener(page);
	await gotoApp(page);
	await loadBoth(page);
	await seedThreePairs(page);

	const labelInput = inRow(row(page, 2), 'pair-label');
	await labelInput.fill('Pond edge');
	await labelInput.blur();
	await expect(labelInput).toHaveValue('Pond edge');

	// Ctrl+Z undoes, Ctrl+Shift+Z redoes, Ctrl+Y redoes.
	await page.keyboard.press('Control+z');
	await expect(labelInput).toHaveValue('');
	await page.keyboard.press('Control+Shift+z');
	await expect(labelInput).toHaveValue('Pond edge');
	await page.keyboard.press('Control+z');
	await expect(labelInput).toHaveValue('');
	await page.keyboard.press('Control+y');
	await expect(labelInput).toHaveValue('Pond edge');

	// Delete/Backspace delete the selected pair only when safe.
	await row(page, 1).locator('[data-side="source"]').click();
	await page.keyboard.press('Delete');
	await expect(page.getByTestId('pair-row')).toHaveCount(2);
	await page.getByTestId('undo').click();
	await expect(page.getByTestId('pair-row')).toHaveCount(3);

	await row(page, 1).locator('[data-side="source"]').click();
	await page.keyboard.press('Backspace');
	await expect(page.getByTestId('pair-row')).toHaveCount(2);
	await page.getByTestId('undo').click();
	await expect(page.getByTestId('pair-row')).toHaveCount(3);

	// Shortcuts are suppressed inside the project name and label fields.
	const nameInput = page.getByTestId('project-name');
	await nameInput.click();
	await page.keyboard.press('Control+z');
	await expect(page.getByTestId('pair-row')).toHaveCount(3);

	await inRow(row(page, 1), 'pair-label').click();
	await page.keyboard.press('Delete');
	await expect(page.getByTestId('pair-row')).toHaveCount(3);

	expect(errors).toEqual([]);
});
