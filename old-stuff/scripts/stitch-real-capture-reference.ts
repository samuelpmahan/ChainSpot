/**
 * Ad-hoc investigation tool (not a gate, not part of any test budget).
 *
 * Runs one of two real four-screenshot capture sets of "Dash's Track" (see
 * `src/lib/demo/catalog.ts`'s tour copy) through the actual `smartImportFiles`
 * pipeline — the same production code the app calls, not a reimplementation —
 * and then through the actual `renderStitchedPng` renderer to produce a
 * genuine pixel composite: a second real stitched reference image, at a
 * different device resolution/scale than `resources/ribbon-reference/IMG_5641.jpg`.
 *
 * Two datasets, selected by the first CLI arg (default `dashs-track-demo`):
 *
 * - `dashs-track-demo` (recommended): `static/resources/demo/dashs-track/
 *   udisc-capture-{1..4}.png`, the app's own demo tiles. Confirmed clean of
 *   any walk-path overlay on every hole, including 1-2.
 * - `real-capture`: `resources/real-capture/{TL,TR,BL,BR}.PNG`. A DIFFERENT
 *   real capture set of the same course (different checksums, different
 *   capture session) that was apparently taken mid-round: it has UDisc's
 *   purple walk-path overlay baked into the raw screenshots themselves,
 *   obstructing holes 1-2, in every one of its four tiles — re-stitching
 *   cannot remove it, since it predates stitching. Kept here only for
 *   completeness/comparison; prefer `dashs-track-demo` for anything that
 *   needs a clean reference. (`resources/real-capture/ReferenceStitch.png`,
 *   the pre-existing checked-in composite of this same dataset, has the
 *   identical obstruction for the identical reason.)
 *
 * `smartImportFiles` takes browser `File`s and calls back into injectable
 * `decode`/`buildRaster`/`buildCropRaster` hooks (the same injection points
 * `tests/unit/smartImport.test.ts` uses); this script decodes the real PNGs
 * with `pngjs` up front and feeds pre-built rasters through those hooks,
 * exactly mirroring `scripts/stitch-annotate-check.ts`'s pattern, so this
 * exercises the real crop/matcher/assignment/diagnostic code path end to end
 * without a browser. One deliberate improvement over that script's pattern:
 * this script's `decode` hook returns the correct per-file image (keyed by
 * the real `File.name` the pipeline hands it), so `buildCropRaster`/
 * `buildRaster` can key off the `image` argument they are actually given
 * instead of relying on call-order counters.
 *
 * `smartImportFiles` only produces layout/classification metadata (crop
 * insets, tile placements) — not pixels. For the actual composite, this
 * script also calls the real `renderStitchedPng` (`src/lib/stitch/render.ts`)
 * through a Node-compatible `StitchRenderEnv`: `StitchRenderEnv` is an
 * injectable abstraction over exactly two canvas operations
 * (`createCanvas`/`toBlob`), so a Node env only needs to implement a
 * `drawImage`-capable fake canvas backed by a plain RGBA buffer and encode
 * that buffer to PNG with `pngjs` — no native canvas package, no browser.
 *
 * Usage:
 *   npx tsx scripts/stitch-real-capture-reference.ts [dataset] [outputPath]
 *   npx tsx scripts/stitch-real-capture-reference.ts dashs-track-demo
 *   npx tsx scripts/stitch-real-capture-reference.ts real-capture
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { smartImportFiles } from '../src/lib/stitch/smartImport';
import type { AnalysisRaster, RasterRegion } from '../src/lib/stitch/analysis';
import { DEFAULT_CROP_ANALYSIS_MAX_DIM, DEFAULT_MAX_ANALYSIS_DIM } from '../src/lib/stitch/analysis';
import { renderStitchedPng } from '../src/lib/stitch/render';
import type { StitchRenderEnv, StitchRenderTile } from '../src/lib/stitch/render';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

interface CaptureDataset {
	readonly captureDir: string;
	// Deliberately not upper-left/top/left-first, matching stitch-annotate-check.ts's
	// intent of not handing the pipeline an already-sorted arrangement.
	readonly fileNames: readonly string[];
	readonly outputPath: string;
	/**
	 * Extra bottom-crop depth (source px), on top of `smartImportFiles`'s own
	 * proposal, needed to fully remove UDisc's translucent "Apple Maps/Legal +
	 * MAP/SAT" chrome band — see the long comment at its use site below for
	 * why this can't just be `autoCrop.ts`'s job. Both datasets share this
	 * capture device/UI layout (confirmed empirically: the same +136 clears
	 * the same band on both; removing it leaves the identical chrome visible
	 * on both), but a THIRD dataset should re-verify rather than assume it.
	 */
	readonly extraBottomCropPx: number;
}

