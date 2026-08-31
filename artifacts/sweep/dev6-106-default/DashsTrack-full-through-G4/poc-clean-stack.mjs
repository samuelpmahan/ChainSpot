import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const require = createRequire(import.meta.url);
const runtimeRequire = createRequire(
	join(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES ?? '/opt/codex/runtimes/codex-primary-runtime/dependencies/node/node_modules', 'package.json')
);
const sharp = runtimeRequire('sharp');
const { extractComponents } = require('../../../../packages/alg/dist/detectors/threeFactor/components.js');
const { matchBasketSpritesSmart } = require('../../../../packages/alg/dist/detectors/threeFactor/smartBasket.js');
const basketTemplate = require('../../../../packages/alg/dist/detectors/threeFactor/assets/basket-sprite.json');

const runDir = dirname(fileURLToPath(import.meta.url));
const width = 1290;
const height = 2083;
const moat = 5;
const timings = {};
const totalStart = performance.now();

async function timed(name, fn) {
	const start = performance.now();
	const value = await fn();
	timings[name] = performance.now() - start;
	return value;
}

const cached = await timed('cacheLoadMs', async () => {
	const [rgba, brightBytes, darkBytes] = await Promise.all([
		readFile(join(runDir, 'artifacts', 'rgba', 'badgeStage.masks.localImage.bin')),
		readFile(join(runDir, 'artifacts', 'mask', 'badgeStage.masks.bright.bin')),
		readFile(join(runDir, 'artifacts', 'mask', 'badgeStage.masks.dark.bin'))
	]);
	return {
		rgba: new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength),
		bright: new Uint8Array(brightBytes.buffer, brightBytes.byteOffset, brightBytes.byteLength),
		dark: new Uint8Array(darkBytes.buffer, darkBytes.byteOffset, darkBytes.byteLength)
	};
});

const evidence = await timed('cachedEvidenceDerivationMs', async () => {
	const brightMask = { width, height, data: cached.bright };
	const darkMask = { width, height, data: cached.dark };
	const baskets = matchBasketSpritesSmart(brightMask, darkMask, [], basketTemplate);
	const brightStage = extractComponents(brightMask);
	const darkStage = extractComponents(darkMask);
	return { baskets, brightStage, darkStage };
});

function contains(outer, inner) {
	return (
		outer.bboxX <= inner.bboxX && outer.bboxY <= inner.bboxY &&
		outer.bboxX + outer.bboxW >= inner.bboxX + inner.bboxW &&
		outer.bboxY + outer.bboxH >= inner.bboxY + inner.bboxH
	);
}

function enclosingDark(body) {
	return evidence.darkStage.components
		.filter((component) => contains(component, body))
		.sort((a, b) => a.bboxW * a.bboxH - b.bboxW * b.bboxH || b.area - a.area || a.label - b.label)[0];
}

function shellMargins(shell, body) {
	return [
		body.bboxX - shell.bboxX,
		body.bboxY - shell.bboxY,
		shell.bboxX + shell.bboxW - (body.bboxX + body.bboxW),
		shell.bboxY + shell.bboxH - (body.bboxY + body.bboxH)
	];
}

