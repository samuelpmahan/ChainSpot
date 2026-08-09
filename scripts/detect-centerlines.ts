import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import jpeg from 'jpeg-js';
import { strFromU8, unzipSync } from 'fflate';
import { PNG } from 'pngjs';
import { loadCv } from '../src/lib/stitch/cvMatch';
import { detectHoleNumberBadges } from '../src/lib/autoAnnotation/holeNumberDetection';
import type { HoleNumberCvModule, HoleNumberTemplate } from '../src/lib/autoAnnotation/holeNumberDetection';
import { buildCenterlines } from '../src/lib/autoAnnotation/centerlineDetection';
import type { CenterlineHoleInput, CenterlineHoleResult, CenterlineRaster } from '../src/lib/autoAnnotation/centerlineDetection';
import { checkStraightness, compareToGoldenShape } from '../src/lib/autoAnnotation/centerlineGolden';
import type { GoldenPoint } from '../src/lib/autoAnnotation/centerlineGolden';

interface DecodedRaster {
	readonly rgba: Uint8Array;
	readonly widthPx: number;
	readonly heightPx: number;
}

interface HoleTruth {
	readonly number: number;
	readonly tee?: { readonly xPx: number; readonly yPx: number };
	readonly basket?: { readonly xPx: number; readonly yPx: number };
}

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = resolve(dirname(scriptPath), '..');
const defaultTemplateDir = join(projectRoot, 'static', 'resources', 'chainspot_cv_templates');

function usage(): string {
	return [
		'Usage: npm run detect:centerlines -- <tee-chainspot-zip> <basket-chainspot-zip> --out <directory>',
		'',
		'Both bundles must share the same source-overview image (same hole numbering);',
		'tee positions are read from the first bundle and basket positions from the second.',
		'',
		'Options:',
		'  --templates <directory>   Canonical templates directory (default: static/resources/chainspot_cv_templates)',
		'  --golden <path>           Golden-shape/straightness reference (default: resources/centerline-golden.json, if present)',
		'  --no-golden               Skip the golden check even if a default reference file exists',
		'  --help'
	].join('\n');
}

/**
 * A locked-in shape reference for one hole (regression guard against future
 * routing drift) plus a coarse straightness sanity check for holes known,
 * from the real course, to be plain tee-to-basket sightlines.
 */
interface GoldenReference {
	readonly shapeHoles?: readonly Readonly<{
		number: number;
		centerline: readonly GoldenPoint[];
		tolerancePx: number;
	}>[];
	readonly straightHoles?: Readonly<{ numbers: readonly number[]; maxDeviationFraction: number }>;
}

function loadGoldenReference(path: string): GoldenReference {
	return JSON.parse(readFileSync(resolve(path), 'utf8')) as GoldenReference;
}

/** Prints a pass/fail report against the golden reference; returns false if anything failed. */
function checkGolden(golden: GoldenReference, holesByNumber: Map<number, readonly GoldenPoint[]>): boolean {
	let allPassed = true;
	for (const shapeHole of golden.shapeHoles ?? []) {
		const traced = holesByNumber.get(shapeHole.number);
		if (!traced) {
			console.error(`GOLDEN SHAPE hole ${shapeHole.number}: FAIL (hole not traced)`);
			allPassed = false;
			continue;
		}
		const comparison = compareToGoldenShape(traced, shapeHole.centerline, shapeHole.tolerancePx);
		const status = comparison.withinTolerance ? 'PASS' : 'FAIL';
		console.error(
			`GOLDEN SHAPE hole ${shapeHole.number}: ${status} (max ${comparison.maxDistancePx.toFixed(1)}px vs ${shapeHole.tolerancePx}px tolerance)`
		);
		if (!comparison.withinTolerance) allPassed = false;
	}
	if (golden.straightHoles) {
		for (const number of golden.straightHoles.numbers) {
			const traced = holesByNumber.get(number);
			if (!traced) {
				console.error(`STRAIGHTNESS hole ${number}: FAIL (hole not traced)`);
				allPassed = false;
				continue;
			}
			const result = checkStraightness(traced, golden.straightHoles.maxDeviationFraction);
			const status = result.withinTolerance ? 'PASS' : 'FAIL';
			console.error(
				`STRAIGHTNESS hole ${number}: ${status} (deviation ${(result.deviationFraction * 100).toFixed(1)}% vs ${(golden.straightHoles.maxDeviationFraction * 100).toFixed(1)}% max)`
			);
			if (!result.withinTolerance) allPassed = false;
		}
	}
	return allPassed;
}

