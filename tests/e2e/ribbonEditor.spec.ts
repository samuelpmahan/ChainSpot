import { deflateSync } from 'node:zlib';
import { expect, test } from '@playwright/test';
import type { Locator } from '@playwright/test';

function crc32(bytes: Uint8Array): number {
	let crc = 0xffffffff;
	for (const byte of bytes) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
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
			raw[offset] = 80;
			raw[offset + 1] = 100;
			raw[offset + 2] = 120;
		}
	}
	const chunk = (type: string, data: Buffer): Buffer => {
		const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
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

interface ViewState {
	zoom: number;
	panX: number;
	panY: number;
}

async function viewState(viewport: Locator): Promise<ViewState> {
	return {
		zoom: Number(await viewport.getAttribute('data-view-zoom')),
		panX: Number(await viewport.getAttribute('data-view-pan-x')),
		panY: Number(await viewport.getAttribute('data-view-pan-y'))
	};
}

function screenAt(
	box: { x: number; y: number },
	view: ViewState,
	xPx: number,
	yPx: number
): { x: number; y: number } {
	return {
		x: box.x + view.panX + xPx * view.zoom,
		y: box.y + view.panY + yPx * view.zoom
	};
}

test('ribbon editor uses shared viewport navigation and guarded point placement', async ({ page }) => {
	await page.goto('/ribbon-editor');
	await page.waitForFunction(() => document.documentElement.dataset.appReady === 'true');
	await page.getByTestId('ribbon-source-input').setInputFiles({
		name: 'course.png',
		mimeType: 'image/png',
		buffer: pngPayload(400, 300)
	});

	const viewport = page.getByTestId('ribbon-viewport');
	await expect(viewport).toBeVisible();
	await expect(page.getByTestId('ribbon-counts')).toHaveText('L 0 · R 0');
	const box = await viewport.boundingBox();
	if (!box) throw new Error('Ribbon viewport has no layout box.');

	let view = await viewState(viewport);
	await page.mouse.click(...Object.values(screenAt(box, view, 100, 100)) as [number, number]);
	await expect(page.getByTestId('ribbon-counts')).toHaveText('L 0 · R 0');

	await page.keyboard.down('Control');
	await page.mouse.click(...Object.values(screenAt(box, view, 100, 100)) as [number, number]);
	await page.keyboard.up('Control');
	await expect(page.getByTestId('ribbon-counts')).toHaveText('L 1 · R 0');

	const zoomBefore = Number(await viewport.getAttribute('data-view-zoom'));
	await page.mouse.move(...Object.values(screenAt(box, view, 200, 100)) as [number, number]);
	await page.mouse.wheel(0, -100);
	const zoomAfter = Number(await viewport.getAttribute('data-view-zoom'));
	expect(zoomAfter).toBeGreaterThan(zoomBefore);

	view = await viewState(viewport);
	await page.mouse.move(box.x + 12, box.y + 12);
	await page.mouse.down();
	await page.mouse.move(box.x + 42, box.y + 32, { steps: 4 });
	await page.mouse.up();
	const panned = await viewState(viewport);
	expect(panned.panX).not.toBe(view.panX);
	expect(panned.panY).not.toBe(view.panY);

	const pointBox = await viewport.locator('circle').first().boundingBox();
	if (!pointBox) throw new Error('Ribbon vertex has no layout box.');
	const pointBefore = {
		x: pointBox.x + pointBox.width / 2,
		y: pointBox.y + pointBox.height / 2
	};
	await page.mouse.move(pointBefore.x, pointBefore.y);
	await page.mouse.down();
	await page.mouse.move(pointBefore.x + 32, pointBefore.y + 18, { steps: 5 });
	await page.mouse.up();
	await expect(page.getByTestId('ribbon-selected')).not.toContainText('100.0, 100.0 px');
});
