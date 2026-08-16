import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * CHSPT-55/56 browser case, using the committed "incompatible" and "strong"
 * smart-import fixtures. The "incompatible" fixture reduces overlap on two
 * edges to 15% (below ChainSpot's intended 20-30% band) while keeping every
 * pairwise match genuine, real content — with the single-signal diagnostic
 * (correlation score only; see `diagnostics.ts`), reduced-but-real overlap
 * like this does not produce a warning: the score alone stays comfortably
 * high, so it lands directly on the result with `confidence: 'auto'`, no
 * review banner, exactly like a well-overlapped capture. What this case
 * still protects: every decoded file is preserved regardless of confidence
 * and manual correction remains fully available.
 */
const STRONG_FIXTURES = join(process.cwd(), 'tests', 'fixtures', 'smart-import');
const INCOMPATIBLE_FIXTURES = join(STRONG_FIXTURES, 'incompatible');

const STRONG_FILES = ['smart-ll.png', 'smart-ur.png', 'smart-lr.png', 'smart-ul.png'].map((name) => ({
	name,
	mimeType: 'image/png',
	buffer: readFileSync(join(STRONG_FIXTURES, name))
}));

async function gotoApp(page: Page): Promise<string> {
	await page.goto('/stitch-map');
	await page.waitForFunction(() => document.documentElement.dataset.appReady === 'true');
	return new URL(page.url()).origin;
}

test('a reduced-overlap import still lands on an assembled, high-confidence result with every file preserved and correction available', async ({
	page
}) => {
	// See the timing note on the smart-import assertion below for why this
	// needs headroom beyond Playwright's 30s default.
	test.setTimeout(90000);
	const serverOrigin = await gotoApp(page);

	const externalRequests: string[] = [];
	page.on('request', (request) => {
		const url = new URL(request.url());
		if (url.origin !== serverOrigin) externalRequests.push(request.url());
	});

	const incompatibleFiles = ['smart-ll.png', 'smart-ur.png', 'smart-lr.png', 'smart-ul.png'].map(
		(name) => ({
			name,
			mimeType: 'image/png',
			buffer: readFileSync(join(INCOMPATIBLE_FIXTURES, name))
		})
	);
	await page.getByTestId('smart-import-input').setInputFiles(incompatibleFiles);

	// Extended from Playwright's 5s default: this is the worker's first real
	// `cv.matchTemplate` call in its lifetime, which pays a one-time WASM
	// JIT/lazy-compile tax on top of whatever the eager
	// `warmSmartStitchWorker()` call already covers (measured 10-12s locally,
	// more under concurrent e2e-worker CPU contention).
	await expect(page.getByTestId('composite-image')).toBeVisible({ timeout: 60000 });

	// Reduced-but-real overlap is not flagged by the single correlation-score
	// signal: the result lands as high confidence, with no review banner.
	await expect(page.getByTestId('confidence-review')).toHaveCount(0);
	await expect(page.getByTestId('continue-to-annotate')).toBeEnabled();

	// Every decoded file is preserved and manual correction remains available.
	// The tile now starts at its real computed placement (the automatic
	// arrangement always commits, even under weaker evidence) rather than a
	// blank manual-layout position, so the starting x is read rather than
	// assumed.
	await page.getByTestId('adjust-manually').click();
	await expect(page.getByTestId('manual-capture-list').locator('li')).toHaveCount(4);
	await page.getByTestId('tile-select-tile-1').click();
	await expect(page.getByTestId('tile-position-x')).toBeEnabled();
	const startX = Number(await page.getByTestId('tile-position-x').inputValue());
	await page.keyboard.press('ArrowRight');
	await expect(page.getByTestId('tile-position-x')).toHaveValue(String(startX + 1));

	// The crop evidence (identical repeated chrome across all four files) is
	// independently strong, and is already applied — not merely proposed — so
	// the seeded shared crop is non-zero on both the top and bottom edges
	// (this fixture set's exact chrome depth is a detail of the "incompatible"
	// fixtures, not asserted pixel-for-pixel here).
	await page.getByTestId('manual-tab-crop').click();
	const topCrop = Number(await page.getByTestId('crop-topPx').inputValue());
	const bottomCrop = Number(await page.getByTestId('crop-bottomPx').inputValue());
	expect(topCrop).toBeGreaterThan(0);
	expect(bottomCrop).toBeGreaterThan(0);

	expect(externalRequests).toEqual([]);
});

/**
 * The duplicate check runs inside the smart-stitch worker, which unit tests
 * cannot reach — this is the only coverage of the path the browser actually
 * takes. It pins both halves of the rule: the same screenshot twice is
 * refused by name, leaving the import screen untouched, and a subsequent
 * valid import still succeeds.
 */
test('the same screenshot supplied twice is rejected by name, leaving the import screen unchanged, and a later valid import still succeeds', async ({
	page
}) => {
	test.setTimeout(90000);
	await gotoApp(page);

	const duplicated = [
		STRONG_FILES[0],
		STRONG_FILES[1],
		STRONG_FILES[2],
		{ ...STRONG_FILES[0], name: 'smart-ll-copy.png' }
	];
	await page.getByTestId('smart-import-input').setInputFiles(duplicated);

	const error = page.getByTestId('smart-import-error');
	await expect(error).toBeVisible({ timeout: 60000 });
	// Both files are named, so the user can tell which selection to fix.
	await expect(error).toContainText('smart-ll-copy.png');
	await expect(error).toContainText('smart-ll.png');
	// Rejected before ever reaching the processing/result phases.
	await expect(page.getByTestId('smart-import-input')).toBeVisible();
	await expect(page.getByTestId('composite-image')).toHaveCount(0);

	// A later valid import still succeeds — the rejection did not corrupt any
	// import-batch guard state.
	await page.getByTestId('smart-import-input').setInputFiles(STRONG_FILES);
	await expect(page.getByTestId('composite-image')).toBeVisible({ timeout: 60000 });
	await expect(page.getByTestId('continue-to-annotate')).toBeEnabled();
});
