/**
 * Throwaway prototype #2: instead of thresholding pixel brightness/color,
 * borrow the tee-pad detector's proven technique -- Canny edges + Hough line
 * segments, paired up as two roughly-parallel "rails" a fixed distance apart
 * -- but tuned for the corridor band's actual (much larger) width instead of
 * a tee pad's ~7px rail spacing. Hough accumulates votes along a line, so it
 * should reject uncorrelated per-pixel noise far better than a brightness
 * threshold did. Not wired into production; not unit tested.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import jpeg from 'jpeg-js';
import { strFromU8, unzipSync } from 'fflate';
import { PNG } from 'pngjs';
import { loadCv } from '../src/lib/stitch/cvMatch';
import { detectHoleNumberBadges } from '../src/lib/autoAnnotation/holeNumberDetection';
import type { HoleNumberCvModule, HoleNumberTemplate } from '../src/lib/autoAnnotation/holeNumberDetection';
import { buildOcclusionMask, detectPuttingCircleRadii } from '../src/lib/autoAnnotation/centerlineDetection';
import type { CenterlineRaster } from '../src/lib/autoAnnotation/centerlineDetection';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const templateDir = join(projectRoot, 'static', 'resources', 'chainspot_cv_templates');
const outDir = '/tmp/claude-0/-home-user-ChainSpot/ac93230d-47cf-5c69-9b31-e29eac6e7ade/scratchpad/fragments';

interface DecodedRaster {
	readonly rgba: Uint8Array;
	readonly widthPx: number;
	readonly heightPx: number;
}

function decodeJpeg(bytes: Uint8Array): DecodedRaster {
	const decoded = jpeg.decode(Buffer.from(bytes), { useTArray: true });
	return { rgba: new Uint8Array(decoded.data), widthPx: decoded.width, heightPx: decoded.height };
}
function decodePng(bytes: Uint8Array): DecodedRaster {
	const decoded = PNG.sync.read(Buffer.from(bytes));
	return { rgba: new Uint8Array(decoded.data), widthPx: decoded.width, heightPx: decoded.height };
}

function loadBundle(path: string) {
	const bytes = new Uint8Array(readFileSync(resolve(path)));
	const entries = unzipSync(bytes);
	const document = JSON.parse(strFromU8(entries['project.json'])) as {
		holes?: readonly Readonly<{ number?: unknown; tee?: Readonly<{ xPx?: unknown; yPx?: unknown }>; basket?: Readonly<{ xPx?: unknown; yPx?: unknown }> }>[];
	};
	const truth = (document.holes ?? []).map((hole) => ({
		number: hole.number as number,
		tee: typeof hole.tee?.xPx === 'number' && typeof hole.tee?.yPx === 'number' ? { xPx: hole.tee.xPx, yPx: hole.tee.yPx } : undefined,
		basket: typeof hole.basket?.xPx === 'number' && typeof hole.basket?.yPx === 'number' ? { xPx: hole.basket.xPx, yPx: hole.basket.yPx } : undefined
	}));
	return { raster: decodeJpeg(entries['images/source-original.jpg']), truth };
}

function loadNumberTemplatesReal(): readonly HoleNumberTemplate[] {
	return Array.from({ length: 18 }, (_, index) => {
		const label = index + 1;
		const path = join(templateDir, `hole-${String(label).padStart(2, '0')}.png`);
		const decoded = decodePng(new Uint8Array(readFileSync(path)));
		return { label, raster: { format: 'rgba' as const, widthPx: decoded.widthPx, heightPx: decoded.heightPx, data: decoded.rgba } };
	});
}

interface Segment {
	x1: number;
	y1: number;
	x2: number;
	y2: number;
}
function segLength(s: Segment): number {
	return Math.hypot(s.x2 - s.x1, s.y2 - s.y1);
}
function segAngleDeg(s: Segment): number {
	let deg = (Math.atan2(s.y2 - s.y1, s.x2 - s.x1) * 180) / Math.PI;
	if (deg < 0) deg += 180;
	if (deg >= 180) deg -= 180;
	return deg;
}

interface RailPair {
	readonly a: Segment;
	readonly b: Segment;
	readonly midStart: [number, number];
	readonly midEnd: [number, number];
	readonly separationPx: number;
}

/** Pairs two roughly-parallel, overlapping segments at ~bandWidthPx apart into one fragment centerline. */
function pairRails(segments: readonly Segment[], bandWidthLowPx: number, bandWidthHighPx: number): RailPair[] {
	const pairs: RailPair[] = [];
	const angles = segments.map(segAngleDeg);
	for (let i = 0; i < segments.length; i += 1) {
		for (let j = i + 1; j < segments.length; j += 1) {
			const a = segments[i];
			const b = segments[j];
			const angleDiff = Math.min(Math.abs(angles[i] - angles[j]), 180 - Math.abs(angles[i] - angles[j]));
			if (angleDiff > 8) continue;

			const aLen = segLength(a);
			const bLen = segLength(b);
			let ux = (a.x2 - a.x1) / aLen;
			let uy = (a.y2 - a.y1) / aLen;
			let bux = (b.x2 - b.x1) / bLen;
			let buy = (b.y2 - b.y1) / bLen;
			if (ux * bux + uy * buy < 0) {
				bux = -bux;
				buy = -buy;
			}
			ux = (ux + bux) / 2;
			uy = (uy + buy) / 2;
			const uLen = Math.hypot(ux, uy) || 1;
			ux /= uLen;
			uy /= uLen;
			const nx = -uy;
			const ny = ux;

			const proj = (x: number, y: number): number => x * ux + y * uy;
			const aRange = [proj(a.x1, a.y1), proj(a.x2, a.y2)].sort((p, q) => p - q);
			const bRange = [proj(b.x1, b.y1), proj(b.x2, b.y2)].sort((p, q) => p - q);
			const overlap = Math.min(aRange[1], bRange[1]) - Math.max(aRange[0], bRange[0]);
			if (overlap < 0.4 * Math.min(aLen, bLen)) continue;

			const aMid = { x: (a.x1 + a.x2) / 2, y: (a.y1 + a.y2) / 2 };
			const bMid = { x: (b.x1 + b.x2) / 2, y: (b.y1 + b.y2) / 2 };
			const separation = Math.abs((bMid.x - aMid.x) * nx + (bMid.y - aMid.y) * ny);
			if (separation < bandWidthLowPx || separation > bandWidthHighPx) continue;

			const alongStart = Math.max(aRange[0], bRange[0]);
			const alongEnd = Math.min(aRange[1], bRange[1]);
			const acrossCenter = ((aMid.x + bMid.x) / 2) * nx + ((aMid.y + bMid.y) / 2) * ny;
			const toPoint = (along: number): [number, number] => [along * ux + acrossCenter * nx, along * uy + acrossCenter * ny];
			pairs.push({ a, b, midStart: toPoint(alongStart), midEnd: toPoint(alongEnd), separationPx: separation });
		}
	}
	return pairs;
}