function decodeRaster(bytes: Uint8Array, fileName: string): DecodedRaster {
	const extension = extname(fileName).toLowerCase();
	if (extension === '.png') {
		const decoded = PNG.sync.read(Buffer.from(bytes));
		return { rgba: new Uint8Array(decoded.data), widthPx: decoded.width, heightPx: decoded.height };
	}
	if (extension === '.jpg' || extension === '.jpeg') {
		const decoded = jpeg.decode(Buffer.from(bytes), { useTArray: true });
		return { rgba: new Uint8Array(decoded.data), widthPx: decoded.width, heightPx: decoded.height };
	}
	throw new Error(`Unsupported image format '${extension}'.`);
}

interface LoadedBundle extends DecodedRaster {
	readonly truth: readonly HoleTruth[];
}

function loadBundle(path: string): LoadedBundle {
	const bytes = new Uint8Array(readFileSync(resolve(path)));
	const entries = unzipSync(bytes);
	const jsonBytes = entries['project.json'];
	if (!jsonBytes) throw new Error(`Bundle '${path}' does not contain project.json.`);
	const document = JSON.parse(strFromU8(jsonBytes)) as {
		images?: readonly Readonly<{ role?: unknown; fileName?: unknown; bundlePath?: unknown }>[];
		holes?: readonly Readonly<{
			number?: unknown;
			tee?: Readonly<{ xPx?: unknown; yPx?: unknown }>;
			basket?: Readonly<{ xPx?: unknown; yPx?: unknown }>;
		}>[];
	};
	const sourceManifest = (document.images ?? []).find((image) => image.role === 'source-overview');
	const sourceEntry = sourceManifest?.bundlePath;
	if (typeof sourceEntry !== 'string' || !sourceEntry.startsWith('images/')) {
		throw new Error(`Bundle '${path}' does not contain a safe source-overview image path.`);
	}
	const sourceBytes = entries[sourceEntry];
	if (!sourceBytes) throw new Error(`Bundle '${path}' is missing ${sourceEntry}.`);
	const truth: HoleTruth[] = (document.holes ?? [])
		.map((hole) => ({
			number: typeof hole.number === 'number' ? hole.number : NaN,
			tee:
				typeof hole.tee?.xPx === 'number' && typeof hole.tee?.yPx === 'number'
					? { xPx: hole.tee.xPx, yPx: hole.tee.yPx }
					: undefined,
			basket:
				typeof hole.basket?.xPx === 'number' && typeof hole.basket?.yPx === 'number'
					? { xPx: hole.basket.xPx, yPx: hole.basket.yPx }
					: undefined
		}))
		.filter((hole) => Number.isInteger(hole.number));
	return {
		...decodeRaster(sourceBytes, typeof sourceManifest?.fileName === 'string' ? sourceManifest.fileName : sourceEntry),
		truth
	};
}

function toGray(raster: DecodedRaster): Uint8Array {
	const gray = new Uint8Array(raster.widthPx * raster.heightPx);
	for (let pixel = 0, offset = 0; pixel < gray.length; pixel += 1, offset += 4) {
		gray[pixel] = (raster.rgba[offset] * 0.299 + raster.rgba[offset + 1] * 0.587 + raster.rgba[offset + 2] * 0.114 + 0.5) | 0;
	}
	return gray;
}

function loadNumberTemplates(templateDir: string): readonly HoleNumberTemplate[] {
	return Array.from({ length: 18 }, (_, index) => {
		const label = index + 1;
		const fileName = `hole-${String(label).padStart(2, '0')}.png`;
		const path = join(resolve(templateDir), fileName);
		const decoded = decodeRaster(new Uint8Array(readFileSync(path)), path);
		return {
			label,
			raster: { format: 'rgba' as const, widthPx: decoded.widthPx, heightPx: decoded.heightPx, data: decoded.rgba }
		};
	});
}

