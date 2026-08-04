import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const SOURCE_ROLE = 'source-overview';
const TARGET_ROLE = 'target-basemap';

function fixturePath(name: string): string {
	return fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
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
			raw[offset] = 220;
			raw[offset + 1] = 40;
			raw[offset + 2] = 40;
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
	width: number;
	height: number;
}

interface ViewState {
	zoom: number;
	panX: number;
	panY: number;
}

function attachErrorListener(page: Page): string[] {
	const errors: string[] = [];
	page.on('console', (message) => {
		if (message.type() === 'error') errors.push(message.text());
	});
	page.on('pageerror', (error) => errors.push(String(error)));
	return errors;
}

async function gotoApp(page: Page): Promise<void> {
	await page.goto('/spot-round');
	await page.waitForFunction(() => document.documentElement.dataset.appReady === 'true');
}

async function loadBoth(page: Page): Promise<void> {
	await page.getByTestId('pane-input-source-overview').setInputFiles(fixturePath('tiny.png'));
	await page.getByTestId('pane-input-target-basemap').setInputFiles(fixturePath('tiny.jpg'));
	await expect(page.getByTestId('add-correspondence')).toBeEnabled();
}

async function loadBothLarge(page: Page): Promise<void> {
	const payload = pngPayload(20, 20);
	await page.getByTestId('pane-input-source-overview').setInputFiles({
		name: 'large-source.png',
		mimeType: 'image/png',
		buffer: payload
	});
	await expect(page.getByTestId('pane-filename-source-overview')).toHaveText('large-source.png');
	await page.getByTestId('pane-input-target-basemap').setInputFiles({
		name: 'large-target.png',
		mimeType: 'image/png',
		buffer: payload
	});
	await expect(page.getByTestId('pane-filename-target-basemap')).toHaveText('large-target.png');
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
	return {
		x: geometry.left + geometry.clientLeft + x,
		y: geometry.top + geometry.clientTop + y
	};
}

function imagePoint(view: ViewState, xPx: number, yPx: number): { x: number; y: number } {
	return { x: xPx * view.zoom + view.panX, y: yPx * view.zoom + view.panY };
}

async function createPair(
	page: Page,
	sourcePoint: { xPx: number; yPx: number },
	targetPoint: { xPx: number; yPx: number }
): Promise<{ sourceLocal: { x: number; y: number }; targetLocal: { x: number; y: number } }> {
	const sourceGeometry = await paneGeometry(page, SOURCE_ROLE);
	const targetGeometry = await paneGeometry(page, TARGET_ROLE);
	const sourceView = await viewState(page, SOURCE_ROLE);
	const targetView = await viewState(page, TARGET_ROLE);
	const sourceLocal = imagePoint(sourceView, sourcePoint.xPx, sourcePoint.yPx);
	const targetLocal = imagePoint(targetView, targetPoint.xPx, targetPoint.yPx);
	await page.getByTestId('add-correspondence').click();
	await page.mouse.click(...Object.values(panePoint(sourceGeometry, sourceLocal.x, sourceLocal.y)) as [number, number]);
	await page.mouse.click(...Object.values(panePoint(targetGeometry, targetLocal.x, targetLocal.y)) as [number, number]);
	await expect(page.getByTestId('app-shell')).toHaveAttribute('data-correspondence-mode', 'neutral');
	return { sourceLocal, targetLocal };
}

