import { deflateSync } from 'node:zlib';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { radialWedges } from '../../src/lib/radialMenu';

// Must match the RADIAL_HUB_RADIUS_PX / RADIAL_OUTER_RADIUS_PX constants in
// +page.svelte — there is no shared export, since they're page-local tuning.
const RADIAL_HUB_RADIUS_PX = 20;
const RADIAL_OUTER_RADIUS_PX = 62;

type PointKind = 'tee' | 'basket' | 'shot' | 'bend';

/** The wedges a fresh radial menu offers for empty space, given what's already on the hole — mirrors +page.svelte's radialMenuActions(). */
function availableKinds(hasTee: boolean, hasBasket: boolean): PointKind[] {
	const kinds: PointKind[] = [];
	if (!hasTee) kinds.push('tee');
	if (!hasBasket) kinds.push('basket');
	kinds.push('shot', 'bend');
	return kinds;
}

/** Clicks (x, y) to open the radial menu, then clicks the wedge for `kind` among `kinds`. */
async function placePoint(page: Page, x: number, y: number, kind: PointKind, kinds: PointKind[]): Promise<void> {
	await page.mouse.click(x, y);
	const layout = radialWedges(kinds.length, { hubRadius: RADIAL_HUB_RADIUS_PX, outerRadius: RADIAL_OUTER_RADIUS_PX });
	const index = kinds.indexOf(kind);
	if (index === -1) throw new Error(`${kind} is not offered among ${kinds.join(', ')}`);
	const wedge = layout.wedges[index];
	await page.mouse.click(x + wedge.labelX, y + wedge.labelY);
}

