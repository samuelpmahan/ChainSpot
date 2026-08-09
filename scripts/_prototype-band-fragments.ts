/**
 * Throwaway prototype: instead of point-by-point appearance coasting,
 * extract the UDisc corridor overlay as occlusion-aware connected fragments
 * (confident on-band pixels, minus every hole's badge/tee/circle graphics),
 * fit each fragment to a line segment, and color-code them so a human can
 * eyeball whether fragment-chaining + ray-intersection bridging is viable
 * before it's built for real. Not wired into production; not unit tested.
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

function loadBundle(path: string): { readonly raster: DecodedRaster; readonly truth: readonly { number: number; tee?: { xPx: number; yPx: number }; basket?: { xPx: number; yPx: number } }[] } {
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

function decodePng(bytes: Uint8Array): DecodedRaster {
	const decoded = PNG.sync.read(Buffer.from(bytes));
	return { rgba: new Uint8Array(decoded.data), widthPx: decoded.width, heightPx: decoded.height };
}
function loadNumberTemplatesReal(): readonly HoleNumberTemplate[] {
	return Array.from({ length: 18 }, (_, index) => {
		const label = index + 1;
		const path = join(templateDir, `hole-${String(label).padStart(2, '0')}.png`);
		const decoded = decodePng(new Uint8Array(readFileSync(path)));
		return { label, raster: { format: 'rgba' as const, widthPx: decoded.widthPx, heightPx: decoded.heightPx, data: decoded.rgba } };
	});
}

async function main(): Promise<void> {
	mkdirSync(outDir, { recursive: true });
	const teeBundle = loadBundle('resources/GoldenTeeSet.chainspot.zip');
	const basketBundle = loadBundle('resources/GoldenBasketSet.chainspot.zip');
	const cv = (await loadCv()) as unknown as HoleNumberCvModule;

	const numberDetection = detectHoleNumberBadges(
		cv,
		{ format: 'rgba', widthPx: teeBundle.raster.widthPx, heightPx: teeBundle.raster.heightPx, data: teeBundle.raster.rgba },
		loadNumberTemplatesReal()
	);
	const badgeByLabel = new Map(numberDetection.candidates.filter((c) => c.label !== undefined).map((c) => [c.label as number, c]));
	const basketByNumber = new Map(basketBundle.truth.filter((h) => h.basket).map((h) => [h.number, h.basket!]));
	const teeByNumber = new Map(teeBundle.truth.filter((h) => h.tee).map((h) => [h.number, h.tee!]));

	const numberBadges = [...badgeByLabel.values()].map((b) => ({
		xPx: b.xPx,
		yPx: b.yPx,
		leftPx: b.xPx - b.widthPx / 2,
		topPx: b.yPx - b.heightPx / 2,
		widthPx: b.widthPx,
		heightPx: b.heightPx
	}));
	const basketPoints = [...basketByNumber.values()];
	const teePoints = [...teeByNumber.values()];

	const gray = new Uint8Array(teeBundle.raster.widthPx * teeBundle.raster.heightPx);
	for (let p = 0, o = 0; p < gray.length; p += 1, o += 4) {
		gray[p] = (teeBundle.raster.rgba[o] * 0.299 + teeBundle.raster.rgba[o + 1] * 0.587 + teeBundle.raster.rgba[o + 2] * 0.114 + 0.5) | 0;
	}
	const raster: CenterlineRaster = { rgba: teeBundle.raster.rgba, gray, widthPx: teeBundle.raster.widthPx, heightPx: teeBundle.raster.heightPx };

	const { c1RadiusPx, c2RadiusPx } = detectPuttingCircleRadii(raster, basketPoints);
	console.error(`c1=${c1RadiusPx} c2=${c2RadiusPx}`);
	const occlusionMask = buildOcclusionMask(raster.widthPx, raster.heightPx, numberBadges, basketPoints, teePoints, c2RadiusPx);
	const { widthPx, heightPx } = raster;

	// Local-relative brightness: the band is a translucent overlay that lifts
	// brightness relative to whatever terrain it's over, not any fixed
	// absolute brightness/saturation -- confirmed on real samples (band:
	// consistently +20..+48 over its local neighborhood; grass: -9..-28).
	// Computed via a summed-area table for O(1) local-mean lookups.
	const value = new Float32Array(widthPx * heightPx);
	for (let pixel = 0, offset = 0; pixel < value.length; pixel += 1, offset += 4) {
		value[pixel] = Math.max(raster.rgba[offset], raster.rgba[offset + 1], raster.rgba[offset + 2]);
	}
	const integral = new Float64Array((widthPx + 1) * (heightPx + 1));
	for (let y = 0; y < heightPx; y += 1) {
		let rowSum = 0;
		for (let x = 0; x < widthPx; x += 1) {
			rowSum += value[y * widthPx + x];
			integral[(y + 1) * (widthPx + 1) + (x + 1)] = integral[y * (widthPx + 1) + (x + 1)] + rowSum;
		}
	}
	function localMean(x: number, y: number, radius: number): number {
		const x0 = Math.max(0, x - radius);
		const y0 = Math.max(0, y - radius);
		const x1 = Math.min(widthPx, x + radius + 1);
		const y1 = Math.min(heightPx, y + radius + 1);
		const sum =
			integral[y1 * (widthPx + 1) + x1] -
			integral[y0 * (widthPx + 1) + x1] -
			integral[y1 * (widthPx + 1) + x0] +
			integral[y0 * (widthPx + 1) + x0];
		return sum / ((x1 - x0) * (y1 - y0));
	}
	const LOCAL_RADIUS_PX = 60;
	const feature = new Float32Array(widthPx * heightPx);
	for (let y = 0; y < heightPx; y += 1) {
		for (let x = 0; x < widthPx; x += 1) {
			const index = y * widthPx + x;
			feature[index] = value[index] - localMean(x, y, LOCAL_RADIUS_PX);
		}
	}

	const threshold = 15; // pixel value minus its local-neighborhood mean brightness

	// Restrict the mask/component search per hole to a capsule around its own
	// straight tee-basket line (generous radius so a real bend still fits),
	// instead of the whole image -- that's what let unrelated pale terrain
	// (roads, parking, dead grass) leak into far-away components last time.
	const CAPSULE_RADIUS_PX = 140;
	function distanceToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
		const dx = bx - ax;
		const dy = by - ay;
		const lengthSquared = dx * dx + dy * dy;
		const t = lengthSquared > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared)) : 0;
		const cx = ax + t * dx;
		const cy = ay + t * dy;
		return Math.hypot(px - cx, py - cy);
	}

	function fitLine(xs: readonly number[], ys: readonly number[]): { a: [number, number]; b: [number, number] } {
		const n = xs.length;
		const meanX = xs.reduce((s, v) => s + v, 0) / n;
		const meanY = ys.reduce((s, v) => s + v, 0) / n;
		let sxx = 0,
			sxy = 0,
			syy = 0;
		for (let i = 0; i < n; i += 1) {
			const dx = xs[i] - meanX;
			const dy = ys[i] - meanY;
			sxx += dx * dx;
			sxy += dx * dy;
			syy += dy * dy;
		}
		const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
		const dirX = Math.cos(theta);
		const dirY = Math.sin(theta);
		let minT = Infinity,
			maxT = -Infinity,
			minPoint: [number, number] = [meanX, meanY],
			maxPoint: [number, number] = [meanX, meanY];
		for (let i = 0; i < n; i += 1) {
			const t = (xs[i] - meanX) * dirX + (ys[i] - meanY) * dirY;
			if (t < minT) {
				minT = t;
				minPoint = [xs[i], ys[i]];
			}
			if (t > maxT) {
				maxT = t;
				maxPoint = [xs[i], ys[i]];
			}
		}
		return { a: minPoint, b: maxPoint };
	}

	const MIN_COMPONENT_SIZE = 40;
	const fragmentsByHole = new Map<number, { a: [number, number]; b: [number, number]; size: number }[]>();
	const combinedOnBand = new Uint8Array(widthPx * heightPx);

	for (const hole of teeBundle.truth) {
		const tee = teeByNumber.get(hole.number);
		const basket = basketByNumber.get(hole.number);
		if (!tee || !basket) continue;

		const x0 = Math.max(0, Math.floor(Math.min(tee.xPx, basket.xPx) - CAPSULE_RADIUS_PX));
		const x1 = Math.min(widthPx, Math.ceil(Math.max(tee.xPx, basket.xPx) + CAPSULE_RADIUS_PX));
		const y0 = Math.max(0, Math.floor(Math.min(tee.yPx, basket.yPx) - CAPSULE_RADIUS_PX));
		const y1 = Math.min(heightPx, Math.ceil(Math.max(tee.yPx, basket.yPx) + CAPSULE_RADIUS_PX));

		const onBand = new Uint8Array(widthPx * heightPx);
		for (let y = y0; y < y1; y += 1) {
			for (let x = x0; x < x1; x += 1) {
				const index = y * widthPx + x;
				if (feature[index] < threshold || occlusionMask[index] !== 0) continue;
				if (distanceToSegment(x, y, tee.xPx, tee.yPx, basket.xPx, basket.yPx) > CAPSULE_RADIUS_PX) continue;
				onBand[index] = 1;
				combinedOnBand[index] = 1;
			}
		}

		const labels = new Int32Array(widthPx * heightPx).fill(-1);
		const components: { xs: number[]; ys: number[] }[] = [];
		const stack: number[] = [];
		for (let y = y0; y < y1; y += 1) {
			for (let x = x0; x < x1; x += 1) {
				const start = y * widthPx + x;
				if (onBand[start] === 0 || labels[start] !== -1) continue;
				const component = { xs: [] as number[], ys: [] as number[] };
				components.push(component);
				stack.push(start);
				labels[start] = components.length - 1;
				while (stack.length > 0) {
					const index = stack.pop()!;
					const cx = index % widthPx;
					const cy = (index / widthPx) | 0;
					component.xs.push(cx);
					component.ys.push(cy);
					const neighbors: [number, number][] = [
						[index - 1, cx - 1],
						[index + 1, cx + 1],
						[index - widthPx, cx],
						[index + widthPx, cx]
					];
					for (const [neighbor, neighborX] of neighbors) {
						if (neighbor < 0 || neighbor >= onBand.length) continue;
						if (Math.abs(neighborX - cx) > 1) continue;
						if (onBand[neighbor] === 1 && labels[neighbor] === -1) {
							labels[neighbor] = components.length - 1;
							stack.push(neighbor);
						}
					}
				}
			}
		}

		const bigComponents = components.filter((c) => c.xs.length >= MIN_COMPONENT_SIZE);
		fragmentsByHole.set(
			hole.number,
			bigComponents.map((c) => ({ ...fitLine(c.xs, c.ys), size: c.xs.length }))
		);
	}

	const totalFragments = [...fragmentsByHole.values()].reduce((sum, f) => sum + f.length, 0);
	console.error(`${totalFragments} fragments across ${fragmentsByHole.size} holes (capsule radius ${CAPSULE_RADIUS_PX}px)`);
	for (const [number, fragments] of fragmentsByHole) {
		console.error(`  hole ${number}: ${fragments.length} fragments, sizes [${fragments.map((f) => f.size).join(', ')}]`);
	}

	// Render: source image, on-band mask tinted faint white, each hole's
	// fragments in a distinct color with the fitted line drawn on top.
	const png = new PNG({ width: widthPx, height: heightPx });
	png.data.set(teeBundle.raster.rgba);
	for (let i = 0; i < combinedOnBand.length; i += 1) {
		if (combinedOnBand[i] === 1) {
			const o = i * 4;
			png.data[o] = Math.min(255, png.data[o] + 40);
			png.data[o + 1] = Math.min(255, png.data[o + 1] + 40);
			png.data[o + 2] = Math.min(255, png.data[o + 2] + 40);
		}
	}
	function setPixel(x: number, y: number, c: readonly [number, number, number, number]): void {
		if (x < 0 || y < 0 || x >= widthPx || y >= heightPx) return;
		const o = (y * widthPx + x) * 4;
		png.data[o] = c[0];
		png.data[o + 1] = c[1];
		png.data[o + 2] = c[2];
		png.data[o + 3] = c[3];
	}
	function line(x0: number, y0: number, x1: number, y1: number, c: readonly [number, number, number, number]): void {
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
			for (let ry = -1; ry <= 1; ry += 1) for (let rx = -1; rx <= 1; rx += 1) setPixel(x + rx, y + ry, c);
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
	let holeIndex = 0;
	for (const fragments of fragmentsByHole.values()) {
		const color = PALETTE[holeIndex % PALETTE.length];
		for (const fragment of fragments) line(fragment.a[0], fragment.a[1], fragment.b[0], fragment.b[1], color);
		holeIndex += 1;
	}

	writeFileSync(join(outDir, 'fragments-full.png'), PNG.sync.write(png));
	console.error(`wrote ${join(outDir, 'fragments-full.png')}, ${totalFragments} fragments drawn`);

	// Focused crop on hole 7's number badge (the validation case: obscured on
	// one side by hole 8's tee pad, the other by hole 6's dashed C2 circle).
	const badge7 = badgeByLabel.get(7);
	if (badge7) {
		const pad = 220;
		const x0 = Math.max(0, Math.round(badge7.xPx - pad));
		const x1 = Math.min(widthPx, Math.round(badge7.xPx + pad));
		const y0 = Math.max(0, Math.round(badge7.yPx - pad));
		const y1 = Math.min(heightPx, Math.round(badge7.yPx + pad));
		const crop = new PNG({ width: x1 - x0, height: y1 - y0 });
		PNG.bitblt(png, crop, x0, y0, x1 - x0, y1 - y0, 0, 0);
		writeFileSync(join(outDir, 'fragments-hole7.png'), PNG.sync.write(crop));
		console.error(`wrote ${join(outDir, 'fragments-hole7.png')}`);
	}
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
