/**
 * Measures real in-browser corridor-bend-detection latency for a guided
 * approval session over the Dash course (IMG_5641, 18 holes), driving the
 * ACTUAL annotate-round app in a real headless Chromium via Playwright --
 * not a Node reimplementation.
 *
 * Flow (mirrors a real guided-approval session):
 *   1. Load /annotate-round, upload the real IMG_5641.jpg fixture through the
 *      same file input a user would use (`pane-input-source-overview`).
 *   2. Flip the "Ground truth tools" dev toggle and click "Assign ground
 *      truth" -- this seeds accurate tee/basket/badge positions for all 18
 *      Dash holes from IMG_5641_GROUND_TRUTH, but ALSO marks every
 *      tee/basket as already confirmed (see `handleAssignGroundTruth`),
 *      which bypasses `approveHolePieces` (and therefore
 *      `detectAndApplyCorridorBends`) entirely.
 *   3. To still exercise the real approve-time detection path, this script
 *      relies on a TEMPORARY debug hook added to +page.svelte for this
 *      measurement task: `window.__debugApproveHoleByNumber(n)`, which
 *      looks up the hole by number and calls the real `approveHolePieces`
 *      (the exact function the sidebar's Approve button calls). It is
 *      invoked once per hole, in ascending order 1..18, matching the order
 *      a real guided-approval session goes through the sidebar.
 *   4. `approveHolePieces` (also temporarily instrumented) brackets its own
 *      call to `detectAndApplyCorridorBends` with `performance.now()` and
 *      pushes `{holeNumber, ms}` onto `window.__corridorBendTimings` --
 *      read back at the end of the run.
 *
 * This times the REAL synchronous main-thread cost a user's Approve click
 * would pay: raster crop via canvas (`cropSourceRasterAroundHole`, which
 * cannot run in Node -- this is exactly what a Node-side benchmark cannot
 * capture) + badge lookup + the capsule detector itself
 * (`detectAndApplyCorridorBendsCapsule`).
 *
 * Requires: `npm run dev` already serving on 127.0.0.1:5173 (or set
 * PW_PORT), PLUS the temporary instrumentation described in step 3/4 above,
 * added to `src/routes/annotate-round/+page.svelte` for this measurement
 * task and REVERTED (via `git checkout`) once the numbers were captured --
 * this script errors out cleanly ("hook missing") against an unmodified
 * checkout rather than silently measuring nothing. To reproduce, reapply:
 *
 *   1. In `approveHolePieces`, right after `detectAndApplyCorridorBends(holeId)`
 *      is (still) called, wrap that one call with performance.now() before/after
 *      and push `{ holeNumber: hole.number, ms }` onto
 *      `(window as any).__corridorBendTimings ??= []`.
 *   2. In the existing `onMount(() => { ... })` block, assign
 *      `(window as any).__debugApproveHoleByNumber = (n: number) => {
 *         const hole = holes.find((h) => h.number === n);
 *         if (hole) approveHolePieces(hole.id);
 *       };`
 *
 * Both are pure additions (no existing line changed), <25 lines total, and
 * safe to revert afterward with `git checkout -- src/routes/annotate-round/+page.svelte`.
 *
 * Run (from the project root): npx tsx scripts/measure-bend-detection-session.ts [--repeats N]
 */

import { chromium } from '@playwright/test';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = resolve(dirname(scriptPath), '..');

const PORT = process.env.PW_PORT ?? '5173';
const BASE_URL = `http://127.0.0.1:${PORT}`;
const IMAGE_PATH = resolve(projectRoot, 'resources/ribbon-reference/IMG_5641.jpg');

const CHROMIUM_PATH = process.env.PW_CHROMIUM_PATH ?? '/opt/pw-browsers/chromium';

interface HoleTiming {
	readonly holeNumber: number;
	readonly ms: number;
}

function median(values: readonly number[]): number {
	const sorted = values.slice().sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}
function mean(values: readonly number[]): number {
	return values.reduce((sum, value) => sum + value, 0) / values.length;
}

