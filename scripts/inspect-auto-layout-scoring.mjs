/**
 * Ad-hoc investigation tool (not a gate, not part of any test budget).
 *
 * Loads the four real capture screenshots (`resources/real-capture/`),
 * imports the actual `analysis.ts`/`autoLayout.ts`/`autoCrop.ts`/`cropGate.ts`
 * modules straight from the Vite dev server (so this runs the real scoring
 * code, not a reimplementation), and prints the full pairwise score landscape:
 * every directed pair's left-right and top-bottom hypothesis score, runner-up
 * score, and offset, plus how the winning (automatic) assignment's total score
 * compares to the assignment implied by the files' own names (TL/TR/BL/BR).
 *
 * Mirrors the production `smartImportFiles`/`smartStitch.worker.ts` pipeline:
 * crop evidence is computed first from full-frame crop rasters, and when it is
 * `high` confidence the matcher rasters are built from the cropped interior
 * region via `matcherRegionFromCrop` before `assignFour` scores them. This is
 * what actually removes the shared status-bar/footer chrome from the
 * vertical-matching signal; calling `assignFour` on full-frame rasters (as
 * this script did before the P1-002 matcher-region hardening) reproduces the
 * bug this script exists to diagnose, not the shipped behavior.
 *
 * Usage:
 *   node scripts/inspect-auto-layout-scoring.mjs
 */
import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const captureDir = join(root, 'resources', 'real-capture');
const fileNames = ['TL.PNG', 'TR.PNG', 'BL.PNG', 'BR.PNG'];
const files = fileNames.map((name) => join(captureDir, name));

for (const file of files) {
	if (!existsSync(file)) {
		console.error(`Missing real screenshot: ${file}`);
		process.exit(1);
	}
}

const dataUrls = files.map((file) => `data:image/png;base64,${readFileSync(file).toString('base64')}`);

const server = spawn('npm', ['run', 'dev', '--', '--host', '127.0.0.1', '--port', '5198'], {
	cwd: root,
	stdio: ['ignore', 'pipe', 'inherit']
});
const serverUrl = 'http://127.0.0.1:5198';

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

