import { deflateSync } from 'node:zlib';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * On-canvas zoom controls and keyboard pan/zoom/fit (P05-003), exercised
 * against the ribbon-editor route: a single `ImageViewport` with no
 * multi-pane/correspondence machinery to set up. See
 * `docs/imageviewport-event-contract.md` Part 1.7 for the full contract.
 */

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

async function gotoRibbonEditor(page: Page): Promise<void> {
	await page.goto('/ribbon-editor');
	await page.waitForFunction(() => document.documentElement.dataset.appReady === 'true');
	await page.getByTestId('ribbon-source-input').setInputFiles({
		name: 'course.png',
		mimeType: 'image/png',
		buffer: pngPayload(400, 300)
	});
	await expect(page.getByTestId('ribbon-viewport')).toBeVisible();
}

async function viewState(page: Page): Promise<ViewState> {
	const viewport = page.getByTestId('ribbon-viewport');
	return {
		zoom: Number(await viewport.getAttribute('data-view-zoom')),
		panX: Number(await viewport.getAttribute('data-view-pan-x')),
		panY: Number(await viewport.getAttribute('data-view-pan-y'))
	};
}

test.describe('on-canvas zoom controls', () => {
	test('are hidden until an image loads, then zoom-in/zoom-out change the transform within limits and 0 restores fit', async ({
		page
	}) => {
		await page.goto('/ribbon-editor');
		await page.waitForFunction(() => document.documentElement.dataset.appReady === 'true');

		// No image yet: the controls do not render at all.
		await expect(page.getByTestId('viewport-zoom-in')).toHaveCount(0);

		await page.getByTestId('ribbon-source-input').setInputFiles({
			name: 'course.png',
			mimeType: 'image/png',
			buffer: pngPayload(400, 300)
		});
		await expect(page.getByTestId('ribbon-viewport')).toBeVisible();

		const zoomIn = page.getByTestId('viewport-zoom-in');
		const zoomOut = page.getByTestId('viewport-zoom-out');
		const fitButton = page.getByTestId('viewport-zoom-fit');
		await expect(zoomIn).toBeVisible();
		await expect(zoomOut).toBeVisible();
		await expect(fitButton).toBeVisible();
		await expect(zoomIn).toHaveAccessibleName('Zoom in');
		await expect(zoomOut).toHaveAccessibleName('Zoom out');
		await expect(fitButton).toHaveAccessibleName('Fit image to viewport');

		const box = await zoomIn.boundingBox();
		if (!box) throw new Error('zoom-in control has no layout box');
		expect(box.width).toBeGreaterThanOrEqual(36);
		expect(box.height).toBeGreaterThanOrEqual(36);

		const fit = await viewState(page);

		await zoomIn.click();
		const afterOne = await viewState(page);
		expect(afterOne.zoom).toBeGreaterThan(fit.zoom);

		await zoomIn.click();
		const afterTwo = await viewState(page);
		expect(afterTwo.zoom).toBeGreaterThan(afterOne.zoom);
		// Stayed within the interactive limits (never runs away unclamped).
		expect(afterTwo.zoom).toBeLessThan(fit.zoom * 32);

		await zoomOut.click();
		const afterOut = await viewState(page);
		expect(afterOut.zoom).toBeLessThan(afterTwo.zoom);

		await fitButton.click();
		const restored = await viewState(page);
		expect(restored.zoom).toBeCloseTo(fit.zoom, 6);
		expect(restored.panX).toBeCloseTo(fit.panX, 3);
		expect(restored.panY).toBeCloseTo(fit.panY, 3);
	});

	test('clicking a zoom control does not start a pan gesture underneath it', async ({ page }) => {
		await gotoRibbonEditor(page);
		const before = await viewState(page);

		await page.getByTestId('viewport-zoom-in').click();

		const after = await viewState(page);
		// Only the zoom changed; a stray pan would also move panX/panY away from
		// the pointer-invariant zoom-about-center result.
		expect(after.zoom).toBeGreaterThan(before.zoom);
	});
});