const DATASETS: Readonly<Record<string, CaptureDataset>> = {
	'dashs-track-demo': {
		captureDir: join(root, 'static', 'resources', 'demo', 'dashs-track'),
		fileNames: ['udisc-capture-3.png', 'udisc-capture-1.png', 'udisc-capture-4.png', 'udisc-capture-2.png'],
		outputPath: join(root, 'artifacts', 'cv-runs', 'dashs-track-demo-fresh-stitch.png'),
		extraBottomCropPx: 136
	},
	'real-capture': {
		captureDir: join(root, 'resources', 'real-capture'),
		fileNames: ['TR.PNG', 'BL.PNG', 'TL.PNG', 'BR.PNG'],
		outputPath: join(root, 'artifacts', 'cv-runs', 'real-capture-fresh-stitch.png'),
		extraBottomCropPx: 136
	}
};

interface RgbaImage {
	readonly name: string;
	readonly widthPx: number;
	readonly heightPx: number;
	readonly gray: Uint8Array;
	/** Full-resolution RGBA straight from pngjs; consumed only by this script's own Node canvas env. */
	readonly rgba: Uint8Array;
}

function loadRgba(path: string, name: string): RgbaImage {
	const png = PNG.sync.read(readFileSync(path));
	const { width, height, data } = png;
	const gray = new Uint8Array(width * height);
	for (let i = 0; i < width * height; i += 1) {
		const o = i * 4;
		gray[i] = Math.round(0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2]);
	}
	return { name, widthPx: width, heightPx: height, gray, rgba: data };
}

/** Mirrors `toAnalysisRaster`'s crop-then-downscale, without a canvas (grayscale only, for matching). */
function buildGrayRaster(source: RgbaImage, maxDim: number, region?: RasterRegion): AnalysisRaster {
	const sourceX = region?.x ?? 0;
	const sourceY = region?.y ?? 0;
	const sourceWidth = region?.width ?? source.widthPx;
	const sourceHeight = region?.height ?? source.heightPx;
	const scaleFactor = Math.min(1, maxDim / Math.max(sourceWidth, sourceHeight));
	const widthPx = Math.max(1, Math.round(sourceWidth * scaleFactor));
	const heightPx = Math.max(1, Math.round(sourceHeight * scaleFactor));
	const gray = new Uint8Array(widthPx * heightPx);
	for (let y = 0; y < heightPx; y += 1) {
		const sy = Math.min(sourceHeight - 1, Math.floor(y / scaleFactor));
		const srcRow = (sourceY + sy) * source.widthPx;
		for (let x = 0; x < widthPx; x += 1) {
			const sx = Math.min(sourceWidth - 1, Math.floor(x / scaleFactor));
			gray[y * widthPx + x] = source.gray[srcRow + sourceX + sx];
		}
	}
	return { widthPx, heightPx, gray, scale: sourceWidth / widthPx };
}

// --- Node-compatible StitchRenderEnv --------------------------------------
//
// `StitchRenderEnv` is exactly two operations (`createCanvas`, `toBlob`); the
// fake canvas below implements only what `renderStitchedPng` actually calls
// on it: `getContext('2d')` returning an object with a `drawImage` matching
// the 9-argument (sx,sy,sWidth,sHeight,dx,dy,dWidth,dHeight) form, plus
// mutable `width`/`height`. Source images carry their own RGBA buffer
// (`RgbaImage`, set up above) instead of being real `HTMLImageElement`s.
// Every draw in this pipeline has `dWidth === sWidth` and `dHeight ===
// sHeight` (see render.ts: "identical source and destination crop sizes: no
// resampling"), so a direct pixel copy (not resampling) is correct; alpha is
// copied too but every source pixel here is fully opaque, so this is
// equivalent to the canvas default `source-over` compositing.

interface NodeCanvas {
	width: number;
	height: number;
	buffer: Uint8ClampedArray | null;
	getContext(type: string): { drawImage(...args: unknown[]): void } | null;
}

function makeNodeCanvas(): NodeCanvas {
	const canvas: NodeCanvas = {
		width: 0,
		height: 0,
		buffer: null,
		getContext(type: string) {
			if (type !== '2d') return null;
			return {
				drawImage(...args: unknown[]): void {
					const [image, sx, sy, sWidth, sHeight, dx, dy, dWidth, dHeight] = args as [
						RgbaImage,
						number,
						number,
						number,
						number,
						number,
						number,
						number,
						number
					];
					if (!canvas.buffer || canvas.buffer.length !== canvas.width * canvas.height * 4) {
						canvas.buffer = new Uint8ClampedArray(canvas.width * canvas.height * 4);
					}
					const buf = canvas.buffer;
					for (let row = 0; row < dHeight; row += 1) {
						const srcY = sy + row;
						const dstY = dy + row;
						if (srcY < 0 || srcY >= image.heightPx || dstY < 0 || dstY >= canvas.height) continue;
						const srcRowOffset = srcY * image.widthPx;
						const dstRowOffset = dstY * canvas.width;
						for (let col = 0; col < dWidth; col += 1) {
							const srcX = sx + col;
							const dstX = dx + col;
							if (srcX < 0 || srcX >= image.widthPx || dstX < 0 || dstX >= canvas.width) continue;
							const srcIdx = (srcRowOffset + srcX) * 4;
							const dstIdx = (dstRowOffset + dstX) * 4;
							buf[dstIdx] = image.rgba[srcIdx];
							buf[dstIdx + 1] = image.rgba[srcIdx + 1];
							buf[dstIdx + 2] = image.rgba[srcIdx + 2];
							buf[dstIdx + 3] = image.rgba[srcIdx + 3];
						}
					}
				}
			};
		}
	};
	return canvas;
}