function setPixel(png: PNG, x: number, y: number, color: readonly [number, number, number, number]): void {
	if (x < 0 || y < 0 || x >= png.width || y >= png.height) return;
	const offset = (y * png.width + x) * 4;
	png.data[offset] = color[0];
	png.data[offset + 1] = color[1];
	png.data[offset + 2] = color[2];
	png.data[offset + 3] = color[3];
}

function dot(png: PNG, x: number, y: number, radius: number, color: readonly [number, number, number, number]): void {
	for (let dy = -radius; dy <= radius; dy += 1)
		for (let dx = -radius; dx <= radius; dx += 1) if (dx * dx + dy * dy <= radius * radius) setPixel(png, Math.round(x) + dx, Math.round(y) + dy, color);
}

function line(png: PNG, x0: number, y0: number, x1: number, y1: number, color: readonly [number, number, number, number]): void {
	let x = Math.round(x0);
	let y = Math.round(y0);
	const targetX = Math.round(x1);
	const targetY = Math.round(y1);
	const dx = Math.abs(targetX - x);
	const dy = Math.abs(targetY - y);
	const stepX = x < targetX ? 1 : -1;
	const stepY = y < targetY ? 1 : -1;
	let error = dx - dy;
	while (true) {
		setPixel(png, x, y, color);
		if (x === targetX && y === targetY) break;
		const doubled = 2 * error;
		if (doubled > -dy) {
			error -= dy;
			x += stepX;
		}
		if (doubled < dx) {
			error += dx;
			y += stepY;
		}
	}
}

function circle(png: PNG, cx: number, cy: number, radius: number, color: readonly [number, number, number, number]): void {
	const steps = Math.max(24, Math.round(radius));
	let prev: [number, number] | undefined;
	for (let step = 0; step <= steps; step += 1) {
		const theta = (step / steps) * Math.PI * 2;
		const point: [number, number] = [cx + Math.cos(theta) * radius, cy + Math.sin(theta) * radius];
		if (prev) line(png, prev[0], prev[1], point[0], point[1], color);
		prev = point;
	}
}

function rectOutline(
	png: PNG,
	x0: number,
	y0: number,
	x1: number,
	y1: number,
	color: readonly [number, number, number, number]
): void {
	line(png, x0, y0, x1, y0, color);
	line(png, x1, y0, x1, y1, color);
	line(png, x1, y1, x0, y1, color);
	line(png, x0, y1, x0, y0, color);
}

/**
 * Per-hole overlay style matched to the proven `semantic_exact_anchor.py`
 * probe's `render_one`/`contact_sheet` (BGR translated to RGB): the
 * appearance-tracked outward trace and the geometry-only C2/C1/basket
 * terminal are drawn in different colors so the two very different kinds of
 * evidence a route is built from aren't visually conflated into one
 * undifferentiated wiggly line.
 */
const COLOR_BADGE: readonly [number, number, number, number] = [255, 255, 0, 255];
const COLOR_TEE: readonly [number, number, number, number] = [255, 0, 255, 255];
const COLOR_BASKET_BOX: readonly [number, number, number, number] = [0, 255, 255, 255];
const COLOR_BASKET_DOT: readonly [number, number, number, number] = [255, 0, 0, 255];
const COLOR_C1_RING: readonly [number, number, number, number] = [255, 170, 0, 255];
const COLOR_C2_RING: readonly [number, number, number, number] = [0, 220, 0, 255];
const COLOR_APPEARANCE_SEGMENT: readonly [number, number, number, number] = [0, 80, 255, 255];
const COLOR_TERMINAL_SEGMENT: readonly [number, number, number, number] = [255, 0, 0, 255];
const COLOR_C2_SIDE: readonly [number, number, number, number] = [255, 255, 0, 255];
const COLOR_C1_SIDE: readonly [number, number, number, number] = [0, 255, 255, 255];