async function markerExtent(
	page: Page,
	role: string,
	localPoint: { x: number; y: number }
): Promise<{ width: number; height: number } | null> {
	return page.evaluate(
		({ paneRole, point }) => {
			const scene = document.querySelector<HTMLElement>(`[data-testid="pane-scene-${paneRole}"]`);
			if (!scene) return null;
			let minX = Number.POSITIVE_INFINITY;
			let minY = Number.POSITIVE_INFINITY;
			let maxX = Number.NEGATIVE_INFINITY;
			let maxY = Number.NEGATIVE_INFINITY;
			for (const canvas of scene.querySelectorAll('canvas')) {
				const rect = canvas.getBoundingClientRect();
				const scaleX = canvas.width / Math.max(rect.width, 1);
				const scaleY = canvas.height / Math.max(rect.height, 1);
				const centerX = Math.round((point.x - (rect.left - scene.getBoundingClientRect().left)) * scaleX);
				const centerY = Math.round((point.y - (rect.top - scene.getBoundingClientRect().top)) * scaleY);
				const radius = Math.ceil(24 * Math.max(scaleX, scaleY));
				const left = Math.max(0, centerX - radius);
				const top = Math.max(0, centerY - radius);
				const right = Math.min(canvas.width, centerX + radius + 1);
				const bottom = Math.min(canvas.height, centerY + radius + 1);
				const context = canvas.getContext('2d');
				if (!context || right <= left || bottom <= top) continue;
				const pixels = context.getImageData(left, top, right - left, bottom - top).data;
				for (let y = 0; y < bottom - top; y += 1) {
					for (let x = 0; x < right - left; x += 1) {
						const index = (y * (right - left) + x) * 4;
						const red = pixels[index];
						const green = pixels[index + 1];
						const blue = pixels[index + 2];
						const alpha = pixels[index + 3];
						if (alpha > 0 && red < 40 && green > 50 && green < 130 && blue > 90) {
							const screenX = (left + x) / scaleX;
							const screenY = (top + y) / scaleY;
							minX = Math.min(minX, screenX);
							minY = Math.min(minY, screenY);
							maxX = Math.max(maxX, screenX);
							maxY = Math.max(maxY, screenY);
						}
					}
				}
			}
			if (!Number.isFinite(minX)) return null;
			return { width: maxX - minX, height: maxY - minY };
		},
		{ paneRole: role, point: localPoint }
	);
}

test('creates one source-then-target pair and keeps pan and marker gestures separate', async ({ page }) => {
	const errors = attachErrorListener(page);
	await gotoApp(page);
	await loadBoth(page);

	const sourceGeometry = await paneGeometry(page, SOURCE_ROLE);
	const targetGeometry = await paneGeometry(page, TARGET_ROLE);
	await page.getByTestId('add-correspondence').click();
	await expect(page.getByTestId('correspondence-guidance')).toHaveText(
		'Click a landmark in the UDisc source image.'
	);

	// A drag over empty canvas is a pan, never a correspondence click.
	const dragStart = panePoint(sourceGeometry, 100, 100);
	await page.mouse.move(dragStart.x, dragStart.y);
	await page.mouse.down();
	await page.mouse.move(dragStart.x + 40, dragStart.y + 15, { steps: 5 });
	await page.mouse.up();
	await expect(page.getByTestId('app-shell')).toHaveAttribute('data-correspondence-mode', 'add-source');
	await expect(page.getByTestId('app-shell')).toHaveAttribute('data-complete-pair-count', '0');

	const sourceView = await viewState(page, SOURCE_ROLE);
	const targetView = await viewState(page, TARGET_ROLE);
	const sourceLocal = imagePoint(sourceView, 1, 1);
	const targetLocal = imagePoint(targetView, 2, 2);
	await page.mouse.click(...Object.values(panePoint(sourceGeometry, sourceLocal.x, sourceLocal.y)) as [number, number]);
	await expect(page.getByTestId('correspondence-guidance')).toHaveText(
		'Click the same landmark in the clean target image.'
	);

	// A second source click is ignored while the target is pending.
	await page.mouse.click(...Object.values(panePoint(sourceGeometry, 250, 150)) as [number, number]);
	await expect(page.getByTestId('app-shell')).toHaveAttribute('data-correspondence-mode', 'add-target');

	await page.mouse.click(...Object.values(panePoint(targetGeometry, targetLocal.x, targetLocal.y)) as [number, number]);
	await expect(page.getByTestId('app-shell')).toHaveAttribute('data-correspondence-mode', 'neutral');
	await expect(page.getByTestId('app-shell')).toHaveAttribute('data-complete-pair-count', '1');

	// Existing marker hits are consumed and reserved for P0-008.
	await page.getByTestId('add-correspondence').click();
	await page.mouse.click(...Object.values(panePoint(sourceGeometry, sourceLocal.x, sourceLocal.y)) as [number, number]);
	await expect(page.getByTestId('app-shell')).toHaveAttribute('data-correspondence-mode', 'add-source');

	expect(errors).toEqual([]);
});