function makeNodeStitchRenderEnv(): StitchRenderEnv {
	return {
		createCanvas() {
			return makeNodeCanvas() as unknown as HTMLCanvasElement;
		},
		async toBlob(canvasArg, type) {
			if (type !== 'image/png') return null;
			const canvas = canvasArg as unknown as NodeCanvas;
			const png = new PNG({ width: canvas.width, height: canvas.height });
			png.data.set(canvas.buffer ?? new Uint8ClampedArray(canvas.width * canvas.height * 4));
			// Node's Buffer type (ArrayBufferLike) isn't assignable to DOM's
			// BlobPart (ArrayBuffer-backed) typing; a fresh Uint8Array is.
			return new Blob([Uint8Array.from(PNG.sync.write(png))], { type: 'image/png' });
		}
	};
}

async function main(): Promise<void> {
	const datasetName = process.argv[2] && process.argv[2] in DATASETS ? process.argv[2] : 'dashs-track-demo';
	const dataset = DATASETS[datasetName];
	const outputPath = process.argv[3] ? join(process.cwd(), process.argv[3]) : dataset.outputPath;
	const { captureDir, fileNames: FILE_NAMES } = dataset;

	console.log(`Dataset: ${datasetName}`);
	console.log(`Loading ${FILE_NAMES.length} real captures from ${captureDir} ...`);
	const fullRes = new Map(
		FILE_NAMES.map((name) => [name, loadRgba(join(captureDir, name), name)] as const)
	);
	for (const name of FILE_NAMES) {
		const image = fullRes.get(name)!;
		console.log(`  ${name}: ${image.widthPx} x ${image.heightPx}`);
	}

	const files = FILE_NAMES.map((name) => new File([new Uint8Array(8).fill(1)], name, { type: 'image/png' }));

	console.log('Running smartImportFiles (real production pipeline: crop evidence, matcher-region');
	console.log('trimming, assignN, classifyLayout) ...');
	const started = Date.now();
	const result = await smartImportFiles(files, {
		decode: async (file) => {
			const image = fullRes.get(file.name);
			if (!image) throw new Error(`no fixture loaded for ${file.name}`);
			return { image: image as unknown as HTMLImageElement, widthPx: image.widthPx, heightPx: image.heightPx };
		},
		buildCropRaster: (image) => buildGrayRaster(image as unknown as RgbaImage, DEFAULT_CROP_ANALYSIS_MAX_DIM),
		buildRaster: (image, region) => buildGrayRaster(image as unknown as RgbaImage, DEFAULT_MAX_ANALYSIS_DIM, region)
	});
	const elapsedMs = Date.now() - started;

	if (!result.ok) {
		console.error(`smartImportFiles FAILED (${elapsedMs}ms):`, result);
		process.exitCode = 1;
		return;
	}

	console.log(`smartImportFiles OK (${elapsedMs}ms), ${result.order.length} tiles, anchor=${result.order[0]}`);
	console.log(`  crop: confidence=${result.crop.confidence} insets=${JSON.stringify(result.cropProposal)}`);
	console.log('  assignment (slot -> input file):');
	for (const [slot, fileIndex] of Object.entries(result.assignment)) {
		console.log(`    ${slot}: ${FILE_NAMES[fileIndex as number]}`);
	}
	console.log('  placements:');
	for (const [slot, placement] of Object.entries(result.placements)) {
		if (!placement) continue;
		console.log(`    ${slot}: (${placement.xPx}, ${placement.yPx})`);
	}
	console.log('  neighbors:');
	for (const [slot, adjacent] of Object.entries(result.neighbors)) {
		console.log(`    ${slot}: ${adjacent.join(', ')}`);
	}
	console.log(
		`  diagnostic: ${result.diagnostic.category}${
			result.diagnostic.warnings.length > 0 ? `\n    - ${result.diagnostic.warnings.join('\n    - ')}` : ''
		}`
	);

	if (!result.cropProposal) {
		console.error('No crop proposal was produced; cannot render (renderStitchedPng requires a crop).');
		process.exitCode = 1;
		return;
	}

	// --- One-off crop touch-up (NOT a change to src/lib/stitch/*) -----------
	//
	// Investigation finding: the auto-proposed crop's `bottomPx` (254) removes
	// only the solid black bottom nav bar (the "ALL / <- / ->" hole-carousel
	// bar). `autoCrop.ts` picks this boundary via its per-image row-entropy
	// detector (`analyzeVerticalEntropy`, the code path this real capture's
	// dimensions actually take — tall/narrow, native-resolution raster): it
	// looks for a sustained *drop* in per-row pixel-value entropy near the
	// edge, which finds the low-detail solid-black bar cleanly. Just above
	// that bar, every capture also carries UDisc's persistent on-screen
	// chrome — the "Apple Maps / Legal" wordmark (bottom-left) and the
	// "MAP/SAT" toggle (bottom-right) — translucently composited over live,
	// per-capture map imagery (trees/pavement here), which stays visually
	// "busy"/high-entropy even under the overlay, so the entropy detector
	// correctly does not mistake it for the same kind of uniform chrome band.
	// That is a real, inherent blind spot of an entropy-based detector (it
	// finds low-detail bars, not translucent overlays on high-detail
	// content) — not obviously fixable by retuning the existing
	// hand-calibrated thresholds (`ENTROPY_THRESHOLD_RATIO` etc., tuned
	// against a labeled real-capture sweep per that file's comments) without
	// risking regressing that calibration, so this script does not touch
	// `autoCrop.ts`.
	//
	// This leftover chrome is not unique to this script's raw run, either:
	// the already-shipped `resources/real-capture/ReferenceStitch.png` has
	// the identical artifact (a duplicated Apple-logo/MAP-SAT pair at the
	// bottom, plus a lone "SAT" fragment floating mid-right with no other
	// chrome around it) at the identical position — confirming this is a
	// pre-existing characteristic of the real pipeline's automatic output on
	// this capture, not something introduced here. Root cause of *both*
	// symptoms turns out to be the same fixed-position row band: BL and BR
	// (the two tiles reaching the union's bottom edge) drift independently,
	// so BR does not extend quite as far down as BL, leaving BL's own copy
	// of the band exposed next to BR's own (nothing paints over the
	// last-drawn tile) copy; and TR reaches further right than BR does, so
	// the same band's toggle half survives at TR's own right edge too,
	// uncovered for the same reason. Since the exposure is really about this
	// one row band surviving at all (not about draw order — draw order can
	// only ever composite whichever pixels each tile actually has), deepening
	// the *shared* bottom crop enough to remove the band from every tile's
	// own frame outright removes both symptoms at once, with no dependence on
	// which tile ends up drawn last. Pixel-scanning all four captures found
	// the band starts at original-image row ~2413-2419 (`BL.PNG`/`BR.PNG`;
	// verified visually to contain no course content there, only
	// trees/pavement/a parking-lot corner) — comfortably inside the
	// crop-safety-margin spirit `smartImportFiles` already applies elsewhere,
	// so this costs no real content for this capture (confirmed: holes 16-17,
	// near the same right edge, stay fully intact since only the bottom inset
	// changes). See the task report for the full writeup; this is a
	// deliberate, content-safe crop choice for a clean reference image, not a
	// `src/lib/stitch/*` change.
	const crop = { ...result.cropProposal, bottomPx: result.cropProposal.bottomPx + dataset.extraBottomCropPx };
	console.log(
		`  clean-export crop override: bottomPx ${result.cropProposal.bottomPx} -> ${crop.bottomPx} (+${dataset.extraBottomCropPx}, see comment)`
	);

	console.log('Rendering the actual composite via renderStitchedPng (Node StitchRenderEnv) ...');
	const tiles: StitchRenderTile[] = result.order.map((slot) => {
		const fileIndex = result.assignment[slot];
		if (fileIndex === undefined) throw new Error(`no assignment for slot ${slot}`);
		const source = fullRes.get(FILE_NAMES[fileIndex])!;
		const placement = result.placements[slot];
		if (!placement) throw new Error(`no placement for slot ${slot}`);
		return {
			slot,
			image: source as unknown as HTMLImageElement,
			widthPx: source.widthPx,
			heightPx: source.heightPx,
			placement
		};
	});

	const blob = await renderStitchedPng(tiles, crop, makeNodeStitchRenderEnv());
	const buffer = Buffer.from(await blob.arrayBuffer());

	mkdirSync(dirname(outputPath), { recursive: true });
	writeFileSync(outputPath, buffer);

	const written = PNG.sync.read(buffer);
	console.log(`Wrote ${outputPath}`);
	console.log(`  dimensions: ${written.width} x ${written.height}`);
	console.log(`  bytes: ${buffer.length}`);
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
