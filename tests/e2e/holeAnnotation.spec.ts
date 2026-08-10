import { deflateSync } from 'node:zlib';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { radialWedges } from '../../src/lib/radialMenu';

/**
 * Browser coverage for Annotate Round's hole-annotation workflow: adding holes,
 * placing tee/basket/shot/bend points via the radial menu, deleting an existing
 * point via the same menu, per-hole correction (remove last shot/bend, clear
 * bends), switching the active hole without cross-contaminating another hole's
 * points, immediate corridor-band rendering from tee + basket + bends + width,
 * and the resulting AnnotatedRound handing off to Create Graphics once
 * corrected.
 */

// Must match the RADIAL_HUB_RADIUS_PX / RADIAL_OUTER_RADIUS_PX constants in
// +page.svelte — there is no shared export, since they're page-local tuning.
const RADIAL_HUB_RADIUS_PX = 20;
const RADIAL_OUTER_RADIUS_PX = 62;

type PointKind = 'tee' | 'basket' | 'shot' | 'bend' | 'walk';

/**
 * The wedges a fresh radial menu offers for empty space, given the active
 * mode and what's already on the hole — mirrors +page.svelte's
 * radialMenuActions(). Map mode offers course geometry (tee/basket if
 * absent, bend always); Round mode offers round-specific points (shot only
 * with a hole active, walk always).
 */
function mapKinds(hasTee: boolean, hasBasket: boolean): PointKind[] {
	const kinds: PointKind[] = [];
	if (!hasTee) kinds.push('tee');
	if (!hasBasket) kinds.push('basket');
	kinds.push('bend');
	return kinds;
}

function roundKinds(hasActiveHole: boolean): PointKind[] {
	const kinds: PointKind[] = [];
	if (hasActiveHole) kinds.push('shot');
	kinds.push('walk');
	return kinds;
}