async function runOneSession(chromiumPath: string, label: string): Promise<HoleTiming[]> {
	const browser = await chromium.launch({ executablePath: existsSync(chromiumPath) ? chromiumPath : undefined });
	try {
		const page = await browser.newPage();
		page.on('pageerror', (err) => console.error(`[${label}] pageerror:`, err));
		page.on('console', (msg) => {
			if (msg.type() === 'error') console.error(`[${label}] console.error:`, msg.text());
		});

		await page.goto(`${BASE_URL}/annotate-round`);
		await page.waitForFunction(() => document.documentElement.dataset.appReady === 'true');

		// Real production entry point: same file input a user drags/drops or
		// picks through, loaded with the exact real Dash course fixture image.
		await page.getByTestId('pane-input-source-overview').setInputFiles(IMAGE_PATH);
		await page.getByTestId('annotate-round').waitFor({ state: 'attached' });
		await page.waitForSelector('[data-testid="annotate-round"][data-source-loaded="true"]', { timeout: 30_000 });

		// Reveal + use the dev-only ground-truth shortcut to seed accurate
		// tee/basket/badge positions for all 18 holes (see module doc comment
		// for why this is necessary and how the debug hook works around the
		// resulting already-confirmed state).
		await page.getByTestId('ground-truth-tools-toggle').click();
		const assignButton = page.getByTestId('assign-ground-truth');
		await assignButton.waitFor({ state: 'visible' });
		await assignButton.click();
		await page.waitForFunction(
			() => document.querySelector('[data-testid="course-detection-controls-progress"]')?.textContent?.includes('Ground truth assigned') ?? false
		);

		// Reset the timing sink and walk holes 1..18 in ascending order,
		// exactly the order a real guided-approval session goes through the
		// sidebar's "Placed — unconfirmed" section.
		await page.evaluate(() => {
			(window as unknown as { __corridorBendTimings?: unknown[] }).__corridorBendTimings = [];
		});

		for (let holeNumber = 1; holeNumber <= 18; holeNumber += 1) {
			await page.evaluate((n) => {
				const hook = (window as unknown as { __debugApproveHoleByNumber?: (n: number) => void }).__debugApproveHoleByNumber;
				if (!hook) throw new Error('__debugApproveHoleByNumber hook missing -- temp instrumentation not present in this build');
				hook(n);
			}, holeNumber);
		}

		const timings = await page.evaluate(
			() => (window as unknown as { __corridorBendTimings?: HoleTiming[] }).__corridorBendTimings ?? []
		);
		return timings;
	} finally {
		await browser.close();
	}
}

function report(label: string, timings: HoleTiming[]): void {
	console.log(`\n=== ${label} ===`);
	console.log('hole | ms      | cumulative ms');
	let cumulative = 0;
	for (const t of timings) {
		cumulative += t.ms;
		console.log(`${String(t.holeNumber).padStart(4)} | ${t.ms.toFixed(2).padStart(8)} | ${cumulative.toFixed(2).padStart(13)}`);
	}
	const ms = timings.map((t) => t.ms);
	console.log(`\nholes measured: ${timings.length}/18`);
	console.log(`median/hole: ${median(ms).toFixed(2)}ms  mean/hole: ${mean(ms).toFixed(2)}ms  min: ${Math.min(...ms).toFixed(2)}ms  max: ${Math.max(...ms).toFixed(2)}ms`);
	console.log(`cumulative total for all ${timings.length} holes: ${cumulative.toFixed(2)}ms`);
}

async function main(): Promise<void> {
	const repeatsArgIndex = process.argv.indexOf('--repeats');
	const repeats = repeatsArgIndex >= 0 ? Number(process.argv[repeatsArgIndex + 1]) : 1;

	console.log(`Base URL: ${BASE_URL}`);
	console.log(`Image: ${IMAGE_PATH}`);
	console.log(`Chromium: ${CHROMIUM_PATH}`);
	console.log(`Sessions to run: ${repeats}`);

	const allSessions: HoleTiming[][] = [];
	for (let i = 0; i < repeats; i += 1) {
		const label = `Session ${i + 1}/${repeats} (fresh page load, holes 1..18 in order)`;
		const timings = await runOneSession(CHROMIUM_PATH, label);
		report(label, timings);
		allSessions.push(timings);
	}

	if (allSessions.length > 1) {
		console.log('\n=== Cross-session per-hole median (of session medians-of-1, i.e. per-hole across repeats) ===');
		console.log('hole | ' + allSessions.map((_, i) => `s${i + 1} ms`.padStart(9)).join(' | ') + ' | median ms');
		for (let holeIdx = 0; holeIdx < 18; holeIdx += 1) {
			const acrossSessions = allSessions.map((session) => session[holeIdx]?.ms ?? NaN);
			const holeNumber = allSessions[0][holeIdx]?.holeNumber ?? holeIdx + 1;
			console.log(
				`${String(holeNumber).padStart(4)} | ` +
					acrossSessions.map((v) => v.toFixed(2).padStart(9)).join(' | ') +
					` | ${median(acrossSessions.filter((v) => !Number.isNaN(v))).toFixed(2)}`
			);
		}
		const grandTotals = allSessions.map((session) => session.reduce((sum, t) => sum + t.ms, 0));
		console.log(`\nGrand totals per session: ${grandTotals.map((v) => v.toFixed(2)).join(', ')} ms`);
		console.log(`Median grand total across sessions: ${median(grandTotals).toFixed(2)}ms`);
	}
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
	process.exitCode = 1;
});
