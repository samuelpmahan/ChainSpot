import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * CHSPT-55/56 auto-first browser case: one complete import from unordered
 * multi-select straight through an assembled, already-cropped result, manual
 * correction, native export, and no external request. Uses the committed
 * deterministic smart-import fixtures.
 */
const FIXTURES = join(process.cwd(), 'tests', 'fixtures', 'smart-import');

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

test('smart four-tile import: unordered select, automatic arrangement + crop already applied, manual edit, native export, no network', async ({
	page
}) => {
	// Extended from Playwright's 30s default: this is the smart-stitch worker's
	// first real `cv.matchTemplate` call in its lifetime, which pays a
	// one-time WASM JIT/lazy-compile tax on top of whatever the eager
	// `warmSmartStitchWorker()` call already covers (measured 10-12s locally,
	// more under concurrent e2e-worker CPU contention).
	test.setTimeout(90000);
	const serverOrigin = await gotoApp(page);

	const externalRequests: string[] = [];
	page.on('request', (request) => {
		const url = new URL(request.url());
		if (url.origin !== serverOrigin) externalRequests.push(request.url());
	});

	// The file-selection order (lower-left, upper-right, lower-right, upper-left)
	// must not determine the inferred roles.
	await page.getByTestId('smart-import-input').setInputFiles(FILES);

	// No approval click stands between selection and an assembled result.
	await expect(page.getByTestId('composite-image')).toBeVisible({ timeout: 60000 });
	await expect(page.getByTestId('continue-to-annotate')).toBeEnabled();

	// High-confidence automatic arrangements proceed with no review flag.
	await expect(page.getByTestId('confidence-review')).toHaveCount(0);

	// The shared crop the pipeline detected (this fixture's known top 4px /
	// bottom 3px chrome band, plus the default +2px safety margin per side)
	// is already applied — not merely proposed — visible once the
	// manual-correction surface is opened.
	await page.getByTestId('adjust-manually').click();
	await page.getByTestId('manual-tab-crop').click();
	await expect(page.getByTestId('crop-topPx')).toHaveValue('6');
	await expect(page.getByTestId('crop-bottomPx')).toHaveValue('5');

	// The automatic result summary lists all four captures, order-independent
	// of upload order.
	await expect(page.getByTestId('manual-capture-list').locator('li')).toHaveCount(4);

	// Manual correction controls remain available after import: select a
	// movable tile and nudge it by one pixel.
	await page.getByTestId('manual-tab-placement').click();
	await page.getByTestId('tile-select-tile-1').click();
	const startX = Number(await page.getByTestId('tile-position-x').inputValue());
	await page.keyboard.press('ArrowRight');
	await expect(page.getByTestId('tile-position-x')).toHaveValue(String(startX + 1));
	await page.getByTestId('tile-position-x').fill(String(startX));
	await page.getByTestId('tile-position-x').blur();

	await page.getByTestId('apply-manual-adjustments').click();
	await expect(page.getByTestId('manual-surface')).toHaveCount(0);

	// Native-resolution export uses the cropped dimensions and inferred
	// placements: cropped size is 200x189 (top 6, bottom 5); ground-truth
	// placements (0,0), (150,0), (0,150), (150,150) span x 0..350, y 0..339.
	await expect(page.getByTestId('download-stitched')).toBeEnabled();
	const downloadPromise = page.waitForEvent('download');
	await page.getByTestId('download-stitched').click();
	const download = await downloadPromise;
	// The filename is derived from whichever capture `assignN` chose as the
	// anchor — an internal ordering detail this file does not pin (see
	// `stitchMap.spec.ts`'s note on the same point) — so only the naming
	// convention itself is asserted, not a specific fixture's name.
	expect(download.suggestedFilename()).toMatch(/^smart-(ll|ur|lr|ul)-stitched\.png$/);
	const stream = await download.createReadStream();
	const chunks: Buffer[] = [];
	for await (const chunk of stream) chunks.push(chunk);
	const png = Buffer.concat(chunks);

	const dims = await page.evaluate(async (data) => {
		const blob = new Blob([new Uint8Array(data)], { type: 'image/png' });
		const url = URL.createObjectURL(blob);
		try {
			const image = new Image();
			image.src = url;
			await image.decode();
			return { width: image.naturalWidth, height: image.naturalHeight };
		} finally {
			URL.revokeObjectURL(url);
		}
	}, [...png]);
	expect(dims).toEqual({ width: 350, height: 339 });

	expect(externalRequests).toEqual([]);
});
