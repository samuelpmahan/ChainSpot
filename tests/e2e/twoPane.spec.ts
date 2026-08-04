import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const SOURCE_ROLE = 'source-overview';
const TARGET_ROLE = 'target-basemap';

function fixturePath(name: string): string {
	return fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
}

function fixtureBuffer(name: string): Buffer {
	return readFileSync(fixturePath(name));
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
	// Wait for hydration: events dispatched before this are not delegated.
	await page.waitForFunction(() => document.documentElement.dataset.appReady === 'true');
}

async function expectPanePixel(
	page: Page,
	role: string,
	expected: { r: number; g: number; b: number }
): Promise<void> {
	await expect
		.poll(
			() =>
				page.evaluate(
					({ paneRole, r, g, b }) => {
						const canvas = document.querySelector<HTMLCanvasElement>(
							`[data-testid="pane-scene-${paneRole}"] canvas`
						);
						if (!canvas) return false;
						const ctx = canvas.getContext('2d');
						if (!ctx) return false;
						const { data } = ctx.getImageData(
							Math.floor(canvas.width / 2),
							Math.floor(canvas.height / 2),
							1,
							1
						);
						return (
							Math.abs(data[0] - r) <= 12 &&
							Math.abs(data[1] - g) <= 12 &&
							Math.abs(data[2] - b) <= 12
						);
					},
					{ paneRole: role, r: expected.r, g: expected.g, b: expected.b }
				),
			{ timeout: 5000 }
		)
		.toBe(true);
}

/**
 * Verifies the raster layer actually drew decoded content. The tiny.jpg fixture's
 * decoder-level contract is its dimensions, not its color, so only non-blank content
 * is asserted for JPEGs.
 */
async function expectPaneRendered(page: Page, role: string): Promise<void> {
	await expect
		.poll(
			() =>
				page.evaluate((paneRole: string) => {
					const canvas = document.querySelector<HTMLCanvasElement>(
						`[data-testid="pane-scene-${paneRole}"] canvas`
					);
					if (!canvas) return false;
					const ctx = canvas.getContext('2d');
					if (!ctx) return false;
					const { data } = ctx.getImageData(
						Math.floor(canvas.width / 2),
						Math.floor(canvas.height / 2),
						1,
						1
					);
					return data[3] !== 0;
				}, role),
			{ timeout: 5000 }
		)
		.toBe(true);
}

test('loads both fixtures locally, gates Add correspondence, and makes no external requests', async ({
	page
}) => {
	const consoleErrors = attachErrorListener(page);
	const networkRequests: string[] = [];
	page.on('request', (request) => {
		// blob:/data: URLs are local in-memory reads (e.g. Image.decode of an
		// object URL), not network transfers; every http(s) request is tracked
		// regardless of origin so same-origin uploads are also caught.
		if (request.url().startsWith('blob:') || request.url().startsWith('data:')) return;
		networkRequests.push(request.url());
	});

	await gotoApp(page);
	// Let all application modules settle so the baseline covers the complete load.
	await page.waitForLoadState('networkidle');
	const baselineRequests = networkRequests.length;

	const addButton = page.getByTestId('add-correspondence');
	await expect(addButton).toBeDisabled();
	await expect(page.getByTestId('pane-empty-source-overview')).toBeVisible();
	await expect(page.getByTestId('pane-empty-target-basemap')).toBeVisible();

	await page.getByTestId('pane-input-source-overview').setInputFiles(fixturePath('tiny.png'));
	await expect(page.getByTestId('pane-filename-source-overview')).toHaveText('tiny.png');
	await expect(page.getByTestId('pane-dimensions-source-overview')).toContainText('2 × 3 px');
	await expect(page.getByTestId('pane-orientation-source-overview')).toHaveText('Portrait');
	await expect(page.getByTestId('pane-status-source-overview')).toHaveText('Image loaded');
	await expect(addButton).toBeDisabled();

	await page.getByTestId('pane-input-target-basemap').setInputFiles(fixturePath('tiny.jpg'));
	await expect(page.getByTestId('pane-filename-target-basemap')).toHaveText('tiny.jpg');
	await expect(page.getByTestId('pane-dimensions-target-basemap')).toContainText('5 × 4 px');
	await expect(page.getByTestId('pane-orientation-target-basemap')).toHaveText('Landscape');
	await expect(addButton).toBeEnabled();

	await expectPanePixel(page, SOURCE_ROLE, { r: 255, g: 0, b: 0 });
	await expectPaneRendered(page, TARGET_ROLE);

	// Selecting local files must cause no network request of any kind, including
	// same-origin uploads: the network request log must not grow past the load baseline.
	expect(networkRequests.slice(baselineRequests)).toEqual([]);
	expect(consoleErrors).toEqual([]);
});