interface RenderHole {
	readonly badge: { readonly xPx: number; readonly yPx: number; readonly leftPx: number; readonly topPx: number; readonly widthPx: number; readonly heightPx: number };
	readonly tee: GoldenPoint;
	readonly basket: GoldenPoint;
	readonly route: CenterlineHoleResult;
	readonly c1RadiusPx: number;
	readonly c2RadiusPx: number;
}

/** Draws one hole's full route + endpoint markers onto `png`, offsetting every coordinate by `(-offsetX, -offsetY)`. */
function renderOne(png: PNG, hole: RenderHole, offsetX: number, offsetY: number): void {
	const at = (point: GoldenPoint): [number, number] => [point.xPx - offsetX, point.yPx - offsetY];
	const [badgeX, badgeY] = at({ xPx: hole.badge.leftPx, yPx: hole.badge.topPx });
	rectOutline(png, badgeX, badgeY, badgeX + hole.badge.widthPx, badgeY + hole.badge.heightPx, COLOR_BADGE);

	const [teeX, teeY] = at(hole.tee);
	circle(png, teeX, teeY, 6, COLOR_TEE);
	dot(png, teeX, teeY, 2, COLOR_TEE);

	const [basketX, basketY] = at(hole.basket);
	rectOutline(png, basketX - hole.c1RadiusPx * 0.1 - 5, basketY - 5, basketX + 5, basketY + 5, COLOR_BASKET_BOX);
	dot(png, basketX, basketY, 4, COLOR_BASKET_DOT);
	circle(png, basketX, basketY, hole.c1RadiusPx, COLOR_C1_RING);
	circle(png, basketX, basketY, hole.c2RadiusPx, COLOR_C2_RING);

	const points = hole.route.centerline.map(at);
	const terminalStart = hole.route.terminalStartIndex;
	for (let index = 0; index < terminalStart && index < points.length - 1; index += 1) {
		line(png, points[index][0], points[index][1], points[index + 1][0], points[index + 1][1], COLOR_APPEARANCE_SEGMENT);
	}
	for (let index = Math.max(terminalStart, 0); index < points.length - 1; index += 1) {
		line(png, points[index][0], points[index][1], points[index + 1][0], points[index + 1][1], COLOR_TERMINAL_SEGMENT);
	}

	for (const side of [hole.route.c2Left, hole.route.c2Right]) {
		const [x, y] = at(side);
		dot(png, x, y, 3, COLOR_C2_SIDE);
	}
	const [c2EntryX, c2EntryY] = at(hole.route.c2Entry);
	dot(png, c2EntryX, c2EntryY, 4, COLOR_C2_RING);

	for (const side of [hole.route.c1Left, hole.route.c1Right]) {
		const [x, y] = at(side);
		dot(png, x, y, 3, COLOR_C1_SIDE);
	}
	const [c1EntryX, c1EntryY] = at(hole.route.c1Entry);
	dot(png, c1EntryX, c1EntryY, 4, COLOR_C1_RING);
}

function cropPng(source: PNG, x0: number, y0: number, x1: number, y1: number): PNG {
	const width = Math.max(1, x1 - x0);
	const height = Math.max(1, y1 - y0);
	const crop = new PNG({ width, height });
	PNG.bitblt(source, crop, x0, y0, width, height, 0, 0);
	return crop;
}

/** Bilinear resize into a new PNG; used to fit each hole's crop into a fixed tile size. */
function resizeBilinear(source: PNG, targetWidth: number, targetHeight: number): PNG {
	const output = new PNG({ width: targetWidth, height: targetHeight });
	const scaleX = source.width / targetWidth;
	const scaleY = source.height / targetHeight;
	for (let y = 0; y < targetHeight; y += 1) {
		const sy = Math.min(source.height - 1.0001, y * scaleY);
		const y0 = Math.floor(sy);
		const y1 = Math.min(source.height - 1, y0 + 1);
		const fy = sy - y0;
		for (let x = 0; x < targetWidth; x += 1) {
			const sx = Math.min(source.width - 1.0001, x * scaleX);
			const x0 = Math.floor(sx);
			const x1 = Math.min(source.width - 1, x0 + 1);
			const fx = sx - x0;
			const outOffset = (y * targetWidth + x) * 4;
			for (let channel = 0; channel < 4; channel += 1) {
				const p00 = source.data[(y0 * source.width + x0) * 4 + channel];
				const p10 = source.data[(y0 * source.width + x1) * 4 + channel];
				const p01 = source.data[(y1 * source.width + x0) * 4 + channel];
				const p11 = source.data[(y1 * source.width + x1) * 4 + channel];
				const top = p00 + (p10 - p00) * fx;
				const bottom = p01 + (p11 - p01) * fx;
				output.data[outOffset + channel] = Math.round(top + (bottom - top) * fy);
			}
		}
	}
	return output;
}

