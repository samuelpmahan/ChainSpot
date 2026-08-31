import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const require = createRequire(import.meta.url);
const runtimeRequire = createRequire(
	join(
		process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES ??
			'/opt/codex/runtimes/codex-primary-runtime/dependencies/node/node_modules',
		'package.json'
	)
);
const sharp = runtimeRequire('sharp');
const { extractComponents } = require('../../../../packages/alg/dist/detectors/threeFactor/components.js');
const { matchBasketSpritesSmart } = require('../../../../packages/alg/dist/detectors/threeFactor/smartBasket.js');
const basketTemplate = require('../../../../packages/alg/dist/detectors/threeFactor/assets/basket-sprite.json');

const runDir = dirname(fileURLToPath(import.meta.url));
const renderDir = join(runDir, 'renders', 'run');
const width = 1290;
const height = 2083;

// C1S is centered on the semantic pole tip at radius ~44px. The historical
// backwalk begins at r=35, immediately before the measured 44+-8 ring band.
// This PoC keeps only the translucent C1 interior: r=4..35.
const c1InnerMinPx = 4;
const c1InnerMaxPx = 35;
const angleStepDeg = 2;
const microFanDeg = [-2, -1, 0, 1, 2];
const familyWidth = 56;
const familyHeight = 82;
const familyMoatPx = 5;

const cropWidth = 100;
const cropHeight = 126;
const cropLeftOfTip = 50;
const cropAboveTip = 76;
const viewWidth = 124;
const viewHeight = 156;
const panelWidth = 438;
const panelHeight = 338;
const panelGap = 10;
const columns = 4;
const headerHeight = 248;
const outerMargin = 36;

const timings = {};
const totalStart = performance.now();

async function timed(name, fn) {
	const start = performance.now();
	const value = await fn();
	timings[name] = performance.now() - start;
	return value;
}

