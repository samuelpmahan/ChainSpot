import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

const SOURCE_ROLE = 'source-overview';
const TARGET_ROLE = 'target-basemap';

const fixturePath = (name: string): string => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));

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

test('a keyboard user can create and cancel a correspondence using visible controls', async ({ page }) => {
	const errors = attachErrorListener(page);
	await gotoApp(page);
	await loadBothLarge(page);

	// Activate creation with the keyboard (focus + Enter), exactly like a pointer click.
	const addButton = page.getByTestId('add-correspondence');
	await addButton.focus();
	await page.keyboard.press('Enter');
	await expect(page.getByTestId('app-shell')).toHaveAttribute('data-correspondence-mode', 'add-source');
	await expect(page.getByTestId('correspondence-guidance')).toHaveText(
		'Click a landmark in the UDisc source image.'
	);

	// Escape cancels the pending half-pair without history.
	await page.keyboard.press('Escape');
	await expect(page.getByTestId('app-shell')).toHaveAttribute('data-correspondence-mode', 'neutral');
	await expect(page.getByTestId('app-shell')).toHaveAttribute('data-pending-pair-count', '0');

	// The visible Cancel button is keyboard-operable too.
	await addButton.focus();
	await page.keyboard.press('Enter');
	await expect(page.getByTestId('cancel-correspondence')).toBeVisible();
	await page.getByTestId('cancel-correspondence').focus();
	await page.keyboard.press('Enter');
	await expect(page.getByTestId('app-shell')).toHaveAttribute('data-correspondence-mode', 'neutral');

	expect(errors).toEqual([]);
});

test('nudge and undo/redo shortcuts are suppressed inside editable fields', async ({ page }) => {
	const errors = attachErrorListener(page);
	await gotoApp(page);
	await loadBothLarge(page);
	await createPair(page, { xPx: 10, yPx: 8 }, { xPx: 10, yPx: 8 });

	// Arrow nudge on the selected source point.
	await row(page, 1).locator('[data-side="source"]').click();
	await expect(page.getByTestId('point-x')).toHaveValue('10');
	await page.keyboard.press('ArrowRight');
	await expect(page.getByTestId('point-x')).toHaveValue('11');
	await page.keyboard.press('Shift+ArrowDown');
	await expect(page.getByTestId('point-y')).toHaveValue('18');

	// Arrow keys inside the numeric inspector must edit the field, not nudge the marker.
	await page.getByTestId('point-x').focus();
	await page.keyboard.press('ArrowRight');
	await expect(page.getByTestId('point-x')).toHaveValue('11');
	await expect(inRow(row(page, 1), 'pair-source-px')).toHaveText('(11, 18)');

	// Delete/Backspace inside a field must not delete the pair.
	await inRow(row(page, 1), 'pair-label').fill('Keep');
	await inRow(row(page, 1), 'pair-label').focus();
	await page.keyboard.press('Delete');
	await expect(page.getByTestId('app-shell')).toHaveAttribute('data-complete-pair-count', '1');

	// Ctrl+Z inside the project-name field must not undo the pair.
	await page.getByTestId('project-name').focus();
	await page.keyboard.press('Control+z');
	await expect(page.getByTestId('app-shell')).toHaveAttribute('data-complete-pair-count', '1');

	expect(errors).toEqual([]);
});

test('focus moves into a confirmation dialog and returns to the pane trigger on cancel', async ({
	page
}) => {
	const errors = attachErrorListener(page);
	await gotoApp(page);
	await loadBothLarge(page);
	await createPair(page, { xPx: 5, yPx: 5 }, { xPx: 10, yPx: 5 });

	const sourceChoose = page.getByTestId(`pane-choose-${SOURCE_ROLE}`);
	await sourceChoose.focus();
	await page.getByTestId(`pane-input-${SOURCE_ROLE}`).setInputFiles({
		name: 'wide-source.png',
		mimeType: 'image/png',
		buffer: pngPayload(40, 40)
	});

	// The modal receives focus and traps it; Escape cancels and returns to the trigger.
	await expect(page.getByTestId('discard-confirmation')).toBeVisible();
	await expect(page.getByTestId('discard-confirm-cancel')).toBeFocused();
	await page.keyboard.press('Escape');
	await expect(page.getByTestId('discard-confirmation')).toBeHidden();
	await expect(sourceChoose).toBeFocused();

	expect(errors).toEqual([]);
});

test('focus returns to the list after delete and to Open project after a failed import', async ({
	page
}) => {
	const errors = attachErrorListener(page);
	await gotoApp(page);
	await loadBoth(page);
	await createPair(page, { xPx: 1, yPx: 1 }, { xPx: 2, yPx: 2 });

	// Deleting the only pair leaves focus on a stable control that can undo it.
	await inRow(row(page, 1), 'pair-delete').click();
	await expect(page.getByTestId('app-shell')).toHaveAttribute('data-complete-pair-count', '0');
	await expect(page.getByTestId('undo')).toBeFocused();

	// A failed open returns focus to the Open project control.
	await page.getByTestId('open-project').focus();
	await page.getByTestId('open-project-input').setInputFiles({
		name: 'broken.chainspot.zip',
		mimeType: 'application/zip',
		buffer: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x02])
	});
	await expect(page.getByTestId('open-error')).toBeVisible();
	await expect(page.getByTestId('open-project')).toBeFocused();

	expect(errors).toEqual([]);
});

test('the hidden file inputs never take keyboard focus and are not announced twice', async ({
	page
}) => {
	await gotoApp(page);

	// Tab order starts from the page header and skips the visually hidden file inputs.
	const firstTab = await page.evaluate(() => {
		document.querySelector<HTMLElement>('[data-testid="project-name"]')?.focus();
		return document.activeElement?.getAttribute('data-testid');
	});
	expect(firstTab).toBe('project-name');

	const focused = await page.evaluate(() => {
		const active = document.activeElement as HTMLElement | null;
		return active?.getAttribute('tabindex');
	});
	expect(focused).not.toBe('0');
});
