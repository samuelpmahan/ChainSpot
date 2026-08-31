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
const maskDir = join(runDir, 'artifacts', 'mask');
const rgbaDir = join(runDir, 'artifacts', 'rgba');
const outPng = join(runDir, 'renders', 'run', 'poc.red-v-blue.png');
const outJson = join(runDir, 'renders', 'run', 'poc.red-v-blue.receipt.json');
const marks = {};
const totalStart = performance.now();

async function timed(name, fn) {
	const start = performance.now();
	const value = await fn();
	marks[name] = performance.now() - start;
	return value;
}

const cached = await timed('cacheLoadMs', async () => {
	const [rgba, brightBytes, darkBytes] = await Promise.all([
		readFile(join(rgbaDir, 'badgeStage.masks.localImage.bin')),
		readFile(join(maskDir, 'badgeStage.masks.bright.bin')),
		readFile(join(maskDir, 'badgeStage.masks.dark.bin'))
	]);
	if (rgba.byteLength !== width * height * 4) throw new Error('cached RGBA dimensions do not match receipt');
	if (brightBytes.byteLength !== width * height || darkBytes.byteLength !== width * height)
		throw new Error('cached mask dimensions do not match receipt');
	return {
		rgba,
		bright: new Uint8Array(brightBytes.buffer, brightBytes.byteOffset, brightBytes.byteLength),
		dark: new Uint8Array(darkBytes.buffer, darkBytes.byteOffset, darkBytes.byteLength)
	};
});

const derived = await timed('cachedEvidenceDerivationMs', async () => {
	const brightMask = { width, height, data: cached.bright };
	const darkMask = { width, height, data: cached.dark };
	const decisions = [];
	const baskets = matchBasketSpritesSmart(brightMask, darkMask, [], basketTemplate, {}, decisions);
	const brightStage = extractComponents(brightMask);
	const darkStage = extractComponents(darkMask);
	return { baskets, decisions, brightStage, darkStage };
});

function contains(outer, inner) {
	return (
		outer.bboxX <= inner.bboxX &&
		outer.bboxY <= inner.bboxY &&
		outer.bboxX + outer.bboxW >= inner.bboxX + inner.bboxW &&
		outer.bboxY + outer.bboxH >= inner.bboxY + inner.bboxH
	);
}

function enclosingDark(body) {
	return derived.darkStage.components
		.filter((component) => contains(component, body))
		.sort(
			(a, b) =>
				a.bboxW * a.bboxH - b.bboxW * b.bboxH ||
				b.area - a.area ||
				a.label - b.label
		)[0];
}

function margins(shell, body) {
	return [
		body.bboxX - shell.bboxX,
		body.bboxY - shell.bboxY,
		shell.bboxX + shell.bboxW - (body.bboxX + body.bboxW),
		shell.bboxY + shell.bboxH - (body.bboxY + body.bboxH)
	];
}

