import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * Browser coverage for single-image autocrop on Annotate Course / Annotate
 * Round uploads: a qualifying phone-screenshot-shaped image (see
 * `usePerImageEntropyVerticalCrop` in `src/lib/stitch/autoCrop.ts`) triggers a
 * crop-review dialog instead of loading straight into the pane, with an
 * explicit "Apply crop" / "Upload without cropping" choice and manually
 * overridable numeric fields — never a silent mutation.
 */

function fixturePath(name: string): string {
	return fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
}

async function gotoApp(page: Page, route: string): Promise<void> {
	await page.goto(route);
	await page.waitForFunction(() => document.documentElement.dataset.appReady === 'true');
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

/**
 * A synthetic "phone screenshot" PNG: uniform gray bands of `chromeDepth` rows
 * at the top and bottom, and a full-range per-pixel-varying region in between
 * standing in for real map content — the same shape the unit tests in
 * `tests/unit/autoCrop.test.ts` use, encoded as a real truecolor PNG so the
 * browser's own canvas/entropy pipeline exercises it end to end.
 */
function screenshotPngPayload(width: number, height: number, chromeDepth: number): Buffer {
	const rowSize = width * 3 + 1;
	const raw = Buffer.alloc(rowSize * height);
	for (let y = 0; y < height; y += 1) {
		raw[y * rowSize] = 0;
		const inChrome = y < chromeDepth || y >= height - chromeDepth;
		for (let x = 0; x < width; x += 1) {
			const offset = y * rowSize + 1 + x * 3;
			const value = inChrome ? 40 : (x * 37 + y * 91) % 256;
			raw[offset] = value;
			raw[offset + 1] = value;
			raw[offset + 2] = value;
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

const WIDTH = 600;
const HEIGHT = 1200;
const CHROME_DEPTH = 100;

test('uploading a qualifying screenshot proposes a crop, which Apply crop applies to the loaded image', async ({
	page
}) => {
	await gotoApp(page, '/annotate-course');

	await page.getByTestId('pane-input-source-overview').setInputFiles({
		name: 'course-screenshot.png',
		mimeType: 'image/png',
		buffer: screenshotPngPayload(WIDTH, HEIGHT, CHROME_DEPTH)
	});

	const dialog = page.getByTestId('crop-review-dialog');
	await expect(dialog).toBeVisible();
	await expect(page.getByTestId('crop-review-top')).toHaveValue(String(CHROME_DEPTH));
	await expect(page.getByTestId('crop-review-bottom')).toHaveValue(String(CHROME_DEPTH));

	// The pane has not been touched while the dialog is open.
	await expect(page.getByTestId('pane-filename-source-overview')).toHaveCount(0);

	await page.getByTestId('crop-review-apply').click();
	await expect(dialog).not.toBeVisible();
	await expect(page.getByTestId('pane-filename-source-overview')).toHaveText(
		`course-screenshot.png · ${WIDTH} × ${HEIGHT - CHROME_DEPTH * 2}`
	);
});

test('Upload without cropping keeps the original, uncropped image', async ({ page }) => {
	await gotoApp(page, '/annotate-course');

	await page.getByTestId('pane-input-source-overview').setInputFiles({
		name: 'course-screenshot.png',
		mimeType: 'image/png',
		buffer: screenshotPngPayload(WIDTH, HEIGHT, CHROME_DEPTH)
	});

	const dialog = page.getByTestId('crop-review-dialog');
	await expect(dialog).toBeVisible();
	await page.getByTestId('crop-review-skip').click();
	await expect(dialog).not.toBeVisible();
	await expect(page.getByTestId('pane-filename-source-overview')).toHaveText(
		`course-screenshot.png · ${WIDTH} × ${HEIGHT}`
	);
});

test('a manually overridden crop amount is what gets applied', async ({ page }) => {
	await gotoApp(page, '/annotate-course');

	await page.getByTestId('pane-input-source-overview').setInputFiles({
		name: 'course-screenshot.png',
		mimeType: 'image/png',
		buffer: screenshotPngPayload(WIDTH, HEIGHT, CHROME_DEPTH)
	});

	await expect(page.getByTestId('crop-review-dialog')).toBeVisible();
	await page.getByTestId('crop-review-top').fill('50');
	await page.getByTestId('crop-review-bottom').fill('0');
	await page.getByTestId('crop-review-apply').click();
	await expect(page.getByTestId('crop-review-dialog')).not.toBeVisible();
	await expect(page.getByTestId('pane-filename-source-overview')).toHaveText(
		`course-screenshot.png · ${WIDTH} × ${HEIGHT - 50}`
	);
});

test('a small, non-screenshot-shaped image never triggers the crop dialog', async ({ page }) => {
	await gotoApp(page, '/annotate-course');

	await page.getByTestId('pane-input-source-overview').setInputFiles(fixturePath('tiny.png'));
	await expect(page.getByTestId('pane-filename-source-overview')).toBeVisible();
	await expect(page.getByTestId('crop-review-dialog')).toHaveCount(0);
});