test('keeps marker anchors and visible size stable through zoom, fit, reset, and resize', async ({ page }) => {
	const errors = attachErrorListener(page);
	await gotoApp(page);
	await loadBoth(page);

	const sourceGeometry = await paneGeometry(page, SOURCE_ROLE);
	const targetGeometry = await paneGeometry(page, TARGET_ROLE);
	await page.getByTestId('add-correspondence').click();
	const sourceView = await viewState(page, SOURCE_ROLE);
	const targetView = await viewState(page, TARGET_ROLE);
	const sourceLocal = imagePoint(sourceView, 1, 1);
	const targetLocal = imagePoint(targetView, 2, 2);
	await page.mouse.click(...Object.values(panePoint(sourceGeometry, sourceLocal.x, sourceLocal.y)) as [number, number]);
	await page.mouse.click(...Object.values(panePoint(targetGeometry, targetLocal.x, targetLocal.y)) as [number, number]);
	await expect(page.getByTestId('app-shell')).toHaveAttribute('data-complete-pair-count', '1');

	const fitExtent = await markerExtent(page, SOURCE_ROLE, sourceLocal);
	expect(fitExtent).not.toBeNull();

	const zoomPoint = panePoint(sourceGeometry, sourceLocal.x, sourceLocal.y);
	await page.mouse.move(zoomPoint.x, zoomPoint.y);
	await page.mouse.wheel(0, -100);
	const zoomedView = await viewState(page, SOURCE_ROLE);
	const zoomedLocal = imagePoint(zoomedView, 1, 1);
	const zoomedExtent = await markerExtent(page, SOURCE_ROLE, zoomedLocal);
	expect(zoomedExtent).not.toBeNull();
	if (fitExtent && zoomedExtent) {
		expect(Math.abs(fitExtent.width - zoomedExtent.width)).toBeLessThanOrEqual(4);
		expect(Math.abs(fitExtent.height - zoomedExtent.height)).toBeLessThanOrEqual(4);
	}

	await page.getByTestId('pane-fit-source-overview').click();
	await expect(page.getByTestId('app-shell')).toHaveAttribute('data-complete-pair-count', '1');
	await page.getByTestId('pane-reset-source-overview').click();
	await page.setViewportSize({ width: 1000, height: 700 });
	await expect(page.getByTestId('app-shell')).toHaveAttribute('data-complete-pair-count', '1');

	expect(errors).toEqual([]);
});

test('selects exact pair sides, consumes marker gestures in add mode, and clears correction state', async ({ page }) => {
	const errors = attachErrorListener(page);
	await gotoApp(page);
	await loadBoth(page);
	const sourceGeometry = await paneGeometry(page, SOURCE_ROLE);
	const targetGeometry = await paneGeometry(page, TARGET_ROLE);
	const first = await createPair(page, { xPx: 0.5, yPx: 0.6 }, { xPx: 1.5, yPx: 1.2 });
	await createPair(page, { xPx: 1.2, yPx: 2 }, { xPx: 3.5, yPx: 2.8 });

	await page.mouse.click(
		...Object.values(panePoint(sourceGeometry, first.sourceLocal.x, first.sourceLocal.y)) as [number, number]
	);
	await expect(page.getByTestId('point-inspector')).toContainText('Pair 1 · Source point');
	await page.mouse.click(
		...Object.values(panePoint(targetGeometry, first.targetLocal.x, first.targetLocal.y)) as [number, number]
	);
	await expect(page.getByTestId('point-inspector')).toContainText('Pair 1 · Target point');

	await page.getByTestId('point-x').fill('bad');
	await page.getByTestId('point-apply').click();
	await expect(page.getByTestId('point-error')).toContainText('finite');
	await page.getByTestId('add-correspondence').click();
	await expect(page.getByTestId('point-inspector')).toHaveCount(0);
	await expect(page.getByTestId('app-shell')).toHaveAttribute('data-correspondence-mode', 'add-source');

	// Existing complete markers are reserved while adding and cannot create another pair.
	await page.mouse.click(
		...Object.values(panePoint(sourceGeometry, first.sourceLocal.x, first.sourceLocal.y)) as [number, number]
	);
	await expect(page.getByTestId('app-shell')).toHaveAttribute('data-correspondence-mode', 'add-source');
	await expect(page.getByTestId('app-shell')).toHaveAttribute('data-complete-pair-count', '2');
	expect(errors).toEqual([]);
});

