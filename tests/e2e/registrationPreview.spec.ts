import { deflateSync } from 'node:zlib';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * Browser coverage for the live registration preview (P1-006): the
 * target/NAIP pane's ghost-course overlay, derived live from `alignmentResult`
 * + the confirmed holes. The projection math and the route-level wiring
 * (which pairs feed which transform, which model recomputes what) already
 * have their own unit coverage (`holeGraphics.test.ts`, `alignment.test.ts`,
 * `registrationPreview.test.ts`). What's new and only checkable in a real
 * browser here: the overlay is actually visible on the target pane, and —
 * critically — it never intercepts a pointer click meant for correspondence
 * placement, even when a click lands exactly on ghost geometry.
 *
 * Holes can't be annotated through the live Annotate Course UI in this test
 * suite (`holePersistence.spec.ts`'s header note explains why: that flow
 * predates a later UX split and no longer applies). Instead this test builds
 * a real bundle through Create Graphics's own Save, then injects a hand-built
 * `holes` array into the saved manifest before reopening it — the same
 * technique `holePersistence.spec.ts`'s "pre-hole v1 bundle" test already
 * uses to get holes into the route without touching Annotate Course.
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

async function screenPointFor(
	page: Page,
	role: string,
	point: { xPx: number; yPx: number }
): Promise<{ x: number; y: number }> {
	const geometry = await paneGeometry(page, role);
	const view = await viewState(page, role);
	const local = imagePoint(view, point.xPx, point.yPx);
	return panePoint(geometry, local.x, local.y);
}

async function createPair(
	page: Page,
	sourcePoint: { xPx: number; yPx: number },
	targetPoint: { xPx: number; yPx: number }
): Promise<void> {
	await page.getByTestId('pane-scene-source-overview').scrollIntoViewIfNeeded();
	const sourceScreen = await screenPointFor(page, 'source-overview', sourcePoint);
	const targetScreen = await screenPointFor(page, 'target-basemap', targetPoint);
	await page.getByTestId('add-correspondence').click();
	await page.mouse.click(sourceScreen.x, sourceScreen.y);
	await expect(page.getByTestId('app-shell')).toHaveAttribute('data-correspondence-mode', 'add-target');
	await page.mouse.click(targetScreen.x, targetScreen.y);
	await expect(page.getByTestId('app-shell')).toHaveAttribute('data-correspondence-mode', 'neutral');
}

// A pure 1.5x-scale + translate similarity transform: xT = 1.5*xS + 200, yT = 1.5*yS + 100.
const PAIR_1 = { source: { xPx: 50, yPx: 50 }, target: { xPx: 275, yPx: 175 } };
const PAIR_2 = { source: { xPx: 500, yPx: 400 }, target: { xPx: 950, yPx: 700 } };
// The hole's tee under that same transform lands at (350, 250) — a point with
// no correspondence marker anywhere near it, used below to prove the ghost
// overlay never swallows a click meant for placement.
const HOLE_TEE = { xPx: 100, yPx: 100 };
const EXPECTED_GHOST_TEE = { xPx: 350, yPx: 250 };

