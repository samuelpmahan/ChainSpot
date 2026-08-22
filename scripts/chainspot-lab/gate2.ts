import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

import { runBadgeStage } from '../../src/lib/nuthing/badgeStage';
import {
	matchBasketSpritesSmart,
	type SmartBasketTemplate
} from '../../src/lib/nuthing/smartBasket';
import { cropRows, detectMapViewport } from '../../src/lib/nuthing/viewport';
import { decodeImageFile } from '../nuthing/decode';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function setPixel(png: PNG, x: number, y: number, rgb: readonly [number, number, number]): void {
	if (x < 0 || y < 0 || x >= png.width || y >= png.height) return;
	const i = (y * png.width + x) * 4;
	png.data[i] = rgb[0];
	png.data[i + 1] = rgb[1];
	png.data[i + 2] = rgb[2];
	png.data[i + 3] = 255;
}

function rect(
	png: PNG,
	x: number,
	y: number,
	w: number,
	h: number,
	rgb: readonly [number, number, number]
): void {
	for (let xx = x; xx < x + w; xx++) {
		for (let t = 0; t < 3; t++) {
			setPixel(png, xx, y + t, rgb);
			setPixel(png, xx, y + h - 1 - t, rgb);
		}
	}
	for (let yy = y; yy < y + h; yy++) {
		for (let t = 0; t < 3; t++) {
			setPixel(png, x + t, yy, rgb);
			setPixel(png, x + w - 1 - t, yy, rgb);
		}
	}
}

function cross(png: PNG, x: number, y: number, rgb: readonly [number, number, number]): void {
	for (let d = -5; d <= 5; d++) {
		setPixel(png, x + d, y, rgb);
		setPixel(png, x, y + d, rgb);
	}
}

function main(): void {
	const [inputPath, outDirArg] = process.argv.slice(2);
	if (!inputPath || !outDirArg) {
		console.error('Usage: npx tsx scripts/chainspot-lab/gate2.ts IMAGE OUT_DIR');
		process.exit(2);
	}

	const outDir = resolve(outDirArg);
	mkdirSync(outDir, { recursive: true });

	const full = decodeImageFile(resolve(inputPath));
	const viewport = detectMapViewport(full);
	const image = cropRows(full, viewport);
	const stage = runBadgeStage(image);
	const template = JSON.parse(
		readFileSync(join(repoRoot, 'resources/nuthing-p2/endpoints/basket-sprite.json'), 'utf8')
	) as SmartBasketTemplate;

	const baskets = matchBasketSpritesSmart(stage.brightMask, stage.darkMask, stage.badges, template);

	const clean = baskets.filter((b) => b.tier === 'clean-family');
	const recovered = baskets.filter((b) => b.tier === 'occlusion-recovery');
	const high = baskets.filter((b) => b.confidence === 'high');
	const medium = baskets.filter((b) => b.confidence === 'medium');

	console.log(
		`Gate 0 canonical: ${full.width}x${full.height} -> ${image.width}x${image.height}; rows [${viewport.top},${viewport.bottom})`
	);
	console.log(`Gate 1 badge plates: ${stage.badgeCount}`);
	console.log(
		`Gate 2 basket objects: ${baskets.length} = ${clean.length} clean + ${recovered.length} recovered`
	);
	console.log(
		`confidence: ${high.length} high, ${medium.length} medium, ${baskets.length - high.length - medium.length} low`
	);
	console.log('');
	console.log('BASKET TESTIMONY');
	baskets
		.slice()
		.sort((a, b) => a.cy - b.cy || a.cx - b.cx)
		.forEach((b, i) => {
			console.log(
				`${String(i + 1).padStart(2, '0')} ${b.tier.padEnd(18)} ${b.confidence.padEnd(6)} ` +
					`tip=(${b.tipX.toFixed(1)},${b.tipY.toFixed(1)}) ` +
					`identity=${b.identity.toFixed(3)} visible=${b.effectiveVisibility.toFixed(3)} ` +
					`white=${b.whiteCoverage.toFixed(3)} black=${b.blackBorderSupport.toFixed(3)} ` +
					`source=${b.source}`
			);
		});

	const png = new PNG({ width: image.width, height: image.height });
	Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength).copy(png.data);
	for (const b of baskets) {
		const color: readonly [number, number, number] =
			b.tier === 'clean-family'
				? [45, 225, 80]
				: b.confidence === 'high'
					? [35, 215, 235]
					: [255, 190, 40];
		rect(png, Math.round(b.x), Math.round(b.y), b.bboxW, b.bboxH, color);
		cross(png, Math.round(b.tipX), Math.round(b.tipY), color);
	}
	const overlayPath = join(outDir, 'gate2-baskets.png');
	writeFileSync(overlayPath, PNG.sync.write(png));

	const evidencePath = join(outDir, 'gate2-baskets.json');
	writeFileSync(
		evidencePath,
		JSON.stringify(
			{
				schemaVersion: 1,
				input: resolve(inputPath),
				canonical: {
					width: image.width,
					height: image.height,
					rows: [viewport.top, viewport.bottom]
				},
				badgeCount: stage.badgeCount,
				counts: {
					total: baskets.length,
					clean: clean.length,
					recovered: recovered.length,
					high: high.length,
					medium: medium.length
				},
				baskets
			},
			null,
			2
		)
	);
	console.log(`overlay -> ${overlayPath}`);
	console.log(`evidence -> ${evidencePath}`);
}

main();
