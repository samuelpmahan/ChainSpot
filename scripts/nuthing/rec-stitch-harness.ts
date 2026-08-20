/**
 * Headless driver for the app's own import pipeline (NuThing demo prep).
 *
 * Runs `runStitchPipeline` — the real AutoCrop + AutoStitch entry point,
 * including the OpenCV pose-graph verification — on screenshot files from
 * disk, then renders the composite with the real compositor
 * (`compositeDraftPixels`). Only the browser-bound adapters are injected:
 * PNG decode (pngjs instead of <img>), raster construction (same grayscale
 * formula as `toAnalysisRaster`; at phone-screenshot sizes both analysis
 * caps resolve to scale=1 so the bytes are identical), and sha256 via
 * node:crypto. All matching, cropping, pose, and paint logic is the app's.
 *
 * Usage: npx tsx scripts/nuthing/rec-stitch-harness.ts <out-dir> <img1> [img2 ...]
 * Writes <out-dir>/composite.png, <out-dir>/draft.json, <out-dir>/report.json
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { PNG } from 'pngjs';
import jpeg from 'jpeg-js';
import { runStitchPipeline } from '../../src/lib/stitch/stitchPipeline';
import { compositeDraftPixels } from '../../src/lib/stitch/renderComposite';
import type { RgbaBuffer } from '../../src/lib/stitch/renderComposite';
import type { AnalysisRaster, RasterRegion } from '../../src/lib/stitch/analysis';
import type { SemanticRaster } from '../../src/lib/stitch/semanticLandmarks';

interface FakeImage {
	readonly naturalWidth: number;
	readonly naturalHeight: number;
	readonly rgba: Uint8Array;
}

const imageByName = new Map<string, FakeImage>();

function loadImage(filePath: string): { file: File; image: FakeImage } {
	const bytes = fs.readFileSync(filePath);
	const name = path.basename(filePath);
	const isJpeg = /\.jpe?g$/i.test(name);
	let image: FakeImage;
	if (isJpeg) {
		const decoded = jpeg.decode(bytes, { useTArray: true, maxMemoryUsageInMB: 2048 });
		image = { naturalWidth: decoded.width, naturalHeight: decoded.height, rgba: decoded.data };
	} else {
		const png = PNG.sync.read(bytes);
		image = { naturalWidth: png.width, naturalHeight: png.height, rgba: new Uint8Array(png.data) };
	}
	const file = new File([bytes], name, { type: isJpeg ? 'image/jpeg' : 'image/png' });
	imageByName.set(name, image);
	return { file, image };
}

function grayOf(rgba: Uint8Array, i: number): number {
	return (rgba[i] * 0.299 + rgba[i + 1] * 0.587 + rgba[i + 2] * 0.114 + 0.5) | 0;
}

// Faithful toAnalysisRaster at scaleFactor=1 (both app caps are 4096 and the
// intake contract keeps phone screenshots below that): integer region copy,
// identical grayscale coefficients and rounding.
function buildRasterFrom(img: FakeImage, region?: RasterRegion): AnalysisRaster {
	const sx = region?.x ?? 0;
	const sy = region?.y ?? 0;
	const w = region?.width ?? img.naturalWidth;
	const h = region?.height ?? img.naturalHeight;
	if (Math.max(w, h) > 4096) throw new Error('rec-stitch-harness: image exceeds 4096 cap; downscale path not implemented');
	const gray = new Uint8Array(w * h);
	for (let y = 0; y < h; y += 1) {
		const rowBase = ((sy + y) * img.naturalWidth + sx) * 4;
		for (let x = 0; x < w; x += 1) {
			gray[y * w + x] = grayOf(img.rgba, rowBase + x * 4);
		}
	}
	return { widthPx: w, heightPx: h, gray, scale: 1 };
}

function asImage(image: HTMLImageElement): FakeImage {
	return image as unknown as FakeImage;
}

async function main(): Promise<void> {
	const [outDir, ...inputs] = process.argv.slice(2);
	if (!outDir || inputs.length === 0) {
		console.error('usage: rec-stitch-harness.ts <out-dir> <img1> [img2 ...]');
		process.exit(1);
	}
	fs.mkdirSync(outDir, { recursive: true });
	const loaded = inputs.map(loadImage);
	let idCounter = 0;

	const result = await runStitchPipeline(loaded.map((l) => l.file), {
		decode: async (file) => {
			const img = imageByName.get(file.name);
			if (!img) throw new Error(`no preloaded image for ${file.name}`);
			return {
				image: img as unknown as HTMLImageElement,
				widthPx: img.naturalWidth,
				heightPx: img.naturalHeight
			};
		},
		buildRaster: (image, region) => buildRasterFrom(asImage(image), region),
		buildCropRaster: (image) => buildRasterFrom(asImage(image)),
		buildSemanticRaster: (image, sourceId): SemanticRaster => {
			const img = asImage(image);
			return {
				sourceId,
				widthPx: img.naturalWidth,
				heightPx: img.naturalHeight,
				rgba: new Uint8ClampedArray(img.rgba)
			};
		},
		hash: async (bytes) => createHash('sha256').update(bytes).digest('hex'),
		createSourceId: () => `rec-${(idCounter += 1)}`
	});

	if (!result.ok) {
		console.error('PIPELINE FAILURE:', result.failure.reason, '-', result.failure.message);
		fs.writeFileSync(`${outDir}/report.json`, JSON.stringify({ ok: false, failure: result.failure }, null, 2));
		process.exit(2);
	}

	const { draft, sources, confidence, warnings, performance: perf, pairDiagnostics } = result.result;
	console.log(`confidence: ${confidence}`);
	for (const w of warnings) console.log(`warning: ${w}`);
	console.log(`output: ${draft.outputWidthPx} x ${draft.outputHeightPx}, policy ${draft.compositingPolicy}, resampling ${draft.resampling}`);
	for (const s of draft.sources) {
		console.log(
			`  ${s.fileName}: crop x=${s.crop.xPx} y=${s.crop.yPx} ${s.crop.widthPx}x${s.crop.heightPx}, ` +
			`transform [${s.transform.coefficients.map((c) => c.toFixed(3)).join(', ')}] (${s.transform.model}), paint ${s.paintOrder}`
		);
	}
	for (const o of draft.overlaps) console.log(`  overlap ${o.a}-${o.b}: ${o.kind} score ${o.score.toFixed(4)}`);

	const pixelsBySource = new Map<string, RgbaBuffer>();
	for (const s of sources) {
		const img = imageByName.get(s.fileName)!;
		pixelsBySource.set(s.sourceId, {
			widthPx: img.naturalWidth,
			heightPx: img.naturalHeight,
			data: new Uint8ClampedArray(img.rgba)
		});
	}
	const composite = compositeDraftPixels(draft, pixelsBySource);
	const png = new PNG({ width: composite.widthPx, height: composite.heightPx });
	png.data = Buffer.from(composite.data.buffer, composite.data.byteOffset, composite.data.byteLength);
	fs.writeFileSync(`${outDir}/composite.png`, PNG.sync.write(png));

	fs.writeFileSync(`${outDir}/draft.json`, JSON.stringify(draft, null, 2));
	fs.writeFileSync(
		`${outDir}/report.json`,
		JSON.stringify({ ok: true, confidence, warnings, performance: perf, pairDiagnostics: pairDiagnostics ?? null }, null, 2)
	);
	console.log(`wrote ${outDir}/composite.png (${composite.widthPx}x${composite.heightPx})`);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