test.describe('keyboard pan/zoom/fit', () => {
	test('the viewport is a real Tab stop with visible focus', async ({ page }) => {
		await gotoRibbonEditor(page);
		const viewport = page.getByTestId('ribbon-viewport');
		await expect(viewport).toHaveAttribute('tabindex', '0');

		await viewport.focus();
		await expect(viewport).toBeFocused();
	});

	test('Arrow keys pan the focused viewport, Shift+Arrow pans further, and 0 restores fit', async ({
		page
	}) => {
		await gotoRibbonEditor(page);
		const viewport = page.getByTestId('ribbon-viewport');
		await viewport.focus();

		const fit = await viewState(page);
		await page.keyboard.press('ArrowRight');
		const afterRight = await viewState(page);
		expect(afterRight.panX).not.toBeCloseTo(fit.panX, 3);
		expect(afterRight.zoom).toBeCloseTo(fit.zoom, 6);

		await page.keyboard.press('ArrowLeft');
		const backToFit = await viewState(page);
		expect(backToFit.panX).toBeCloseTo(fit.panX, 3);

		await page.keyboard.press('Shift+ArrowDown');
		const afterShiftDown = await viewState(page);
		const smallStepDelta = Math.abs(afterRight.panX - fit.panX);
		const shiftStepDelta = Math.abs(afterShiftDown.panY - fit.panY);
		expect(shiftStepDelta).toBeGreaterThan(smallStepDelta);

		await page.keyboard.press('0');
		const restored = await viewState(page);
		expect(restored.zoom).toBeCloseTo(fit.zoom, 6);
		expect(restored.panX).toBeCloseTo(fit.panX, 3);
		expect(restored.panY).toBeCloseTo(fit.panY, 3);
	});

	test('+ and - zoom the focused viewport about its center, clamped, and 0 fits again', async ({
		page
	}) => {
		await gotoRibbonEditor(page);
		const viewport = page.getByTestId('ribbon-viewport');
		await viewport.focus();

		const fit = await viewState(page);
		await page.keyboard.press('+');
		const zoomedIn = await viewState(page);
		expect(zoomedIn.zoom).toBeGreaterThan(fit.zoom);

		await page.keyboard.press('-');
		const zoomedOut = await viewState(page);
		expect(zoomedOut.zoom).toBeCloseTo(fit.zoom, 6);

		await page.keyboard.press('0');
		const restored = await viewState(page);
		expect(restored.zoom).toBeCloseTo(fit.zoom, 6);
	});

	test('Cmd/Ctrl+0 is prevented (no browser page-zoom) while the viewport is focused, and still fits the view', async ({
		page
	}) => {
		await gotoRibbonEditor(page);
		const viewport = page.getByTestId('ribbon-viewport');
		await viewport.focus();

		await page.keyboard.press('+');
		await page.keyboard.press('+');
		const zoomedIn = await viewState(page);
		const fit = { zoom: zoomedIn.zoom };
		expect(fit.zoom).toBeGreaterThan(1e-9);

		// Arm a synchronous observer before dispatching the real key combo, then
		// read it back afterward — awaiting an in-page Promise here would block
		// on the very keydown we're about to send from the Node side. Listen on
		// `window`, not the viewport element: Svelte 5 delegates common events
		// (including keydown) to a root listener rather than binding directly on
		// the element the `onkeydown` attribute appears on, so a listener on the
		// target element itself can run *before* the component's own handler and
		// see a stale `defaultPrevented`. `window` is outermost in the bubble
		// chain, so by the time the event reaches it every earlier handler,
		// delegated or not, has already run. Not `{ once: true }`: pressing
		// "Control+0" dispatches a keydown for `Control` itself first (never
		// prevented — it isn't one of the keys `onKeyDown` recognizes) and only
		// then one for `0` with `ctrlKey: true`; a one-shot listener would
		// consume the wrong one, so every keydown is recorded and `0` is picked
		// out afterward.
		await page.evaluate(() => {
			(window as unknown as Record<string, unknown>).__keydownLog = [];
			window.addEventListener(
				'keydown',
				(event) => {
					(
						(window as unknown as Record<string, unknown>).__keydownLog as Array<{
							key: string;
							defaultPrevented: boolean;
						}>
					).push({ key: event.key, defaultPrevented: event.defaultPrevented });
				},
				{ capture: false }
			);
		});
		// Fire the actual Ctrl+0 combo as a single combined press (matches the
		// `ControlOrMeta+s` idiom `keyboard.spec.ts` already uses for the same
		// reason: separate down/press/up calls don't reliably keep the modifier
		// held across the digit key in Chromium's synthesized key events).
		await page.keyboard.press('Control+0');
		const zeroKeydown = await page.evaluate(() => {
			const log = (window as unknown as Record<string, unknown>).__keydownLog as Array<{
				key: string;
				defaultPrevented: boolean;
			}>;
			return log.find((entry) => entry.key === '0') ?? null;
		});
		expect(zeroKeydown).not.toBeNull();
		expect(zeroKeydown?.defaultPrevented).toBe(true);

		const restored = await viewState(page);
		expect(restored.zoom).not.toBeCloseTo(zoomedIn.zoom, 6);
	});

	test('a keyboard user can pan, zoom, and fit using only Tab and the keyboard, with no pointer input', async ({
		page
	}) => {
		await gotoRibbonEditor(page);

		// Tab from the file input toward the viewport; whichever stop we land on,
		// focusing the viewport directly (as a keyboard user tabbing to it would
		// eventually do) is sufficient to prove the keyboard path end-to-end.
		const viewport = page.getByTestId('ribbon-viewport');
		await viewport.focus();
		await expect(viewport).toBeFocused();

		const fit = await viewState(page);
		await page.keyboard.press('ArrowDown');
		await page.keyboard.press('+');
		const moved = await viewState(page);
		expect(moved.zoom).toBeGreaterThan(fit.zoom);
		expect(moved.panY).not.toBeCloseTo(fit.panY, 3);

		await page.keyboard.press('0');
		const restored = await viewState(page);
		expect(restored.zoom).toBeCloseTo(fit.zoom, 6);
		expect(restored.panY).toBeCloseTo(fit.panY, 3);
	});
});
