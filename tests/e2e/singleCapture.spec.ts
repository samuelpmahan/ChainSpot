import { deflateSync } from 'node:zlib';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * CHSPT-55/56 N=1 browser case: a single screenshot is a new, first-class
 * entry point (previously explicitly rejected with "requires at least two
 * files"). It gets AutoCrop only (no AutoStitch — nothing to stitch against)
 * through the SAME unified pipeline call and the SAME phases (import ->
 * processing -> result) as N>1, with no separate code path the user can
 * tell apart.
 */

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

function pngPayload(width: number, height: number, rgb: [number, number, number]): Buffer {
	const rowSize = width * 3 + 1;
	const raw = Buffer.alloc(rowSize * height);
	for (let y = 0; y < height; y += 1) {
		raw[y * rowSize] = 0;
		for (let x = 0; x < width; x += 1) {
			const offset = y * rowSize + 1 + x * 3;
			raw[offset] = rgb[0];
			raw[offset + 1] = rgb[1];
			raw[offset + 2] = rgb[2];
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

const WIDTH = 60;
const HEIGHT = 40;

async function gotoApp(page: Page): Promise<string> {
	await page.goto('/stitch-map');
	await page.waitForFunction(() => document.documentElement.dataset.appReady === 'true');
	return new URL(page.url()).origin;
}

test('a single screenshot gets AutoCrop only through the same unified entry point, lands directly on a result, and supports manual crop correction', async ({
	page
}) => {
	const serverOrigin = await gotoApp(page);
	const externalRequests: string[] = [];
	page.on('request', (request) => {
		const url = new URL(request.url());
		if (url.origin !== serverOrigin) externalRequests.push(request.url());
	});

	// The SAME "Import screenshots" input N>1 uses, with just one file.
	await page.getByTestId('smart-import-input').setInputFiles({
		name: 'single.png',
		mimeType: 'image/png',
		buffer: pngPayload(WIDTH, HEIGHT, [90, 140, 200])
	});

	// No stitching to wait on, no forced approval click: straight to result.
	await expect(page.getByTestId('composite-image')).toBeVisible();
	await expect(page.getByTestId('confidence-review')).toHaveCount(0);
	await expect(page.getByTestId('continue-to-annotate')).toBeEnabled();
	await expect(page.getByTestId('download-stitched')).toBeEnabled();
	await expect(page.getByTestId('use-as-target')).toBeEnabled();

	// A single capture has no neighbor and nothing movable: the manual
	// surface's Position tab has no tile selector, and Snap has nothing to
	// search against.
	await page.getByTestId('adjust-manually').click();
	await expect(page.locator('[data-testid^="tile-select-"]')).toHaveCount(0);
	// Snap stays visible (same control surface as N>1) but has nothing to
	// search against with no neighbor, so it is disabled rather than hidden.
	await expect(page.getByTestId('snap-tile')).toBeDisabled();
	await expect(page.getByTestId('manual-capture-list').locator('li')).toHaveCount(1);

	// Manual crop correction remains fully capable even for N=1: no automatic
	// proposal was defensible for this flat synthetic fixture (its uniform
	// color carries no chrome-band evidence), so the crop starts at zero and
	// the user can still set an exact inset by hand.
	await page.getByTestId('manual-tab-crop').click();
	await expect(page.getByTestId('crop-topPx')).toHaveValue('0');
	await page.getByTestId('crop-topPx').fill('5');
	await page.getByTestId('crop-topPx').blur();
	await page.getByTestId('crop-bottomPx').fill('5');
	await page.getByTestId('crop-bottomPx').blur();
	await page.getByTestId('crop-leftPx').fill('10');
	await page.getByTestId('crop-leftPx').blur();
	await page.getByTestId('crop-rightPx').fill('10');
	await page.getByTestId('crop-rightPx').blur();

	await expect(page.getByTestId('apply-manual-adjustments')).toBeEnabled();
	await page.getByTestId('apply-manual-adjustments').click();
	await expect(page.getByTestId('manual-surface')).toHaveCount(0);

	const downloadPromise = page.waitForEvent('download');
	await page.getByTestId('download-stitched').click();
	const download = await downloadPromise;
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
	// 60x40 minus 10px left/right and 5px top/bottom.
	expect(dims).toEqual({ width: WIDTH - 20, height: HEIGHT - 10 });

	expect(externalRequests).toEqual([]);
});

test('N=1 continues to Annotate Course through the same handoff as N>1', async ({ page }) => {
	await gotoApp(page);
	await page.getByTestId('smart-import-input').setInputFiles({
		name: 'single.png',
		mimeType: 'image/png',
		buffer: pngPayload(WIDTH, HEIGHT, [10, 200, 90])
	});
	await expect(page.getByTestId('composite-image')).toBeVisible();
	await page.getByTestId('continue-to-annotate').click();
	await expect(page).toHaveURL(/\/annotate-course$/);
	await expect(page.getByTestId('pending-handoff')).toBeHidden();
	await expect(page.getByTestId('annotation-workspace')).toHaveAttribute('data-source-loaded', 'true');
});
