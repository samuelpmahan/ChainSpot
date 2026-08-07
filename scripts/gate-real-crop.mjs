/**
 * P1-002 real-image manual-gate runner for the shared-crop proposal and the
 * placement reconciliation / Snap-assist continuation.
 *
 * Standalone gate tool, deliberately NOT part of the Playwright test suite (no
 * *.spec.ts), so it does not consume any Phase 1 test budget — same precedent
 * as `perf-smart-import.mjs`.
 *
 * It boots the dev server and a Chromium browser, imports the four real UDisc
 * screenshots from `resources/real-capture/` (BL/BR/TL/TR, 1290x2796) in an
 * order unrelated to their tile roles, and records:
 *   - the inferred slot-to-file assignment;
 *   - the layout confidence category and warnings;
 *   - the proposed top/right/bottom/left insets;
 *   - the crop confidence.
 * It then applies the suggested crop and downloads stitched PNGs so chrome
 * removal and map preservation can be inspected:
 *   - the neutral manual starting layout the page ships for this set
 *     (baseline);
 *   - the independently-placed reconciliation (each non-anchor tile from its
 *     own directly measured evidence — see `reconcilePlacements`'s doc
 *     comment; no rectangle-consistency blending), applied through the same
 *     numeric position inputs;
 *   - a Snap-assist before/after: the upper-right tile is displaced from the
 *     reconciled placement by a rough "dragged by eye" offset, then locked
 *     back with the Snap button.
 * The reconciled placements are computed in-browser from the real modules
 * (same technique as `inspect-auto-layout-scoring.mjs`) and typed into the
 * ordinary position inputs, so the gate exercises the exact UI commit path.
 *
 * The gate fails the implementation if the proposal again leaves obvious UDisc
 * UI chrome under a high-confidence claim, or crops useful map content.
 *
 * Usage:
 *   node scripts/gate-real-crop.mjs
 */
