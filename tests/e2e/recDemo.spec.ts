/**
 * The Rec demo data-integrity gate (NuThing P2 demo prep).
 *
 * Two claims, verified in the real product with the real captures:
 *
 * 1. STITCH PARITY — the composite the browser assembles from the two Rec
 *    captures is byte-identical (full RGBA hash) to the composite the
 *    headless harness (scripts/nuthing/rec-stitch-harness.ts) produced from
 *    the same files. This is what makes coordinates computed offline by the
 *    pairing pipeline valid in the browser's image space at all.
 *
 * 2. HIDDEN STATE <-> VISIBLE PIXELS — after the ordinary handoff to
 *    Annotate Course, every tee and basket coordinate in the pipeline's
 *    assignments file, projected through the pane's own published view
 *    transform (data-view-zoom/panX/panY), lands on a locally bright render
 *    feature in an actual screenshot of the pane. "Pad 2" is asserted
 *    specifically (with a centroid tolerance), because an earlier session
 *    could not locate it through Playwright by eye; the fix is to never
 *    eyeball — project hidden-state coordinates through the transform and
 *    measure pixels.
 *
 * The Rec assets live in the corpus repo, not this one, so every test skips
 * cleanly when they are absent (CI without the corpus stays green). Paths
 * are overridable:
 *   REC_DEMO_DIR            captures dir (default /workspace/chainspot-corpus/demo)
 *   REC_EXPECTED_COMPOSITE  harness composite.png for the parity hash
 *   REC_ASSIGNMENTS         pairing assignments json (geometry-frame coords)
 *   REC_GEO_SCALE           geometry-raster scale vs native (default 0.5)
 */
