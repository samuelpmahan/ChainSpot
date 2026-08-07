import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
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

async function loadBothLarge(page: Page): Promise<void> {
	const payload = pngPayload(20, 20);
	await page.getByTestId('pane-input-source-overview').setInputFiles({
		name: 'large-source.png',
		mimeType: 'image/png',
		buffer: payload
	});
	await expect(page.getByTestId('pane-filename-source-overview')).toHaveText('large-source.png');
	await page.getByTestId('pane-input-target-basemap').setInputFiles({
		name: 'large-target.png',
		mimeType: 'image/png',
		buffer: payload
	});
	await expect(page.getByTestId('pane-filename-target-basemap')).toHaveText('large-target.png');
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
			raw[offset] = 60;
			raw[offset + 1] = 120;
			raw[offset + 2] = 200;
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

function row(page: Page, ordinal: number): Locator {
	return page.locator(`[data-testid="pair-row"][data-ordinal="${ordinal}"]`);
}

function inRow(row: Locator, testIdPrefix: string): Locator {
	return row.locator(`[data-testid^="${testIdPrefix}-"]`);
}

test('a full keyboard flow creates/cancels, nudges, manages, undoes/redoes, and suppresses in fields', async ({
	page
}) => {
	const errors = attachErrorListener(page);
	await gotoApp(page);
	await loadBothLarge(page);

	// Creation is initiated from the visible Add control; Escape cancels it.
	await page.getByTestId('add-correspondence').focus();
	await page.keyboard.press('Enter');
	await expect(page.getByTestId('app-shell')).toHaveAttribute('data-correspondence-mode', 'add-source');
	await page.keyboard.press('Escape');
	await expect(page.getByTestId('app-shell')).toHaveAttribute('data-correspondence-mode', 'neutral');
	await expect(page.getByTestId('activity-message')).toContainText('cancelled');

	// Build two pairs, then drive every management action with the keyboard.
	await createPair(page, { xPx: 10, yPx: 8 }, { xPx: 10, yPx: 8 });
	await createPair(page, { xPx: 12, yPx: 12 }, { xPx: 12, yPx: 12 });

	// Select pair 1 source from the list and nudge with arrow keys (1px and Shift 10px).
	const sourceButton = row(page, 1).locator('[data-side="source"]');
	await sourceButton.focus();
	await sourceButton.press('Enter');
	await expect(page.getByTestId('point-inspector')).toContainText('Pair 1 · Source point');
	await page.keyboard.press('ArrowRight');
	await expect(page.getByTestId('point-x')).toHaveValue('11');
	await page.keyboard.press('Shift+ArrowDown');
	await expect(page.getByTestId('point-y')).toHaveValue('18');

	// Undo/redo through the keyboard revert and restore the last nudge.
	await page.keyboard.press('Control+z');
	await expect(page.getByTestId('point-y')).toHaveValue('8');
	await page.keyboard.press('Control+Shift+z');
	await expect(page.getByTestId('point-y')).toHaveValue('18');

	// Reorder pair 2 up through its visible control.
	await inRow(row(page, 2), 'pair-up').focus();
	await page.keyboard.press('Enter');
	await expect(inRow(row(page, 1), 'pair-up')).toBeDisabled();
	await page.keyboard.press('Control+z');
	await expect(inRow(row(page, 2), 'pair-up')).toBeEnabled();

	// Toggle disable with the keyboard (Space on the checkbox).
	const enabledToggle = inRow(row(page, 2), 'pair-enabled');
	await enabledToggle.focus();
	await enabledToggle.press('Space');
	await expect(row(page, 2)).toHaveClass(/disabled-pair/);

	// Delete pair 2 through its visible control; focus returns to Undo.
	const deleteButton = inRow(row(page, 2), 'pair-delete');
	await deleteButton.focus();
	await deleteButton.press('Enter');
	await expect(page.getByTestId('pair-row')).toHaveCount(1);
	await expect(page.getByTestId('undo')).toBeFocused();
	await page.keyboard.press('Control+z');
	await expect(page.getByTestId('pair-row')).toHaveCount(2);

	// Shortcuts are suppressed inside editable fields.
	const nameInput = page.getByTestId('project-name');
	await nameInput.focus();
	await page.keyboard.press('Control+z');
	await expect(page.getByTestId('pair-row')).toHaveCount(2);
	const labelInput = inRow(row(page, 1), 'pair-label');
	await labelInput.focus();
	await page.keyboard.press('Delete');
	await expect(page.getByTestId('pair-row')).toHaveCount(2);

	expect(errors).toEqual([]);
});

test('successful open returns focus to the Open project control', async ({ page }) => {
	const errors = attachErrorListener(page);
	await gotoApp(page);
	await loadBoth(page);
	await createPair(page, { xPx: 1, yPx: 1 }, { xPx: 2, yPx: 2 });

	// Save a valid bundle, reload, then open it with keyboard focus on Open project.
	const downloadPromise = page.waitForEvent('download');
	await page.getByTestId('save-project').click();
	const download = await downloadPromise;
	const stream = await download.createReadStream();
	const chunks: Buffer[] = [];
	for await (const chunk of stream) chunks.push(chunk);
	const zipBuffer = Buffer.concat(chunks);

	await gotoApp(page);
	const openButton = page.getByTestId('open-project');
	await openButton.focus();
	await page.getByTestId('open-project-input').setInputFiles({
		name: 'round.chainspot.zip',
		mimeType: 'application/zip',
		buffer: zipBuffer
	});

	await expect(page.getByTestId('app-shell')).toHaveAttribute('data-complete-pair-count', '1');
	await expect(page.getByTestId('dirty-indicator')).toBeHidden();
	await expect(page.getByTestId('activity-message')).toContainText('Opened project');
	await expect(openButton).toBeFocused();
	expect(errors).toEqual([]);
});

test('toolbar buttons display shortcut labels and aria-keyshortcuts attributes', async ({ page }) => {
	await gotoApp(page);

	await expect(page.getByTestId('add-correspondence')).toHaveAttribute('aria-keyshortcuts', 'A');
	await expect(page.getByTestId('undo')).toHaveAttribute('aria-keyshortcuts', 'Control+Z Meta+Z');
	await expect(page.getByTestId('redo')).toHaveAttribute('aria-keyshortcuts', 'Control+Shift+Z Meta+Shift+Z Control+Y');
	await expect(page.getByTestId('toggle-markers')).toHaveAttribute('aria-keyshortcuts', 'M');
	await expect(page.getByTestId('save-project')).toHaveAttribute('aria-keyshortcuts', 'Control+S Meta+S');
	await expect(page.getByTestId('open-project')).toHaveAttribute('aria-keyshortcuts', 'Control+O Meta+O');

	await expect(page.getByTestId('add-correspondence')).toContainText('(A)');
	await expect(page.getByTestId('save-project')).toContainText('(⌘/Ctrl+S)');
	await expect(page.getByTestId('open-project')).toContainText('(⌘/Ctrl+O)');
});

test('A, M, and Escape perform expected actions when active and are ignored inside text input', async ({ page }) => {
	await gotoApp(page);
	await loadBoth(page);

	// A activates correspondence mode when neutral and images loaded
	await page.keyboard.press('a');
	await expect(page.getByTestId('app-shell')).toHaveAttribute('data-correspondence-mode', 'add-source');
	await expect(page.getByTestId('cancel-correspondence')).toHaveAttribute('aria-keyshortcuts', 'Escape');

	// Escape cancels pending correspondence
	await page.keyboard.press('Escape');
	await expect(page.getByTestId('app-shell')).toHaveAttribute('data-correspondence-mode', 'neutral');

	// M toggles marker visibility
	await expect(page.getByTestId('toggle-markers')).toHaveAttribute('aria-pressed', 'true');
	await page.keyboard.press('m');
	await expect(page.getByTestId('toggle-markers')).toHaveAttribute('aria-pressed', 'false');
	await page.keyboard.press('m');
	await expect(page.getByTestId('toggle-markers')).toHaveAttribute('aria-pressed', 'true');

	// Shortcuts are ignored while typing inside project-name input
	const nameInput = page.getByTestId('project-name');
	await nameInput.focus();
	await page.keyboard.press('a');
	await expect(page.getByTestId('app-shell')).toHaveAttribute('data-correspondence-mode', 'neutral');
	await page.keyboard.press('m');
	await expect(page.getByTestId('toggle-markers')).toHaveAttribute('aria-pressed', 'true');

	// Escape inside text input does not cancel correspondence mode
	await nameInput.blur();
	await page.keyboard.press('a');
	await expect(page.getByTestId('app-shell')).toHaveAttribute('data-correspondence-mode', 'add-source');
	await nameInput.focus();
	await page.keyboard.press('Escape');
	await expect(page.getByTestId('app-shell')).toHaveAttribute('data-correspondence-mode', 'add-source');
});

test('Cmd/Ctrl+S and Cmd/Ctrl+O trigger save and open file chooser without browser defaults', async ({ page }) => {
	await gotoApp(page);
	await loadBoth(page);

	// Ctrl/Cmd+S triggers project save download
	const downloadPromise = page.waitForEvent('download');
	await page.keyboard.press('ControlOrMeta+s');
	const download = await downloadPromise;
	expect(download.suggestedFilename()).toContain('.chainspot.zip');

	// Ctrl/Cmd+O triggers file input click
	let inputClicked = false;
	await page.evaluate(() => {
		const input = document.querySelector<HTMLInputElement>('[data-testid="open-project-input"]');
		if (input) input.addEventListener('click', () => { (window as unknown as Record<string, boolean>).__openClicked = true; });
	});
	await page.keyboard.press('ControlOrMeta+o');
	inputClicked = await page.evaluate(() => (window as unknown as Record<string, boolean>).__openClicked === true);
	expect(inputClicked).toBe(true);
});
