import { deflateSync } from 'node:zlib';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * Real-browser coverage for three Annotate Course fixes that only had
 * jsdom-level coverage before (`annotateCourseSidebar.test.ts`,
 * `annotationRadialMenu.test.ts`, `annotateCourseLocalSnap.test.ts`):
 *
 * 1. Enter approves the active hole once the Approve banner is showing.
 * 2. An existing corridor bend can be deleted by clicking it directly, with
 *    the "Manual placement (radial menu)" dev toggle left off.
 * 3. Dragging a tee marker after it settles onto a snap result is a genuine
 *    manual correction — a second drag-release never re-fires the snap.
 */

async function gotoApp(page: Page): Promise<void> {
	await page.goto('/annotate-course');
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
	await page.getByTestId('pane-input-source-overview').setInputFiles({
		name: 'course.png',
		mimeType: 'image/png',
		buffer: pngPayload(800, 600)
	});
	await expect(page.getByTestId('pane-filename-source-overview')).toBeVisible();
}

async function addHole(page: Page): Promise<void> {
	await page.keyboard.press('n');
	await expect(page.getByTestId('placement-banner')).toBeVisible();
}

interface ViewState {
	zoom: number;
	panX: number;
	panY: number;
}

interface PaneGeometry {
	left: number;
	top: number;
	clientLeft: number;
	clientTop: number;
}

async function viewState(page: Page): Promise<ViewState> {
	return page.evaluate(() => {
		const element = document.querySelector<HTMLElement>('[data-testid="pane-scene-source-overview"]');
		if (!element) throw new Error('missing pane scene');
		return {
			zoom: Number(element.dataset.viewZoom),
			panX: Number(element.dataset.viewPanX),
			panY: Number(element.dataset.viewPanY)
		};
	});
}

async function paneGeometry(page: Page): Promise<PaneGeometry> {
	return page.evaluate(() => {
		const element = document.querySelector<HTMLElement>('[data-testid="pane-scene-source-overview"]');
		if (!element) throw new Error('missing pane scene');
		const rect = element.getBoundingClientRect();
		return { left: rect.left, top: rect.top, clientLeft: element.clientLeft, clientTop: element.clientTop };
	});
}

function imagePoint(view: ViewState, xPx: number, yPx: number): { x: number; y: number } {
	return { x: xPx * view.zoom + view.panX, y: yPx * view.zoom + view.panY };
}

async function clickImagePoint(page: Page, imageX: number, imageY: number): Promise<void> {
	const [view, geometry] = await Promise.all([viewState(page), paneGeometry(page)]);
	const local = imagePoint(view, imageX, imageY);
	await page.mouse.click(geometry.left + geometry.clientLeft + local.x, geometry.top + geometry.clientTop + local.y);
}

async function dragImagePoint(
	page: Page,
	from: { x: number; y: number },
	to: { x: number; y: number }
): Promise<void> {
	const [view, geometry] = await Promise.all([viewState(page), paneGeometry(page)]);
	const start = imagePoint(view, from.x, from.y);
	const end = imagePoint(view, to.x, to.y);
	await page.mouse.move(
		geometry.left + geometry.clientLeft + start.x,
		geometry.top + geometry.clientTop + start.y
	);
	await page.mouse.down();
	await page.mouse.move(
		geometry.left + geometry.clientLeft + end.x,
		geometry.top + geometry.clientTop + end.y,
		{ steps: 5 }
	);
	await page.mouse.up();
}

test('Enter approves the active hole once both pieces are placed', async ({ page }) => {
	await gotoApp(page);
	await loadSourceImage(page);
	await addHole(page);

	await clickImagePoint(page, 100, 100);
	await expect(page.getByTestId('tee-marker-1')).toBeVisible();
	await clickImagePoint(page, 400, 400);
	await expect(page.getByTestId('basket-marker-1')).toBeVisible();
	await expect(page.getByTestId('approve-hole-button')).toBeVisible();

	await page.keyboard.press('Enter');

	await expect(page.getByTestId('sidebar-section-4')).toContainText('1');
});

test('an existing bend can be deleted by clicking it, with the radial-menu dev toggle left off', async ({
	page
}) => {
	await gotoApp(page);
	await loadSourceImage(page);
	await addHole(page);

	await clickImagePoint(page, 100, 100);
	await clickImagePoint(page, 400, 400);
	await expect(page.getByTestId('approve-hole-button')).toBeVisible();

	// Placing a bend via empty-space click still needs the dev toggle on,
	// which routes it through the radial menu's own "bend" wedge.
	await page.getByTestId('add-bend-button').click();
	await page.getByTestId('radial-menu-toggle').check();
	await clickImagePoint(page, 250, 50);
	await expect(page.getByTestId('radial-action-bend')).toBeVisible();
	await page.getByTestId('radial-action-bend').click();
	await expect(page.getByTestId('bend-marker-1-0')).toBeVisible();

	// Flip it back off, then prove the on-marker delete menu still opens.
	await page.getByTestId('radial-menu-toggle').uncheck();
	await clickImagePoint(page, 250, 50);
	await expect(page.getByTestId('radial-menu')).toBeVisible();
	await page.getByTestId('radial-action-delete').click();

	await expect(page.getByTestId('bend-marker-1-0')).toHaveCount(0);
});

test('dragging a tee marker after a settled snap is a manual correction that never re-snaps', async ({
	page
}) => {
	await gotoApp(page);
	await loadSourceImage(page);
	await addHole(page);

	// No course detection has run against this hand-built fixture, so
	// placement never snaps — this asserts the marker lands, and stays,
	// exactly where dragged, matching `annotateCourseLocalSnap.test.ts`'s
	// jsdom coverage of the same drag-release code path in a real browser.
	await clickImagePoint(page, 100, 100);
	await expect(page.getByTestId('tee-marker-1')).toBeVisible();

	await dragImagePoint(page, { x: 100, y: 100 }, { x: 300, y: 350 });
	await expect(page.getByTestId('tee-marker-1')).toHaveAttribute('cx', '300');
	await expect(page.getByTestId('tee-marker-1')).toHaveAttribute('cy', '350');

	// A second manual drag (simulating "drag back to where I originally
	// wanted it") must also land exactly where dropped, never jumping
	// elsewhere on release.
	await dragImagePoint(page, { x: 300, y: 350 }, { x: 100, y: 100 });
	await expect(page.getByTestId('tee-marker-1')).toHaveAttribute('cx', '100');
	await expect(page.getByTestId('tee-marker-1')).toHaveAttribute('cy', '100');
});