async function main() {
	await waitForServer(serverUrl, 30000);
	const browser = await chromium.launch();
	const page = await browser.newPage();
	try {
		await page.goto(`${serverUrl}/stitch-map`, { waitUntil: 'domcontentloaded' });

		const result = await page.evaluate(async (urls) => {
			const analysis = await import('/src/lib/stitch/analysis.ts');
			const autoLayout = await import('/src/lib/stitch/autoLayout.ts');
			const autoCrop = await import('/src/lib/stitch/autoCrop.ts');
			const cropGate = await import('/src/lib/stitch/cropGate.ts');
			const diagnostics = await import('/src/lib/stitch/diagnostics.ts');

			function loadImage(src) {
				return new Promise((resolve, reject) => {
					const img = new Image();
					img.onload = () => resolve(img);
					img.onerror = reject;
					img.src = src;
				});
			}

			const images = await Promise.all(urls.map(loadImage));

			// Same order as smartImportFiles: crop evidence from full-frame crop
			// rasters first, then matcher rasters trimmed to the confidently
			// cropped interior when crop confidence is `high`.
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

			// index order here is TL=0, TR=1, BL=2, BR=3 (the array we loaded).
			const estimates = {};
			for (const [key, value] of Object.entries(layout.estimates)) {
				estimates[key] = value;
			}

			// Each non-anchor tile's placement now comes straight from its own
			// directly measured evidence (see `reconcilePlacements`'s doc comment):
			// upper-right/lower-left are their raw single measurement, and
			// lower-right averages its two paths. No rectangle-consistency
			// blending happens anymore, so there is nothing left to compare against
			// a "score-weighted" alternative — that comparison was retired once the
			// blending itself was removed (P1-002, fifth round).
			const diagnostic = diagnostics.classifyLayout(layout);

			// `AutoLayout.edgeScores` was deleted (P1-002, sixth round, diagnostics
			// cut): re-derive the winning assignment's four expected-edge scores
			// from `estimates` + `assignment`, the same way `diagnostics.ts` does.
			const expectedEdges = [
				{ from: 'upper-left', to: 'upper-right', orientation: 'left-right' },
				{ from: 'upper-left', to: 'lower-left', orientation: 'top-bottom' },
				{ from: 'upper-right', to: 'lower-right', orientation: 'top-bottom' },
				{ from: 'lower-left', to: 'lower-right', orientation: 'left-right' }
			];
			const edgeScores = {};
			for (const edge of expectedEdges) {
				const from = layout.assignment[edge.from];
				const to = layout.assignment[edge.to];
				const est = layout.estimates[`${from}>${to}`]?.[edge.orientation];
				edgeScores[`${edge.from}>${edge.to}`] = est ? est.score : 0;
			}

			return {
				crop,
				assignment: layout.assignment,
				edgeScores,
				placements: layout.placements,
				diagnostic,
				estimates
			};
		}, dataUrls);

		const fileByIndex = fileNames;
		console.log('Loaded index -> file:', fileByIndex.map((f, i) => `${i}=${f}`).join(', '));
		console.log(
			`\nCrop evidence: confidence=${result.crop.confidence}, insets=${JSON.stringify(result.crop.insets)}`
		);
		console.log(
			result.crop.confidence === 'high'
				? '=> Matcher rasters were trimmed to the cropped interior before scoring.'
				: '=> Crop confidence is not high; matcher rasters used the full frame (unchanged fallback).'
		);
		console.log('\nWinning assignment (slot -> loaded index -> file):');
		for (const [slot, idx] of Object.entries(result.assignment)) {
			console.log(`  ${slot}: index ${idx} (${fileByIndex[idx]})`);
		}
		console.log('\nWinning edge scores:', result.edgeScores);
		console.log('Independent placements (upper-left anchored at 0,0):', result.placements);
		console.log(
			`\nDiagnostic category: ${result.diagnostic.category}` +
				(result.diagnostic.warnings.length > 0
					? `\nWarnings:\n  ${result.diagnostic.warnings.join('\n  ')}`
					: ' (no warnings)')
		);

		console.log('\nFull pairwise estimate landscape (index i > index j):');
		for (const [key, est] of Object.entries(result.estimates)) {
			const lr = est['left-right'];
			const tb = est['top-bottom'];
			console.log(
				`  ${key} (${fileByIndex[Number(key.split('>')[0])]} > ${fileByIndex[Number(key.split('>')[1])]}):` +
					`\n    left-right: score=${lr.score.toFixed(4)} runnerUp=${lr.runnerUpScore.toFixed(4)} dx=${lr.dxPx} dy=${lr.dyPx} overlap=${lr.overlapFractionPx.toFixed(3)}` +
					`\n    top-bottom: score=${tb.score.toFixed(4)} runnerUp=${tb.runnerUpScore.toFixed(4)} dx=${tb.dxPx} dy=${tb.dyPx} overlap=${tb.overlapFractionPx.toFixed(3)}` +
					`\n    winning orientation: ${est.orientation}`
			);
		}

		// Ground truth per the files' own names: TL=0 is upper-left, TR=1 is
		// upper-right, BL=2 is lower-left, BR=3 is lower-right.
		const trueAssignment = { 'upper-left': 0, 'upper-right': 1, 'lower-left': 2, 'lower-right': 3 };
		const requiredOrientation = {
			'upper-left>upper-right': 'left-right',
			'upper-left>lower-left': 'top-bottom',
			'upper-right>lower-right': 'top-bottom',
			'lower-left>lower-right': 'left-right'
		};
		let trueScore = 0;
		console.log('\nName-implied ("true") assignment edge scores:');
		for (const [edge, orientation] of Object.entries(requiredOrientation)) {
			const [fromSlot, toSlot] = edge.split('>');
			const fromIdx = trueAssignment[fromSlot];
			const toIdx = trueAssignment[toSlot];
			const est = result.estimates[`${fromIdx}>${toIdx}`];
			const score = est ? est[orientation].score : null;
			trueScore += score ?? 0;
			console.log(`  ${edge}: index ${fromIdx}>${toIdx}, ${orientation} score=${score?.toFixed(4)}`);
		}
		const winningTotal = Object.values(result.edgeScores).reduce((a, b) => a + b, 0);
		console.log(`\nWinning assignment total score: ${winningTotal.toFixed(4)}`);
		console.log(`Name-implied assignment total score: ${trueScore.toFixed(4)}`);
		console.log(
			winningTotal > trueScore
				? '=> The scorer prefers the WRONG assignment over the name-implied correct one.'
				: '=> The name-implied assignment would have scored higher than the winner (search/permutation issue, not a scoring-function issue).'
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
