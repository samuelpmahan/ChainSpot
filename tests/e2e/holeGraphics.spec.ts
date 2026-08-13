import { deflateSync } from 'node:zlib';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

type PointKind = 'tee' | 'basket' | 'shot' | 'bend' | 'walk';

/** Clicks the Map/Round segmented toggle in the toolbar. */
// The toggle sits above the fold; clicking it scrolls the annotation frame
// away, so scroll back to keep previously-measured frame coordinates valid.
async function switchMode(page: Page, mode: 'map' | 'round'): Promise<void> {
	await page.getByTestId(`annotation-mode-${mode}`).click();
	await page.getByTestId('annotation-frame').scrollIntoViewIfNeeded();
}

/**
 * Clicks (x, y) to open the radial menu, then clicks the real button for
 * `kind`. The radial menu is a dev-tools opt-in (off by default — Map mode's
 * default flow places tee/basket/bends directly, with no menu at all), so
 * shot placement in Round mode needs it switched on first.
 */
async function placePoint(page: Page, x: number, y: number, kind: PointKind): Promise<void> {
	const radialToggle = page.getByTestId('radial-menu-toggle');
	if (!(await radialToggle.isChecked())) await radialToggle.check();
	await page.mouse.click(x, y);
	await page.getByTestId(`radial-action-${kind}`).click();
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

/**
 * Uploads a source image and places hole 1's tee + basket through the
 * sidebar-driven flow: selecting hole 1 creates its draft record, and with
 * no piece yet placed the first two map clicks land tee then basket
 * directly (no radial menu) — see `handleAnnotationPlacement` in
 * annotate-round's `+page.svelte`. Returns the annotation frame's bounding
 * box for any further clicks (a shot, a bend) the caller wants to place.
 */
async function placeHoleOneTeeAndBasket(page: Page): Promise<{ x: number; y: number; width: number; height: number }> {
	await page.goto('/annotate-round');
	await page.waitForFunction(() => document.documentElement.dataset.appReady === 'true');
	await page.getByTestId('pane-input-source-overview').setInputFiles({
		name: 'course.png',
		mimeType: 'image/png',
		buffer: pngPayload(800, 600, 80, 120, 60)
	});
	await page.waitForSelector('[data-testid="hole-annotation"]');
	await page.getByTestId('sidebar-hole-1').click();
	const frame = page.getByTestId('annotation-frame');
	await frame.scrollIntoViewIfNeeded();
	await page.waitForFunction(() => {
		const img = document.querySelector('.annotation-image');
		return img instanceof HTMLImageElement && img.complete && img.naturalWidth > 0;
	});
	const box = await frame.boundingBox();
	if (!box) throw new Error('annotation frame has no bounding box');

	await page.mouse.click(box.x + 50, box.y + 50); // tee — hole 1's first missing piece
	await page.mouse.click(box.x + 400, box.y + 300); // basket — its second
	return box;
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
	const box = await placeHoleOneTeeAndBasket(page);
	await switchMode(page, 'round');
	await placePoint(page, box.x + 200, box.y + 150, 'shot');
	await switchMode(page, 'map');
	// placePoint's shot placement switched the radial-menu toggle on, so a
	// bend now goes through the same menu rather than the toggle-off direct
	// placement path (see `handleAnnotationPlacement`'s doc comment). Placed
	// well off the tee-basket line — the floating "Approve Hole 1" button
	// anchors at that line's midpoint and would otherwise eat this click.
	await placePoint(page, box.x + 350, box.y + 50, 'bend'); // one dogleg bend

	await page.getByTestId('annotate-done').click();
	await page.waitForURL('**/create-graphics');

	// 2. The annotated source auto-imports; load a clean target and align. The
	// target is large and the hole's translated position generously centered
	// (offset (600, 600), scale 1, well clear of every edge) so its 16:9,
	// padded camera fits comfortably regardless of exactly where the bend
	// above landed in source-image pixels.
	await expect(page.getByTestId('pane-filename-source-overview')).toHaveText('course.png');
	await page.getByTestId('pane-input-target-basemap').setInputFiles({
		name: 'clean.png',
		mimeType: 'image/png',
		buffer: pngPayload(2400, 1800, 60, 90, 40)
	});
	await createPair(page, { xPx: 50, yPx: 50 }, { xPx: 650, yPx: 650 });
	await createPair(page, { xPx: 700, yPx: 500 }, { xPx: 1300, yPx: 1100 });
	await expect(page.getByTestId('alignment-summary')).toContainText('similarity transform from 2 pairs');

	// 3. Exactly one buildable plan (the fully-annotated hole), and the
	// workspace auto-selects it with no explicit "build" step. The preview is
	// always framed to the canonical 16:9 camera, never the hole's own bbox
	// shape, and stays well inside the full 2400x1800 target.
	await page.getByTestId('hole-graphics').scrollIntoViewIfNeeded();
	await expect(page.getByTestId('hole-thumb-1')).toHaveClass(/active/);
	await page.waitForSelector('[data-testid="hole-graphic-preview-1"]');

	const viewBox = await page.evaluate(() => {
		const svg = document.querySelector('[data-testid="hole-graphic-preview-1"] svg');
		return svg?.getAttribute('viewBox') ?? null;
	});
	expect(viewBox).not.toBeNull();
	const [, , cropWidth, cropHeight] = (viewBox as string).split(' ').map(Number);
	expect(cropWidth).toBeGreaterThan(0);
	expect(cropHeight).toBeGreaterThan(0);
	expect(cropWidth).toBeLessThan(2400);
	expect(cropHeight).toBeLessThan(1800);
	expect(cropWidth / cropHeight).toBeCloseTo(16 / 9, 1);

	// 4. Downloading renders the same geometry to a real PNG on demand.
	const downloadPromise = page.waitForEvent('download');
	await page.getByTestId('hole-graphic-download-selected').click();
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

/**
 * Coverage for the out-of-bounds path this workspace exists to fix: a hole
 * whose transformed geometry doesn't fit inside the clean target at the
 * canonical framing must show a loud, specific message in the preview area —
 * never a silently truncated crop — and must be excluded from both single
 * and batch export.
 */
test('a hole that does not fit inside the clean target shows a loud out-of-bounds message, not a truncated graphic', async ({
	page
}) => {
	await placeHoleOneTeeAndBasket(page);

	await page.getByTestId('annotate-done').click();
	await page.waitForURL('**/create-graphics');

	// A deliberately tiny clean target: this hole's padded, 16:9-framed crop
	// (well over 400px on a side, per the same padding math as the first test)
	// cannot fit inside a 300x200 target regardless of exactly where the two
	// correspondence pairs land, so alignment succeeding here reliably
	// reproduces the "geometry extends past the target's edge" case.
	await expect(page.getByTestId('pane-filename-source-overview')).toHaveText('course.png');
	await page.getByTestId('pane-input-target-basemap').setInputFiles({
		name: 'clean.png',
		mimeType: 'image/png',
		buffer: pngPayload(300, 200, 60, 90, 40)
	});
	await createPair(page, { xPx: 50, yPx: 50 }, { xPx: 20, yPx: 20 });
	await createPair(page, { xPx: 400, yPx: 300 }, { xPx: 200, yPx: 150 });
	await expect(page.getByTestId('alignment-summary')).toContainText('similarity transform from 2 pairs');

	await page.getByTestId('hole-graphics').scrollIntoViewIfNeeded();
	await expect(page.getByTestId('hole-preview-out-of-bounds')).toHaveText(
		'Hole 1 extends outside clean target — adjust target/alignment'
	);
	await expect(page.getByTestId('hole-thumb-1')).toHaveClass(/hole-thumb-warning/);

	// Neither export path offers this graphic: the single-hole action is
	// disabled, and "export all" both excludes it and says so.
	await expect(page.getByTestId('hole-graphic-download-selected')).toBeDisabled();
	await expect(page.getByTestId('download-all-hole-graphics')).toBeDisabled();
	await expect(page.getByTestId('hole-graphics-out-of-bounds-count')).toContainText('1 hole out of bounds, excluded');
});
