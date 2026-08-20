import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

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

async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
	await page.mouse.move(from.x, from.y);
	await page.mouse.down();
	await page.mouse.move(to.x, to.y, { steps: 8 });
	await page.mouse.up();
}

test('auto-first workflow: unordered grid import lands directly on an assembled result, alignment-review correction (drag, reset) still works, and download/handoff are native', async ({
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

	await expect(page.getByTestId('alignment-review')).toHaveCount(0);

	await importFixtureSet(page);

	// No forced approval click: the result is already the assembled composite,
	// and the shared crop the auto pipeline detected (plus its default +2px
	// safety margin per side) is already applied — not just proposed. The
	// Yes/No review HUD (StitchAlignmentReview, CHSPT-40) offers the same
	// "continue" affordance the old `continue-to-annotate` button used to be;
	// the rest (download, send-to-Create-Graphics) live under "More actions".
	await expect(page.getByTestId('alignment-yes')).toBeEnabled();
	await page.getByTestId('result-more-toggle').click();
	await expect(page.getByTestId('download-stitched')).toBeEnabled();
	await expect(page.getByTestId('use-as-target')).toBeEnabled();

	// Enter correction mode ("No, let me fix it") and drag one source's
	// outline — the replacement for the old per-tile x/y placement editor.
	await page.getByTestId('alignment-no').click();
	const outline = page.getByTestId('source-outline-1');
	await outline.scrollIntoViewIfNeeded();
	const box = await outline.boundingBox();
	if (!box) throw new Error('source outline has no bounds');
	const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
	await drag(page, center, { x: center.x + 24, y: center.y + 10 });
	// The drag stages instantly and must NOT re-render the composite on its
	// own — only an explicit Apply/Reset does that expensive work (perf fix:
	// dragging used to trigger a full recomposite + encode + hash + badge
	// re-detection per drag, which crawled for several seconds).
	await expect(page.getByTestId('stitch-status')).not.toContainText('Stitch adjustment applied.');
	await expect(page.getByTestId('alignment-apply')).toBeEnabled();

	await page.getByTestId('alignment-apply').click();
	await expect(page.getByTestId('stitch-status')).toContainText('Stitch adjustment applied.');
	await expect(page.getByTestId('alignment-yes')).toBeVisible();

	// Reset all restores every source to its auto-arranged position —
	// required for the deterministic export check below.
	await page.getByTestId('alignment-no').click();
	await page.getByTestId('alignment-reset-all').click();
	await expect(page.getByTestId('stitch-status')).toContainText('Stitch adjustment applied.');
	await page.getByTestId('alignment-apply').click();
	await expect(page.getByTestId('alignment-yes')).toBeVisible();

	// Native-resolution export: cropped 200x189 tiles (crop top 6 / bottom 5)
	// at ground truth (0,0)/(150,0)/(0,150)/(150,150) span x 0..350, y 0..339 —
	// valid only because Reset all put every source back at its auto position.
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

	expect(externalRequests).toEqual([]);
});

test('handoff: a safe arrival (no existing source image or holes) auto-imports the stitched image with no confirmation click', async ({
	page
}) => {
	test.setTimeout(90000);
	await gotoApp(page, '/stitch-map');
	await importFixtureSet(page);
	await page.getByTestId('alignment-yes').click();
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
	await page.getByTestId('alignment-yes').click();
	await expect(page).toHaveURL(/\/annotate-course$/);
	await expect(page.getByTestId('annotation-workspace')).toHaveAttribute('data-source-loaded', 'true');

	// A source image is now loaded, so a *second* handoff is no longer safe to
	// auto-import — the banner returns.
	await page.getByRole('link', { name: 'Stitch Map' }).click();
	await importFixtureSet(page);
	await page.getByTestId('alignment-yes').click();
	await expect(page).toHaveURL(/\/annotate-course$/);
	const sourceBanner = page.getByTestId('pending-handoff');
	await expect(sourceBanner).toBeVisible();
	await page.getByTestId('handoff-dismiss').click();
	await expect(sourceBanner).toBeHidden();

	// A target-role handoff lands directly on Create Graphics.
	await page.getByRole('link', { name: 'Stitch Map' }).click();
	await importFixtureSet(page);
	await page.getByTestId('result-more-toggle').click();
	await page.getByTestId('use-as-target').click();
	await expect(page).toHaveURL(/\/create-graphics$/);
	const targetBanner = page.getByTestId('pending-handoff');
	await expect(targetBanner).toBeVisible();
	await expect(targetBanner).toContainText('clean target');
});
