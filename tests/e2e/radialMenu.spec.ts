import { deflateSync } from 'node:zlib';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * Browser coverage for the accessible HTML-popover radial menu itself
 * (RadialMenu.svelte), as opposed to holeAnnotation.spec.ts's coverage of the
 * hole-annotation workflow it's used inside. Three things the previous
 * SVG/geometric-hit-test implementation could not do at all:
 *
 * - stay fully on-screen (and reachable) when opened near a pane edge/corner,
 * - open, navigate, and choose an action with the keyboard alone,
 * - close via Escape without ever placing anything.
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

/**
 * Loads a source image and returns both the pane (`.image-viewport`, the
 * `overflow: hidden` element the previous implementation clipped wedges
 * against — "the viewport bounds" the clamping requirement means) and the
 * rendered image frame's own box. `fit()` centers the image inside the pane
 * and may letterbox one axis, so click coordinates are computed from the
 * frame (guaranteed to land on the image) while on-screen containment is
 * always asserted against the pane.
 */
async function loadHoleWithImage(
	page: Page
): Promise<{
	pane: import('@playwright/test').Locator;
	box: { x: number; y: number; width: number; height: number };
}> {
	await page.goto('/annotate-round');
	await page.waitForFunction(() => document.documentElement.dataset.appReady === 'true');
	await page.getByTestId('pane-input-source-overview').setInputFiles({
		name: 'course.png',
		mimeType: 'image/png',
		buffer: pngPayload(1000, 1000)
	});
	await page.waitForSelector('[data-testid="hole-annotation"]');
	await page.getByTestId('hole-add').click();
	const pane = page.getByTestId('pane-scene-source-overview');
	const frame = page.getByTestId('annotation-frame');
	await frame.scrollIntoViewIfNeeded();
	await page.waitForFunction(() => {
		const img = document.querySelector('.annotation-image');
		return img instanceof HTMLImageElement && img.complete && img.naturalWidth > 0;
	});
	const box = await frame.boundingBox();
	if (!box) throw new Error('annotation frame has no bounding box');
	return { pane, box };
}

test('the radial menu opened near a pane corner keeps every action button fully on-screen and clickable', async ({
	page
}) => {
	const { pane, box } = await loadHoleWithImage(page);

	// Near the image frame's own top-left corner (guaranteed to land on the
	// image, unlike the pane's corner, which `fit()` may letterbox away from
	// the image) — close enough to the pane's edges that the ring's natural
	// ~60px reach in every direction would spill off two edges at once if it
	// weren't clamped.
	await page.mouse.click(box.x + 12, box.y + 12);
	await expect(page.getByTestId('radial-menu')).toBeVisible();

	const paneBox = await pane.boundingBox();
	if (!paneBox) throw new Error('pane has no bounding box');

	const buttons = page.locator('[data-testid^="radial-action-"]');
	const count = await buttons.count();
	expect(count).toBeGreaterThan(0);

	for (let index = 0; index < count; index += 1) {
		const button = buttons.nth(index);
		await expect(button).toBeVisible();
		const buttonBox = await button.boundingBox();
		if (!buttonBox) throw new Error('radial action button has no bounding box');
		expect(buttonBox.x).toBeGreaterThanOrEqual(paneBox.x - 0.5);
		expect(buttonBox.y).toBeGreaterThanOrEqual(paneBox.y - 0.5);
		expect(buttonBox.x + buttonBox.width).toBeLessThanOrEqual(paneBox.x + paneBox.width + 0.5);
		expect(buttonBox.y + buttonBox.height).toBeLessThanOrEqual(paneBox.y + paneBox.height + 0.5);
	}

	// Every button is genuinely clickable, not just visually present — the bug
	// being killed is that a clipped wedge used to be geometrically
	// unreachable even though it was still drawn.
	await buttons.first().click();
	await expect(page.getByTestId('radial-menu')).toHaveCount(0);
});

