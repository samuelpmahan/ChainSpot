/**
 * Phase-1 parity check for `src/lib/autoAnnotation/middleOutRibbon.ts`
 * against the same dev corpus that produced `middleout.py`'s numbers.
 *
 * Simplification vs the Python probe: routes tee<->basket directly (one
 * `routeLeg` call) instead of badge-splitting through a detected physical
 * badge, since this script's job is validating the ported paired-edge
 * substrate + router, not the full P1-P6 pipeline (which will supply real
 * badge positions once wired into the worker in Phase 2). For most holes
 * the badge sits close enough to the tee-basket chord that this does not
 * change which ribbon gets recovered.
 *
 * Usage: npx tsx scripts/cv-probes/middleout/validate-ts-port.ts <path-to-Annotated-dir>
 */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import { getCv } from '../../../src/lib/cv/runtime';
import { proposeSingleImageCrop } from '../../../src/lib/stitch/autoCrop';
import type { AnalysisRaster } from '../../../src/lib/stitch/analysis';
import {
	buildSupportCost,
	capIconFalsePositives,
	computePairedEdgeSupportField,
	routeLeg,
	type MiddleOutCv,
	type Point
} from '../../../src/lib/autoAnnotation/middleOutRibbon';

const [, , inputDirArg] = process.argv;
if (!inputDirArg) {
	console.error('Usage: npx tsx scripts/cv-probes/middleout/validate-ts-port.ts <path-to-Annotated-dir>');
	process.exit(1);
}
const inputDir = inputDirArg;
const COURSES = ['DashsTrack', 'Heritage', 'Lenard', 'TowneLake'];

interface AnnotationHole {
	readonly number: number;
	readonly tee: { readonly xPx: number; readonly yPx: number };
	readonly basket: { readonly xPx: number; readonly yPx: number };
	readonly corridorBends: readonly { readonly xPx: number; readonly yPx: number }[];
	readonly corridorWidthPx: number;
}

interface Annotation {
	readonly sourceImage: { readonly widthPx: number; readonly heightPx: number };
	readonly holes: readonly AnnotationHole[];
}

async function decodeImage(buf: Buffer, fileName: string): Promise<{ widthPx: number; heightPx: number; rgba: Uint8ClampedArray }> {
	if (fileName.toLowerCase().endsWith('.png')) {
		const png = PNG.sync.read(buf);
		return { widthPx: png.width, heightPx: png.height, rgba: new Uint8ClampedArray(png.data.buffer, png.data.byteOffset, png.data.byteLength) };
	}
	const decoded = jpeg.decode(buf, { useTArray: true, maxMemoryUsageInMB: 4096 });
	return { widthPx: decoded.width, heightPx: decoded.height, rgba: new Uint8ClampedArray(decoded.data.buffer, decoded.data.byteOffset, decoded.data.byteLength) };
}

function toGrayAnalysisRaster(source: { widthPx: number; heightPx: number; rgba: Uint8ClampedArray }): AnalysisRaster {
	const gray = new Uint8Array(source.widthPx * source.heightPx);
	for (let i = 0, j = 0; j < gray.length; i += 4, j += 1) {
		gray[j] = (source.rgba[i] * 0.299 + source.rgba[i + 1] * 0.587 + source.rgba[i + 2] * 0.114 + 0.5) | 0;
	}
	return { widthPx: source.widthPx, heightPx: source.heightPx, gray, scale: 1 };
}

/**
 * Real ChainSpot single-image autocrop (top/bottom phone-chrome band,
 * `src/lib/stitch/autoCrop.ts`'s `proposeSingleImageCrop`) rather than a
 * naive height-difference guess -- some of this corpus's raw captures crop
 * from BOTH top and bottom (status bar + home-indicator), so `raw_height -
 * annotation_height` alone silently picks the wrong window.
 */
function autoCropToAnnotationSize(
	source: { widthPx: number; heightPx: number; rgba: Uint8ClampedArray },
	targetHeight: number,
	course: string
): { widthPx: number; heightPx: number; rgba: Uint8ClampedArray } {
	if (source.heightPx === targetHeight) return source;
	const proposal = proposeSingleImageCrop(toGrayAnalysisRaster(source));
	if (!proposal.insets) throw new Error(`${course}: autocrop proposed no crop, but raw (${source.heightPx}px) != annotation (${targetHeight}px).`);
	const top = proposal.insets.topPx;
	const bottom = proposal.insets.bottomPx;
	const croppedHeight = source.heightPx - top - bottom;
	if (croppedHeight !== targetHeight) {
		console.warn(`${course}: autocrop gave ${croppedHeight}px (top=${top} bottom=${bottom}), annotation expects ${targetHeight}px -- using annotation height, top-aligned to the proposed crop.`);
	}
	const rowBytes = source.widthPx * 4;
	const rgba = new Uint8ClampedArray(source.rgba.buffer, source.rgba.byteOffset + top * rowBytes, targetHeight * rowBytes);
	return { widthPx: source.widthPx, heightPx: targetHeight, rgba };
}

