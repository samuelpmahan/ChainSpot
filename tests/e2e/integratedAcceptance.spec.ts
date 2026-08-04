import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { strFromU8, unzipSync } from 'fflate';
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

const SOURCE_ROLE = 'source-overview';
const TARGET_ROLE = 'target-basemap';

type Point = { xPx: number; yPx: number };
type ViewState = { zoom: number; panX: number; panY: number };
type PaneGeometry = { left: number; top: number; clientLeft: number; clientTop: number; width: number; height: number };
type PairSnapshot = {
	ordinal: number;
	label: string;
	enabled: boolean;
	source: Point;
	target: Point;
};

const sourceLandmarks: Point[] = [
	{ xPx: 90, yPx: 70 },
	{ xPx: 520, yPx: 65 },
	{ xPx: 120, yPx: 330 },
	{ xPx: 350, yPx: 205 },
	{ xPx: 560, yPx: 350 }
];
const targetLandmarks: Point[] = [
	{ xPx: 140, yPx: 90 },
	{ xPx: 780, yPx: 80 },
	{ xPx: 170, yPx: 420 },
	{ xPx: 520, yPx: 270 },
	{ xPx: 840, yPx: 420 }
];

function fixturePath(name: string): string {
	return fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
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

function screenPoint(geometry: PaneGeometry, point: { x: number; y: number }): { x: number; y: number } {
	return {
		x: geometry.left + geometry.clientLeft + point.x,
		y: geometry.top + geometry.clientTop + point.y
	};
}

function imageToScreen(view: ViewState, point: Point): { x: number; y: number } {
	return { x: point.xPx * view.zoom + view.panX, y: point.yPx * view.zoom + view.panY };
}

async function canvasClick(page: Page, role: string, point: Point): Promise<void> {
	await page.getByTestId(`pane-scene-${role}`).scrollIntoViewIfNeeded();
	const geometry = await paneGeometry(page, role);
	const view = await viewState(page, role);
	const local = imageToScreen(view, point);
	const absolute = screenPoint(geometry, local);
	await page.mouse.click(absolute.x, absolute.y);
}

async function createPair(page: Page, source: Point, target: Point): Promise<void> {
	await page.getByTestId('add-correspondence').click();
	await canvasClick(page, SOURCE_ROLE, source);
	await canvasClick(page, TARGET_ROLE, target);
	await expect(page.getByTestId('app-shell')).toHaveAttribute('data-correspondence-mode', 'neutral');
}

async function dragMarker(page: Page, role: string, from: Point, to: Point): Promise<void> {
	await page.getByTestId(`pane-scene-${role}`).scrollIntoViewIfNeeded();
	const geometry = await paneGeometry(page, role);
	const view = await viewState(page, role);
	const start = screenPoint(geometry, imageToScreen(view, from));
	const destination = screenPoint(geometry, imageToScreen(view, to));
	await page.mouse.move(start.x, start.y);
	await page.mouse.down();
	await page.mouse.move(destination.x, destination.y, { steps: 5 });
	await page.mouse.up();
}

function row(page: Page, ordinal: number): Locator {
	return page.locator(`[data-testid="pair-row"][data-ordinal="${ordinal}"]`);
}

function parsePoint(text: string | null): Point {
	const match = text?.match(/\((-?[0-9.]+),\s*(-?[0-9.]+)\)/);
	if (!match) throw new Error(`Could not parse point '${text}'`);
	return { xPx: Number(match[1]), yPx: Number(match[2]) };
}

async function readPairs(page: Page): Promise<PairSnapshot[]> {
	const rows = page.getByTestId('pair-row');
	const snapshots: PairSnapshot[] = [];
	for (let index = 0; index < (await rows.count()); index += 1) {
		const current = rows.nth(index);
		snapshots.push({
			ordinal: Number(await current.getAttribute('data-ordinal')),
			label: await current.locator('input.label-input').inputValue(),
			enabled: await current.locator('input[type="checkbox"]').isChecked(),
			source: parsePoint(await current.locator('[data-testid^="pair-source-px-"]').textContent()),
			target: parsePoint(await current.locator('[data-testid^="pair-target-px-"]').textContent())
		});
	}
	return snapshots;
}

function expectPointWithinOnePixel(actual: Point, expected: Point): void {
	expect(Math.abs(actual.xPx - expected.xPx)).toBeLessThanOrEqual(1);
	expect(Math.abs(actual.yPx - expected.yPx)).toBeLessThanOrEqual(1);
}

test('completes the five-pair save/reopen acceptance workflow without a backend', async ({ page }) => {
	const errors = attachErrorListener(page);
	const requests: string[] = [];
	page.on('request', (request) => {
		if (!request.url().startsWith('blob:') && !request.url().startsWith('data:')) requests.push(request.url());
	});

	await gotoApp(page);
	await page.getByTestId('pane-input-source-overview').setInputFiles(fixturePath('acceptance-source-overview.png'));
	await expect(page.getByTestId('pane-dimensions-source-overview')).toHaveText('640 × 420 px');
	await page.getByTestId('pane-input-target-basemap').setInputFiles(fixturePath('acceptance-clean-map.png'));
	await expect(page.getByTestId('pane-dimensions-target-basemap')).toHaveText('960 × 540 px');

	const sourceFit = await viewState(page, SOURCE_ROLE);
	const targetFit = await viewState(page, TARGET_ROLE);
	await page.mouse.move(...Object.values(screenPoint(await paneGeometry(page, SOURCE_ROLE), { x: 210, y: 150 })) as [number, number]);
	await page.mouse.wheel(0, -200);
	await expect.poll(() => viewState(page, SOURCE_ROLE)).not.toEqual(sourceFit);
	await page.mouse.move(...Object.values(screenPoint(await paneGeometry(page, TARGET_ROLE), { x: 280, y: 160 })) as [number, number]);
	await page.mouse.wheel(0, 200);
	await expect.poll(() => viewState(page, TARGET_ROLE)).not.toEqual(targetFit);
	await page.getByTestId('pane-fit-source-overview').click();
	await page.getByTestId('pane-reset-target-basemap').click();
	await expect.poll(() => viewState(page, SOURCE_ROLE)).toEqual(sourceFit);
	await expect.poll(() => viewState(page, TARGET_ROLE)).toEqual(targetFit);

	for (let index = 0; index < sourceLandmarks.length; index += 1) {
		await createPair(page, sourceLandmarks[index], targetLandmarks[index]);
	}
	await expect(page.getByTestId('app-shell')).toHaveAttribute('data-complete-pair-count', '5');

	// Correct two markers through the canvas after independent navigation has been exercised.
	await page.mouse.move(...Object.values(screenPoint(await paneGeometry(page, SOURCE_ROLE), { x: 310, y: 170 })) as [number, number]);
	await page.mouse.wheel(0, -200);
	await dragMarker(page, SOURCE_ROLE, sourceLandmarks[0], { xPx: 96, yPx: 76 });
	await page.getByTestId('pane-fit-source-overview').click();
	await dragMarker(page, TARGET_ROLE, targetLandmarks[1], { xPx: 788, yPx: 86 });

	await row(page, 3).locator('input.label-input').fill('Bridge crossing');
	await row(page, 3).locator('input.label-input').press('Enter');
	await expect(row(page, 3).locator('input.label-input')).toHaveValue('Bridge crossing');

	await row(page, 4).locator('[data-testid^="pair-delete-"]').click();
	await expect(page.getByTestId('pair-row')).toHaveCount(4);
	await page.getByTestId('undo').click();
	await expect(page.getByTestId('pair-row')).toHaveCount(5);

	// Reorder, toggle enabled state, and use the one-pixel keyboard correction.
	await row(page, 5).locator('[data-testid^="pair-up-"]').click();
	await expect(row(page, 4).locator('input.label-input')).toHaveValue('');
	await row(page, 2).locator('input[type="checkbox"]').uncheck();
	await expect(row(page, 2)).toHaveClass(/disabled-pair/);
	await row(page, 2).locator('input[type="checkbox"]').check();
	await row(page, 1).locator('[data-side="source"]').click();
	await page.keyboard.press('ArrowRight');

	const beforeResize = await readPairs(page);
	await page.setViewportSize({ width: 1000, height: 700 });
	await expect.poll(async () => JSON.stringify(await readPairs(page))).toBe(JSON.stringify(beforeResize));
	await expect(page.getByTestId('pane-dimensions-source-overview')).toHaveText('640 × 420 px');
	await expect(page.getByTestId('pane-dimensions-target-basemap')).toHaveText('960 × 540 px');

	await page.getByTestId('project-name').fill('Five Landmark Acceptance');
	await page.getByTestId('project-name').blur();
	await expect(page.getByTestId('dirty-indicator')).toContainText('Unsaved changes');
	const expected = await readPairs(page);
	const saveRequestCount = requests.length;
	const downloadPromise = page.waitForEvent('download');
	await page.getByTestId('save-project').click();
	const download = await downloadPromise;
	await expect(page.getByTestId('dirty-indicator')).toBeHidden();
	expect(download.suggestedFilename()).toBe('Five Landmark Acceptance.chainspot.zip');
	expect(requests.length).toBe(saveRequestCount);

	const stream = await download.createReadStream();
	if (!stream) throw new Error('Playwright did not expose the saved bundle stream');
	const chunks: Buffer[] = [];
	for await (const chunk of stream) chunks.push(Buffer.from(chunk));
	const bundle = Buffer.concat(chunks);
	const entries = unzipSync(new Uint8Array(bundle));
	const document = JSON.parse(strFromU8(entries['project.json']));
	expect(document.controlPointPairs).toHaveLength(5);
	expect(Object.keys(entries).sort()).toEqual([
		'images/source-original.png',
		'images/target-original.png',
		'project.json'
	]);
	expect(Buffer.from(entries['images/source-original.png']).equals(readFileSync(fixturePath('acceptance-source-overview.png')))).toBe(true);
	expect(Buffer.from(entries['images/target-original.png']).equals(readFileSync(fixturePath('acceptance-clean-map.png')))).toBe(true);

	await gotoApp(page);
	const reopenRequestCount = requests.length;
	await page.getByTestId('open-project-input').setInputFiles({
		name: 'Five Landmark Acceptance.chainspot.zip',
		mimeType: 'application/zip',
		buffer: bundle
	});
	await expect(page.getByTestId('pair-row')).toHaveCount(5);
	await expect.poll(async () => JSON.stringify(await readPairs(page))).not.toBe('[]');
	const restored = await readPairs(page);
	for (let index = 0; index < expected.length; index += 1) {
		expect(restored[index].ordinal).toBe(expected[index].ordinal);
		expect(restored[index].label).toBe(expected[index].label);
		expect(restored[index].enabled).toBe(expected[index].enabled);
		expectPointWithinOnePixel(restored[index].source, expected[index].source);
		expectPointWithinOnePixel(restored[index].target, expected[index].target);
	}
	await expect(page.getByTestId('dirty-indicator')).toBeHidden();
	await expect(page.getByTestId('undo')).toBeDisabled();
	await expect(page.getByTestId('redo')).toBeDisabled();
	// Save/open uses only browser file/blob APIs after the initial local app load.
	expect(requests.slice(reopenRequestCount)).toEqual([]);
	expect(errors).toEqual([]);
});
