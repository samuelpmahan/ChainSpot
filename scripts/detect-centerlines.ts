import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
		'  --help'
	].join('\n');
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
	const positionals: string[] = [];
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === '--templates') {
			templateDir = argv[index + 1];
			index += 1;
		} else if (argument === '--out') {
			outputDir = argv[index + 1];
			index += 1;
		} else if (!argument.startsWith('--')) {
			positionals.push(argument);
		}
	}
	const [teeBundlePath, basketBundlePath] = positionals;
	if (!teeBundlePath || !basketBundlePath || !outputDir) throw new Error(`Missing arguments.\n\n${usage()}`);

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
	for (const hole of result.holes) {
		const color = CENTERLINE_COLORS[(hole.number - 1) % CENTERLINE_COLORS.length];
		circle(png, hole.c1Entry.xPx, hole.c1Entry.yPx, result.c1RadiusPx, CIRCLE_COLOR);
		circle(png, hole.c2Entry.xPx, hole.c2Entry.yPx, result.c2RadiusPx, CIRCLE_COLOR);
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
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
