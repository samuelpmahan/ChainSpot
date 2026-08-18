/**
 * Screenshots a live Toph replay viewer session with Playwright, for proof
 * purposes. Requires ChainSpot's installed Playwright + a Chromium binary
 * (set `PLAYWRIGHT_BROWSERS_PATH`, do not `playwright install`).
 *
 * Usage:
 *   PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers npx tsx scripts/toph-proof-shoot.ts \
 *     --session <sessionDir> --out <dir> [--toph-dir ../toph] [--port 4174] \
 *     [--image resources/cv-fixtures/TheRec-stitched.png] [--truth resources/cv-fixtures/the-rec.json]
 *
 * `--session` should already contain a baseline + counterfactual children
 * (e.g. the session directory `scripts/toph-replay-proof.ts` produces) so
 * the tree/runs table has something interesting to show.
 */
import { existsSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';

import { createChainSpotReplayAdapter } from './toph-replay-adapter';

const __dirname = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv: readonly string[]) {
	const get = (flag: string): string | undefined => {
		const index = argv.indexOf(flag);
		return index >= 0 ? argv[index + 1] : undefined;
	};
	const session = get('--session');
	const out = get('--out');
	if (!session || !out) {
		throw new Error('Usage: toph-proof-shoot.ts --session <dir> --out <dir> [--toph-dir <path>] [--port <n>]');
	}
	return {
		session: resolve(session),
		out: resolve(out),
		tophDir: resolve(get('--toph-dir') ?? process.env.TOPH_DIR ?? resolveDefaultTophDir()),
		port: Number(get('--port') ?? '4174'),
		image: resolve(get('--image') ?? 'resources/cv-fixtures/TheRec-stitched.png'),
		truthPath: get('--truth') ? resolve(get('--truth')!) : resolve('resources/cv-fixtures/the-rec.json')
	};
}

function resolveDefaultTophDir(): string {
	const sibling = resolve(__dirname, '..', '..', 'toph');
	return existsSync(sibling) ? sibling : '/workspace/toph';
}

function contentTypeFor(path: string): string {
	switch (extname(path).toLowerCase()) {
		case '.png':
			return 'image/png';
		case '.jpg':
		case '.jpeg':
			return 'image/jpeg';
		default:
			return 'application/octet-stream';
	}
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	const projectRoot = resolve(__dirname, '..');

	const adapter = await createChainSpotReplayAdapter({
		imagePath: args.image,
		projectRoot,
		tophDir: args.tophDir,
		truthPath: args.truthPath
	});

	const serverUrl = pathToFileURL(resolve(args.tophDir, 'src/viewer/server.ts')).href;
	const { startReplayViewer } = (await import(serverUrl)) as typeof import('/workspace/toph/src/viewer/server.js');

	const handle = await startReplayViewer({
		sessionDir: args.session,
		adapter,
		port: args.port,
		sourceImage: { path: args.image, contentType: contentTypeFor(args.image) }
	});
	console.log('viewer up on', handle.port);

	const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
	const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
	await page.goto(`http://localhost:${handle.port}/`);
	await page.waitForSelector('#tree .treenode', { timeout: 15000 });

	// Select the baseline (root) run -- first treenode in the tree.
	const treenodes = page.locator('#tree .treenode');
	const runLabels = await treenodes.locator('.runlabel').allTextContents();
	console.log('runs in tree:', runLabels);
	await treenodes.first().click();
	await page.waitForTimeout(500);

	// --- Shot 1: baseline selected, scrubber at p6.lowParAssignment ---
	await page.locator('.stagechip', { hasText: 'p6.lowParAssignment' }).first().click();
	await page.waitForTimeout(300);
	await page.screenshot({ path: resolve(args.out, '1-baseline-lowpar.png') });
	console.log('shot 1 done');

	// --- Shot 2: same run scrubbed to p6.swapAdjudication ---
	await page.locator('.stagechip', { hasText: 'p6.swapAdjudication' }).first().click();
	await page.waitForTimeout(300);
	await page.screenshot({ path: resolve(args.out, '2-baseline-swapadjudication.png') });
	console.log('shot 2 done');

	// --- Shot 3: A/B panel, baseline pinned as A vs the p6.swap.enabled=false child pinned as B ---
	await page.locator('#abPanel button', { hasText: 'pin as A' }).click();
	await page.waitForTimeout(200);

	const nodeCount = await treenodes.count();
	let swapOffIndex = -1;
	for (let i = 0; i < nodeCount; i++) {
		const text = await treenodes.nth(i).locator('.runpatch').textContent();
		if (text && text.includes('swap.enabled') && text.includes('false')) {
			swapOffIndex = i;
			break;
		}
	}
	console.log('swap-off treenode index', swapOffIndex);
	if (swapOffIndex >= 0) {
		await treenodes.nth(swapOffIndex).click();
		await page.waitForTimeout(300);
		await page.locator('#abPanel button', { hasText: 'pin as B' }).click();
		await page.waitForTimeout(500);
	}
	await page.locator('#abSection').scrollIntoViewIfNeeded();
	await page.screenshot({ path: resolve(args.out, '3-ab-panel-divergence.png'), fullPage: true });
	console.log('shot 3 done');

	// --- Shot 4: experiment tree + runs summary table with the grid children ---
	await page.locator('#runsTableWrap').scrollIntoViewIfNeeded();
	await page.screenshot({ path: resolve(args.out, '4-tree-and-runs-table.png'), fullPage: true });
	console.log('shot 4 done');

	await browser.close();
	await handle.close();
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