import { spawn } from 'node:child_process';
import { mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const captureDir = join(root, 'resources', 'real-capture');
const outputDir = join(captureDir, 'gate-output');
const fileNames = ['BL.PNG', 'BR.PNG', 'TL.PNG', 'TR.PNG'];
const fixtureFiles = fileNames.map((name) => join(captureDir, name));

for (const file of fixtureFiles) {
	if (!existsSync(file)) {
		console.error(`Missing real screenshot: ${file}`);
		process.exit(1);
	}
}

const dataUrls = fixtureFiles.map(
	(file) => `data:image/png;base64,${readFileSync(file).toString('base64')}`
);

const server = spawn('npm', ['run', 'dev', '--', '--host', '127.0.0.1', '--port', '5199'], {
	cwd: root,
	stdio: ['ignore', 'pipe', 'inherit']
});
const serverUrl = 'http://127.0.0.1:5199';

function waitForServer(url, timeoutMs) {
	return new Promise((resolve, reject) => {
		const started = Date.now();
		const attempt = () => {
			if (Date.now() - started > timeoutMs) return reject(new Error('dev server did not start'));
			fetch(url)
				.then(() => resolve())
				.catch(() => setTimeout(attempt, 250));
		};
		attempt();
	});
}

async function place(page, slot, xPx, yPx) {
	await page.getByTestId(`tile-select-${slot}`).click();
	await page.getByTestId('tile-position-x').fill(String(xPx));
	await page.getByTestId('tile-position-x').blur();
	await page.getByTestId('tile-position-y').fill(String(yPx));
	await page.getByTestId('tile-position-y').blur();
}

async function positionOf(page, slot) {
	await page.getByTestId(`tile-select-${slot}`).click();
	return {
		xPx: Number(await page.getByTestId('tile-position-x').inputValue()),
		yPx: Number(await page.getByTestId('tile-position-y').inputValue())
	};
}

async function downloadStitched(page, path) {
	const downloadPromise = page.waitForEvent('download');
	await page.getByTestId('download-stitched').click();
	const download = await downloadPromise;
	await download.saveAs(path);
	return path;
}

async function main() {
	await waitForServer(serverUrl, 30000);

	const browser = await chromium.launch();
	const page = await browser.newPage();
	try {
		await page.goto(`${serverUrl}/stitch-map`, { waitUntil: 'domcontentloaded' });
		await page.waitForFunction(() => document.documentElement.dataset.appReady === 'true');

		// Selection order is deliberately unrelated to the tile roles.
		await page.getByTestId('smart-import-input').setInputFiles(fixtureFiles);
		await page.getByTestId('smart-import-assignment').waitFor({ state: 'visible', timeout: 120000 });

		const assignment = {};
		for (const slot of ['upper-left', 'upper-right', 'lower-left', 'lower-right']) {
			assignment[slot] = await page.getByTestId(`smart-import-slot-${slot}`).textContent();
		}
		const layoutConfidence = await page.getByTestId('smart-import-confidence').textContent();
		const insets = await page.getByTestId('crop-proposal-insets').textContent().catch(() => null);
		const cropConfidence = await page.getByTestId('crop-confidence').textContent().catch(() => null);
		const warnings = await page
			.getByTestId('smart-import-warnings')
			.locator('li')
			.allTextContents()
			.catch(() => []);

		console.log('Real-capture gate (BL/BR/TL/TR, 1290x2796):');
		console.log(`  assignment: ${JSON.stringify(assignment)}`);
		console.log(`  layout confidence: ${layoutConfidence}`);
		console.log(`  warnings: ${warnings.length > 0 ? warnings.join(' | ') : 'none'}`);
		console.log(`  proposed insets:   ${insets ?? 'no proposal returned'}`);
		console.log(`  crop confidence:   ${cropConfidence ?? 'n/a'}`);

		// The independently-placed reconciliation from the real modules, on the
		// exact same crop-gated matcher evidence `assignFour` used (mirrors
		// `inspect-auto-layout-scoring.mjs`).
		const reconciled = await page.evaluate(async (urls) => {
			const analysis = await import('/src/lib/stitch/analysis.ts');
			const autoLayout = await import('/src/lib/stitch/autoLayout.ts');
			const autoCrop = await import('/src/lib/stitch/autoCrop.ts');
			const cropGate = await import('/src/lib/stitch/cropGate.ts');

			function loadImage(src) {
				return new Promise((resolve, reject) => {
					const img = new Image();
					img.onload = () => resolve(img);
					img.onerror = reject;
					img.src = src;
				});
			}
			const images = await Promise.all(urls.map(loadImage));
			const cropRasters = images.map((img) => analysis.toCropRaster(img));
			const crop = autoCrop.proposeCropDetailed(cropRasters);
			const rasters = images.map((img) => {
				const region = cropGate.matcherRegionFromCrop(
					crop,
					img.naturalWidth,
					img.naturalHeight
				);
				return analysis.toAnalysisRaster(img, undefined, region ?? undefined);
			});
			const layout = await autoLayout.assignFour(rasters);
			const a = layout.assignment;
			const ulur = layout.estimates[`${a['upper-left']}>${a['upper-right']}`]['left-right'];
			const ulll = layout.estimates[`${a['upper-left']}>${a['lower-left']}`]['top-bottom'];
			const urlr = layout.estimates[`${a['upper-right']}>${a['lower-right']}`]['top-bottom'];
			const llr = layout.estimates[`${a['lower-left']}>${a['lower-right']}`]['left-right'];
			return autoLayout.reconcilePlacements(ulur, ulll, urlr, llr);
		}, dataUrls);
		console.log(
			`Reconciled placement: upperRight=(${reconciled.upperRight.xPx},${reconciled.upperRight.yPx}) ` +
				`lowerLeft=(${reconciled.lowerLeft.xPx},${reconciled.lowerLeft.yPx}) ` +
				`lowerRight=(${reconciled.lowerRight.xPx},${reconciled.lowerRight.yPx})`
		);

		mkdirSync(outputDir, { recursive: true });
		const stamp = Date.now();

		// Keep a page screenshot of the imported state for the record.
		await page.screenshot({ path: join(outputDir, `gate-${stamp}.png`) });

		// Apply the crop (if proposed), then export every variant through the
		// ordinary UI commit path so chrome removal, seam quality, and the
		// reconciliation/Snap behavior can all be inspected visually.
		const hasProposal = (await page.getByTestId('crop-proposal').count()) > 0;
		if (hasProposal) {
			await page.getByTestId('apply-suggested-crop').click();

			console.log(
				`  stitched PNG (neutral manual starting layout): ${await downloadStitched(
					page,
					join(outputDir, `stitched-${stamp}-neutral.png`)
				)}`
			);

			await place(page, 'upper-right', reconciled.upperRight.xPx, reconciled.upperRight.yPx);
			await place(page, 'lower-left', reconciled.lowerLeft.xPx, reconciled.lowerLeft.yPx);
			await place(page, 'lower-right', reconciled.lowerRight.xPx, reconciled.lowerRight.yPx);
			console.log(
				`  stitched PNG (reconciled): ${await downloadStitched(
					page,
					join(outputDir, `stitched-${stamp}-reconciled.png`)
				)}`
			);

			// Snap-assist before/after: restore the reconciled placement, displace
			// upper-right by a rough "dragged into place by eye" offset, then let
			// the bounded local search lock it back.
			await place(page, 'upper-right', reconciled.upperRight.xPx, reconciled.upperRight.yPx);
			const displacedX = reconciled.upperRight.xPx + 40;
			const displacedY = reconciled.upperRight.yPx - 30;
			await place(page, 'upper-right', displacedX, displacedY);
			await page.getByTestId('snap-tile').click();
			const snapped = await positionOf(page, 'upper-right');
			console.log(
				`  snap assist: upper-right displaced to (${displacedX},${displacedY}), ` +
					`snapped to (${snapped.xPx},${snapped.yPx}) ` +
					`(reconciled target (${reconciled.upperRight.xPx},${reconciled.upperRight.yPx}))`
			);
			console.log(
				`  stitched PNG (after snap): ${await downloadStitched(
					page,
					join(outputDir, `stitched-${stamp}-snap.png`)
				)}`
			);
		} else {
			console.log('  no crop applied (no defensible shared proposal).');
		}

		console.log(`  page screenshot:   ${join(outputDir, `gate-${stamp}.png`)}`);
		console.log(
			'Inspect the outputs for: obvious UDisc header/footer chrome removed under a high-confidence claim,\nno useful course-map content removed, seam duplication reduced by the reconciled placements,\nand the snap-assist export matching the reconciled export. Record the values above in the P1-002 completion record.'
		);
	} finally {
		await browser.close();
		server.kill();
	}
}

main().catch((error) => {
	console.error(error);
	server.kill();
	process.exitCode = 1;
});