test('the target-pane ghost course overlay renders live and never intercepts correspondence placement clicks', async ({
	page
}) => {
	await page.goto('/create-graphics');
	await page.waitForFunction(() => document.documentElement.dataset.appReady === 'true');

	await page.getByTestId('pane-input-source-overview').setInputFiles({
		name: 'course.png',
		mimeType: 'image/png',
		buffer: pngPayload(800, 600, 80, 120, 60)
	});
	await page.getByTestId('pane-input-target-basemap').setInputFiles({
		name: 'clean.png',
		mimeType: 'image/png',
		buffer: pngPayload(1000, 800, 60, 90, 40)
	});

	// Save, inject a hand-built hole into the manifest (see the file header for
	// why), and reopen — the real save/open code path, only the `holes` field
	// is hand-authored.
	const downloadPromise = page.waitForEvent('download');
	await page.getByTestId('save-project').click();
	const download = await downloadPromise;
	const stream = await download.createReadStream();
	const chunks: Buffer[] = [];
	for await (const chunk of stream) chunks.push(chunk);
	const entries = unzipSync(new Uint8Array(Buffer.concat(chunks)));
	const manifest = JSON.parse(strFromU8(entries['project.json']));
	manifest.holes = [
		{
			id: 'hole-1',
			number: 1,
			tee: HOLE_TEE,
			basket: { xPx: 500, yPx: 350 },
			shots: [],
			corridorBends: [{ xPx: 300, yPx: 200 }],
			corridorWidthPx: 40
		}
	];
	const rebuilt: Record<string, Uint8Array> = { 'project.json': strToU8(JSON.stringify(manifest)) };
	for (const [path, bytes] of Object.entries(entries)) {
		if (path !== 'project.json') rebuilt[path] = bytes;
	}
	await page.getByTestId('open-project-input').setInputFiles({
		name: 'with-hole.chainspot.zip',
		mimeType: 'application/zip',
		buffer: Buffer.from(zipSync(rebuilt, { level: 6 }))
	});
	await expect(page.getByTestId('pane-filename-source-overview')).toHaveText('course.png');
	await expect(page.getByTestId('app-shell')).toHaveAttribute('data-hole-count', '1');

	// Before enough correspondence evidence exists: no overlay on either pane.
	await expect(page.getByTestId('pane-target-basemap')).toHaveAttribute('data-ghost-course-count', '0');
	await expect(page.getByTestId('pane-source-overview')).toHaveAttribute('data-ghost-course-count', '0');

	// Two pairs make similarity valid: the overlay appears on the target pane only.
	await createPair(page, PAIR_1.source, PAIR_1.target);
	await createPair(page, PAIR_2.source, PAIR_2.target);
	await expect(page.getByTestId('alignment-summary')).toContainText('similarity transform from 2 pairs');

	await expect(page.getByTestId('pane-target-basemap')).toHaveAttribute('data-ghost-course-count', '1');
	await expect(page.getByTestId('pane-source-overview')).toHaveAttribute('data-ghost-course-count', '0');

	// The dedicated toggle hides and reshows it without touching markers or diagnostics.
	const toggle = page.getByTestId('toggle-ghost-course');
	await expect(toggle).toHaveAttribute('aria-pressed', 'true');
	await toggle.click();
	await expect(page.getByTestId('pane-target-basemap')).toHaveAttribute('data-ghost-course-count', '0');
	await expect(toggle).toHaveAttribute('aria-pressed', 'false');
	await expect(page.getByTestId('toggle-markers')).toHaveAttribute('aria-pressed', 'true');
	await toggle.click();
	await expect(page.getByTestId('pane-target-basemap')).toHaveAttribute('data-ghost-course-count', '1');

	// Pointer-transparency: place a third correspondence pair whose TARGET click
	// lands exactly on the ghost tee marker's own screen position. If the
	// overlay intercepted the click, this would either fail to register a
	// placement at all or land somewhere else; instead it must complete
	// normally with the pair's target coordinates at the clicked point.
	const ghostTeeScreen = await screenPointFor(page, 'target-basemap', EXPECTED_GHOST_TEE);
	const sourceThirdScreen = await screenPointFor(page, 'source-overview', { xPx: 200, yPx: 150 });
	await page.getByTestId('add-correspondence').click();
	await page.mouse.click(sourceThirdScreen.x, sourceThirdScreen.y);
	await expect(page.getByTestId('app-shell')).toHaveAttribute('data-correspondence-mode', 'add-target');
	await page.mouse.click(ghostTeeScreen.x, ghostTeeScreen.y);
	await expect(page.getByTestId('app-shell')).toHaveAttribute('data-correspondence-mode', 'neutral');
	await expect(page.getByTestId('alignment-summary')).toContainText('similarity transform from 3 pairs');

	const thirdPairTarget = await page.evaluate(() => {
		const cells = document.querySelectorAll('[data-testid^="pair-target-px-"]');
		return cells.length > 0 ? cells[cells.length - 1].textContent : null;
	});
	expect(thirdPairTarget).not.toBeNull();
	const [tx, ty] = (thirdPairTarget as string)
		.replace(/[()]/g, '')
		.split(',')
		.map((value) => Number(value.trim()));
	expect(tx).toBeCloseTo(EXPECTED_GHOST_TEE.xPx, 0);
	expect(ty).toBeCloseTo(EXPECTED_GHOST_TEE.yPx, 0);
});
