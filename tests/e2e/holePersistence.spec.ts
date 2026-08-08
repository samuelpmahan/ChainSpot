import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { deflateSync } from 'node:zlib';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * The regression this file exists for: hole annotations used to live only in an
 * in-memory session slot, so annotating a round, saving the project, and
 * reopening it silently lost every tee, basket, shot, and corridor point. Holes
 * are now durable `ProjectState` written into the schema-v2 document, and this
 * test drives the whole loop in a real browser — annotate, save, reload the
 * page (clearing every in-memory session), reopen the bundle, and confirm the
 * holes are still there and still buildable into graphics.
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
	await page.getByTestId('add-correspondence').click();
	await page.mouse.click(
		sourceGeometry.left + sourceGeometry.clientLeft + sourcePoint.xPx * sourceView.zoom + sourceView.panX,
		sourceGeometry.top + sourceGeometry.clientTop + sourcePoint.yPx * sourceView.zoom + sourceView.panY
	);
	await expect(page.getByTestId('app-shell')).toHaveAttribute('data-correspondence-mode', 'add-target');
	await page.mouse.click(
		targetGeometry.left + targetGeometry.clientLeft + targetPoint.xPx * targetView.zoom + targetView.panX,
		targetGeometry.top + targetGeometry.clientTop + targetPoint.yPx * targetView.zoom + targetView.panY
	);
	await expect(page.getByTestId('app-shell')).toHaveAttribute('data-correspondence-mode', 'neutral');
}

/** Annotates one hole with a tee, a basket, one shot, and a 3-vertex corridor. */
async function annotateOneHole(page: Page): Promise<void> {
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

	await page.mouse.click(box.x + 50, box.y + 50);
	await page.getByTestId('placement-mode-basket').check();
	await page.mouse.click(box.x + 400, box.y + 300);
	await page.getByTestId('placement-mode-shot').check();
	await page.mouse.click(box.x + 200, box.y + 150);
	await page.getByTestId('placement-mode-corridor').check();
	await page.mouse.click(box.x + 20, box.y + 20);
	await page.mouse.click(box.x + 450, box.y + 20);
	await page.mouse.click(box.x + 230, box.y + 320);

	await page.getByTestId('annotate-done').click();
	await page.waitForURL('**/create-graphics');
}

test('holes survive save, full page reload, and reopen — and are still buildable', async ({ page }) => {
	await annotateOneHole(page);
	await expect(page.getByTestId('app-shell')).toHaveAttribute('data-hole-count', '1');

	await page.getByTestId('pane-input-target-basemap').setInputFiles({
		name: 'clean.png',
		mimeType: 'image/png',
		buffer: pngPayload(1000, 800, 60, 90, 40)
	});
	await page.getByTestId('project-name').fill('Hole Round');
	await page.getByTestId('project-name').blur();

	const downloadPromise = page.waitForEvent('download');
	await page.getByTestId('save-project').click();
	const download = await downloadPromise;
	const stream = await download.createReadStream();
	const chunks: Buffer[] = [];
	for await (const chunk of stream) chunks.push(chunk);
	const zipBuffer = Buffer.concat(chunks);

	// The saved manifest is v2 and actually carries the hole geometry.
	const entries = unzipSync(new Uint8Array(zipBuffer));
	const manifest = JSON.parse(strFromU8(entries['project.json']));
	expect(manifest.schemaVersion).toBe(2);
	expect(manifest.holes).toHaveLength(1);
	expect(manifest.holes[0].number).toBe(1);
	expect(manifest.holes[0].tee).toBeDefined();
	expect(manifest.holes[0].basket).toBeDefined();
	expect(manifest.holes[0].shots).toHaveLength(1);
	expect(manifest.holes[0].corridor).toHaveLength(3);
	const savedHole = manifest.holes[0];

	// Full page load clears every in-memory session slot — the exact condition
	// under which holes used to vanish.
	await page.goto('/create-graphics');
	await page.waitForFunction(() => document.documentElement.dataset.appReady === 'true');
	await expect(page.getByTestId('app-shell')).toHaveAttribute('data-hole-count', '0');

	await page.getByTestId('open-project-input').setInputFiles({
		name: 'Hole Round.chainspot.zip',
		mimeType: 'application/zip',
		buffer: zipBuffer
	});

	await expect(page.getByTestId('pane-filename-source-overview')).toHaveText('course.png');
	await expect(page.getByTestId('app-shell')).toHaveAttribute('data-hole-count', '1');

	// Reopened holes are still usable: create pairs, align, and build the graphic
	// with no session artifact present anywhere.
	await createPair(page, { xPx: 50, yPx: 50 }, { xPx: 100, yPx: 100 });
	await createPair(page, { xPx: 700, yPx: 500 }, { xPx: 900, yPx: 700 });
	await expect(page.getByTestId('alignment-summary')).toContainText('similarity transform from 2 pairs');

	await page.getByTestId('hole-graphics').scrollIntoViewIfNeeded();
	await expect(page.getByTestId('build-hole-graphics')).toHaveText('Build 1 hole graphic');
	await page.getByTestId('build-hole-graphics').click();
	await page.waitForSelector('[data-testid="hole-graphic-image-1"]');

	// Re-saving reproduces the same hole geometry: no drift across the round trip.
	const resavePromise = page.waitForEvent('download');
	await page.getByTestId('save-project').click();
	const resave = await resavePromise;
	const resaveStream = await resave.createReadStream();
	const resaveChunks: Buffer[] = [];
	for await (const chunk of resaveStream) resaveChunks.push(chunk);
	const resaveManifest = JSON.parse(
		strFromU8(unzipSync(new Uint8Array(Buffer.concat(resaveChunks)))['project.json'])
	);
	expect(resaveManifest.holes).toEqual([savedHole]);
});

test('a pre-hole v1 bundle still opens, migrating forward to an empty hole list', async ({ page }) => {
	// Build a real v2 bundle, then rewrite its manifest as the v1 shape a build
	// from before hole annotation would have written.
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

	const downloadPromise = page.waitForEvent('download');
	await page.getByTestId('save-project').click();
	const download = await downloadPromise;
	const stream = await download.createReadStream();
	const chunks: Buffer[] = [];
	for await (const chunk of stream) chunks.push(chunk);
	const entries = unzipSync(new Uint8Array(Buffer.concat(chunks)));

	const manifest = JSON.parse(strFromU8(entries['project.json']));
	manifest.schemaVersion = 1;
	delete manifest.holes;

	const rebuilt: Record<string, Uint8Array> = { 'project.json': strToU8(JSON.stringify(manifest)) };
	for (const [path, bytes] of Object.entries(entries)) {
		if (path !== 'project.json') rebuilt[path] = bytes;
	}

	await page.getByTestId('open-project-input').setInputFiles({
		name: 'legacy.chainspot.zip',
		mimeType: 'application/zip',
		buffer: Buffer.from(zipSync(rebuilt, { level: 6 }))
	});

	await expect(page.getByTestId('pane-filename-source-overview')).toHaveText('course.png');
	await expect(page.getByTestId('app-shell')).toHaveAttribute('data-hole-count', '0');
});
