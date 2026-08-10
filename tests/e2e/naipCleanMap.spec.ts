import { deflateSync } from 'node:zlib';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * Browser coverage for the NAIP clean-map pipeline: course-name search (city/state
 * optional), the drag-resize coverage box over the fetched reference preview, the
 * derived tile-grid plan, the actual multi-tile fetch + mosaic assembly, and the
 * commit into the editor. Nominatim and NAIP are both mocked deterministically — real
 * network behavior for each is already covered by `naip.test.ts` and `geocode.test.ts`.
 */

const NOMINATIM_PATTERN = 'https://nominatim.openstreetmap.org/search**';
const NAIP_PATTERN = 'https://imagery.nationalmap.gov/**';

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

/** Solid-color PNG, synthesized at test time rather than committed as a binary fixture. */
function pngPayload(width: number, height: number): Buffer {
	const rowSize = width * 3 + 1;
	const raw = Buffer.alloc(rowSize * height);
	for (let y = 0; y < height; y += 1) {
		raw[y * rowSize] = 0;
		for (let x = 0; x < width; x += 1) {
			const offset = y * rowSize + 1 + x * 3;
			raw[offset] = 120;
			raw[offset + 1] = 150;
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

async function gotoApp(page: Page): Promise<string> {
	await page.goto('/create-graphics');
	await page.waitForFunction(() => document.documentElement.dataset.appReady === 'true');
	return new URL(page.url()).origin;
}

test('NAIP clean-map pipeline: search by name only, drag the coverage box, fetch a tile grid, commit the mosaic', async ({
	page
}) => {
	const serverOrigin = await gotoApp(page);

	const externalOrigins: string[] = [];
	page.on('request', (request) => {
		const url = new URL(request.url());
		if (url.origin !== serverOrigin) externalOrigins.push(url.origin);
	});

	let lastNominatimQuery: string | null = null;
	await page.route(NOMINATIM_PATTERN, async (route) => {
		lastNominatimQuery = new URL(route.request().url()).searchParams.get('q');
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify([
				{ lat: '33.1255198', lon: '-96.8610387', display_name: "Dash's Track, Frisco, Collin County, Texas" }
			])
		});
	});

	// 2048x2048 matches NAIP_EXPORT_SIZE_PX exactly, so the box picker's natural-vs-
	// displayed-pixel scale math behaves the same as it would against a real tile.
	const tilePng = pngPayload(2048, 2048);
	let naipRequestCount = 0;
	await page.route(NAIP_PATTERN, async (route) => {
		naipRequestCount += 1;
		await route.fulfill({ status: 200, contentType: 'image/png', body: tilePng });
	});

	// 1. Search by course name alone — city/state is optional precisely for courses
	// whose town the user doesn't know off-hand.
	await page.getByTestId('geocode-park-name').fill("Dash's Track");
	await page.getByTestId('geocode-search-button').click();
	await expect(page.getByTestId('geocode-results')).toBeVisible();
	expect(lastNominatimQuery).toBe("Dash's Track");
	await page.getByTestId('geocode-result-0').click();
	await expect(page.getByTestId('naip-lat')).toHaveValue('33.1255198');
	await expect(page.getByTestId('naip-lon')).toHaveValue('-96.8610387');

	// 2. Fetch the wide reference preview at the default 900m radius.
	await expect(page.getByTestId('naip-radius')).toHaveValue('900');
	await page.getByTestId('naip-fetch-button').click();
	await expect(page.getByTestId('naip-preview')).toBeVisible();
	expect(naipRequestCount).toBe(1);

	// 3. The default coverage box (90% of the 1800m preview) plans a 3x3, 9-tile grid.
	await expect(page.getByTestId('naip-grid-plan')).toContainText('3 x 3 tiles');
	await expect(page.getByTestId('naip-grid-plan')).toContainText('9 images');

	// 4. Dragging the southeast handle inward shrinks the box and the plan recomputes
	// live, with no fetch involved — pure geometry.
	const seHandle = page.getByTestId('naip-box-handle-se');
	await seHandle.scrollIntoViewIfNeeded();
	const handleBox = await seHandle.boundingBox();
	if (!handleBox) throw new Error('coverage box resize handle has no bounding box');
	const startX = handleBox.x + handleBox.width / 2;
	const startY = handleBox.y + handleBox.height / 2;
	await page.mouse.move(startX, startY);
	await page.mouse.down();
	await page.mouse.move(startX - 200, startY - 200, { steps: 10 });
	await page.mouse.up();
	await expect(page.getByTestId('naip-grid-plan')).toContainText('2 x 2 tiles');
	await expect(page.getByTestId('naip-grid-plan')).toContainText('4 images');

	// 5. Fetching the grid pulls exactly the planned tile count (not the original 9)
	// and assembles one mosaic preview.
	await page.getByTestId('naip-grid-fetch-button').click();
	await expect(page.getByTestId('naip-grid-preview')).toBeVisible({ timeout: 15000 });
	expect(naipRequestCount).toBe(5); // 1 overview + 4 grid tiles

	// 6. Committing routes through the normal intake path, same as a manual upload.
	await page.getByTestId('naip-grid-use').click();
	await expect(page.getByTestId('pane-filename-target-basemap')).toHaveText('naip-tile-grid.png');
	await expect(page.getByTestId('naip-preview')).toBeHidden();

	// Only the two intended external services were ever contacted.
	const uniqueOrigins = [...new Set(externalOrigins)].sort();
	expect(uniqueOrigins).toEqual(
		['https://imagery.nationalmap.gov', 'https://nominatim.openstreetmap.org'].sort()
	);
});

test('NAIP clean-map pipeline: "Use this preview as-is" commits the single reference image without tiling', async ({
	page
}) => {
	await gotoApp(page);

	await page.route(NAIP_PATTERN, async (route) => {
		await route.fulfill({ status: 200, contentType: 'image/png', body: pngPayload(2048, 2048) });
	});

	await page.getByTestId('naip-lat').fill('33.1255198');
	await page.getByTestId('naip-lon').fill('-96.8610387');
	await page.getByTestId('naip-fetch-button').click();
	await expect(page.getByTestId('naip-preview')).toBeVisible();

	await page.getByTestId('naip-use').click();
	await expect(page.getByTestId('pane-filename-target-basemap')).toHaveText('naip-aerial.png');
	await expect(page.getByTestId('naip-preview')).toBeHidden();
});
