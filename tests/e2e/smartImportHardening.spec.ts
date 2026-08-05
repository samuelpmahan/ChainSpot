import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * P1-002 browser case: a low-confidence (incompatible) import preserves all four
 * files, communicates the issue in text, never claims a strong success, permits
 * manual correction, and a re-run over manual edits requires an explicit replace
 * decision. Uses the committed incompatible smart-import fixtures.
 */
const FIXTURES = join(process.cwd(), 'tests', 'fixtures', 'smart-import', 'incompatible');

const FILES = [
	{ name: 'smart-ll.png', mimeType: 'image/png' },
	{ name: 'smart-ur.png', mimeType: 'image/png' },
	{ name: 'smart-lr.png', mimeType: 'image/png' },
	{ name: 'smart-ul.png', mimeType: 'image/png' }
].map((file) => ({
	...file,
	buffer: readFileSync(join(FIXTURES, file.name))
}));

async function gotoApp(page: Page): Promise<string> {
	await page.goto('/stitch-map');
	await page.waitForFunction(() => document.documentElement.dataset.appReady === 'true');
	return new URL(page.url()).origin;
}

test('low-confidence import preserves all files, communicates the issue, permits correction, and never claims strong', async ({
	page
}) => {
	const serverOrigin = await gotoApp(page);

	const externalRequests: string[] = [];
	page.on('request', (request) => {
		const url = new URL(request.url());
		if (url.origin !== serverOrigin) externalRequests.push(request.url());
	});

	await page.getByTestId('smart-import-input').setInputFiles(FILES);

	// Every decoded file is preserved in the four replaceable slots.
	for (const slot of ['upper-left', 'upper-right', 'lower-left', 'lower-right'] as const) {
		await expect(page.getByTestId(`tile-file-${slot}`)).toBeVisible();
	}
	await expect(page.getByTestId('smart-import-slot-upper-left')).toHaveText('smart-ul.png');

	// The uncertainty is communicated as text and never claims a strong success.
	const confidence = page.getByTestId('smart-import-confidence');
	await expect(confidence).toBeVisible();
	await expect(confidence).toContainText('uncertain');
	await expect(confidence).not.toContainText('strong');
	await expect(page.getByTestId('smart-import-warnings')).toBeVisible();

	// Manual correction remains available: select a movable tile and edit it.
	await expect(page.getByTestId('tile-select-upper-right')).toBeEnabled();
	await page.getByTestId('tile-select-upper-right').click();
	await expect(page.getByTestId('tile-position-x')).toBeEnabled();
	await page.keyboard.press('ArrowRight');
	await expect(page.getByTestId('tile-position-x')).toHaveValue('151');

	expect(externalRequests).toEqual([]);
});

test('re-running automatic arrangement over manual edits requires an explicit replace decision', async ({
	page
}) => {
	await gotoApp(page);

	// First import: a coherent strong set, no confirmation needed.
	await page
		.getByTestId('smart-import-input')
		.setInputFiles(
			['smart-ll.png', 'smart-ur.png', 'smart-lr.png', 'smart-ul.png'].map((name) => ({
				name,
				mimeType: 'image/png',
				buffer: readFileSync(join(process.cwd(), 'tests', 'fixtures', 'smart-import', name))
			}))
		);
	await expect(page.getByTestId('smart-import-assignment')).toBeVisible();

	// Refine a tile by hand, then ask for automatic arrangement again.
	await page.getByTestId('tile-select-upper-right').click();
	await page.keyboard.press('ArrowRight');
	await expect(page.getByTestId('tile-position-x')).toHaveValue('151');

	await page
		.getByTestId('smart-import-input')
		.setInputFiles(
			['smart-ll.png', 'smart-ur.png', 'smart-lr.png', 'smart-ul.png'].map((name) => ({
				name,
				mimeType: 'image/png',
				buffer: readFileSync(join(process.cwd(), 'tests', 'fixtures', 'smart-import', name))
			}))
		);

	// The manual arrangement is protected until the user explicitly replaces it.
	await expect(page.getByTestId('replace-arrangement-confirmation')).toBeVisible();
	await page.getByTestId('replace-confirm-cancel').click();
	await expect(page.getByTestId('replace-arrangement-confirmation')).toBeHidden();
	await expect(page.getByTestId('tile-position-x')).toHaveValue('151');

	// Confirming performs the replacement.
	await page
		.getByTestId('smart-import-input')
		.setInputFiles(
			['smart-ll.png', 'smart-ur.png', 'smart-lr.png', 'smart-ul.png'].map((name) => ({
				name,
				mimeType: 'image/png',
				buffer: readFileSync(join(process.cwd(), 'tests', 'fixtures', 'smart-import', name))
			}))
		);
	await expect(page.getByTestId('replace-arrangement-confirmation')).toBeVisible();
	await page.getByTestId('replace-confirm-accept').click();
	await expect(page.getByTestId('replace-arrangement-confirmation')).toBeHidden();
	// The selected slot resets to the fresh automatic placement (150,0).
	await page.getByTestId('tile-select-upper-right').click();
	await expect(page.getByTestId('tile-position-x')).toHaveValue('150');
});