async function main(): Promise<void> {
	mkdirSync(outDir, { recursive: true });
	const teeBundle = loadBundle('resources/GoldenTeeSet.chainspot.zip');
	const basketBundle = loadBundle('resources/GoldenBasketSet.chainspot.zip');
	const cv = (await loadCv()) as any; // eslint-disable-line @typescript-eslint/no-explicit-any

	const numberDetection = detectHoleNumberBadges(
		cv as unknown as HoleNumberCvModule,
		{ format: 'rgba', widthPx: teeBundle.raster.widthPx, heightPx: teeBundle.raster.heightPx, data: teeBundle.raster.rgba },
		loadNumberTemplatesReal()
	);
	const badgeByLabel = new Map(numberDetection.candidates.filter((c) => c.label !== undefined).map((c) => [c.label as number, c]));
	const basketByNumber = new Map(basketBundle.truth.filter((h: any) => h.basket).map((h: any) => [h.number, h.basket])); // eslint-disable-line @typescript-eslint/no-explicit-any
	const teeByNumber = new Map(teeBundle.truth.filter((h: any) => h.tee).map((h: any) => [h.number, h.tee])); // eslint-disable-line @typescript-eslint/no-explicit-any

	const numberBadges = [...badgeByLabel.values()].map((b) => ({
		xPx: b.xPx,
		yPx: b.yPx,
		leftPx: b.xPx - b.widthPx / 2,
		topPx: b.yPx - b.heightPx / 2,
		widthPx: b.widthPx,
		heightPx: b.heightPx
	}));
	const basketPoints = [...basketByNumber.values()] as { xPx: number; yPx: number }[];
	const teePoints = [...teeByNumber.values()] as { xPx: number; yPx: number }[];

	const gray = new Uint8Array(teeBundle.raster.widthPx * teeBundle.raster.heightPx);
	for (let p = 0, o = 0; p < gray.length; p += 1, o += 4) {
		gray[p] = (teeBundle.raster.rgba[o] * 0.299 + teeBundle.raster.rgba[o + 1] * 0.587 + teeBundle.raster.rgba[o + 2] * 0.114 + 0.5) | 0;
	}
	const raster: CenterlineRaster = { rgba: teeBundle.raster.rgba, gray, widthPx: teeBundle.raster.widthPx, heightPx: teeBundle.raster.heightPx };
	const { widthPx, heightPx } = raster;

	const { c2RadiusPx } = detectPuttingCircleRadii(raster, basketPoints);
	const occlusionMask = buildOcclusionMask(widthPx, heightPx, numberBadges, basketPoints, teePoints, c2RadiusPx);

	// Corridor width: 40px in the hand-annotated hole-spike fixture, 60px
	// default elsewhere -- search a generous band around that.
	const BAND_WIDTH_LOW_PX = 25;
	const BAND_WIDTH_HIGH_PX = 90;
	const CAPSULE_RADIUS_PX = 160;

	function distanceToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
		const dx = bx - ax;
		const dy = by - ay;
		const lengthSquared = dx * dx + dy * dy;
		const t = lengthSquared > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared)) : 0;
		return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
	}

	const fragmentsByHole = new Map<number, RailPair[]>();
	const allSegmentsByHole = new Map<number, Segment[]>();

	for (const hole of teeBundle.truth) {
		const tee = teeByNumber.get(hole.number) as { xPx: number; yPx: number } | undefined;
		const basket = basketByNumber.get(hole.number) as { xPx: number; yPx: number } | undefined;
		if (!tee || !basket) continue;

		const x0 = Math.max(0, Math.floor(Math.min(tee.xPx, basket.xPx) - CAPSULE_RADIUS_PX));
		const x1 = Math.min(widthPx, Math.ceil(Math.max(tee.xPx, basket.xPx) + CAPSULE_RADIUS_PX));
		const y0 = Math.max(0, Math.floor(Math.min(tee.yPx, basket.yPx) - CAPSULE_RADIUS_PX));
		const y1 = Math.min(heightPx, Math.ceil(Math.max(tee.yPx, basket.yPx) + CAPSULE_RADIUS_PX));
		const cropW = x1 - x0;
		const cropH = y1 - y0;
		if (cropW < 4 || cropH < 4) continue;

		const cropGray = new Uint8Array(cropW * cropH);
		for (let y = 0; y < cropH; y += 1) {
			for (let x = 0; x < cropW; x += 1) {
				cropGray[y * cropW + x] = gray[(y0 + y) * widthPx + (x0 + x)];
			}
		}

		const grayMat = new cv.Mat(cropH, cropW, cv.CV_8UC1);
		grayMat.data.set(cropGray);
		const blurred = new cv.Mat();
		const edges = new cv.Mat();
		const lines = new cv.Mat();
		try {
			cv.GaussianBlur(grayMat, blurred, new cv.Size(3, 3), 0, 0, cv.BORDER_DEFAULT);
			cv.Canny(blurred, edges, 40, 120);

			// Zero out edges inside occluder graphics (translated to crop coords),
			// and outside the capsule around this hole's tee-basket line.
			for (let y = 0; y < cropH; y += 1) {
				for (let x = 0; x < cropW; x += 1) {
					const globalIndex = (y0 + y) * widthPx + (x0 + x);
					const withinCapsule = distanceToSegment(x0 + x, y0 + y, tee.xPx, tee.yPx, basket.xPx, basket.yPx) <= CAPSULE_RADIUS_PX;
					if (occlusionMask[globalIndex] !== 0 || !withinCapsule) edges.data[y * cropW + x] = 0;
				}
			}

			cv.HoughLinesP(edges, lines, 1, Math.PI / 180, 20, 20, 8);
			const values: Int32Array = lines.data32S ?? new Int32Array();
			const segments: Segment[] = [];
			for (let i = 0; i + 3 < values.length; i += 4) {
				const s = { x1: values[i] + x0, y1: values[i + 1] + y0, x2: values[i + 2] + x0, y2: values[i + 3] + y0 };
				if (segLength(s) >= 15) segments.push(s);
			}
			allSegmentsByHole.set(hole.number, segments);

			const pairs = pairRails(segments, BAND_WIDTH_LOW_PX, BAND_WIDTH_HIGH_PX);
			fragmentsByHole.set(hole.number, pairs);
		} finally {
			grayMat.delete();
			blurred.delete();
			edges.delete();
			lines.delete();
		}
	}

	const totalFragments = [...fragmentsByHole.values()].reduce((sum, f) => sum + f.length, 0);
	console.error(`${totalFragments} rail-pair fragments across ${fragmentsByHole.size} holes`);
	for (const [number, fragments] of fragmentsByHole) {
		console.error(`  hole ${number}: ${allSegmentsByHole.get(number)?.length ?? 0} segments -> ${fragments.length} pairs`);
	}

	const png = new PNG({ width: widthPx, height: heightPx });
	png.data.set(teeBundle.raster.rgba);
	function setPixel(x: number, y: number, c: readonly [number, number, number, number]): void {
		if (x < 0 || y < 0 || x >= widthPx || y >= heightPx) return;
		const o = (y * widthPx + x) * 4;
		png.data[o] = c[0];
		png.data[o + 1] = c[1];
		png.data[o + 2] = c[2];
		png.data[o + 3] = c[3];
	}
	function line(x0: number, y0: number, x1: number, y1: number, c: readonly [number, number, number, number], thick = 1): void {
		let x = Math.round(x0),
			y = Math.round(y0);
		const tx = Math.round(x1),
			ty = Math.round(y1);
		const dx = Math.abs(tx - x),
			dy = Math.abs(ty - y);
		const sx = x < tx ? 1 : -1,
			sy = y < ty ? 1 : -1;
		let err = dx - dy;
		while (true) {
			for (let ry = -thick; ry <= thick; ry += 1) for (let rx = -thick; rx <= thick; rx += 1) setPixel(x + rx, y + ry, c);
			if (x === tx && y === ty) break;
			const e2 = 2 * err;
			if (e2 > -dy) {
				err -= dy;
				x += sx;
			}
			if (e2 < dx) {
				err += dx;
				y += sy;
			}
		}
	}
	const PALETTE: readonly [number, number, number, number][] = [
		[255, 0, 0, 255],
		[0, 128, 255, 255],
		[0, 220, 0, 255],
		[255, 200, 0, 255],
		[255, 0, 255, 255],
		[0, 220, 220, 255],
		[255, 120, 0, 255],
		[160, 0, 255, 255]
	];
	// Faint raw Hough segments in gray, then the accepted rail-pair midlines
	// in a bold hole color on top.
	let holeIndex = 0;
	for (const [, segments] of allSegmentsByHole) {
		for (const s of segments) line(s.x1, s.y1, s.x2, s.y2, [140, 140, 140, 255], 0);
	}
	for (const fragments of fragmentsByHole.values()) {
		const color = PALETTE[holeIndex % PALETTE.length];
		for (const pair of fragments) line(pair.midStart[0], pair.midStart[1], pair.midEnd[0], pair.midEnd[1], color, 1);
		holeIndex += 1;
	}

	writeFileSync(join(outDir, 'hough-full.png'), PNG.sync.write(png));
	console.error(`wrote ${join(outDir, 'hough-full.png')}`);

	const badge7 = badgeByLabel.get(7);
	if (badge7) {
		const pad = 220;
		const x0 = Math.max(0, Math.round(badge7.xPx - pad));
		const x1 = Math.min(widthPx, Math.round(badge7.xPx + pad));
		const y0 = Math.max(0, Math.round(badge7.yPx - pad));
		const y1 = Math.min(heightPx, Math.round(badge7.yPx + pad));
		const crop = new PNG({ width: x1 - x0, height: y1 - y0 });
		PNG.bitblt(png, crop, x0, y0, x1 - x0, y1 - y0, 0, 0);
		writeFileSync(join(outDir, 'hough-hole7.png'), PNG.sync.write(crop));
		console.error(`wrote ${join(outDir, 'hough-hole7.png')}`);
	}
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
