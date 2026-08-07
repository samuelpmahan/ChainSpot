import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * P1-002 browser case, using the committed "incompatible" and "strong"
 * smart-import fixtures. The "incompatible" fixture reduces overlap on two
 * edges to 15% (below ChainSpot's intended 20-30% band) while keeping every
 * pairwise match genuine, real content — with the single-signal diagnostic
 * (correlation score only, no separate overlap-fraction check; see
 * `diagnostics.ts`), reduced-but-real overlap like this no longer produces a
 * warning: the score alone stays comfortably high, so it commits as `strong`
 * with no warnings, exactly like a well-overlapped capture. What this case
 * still protects: every decoded file is preserved regardless of confidence,
 * manual correction remains available, and a re-run over manual edits
 * requires an explicit replace decision.
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

test('a reduced-overlap import still commits automatically, preserves all files, permits correction, and re-running over manual edits requires an explicit replace decision', async ({
	page
}) => {
	// Extended from Playwright's 30s default: see the timing note below on the
	// first smart-import assertion for why.
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

	// Every decoded file is preserved in the four replaceable slots. Extended
	// from Playwright's 5s default: this is the worker's first real
	// `cv.matchTemplate` call in its lifetime (via `assignFour`), which pays a
	// one-time WASM JIT/lazy-compile tax on top of whatever the eager
	// `loadCv()` warm-up in `smartStitch.worker.ts` already covers (measured
	// 10-12s locally, more under concurrent e2e-worker CPU contention). The
	// second `setInputFiles` re-run later in this test needs no such
	// extension: that worker call is no longer the first one.
	for (const slot of ['upper-left', 'upper-right', 'lower-left', 'lower-right'] as const) {
		await expect(page.getByTestId(`tile-file-${slot}`)).toBeVisible({ timeout: 60000 });
	}
	await expect(page.getByTestId('smart-import-slot-upper-left')).toHaveText('smart-ul.png');

	// Reduced-but-real overlap is not flagged by the single correlation-score
	// signal (see diagnostics.ts): the arrangement commits as strong, with no
	// warnings, exactly like a well-overlapped capture.
	const confidence = page.getByTestId('smart-import-confidence');
	await expect(confidence).toBeVisible();
	await expect(confidence).toContainText('strong');
	await expect(page.getByTestId('smart-import-warnings')).toBeHidden();

	// The crop evidence (identical repeated chrome across all four files) is
	// independently strong, so the shared crop proposal is surfaced with
	// honest high confidence, regardless of the layout diagnostic.
	await expect(page.getByTestId('crop-proposal')).toBeVisible();
	await expect(page.getByTestId('crop-confidence')).toContainText('high');

	// Manual correction remains available: select a movable tile and edit it.
	// The tile now starts at its real computed placement (the automatic
	// arrangement always commits, even under review) rather than a blank
	// manual-layout position, so the starting x is read rather than assumed.
	await expect(page.getByTestId('tile-select-upper-right')).toBeEnabled();
	await page.getByTestId('tile-select-upper-right').click();
	await expect(page.getByTestId('tile-position-x')).toBeEnabled();
	const startX = Number(await page.getByTestId('tile-position-x').inputValue());
	const nudgedX = String(startX + 1);
	await page.keyboard.press('ArrowRight');
	await expect(page.getByTestId('tile-position-x')).toHaveValue(nudgedX);

	// Re-running automatic arrangement over manual edits requires an explicit
	// replace decision; cancelling preserves the manual arrangement.
	await page.getByTestId('smart-import-input').setInputFiles(STRONG_FILES);
	await expect(page.getByTestId('replace-arrangement-confirmation')).toBeVisible();
	await page.getByTestId('replace-confirm-cancel').click();
	await expect(page.getByTestId('replace-arrangement-confirmation')).toBeHidden();
	await expect(page.getByTestId('tile-position-x')).toHaveValue(nudgedX);

	// Confirming performs the replacement with the fresh automatic placement.
	await page.getByTestId('smart-import-input').setInputFiles(STRONG_FILES);
	await expect(page.getByTestId('replace-arrangement-confirmation')).toBeVisible();
	await page.getByTestId('replace-confirm-accept').click();
	await expect(page.getByTestId('replace-arrangement-confirmation')).toBeHidden();
	// The analysis is off the main thread now, so wait for the committed result
	// (busy clears) before selecting a tile to inspect.
	await expect(page.getByTestId('smart-import-input')).toBeEnabled();
	await page.getByTestId('tile-select-upper-right').click();
	await expect(page.getByTestId('tile-position-x')).toHaveValue('150');

	expect(externalRequests).toEqual([]);
});