test('commits a marker drag in original coordinates without panning', async ({ page }) => {
	const errors = attachErrorListener(page);
	await gotoApp(page);
	await loadBoth(page);
	const sourceGeometry = await paneGeometry(page, SOURCE_ROLE);
	const { sourceLocal } = await createPair(page, { xPx: 0.5, yPx: 0.6 }, { xPx: 1.5, yPx: 1.2 });
	const before = await viewState(page, SOURCE_ROLE);
	const start = panePoint(sourceGeometry, sourceLocal.x, sourceLocal.y);
	await page.mouse.move(start.x, start.y);
	await page.mouse.wheel(0, -400);
	const zoomed = await viewState(page, SOURCE_ROLE);
	const emptyStart = panePoint(sourceGeometry, 500, 350);
	await page.mouse.move(emptyStart.x, emptyStart.y);
	await page.mouse.down();
	await page.mouse.move(emptyStart.x + 30, emptyStart.y - 15, { steps: 3 });
	await page.mouse.up();
	const panned = await viewState(page, SOURCE_ROLE);
	const markerAfterNavigation = imagePoint(panned, 0.5, 0.6);
	const destinationLocal = imagePoint(panned, 0.75, 0.8);
	const markerAfterZoom = imagePoint(zoomed, 0.5, 0.6);
	expect(zoomed.zoom).toBeGreaterThan(before.zoom);
	expect(markerAfterNavigation.x).not.toBe(markerAfterZoom.x);
	const destination = panePoint(sourceGeometry, destinationLocal.x, destinationLocal.y);
	const markerStart = panePoint(sourceGeometry, markerAfterNavigation.x, markerAfterNavigation.y);

	await page.mouse.move(markerStart.x, markerStart.y);
	await page.mouse.down();
	await page.mouse.move(destination.x, destination.y, { steps: 5 });
	await page.mouse.up();

	await expect(page.getByTestId('point-inspector')).toContainText('Pair 1 · Source point');
	await expect(page.getByTestId('point-x')).toHaveValue('0.75');
	await expect(page.getByTestId('point-y')).toHaveValue('0.8');
	const after = await viewState(page, SOURCE_ROLE);
	expect(after).toEqual(panned);
	expect(errors).toEqual([]);
});