import { existsSync, readFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import { expect, test } from '@playwright/test';
import type { Page, TestInfo } from '@playwright/test';

const DEMO_DIR = process.env.REC_DEMO_DIR ?? '/workspace/chainspot-corpus/demo';
const EXPECTED_COMPOSITE =
	process.env.REC_EXPECTED_COMPOSITE ?? '/workspace/nuthing-work/rec-demo/composite.png';
const ASSIGNMENTS =
	process.env.REC_ASSIGNMENTS ?? '/workspace/nuthing-work/pair-matrix-v4/TheRec-full-assignments.json';
const GEO_SCALE = Number(process.env.REC_GEO_SCALE ?? '0.5');

const CAPTURE_L = `${DEMO_DIR}/TheRec-L.PNG`;
const CAPTURE_R = `${DEMO_DIR}/TheRec-R.PNG`;
const HAVE_CAPTURES = existsSync(CAPTURE_L) && existsSync(CAPTURE_R);

interface AssignmentHole {
	hole: number;
	tee: { xPx: number; yPx: number };
	basket: { xPx: number; yPx: number };
	pairScore: number;
}

/**
 * Order-dependent double-FNV-1a over RGBA bytes. Small and dependency-free so
 * the exact same source runs in Node (over pngjs output) and in the page
 * (over canvas ImageData); two seeds because a single 32-bit FNV over ~20MB
 * is collision-prone enough to matter for a parity gate.
 */
function rgbaHash(data: Uint8Array | Uint8ClampedArray): string {
	let h1 = 0x811c9dc5 | 0;
	let h2 = 0x01000193 | 0;
	for (let i = 0; i < data.length; i++) {
		h1 = Math.imul(h1 ^ data[i], 16777619);
		h2 = Math.imul(h2 ^ data[i], 33554467);
	}
	return `${(h1 >>> 0).toString(16)}-${(h2 >>> 0).toString(16)}-${data.length}`;
}

async function gotoApp(page: Page, route: string): Promise<void> {
	await page.goto(route);
	await page.waitForFunction(() => document.documentElement.dataset.appReady === 'true');
}

async function importRecCaptures(page: Page): Promise<void> {
	await page.getByTestId('smart-import-input').setInputFiles([
		{ name: 'TheRec-L.PNG', mimeType: 'image/png', buffer: readFileSync(CAPTURE_L) },
		{ name: 'TheRec-R.PNG', mimeType: 'image/png', buffer: readFileSync(CAPTURE_R) }
	]);
	// Neither Rec capture is a played round, so answer the thrown-round
	// triage (shown when the import can't rule one out on its own) with
	// "stitch all".
	const stitchAll = page.getByRole('button', { name: /No thrown round/ });
	await stitchAll.click({ timeout: 15000 });
	// First matchTemplate call in the browser pays the one-time WASM
	// JIT/lazy-compile tax on top of the module load (see smartImport.spec).
	await expect(page.getByTestId('composite-image')).toBeVisible({ timeout: 120000 });
}

/** Draw the rendered composite <img> to a canvas and hash its raw RGBA. */
async function compositeHashInPage(
	page: Page
): Promise<{ width: number; height: number; hash: string }> {
	return page.evaluate(() => {
		const img = document.querySelector<HTMLImageElement>('[data-testid="composite-image"]');
		if (!img) throw new Error('composite-image not found');
		const canvas = document.createElement('canvas');
		canvas.width = img.naturalWidth;
		canvas.height = img.naturalHeight;
		const context = canvas.getContext('2d', { willReadFrequently: true });
		if (!context) throw new Error('no 2d context');
		context.drawImage(img, 0, 0);
		const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
		let h1 = 0x811c9dc5 | 0;
		let h2 = 0x01000193 | 0;
		for (let i = 0; i < data.length; i++) {
			h1 = Math.imul(h1 ^ data[i], 16777619);
			h2 = Math.imul(h2 ^ data[i], 33554467);
		}
		return {
			width: canvas.width,
			height: canvas.height,
			hash: `${(h1 >>> 0).toString(16)}-${(h2 >>> 0).toString(16)}-${data.length}`
		};
	});
}

interface PaneView {
	zoom: number;
	panX: number;
	panY: number;
	clientLeft: number;
	clientTop: number;
	width: number;
	height: number;
}

async function paneView(page: Page): Promise<PaneView> {
	return page.evaluate(() => {
		const element = document.querySelector<HTMLElement>(
			'[data-testid="pane-scene-source-overview"]'
		);
		if (!element) throw new Error('missing pane-scene-source-overview');
		return {
			zoom: Number(element.dataset.viewZoom),
			panX: Number(element.dataset.viewPanX),
			panY: Number(element.dataset.viewPanY),
			clientLeft: element.clientLeft,
			clientTop: element.clientTop,
			width: element.clientWidth,
			height: element.clientHeight
		};
	});
}

/** Mean brightness (max of r,g,b — render furniture is white-family) in a disk. */
function diskStats(
	shot: PNG,
	cx: number,
	cy: number,
	radius: number
): { mean: number; brightCount: number; centroidX: number; centroidY: number } {
	let sum = 0;
	let n = 0;
	let brightCount = 0;
	let cxAcc = 0;
	let cyAcc = 0;
	for (let y = Math.max(0, Math.round(cy - radius)); y <= Math.min(shot.height - 1, Math.round(cy + radius)); y++) {
		for (let x = Math.max(0, Math.round(cx - radius)); x <= Math.min(shot.width - 1, Math.round(cx + radius)); x++) {
			if ((x - cx) ** 2 + (y - cy) ** 2 > radius * radius) continue;
			const i = (y * shot.width + x) * 4;
			const r = shot.data[i];
			const g = shot.data[i + 1];
			const b = shot.data[i + 2];
			const v = Math.max(r, g, b);
			const s = v - Math.min(r, g, b);
			sum += v;
			n++;
			// White-family render pixel: bright and low-saturation.
			if (v >= 165 && s <= 60) {
				brightCount++;
				cxAcc += x;
				cyAcc += y;
			}
		}
	}
	return {
		mean: n ? sum / n : 0,
		brightCount,
		centroidX: brightCount ? cxAcc / brightCount : cx,
		centroidY: brightCount ? cyAcc / brightCount : cy
	};
}

async function attachPatch(
	testInfo: TestInfo,
	shot: PNG,
	name: string,
	cx: number,
	cy: number,
	half: number
): Promise<void> {
	const x0 = Math.max(0, Math.round(cx - half));
	const y0 = Math.max(0, Math.round(cy - half));
	const w = Math.min(shot.width, Math.round(cx + half)) - x0;
	const h = Math.min(shot.height, Math.round(cy + half)) - y0;
	if (w <= 0 || h <= 0) return;
	const patch = new PNG({ width: w, height: h });
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const src = ((y0 + y) * shot.width + (x0 + x)) * 4;
			const dst = (y * w + x) * 4;
			patch.data[dst] = shot.data[src];
			patch.data[dst + 1] = shot.data[src + 1];
			patch.data[dst + 2] = shot.data[src + 2];
			patch.data[dst + 3] = 255;
		}
	}
	await testInfo.attach(name, { body: PNG.sync.write(patch), contentType: 'image/png' });
}