test('renames the project through the domain boundary and shows dirty state', async ({ page }) => {
	const consoleErrors = attachErrorListener(page);

	await gotoApp(page);
	await expect(page.getByTestId('dirty-indicator')).toBeVisible();

	const nameInput = page.getByTestId('project-name');
	await nameInput.fill('Sample Round');
	await nameInput.blur();
	await expect(page.getByTestId('dirty-indicator')).toContainText('Unsaved changes');
	await expect(nameInput).toHaveValue('Sample Round');
	expect(consoleErrors).toEqual([]);
});

test('an unsupported file type shows a specific error and keeps the other pane intact', async ({
	page
}) => {
	const consoleErrors = attachErrorListener(page);

	await gotoApp(page);
	await page.getByTestId('pane-input-source-overview').setInputFiles(fixturePath('tiny.png'));
	await expect(page.getByTestId('pane-status-source-overview')).toHaveText('Image loaded');

	await page
		.getByTestId('pane-input-source-overview')
		.setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });

	await expect(page.getByTestId('pane-error-source-overview')).toContainText(
		'Unsupported file type'
	);
	await expect(page.getByTestId('pane-filename-source-overview')).toHaveText('tiny.png');
	await expect(page.getByTestId('pane-empty-target-basemap')).toBeVisible();
	expect(consoleErrors).toEqual([]);
});

test('corrupt image data reports a decode failure and preserves the current pane', async ({
	page
}) => {
	const consoleErrors = attachErrorListener(page);

	await gotoApp(page);
	await page.getByTestId('pane-input-source-overview').setInputFiles(fixturePath('tiny.png'));
	await expect(page.getByTestId('pane-status-source-overview')).toHaveText('Image loaded');

	await page.getByTestId('pane-input-source-overview').setInputFiles({
		name: 'broken.png',
		mimeType: 'image/png',
		buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03])
	});

	await expect(page.getByTestId('pane-error-source-overview')).toContainText('Could not decode');
	await expect(page.getByTestId('pane-filename-source-overview')).toHaveText('tiny.png');
	expect(consoleErrors).toEqual([]);
});

test('a valid replacement swaps the pane image without clearing the other role', async ({
	page
}) => {
	const consoleErrors = attachErrorListener(page);

	await gotoApp(page);
	await page.getByTestId('pane-input-source-overview').setInputFiles(fixturePath('tiny.png'));
	await page.getByTestId('pane-input-target-basemap').setInputFiles(fixturePath('tiny.jpg'));
	await expect(page.getByTestId('pane-status-target-basemap')).toHaveText('Image loaded');

	await page.getByTestId('pane-input-source-overview').setInputFiles({
		name: 'udisc-v2.png',
		mimeType: 'image/png',
		buffer: fixtureBuffer('tiny.png')
	});

	await expect(page.getByTestId('pane-filename-source-overview')).toHaveText('udisc-v2.png');
	await expect(page.getByTestId('pane-status-source-overview')).toHaveText('Image loaded');
	await expect(page.getByTestId('pane-filename-target-basemap')).toHaveText('tiny.jpg');
	await expectPanePixel(page, SOURCE_ROLE, { r: 255, g: 0, b: 0 });
	expect(consoleErrors).toEqual([]);
});