function pointSegmentDistance(p: Point, a: Point, b: Point): number {
	const vx = b.xPx - a.xPx;
	const vy = b.yPx - a.yPx;
	const vv = vx * vx + vy * vy;
	if (vv < 1e-9) return Math.hypot(p.xPx - a.xPx, p.yPx - a.yPx);
	const t = Math.max(0, Math.min(1, ((p.xPx - a.xPx) * vx + (p.yPx - a.yPx) * vy) / vv));
	const qx = a.xPx + t * vx;
	const qy = a.yPx + t * vy;
	return Math.hypot(p.xPx - qx, p.yPx - qy);
}

function holePolyline(hole: AnnotationHole): Point[] {
	return [hole.tee, ...hole.corridorBends, hole.basket];
}

function distanceToPolyline(p: Point, polyline: readonly Point[]): number {
	let best = Infinity;
	for (let i = 0; i < polyline.length - 1; i += 1) {
		best = Math.min(best, pointSegmentDistance(p, polyline[i], polyline[i + 1]));
	}
	return best;
}

function percentile(sortedAscending: number[], p: number): number {
	if (sortedAscending.length === 0) return NaN;
	const rank = (p / 100) * (sortedAscending.length - 1);
	const lo = Math.floor(rank);
	const hi = Math.ceil(rank);
	if (lo === hi) return sortedAscending[lo];
	const frac = rank - lo;
	return sortedAscending[lo] * (1 - frac) + sortedAscending[hi] * frac;
}

async function runCourse(cv: MiddleOutCv, course: string): Promise<void> {
	const dir = join(inputDir, course);
	const entries = await readdir(dir);
	const imageName = entries.find((e) => /\.(jpe?g|png)$/i.test(e) && !e.startsWith('.'));
	const annotationName = entries.find((e) => e.endsWith('.annotation.json'));
	if (!imageName || !annotationName) throw new Error(`${course}: missing image or annotation.json in ${dir}`);

	const annotation: Annotation = JSON.parse(await readFile(join(dir, annotationName), 'utf8'));
	const rawBuf = await readFile(join(dir, imageName));
	const rawImage = await decodeImage(rawBuf, imageName);
	const raster = autoCropToAnnotationSize(rawImage, annotation.sourceImage.heightPx, course);
	if (raster.widthPx !== annotation.sourceImage.widthPx) {
		throw new Error(`${course}: width mismatch raw=${raster.widthPx} annotation=${annotation.sourceImage.widthPx}`);
	}

	const field = computePairedEdgeSupportField(cv, {
		data: raster.rgba,
		widthPx: raster.widthPx,
		heightPx: raster.heightPx,
		originXPx: 0,
		originYPx: 0,
		scale: 1,
		channels: 4
	});
	const holes = [...annotation.holes].sort((a, b) => a.number - b.number);
	capIconFalsePositives(field, holes.map((h) => h.basket));
	const cost = buildSupportCost(field.support);

	const allErrors: number[] = [];
	const pathStarted = performance.now();
	let pathCount = 0;

	const verbose = process.env.MIDDLEOUT_VERBOSE === '1';
	for (const hole of holes) {
		const path = routeLeg(cost, field.widthPx, field.heightPx, field.scale, hole.tee, hole.basket);
		if (!path) {
			console.warn(`${course} hole ${hole.number}: no path found`);
			continue;
		}
		pathCount += 1;
		const truth = holePolyline(hole);
		const holeErrors = path.map((point) => distanceToPolyline(point, truth));
		if (verbose) {
			holeErrors.sort((a, b) => a - b);
			console.log(`  hole ${String(hole.number).padStart(2)}: median=${percentile(holeErrors, 50).toFixed(1)}px  p90=${percentile(holeErrors, 90).toFixed(1)}px  max=${holeErrors[holeErrors.length - 1].toFixed(1)}px`);
		}
		allErrors.push(...holeErrors);
	}
	const pathMs = performance.now() - pathStarted;

	allErrors.sort((a, b) => a - b);
	const halfWidth = median(holes.map((h) => h.corridorWidthPx)) / 2;
	const withinHalfWidth = allErrors.filter((e) => e <= halfWidth).length / allErrors.length;

	console.log(
		`${course.padEnd(10)} holes=${pathCount}/${holes.length}  median=${percentile(allErrors, 50).toFixed(1)}px` +
			`  p90=${percentile(allErrors, 90).toFixed(1)}px  within-half-width=${(100 * withinHalfWidth).toFixed(1)}%` +
			`  supportMs=${field.elapsedMs.toFixed(0)}  pathsMs=${pathMs.toFixed(0)}`
	);
}

function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

async function main(): Promise<void> {
	const cv = (await getCv()) as unknown as MiddleOutCv;
	for (const course of COURSES) {
		await runCourse(cv, course);
	}
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