test('covers 50%, 100%, and 200% drag scales with pan and combined pan/zoom', async ({ page }) => {
	const errors = attachErrorListener(page);
	await gotoApp(page);
	await loadBothLarge(page);
	const sourceGeometry = await paneGeometry(page, SOURCE_ROLE);
	const first = await createPair(page, { xPx: 5, yPx: 5 }, { xPx: 5, yPx: 5 });
	const second = await createPair(page, { xPx: 10, yPx: 10 }, { xPx: 10, yPx: 10 });
	const third = await createPair(page, { xPx: 15, yPx: 15 }, { xPx: 15, yPx: 15 });

	// 100%: pan only, then drag pair #1. Intermediate moves leave the durable
	// inspector value and history position unchanged until release.
	const fitView = await viewState(page, SOURCE_ROLE);
	const emptyStart = panePoint(sourceGeometry, 500, 350);
	await page.mouse.move(emptyStart.x, emptyStart.y);
	await page.mouse.down();
	await page.mouse.move(emptyStart.x + 25, emptyStart.y + 12, { steps: 3 });
	await page.mouse.up();
	const pannedView = await viewState(page, SOURCE_ROLE);
	const firstStart = panePoint(sourceGeometry, imagePoint(pannedView, 5, 5).x, imagePoint(pannedView, 5, 5).y);
	const firstDestination = panePoint(sourceGeometry, imagePoint(pannedView, 6, 6).x, imagePoint(pannedView, 6, 6).y);
	await page.mouse.move(firstStart.x, firstStart.y);
	await page.mouse.down();
	await page.mouse.move((firstStart.x + firstDestination.x) / 2, (firstStart.y + firstDestination.y) / 2);
	await expect(page.getByTestId('point-x')).toHaveValue('5');
	await page.mouse.move(firstDestination.x, firstDestination.y, { steps: 3 });
	await expect(page.getByTestId('point-x')).toHaveValue('5');
	await page.mouse.up();
	await expect(page.getByTestId('point-x')).toHaveValue('6');
	await expect(page.getByTestId('point-y')).toHaveValue('6');

	// 50%: fit, halve the view scale, and correct pair #2.
	await page.getByTestId('pane-fit-source-overview').click();
	const secondFit = await viewState(page, SOURCE_ROLE);
	const secondFitScreen = imagePoint(secondFit, 10, 10);
	await page.mouse.move(...Object.values(panePoint(sourceGeometry, secondFitScreen.x, secondFitScreen.y)) as [number, number]);
	await page.mouse.wheel(0, 200);
	const halfView = await viewState(page, SOURCE_ROLE);
	expect(halfView.zoom).toBeCloseTo(secondFit.zoom / 2, 8);
	const secondStart = panePoint(sourceGeometry, imagePoint(halfView, 10, 10).x, imagePoint(halfView, 10, 10).y);
	const secondDestination = panePoint(sourceGeometry, imagePoint(halfView, 11, 11).x, imagePoint(halfView, 11, 11).y);
	await page.mouse.move(secondStart.x, secondStart.y);
	await page.mouse.down();
	await page.mouse.move(secondDestination.x, secondDestination.y, { steps: 4 });
	await page.mouse.up();
	await expect(page.getByTestId('point-x')).toHaveValue('11');
	await expect(page.getByTestId('point-y')).toHaveValue('11');

	// 200%: fit, double the view scale, pan the zoomed image, and correct pair #3.
	await page.getByTestId('pane-fit-source-overview').click();
	const thirdFit = await viewState(page, SOURCE_ROLE);
	const thirdFitScreen = imagePoint(thirdFit, 15, 15);
	await page.mouse.move(...Object.values(panePoint(sourceGeometry, thirdFitScreen.x, thirdFitScreen.y)) as [number, number]);
	await page.mouse.wheel(0, -200);
	const doubleView = await viewState(page, SOURCE_ROLE);
	expect(doubleView.zoom).toBeCloseTo(thirdFit.zoom * 2, 8);
	const zoomedEmptyStart = panePoint(sourceGeometry, 500, 350);
	await page.mouse.move(zoomedEmptyStart.x, zoomedEmptyStart.y);
	await page.mouse.down();
	await page.mouse.move(zoomedEmptyStart.x - 18, zoomedEmptyStart.y + 14, { steps: 3 });
	await page.mouse.up();
	const combinedView = await viewState(page, SOURCE_ROLE);
	const thirdStart = panePoint(sourceGeometry, imagePoint(combinedView, 15, 15).x, imagePoint(combinedView, 15, 15).y);
	const thirdDestination = panePoint(sourceGeometry, imagePoint(combinedView, 14, 14).x, imagePoint(combinedView, 14, 14).y);
	await page.mouse.move(thirdStart.x, thirdStart.y);
	await page.mouse.down();
	await page.mouse.move(thirdDestination.x, thirdDestination.y, { steps: 4 });
	await page.mouse.up();
	await expect(page.getByTestId('point-x')).toHaveValue('14');
	await expect(page.getByTestId('point-y')).toHaveValue('14');
	await expect(page.getByTestId('app-shell')).toHaveAttribute('data-complete-pair-count', '3');
	void first;
	void second;
	void third;
	void fitView;
	expect(errors).toEqual([]);
});

