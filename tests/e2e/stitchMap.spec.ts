import { deflateSync } from 'node:zlib';
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

const SOURCE_ROLE = 'source-overview';
const TARGET_ROLE = 'target-basemap';

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

function pngPayload(
	width: number,
	height: number,
	rgb: [number, number, number]
): Buffer {
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

const TILE_COLORS: Record<string, [number, number, number]> = {
	'upper-left': [200, 40, 40],
	'upper-right': [40, 180, 40],
	'lower-left': [40, 60, 200],
	'lower-right': [80, 190, 220]
};

const TILE_SIZE = 24;

function tileFiles(): Record<string, { name: string; mimeType: string; buffer: Buffer }> {
	const files: Record<string, { name: string; mimeType: string; buffer: Buffer }> = {};
	for (const [slot, rgb] of Object.entries(TILE_COLORS)) {
		files[slot] = {
			name: `${slot}.png`,
			mimeType: 'image/png',
			buffer: pngPayload(TILE_SIZE, TILE_SIZE, rgb)
		};
	}
	return files;
}

async function gotoApp(page: Page, route: string): Promise<string> {
	await page.goto(route);
	await page.waitForFunction(() => document.documentElement.dataset.appReady === 'true');
	return new URL(page.url()).origin;
}

async function uploadTiles(page: Page, files: Record<string, { name: string; mimeType: string; buffer: Buffer }>): Promise<void> {
	for (const [slot, file] of Object.entries(files)) {
		await page.getByTestId(`tile-input-${slot}`).setInputFiles(file);
	}
	await expect(page.getByTestId('stitch-readiness')).toContainText('ready');
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
	width: number;
	height: number;
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

async function paneGeometry(page: Page, role: string): Promise<PaneGeometry> {
	return page.evaluate((paneRole) => {
		const element = document.querySelector<HTMLElement>(`[data-testid="pane-scene-${paneRole}"]`);
		if (!element) throw new Error(`missing pane ${paneRole}`);
		const rect = element.getBoundingClientRect();
		return {
			left: rect.left,
			top: rect.top,
			clientLeft: element.clientLeft,
			clientTop: element.clientTop,
			width: element.clientWidth,
			height: element.clientHeight
		};
	}, role);
}

function panePoint(geometry: PaneGeometry, x: number, y: number): { x: number; y: number } {
	return {
		x: geometry.left + geometry.clientLeft + x,
		y: geometry.top + geometry.clientTop + y
	};
}

function imagePoint(view: ViewState, xPx: number, yPx: number): { x: number; y: number } {
	return { x: xPx * view.zoom + view.panX, y: yPx * view.zoom + view.panY };
}

async function canvasClick(page: Page, role: string, local: { x: number; y: number }): Promise<void> {
	await page.getByTestId(`pane-scene-${role}`).scrollIntoViewIfNeeded();
	const geometry = await paneGeometry(page, role);
	await page.mouse.click(...(Object.values(panePoint(geometry, local.x, local.y)) as [number, number]));
}

async function loadSpotImages(page: Page): Promise<void> {
	await page.getByTestId('pane-input-source-overview').setInputFiles({
		name: 'source.png',
		mimeType: 'image/png',
		buffer: pngPayload(20, 20, [90, 90, 90])
	});
	await expect(page.getByTestId('pane-filename-source-overview')).toHaveText('source.png');
	await page.getByTestId('pane-input-target-basemap').setInputFiles({
		name: 'target.png',
		mimeType: 'image/png',
		buffer: pngPayload(20, 20, [120, 120, 120])
	});
	await expect(page.getByTestId('pane-filename-target-basemap')).toHaveText('target.png');
}

async function createPair(page: Page): Promise<void> {
	const sourceView = await viewState(page, SOURCE_ROLE);
	const targetView = await viewState(page, TARGET_ROLE);
	await page.getByTestId('add-correspondence').click();
	await canvasClick(page, SOURCE_ROLE, imagePoint(sourceView, 5, 5));
	await canvasClick(page, TARGET_ROLE, imagePoint(targetView, 5, 5));
	await expect(page.getByTestId('app-shell')).toHaveAttribute('data-complete-pair-count', '1');
}

function row(page: Page, ordinal: number): Locator {
	return page.locator(`[data-testid="pair-row"][data-ordinal="${ordinal}"]`);
}

interface ViewTransform {
	zoom: number;
	panX: number;
	panY: number;
}

async function viewOf(viewport: Locator): Promise<ViewTransform> {
	return {
		zoom: Number(await viewport.getAttribute('data-view-zoom')),
		panX: Number(await viewport.getAttribute('data-view-pan-x')),
		panY: Number(await viewport.getAttribute('data-view-pan-y'))
	};
}

async function atImagePoint(
	viewport: Locator,
	box: { x: number; y: number },
	view: ViewTransform,
	xPx: number,
	yPx: number
): Promise<{ x: number; y: number }> {
	return {
		x: box.x + view.panX + xPx * view.zoom,
		y: box.y + view.panY + yPx * view.zoom
	};
}

async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
	await page.mouse.move(from.x, from.y);
	await page.mouse.down();
	await page.mouse.move(to.x, to.y, { steps: 8 });
	await page.mouse.up();
}

test('stitch workflow: upload, mismatch isolation, crop recovery, alignment, native PNG download', async ({
	page
}) => {
	const serverOrigin = await gotoApp(page, '/stitch-map');

	// Assert no request leaves the Playwright test server's origin after this
	// point: same-origin application/asset requests are allowed, external HTTP
	// requests are forbidden (P05-002 locality contract).
	const externalRequests: string[] = [];
	page.on('request', (request) => {
		const url = new URL(request.url());
		if (url.origin !== serverOrigin) externalRequests.push(request.url());
	});

	await expect(page.getByTestId('download-stitched')).toBeDisabled();

	// Upload the upper-left tile, set the shared crop, then complete the set so
	// the initial 25% placement uses the cropped dimensions.
	const files = tileFiles();
	await page.getByTestId('tile-input-upper-left').setInputFiles(files['upper-left']);
	await expect(page.getByTestId('tile-file-upper-left')).toHaveText('upper-left.png');
	await expect(page.getByTestId('tile-dims-upper-left')).toHaveText(`${TILE_SIZE} x ${TILE_SIZE}`);

	await page.getByTestId('crop-leftPx').fill('4');
	await page.getByTestId('crop-leftPx').blur();
	await page.getByTestId('crop-topPx').fill('4');
	await page.getByTestId('crop-topPx').blur();
	await page.getByTestId('crop-rightPx').fill('2');
	await page.getByTestId('crop-rightPx').blur();
	await page.getByTestId('crop-bottomPx').fill('2');
	await page.getByTestId('crop-bottomPx').blur();

	for (const slot of ['upper-right', 'lower-left', 'lower-right']) {
		await page.getByTestId(`tile-input-${slot}`).setInputFiles(files[slot]);
		await expect(page.getByTestId(`tile-file-${slot}`)).toHaveText(files[slot].name);
		await expect(page.getByTestId(`tile-dims-${slot}`)).toHaveText(`${TILE_SIZE} x ${TILE_SIZE}`);
	}
	await expect(page.getByTestId('stitch-readiness')).toContainText('ready');

	// A dimension-mismatched replacement is rejected; the valid tile stays.
	await page.getByTestId('tile-input-upper-right').setInputFiles({
		name: 'wrong-size.png',
		mimeType: 'image/png',
		buffer: pngPayload(TILE_SIZE + 1, TILE_SIZE, [1, 2, 3])
	});
	await expect(page.getByTestId('tile-error-upper-right')).toContainText('same device orientation');
	await expect(page.getByTestId('tile-file-upper-right')).toHaveText('upper-right.png');

	// An invalid crop disables export and flags the fields; recovery re-enables it.
	const cropLeft = page.getByTestId('crop-leftPx');
	await cropLeft.fill('24');
	await cropLeft.blur();
	await expect(page.getByTestId('download-stitched')).toBeDisabled();
	await expect(page.getByTestId('stitch-readiness')).toContainText('crop');
	for (const field of ['crop-leftPx', 'crop-rightPx']) {
		await expect(page.getByTestId(field)).toHaveAttribute('aria-invalid', 'true');
	}
	await cropLeft.fill('4');
	await cropLeft.blur();
	await expect(page.getByTestId('download-stitched')).toBeEnabled();

	// Shared crop viewport: background drag pans without changing crop values.
	const cropViewport = page.getByTestId('crop-viewport');
	await cropViewport.scrollIntoViewIfNeeded();
	const cropBox = await cropViewport.boundingBox();
	if (!cropBox) throw new Error('crop viewport has no bounds');
	const cropViewBefore = await viewOf(cropViewport);
	await drag(page, { x: cropBox.x + 10, y: cropBox.y + 10 }, { x: cropBox.x + 60, y: cropBox.y + 10 });
	const cropViewAfter = await viewOf(cropViewport);
	expect(cropViewAfter.panX).not.toBe(cropViewBefore.panX);
	await expect(page.getByTestId('crop-leftPx')).toHaveValue('4');

	// Crop-handle drag changes only the crop edge and preserves the viewport.
	// Bottom inset is 2, so the bottom edge sits at image y = 22; the handle
	// center is at the crop-rect midpoint x = 13.
	const handleView = await viewOf(cropViewport);
	const bottomHandle = await atImagePoint(cropViewport, cropBox, handleView, 13, 22);
	await drag(
		page,
		bottomHandle,
		{ x: bottomHandle.x, y: bottomHandle.y - handleView.zoom * 3 }
	);
	await expect(page.getByTestId('crop-bottomPx')).toHaveValue('5');
	const viewAfterHandle = await viewOf(cropViewport);
	expect(viewAfterHandle.panX).toBe(handleView.panX);
	expect(viewAfterHandle.panY).toBe(handleView.panY);
	await page.getByTestId('crop-bottomPx').fill('2');
	await page.getByTestId('crop-bottomPx').blur();

	// Crop wheel zoom is pointer-centered; Fit restores the full upper-left image.
	const cropZoomBefore = (await viewOf(cropViewport)).zoom;
	await page.mouse.move(cropBox.x + cropBox.width / 2, cropBox.y + cropBox.height / 2);
	await page.mouse.wheel(0, -200);
	await expect
		.poll(async () => (await viewOf(cropViewport)).zoom)
		.toBeGreaterThan(cropZoomBefore);
	await page.getByTestId('crop-fit').click();
	await expect
		.poll(async () => (await viewOf(cropViewport)).zoom)
		.toBe(cropZoomBefore);

	// Cropped size is 18 x 18, so initial 25% offsets are round(18 * 3 / 4) = 14.
	await page.getByTestId('tile-select-upper-right').click();
	await expect(page.getByTestId('tile-position-x')).toHaveValue('14');
	await expect(page.getByTestId('tile-position-y')).toHaveValue('0');

	// Keyboard nudge: 1px, and Shift 10px (page must not scroll).
	await page.keyboard.press('ArrowRight');
	await expect(page.getByTestId('tile-position-x')).toHaveValue('15');
	await page.keyboard.press('Shift+ArrowLeft');
	await expect(page.getByTestId('tile-position-x')).toHaveValue('5');

	// Exact integer fields commit; fractional/empty input reverts to the previous value.
	await page.getByTestId('tile-position-x').fill('6');
	await page.getByTestId('tile-position-x').blur();
	await expect(page.getByTestId('tile-position-x')).toHaveValue('6');
	await page.getByTestId('tile-position-x').fill('1.5');
	await page.getByTestId('tile-position-x').blur();
	await expect(page.getByTestId('tile-position-x')).toHaveValue('6');

	// Shared alignment viewport geometry.
	const alignmentViewport = page.getByTestId('alignment-viewport');
	await alignmentViewport.scrollIntoViewIfNeeded();
	const alignmentBox = await alignmentViewport.boundingBox();
	if (!alignmentBox) throw new Error('alignment viewport has no bounds');

	// A point overlapped by the anchored upper-left tile and a movable tile is
	// ambiguous too: the anchor participates in ambiguity even though it can
	// never be selected. With lower-left selected, (8, 4) lies inside both the
	// anchor and UR, so the selection stays on lower-left.
	await page.getByTestId('tile-select-lower-left').click();
	const anchorOverlapPoint = await atImagePoint(
		alignmentViewport,
		alignmentBox,
		await viewOf(alignmentViewport),
		8,
		4
	);
	await page.mouse.click(anchorOverlapPoint.x, anchorOverlapPoint.y);
	await expect(page.getByTestId('tile-select-lower-left')).toHaveAttribute('aria-pressed', 'true');

	// Clicking an exposed, non-overlapped region of an unselected tile selects
	// it without moving it. UR sits at (6,0); its exposed region is the part not
	// covered by UL (x >= 18) or LR (y < 16), e.g. (20, 5).
	const clickView = await viewOf(alignmentViewport);
	const exposedPoint = await atImagePoint(alignmentViewport, alignmentBox, clickView, 20, 5);
	await page.mouse.click(exposedPoint.x, exposedPoint.y);
	await expect(page.getByTestId('tile-select-upper-right')).toHaveAttribute('aria-pressed', 'true');
	await expect(page.getByTestId('tile-position-x')).toHaveValue('6');
	await expect(page.getByTestId('tile-position-y')).toHaveValue('0');

	// A point overlapped by two movable tiles (UR and LR, e.g. (20, 17)) is
	// ambiguous: the current selection is preserved.
	const ambiguousPoint = await atImagePoint(
		alignmentViewport,
		alignmentBox,
		await viewOf(alignmentViewport),
		20,
		17
	);
	await page.mouse.click(ambiguousPoint.x, ambiguousPoint.y);
	await expect(page.getByTestId('tile-select-upper-right')).toHaveAttribute('aria-pressed', 'true');

	// Dragging the ALREADY SELECTED tile from an overlapped point moves the tile
	// (2 image pixels) and leaves the viewport pan untouched.
	const panBeforeTileDrag = await viewOf(alignmentViewport);
	const tileDragStart = await atImagePoint(alignmentViewport, alignmentBox, panBeforeTileDrag, 10, 5);
	await drag(
		page,
		tileDragStart,
		{ x: tileDragStart.x + panBeforeTileDrag.zoom * 2, y: tileDragStart.y }
	);
	await expect(page.getByTestId('tile-position-x')).toHaveValue('8');
	const panAfterTileDrag = await viewOf(alignmentViewport);
	expect(panAfterTileDrag).toEqual(panBeforeTileDrag);

	// Dragging an UNSELECTED tile pans the viewport instead of moving the tile.
	await page.getByTestId('tile-select-lower-left').click();
	const panBeforeUnselected = await viewOf(alignmentViewport);
	const unselectedPoint = await atImagePoint(alignmentViewport, alignmentBox, panBeforeUnselected, 20, 9);
	await drag(
		page,
		unselectedPoint,
		{ x: unselectedPoint.x + panBeforeUnselected.zoom * 15, y: unselectedPoint.y }
	);
	await expect(page.getByTestId('tile-position-x')).toHaveValue('0');
	await expect(page.getByTestId('tile-position-y')).toHaveValue('14');
	await page.getByTestId('tile-select-upper-right').click();
	await expect(page.getByTestId('tile-position-x')).toHaveValue('8');

	// Background drag pans without changing any tile coordinate.
	const panBeforeBackground = await viewOf(alignmentViewport);
	await drag(
		page,
		{ x: alignmentBox.x + 5, y: alignmentBox.y + 5 },
		{ x: alignmentBox.x + 45, y: alignmentBox.y + 5 }
	);
	const panAfterBackground = await viewOf(alignmentViewport);
	expect(panAfterBackground.panX).not.toBe(panBeforeBackground.panX);
	await page.getByTestId('tile-select-upper-right').click();
	await expect(page.getByTestId('tile-position-x')).toHaveValue('8');

	// Wheel zoom is pointer-centered; Fit restores the full tile union. The tiles
	// fill the fitted viewport, so the probe uses the background corner point.
	const beforeZoom = await viewOf(alignmentViewport);
	const wheelPoint = { x: alignmentBox.x + 5, y: alignmentBox.y + 5 };
	await page.mouse.move(wheelPoint.x, wheelPoint.y);
	await page.mouse.wheel(0, -200);
	await expect
		.poll(async () => (await viewOf(alignmentViewport)).zoom)
		.toBeGreaterThan(beforeZoom.zoom);
	const zoomed = await viewOf(alignmentViewport);
	const imageXBefore = (wheelPoint.x - alignmentBox.x - beforeZoom.panX) / beforeZoom.zoom;
	const imageXAfter = (wheelPoint.x - alignmentBox.x - zoomed.panX) / zoomed.zoom;
	expect(Math.abs(imageXAfter - imageXBefore)).toBeLessThan(0.01);
	await page.getByTestId('fit-preview').click();
	await expect
		.poll(async () => (await viewOf(alignmentViewport)).zoom)
		.toBe(beforeZoom.zoom);

	// Lower-right gets exact coordinates; preview-only controls never block export.
	await page.getByTestId('tile-select-lower-right').click();
	await page.getByTestId('tile-position-x').fill('16');
	await page.getByTestId('tile-position-x').blur();
	await page.getByTestId('tile-position-y').fill('16');
	await page.getByTestId('tile-position-y').blur();
	await page.getByTestId('tile-visible-lower-right').click();
	await expect(page.getByTestId('download-stitched')).toBeEnabled();

	// Export and verify the downloaded PNG at native resolution.
	const downloadPromise = page.waitForEvent('download');
	await page.getByTestId('download-stitched').click();
	const download = await downloadPromise;
	expect(download.suggestedFilename()).toBe('upper-left-stitched.png');
	const stream = await download.createReadStream();
	const chunks: Buffer[] = [];
	for await (const chunk of stream) chunks.push(chunk);
	const png = Buffer.concat(chunks);

	// Expected union: UL(0,0), UR(8,0), LL(0,14), LR(16,16), each 18 x 18,
	// spanning x 0..34 and y 0..34.
	const pixels = await page.evaluate(
		async (data) => {
			const blob = new Blob([new Uint8Array(data)], { type: 'image/png' });
			const url = URL.createObjectURL(blob);
			try {
				const image = new Image();
				image.src = url;
				await image.decode();
				const canvas = document.createElement('canvas');
				canvas.width = image.naturalWidth;
				canvas.height = image.naturalHeight;
				const context = canvas.getContext('2d');
				if (!context) throw new Error('no canvas');
				context.drawImage(image, 0, 0);
				const read = (x: number, y: number): number[] =>
					Array.from(context.getImageData(x, y, 1, 1).data);
				return {
					width: canvas.width,
					height: canvas.height,
					upperLeft: read(0, 0),
					upperRight: read(25, 0),
					lowerLeft: read(0, 31),
					lowerRight: read(33, 33)
				};
			} finally {
				URL.revokeObjectURL(url);
			}
		},
		[...png]
	);

	expect(pixels.width).toBe(34);
	expect(pixels.height).toBe(34);
	expect(pixels.upperLeft.slice(0, 3)).toEqual([200, 40, 40]);
	expect(pixels.upperRight.slice(0, 3)).toEqual([40, 180, 40]);
	expect(pixels.lowerLeft.slice(0, 3)).toEqual([40, 60, 200]);
	expect(pixels.lowerRight.slice(0, 3)).toEqual([80, 190, 220]);

	expect(externalRequests).toEqual([]);
});

test('handoff: retained Spot Round session, replacement semantics, blocked second handoff, target import', async ({
	page
}) => {
	await gotoApp(page, '/spot-round');
	await loadSpotImages(page);
	await page.getByTestId('project-name').fill('Round 1');
	await page.getByTestId('project-name').blur();
	await expect(page.getByTestId('project-name')).toHaveValue('Round 1');
	await createPair(page);
	await expect(page.getByTestId('dirty-indicator')).toBeVisible();

	// Navigate to Stitch Map and hand a stitched image back to the source role.
	await page.getByRole('link', { name: 'Stitch Map' }).click();
	await uploadTiles(page, tileFiles());
	await page.getByTestId('use-as-source').click();
	await expect(page).toHaveURL(/\/spot-round$/);

	// The retained session is the same active editor: images, project name,
	// pair, dirty state, and undo/redo history all survive the round trip.
	await expect(page.getByTestId('pane-filename-source-overview')).toHaveText('source.png');
	await expect(page.getByTestId('pane-filename-target-basemap')).toHaveText('target.png');
	await expect(page.getByTestId('project-name')).toHaveValue('Round 1');
	await expect(page.getByTestId('app-shell')).toHaveAttribute('data-complete-pair-count', '1');
	await expect(page.getByTestId('dirty-indicator')).toBeVisible();
	await page.keyboard.press('Control+z');
	await expect(page.getByTestId('app-shell')).toHaveAttribute('data-complete-pair-count', '0');
	await page.keyboard.press('Control+Shift+z');
	await expect(page.getByTestId('app-shell')).toHaveAttribute('data-complete-pair-count', '1');

	const banner = page.getByTestId('pending-handoff');
	await expect(banner).toBeVisible();
	await expect(banner).toContainText('UDisc source');

	// Cancelling the discard confirmation preserves both the Spot Round project
	// and the pending stitched image.
	await page.getByTestId('handoff-import').click();
	await expect(page.getByTestId('discard-confirmation')).toBeVisible();
	await page.getByTestId('discard-confirm-cancel').click();
	await expect(banner).toBeVisible();
	await expect(page.getByTestId('app-shell')).toHaveAttribute('data-complete-pair-count', '1');
	await expect(page.getByTestId('pane-filename-source-overview')).toHaveText('source.png');
	await expect(page.getByTestId('pane-filename-target-basemap')).toHaveText('target.png');

	// Confirming replaces only the requested role through the normal intake
	// path: the other image stays, affected pairs are discarded, history and
	// dirty state update normally, and the handoff is consumed.
	await page.getByTestId('handoff-import').click();
	await expect(page.getByTestId('discard-confirmation')).toBeVisible();
	await page.getByTestId('discard-confirm-accept').click();
	await expect(banner).toBeHidden();
	await expect(page.getByTestId('pane-filename-source-overview')).toHaveText(
		'upper-left-stitched.png'
	);
	await expect(page.getByTestId('pane-filename-target-basemap')).toHaveText('target.png');
	await expect(page.getByTestId('app-shell')).toHaveAttribute('data-complete-pair-count', '0');
	await expect(page.getByTestId('dirty-indicator')).toBeVisible();

	// A second handoff (target role) reaches Spot Round.
	await page.getByRole('link', { name: 'Stitch Map' }).click();
	await uploadTiles(page, tileFiles());
	await page.getByTestId('use-as-target').click();
	await expect(page).toHaveURL(/\/spot-round$/);
	await expect(banner).toBeVisible();
	await expect(banner).toContainText('clean target');

	// While a handoff is pending, another Use-as attempt aborts without
	// navigating or overwriting; Download remains available.
	await page.getByRole('link', { name: 'Stitch Map' }).click();
	await uploadTiles(page, tileFiles());
	await page.getByTestId('use-as-source').click();
	await expect(page).toHaveURL(/\/stitch-map$/);
	await expect(page.getByTestId('stitch-status')).toContainText('already awaiting import');
	await expect(page.getByTestId('download-stitched')).toBeEnabled();

	// The pending handoff survives the round trip and imports into the clean
	// target role through normal intake (no affected pairs, so no discard step).
	await page.getByRole('link', { name: 'Spot Round' }).click();
	await expect(banner).toBeVisible();
	await page.getByTestId('handoff-import').click();
	await expect(banner).toBeHidden();
	await expect(page.getByTestId('pane-filename-target-basemap')).toHaveText(
		'upper-left-stitched.png'
	);
	await expect(page.getByTestId('pane-filename-source-overview')).toHaveText(
		'upper-left-stitched.png'
	);
});
