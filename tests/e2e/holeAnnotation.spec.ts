import { deflateSync } from 'node:zlib';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * Browser coverage for Annotate Round's hole-annotation workflow: adding holes,
 * placing tee/basket/shot/corridor points by click, per-hole correction (remove
 * last shot/corridor point, clear corridor), switching the active hole without
 * cross-contaminating another hole's points, the Done-time corridor-length
 * validation surfacing as a page error instead of crashing, and the resulting
 * AnnotatedRound handing off to Create Graphics once corrected.
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

function pngPayload(width: number, height: number): Buffer {
	const rowSize = width * 3 + 1;
	const raw = Buffer.alloc(rowSize * height);
	for (let y = 0; y < height; y += 1) {
		raw[y * rowSize] = 0;
		for (let x = 0; x < width; x += 1) {
			const offset = y * rowSize + 1 + x * 3;
			raw[offset] = 80;
			raw[offset + 1] = 120;
			raw[offset + 2] = 60;
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

async function loadSourceImage(page: Page): Promise<void> {
	await page.goto('/annotate-round');
	await page.waitForFunction(() => document.documentElement.dataset.appReady === 'true');
	await page.getByTestId('pane-input-source-overview').setInputFiles({
		name: 'course.png',
		mimeType: 'image/png',
		buffer: pngPayload(800, 600)
	});
	await page.waitForSelector('[data-testid="hole-annotation"]');
}

/** The annotation frame renders below the fold on a short viewport; scroll it into view first, matching how a real user would interact with it, before reading its box or clicking inside it. */
async function annotationFrameBox(page: Page) {
	await page.getByTestId('hole-add').click();
	const frame = page.getByTestId('annotation-frame');
	await frame.scrollIntoViewIfNeeded();
	await page.waitForFunction(() => {
		const img = document.querySelector('.annotation-image');
		return img instanceof HTMLImageElement && img.complete && img.naturalWidth > 0;
	});
	const box = await frame.boundingBox();
	if (!box) throw new Error('annotation frame has no bounding box');
	return { frame, box };
}

test('hole annotation: place tee/basket/shots/corridor by click, correct with remove-last controls, no cross-contamination between holes', async ({
	page
}) => {
	await loadSourceImage(page);
	const { box } = await annotationFrameBox(page);

	// Tee is the default placement mode.
	await page.mouse.click(box.x + 50, box.y + 50);
	await expect(page.getByTestId('tee-marker-1')).toBeVisible();
	await expect(page.getByTestId('hole-select-1')).toContainText('tee');

	await page.getByTestId('placement-mode-basket').check();
	await page.mouse.click(box.x + 300, box.y + 250);
	await expect(page.getByTestId('basket-marker-1')).toBeVisible();

	await page.getByTestId('placement-mode-shot').check();
	await page.mouse.click(box.x + 120, box.y + 100);
	await page.mouse.click(box.x + 200, box.y + 160);
	await expect(page.getByTestId('shot-marker-1-1')).toBeVisible();
	await expect(page.getByTestId('hole-select-1')).toContainText('2 shots');

	await page.getByTestId('placement-mode-corridor').check();
	await page.mouse.click(box.x + 20, box.y + 20);
	await page.mouse.click(box.x + 350, box.y + 20);
	await page.mouse.click(box.x + 200, box.y + 280);
	await expect(page.getByTestId('hole-select-1')).toContainText('corridor (3)');

	// Corrections: remove the last shot and the last corridor point.
	await page.getByTestId('remove-last-shot').click();
	await page.getByTestId('remove-last-corridor-point').click();
	await expect(page.getByTestId('hole-select-1')).toContainText('1 shot');
	await expect(page.getByTestId('hole-select-1')).toContainText('corridor (2)');
	await expect(page.getByTestId('hole-select-1')).not.toContainText('2 shots');

	// A second hole must not see hole 1's points, and placing on hole 2 must not
	// touch hole 1's already-placed tee.
	await page.getByTestId('hole-add').click();
	await expect(page.getByTestId('annotate-round')).toHaveAttribute('data-hole-count', '2');
	await page.getByTestId('placement-mode-tee').check();
	await page.mouse.click(box.x + 60, box.y + 60);
	await expect(page.getByTestId('tee-marker-2')).toBeVisible();
	await expect(page.getByTestId('tee-marker-1')).toBeVisible();
	await expect(page.getByTestId('basket-marker-2')).toHaveCount(0);
});

test('hole annotation: an incomplete corridor blocks Done with a specific error instead of crashing, and clearing it unblocks the handoff', async ({
	page
}) => {
	await loadSourceImage(page);
	const { box } = await annotationFrameBox(page);

	await page.getByTestId('placement-mode-corridor').check();
	await page.mouse.click(box.x + 20, box.y + 20);
	await page.mouse.click(box.x + 100, box.y + 20);
	await expect(page.getByTestId('hole-select-1')).toContainText('corridor (2)');

	await page.getByTestId('annotate-done').click();
	await expect(page.getByTestId('annotate-done-error')).toContainText('hole 1 corridor must have at least 3 vertices, got 2');

	// Clearing the incomplete corridor unblocks Done, and the round hands off to
	// Create Graphics as normal (source image intact, no crash from the earlier
	// failed attempt).
	await page.getByTestId('clear-corridor').click();
	await page.getByTestId('annotate-done').click();
	await page.waitForURL('**/create-graphics');
	await expect(page.getByTestId('pane-filename-source-overview')).toHaveText('course.png');
});