/**
 * End-to-end coverage for the full "clean hole construction" flow: annotate a
 * hole in Annotate Round (tee, basket, a shot, a bend), hand off to
 * Create Graphics, load a clean target and create correspondence pairs so
 * alignment succeeds, then build and download the resulting clean hole
 * graphic. Each stage (hole annotation, alignment estimation, hole-graphic
 * planning/rendering) already has its own unit coverage; what's new and
 * untested here is that the three actually compose correctly end to end.
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

function pngPayload(width: number, height: number, r: number, g: number, b: number): Buffer {
	const rowSize = width * 3 + 1;
	const raw = Buffer.alloc(rowSize * height);
	for (let y = 0; y < height; y += 1) {
		raw[y * rowSize] = 0;
		for (let x = 0; x < width; x += 1) {
			const offset = y * rowSize + 1 + x * 3;
			raw[offset] = r;
			raw[offset + 1] = g;
			raw[offset + 2] = b;
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

interface PaneGeometry {
	left: number;
	top: number;
	clientLeft: number;
	clientTop: number;
}

interface ViewState {
	zoom: number;
	panX: number;
	panY: number;
}

async function paneGeometry(page: Page, role: string): Promise<PaneGeometry> {
	return page.evaluate((paneRole) => {
		const element = document.querySelector<HTMLElement>(`[data-testid="pane-scene-${paneRole}"]`);
		if (!element) throw new Error(`missing pane ${paneRole}`);
		const rect = element.getBoundingClientRect();
		return { left: rect.left, top: rect.top, clientLeft: element.clientLeft, clientTop: element.clientTop };
	}, role);
}

async function viewState(page: Page, role: string): Promise<ViewState> {
	return page.evaluate((paneRole) => {
		const element = document.querySelector<HTMLElement>(`[data-testid="pane-scene-${paneRole}"]`);
		if (!element) throw new Error(`missing pane ${paneRole}`);
		return {
			zoom: Number(element.dataset.viewZoom),
			panX: Number(element.dataset.viewPanX),
			panY: Number(element.dataset.viewPanY)
		};
	}, role);
}

function panePoint(geometry: PaneGeometry, x: number, y: number): { x: number; y: number } {
	return { x: geometry.left + geometry.clientLeft + x, y: geometry.top + geometry.clientTop + y };
}

function imagePoint(view: ViewState, xPx: number, yPx: number): { x: number; y: number } {
	return { x: xPx * view.zoom + view.panX, y: yPx * view.zoom + view.panY };
}

async function createPair(
	page: Page,
	sourcePoint: { xPx: number; yPx: number },
	targetPoint: { xPx: number; yPx: number }
): Promise<void> {
	await page.getByTestId('pane-scene-source-overview').scrollIntoViewIfNeeded();
	const sourceGeometry = await paneGeometry(page, 'source-overview');
	const targetGeometry = await paneGeometry(page, 'target-basemap');
	const sourceView = await viewState(page, 'source-overview');
	const targetView = await viewState(page, 'target-basemap');
	const sourceLocal = imagePoint(sourceView, sourcePoint.xPx, sourcePoint.yPx);
	const targetLocal = imagePoint(targetView, targetPoint.xPx, targetPoint.yPx);
	await page.getByTestId('add-correspondence').click();
	const sourceScreen = panePoint(sourceGeometry, sourceLocal.x, sourceLocal.y);
	const targetScreen = panePoint(targetGeometry, targetLocal.x, targetLocal.y);
	await page.mouse.click(sourceScreen.x, sourceScreen.y);
	await expect(page.getByTestId('app-shell')).toHaveAttribute('data-correspondence-mode', 'add-target');
	await page.mouse.click(targetScreen.x, targetScreen.y);
	await expect(page.getByTestId('app-shell')).toHaveAttribute('data-correspondence-mode', 'neutral');
}

test('clean hole construction: annotate a hole, align, build and download the resulting clean graphic', async ({
	page
}) => {
	// 1. Annotate Round: place a fully-featured hole (tee, basket, one shot, a bend).
	await page.goto('/annotate-round');
	await page.waitForFunction(() => document.documentElement.dataset.appReady === 'true');
	await page.getByTestId('pane-input-source-overview').setInputFiles({
		name: 'course.png',
		mimeType: 'image/png',
		buffer: pngPayload(800, 600, 80, 120, 60)
	});
	await page.waitForSelector('[data-testid="hole-annotation"]');
	await page.getByTestId('hole-add').click();
	const frame = page.getByTestId('annotation-frame');
	await frame.scrollIntoViewIfNeeded();
	await page.waitForFunction(() => {
		const img = document.querySelector('.annotation-image');
		return img instanceof HTMLImageElement && img.complete && img.naturalWidth > 0;
	});
	const box = await frame.boundingBox();
	if (!box) throw new Error('annotation frame has no bounding box');

	await placePoint(page, box.x + 50, box.y + 50, 'tee', availableKinds(false, false));
	await placePoint(page, box.x + 400, box.y + 300, 'basket', availableKinds(true, false));
	await placePoint(page, box.x + 200, box.y + 150, 'shot', availableKinds(true, true));
	await placePoint(page, box.x + 230, box.y + 180, 'bend', availableKinds(true, true)); // one dogleg bend

	await page.getByTestId('annotate-done').click();
	await page.waitForURL('**/create-graphics');

	// 2. The annotated source auto-imports; load a clean target and align.
	await expect(page.getByTestId('pane-filename-source-overview')).toHaveText('course.png');
	await page.getByTestId('pane-input-target-basemap').setInputFiles({
		name: 'clean.png',
		mimeType: 'image/png',
		buffer: pngPayload(1000, 800, 60, 90, 40)
	});
	await createPair(page, { xPx: 50, yPx: 50 }, { xPx: 100, yPx: 100 });
	await createPair(page, { xPx: 700, yPx: 500 }, { xPx: 900, yPx: 700 });
	await expect(page.getByTestId('alignment-summary')).toContainText('similarity transform from 2 pairs');

	// 3. Exactly one buildable plan (the fully-annotated hole). Its preview
	// renders live, with no explicit "build" step, framed to the hole's own
	// bounding box (with padding), not the full 1000x800 target.
	await page.getByTestId('hole-graphics').scrollIntoViewIfNeeded();
	await page.waitForSelector('[data-testid="hole-graphic-preview-1"]');

	const viewBox = await page.evaluate(() => {
		const svg = document.querySelector('[data-testid="hole-graphic-preview-1"] svg');
		return svg?.getAttribute('viewBox') ?? null;
	});
	expect(viewBox).not.toBeNull();
	const [, , cropWidth, cropHeight] = (viewBox as string).split(' ').map(Number);
	expect(cropWidth).toBeGreaterThan(0);
	expect(cropHeight).toBeGreaterThan(0);
	expect(cropWidth).toBeLessThan(1000);
	expect(cropHeight).toBeLessThan(800);

	// 4. Downloading renders the same geometry to a real PNG on demand.
	const downloadPromise = page.waitForEvent('download');
	await page.getByTestId('hole-graphic-download-1').click();
	const download = await downloadPromise;
	expect(download.suggestedFilename()).toBe('hole-1.png');
	const stream = await download.createReadStream();
	const chunks: Buffer[] = [];
	for await (const chunk of stream) chunks.push(chunk);
	const bytes = Buffer.concat(chunks);
	expect(bytes.length).toBeGreaterThan(0);
	expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])); // PNG signature

	// 5. The batch zip download bundles the same hole under hole-01.png.
	const zipDownloadPromise = page.waitForEvent('download');
	await page.getByTestId('download-all-hole-graphics').click();
	const zipDownload = await zipDownloadPromise;
	expect(zipDownload.suggestedFilename()).toBe('hole-graphics.zip');
});