const attribution = await timed('familyAndAttributionMs', async () => {
	const brightByLabel = new Map(derived.brightStage.components.map((component) => [component.label, component]));
	const basketRows = derived.baskets.map((basket, index) => {
		const match = /^bright-component:(\d+)$/.exec(basket.source);
		const body = match ? brightByLabel.get(Number(match[1])) : undefined;
		const shell = body ? enclosingDark(body) : undefined;
		return { index, basket, body, shell, shellMargins: body && shell ? margins(shell, body) : undefined };
	});

	const marginCounts = new Map();
	for (const row of basketRows) {
		if (!row.shellMargins) continue;
		const key = row.shellMargins.join(',');
		marginCounts.set(key, (marginCounts.get(key) ?? 0) + 1);
	}
	const [modalKey, modalCount] = [...marginCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
	const modalMargins = modalKey.split(',').map(Number);
	const clean = basketRows.filter((row) => row.shellMargins?.every((value, i) => value === modalMargins[i]));
	const failed = basketRows.filter((row) => !clean.includes(row));
	if (clean.length !== 16 || failed.length !== 2)
		throw new Error(`expected 16 clean + 2 overlap baskets, got ${clean.length} + ${failed.length}`);

	const withFusedShell = failed.find((row) => row.shell);
	const recovered = failed.find((row) => !row.shell);
	if (!withFusedShell || !recovered) throw new Error('expected one fused-shell basket and one recovered basket');
	const fusedLabel = withFusedShell.shell.label;
	const fusedComponent = derived.darkStage.components.find((component) => component.label === fusedLabel);
	if (!fusedComponent) throw new Error(`fused dark component ${fusedLabel} disappeared`);

	const [left, top, right, bottom] = modalMargins;
	const familyWidth = basketTemplate.width + left + right;
	const familyHeight = basketTemplate.height + top + bottom;
	const brightVotes = new Uint16Array(familyWidth * familyHeight);
	const darkVotes = new Uint16Array(familyWidth * familyHeight);
	for (const row of clean) {
		const originX = row.body.bboxX - left;
		const originY = row.body.bboxY - top;
		for (let y = 0; y < familyHeight; y++) {
			for (let x = 0; x < familyWidth; x++) {
				const local = y * familyWidth + x;
				const source = (originY + y) * width + originX + x;
				brightVotes[local] += cached.bright[source];
				darkVotes[local] += cached.dark[source];
			}
		}
	}

	const family = new Uint8Array(familyWidth * familyHeight);
	let familyBrightPixels = 0;
	let familyDarkPixels = 0;
	let familyUnknownPixels = 0;
	for (let i = 0; i < family.length; i++) {
		const bright = brightVotes[i];
		const dark = darkVotes[i];
		const neither = clean.length - bright - dark;
		if (bright > dark && bright > neither) {
			family[i] = 1;
			familyBrightPixels++;
		} else if (dark > bright && dark > neither) {
			family[i] = 2;
			familyDarkPixels++;
		} else {
			familyUnknownPixels++;
		}
	}

	const blue = { ...withFusedShell, name: 'blue', originX: withFusedShell.basket.x - left, originY: withFusedShell.basket.y - top };
	const red = { ...recovered, name: 'red', originX: recovered.basket.x - left, originY: recovered.basket.y - top };
	const claim = (owner, x, y) => {
		const fx = x - owner.originX;
		const fy = y - owner.originY;
		if (fx < 0 || fy < 0 || fx >= familyWidth || fy >= familyHeight) return 0;
		return family[fy * familyWidth + fx];
	};

	const fusedPixels = [];
	const mergePixels = [];
	let darkBlue = 0;
	let darkRed = 0;
	let darkShared = 0;
	let darkResidual = 0;
	for (let y = fusedComponent.bboxY; y < fusedComponent.bboxY + fusedComponent.bboxH; y++) {
		for (let x = fusedComponent.bboxX; x < fusedComponent.bboxX + fusedComponent.bboxW; x++) {
			const index = y * width + x;
			if (derived.darkStage.labels[index] !== fusedLabel) continue;
			const blueClaim = claim(blue, x, y) === 2;
			const redClaim = claim(red, x, y) === 2;
			const owner = blueClaim && redClaim ? 3 : blueClaim ? 1 : redClaim ? 2 : 4;
			if (owner === 1) darkBlue++;
			else if (owner === 2) darkRed++;
			else if (owner === 3) darkShared++;
			else darkResidual++;
			fusedPixels.push({ x, y, owner });
			if (owner === 3) mergePixels.push({ x, y });
		}
	}

	const whitePixels = [];
	for (const owner of [blue, red]) {
		for (let y = owner.originY; y < owner.originY + familyHeight; y++) {
			for (let x = owner.originX; x < owner.originX + familyWidth; x++) {
				if (claim(owner, x, y) !== 1) continue;
				whitePixels.push({ x, y, owner: owner.name });
			}
		}
	}

	return {
		modalMargins,
		modalCount,
		clean,
		failed,
		familyWidth,
		familyHeight,
		familyBrightPixels,
		familyDarkPixels,
		familyUnknownPixels,
		blue,
		red,
		fusedComponent,
		fusedPixels,
		whitePixels,
		mergePixels,
		darkBlue,
		darkRed,
		darkShared,
		darkResidual
	};
});

const overlay = Buffer.alloc(width * height * 4);
function colorPixel(x, y, rgba) {
	if (x < 0 || y < 0 || x >= width || y >= height) return;
	const p = (y * width + x) * 4;
	overlay[p] = rgba[0];
	overlay[p + 1] = rgba[1];
	overlay[p + 2] = rgba[2];
	overlay[p + 3] = rgba[3];
}

const COLORS = {
	blueDark: [0, 86, 255, 245],
	blueLight: [65, 190, 255, 225],
	redDark: [235, 38, 38, 245],
	redLight: [255, 118, 118, 225],
	shared: [183, 62, 255, 255],
	residual: [255, 210, 0, 255]
};
for (const pixel of attribution.whitePixels)
	colorPixel(pixel.x, pixel.y, pixel.owner === 'blue' ? COLORS.blueLight : COLORS.redLight);
for (const pixel of attribution.fusedPixels) {
	const color = pixel.owner === 1 ? COLORS.blueDark : pixel.owner === 2 ? COLORS.redDark : pixel.owner === 3 ? COLORS.shared : COLORS.residual;
	colorPixel(pixel.x, pixel.y, color);
}

await timed('renderMs', async () => {
	const focusPad = 10;
	const x0 = Math.max(0, Math.min(attribution.blue.originX, attribution.red.originX) - focusPad);
	const y0 = Math.max(0, Math.min(attribution.blue.originY, attribution.red.originY) - focusPad);
	const x1 = Math.min(width, Math.max(attribution.blue.originX, attribution.red.originX) + attribution.familyWidth + focusPad);
	const y1 = Math.min(height, Math.max(attribution.blue.originY, attribution.red.originY) + attribution.familyHeight + focusPad);
	const focusW = x1 - x0;
	const focusH = y1 - y0;
	const zoomScale = 7;
	const zoomW = focusW * zoomScale;
	const zoomH = focusH * zoomScale;
	const panelWidth = Math.max(820, zoomW + 80);
	const canvasWidth = width + panelWidth;
	const canvasHeight = Math.max(height, zoomH + 520);

	const annotated = await sharp(cached.rgba, { raw: { width, height, channels: 4 } })
		.composite([{ input: overlay, raw: { width, height, channels: 4 }, blend: 'over' }])
		.png()
		.toBuffer();
	const zoom = await sharp(annotated)
		.extract({ left: x0, top: y0, width: focusW, height: focusH })
		.resize({ width: zoomW, height: zoomH, kernel: 'nearest' })
		.png()
		.toBuffer();

	const textX = width + 34;
	const zoomX = width + Math.round((panelWidth - zoomW) / 2);
	const zoomY = 145;
	const mergeBounds = attribution.mergePixels.length
		? {
			x: Math.min(...attribution.mergePixels.map((p) => p.x)),
			y: Math.min(...attribution.mergePixels.map((p) => p.y)),
			w: Math.max(...attribution.mergePixels.map((p) => p.x)) - Math.min(...attribution.mergePixels.map((p) => p.x)) + 1,
			h: Math.max(...attribution.mergePixels.map((p) => p.y)) - Math.min(...attribution.mergePixels.map((p) => p.y)) + 1
		}
		: { x: x0, y: y0, w: 1, h: 1 };
	const mergeZoomX = zoomX + (mergeBounds.x - x0) * zoomScale;
	const mergeZoomY = zoomY + (mergeBounds.y - y0) * zoomScale;
	const mergeZoomW = Math.max(zoomScale, mergeBounds.w * zoomScale);
	const mergeZoomH = Math.max(zoomScale, mergeBounds.h * zoomScale);
	const escape = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
	const svg = Buffer.from(`
		<svg width="${canvasWidth}" height="${canvasHeight}" xmlns="http://www.w3.org/2000/svg">
			<style>
				.title { font: 700 29px sans-serif; fill: #f8fafc; }
				.sub { font: 17px sans-serif; fill: #cbd5e1; }
				.body { font: 18px sans-serif; fill: #e2e8f0; }
				.mono { font: 16px monospace; fill: #cbd5e1; }
				.small { font: 14px sans-serif; fill: #94a3b8; }
			</style>
			<rect x="${x0 - 2}" y="${y0 - 2}" width="${focusW + 4}" height="${focusH + 4}" fill="none" stroke="#ff4fd8" stroke-width="3"/>
			<text x="${textX}" y="46" class="title">Red v Blue: fused basket custody</text>
			<text x="${textX}" y="78" class="sub">Truth-blind · cached raster + masks · nearest thing to “show your work”</text>
			<text x="${textX}" y="108" class="mono">blue anchor (${attribution.blue.basket.x},${attribution.blue.basket.y})  red anchor (${attribution.red.basket.x},${attribution.red.basket.y})</text>
			<rect x="${mergeZoomX - 5}" y="${mergeZoomY - 5}" width="${mergeZoomW + 10}" height="${mergeZoomH + 10}" fill="none" stroke="#ff4fd8" stroke-width="4"/>
			<text x="${mergeZoomX}" y="${Math.max(zoomY + 24, mergeZoomY - 12)}" class="body" fill="#ff8be6">shared template support / merge</text>
			<circle cx="${textX + 8}" cy="${zoomY + zoomH + 48}" r="8" fill="#0056ff"/><text x="${textX + 28}" y="${zoomY + zoomH + 54}" class="body">blue: upper detected basket</text>
			<circle cx="${textX + 8}" cy="${zoomY + zoomH + 80}" r="8" fill="#eb2626"/><text x="${textX + 28}" y="${zoomY + zoomH + 86}" class="body">red: recovered lower basket</text>
			<circle cx="${textX + 8}" cy="${zoomY + zoomH + 112}" r="8" fill="#b73eff"/><text x="${textX + 28}" y="${zoomY + zoomH + 118}" class="body">purple: both templates claim this observed dark pixel</text>
			<circle cx="${textX + 8}" cy="${zoomY + zoomH + 144}" r="8" fill="#ffd200"/><text x="${textX + 28}" y="${zoomY + zoomH + 150}" class="body">yellow: fused dark CC unexplained by either hard template</text>
			<text x="${textX}" y="${zoomY + zoomH + 195}" class="mono">family: ${attribution.clean.length} clean baskets → ${attribution.familyWidth}×${attribution.familyHeight}; margins [${attribution.modalMargins.join(',')}]</text>
			<text x="${textX}" y="${zoomY + zoomH + 224}" class="mono">hard template: ${attribution.familyBrightPixels} bright + ${attribution.familyDarkPixels} dark px</text>
			<text x="${textX}" y="${zoomY + zoomH + 253}" class="mono">fused dark CC #${attribution.fusedComponent.label}: ${attribution.fusedComponent.area} observed px</text>
			<text x="${textX}" y="${zoomY + zoomH + 282}" class="mono">mapped: ${attribution.darkBlue} blue + ${attribution.darkRed} red + ${attribution.darkShared} shared; residue ${attribution.darkResidual}</text>
			<text x="${textX}" y="${zoomY + zoomH + 326}" class="small">Light shades = family bright pixels. Deep shades = observed dark pixels.</text>
			<text x="${textX}" y="${zoomY + zoomH + 350}" class="small">The hard family is categorical mode per aligned pixel; ties remain unknown.</text>
			<text x="${textX}" y="${zoomY + zoomH + 374}" class="small">No annotation truth or hole numbers participated.</text>
		</svg>`);

	await sharp({
		create: { width: canvasWidth, height: canvasHeight, channels: 4, background: { r: 15, g: 20, b: 30, alpha: 1 } }
	})
		.composite([
			{ input: annotated, left: 0, top: 0 },
			{ input: zoom, left: zoomX, top: zoomY },
			{ input: svg, left: 0, top: 0 }
		])
		.png()
		.toFile(outPng);
});

marks.observedTotalMs = performance.now() - totalStart;
const receipt = {
	schema: 'chainspot-red-v-blue-poc@1',
	source: {
		runDir,
		canonicalRaster: 'badgeStage.masks.localImage',
		brightMask: 'badgeStage.masks.bright',
		darkMask: 'badgeStage.masks.dark',
		truthUsed: false
	},
	detection: {
		acceptedBaskets: derived.baskets.length,
		cleanFamilyMembers: attribution.clean.length,
		overlapMembers: attribution.failed.length,
		modalShellMargins: attribution.modalMargins,
		modalShellSupport: attribution.modalCount,
		blue: { x: attribution.blue.basket.x, y: attribution.blue.basket.y, source: attribution.blue.basket.source },
		red: { x: attribution.red.basket.x, y: attribution.red.basket.y, source: attribution.red.basket.source }
	},
	evidence: {
		familyCanvas: [attribution.familyWidth, attribution.familyHeight],
		familyBrightPixels: attribution.familyBrightPixels,
		familyDarkPixels: attribution.familyDarkPixels,
		familyUnknownPixels: attribution.familyUnknownPixels,
		fusedDarkComponent: {
			label: attribution.fusedComponent.label,
			bbox: [attribution.fusedComponent.bboxX, attribution.fusedComponent.bboxY, attribution.fusedComponent.bboxW, attribution.fusedComponent.bboxH],
			area: attribution.fusedComponent.area
		},
		mapping: {
			blueDarkPixels: attribution.darkBlue,
			redDarkPixels: attribution.darkRed,
			sharedDarkPixels: attribution.darkShared,
			unexplainedDarkPixels: attribution.darkResidual
		}
	},
	visualContract: {
		blueLight: 'upper basket family-bright support',
		blueDark: 'observed fused-dark pixels claimed only by upper basket family',
		redLight: 'lower basket family-bright support',
		redDark: 'observed fused-dark pixels claimed only by lower basket family',
		purple: 'observed fused-dark pixels claimed by both aligned family templates',
		yellow: 'observed fused-dark pixels claimed by neither aligned hard template'
	},
	timingsMs: Object.fromEntries(Object.entries(marks).map(([key, value]) => [key, Number(value.toFixed(3))])),
	outputs: { visualRender: outPng }
};
await writeFile(outJson, `${JSON.stringify(receipt, null, 2)}\n`);
console.log(JSON.stringify(receipt, null, 2));