test('discards a marker preview on pointer cancellation and release outside the pane', async ({ page }) => {
	const errors = attachErrorListener(page);
	await gotoApp(page);
	await loadBothLarge(page);
	const sourceGeometry = await paneGeometry(page, SOURCE_ROLE);
	const { sourceLocal } = await createPair(page, { xPx: 10, yPx: 10 }, { xPx: 10, yPx: 10 });
	const view = await viewState(page, SOURCE_ROLE);
	const start = panePoint(sourceGeometry, sourceLocal.x, sourceLocal.y);
	const destination = panePoint(sourceGeometry, imagePoint(view, 12, 12).x, imagePoint(view, 12, 12).y);
	await page.mouse.move(start.x, start.y);
	await page.mouse.down();
	await page.mouse.move(destination.x, destination.y, { steps: 3 });
	await page.evaluate(() => window.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true })));
	await expect(page.getByTestId('point-x')).toHaveValue('10');
	await expect(page.getByTestId('point-y')).toHaveValue('10');

	await page.mouse.move(start.x, start.y);
	await page.mouse.down();
	await page.mouse.move(destination.x, destination.y, { steps: 3 });
	await page.mouse.move(sourceGeometry.left + sourceGeometry.width + 50, destination.y, { steps: 3 });
	await page.mouse.up();
	await expect(page.getByTestId('point-x')).toHaveValue('10');
	await expect(page.getByTestId('point-y')).toHaveValue('10');
	expect(errors).toEqual([]);
});

test('nudges one and ten pixels and rejects all four keyboard edge directions', async ({ page }) => {
	const errors = attachErrorListener(page);
	await gotoApp(page);
	await loadBothLarge(page);
	const sourceGeometry = await paneGeometry(page, SOURCE_ROLE);
	const { sourceLocal } = await createPair(page, { xPx: 10, yPx: 8 }, { xPx: 10, yPx: 8 });
	await page.mouse.click(
		...Object.values(panePoint(sourceGeometry, sourceLocal.x, sourceLocal.y)) as [number, number]
	);
	await page.keyboard.press('ArrowRight');
	await expect(page.getByTestId('point-x')).toHaveValue('11');
	await page.keyboard.press('Shift+ArrowDown');
	await expect(page.getByTestId('point-y')).toHaveValue('18');

	await page.getByTestId('point-x').focus();
	await page.keyboard.press('ArrowRight');
	await expect(page.getByTestId('point-x')).toHaveValue('11');

	async function setAndNudge(x: number, y: number, key: string, expectedX: number, expectedY: number): Promise<void> {
		await page.getByTestId('point-x').fill(String(x));
		await page.getByTestId('point-y').fill(String(y));
		await page.getByTestId('point-apply').click();
		await page.keyboard.press(key);
		await expect(page.getByTestId('point-x')).toHaveValue(String(expectedX));
		await expect(page.getByTestId('point-y')).toHaveValue(String(expectedY));
	}

	await setAndNudge(0, 10, 'ArrowLeft', 0, 10);
	await setAndNudge(19, 10, 'ArrowRight', 19, 10);
	await setAndNudge(10, 0, 'ArrowUp', 10, 0);
	await setAndNudge(10, 19, 'ArrowDown', 10, 19);
	expect(errors).toEqual([]);
});

test('applies fractional coordinates atomically and rejects invalid bounds', async ({ page }) => {
	const errors = attachErrorListener(page);
	await gotoApp(page);
	await loadBoth(page);
	const sourceGeometry = await paneGeometry(page, SOURCE_ROLE);
	const { sourceLocal } = await createPair(page, { xPx: 0.5, yPx: 0.6 }, { xPx: 1.5, yPx: 1.2 });
	await page.mouse.click(
		...Object.values(panePoint(sourceGeometry, sourceLocal.x, sourceLocal.y)) as [number, number]
	);
	await page.getByTestId('point-x').fill(' 1.75 ');
	await page.getByTestId('point-y').fill(' 2.125 ');
	await page.getByTestId('point-apply').click();
	await expect(page.getByTestId('point-x')).toHaveValue('1.75');
	await expect(page.getByTestId('point-y')).toHaveValue('2.125');

	await page.getByTestId('point-x').fill('1.5');
	await page.getByTestId('point-y').fill('Infinity');
	await page.getByTestId('point-apply').click();
	await expect(page.getByTestId('point-error')).toContainText('finite');
	await expect(page.getByTestId('point-x')).toHaveValue('1.5');
	await expect(page.getByTestId('point-y')).toHaveValue('Infinity');
	await expect(page.getByTestId('point-inspector')).toBeVisible();
	expect(errors).toEqual([]);
});
