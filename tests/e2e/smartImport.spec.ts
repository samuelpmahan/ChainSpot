import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * P1-001 browser case: one complete smart-import workflow from unordered
 * multi-select through crop decision, editable arrangement, native export, and
 * no external request. Uses the committed deterministic smart-import fixtures.
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

test('smart four-tile import: unordered select, inferred roles, crop decision, manual edit, native export, no network', async ({
	page
}) => {
	// Extended from Playwright's 30s default: see the timing note below on the
	// first smart-import assertion for why.
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

	// Analysis completes and the inferred assignment is reported as visible
	// text. Extended from Playwright's 5s default: this is the worker's first
	// real `cv.matchTemplate` call in its lifetime (via `assignFour`), which
	// pays a one-time WASM JIT/lazy-compile tax on top of whatever the eager
	// `loadCv()` warm-up in `smartStitch.worker.ts` already covers (measured
	// 10-12s locally, more under concurrent e2e-worker CPU contention). See
	// the equivalent Snap-assist timing note in stitchMap.spec.ts.
	await expect(page.getByTestId('smart-import-assignment')).toBeVisible({ timeout: 60000 });
	await expect(page.getByTestId('smart-import-slot-upper-left')).toHaveText('smart-ul.png');
	await expect(page.getByTestId('smart-import-slot-upper-right')).toHaveText('smart-ur.png');
	await expect(page.getByTestId('smart-import-slot-lower-left')).toHaveText('smart-ll.png');
	await expect(page.getByTestId('smart-import-slot-lower-right')).toHaveText('smart-lr.png');

	// The inferred arrangement satisfies the connected-overlap readiness rule.
	await expect(page.getByTestId('stitch-readiness')).toContainText('ready');

	// The crop proposal shows exact inset values and is not applied silently.
	const proposal = page.getByTestId('crop-proposal');
	await expect(proposal).toBeVisible();
	await expect(page.getByTestId('crop-proposal-insets')).toContainText('top 4px');
	await expect(page.getByTestId('crop-proposal-insets')).toContainText('bottom 3px');
	await expect(page.getByTestId('crop-topPx')).toHaveValue('0');

	// Apply the suggested crop through the explicit action.
	await page.getByTestId('apply-suggested-crop').click();
	await expect(page.getByTestId('crop-topPx')).toHaveValue('4');
	await expect(page.getByTestId('crop-bottomPx')).toHaveValue('3');
	await expect(page.getByTestId('crop-proposal')).toBeHidden();

	// Manual correction controls remain available after import: select the
	// upper-right tile and nudge it by one pixel.
	await page.getByTestId('tile-select-upper-right').click();
	await expect(page.getByTestId('tile-position-x')).toHaveValue('150');
	await page.keyboard.press('ArrowRight');
	await expect(page.getByTestId('tile-position-x')).toHaveValue('151');

	// Native-resolution export uses the cropped dimensions and inferred placements.
	await expect(page.getByTestId('download-stitched')).toBeEnabled();
	const downloadPromise = page.waitForEvent('download');
	await page.getByTestId('download-stitched').click();
	const download = await downloadPromise;
	expect(download.suggestedFilename()).toBe('smart-ul-stitched.png');
	const stream = await download.createReadStream();
	const chunks: Buffer[] = [];
	for await (const chunk of stream) chunks.push(chunk);
	const png = Buffer.concat(chunks);

	// Cropped size is 200x193 (top 4, bottom 3); placements (0,0), (151,0),
	// (0,150), (151,150) span x 0..351 and y 0..343.
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
	expect(dims).toEqual({ width: 351, height: 343 });

	expect(externalRequests).toEqual([]);
});