const stack = await timed('alignmentAndStackMs', async () => {
	const brightByLabel = new Map(evidence.brightStage.components.map((component) => [component.label, component]));
	const rows = evidence.baskets.map((basket, index) => {
		const match = /^bright-component:(\d+)$/.exec(basket.source);
		const body = match ? brightByLabel.get(Number(match[1])) : undefined;
		const shell = body ? enclosingDark(body) : undefined;
		return { index, basket, body, shell, margins: body && shell ? shellMargins(shell, body) : undefined };
	});
	const marginCounts = new Map();
	for (const row of rows) {
		if (!row.margins) continue;
		const key = row.margins.join(',');
		marginCounts.set(key, (marginCounts.get(key) ?? 0) + 1);
	}
	const [modalKey, modalSupport] = [...marginCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
	const margins = modalKey.split(',').map(Number);
	const clean = rows.filter((row) => row.margins?.every((value, i) => value === margins[i]));
	if (clean.length !== 16) throw new Error(`expected 16 intact baskets, got ${clean.length}`);

	const [left, top, right, bottom] = margins;
	const cropWidth = basketTemplate.width + left + right + moat * 2;
	const cropHeight = basketTemplate.height + top + bottom + moat * 2;
	const crops = [];
	const brightVotes = new Uint16Array(cropWidth * cropHeight);
	const darkVotes = new Uint16Array(cropWidth * cropHeight);
	const sums = new Float64Array(cropWidth * cropHeight * 3);
	const samples = Array.from({ length: cropWidth * cropHeight * 3 }, () => []);

	for (const row of clean) {
		// The white body's exact inside edges are the registration pins.
		const originX = row.body.bboxX - left - moat;
		const originY = row.body.bboxY - top - moat;
		const pixels = new Uint8Array(cropWidth * cropHeight * 4);
		for (let y = 0; y < cropHeight; y++) {
			for (let x = 0; x < cropWidth; x++) {
				const local = y * cropWidth + x;
				const source = (originY + y) * width + originX + x;
				const sourceRgba = source * 4;
				const targetRgba = local * 4;
				for (let channel = 0; channel < 3; channel++) {
					const value = cached.rgba[sourceRgba + channel];
					pixels[targetRgba + channel] = value;
					sums[local * 3 + channel] += value;
					samples[local * 3 + channel].push(value);
				}
				pixels[targetRgba + 3] = 255;
				brightVotes[local] += cached.bright[source];
				darkVotes[local] += cached.dark[source];
			}
		}
		crops.push({ row, originX, originY, pixels });
	}

	const mean = new Uint8Array(cropWidth * cropHeight * 4);
	const median = new Uint8Array(cropWidth * cropHeight * 4);
	const family = new Uint8Array(cropWidth * cropHeight);
	let familyBright = 0;
	let familyDark = 0;
	for (let pixel = 0; pixel < cropWidth * cropHeight; pixel++) {
		for (let channel = 0; channel < 3; channel++) {
			const values = samples[pixel * 3 + channel].sort((a, b) => a - b);
			mean[pixel * 4 + channel] = Math.round(sums[pixel * 3 + channel] / clean.length);
			median[pixel * 4 + channel] = Math.round((values[7] + values[8]) / 2);
		}
		mean[pixel * 4 + 3] = 255;
		median[pixel * 4 + 3] = 255;
		const bright = brightVotes[pixel];
		const dark = darkVotes[pixel];
		const neither = clean.length - bright - dark;
		if (bright > dark && bright > neither) {
			family[pixel] = 1;
			familyBright++;
		} else if (dark > bright && dark > neither) {
			family[pixel] = 2;
			familyDark++;
		}
	}

	const outside = mean.slice();
	for (let pixel = 0; pixel < cropWidth * cropHeight; pixel++) {
		if (!family[pixel]) continue;
		const checker = ((pixel % cropWidth >> 1) + (Math.floor(pixel / cropWidth) >> 1)) % 2;
		const value = checker ? 32 : 46;
		outside[pixel * 4] = value;
		outside[pixel * 4 + 1] = value;
		outside[pixel * 4 + 2] = value;
		outside[pixel * 4 + 3] = 255;
	}

	return {
		clean,
		margins,
		modalSupport,
		cropWidth,
		cropHeight,
		crops,
		mean,
		median,
		outside,
		family,
		familyBright,
		familyDark,
		insideBox: [moat + left, moat + top, basketTemplate.width, basketTemplate.height]
	};
});

const outPng = join(runDir, 'renders', 'run', 'poc.clean-stack-plus-5.png');
const outJson = join(runDir, 'renders', 'run', 'poc.clean-stack-plus-5.receipt.json');
const outCrops = join(runDir, 'renders', 'run', 'poc.clean-stack-plus-5.crops.rgba.bin');
const outFamily = join(runDir, 'renders', 'run', 'poc.clean-stack-plus-5.family.bin');

await timed('renderMs', async () => {
	const thumbScale = 2;
	const aggregateScale = 8;
	const thumbW = stack.cropWidth * thumbScale;
	const thumbH = stack.cropHeight * thumbScale;
	const panelW = stack.cropWidth * aggregateScale;
	const panelH = stack.cropHeight * aggregateScale;
	const gap = 34;
	const topBand = 90;
	const gridW = thumbW * 4 + 18 * 3;
	const canvasW = 56 + gridW + gap + panelW * 3 + gap * 2 + 56;
	const canvasH = topBand + Math.max(thumbH * 4 + 18 * 3, panelH) + 120;

	const composites = [];
	for (let i = 0; i < stack.crops.length; i++) {
		const col = i % 4;
		const row = Math.floor(i / 4);
		const input = await sharp(stack.crops[i].pixels, { raw: { width: stack.cropWidth, height: stack.cropHeight, channels: 4 } })
			.resize({ width: thumbW, height: thumbH, kernel: 'nearest' })
			.png().toBuffer();
		composites.push({ input, left: 56 + col * (thumbW + 18), top: topBand + row * (thumbH + 18) });
	}

	const aggregateX = 56 + gridW + gap;
	for (const [index, buffer] of [stack.mean, stack.median, stack.outside].entries()) {
		const input = await sharp(buffer, { raw: { width: stack.cropWidth, height: stack.cropHeight, channels: 4 } })
			.resize({ width: panelW, height: panelH, kernel: 'nearest' })
			.png().toBuffer();
		composites.push({ input, left: aggregateX + index * (panelW + gap), top: topBand });
	}

	const [insideX, insideY, insideW, insideH] = stack.insideBox;
	const titles = ['MEAN — noise averages', 'MEDIAN — noise resists', 'MEAN WITH PURE B/W REMOVED'];
	const titleSvg = Buffer.from(`
		<svg width="${canvasW}" height="${canvasH}" xmlns="http://www.w3.org/2000/svg">
			<style>
				.title { font: 700 27px sans-serif; fill: #f8fafc; }
				.sub { font: 17px sans-serif; fill: #cbd5e1; }
				.panel { font: 700 18px sans-serif; fill: #f8fafc; }
				.mono { font: 16px monospace; fill: #a8b3c7; }
			</style>
			<text x="56" y="38" class="title">16 clean baskets + 5px — registered by exact inside edges</text>
			<text x="56" y="66" class="sub">Every crop pins the 42×66 bright-body bounds to the same coordinates. No truth, fitting, rotation, or scale normalization.</text>
			<text x="56" y="${topBand - 12}" class="panel">ALL 16 ALIGNED INPUTS</text>
			${titles.map((title, i) => `<text x="${aggregateX + i * (panelW + gap)}" y="${topBand - 12}" class="panel">${title}</text>`).join('')}
			${[0, 1, 2].map((i) => `<rect x="${aggregateX + i * (panelW + gap) + insideX * aggregateScale}" y="${topBand + insideY * aggregateScale}" width="${insideW * aggregateScale}" height="${insideH * aggregateScale}" fill="none" stroke="#00e5ff" stroke-width="3"/>`).join('')}
			<text x="${aggregateX}" y="${topBand + panelH + 36}" class="mono">cyan = exact shared registration box (inside white edges)</text>
			<text x="${aggregateX}" y="${topBand + panelH + 64}" class="mono">modal ownership = ${stack.familyBright} bright + ${stack.familyDark} dark px; crop ${stack.cropWidth}×${stack.cropHeight}</text>
			<text x="${aggregateX + 2 * (panelW + gap)}" y="${topBand + panelH + 36}" class="mono">checker = already-known pure B/W ownership</text>
			<text x="${aggregateX + 2 * (panelW + gap)}" y="${topBand + panelH + 64}" class="mono">remaining coherent shape is candidate missed basket signal</text>
		</svg>`);

	await sharp({ create: { width: canvasW, height: canvasH, channels: 4, background: { r: 15, g: 20, b: 30, alpha: 1 } } })
		.composite([...composites, { input: titleSvg, left: 0, top: 0 }])
		.png()
		.toFile(outPng);
});

timings.observedTotalMs = performance.now() - totalStart;
await Promise.all([
	writeFile(outCrops, Buffer.concat(stack.crops.map((crop) => Buffer.from(crop.pixels)))),
	writeFile(outFamily, stack.family)
]);
const receipt = {
	schema: 'chainspot-clean-stack-plus-5-poc@1',
	source: {
		canonicalRaster: 'badgeStage.masks.localImage',
		brightMask: 'badgeStage.masks.bright',
		darkMask: 'badgeStage.masks.dark',
		truthUsed: false
	},
	alignment: {
		cleanBaskets: stack.clean.length,
		registration: 'exact bright-body inside edges',
		insideBox: stack.insideBox,
		modalShellMargins: stack.margins,
		moatPx: moat,
		crop: [stack.cropWidth, stack.cropHeight]
	},
	evidence: {
		familyBrightPixels: stack.familyBright,
		familyDarkPixels: stack.familyDark,
		panels: ['all 16 raw aligned crops', 'per-pixel RGB mean', 'per-pixel RGB median', 'mean with modal pure B/W ownership removed']
	},
	timingsMs: Object.fromEntries(Object.entries(timings).map(([key, value]) => [key, Number(value.toFixed(3))])),
	outputs: { visualRender: outPng, alignedRgbaStack: outCrops, modalFamilyMask: outFamily }
};
await writeFile(outJson, `${JSON.stringify(receipt, null, 2)}\n`);
console.log(JSON.stringify(receipt, null, 2));
