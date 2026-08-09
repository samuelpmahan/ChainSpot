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
import type { CenterlineHoleInput, CenterlineRaster } from '../src/lib/autoAnnotation/centerlineDetection';
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

const CENTERLINE_COLORS: readonly (readonly [number, number, number, number])[] = [
	[255, 64, 64, 255],
	[64, 160, 255, 255],
	[64, 220, 128, 255],
	[255, 200, 64, 255],
	[220, 64, 255, 255],
	[64, 220, 220, 255]
];
const CIRCLE_COLOR: readonly [number, number, number, number] = [255, 255, 255, 160];

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
	const png = new PNG({ width: teeBundle.widthPx, height: teeBundle.heightPx });
	png.data.set(teeBundle.rgba);
	const basketByHoleNumber = new Map(holes.map((hole) => [hole.number, hole.basket]));
	for (const hole of result.holes) {
		const color = CENTERLINE_COLORS[(hole.number - 1) % CENTERLINE_COLORS.length];
		const basket = basketByHoleNumber.get(hole.number)!;
		// c1Entry/c2Entry are where the traced path crosses each circle's
		// boundary, not the circle's center — the center is always the basket.
		circle(png, basket.xPx, basket.yPx, result.c1RadiusPx, CIRCLE_COLOR);
		circle(png, basket.xPx, basket.yPx, result.c2RadiusPx, CIRCLE_COLOR);
		for (let index = 0; index < hole.centerline.length - 1; index += 1) {
			const a = hole.centerline[index];
			const b = hole.centerline[index + 1];
			line(png, a.xPx, a.yPx, b.xPx, b.yPx, color);
		}
		dot(png, hole.centerline[0].xPx, hole.centerline[0].yPx, 4, color);
	}
	const overlayPath = join(resolve(outputDir), 'centerlines.png');
	writeFileSync(overlayPath, PNG.sync.write(png));
	const jsonPath = join(resolve(outputDir), 'centerlines.json');
	writeFileSync(jsonPath, `${JSON.stringify({ c1RadiusPx: result.c1RadiusPx, c2RadiusPx: result.c2RadiusPx, holes: result.holes }, null, 2)}\n`);
	console.log(`Wrote ${overlayPath}`);
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
