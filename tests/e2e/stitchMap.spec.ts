import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

async function gotoApp(page: Page, route: string): Promise<string> {
	await page.goto(route);
	await page.waitForFunction(() => document.documentElement.dataset.appReady === 'true');
	return new URL(page.url()).origin;
}

/**
 * The committed "strong" smart-import fixture set (deterministic seeded
 * scene, 200x200 per capture, shared chrome band detected at top 4px/bottom
 * 3px, plus the default +2px safety margin on each -> shared crop top 6px /
 * bottom 5px applied automatically; 25% overlap). Ground-truth placements
 * relative to the inferred anchor (smart-ul.png) are the three points (150,
 * 0), (0, 150), (150, 150) — the same fixture `smartImport.spec.ts`/the
 * pre-redesign version of this file used, kept as the "ordinary 2x2 remains
 * an important regression fixture" case. Which `tile-N` id lands on which of
 * those three points is an internal `assignN` ordering detail this file
 * deliberately does not pin — see the tests below, which read a tile's own
 * starting position rather than assuming one.
 */
const FIXTURES = join(process.cwd(), 'tests', 'fixtures', 'smart-import');
const SLOT_FILES: Record<string, string> = {
	'tile-0': 'smart-ll.png',
	'tile-1': 'smart-ur.png',
	'tile-2': 'smart-lr.png',
	'tile-3': 'smart-ul.png'
};

/**
 * Uploads the four fixtures through the per-slot grid, deliberately in a
 * scrambled slot order (not upload = position) — the auto-first pipeline
 * infers the real arrangement regardless of which grid slot each file
 * landed in, then re-keys `activeSlots` from that arrangement (see
 * `seedManualFromPipeline`), so the grid upload order carries no
 * significance once the result exists.
 */