function esc(value) {
	return String(value).replace(/[&<>\"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);
}

function contains(outer, inner) {
	return (
		outer.bboxX <= inner.bboxX &&
		outer.bboxY <= inner.bboxY &&
		outer.bboxX + outer.bboxW >= inner.bboxX + inner.bboxW &&
		outer.bboxY + outer.bboxH >= inner.bboxY + inner.bboxH
	);
}

function enclosingDark(darkComponents, body) {
	return darkComponents
		.filter((component) => contains(component, body))
		.sort(
			(a, b) =>
				a.bboxW * a.bboxH - b.bboxW * b.bboxH ||
				b.area - a.area ||
				a.label - b.label
		)[0];
}

function shellMargins(shell, body) {
	return [
		body.bboxX - shell.bboxX,
		body.bboxY - shell.bboxY,
		shell.bboxX + shell.bboxW - (body.bboxX + body.bboxW),
		shell.bboxY + shell.bboxH - (body.bboxY + body.bboxH)
	];
}

function grayAt(rgba, index) {
	const p = index * 4;
	return (rgba[p] + rgba[p + 1] + rgba[p + 2]) / 3;
}

function blend(data, pixel, rgb, alpha) {
	const p = pixel * 4;
	for (let channel = 0; channel < 3; channel++) {
		data[p + channel] = Math.round(data[p + channel] * (1 - alpha) + rgb[channel] * alpha);
	}
	data[p + 3] = 255;
}

function historicalRectangleOwns(row, x, y) {
	// Exact legacy predicate from D11: 42x66 sprite bbox plus a uniform 2px
	// margin, with inclusive raster bounds.
	return (
		x >= row.basket.cx - basketTemplate.width / 2 - 2 &&
		x <= row.basket.cx + basketTemplate.width / 2 + 2 &&
		y >= row.basket.cy - basketTemplate.height / 2 - 2 &&
		y <= row.basket.cy + basketTemplate.height / 2 + 2
	);
}

function exactFamilyOwns(row, x, y, family) {
	const originX = row.body.bboxX - row.margins[0] - familyMoatPx;
	const originY = row.body.bboxY - row.margins[1] - familyMoatPx;
	const localX = x - originX;
	const localY = y - originY;
	if (localX < 0 || localX >= familyWidth || localY < 0 || localY >= familyHeight) return false;
	return family[localY * familyWidth + localX] !== 0;
}

function c1Contains(row, x, y) {
	const distance = Math.hypot(x - row.basket.tipX, y - row.basket.tipY);
	return distance >= c1InnerMinPx && distance <= c1InnerMaxPx;
}

function sampleProfile(row, rgba, family, mode) {
	const values = [];
	const visibleCounts = [];
	for (let bearingDeg = 0; bearingDeg < 360; bearingDeg += angleStepDeg) {
		const samples = new Set();
		for (const fanDeg of microFanDeg) {
			const angle = ((bearingDeg + fanDeg) * Math.PI) / 180;
			for (let radius = c1InnerMinPx; radius <= c1InnerMaxPx; radius++) {
				// Image-bearing convention: 0deg is image north, clockwise positive.
				const x = Math.round(row.basket.tipX + Math.sin(angle) * radius);
				const y = Math.round(row.basket.tipY - Math.cos(angle) * radius);
				if (x < 0 || x >= width || y < 0 || y >= height) continue;
				samples.add(y * width + x);
			}
		}
		let sum = 0;
		let count = 0;
		for (const index of samples) {
			const x = index % width;
			const y = Math.floor(index / width);
			const blocked =
				mode === 'raw'
					? false
					: mode === 'rectangle'
						? historicalRectangleOwns(row, x, y)
						: exactFamilyOwns(row, x, y, family);
			if (blocked) continue;
			sum += grayAt(rgba, index);
			count++;
		}
		values.push(count ? sum / count : null);
		visibleCounts.push(count);
	}
	return { values, visibleCounts };
}

function profilePath(values, x, y, w, h) {
	let path = '';
	let open = false;
	for (let i = 0; i < values.length; i++) {
		const value = values[i];
		if (value === null) {
			open = false;
			continue;
		}
		const px = x + (i / (values.length - 1)) * w;
		const py = y + h - (value / 255) * h;
		path += `${open ? ' L' : ' M'} ${px.toFixed(1)} ${py.toFixed(1)}`;
		open = true;
	}
	return path;
}

function mean(values) {
	return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function median(values) {
	if (!values.length) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

const cached = await timed('cacheLoadMs', async () => {
	const [rgbaBytes, brightBytes, darkBytes, familyBytes] = await Promise.all([
		readFile(join(runDir, 'artifacts', 'rgba', 'badgeStage.masks.localImage.bin')),
		readFile(join(runDir, 'artifacts', 'mask', 'badgeStage.masks.bright.bin')),
		readFile(join(runDir, 'artifacts', 'mask', 'badgeStage.masks.dark.bin')),
		readFile(join(renderDir, 'poc.clean-stack-plus-5.family.bin'))
	]);
	return {
		rgba: new Uint8Array(rgbaBytes.buffer, rgbaBytes.byteOffset, rgbaBytes.byteLength),
		bright: new Uint8Array(brightBytes.buffer, brightBytes.byteOffset, brightBytes.byteLength),
		dark: new Uint8Array(darkBytes.buffer, darkBytes.byteOffset, darkBytes.byteLength),
		family: new Uint8Array(familyBytes.buffer, familyBytes.byteOffset, familyBytes.byteLength)
	};
});

if (cached.family.length !== familyWidth * familyHeight) {
	throw new Error(`expected ${familyWidth}x${familyHeight} merged family cache, got ${cached.family.length} bytes`);
}
const exactFamilyPixels = cached.family.reduce((count, value) => count + (value ? 1 : 0), 0);
if (exactFamilyPixels !== 2145) throw new Error(`expected 2,145 merged B/W pixels, got ${exactFamilyPixels}`);

const evidence = await timed('objectAcquisitionMs', async () => {
	const brightStage = extractComponents({ width, height, data: cached.bright });
	const darkStage = extractComponents({ width, height, data: cached.dark });
	const baskets = matchBasketSpritesSmart(
		{ width, height, data: cached.bright },
		{ width, height, data: cached.dark },
		[],
		basketTemplate
	);
	const brightByLabel = new Map(brightStage.components.map((component) => [component.label, component]));
	const rows = baskets.map((basket, index) => {
		const match = /^bright-component:(\d+)$/.exec(basket.source);
		const body = match ? brightByLabel.get(Number(match[1])) : undefined;
		const shell = body ? enclosingDark(darkStage.components, body) : undefined;
		return {
			index,
			basket,
			body,
			shell,
			margins: body && shell ? shellMargins(shell, body) : undefined
		};
	});
	const marginCounts = new Map();
	for (const row of rows) {
		if (!row.margins) continue;
		const key = row.margins.join(',');
		marginCounts.set(key, (marginCounts.get(key) ?? 0) + 1);
	}
	const [modalKey, modalSupport] = [...marginCounts.entries()].sort(
		(a, b) => b[1] - a[1] || a[0].localeCompare(b[0])
	)[0];
	const clean = rows.filter((row) => row.margins?.join(',') === modalKey);
	if (clean.length !== 16) throw new Error(`expected 16 clean baskets, got ${clean.length}`);
	return {
		clean,
		modalMargins: modalKey.split(',').map(Number),
		modalSupport,
		brightLabels: brightStage.labels,
		darkLabels: darkStage.labels
	};
});

const study = await timed('c1MeasurementMs', async () => {
	return evidence.clean.map((row, cleanIndex) => {
		const disk = {
			totalPixels: 0,
			rectangleBlockedPixels: 0,
			exactBlockedPixels: 0,
			recoveredPixels: 0,
			exactOutsideRectanglePixels: 0
		};
		const xmin = Math.floor(row.basket.tipX - c1InnerMaxPx);
		const xmax = Math.ceil(row.basket.tipX + c1InnerMaxPx);
		const ymin = Math.floor(row.basket.tipY - c1InnerMaxPx);
		const ymax = Math.ceil(row.basket.tipY + c1InnerMaxPx);
		for (let y = ymin; y <= ymax; y++) {
			for (let x = xmin; x <= xmax; x++) {
				if (x < 0 || x >= width || y < 0 || y >= height || !c1Contains(row, x, y)) continue;
				const index = y * width + x;
				const rectangle = historicalRectangleOwns(row, x, y);
				const exact = exactFamilyOwns(row, x, y, cached.family);
				disk.totalPixels++;
				if (rectangle) disk.rectangleBlockedPixels++;
				if (exact) disk.exactBlockedPixels++;
				if (rectangle && !exact) disk.recoveredPixels++;
				if (exact && !rectangle) disk.exactOutsideRectanglePixels++;
			}
		}

		const raw = sampleProfile(row, cached.rgba, cached.family, 'raw');
		const rectangle = sampleProfile(row, cached.rgba, cached.family, 'rectangle');
		const exact = sampleProfile(row, cached.rgba, cached.family, 'exact');
		return {
			cleanIndex,
			row,
			disk,
			profiles: { raw, rectangle, exact },
			exactObjectPixels: exactFamilyPixels
		};
	});
});

function cropBase(row) {
	const originX = Math.round(row.basket.tipX - cropLeftOfTip);
	const originY = Math.round(row.basket.tipY - cropAboveTip);
	const data = new Uint8Array(cropWidth * cropHeight * 4);
	for (let y = 0; y < cropHeight; y++) {
		for (let x = 0; x < cropWidth; x++) {
			const sourceX = originX + x;
			const sourceY = originY + y;
			const target = (y * cropWidth + x) * 4;
			if (sourceX < 0 || sourceX >= width || sourceY < 0 || sourceY >= height) {
				data[target + 3] = 255;
				continue;
			}
			const source = (sourceY * width + sourceX) * 4;
			data.set(cached.rgba.subarray(source, source + 4), target);
		}
	}
	return { data, originX, originY };
}

async function renderView(item, mode) {
	const { data: base, originX, originY } = cropBase(item.row);
	const data = base.slice();
	for (let y = 0; y < cropHeight; y++) {
		for (let x = 0; x < cropWidth; x++) {
			const globalX = originX + x;
			const globalY = originY + y;
			if (!c1Contains(item.row, globalX, globalY)) continue;
			const local = y * cropWidth + x;
			const rectangle = historicalRectangleOwns(item.row, globalX, globalY);
			const exact = exactFamilyOwns(item.row, globalX, globalY, cached.family);
			if (mode === 'rectangle' && rectangle) blend(data, local, [235, 55, 70], 0.78);
			if (mode === 'exact') {
				if (exact) blend(data, local, [30, 120, 255], 0.82);
				else if (rectangle) blend(data, local, [255, 210, 40], 0.46);
			}
		}
	}
	const scaleX = viewWidth / cropWidth;
	const scaleY = viewHeight / cropHeight;
	const tipX = cropLeftOfTip * scaleX;
	const tipY = cropAboveTip * scaleY;
	const radiusX = c1InnerMaxPx * scaleX;
	const radiusY = c1InnerMaxPx * scaleY;
	const circle = Buffer.from(`
		<svg width="${viewWidth}" height="${viewHeight}" xmlns="http://www.w3.org/2000/svg">
			<ellipse cx="${tipX}" cy="${tipY}" rx="${radiusX}" ry="${radiusY}" fill="none" stroke="#3ee6c1" stroke-width="2"/>
			<circle cx="${tipX}" cy="${tipY}" r="2.5" fill="#f8fafc" stroke="#111827" stroke-width="1"/>
		</svg>`);
	return sharp(data, { raw: { width: cropWidth, height: cropHeight, channels: 4 } })
		.resize({ width: viewWidth, height: viewHeight, kernel: 'nearest' })
		.composite([{ input: circle, left: 0, top: 0 }])
		.png()
		.toBuffer();
}

const outPng = join(renderDir, 'poc.c1-clean-control.png');
const outJson = join(renderDir, 'poc.c1-clean-control.receipt.json');
await mkdir(renderDir, { recursive: true });

await timed('renderMs', async () => {
	const rows = Math.ceil(study.length / columns);
	const canvasWidth = outerMargin * 2 + columns * panelWidth + (columns - 1) * panelGap;
	const canvasHeight = headerHeight + rows * panelHeight + (rows - 1) * panelGap + outerMargin;
	const composites = [];
	let panelsSvg = '';

	for (const item of study) {
		const col = item.cleanIndex % columns;
		const rowIndex = Math.floor(item.cleanIndex / columns);
		const left = outerMargin + col * (panelWidth + panelGap);
		const top = headerHeight + rowIndex * (panelHeight + panelGap);
		const [rawView, rectView, exactView] = await Promise.all([
			renderView(item, 'raw'),
			renderView(item, 'rectangle'),
			renderView(item, 'exact')
		]);
		const viewTop = top + 43;
		const viewGap = 9;
		const viewsLeft = left + 17;
		for (const [index, input] of [rawView, rectView, exactView].entries()) {
			composites.push({
				input,
				left: viewsLeft + index * (viewWidth + viewGap),
				top: viewTop
			});
		}

		const plotX = left + 24;
		const plotY = top + 244;
		const plotW = panelWidth - 48;
		const plotH = 60;
		const rawPath = profilePath(item.profiles.raw.values, plotX, plotY, plotW, plotH);
		const rectPath = profilePath(item.profiles.rectangle.values, plotX, plotY, plotW, plotH);
		const exactPath = profilePath(item.profiles.exact.values, plotX, plotY, plotW, plotH);
		const rectVisible = mean(item.profiles.rectangle.visibleCounts);
		const exactVisible = mean(item.profiles.exact.visibleCounts);
		panelsSvg += `
			<rect x="${left}" y="${top}" width="${panelWidth}" height="${panelHeight}" rx="8" fill="#121923" stroke="#344155"/>
			<text x="${left + 16}" y="${top + 24}" class="panel">clean ${item.cleanIndex + 1} · tip (${item.row.basket.tipX}, ${item.row.basket.tipY})</text>
			<text x="${viewsLeft + viewWidth / 2}" y="${viewTop - 7}" text-anchor="middle" class="mini">RAW</text>
			<text x="${viewsLeft + viewWidth + viewGap + viewWidth / 2}" y="${viewTop - 7}" text-anchor="middle" class="mini red">RECTANGLE</text>
			<text x="${viewsLeft + 2 * (viewWidth + viewGap) + viewWidth / 2}" y="${viewTop - 7}" text-anchor="middle" class="mini blue">EXACT B/W</text>
			<rect x="${plotX}" y="${plotY}" width="${plotW}" height="${plotH}" fill="#0b1119" stroke="#334155"/>
			<line x1="${plotX}" y1="${plotY + plotH / 2}" x2="${plotX + plotW}" y2="${plotY + plotH / 2}" stroke="#263244"/>
			<path d="${rawPath}" fill="none" stroke="#d5d9e2" stroke-width="1" opacity="0.55"/>
			<path d="${rectPath}" fill="none" stroke="#ef4056" stroke-width="1.4"/>
			<path d="${exactPath}" fill="none" stroke="#3588ff" stroke-width="1.5"/>
			<text x="${plotX}" y="${plotY + plotH + 15}" class="axis">N 0°</text>
			<text x="${plotX + plotW / 4}" y="${plotY + plotH + 15}" text-anchor="middle" class="axis">E</text>
			<text x="${plotX + plotW / 2}" y="${plotY + plotH + 15}" text-anchor="middle" class="axis">S</text>
			<text x="${plotX + (3 * plotW) / 4}" y="${plotY + plotH + 15}" text-anchor="middle" class="axis">W</text>
			<text x="${plotX + plotW}" y="${plotY + plotH + 15}" text-anchor="end" class="axis">N 360°</text>
			<text x="${left + panelWidth - 15}" y="${top + 24}" text-anchor="end" class="count">+${item.disk.recoveredPixels} C1 px · samples ${rectVisible.toFixed(0)}→${exactVisible.toFixed(0)}/angle</text>`;
	}

	const recovered = study.map((item) => item.disk.recoveredPixels);
	const rectBlocked = study.map((item) => item.disk.rectangleBlockedPixels);
	const exactBlocked = study.map((item) => item.disk.exactBlockedPixels);
	const exactOutside = study.map((item) => item.disk.exactOutsideRectanglePixels);
	const exactObject = study.map((item) => item.exactObjectPixels);
	const headerSvg = Buffer.from(`
		<svg width="${canvasWidth}" height="${canvasHeight}" xmlns="http://www.w3.org/2000/svg">
			<style>
				.title { font: 700 29px sans-serif; fill: #f8fafc; }
				.sub { font: 16px sans-serif; fill: #c4cfdd; }
				.panel { font: 700 14px sans-serif; fill: #f3f6fa; }
				.mini { font: 700 11px sans-serif; fill: #d5d9e2; }
				.red { fill: #ff6b7b; }
				.blue { fill: #65a4ff; }
				.axis { font: 9px sans-serif; fill: #8794a8; }
				.count { font: 10px monospace; fill: #f4d35e; }
				.mono { font: 14px monospace; fill: #d7dfeb; }
				.legend { font: 14px sans-serif; fill: #d7dfeb; }
			</style>
			<text x="${outerMargin}" y="45" class="title">C1 clean control — rectangle occlusion → exact basket ownership</text>
			<text x="${outerMargin}" y="75" class="sub">16 clean Dashs baskets · pole-tip origin · translucent C1 interior r=${c1InnerMinPx}..${c1InnerMaxPx}px · 2° image-north bins · raw pathfinder gray (R+G+B)/3 · no truth</text>
			<rect x="${outerMargin}" y="101" width="20" height="20" fill="#ef4056" opacity="0.85"/><text x="${outerMargin + 30}" y="117" class="legend">historical rectangle: samples dropped</text>
			<rect x="${outerMargin + 320}" y="101" width="20" height="20" fill="#3588ff" opacity="0.9"/><text x="${outerMargin + 350}" y="117" class="legend">merged 2,145-pixel B/W family: samples dropped</text>
			<rect x="${outerMargin + 735}" y="101" width="20" height="20" fill="#f4d35e" opacity="0.8"/><text x="${outerMargin + 765}" y="117" class="legend">rectangle-hidden but not known-owned: now observable, NOT called ghost yet</text>
			<ellipse cx="${outerMargin + 1335}" cy="111" rx="18" ry="18" fill="none" stroke="#3ee6c1" stroke-width="2"/><text x="${outerMargin + 1365}" y="117" class="legend">measured C1 surface</text>
			<text x="${outerMargin}" y="157" class="mono">known object ownership: median ${median(exactObject).toFixed(0)} px = 1,746 bright + 399 dark</text>
			<text x="${outerMargin}" y="181" class="mono">inside measured C1: rectangle blocks median ${median(rectBlocked).toFixed(0)} px; exact B/W blocks ${median(exactBlocked).toFixed(0)} px</text>
			<text x="${outerMargin}" y="205" class="mono">precise ownership re-admits median ${median(recovered).toFixed(0)} C1 px (${(100 * median(recovered) / median(rectBlocked)).toFixed(1)}% of rectangle-hidden surface); exact ownership adds ${median(exactOutside).toFixed(0)} px beyond legacy rectangle</text>
			<text x="${outerMargin}" y="229" class="sub">The blue radial line is the new clean baseline. Yellow pixels remain unclassified until the ghost-pixel experiment.</text>
			${panelsSvg}
		</svg>`);

	await sharp({
		create: {
			width: canvasWidth,
			height: canvasHeight,
			channels: 4,
			background: { r: 13, g: 19, b: 28, alpha: 1 }
		}
	})
		.composite([{ input: headerSvg, left: 0, top: 0 }, ...composites])
		.png()
		.toFile(outPng);
});

timings.observedTotalMs = performance.now() - totalStart;
const receipt = {
	schema: 'chainspot-c1-clean-control@1',
	purpose:
		'establish the C1 baseline required before measuring ghost pixels by replacing historical rectangle occlusion with exact known B/W component ownership',
	source: {
		runDir,
		canonicalRaster: 'badgeStage.masks.localImage',
		brightMask: 'badgeStage.masks.bright',
		darkMask: 'badgeStage.masks.dark',
		truthUsed: false
	},
	control: {
		cleanBaskets: study.length,
		selection: 'modal exact shell margins among accepted G2 baskets',
		modalShellMargins: evidence.modalMargins,
		modalSupport: evidence.modalSupport,
		basketOrigin: 'semantic bottom-center pole tip'
	},
	measurement: {
		observable: 'pathfinder gray arithmetic RGB mean',
		frame: 'imageNorth: 0deg north, clockwise positive',
		c1InnerRadiusPx: [c1InnerMinPx, c1InnerMaxPx],
		angleStepDeg,
		microFanDeg,
		muteSemantics: 'owned samples become UNKNOWN and do not enter the mean'
	},
	occlusions: {
		raw: 'no basket samples omitted',
		historicalRectangle:
			'legacy D11 42x66 sprite bbox plus uniform 2px margin, inclusive raster predicate',
		exactKnownOwnership:
			'2,145-pixel merged clean-family template: 1,746 modal bright plus 399 modal dark pixels, stamped from exact inside-edge registration',
		recoveredMeaning:
			'pixels historical rectangle omitted but exact known B/W ownership does not; includes legitimate C1 and possible ghost pixels, intentionally not classified yet'
	},
	baskets: study.map((item) => ({
		cleanIndex: item.cleanIndex + 1,
		detectorIndex: item.row.index,
		source: item.row.basket.source,
		tip: [item.row.basket.tipX, item.row.basket.tipY],
		exactObjectPixels: item.exactObjectPixels,
		c1PixelCounts: item.disk,
		profiles: item.profiles
	})),
	timingsMs: Object.fromEntries(Object.entries(timings).map(([key, value]) => [key, Number(value.toFixed(3))])),
	outputs: { visualRender: outPng, receipt: outJson }
};

await writeFile(outJson, `${JSON.stringify(receipt, null, 2)}\n`);
console.log(
	JSON.stringify(
		{
			schema: receipt.schema,
			cleanBaskets: study.length,
			exactObjectPixelsMedian: median(study.map((item) => item.exactObjectPixels)),
			c1RectangleBlockedMedian: median(study.map((item) => item.disk.rectangleBlockedPixels)),
			c1ExactBlockedMedian: median(study.map((item) => item.disk.exactBlockedPixels)),
			c1RecoveredMedian: median(study.map((item) => item.disk.recoveredPixels)),
			timingsMs: receipt.timingsMs,
			outputs: receipt.outputs
		},
		null,
		2
	)
);
