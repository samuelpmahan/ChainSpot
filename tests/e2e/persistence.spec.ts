import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { strFromU8, unzipSync } from 'fflate';
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

const SOURCE_ROLE = 'source-overview';
const TARGET_ROLE = 'target-basemap';

function fixturePath(name: string): string {
	return fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
}

function fixtureBuffer(name: string): Buffer {
	return readFileSync(fixturePath(name));
}

function sha256(buffer: Buffer): string {
	return createHash('sha256').update(buffer).digest('hex');
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
	await page.goto('/');
	await page.waitForFunction(() => document.documentElement.dataset.appReady === 'true');
}

interface ViewState {
	zoom: number;
	panX: number;
	panY: number;
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

interface PaneGeometry {
	left: number;
	top: number;
	clientLeft: number;
	clientTop: number;
	width: number;
	height: number;
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

async function loadBoth(page: Page): Promise<void> {
	await page.getByTestId('pane-input-source-overview').setInputFiles(fixturePath('tiny.png'));
	await expect(page.getByTestId('pane-filename-source-overview')).toHaveText('tiny.png');
	await page.getByTestId('pane-input-target-basemap').setInputFiles(fixturePath('tiny.jpg'));
	await expect(page.getByTestId('pane-filename-target-basemap')).toHaveText('tiny.jpg');
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

function row(page: Page, ordinal: number) {
	return page.locator(`[data-testid="pair-row"][data-ordinal="${ordinal}"]`);
}

function inRow(row: Locator, testIdPrefix: string) {
	return row.locator(`[data-testid^="${testIdPrefix}-"]`);
}

test('saves a portable bundle, reloads, and reopens it with exact restoration and no network', async ({
	page
}) => {
	const errors = attachErrorListener(page);
	const networkRequests: string[] = [];
	page.on('request', (request) => {
		if (request.url().startsWith('blob:') || request.url().startsWith('data:')) return;
		networkRequests.push(request.url());
	});

	await gotoApp(page);
	await page.waitForLoadState('networkidle');
	const baselineRequests = networkRequests.length;

	await loadBoth(page);
	await createPair(page, { xPx: 1, yPx: 1 }, { xPx: 1, yPx: 1 });
	await createPair(page, { xPx: 0, yPx: 2 }, { xPx: 4, yPx: 3 });
	await createPair(page, { xPx: 1, yPx: 0 }, { xPx: 2, yPx: 1 });
	await expect(page.getByTestId('app-shell')).toHaveAttribute('data-complete-pair-count', '3');

	await page.getByTestId('project-name').fill('Sample Round');
	await page.getByTestId('project-name').blur();
	await expect(page.getByTestId('dirty-indicator')).toContainText('Unsaved changes');

	const downloadPromise = page.waitForEvent('download');
	await page.getByTestId('save-project').click();
	const download = await downloadPromise;
	expect(download.suggestedFilename()).toBe('Sample Round.chainspot.zip');
	await expect(page.getByTestId('dirty-indicator')).toBeHidden();

	// The saved archive is exactly three entries with byte-identical originals and
	// self-consistent lowercase SHA-256 manifest hashes.
	const stream = await download.createReadStream();
	const chunks: Buffer[] = [];
	for await (const chunk of stream) chunks.push(chunk);
	const zipBuffer = Buffer.concat(chunks);
	const entries = unzipSync(new Uint8Array(zipBuffer));
	expect(Object.keys(entries).sort()).toEqual([
		'images/source-original.png',
		'images/target-original.jpg',
		'project.json'
	]);
	expect(Buffer.from(entries['images/source-original.png']).equals(fixtureBuffer('tiny.png'))).toBe(true);
	expect(Buffer.from(entries['images/target-original.jpg']).equals(fixtureBuffer('tiny.jpg'))).toBe(true);
	const manifest = JSON.parse(strFromU8(entries['project.json']));
	expect(manifest.schemaVersion).toBe(1);
	expect(manifest.images[0].sha256).toBe(sha256(Buffer.from(entries['images/source-original.png'])));
	expect(manifest.images[1].sha256).toBe(sha256(Buffer.from(entries['images/target-original.jpg'])));
	expect(manifest.project.name).toBe('Sample Round');
	expect(manifest.controlPointPairs).toHaveLength(3);

	// Save/open performed no network request beyond the page load baseline.
	expect(networkRequests.slice(baselineRequests)).toEqual([]);

	// Reload and reopen the same bundle.
	await gotoApp(page);
	await page.waitForLoadState('networkidle');
	const reopenBaseline = networkRequests.length;
	await page.getByTestId('open-project-input').setInputFiles({
		name: 'Sample Round.chainspot.zip',
		mimeType: 'application/zip',
		buffer: zipBuffer
	});

	await expect(page.getByTestId('pane-filename-source-overview')).toHaveText('tiny.png');
	await expect(page.getByTestId('pane-filename-target-basemap')).toHaveText('tiny.jpg');
	await expect(page.getByTestId('app-shell')).toHaveAttribute('data-complete-pair-count', '3');
	await expect(page.getByTestId('project-name')).toHaveValue('Sample Round');
	await expect(page.getByTestId('dirty-indicator')).toBeHidden();
	await expect(page.getByTestId('undo')).toBeDisabled();
	await expect(page.getByTestId('redo')).toBeDisabled();

	// Every marker resolves to the exact saved original-image pixel.
	await expect(inRow(row(page, 1), 'pair-source-px')).toHaveText('(1, 1)');
	await expect(inRow(row(page, 2), 'pair-target-px')).toHaveText('(4, 3)');
	await expect(inRow(row(page, 3), 'pair-source-px')).toHaveText('(1, 0)');

	expect(networkRequests.slice(reopenBaseline)).toEqual([]);
	expect(errors).toEqual([]);
});

test('a corrupt open fails atomically, preserving the live project, dirty state, and markers', async ({
	page
}) => {
	const errors = attachErrorListener(page);
	await gotoApp(page);
	await loadBoth(page);
	await createPair(page, { xPx: 1, yPx: 1 }, { xPx: 1, yPx: 1 });

	await page.getByTestId('open-project-input').setInputFiles({
		name: 'broken.chainspot.zip',
		mimeType: 'application/zip',
		buffer: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x02])
	});

	await expect(page.getByTestId('open-error')).toBeVisible();
	await expect(page.getByTestId('app-shell')).toHaveAttribute('data-complete-pair-count', '1');
	await expect(page.getByTestId('pane-filename-source-overview')).toHaveText('tiny.png');
	await expect(page.getByTestId('dirty-indicator')).toContainText('Unsaved changes');
	await expect(page.getByTestId('pair-row')).toHaveCount(1);
	expect(errors).toEqual([]);
});

test('a pending correspondence is never saved silently and the save dialog guides the user', async ({
	page
}) => {
	const errors = attachErrorListener(page);
	await gotoApp(page);
	await loadBoth(page);

	await page.getByTestId('add-correspondence').click();
	const sourceView = await viewState(page, SOURCE_ROLE);
	await canvasClick(page, SOURCE_ROLE, imagePoint(sourceView, 1, 1));
	await expect(page.getByTestId('app-shell')).toHaveAttribute('data-correspondence-mode', 'add-target');

	await page.getByTestId('save-project').click();
	await expect(page.getByTestId('pending-save-dialog')).toBeVisible();
	await page.getByTestId('pending-save-cancel').click();
	await expect(page.getByTestId('pending-save-dialog')).toBeHidden();
	await expect(page.getByTestId('app-shell')).toHaveAttribute('data-correspondence-mode', 'add-target');

	await page.getByTestId('save-project').click();
	await expect(page.getByTestId('pending-save-dialog')).toBeVisible();
	const downloadPromise = page.waitForEvent('download');
	await page.getByTestId('pending-save-proceed').click();
	const download = await downloadPromise;
	expect(download.suggestedFilename()).toBe('Untitled Project.chainspot.zip');
	await expect(page.getByTestId('app-shell')).toHaveAttribute('data-correspondence-mode', 'neutral');
	await expect(page.getByTestId('dirty-indicator')).toBeHidden();
	expect(errors).toEqual([]);
});