/** Clicks the Map/Round segmented toggle in the toolbar. */
async function switchMode(page: Page, mode: 'map' | 'round'): Promise<void> {
	await page.getByTestId(`annotation-mode-${mode}`).click();
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

/** Clicks (x, y) to open the radial menu, then clicks the wedge for `kind` among `kinds`. */
async function placePoint(page: Page, x: number, y: number, kind: PointKind, kinds: PointKind[]): Promise<void> {
	await page.mouse.click(x, y);
	const layout = radialWedges(kinds.length, { hubRadius: RADIAL_HUB_RADIUS_PX, outerRadius: RADIAL_OUTER_RADIUS_PX });
	const index = kinds.indexOf(kind);
	if (index === -1) throw new Error(`${kind} is not offered among ${kinds.join(', ')}`);
	const wedge = layout.wedges[index];
	await page.mouse.click(x + wedge.labelX, y + wedge.labelY);
}

async function dragMarker(
	page: Page,
	testid: string,
	deltaX: number,
	deltaY: number,
	release = true
): Promise<void> {
	const marker = page.getByTestId(testid);
	const box = await marker.boundingBox();
	if (!box) throw new Error(`${testid} has no bounding box`);
	const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
	await page.mouse.move(start.x, start.y);
	await page.mouse.down();
	await page.mouse.move(start.x + deltaX, start.y + deltaY, { steps: 4 });
	if (release) await page.mouse.up();
}

async function expectSourcePointInBounds(page: Page, testid: string): Promise<void> {
	const marker = page.getByTestId(testid);
	const x = Number(await marker.getAttribute('cx'));
	const y = Number(await marker.getAttribute('cy'));
	expect(x).toBeGreaterThanOrEqual(0);
	expect(x).toBeLessThan(800);
	expect(y).toBeGreaterThanOrEqual(0);
	expect(y).toBeLessThan(600);
}

test('hole annotation: place tee/basket/shots/bends via the radial menu, correct with remove-last controls, no cross-contamination between holes', async ({
	page
}) => {
	await loadSourceImage(page);
	const { box } = await annotationFrameBox(page);

	await placePoint(page, box.x + 50, box.y + 50, 'tee', mapKinds(false, false));
	await expect(page.getByTestId('tee-marker-1')).toBeVisible();
	await expect(page.getByTestId('hole-select-1')).toContainText('tee');

	await placePoint(page, box.x + 300, box.y + 250, 'basket', mapKinds(true, false));
	await expect(page.getByTestId('basket-marker-1')).toBeVisible();

	// As soon as tee + basket exist, the derived corridor band and centerline
	// render — even with zero bends.
	await expect(page.getByTestId('corridor-band-1')).toBeVisible();
	await expect(page.getByTestId('corridor-centerline-1')).toBeVisible();
	await expect(page.getByTestId('hole-select-1')).toContainText('tee · basket');

	// Shots are a Round-mode activity.
	await switchMode(page, 'round');
	await placePoint(page, box.x + 120, box.y + 100, 'shot', roundKinds(true));
	await placePoint(page, box.x + 200, box.y + 160, 'shot', roundKinds(true));
	await expect(page.getByTestId('shot-marker-1-1')).toBeVisible();
	await expect(page.getByTestId('hole-select-1')).toContainText('2 shots');

	// Bends are a Map-mode activity; switch back before placing more.
	await switchMode(page, 'map');
	await placePoint(page, box.x + 170, box.y + 170, 'bend', mapKinds(true, true));
	await expect(page.getByTestId('bend-marker-1-0')).toBeVisible();
	await placePoint(page, box.x + 230, box.y + 190, 'bend', mapKinds(true, true));
	await expect(page.getByTestId('bend-marker-1-1')).toBeVisible();
	await expect(page.getByTestId('hole-select-1')).toContainText('bends (2)');

	// The corridor width is controllable and persists on the hole.
	await page.getByTestId('corridor-width').fill('90');
	await page.getByTestId('corridor-width').blur();
	await expect(page.getByTestId('corridor-width')).toHaveValue('90');

	// Corrections: remove the last shot and the last bend; clearing all bends
	// still leaves a renderable straight-hole band.
	await page.getByTestId('remove-last-shot').click();
	await page.getByTestId('remove-last-bend').click();
	await expect(page.getByTestId('hole-select-1')).toContainText('1 shot');
	await expect(page.getByTestId('hole-select-1')).toContainText('bends (1)');
	await expect(page.getByTestId('hole-select-1')).not.toContainText('2 shots');
	await expect(page.getByTestId('corridor-band-1')).toBeVisible();
	await page.getByTestId('clear-bends').click();
	await expect(page.getByTestId('hole-select-1')).not.toContainText('bends (1)');
	await expect(page.getByTestId('corridor-band-1')).toBeVisible();

	// A second hole must not see hole 1's points, and placing on hole 2 must not
	// touch hole 1's already-placed tee. Clicked well clear of every hole-1
	// marker so the radial menu opens for empty space, not that marker's own
	// delete menu.
	await page.getByTestId('hole-add').click();
	await expect(page.getByTestId('annotate-round')).toHaveAttribute('data-hole-count', '2');
	await placePoint(page, box.x + 600, box.y + 440, 'tee', mapKinds(false, false));
	await expect(page.getByTestId('tee-marker-2')).toBeVisible();
	await expect(page.getByTestId('tee-marker-1')).toBeVisible();
	await expect(page.getByTestId('basket-marker-2')).toHaveCount(0);
});

test('hole annotation: existing tee, basket, shot, and bend markers drag without placement duplication; a non-dragging click opens the delete menu instead of placing', async ({
	page
}) => {
	await loadSourceImage(page);
	const { box } = await annotationFrameBox(page);

	await placePoint(page, box.x + 80, box.y + 80, 'tee', mapKinds(false, false));
	await placePoint(page, box.x + 520, box.y + 420, 'basket', mapKinds(true, false));
	await switchMode(page, 'round');
	await placePoint(page, box.x + 180, box.y + 180, 'shot', roundKinds(true));
	await placePoint(page, box.x + 260, box.y + 240, 'shot', roundKinds(true));
	await switchMode(page, 'map');
	await placePoint(page, box.x + 350, box.y + 320, 'bend', mapKinds(true, true));

	const centerlineBefore = await page.getByTestId('corridor-centerline-1').getAttribute('points');
	const bendCountBefore = await page.locator('[data-testid^="bend-marker-1-"]').count();

	// Bend placement is active, but a marker claim must win over background placement.
	// Still in Map mode, so tee/basket/bend markers are the interactive ones.
	const teeBefore = await page.getByTestId('tee-marker-1').getAttribute('cx');
	await dragMarker(page, 'tee-marker-1', 45, 25, false);
	await expect(page.getByTestId('tee-marker-1')).not.toHaveAttribute('cx', teeBefore ?? '');
	await expect(page.getByTestId('hole-select-1')).toContainText('tee · basket · 2 shots · bends (1)');
	await page.mouse.up();
	await expect(page.locator('[data-testid^="bend-marker-1-"]')).toHaveCount(bendCountBefore);
	const centerlineAfterTee = await page.getByTestId('corridor-centerline-1').getAttribute('points');
		expect(centerlineAfterTee).not.toBe(centerlineBefore);
	await expectSourcePointInBounds(page, 'tee-marker-1');

	const bandBeforeBasket = await page.getByTestId('corridor-band-1').getAttribute('points');
	await dragMarker(page, 'basket-marker-1', -35, -20);
	await expect(page.getByTestId('corridor-band-1')).toHaveAttribute('points', /.+/);
	const bandAfterBasket = await page.getByTestId('corridor-band-1').getAttribute('points');
		expect(bandAfterBasket).not.toBe(bandBeforeBasket);
	await expectSourcePointInBounds(page, 'basket-marker-1');

	// Shot markers are only interactive in Round mode.
	await switchMode(page, 'round');
	const shotCountBefore = await page.locator('[data-testid^="shot-marker-1-"]').count();
	await dragMarker(page, 'shot-marker-1-0', 30, 15);
	await expect(page.locator('[data-testid^="shot-marker-1-"]')).toHaveCount(shotCountBefore);
	await expectSourcePointInBounds(page, 'shot-marker-1-0');
	await switchMode(page, 'map');

	const centerlineBeforeBend = await page.getByTestId('corridor-centerline-1').getAttribute('points');
	await dragMarker(page, 'bend-marker-1-0', 25, -15);
	const centerlineAfterBend = await page.getByTestId('corridor-centerline-1').getAttribute('points');
		expect(centerlineAfterBend).not.toBe(centerlineBeforeBend);

	// A click without movement on an existing marker opens its delete menu
	// instead of placing anything; dismissing it (Escape) leaves every point untouched.
	const finalBendCount = await page.locator('[data-testid^="bend-marker-1-"]').count();
	const teeBox = await page.getByTestId('tee-marker-1').boundingBox();
	if (!teeBox) throw new Error('tee marker has no bounding box');
	await page.mouse.click(teeBox.x + teeBox.width / 2, teeBox.y + teeBox.height / 2);
	await expect(page.getByTestId('radial-menu')).toBeVisible();
	await expect(page.getByTestId('radial-wedge-delete')).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(page.getByTestId('radial-menu')).toHaveCount(0);
	await expect(page.getByTestId('tee-marker-1')).toBeVisible();
	await expect(page.locator('[data-testid^="bend-marker-1-"]')).toHaveCount(finalBendCount);

	// Dragging beyond the visible image is clamped into source-image bounds.
	await dragMarker(page, 'bend-marker-1-0', -1000, -1000);
	await expectSourcePointInBounds(page, 'bend-marker-1-0');
});

test('hole annotation: the radial menu deletes an individual point without touching the rest of the hole', async ({
	page
}) => {
	await loadSourceImage(page);
	const { box } = await annotationFrameBox(page);

	await placePoint(page, box.x + 80, box.y + 80, 'tee', mapKinds(false, false));
	await placePoint(page, box.x + 520, box.y + 420, 'basket', mapKinds(true, false));
	await switchMode(page, 'round');
	await placePoint(page, box.x + 180, box.y + 180, 'shot', roundKinds(true));
	// Basket markers are only interactive in Map mode.
	await switchMode(page, 'map');

	const basketBox = await page.getByTestId('basket-marker-1').boundingBox();
	if (!basketBox) throw new Error('basket marker has no bounding box');
	await page.mouse.click(basketBox.x + basketBox.width / 2, basketBox.y + basketBox.height / 2);
	await expect(page.getByTestId('radial-wedge-delete')).toBeVisible();
	const layout = radialWedges(1, { hubRadius: RADIAL_HUB_RADIUS_PX, outerRadius: RADIAL_OUTER_RADIUS_PX });
	const wedge = layout.wedges[0];
	await page.mouse.click(
		basketBox.x + basketBox.width / 2 + wedge.labelX,
		basketBox.y + basketBox.height / 2 + wedge.labelY
	);

	await expect(page.getByTestId('basket-marker-1')).toHaveCount(0);
	await expect(page.getByTestId('tee-marker-1')).toBeVisible();
	await expect(page.getByTestId('shot-marker-1-0')).toBeVisible();
	await expect(page.getByTestId('hole-select-1')).not.toContainText('basket');
});

test('hole annotation: a straight hole with zero bends and its width control still hands off to Create Graphics', async ({
	page
}) => {
	await loadSourceImage(page);
	const { box } = await annotationFrameBox(page);

	await placePoint(page, box.x + 50, box.y + 50, 'tee', mapKinds(false, false));
	await placePoint(page, box.x + 300, box.y + 250, 'basket', mapKinds(true, false));
	// Zero bends is a valid straight hole: the band renders and Done is unblocked.
	await expect(page.getByTestId('corridor-band-1')).toBeVisible();
	await page.getByTestId('corridor-width').fill('70');
	await page.getByTestId('corridor-width').blur();
	await expect(page.getByTestId('corridor-width')).toHaveValue('70');

	await page.getByTestId('annotate-done').click();
	await page.waitForURL('**/create-graphics');
	await expect(page.getByTestId('pane-filename-source-overview')).toHaveText('course.png');
});