test.describe('The Rec demo data integrity', () => {
	test('in-browser AutoCrop+AutoStitch reproduces the headless harness composite byte-for-byte', async ({
		page
	}) => {
		test.skip(!HAVE_CAPTURES, `Rec captures not present under ${DEMO_DIR}`);
		test.skip(
			!existsSync(EXPECTED_COMPOSITE),
			`harness composite not present at ${EXPECTED_COMPOSITE} (run rec-stitch-harness.ts)`
		);
		test.setTimeout(180000);

		await gotoApp(page, '/stitch-map');
		await importRecCaptures(page);

		const expected = PNG.sync.read(readFileSync(EXPECTED_COMPOSITE));
		const actual = await compositeHashInPage(page);
		expect(actual.width).toBe(expected.width);
		expect(actual.height).toBe(expected.height);
		expect(actual.hash).toBe(rgbaHash(expected.data));
	});

	test('every pipeline endpoint projects through the pane transform onto a rendered feature — pad 2 included', async ({
		page
	}, testInfo) => {
		test.skip(!HAVE_CAPTURES, `Rec captures not present under ${DEMO_DIR}`);
		test.skip(
			!existsSync(ASSIGNMENTS),
			`assignments not present at ${ASSIGNMENTS} (run pair-matrix + replay on TheRec)`
		);
		test.setTimeout(240000);

		await gotoApp(page, '/stitch-map');
		await importRecCaptures(page);

		// The ordinary continue affordance: Yes -> handoff -> Annotate Course.
		// A fresh session is a safe arrival, so the handoff auto-imports.
		await page.getByTestId('alignment-yes').click();
		await page.waitForURL('**/annotate-course');
		const pane = page.getByTestId('pane-scene-source-overview');
		await expect(pane).toBeVisible({ timeout: 60000 });
		// Let the initial fit/render settle before reading the transform.
		await page.waitForFunction(() => {
			const el = document.querySelector<HTMLElement>(
				'[data-testid="pane-scene-source-overview"]'
			);
			return el && Number(el.dataset.viewZoom) > 0;
		});

		const view = await paneView(page);
		const shot = PNG.sync.read(await pane.screenshot());
		// Element screenshots are in CSS pixels only at deviceScaleFactor 1;
		// guard so a preset change can't silently skew every sample below.
		expect(Math.abs(shot.width - (view.width + 2 * view.clientLeft))).toBeLessThanOrEqual(2);

		const holes = (
			JSON.parse(readFileSync(ASSIGNMENTS, 'utf8')) as { holes: AssignmentHole[] }
		).holes;
		expect(holes.length).toBe(9);

		const failures: string[] = [];
		for (const hole of holes) {
			for (const [kind, pt] of [
				['tee', hole.tee],
				['basket', hole.basket]
			] as const) {
				// Geometry-frame -> native composite px -> pane CSS px.
				const nativeX = pt.xPx / GEO_SCALE;
				const nativeY = pt.yPx / GEO_SCALE;
				const sx = nativeX * view.zoom + view.panX + view.clientLeft;
				const sy = nativeY * view.zoom + view.panY + view.clientTop;
				const inPane =
					sx >= 0 && sy >= 0 && sx < view.width + view.clientLeft && sy < view.height + view.clientTop;
				if (!inPane) {
					failures.push(`h${hole.hole} ${kind}: projected (${sx.toFixed(0)},${sy.toFixed(0)}) is outside the pane`);
					continue;
				}
				// A tee pad is ~57x40 native, a basket glyph 42x66: use a disk that
				// covers the feature at the current zoom, floor 5px so at least a
				// few dozen screenshot pixels vote.
				const radius = Math.max(5, 34 * view.zoom);
				const stats = diskStats(shot, sx, sy, radius);
				await attachPatch(testInfo, shot, `h${hole.hole}-${kind}.png`, sx, sy, radius * 3);
				if (stats.brightCount < 4) {
					failures.push(
						`h${hole.hole} ${kind}: no white-family render pixels within ${radius.toFixed(1)}px of projected point (found ${stats.brightCount})`
					);
				}
			}
		}
		expect(failures, failures.join('\n')).toEqual([]);

		// Pad 2 by name: the projected hidden-state coordinate must not merely
		// touch bright pixels — their centroid must be the pad itself.
		const hole2 = holes.find((h) => h.hole === 2);
		if (!hole2) throw new Error('assignments carry no hole 2');
		const sx = (hole2.tee.xPx / GEO_SCALE) * view.zoom + view.panX + view.clientLeft;
		const sy = (hole2.tee.yPx / GEO_SCALE) * view.zoom + view.panY + view.clientTop;
		const radius = Math.max(6, 40 * view.zoom);
		const stats = diskStats(shot, sx, sy, radius);
		expect(stats.brightCount).toBeGreaterThanOrEqual(6);
		const centroidOff = Math.hypot(stats.centroidX - sx, stats.centroidY - sy);
		expect(
			centroidOff,
			`pad 2 bright-pixel centroid sits ${centroidOff.toFixed(1)}px from the projected hidden-state point (radius ${radius.toFixed(1)})`
		).toBeLessThanOrEqual(radius * 0.6);
	});
});