function blit(destination: PNG, source: PNG, x: number, y: number): void {
	PNG.bitblt(source, destination, 0, 0, source.width, source.height, x, y);
}

const TILE_WIDTH = 300;
const TILE_HEIGHT = 250;
const TILE_PAD_PX = 60;
const CONTACT_SHEET_COLUMNS = 3;

/**
 * Per-hole cropped tiles (route + endpoints only, no neighboring holes'
 * annotations) tiled into a grid, matching the reference probe's
 * `contact_sheet` for a direct side-by-side visual comparison.
 */
function contactSheet(sourceRaster: PNG, holes: readonly RenderHole[]): PNG {
	const tiles = holes.map((hole) => {
		const xs = [...hole.route.centerline.map((p) => p.xPx), hole.badge.xPx, hole.tee.xPx, hole.basket.xPx];
		const ys = [...hole.route.centerline.map((p) => p.yPx), hole.badge.yPx, hole.tee.yPx, hole.basket.yPx];
		const x0 = Math.max(0, Math.floor(Math.min(...xs) - TILE_PAD_PX));
		const x1 = Math.min(sourceRaster.width, Math.ceil(Math.max(...xs) + TILE_PAD_PX));
		const y0 = Math.max(0, Math.floor(Math.min(...ys) - TILE_PAD_PX));
		const y1 = Math.min(sourceRaster.height, Math.ceil(Math.max(...ys) + TILE_PAD_PX));

		const crop = cropPng(sourceRaster, x0, y0, x1, y1);
		renderOne(crop, hole, x0, y0);

		const fitScale = Math.min(TILE_WIDTH / crop.width, TILE_HEIGHT / crop.height);
		const resized = resizeBilinear(crop, Math.max(1, Math.round(crop.width * fitScale)), Math.max(1, Math.round(crop.height * fitScale)));
		const tile = new PNG({ width: TILE_WIDTH, height: TILE_HEIGHT });
		blit(tile, resized, Math.floor((TILE_WIDTH - resized.width) / 2), Math.floor((TILE_HEIGHT - resized.height) / 2));
		return tile;
	});

	const rows = Math.ceil(tiles.length / CONTACT_SHEET_COLUMNS);
	const sheet = new PNG({ width: TILE_WIDTH * CONTACT_SHEET_COLUMNS, height: TILE_HEIGHT * rows });
	tiles.forEach((tile, index) => {
		const row = Math.floor(index / CONTACT_SHEET_COLUMNS);
		const column = index % CONTACT_SHEET_COLUMNS;
		blit(sheet, tile, column * TILE_WIDTH, row * TILE_HEIGHT);
	});
	return sheet;
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	if (argv.includes('--help')) {
		console.log(usage());
		return;
	}
	let templateDir = defaultTemplateDir;
	let outputDir: string | undefined;
	let goldenPath: string | undefined;
	let skipGolden = false;
	const positionals: string[] = [];
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === '--templates') {
			templateDir = argv[index + 1];
			index += 1;
		} else if (argument === '--out') {
			outputDir = argv[index + 1];
			index += 1;
		} else if (argument === '--golden') {
			goldenPath = argv[index + 1];
			index += 1;
		} else if (argument === '--no-golden') {
			skipGolden = true;
		} else if (!argument.startsWith('--')) {
			positionals.push(argument);
		}
	}
	const [teeBundlePath, basketBundlePath] = positionals;
	if (!teeBundlePath || !basketBundlePath || !outputDir) throw new Error(`Missing arguments.\n\n${usage()}`);
	const defaultGoldenPath = join(projectRoot, 'resources', 'centerline-golden.json');
	const resolvedGoldenPath = skipGolden ? undefined : (goldenPath ?? (existsSync(defaultGoldenPath) ? defaultGoldenPath : undefined));

	const teeBundle = loadBundle(teeBundlePath);
	const basketBundle = loadBundle(basketBundlePath);
	const cv = (await loadCv()) as unknown as HoleNumberCvModule;

	const numberDetection = detectHoleNumberBadges(
		cv,
		{ format: 'rgba', widthPx: teeBundle.widthPx, heightPx: teeBundle.heightPx, data: teeBundle.rgba },
		loadNumberTemplates(templateDir)
	);
	const badgeByLabel = new Map(numberDetection.candidates.filter((c) => c.label !== undefined).map((c) => [c.label as number, c]));
	const basketByNumber = new Map(basketBundle.truth.filter((h) => h.basket).map((h) => [h.number, h.basket!]));

	const holes: CenterlineHoleInput[] = [];
	const skipped: number[] = [];
	for (const hole of teeBundle.truth) {
		const badge = badgeByLabel.get(hole.number);
		const basket = basketByNumber.get(hole.number);
		if (!badge || !hole.tee || !basket) {
			skipped.push(hole.number);
			continue;
		}
		holes.push({
			number: hole.number,
			numberBadge: {
				xPx: badge.xPx,
				yPx: badge.yPx,
				leftPx: badge.xPx - badge.widthPx / 2,
				topPx: badge.yPx - badge.heightPx / 2,
				widthPx: badge.widthPx,
				heightPx: badge.heightPx
			},
			tee: hole.tee,
			basket
		});
	}
	if (skipped.length > 0) console.error(`Skipping holes missing a detected number badge, tee, or basket: ${skipped.join(', ')}`);

	const raster: CenterlineRaster = {
		rgba: teeBundle.rgba,
		gray: toGray(teeBundle),
		widthPx: teeBundle.widthPx,
		heightPx: teeBundle.heightPx
	};
	const result = buildCenterlines(holes, raster);
	console.error(`c1RadiusPx=${result.c1RadiusPx.toFixed(1)} c2RadiusPx=${result.c2RadiusPx.toFixed(1)}`);

	mkdirSync(resolve(outputDir), { recursive: true });
	const holeByNumber = new Map(holes.map((hole) => [hole.number, hole]));
	const renderHoles: RenderHole[] = result.holes.map((route) => {
		const hole = holeByNumber.get(route.number)!;
		return { badge: hole.numberBadge, tee: hole.tee, basket: hole.basket, route, c1RadiusPx: result.c1RadiusPx, c2RadiusPx: result.c2RadiusPx };
	});

	const fullOverlay = new PNG({ width: teeBundle.widthPx, height: teeBundle.heightPx });
	fullOverlay.data.set(teeBundle.rgba);
	for (const hole of renderHoles) renderOne(fullOverlay, hole, 0, 0);
	const overlayPath = join(resolve(outputDir), 'centerlines.png');
	writeFileSync(overlayPath, PNG.sync.write(fullOverlay));

	const rawSource = new PNG({ width: teeBundle.widthPx, height: teeBundle.heightPx });
	rawSource.data.set(teeBundle.rgba);
	const sheetPath = join(resolve(outputDir), 'contact-sheet.png');
	writeFileSync(sheetPath, PNG.sync.write(contactSheet(rawSource, renderHoles)));

	const jsonPath = join(resolve(outputDir), 'centerlines.json');
	writeFileSync(jsonPath, `${JSON.stringify({ c1RadiusPx: result.c1RadiusPx, c2RadiusPx: result.c2RadiusPx, holes: result.holes }, null, 2)}\n`);
	console.log(`Wrote ${overlayPath}`);
	console.log(`Wrote ${sheetPath}`);
	console.log(`Wrote ${jsonPath}`);

	if (resolvedGoldenPath) {
		const golden = loadGoldenReference(resolvedGoldenPath);
		const holesByNumber = new Map(result.holes.map((hole) => [hole.number, hole.centerline]));
		const passed = checkGolden(golden, holesByNumber);
		if (!passed) process.exitCode = 1;
	}
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