test('the radial menu opened at each of the four pane corners stays fully on-screen', async ({ page }) => {
	const { pane, box } = await loadHoleWithImage(page);
	const inset = 12;
	const corners = [
		{ x: box.x + inset, y: box.y + inset },
		{ x: box.x + box.width - inset, y: box.y + inset },
		{ x: box.x + inset, y: box.y + box.height - inset },
		{ x: box.x + box.width - inset, y: box.y + box.height - inset }
	];

	for (const corner of corners) {
		await page.mouse.click(corner.x, corner.y);
		await expect(page.getByTestId('radial-menu')).toBeVisible();
		const paneBox = await pane.boundingBox();
		if (!paneBox) throw new Error('pane has no bounding box');
		const buttons = page.locator('[data-testid^="radial-action-"]');
		const count = await buttons.count();
		for (let index = 0; index < count; index += 1) {
			const buttonBox = await buttons.nth(index).boundingBox();
			if (!buttonBox) throw new Error('radial action button has no bounding box');
			expect(buttonBox.x).toBeGreaterThanOrEqual(paneBox.x - 0.5);
			expect(buttonBox.y).toBeGreaterThanOrEqual(paneBox.y - 0.5);
			expect(buttonBox.x + buttonBox.width).toBeLessThanOrEqual(paneBox.x + paneBox.width + 0.5);
			expect(buttonBox.y + buttonBox.height).toBeLessThanOrEqual(paneBox.y + paneBox.height + 0.5);
		}
		// Escape between corners so the next click opens a fresh menu rather
		// than being interpreted as a click on the still-open one.
		await page.keyboard.press('Escape');
		await expect(page.getByTestId('radial-menu')).toHaveCount(0);
	}
});

test('the radial menu is fully keyboard-operable: open, arrow to an action, Enter places it', async ({ page }) => {
	const { box } = await loadHoleWithImage(page);

	await page.mouse.click(box.x + 100, box.y + 100);
	await expect(page.getByTestId('radial-menu')).toBeVisible();

	// Focus moved into the menu on open, onto the first action (roving tabindex).
	const firstAction = page.locator('[data-testid^="radial-action-"]').first();
	await expect(firstAction).toBeFocused();

	// Cycle to the second action and confirm the roving tabindex followed focus.
	await page.keyboard.press('ArrowRight');
	const secondAction = page.locator('[data-testid^="radial-action-"]').nth(1);
	await expect(secondAction).toBeFocused();
	await expect(secondAction).toHaveAttribute('tabindex', '0');
	await expect(firstAction).toHaveAttribute('tabindex', '-1');

	const targetKind = await secondAction.getAttribute('data-testid');
	const kind = targetKind?.replace('radial-action-', '');
	if (!kind) throw new Error('missing target action testid');

	await page.keyboard.press('Enter');
	await expect(page.getByTestId('radial-menu')).toHaveCount(0);
	await expect(page.getByTestId(`${kind}-marker-1`)).toBeVisible();

	// Keyboard operability continues past the placement: focus lands back on
	// the (programmatically focusable) viewport rather than the page body.
	await expect(page.getByTestId('pane-scene-source-overview')).toBeFocused();
});

test('Home and End jump to the first and last action in radial order', async ({ page }) => {
	const { box } = await loadHoleWithImage(page);

	await page.mouse.click(box.x + 150, box.y + 150);
	await expect(page.getByTestId('radial-menu')).toBeVisible();

	const actions = page.locator('[data-testid^="radial-action-"]');
	const count = await actions.count();

	await page.keyboard.press('End');
	await expect(actions.nth(count - 1)).toBeFocused();

	await page.keyboard.press('Home');
	await expect(actions.first()).toBeFocused();
});

test('Escape closes the radial menu without placing anything', async ({ page }) => {
	const { box } = await loadHoleWithImage(page);

	await page.mouse.click(box.x + 80, box.y + 80);
	await expect(page.getByTestId('radial-menu')).toBeVisible();

	await page.keyboard.press('Escape');
	await expect(page.getByTestId('radial-menu')).toHaveCount(0);

	await expect(page.getByTestId('tee-marker-1')).toHaveCount(0);
	await expect(page.getByTestId('basket-marker-1')).toHaveCount(0);
	await expect(page.getByTestId('shot-marker-1-0')).toHaveCount(0);
	await expect(page.getByTestId('bend-marker-1-0')).toHaveCount(0);
	await expect(page.getByTestId('hole-select-1')).toContainText('no tee');

	// Focus returns to the viewport, so the next Escape-then-place cycle can
	// continue without the user having to hunt for focus manually.
	await expect(page.getByTestId('pane-scene-source-overview')).toBeFocused();
});