async function importFixtureSet(page: Page): Promise<void> {
	for (const [slot, name] of Object.entries(SLOT_FILES)) {
		await page.getByTestId(`tile-input-${slot}`).setInputFiles(join(FIXTURES, name));
	}
	// First real `cv.matchTemplate` call in the worker's lifetime pays a
	// one-time WASM JIT/lazy-compile tax (measured 10-13.5s locally, more
	// under concurrent e2e-worker CPU contention) on top of whatever the
	// eager `warmSmartStitchWorker()` call already covers.
	await expect(page.getByTestId('composite-image')).toBeVisible({ timeout: 60000 });
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

test('auto-first workflow: unordered grid import lands directly on an assembled result, manual correction (crop, drag, nudge, Snap, visibility) still works, and download/handoff are native', async ({
	page
}) => {
	// See the timing note on `importFixtureSet` for why this needs headroom
	// beyond Playwright's 30s default.
	test.setTimeout(90000);
	const serverOrigin = await gotoApp(page, '/stitch-map');

	// No request leaves the Playwright test server's origin (P05-002 locality
	// contract) at any point in this flow.
	const externalRequests: string[] = [];
	page.on('request', (request) => {
		const url = new URL(request.url());
		if (url.origin !== serverOrigin) externalRequests.push(request.url());
	});

	await expect(page.getByTestId('adjust-manually')).toHaveCount(0);

	await importFixtureSet(page);

	// No forced approval click: the result is already the assembled composite,
	// and the shared crop the auto pipeline detected (plus its default +2px
	// safety margin per side) is already applied — not just proposed.
	await expect(page.getByTestId('continue-to-annotate')).toBeEnabled();
	await expect(page.getByTestId('download-stitched')).toBeEnabled();
	await expect(page.getByTestId('use-as-target')).toBeEnabled();

	await page.getByTestId('adjust-manually').click();
	await page.getByTestId('manual-tab-crop').click();
	await expect(page.getByTestId('crop-topPx')).toHaveValue('6');
	await expect(page.getByTestId('crop-bottomPx')).toHaveValue('5');

	// Manual crop editing remains fully capable.
	await page.getByTestId('crop-topPx').fill('7');
	await page.getByTestId('crop-topPx').blur();
	await expect(page.getByTestId('crop-topPx')).toHaveValue('7');
	await page.getByTestId('crop-topPx').fill('6');
	await page.getByTestId('crop-topPx').blur();

	await page.getByTestId('manual-tab-placement').click();
	const stageViewport = page.getByTestId('stage-viewport');

	// Which `tile-N` id the arrangement assigned to which corner is an
	// `assignN` internal detail — read the movable tile's own automatic
	// starting position rather than assuming one, and use it as the baseline
	// every perturb/restore below measures against.
	await page.getByTestId('tile-select-tile-1').click();
	const baselineX = Number(await page.getByTestId('tile-position-x').inputValue());
	const baselineY = Number(await page.getByTestId('tile-position-y').inputValue());

	// Keyboard nudge: 1px, and Shift 10px.
	await page.keyboard.press('ArrowRight');
	await expect(page.getByTestId('tile-position-x')).toHaveValue(String(baselineX + 1));
	await page.keyboard.press('Shift+ArrowLeft');
	await expect(page.getByTestId('tile-position-x')).toHaveValue(String(baselineX - 9));

	// Exact integer fields commit; fractional/empty input reverts.
	await page.getByTestId('tile-position-x').fill(String(baselineX + 12));
	await page.getByTestId('tile-position-x').blur();
	await expect(page.getByTestId('tile-position-x')).toHaveValue(String(baselineX + 12));
	await page.getByTestId('tile-position-y').fill(String(baselineY + 9));
	await page.getByTestId('tile-position-y').blur();

	// Snap assist locks the deliberately displaced tile back onto its real
	// neighbor match — close to wherever it started, not a hardcoded corner.
	await expect(page.getByTestId('snap-tile')).toBeEnabled();
	await page.getByTestId('snap-tile').click();
	// First Snap call in the page's lifetime pays the same one-time
	// WASM JIT/lazy-compile tax as the smart-import worker call above, on the
	// MAIN thread this time (the lazily-warmed `loadCv()` — see
	// `ensureCvWarm` — only covers module parse/instantiate, not this).
	await expect(page.getByTestId('snap-tile')).toBeEnabled({ timeout: 60000 });
	expect(
		Math.abs(Number(await page.getByTestId('tile-position-x').inputValue()) - baselineX)
	).toBeLessThanOrEqual(2);
	expect(
		Math.abs(Number(await page.getByTestId('tile-position-y').inputValue()) - baselineY)
	).toBeLessThanOrEqual(2);

	// Drag: pointer-driven placement still works on the same shared viewport.
	// The grab point is well inside the tile (not at an edge/corner, which a
	// screen<->image rounding step could otherwise land just outside). Box
	// and view are both re-measured immediately before use — an intervening
	// `stageWorkspace.focus()` call (see `selectSlot`) can scroll the page,
	// so a box measured earlier in the test is not safe to reuse here.
	await stageViewport.scrollIntoViewIfNeeded();
	const stageBox = await stageViewport.boundingBox();
	if (!stageBox) throw new Error('stage viewport has no bounds');
	const beforeDrag = await viewOf(stageViewport);
	const dragStart = await atImagePoint(stageViewport, stageBox, beforeDrag, baselineX + 50, baselineY + 50);
	// The move must clear the shared click-vs-drag slop threshold (4px for a
	// mouse pointer) in SCREEN pixels, not image pixels — at this fixture's
	// zoom (~1.5x, much lower than the tiny solid-color fixtures this pattern
	// was inherited from), a couple of image pixels of movement does not.
	await drag(page, dragStart, { x: dragStart.x + beforeDrag.zoom * 20, y: dragStart.y });
	await expect(page.getByTestId('tile-position-x')).not.toHaveValue(String(baselineX));
	// Restore the baseline for a deterministic export check.
	await page.getByTestId('tile-position-x').fill(String(baselineX));
	await page.getByTestId('tile-position-x').blur();
	await page.getByTestId('tile-position-y').fill(String(baselineY));
	await page.getByTestId('tile-position-y').blur();

	await expect(page.getByTestId('apply-manual-adjustments')).toBeEnabled();
	await page.getByTestId('apply-manual-adjustments').click();
	await expect(page.getByTestId('manual-surface')).toHaveCount(0);
	await expect(page.getByTestId('composite-image')).toBeVisible();

	// Native-resolution export: cropped 200x189 tiles (crop top 6 / bottom 5)
	// at ground truth (0,0)/(150,0)/(0,150)/(150,150) span x 0..350, y 0..339.
	const downloadPromise = page.waitForEvent('download');
	await page.getByTestId('download-stitched').click();
	const download = await downloadPromise;
	const stream = await download.createReadStream();
	const chunks: Buffer[] = [];
	for await (const chunk of stream) chunks.push(chunk);
	const png = Buffer.concat(chunks);
	const dims = await page.evaluate(async (data) => {
		const blob = new Blob([new Uint8Array(data)], { type: 'image/png' });
		const url = URL.createObjectURL(blob);
		try {
			const image = new Image();
			image.src = url;
			await image.decode();
			return { width: image.naturalWidth, height: image.naturalHeight };
		} finally {
			URL.revokeObjectURL(url);
		}
	}, [...png]);
	expect(dims).toEqual({ width: 350, height: 339 });

	// Visibility toggle (preview-only) and Reset arrangement, exercised last
	// since both change on-screen placements and would otherwise perturb the
	// deterministic export just checked above.
	await page.getByTestId('adjust-manually').click();
	await page.getByTestId('tile-select-tile-1').click();
	const hideButton = page.getByRole('button', { name: /Hide Capture \d \(preview\)/ });
	await hideButton.click();
	await expect(page.getByRole('button', { name: /Show Capture \d \(preview\)/ })).toBeVisible();
	await page.getByTestId('reset-arrangement').click();
	await expect(page.getByTestId('stitch-readiness')).toContainText('valid');

	expect(externalRequests).toEqual([]);
});

test('handoff: a safe arrival (no existing source image or holes) auto-imports the stitched image with no confirmation click', async ({
	page
}) => {
	test.setTimeout(90000);
	await gotoApp(page, '/stitch-map');
	await importFixtureSet(page);
	await page.getByTestId('continue-to-annotate').click();
	await expect(page).toHaveURL(/\/annotate-course$/);

	// A fresh Annotate Course session has no source image and no holes yet, so
	// the handoff is safe to complete on its own — no banner, no click.
	await expect(page.getByTestId('pending-handoff')).toBeHidden();
	await expect(page.getByTestId('annotation-workspace')).toHaveAttribute('data-source-loaded', 'true');
});

test('handoff: a pending handoff blocks a second one until dismissed, and a target-role handoff lands on Create Graphics', async ({
	page
}) => {
	test.setTimeout(120000);
	await gotoApp(page, '/stitch-map');
	await importFixtureSet(page);
	await page.getByTestId('continue-to-annotate').click();
	await expect(page).toHaveURL(/\/annotate-course$/);
	await expect(page.getByTestId('annotation-workspace')).toHaveAttribute('data-source-loaded', 'true');

	// A source image is now loaded, so a *second* handoff is no longer safe to
	// auto-import — the banner returns.
	await page.getByRole('link', { name: 'Stitch Map' }).click();
	await importFixtureSet(page);
	await page.getByTestId('continue-to-annotate').click();
	await expect(page).toHaveURL(/\/annotate-course$/);
	const sourceBanner = page.getByTestId('pending-handoff');
	await expect(sourceBanner).toBeVisible();
	await page.getByTestId('handoff-dismiss').click();
	await expect(sourceBanner).toBeHidden();

	// A target-role handoff lands directly on Create Graphics.
	await page.getByRole('link', { name: 'Stitch Map' }).click();
	await importFixtureSet(page);
	await page.getByTestId('use-as-target').click();
	await expect(page).toHaveURL(/\/create-graphics$/);
	const targetBanner = page.getByTestId('pending-handoff');
	await expect(targetBanner).toBeVisible();
	await expect(targetBanner).toContainText('clean target');
});
