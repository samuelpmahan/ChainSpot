/**
 * Ad-hoc investigation tool (not a gate, not part of any test budget).
 *
 * Runs the real `resources/stitch-annotate/` course captures through the
 * actual `smartImportFiles` pipeline (crop evidence, matcher-region trimming,
 * `assignFour`/`assignTwo` dispatch, and `classifyLayout`) — the same
 * production code the app calls, not a reimplementation — to sanity-check the
 * new 1x2/2x1 (left/right, top/bottom) two-tile support added alongside the
 * original 2x2 grid, and to confirm the original 2x2 path still works on a
 * real four-screenshot capture (BillAllen).
 *
 * `smartImportFiles` takes browser `File`s and calls back into injectable
 * `decode`/`buildRaster`/`buildCropRaster` hooks (the same injection points
 * `tests/unit/smartImport.test.ts` uses); this script decodes the real PNGs
 * with `pngjs` up front and feeds pre-built rasters through those hooks in
 * file order, exactly mirroring that test's pattern, so this exercises the
 * real crop/matcher/assignment/diagnostic code path end to end without a
 * browser.
 *
 * Usage:
 *   npx tsx scripts/stitch-annotate-check.ts
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { smartImportFiles } from '../src/lib/stitch/smartImport';
import type { AnalysisRaster, RasterRegion } from '../src/lib/stitch/analysis';
import { DEFAULT_CROP_ANALYSIS_MAX_DIM, DEFAULT_MAX_ANALYSIS_DIM } from '../src/lib/stitch/analysis';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const baseDir = join(root, 'resources', 'stitch-annotate');

interface GrayImage {
	readonly widthPx: number;
	readonly heightPx: number;
	readonly gray: Uint8Array;
}

function loadGray(path: string): GrayImage {
	const png = PNG.sync.read(readFileSync(path));
	const { width, height, data } = png;
	const gray = new Uint8Array(width * height);
	for (let i = 0; i < width * height; i += 1) {
		const o = i * 4;
		gray[i] = Math.round(0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2]);
	}
	return { widthPx: width, heightPx: height, gray };
}

/** Mirrors `toAnalysisRaster`'s crop-then-downscale, without a canvas. */
function buildRaster(source: GrayImage, maxDim: number, region?: RasterRegion): AnalysisRaster {
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

interface CourseSet {
	readonly name: string;
	readonly files: readonly string[]; // absolute paths, deliberately not in "true" slot order
}

function discoverCourses(): CourseSet[] {
	const courses: CourseSet[] = [];
	for (const entry of readdirSync(baseDir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const dir = join(baseDir, entry.name);
		const files = readdirSync(dir)
			.filter((name) => name.toLowerCase().endsWith('.png'))
			.sort()
			.reverse() // deliberately not upper-left/top/left first
			.map((name) => join(dir, name));
		if (files.length > 0) courses.push({ name: entry.name, files });
	}
	return courses;
}

async function checkCourse(course: CourseSet): Promise<void> {
	console.log(`\n=== ${course.name} (${course.files.length} tiles) ===`);
	for (const path of course.files) console.log(`  input: ${path.split('/').pop()}`);

	const fullRes = course.files.map((path) => loadGray(path));
	const cropRasters = fullRes.map((image) => buildRaster(image, DEFAULT_CROP_ANALYSIS_MAX_DIM));
	let cropIndex = 0;
	let matcherIndex = 0;

	const files = course.files.map((path) => {
		const name = path.split('/').pop() as string;
		return new File([new Uint8Array(8).fill(1)], name, { type: 'image/png' });
	});

	const started = Date.now();
	const result = await smartImportFiles(files, {
		decode: async () => {
			const image = fullRes[cropIndex] ?? fullRes[0];
			return { image: image as unknown as HTMLImageElement, widthPx: image.widthPx, heightPx: image.heightPx };
		},
		buildCropRaster: () => cropRasters[cropIndex++ % cropRasters.length],
		buildRaster: (_image, region) => buildRaster(fullRes[matcherIndex++ % fullRes.length], DEFAULT_MAX_ANALYSIS_DIM, region)
	});
	const elapsedMs = Date.now() - started;

	if (!result.ok) {
		console.log(`  FAILED: ${JSON.stringify(result)}`);
		return;
	}

	console.log(`  layout: ${result.layoutKind}  (${elapsedMs}ms)`);
	console.log(
		`  crop: confidence=${result.crop.confidence} insets=${JSON.stringify(result.cropProposal)}`
	);
	console.log('  assignment (slot -> input file):');
	for (const [slot, fileIndex] of Object.entries(result.assignment)) {
		console.log(`    ${slot}: ${course.files[fileIndex as number].split('/').pop()}`);
	}
	console.log('  placements:');
	for (const [slot, placement] of Object.entries(result.placements)) {
		console.log(`    ${slot}: (${placement.xPx}, ${placement.yPx})`);
	}
	console.log(
		`  diagnostic: ${result.diagnostic.category}${
			result.diagnostic.warnings.length > 0 ? `\n    - ${result.diagnostic.warnings.join('\n    - ')}` : ''
		}`
	);
}

async function main(): Promise<void> {
	if (!existsSync(baseDir)) {
		console.error(`Not found: ${baseDir}`);
		process.exitCode = 1;
		return;
	}
	const courses = discoverCourses();
	for (const course of courses) {
		await checkCourse(course);
	}
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
