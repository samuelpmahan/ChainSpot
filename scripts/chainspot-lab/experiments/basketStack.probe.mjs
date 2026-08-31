// Canonical basket stack probe (11b7bcc item 2), course-local: align all
// assembled baskets on their owned-bbox anchor and stack three views —
// mean appearance, per-pixel ownership frequency, and mean punched residual.
// Structure that recurs across all 16 is basket-caused; background washes out.
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { measureThreeFactor } from '../../../packages/alg/dist/detectors/threeFactor/index.js';
import { extractComponents } from '../../../packages/alg/dist/detectors/threeFactor/components.js';
import { acquireObjectGraphV1 } from '../../../packages/alg/dist/detectors/threeFactor/objects.js';

const require = createRequire(import.meta.url);
const { PNG } = require('pngjs');

const [rgbaPath, outPath] = process.argv.slice(2);
const WIDTH = 1290, HEIGHT = 2083;
const rgba = new Uint8ClampedArray(readFileSync(rgbaPath).buffer.slice(0));
const image = { imageId: 'dashs-canonical-sweep-artifact', widthPx: WIDTH, heightPx: HEIGHT, rgba };
const t0 = Date.now();
const measurement = measureThreeFactor(image, {});
const bright = extractComponents(measurement.brightMask);
const dark = extractComponents(measurement.darkMask);
const graph = acquireObjectGraphV1(measurement, {
	width: WIDTH, height: HEIGHT,
	brightLabels: bright.labels, darkLabels: dark.labels,
	brightComponents: bright.components, darkComponents: dark.components
});
const assembled = graph.baskets.filter((b) => b.raster.componentAssembly?.status === 'assembled');
console.log('BASKET STACK PROBE');
console.log(`assembled baskets: ${assembled.length}`);

const M = 12;
let winW = 0, winH = 0;
for (const b of assembled) {
	const [, , w, h] = b.raster.componentAssembly.bbox;
	winW = Math.max(winW, w + 2 * M);
	winH = Math.max(winH, h + 2 * M);
}
const N = assembled.length;
const sum = new Float64Array(winW * winH * 3);      // mean appearance
const ownCount = new Uint16Array(winW * winH);      // ownership frequency
const resSum = new Float64Array(winW * winH * 3);   // mean punched residual
const resN = new Uint32Array(winW * winH);          // samples contributing to residual (unowned only)
const bboxDims = new Map();

for (const b of assembled) {
	const asm = b.raster.componentAssembly;
	const [bx, by, bw, bh] = asm.bbox;
	bboxDims.set(`${bw}x${bh}`, (bboxDims.get(`${bw}x${bh}`) ?? 0) + 1);
	const owned = new Set(asm.ownedPixels);
	for (let ly = 0; ly < winH; ly++) {
		const y = by - M + ly;
		if (y < 0 || y >= HEIGHT) continue;
		for (let lx = 0; lx < winW; lx++) {
			const x = bx - M + lx;
			if (x < 0 || x >= WIDTH) continue;
			const si = (y * WIDTH + x) * 4, li = ly * winW + lx;
			sum[li * 3] += rgba[si]; sum[li * 3 + 1] += rgba[si + 1]; sum[li * 3 + 2] += rgba[si + 2];
			if (owned.has(y * WIDTH + x)) ownCount[li]++;
			else {
				resSum[li * 3] += rgba[si]; resSum[li * 3 + 1] += rgba[si + 1]; resSum[li * 3 + 2] += rgba[si + 2];
				resN[li]++;
			}
		}
	}
}
console.log(`bbox dims histogram: ${[...bboxDims.entries()].map(([k, v]) => `${k}:${v}`).join(' ')}`);
const always = [...ownCount].filter((c) => c === N).length;
const flicker = [...ownCount].filter((c) => c > 0 && c < N).length;
console.log(`aligned window ${winW}x${winH}: owned-by-all-${N}=${always}px, flicker(1..${N - 1})=${flicker}px, elapsed=${Date.now() - t0}ms`);

// Render three panels 6x: mean | ownership frequency | mean residual.
const SCALE = 6, GAP = 2;
const png = new PNG({ width: (winW * 3 + GAP * 2) * SCALE, height: winH * SCALE });
png.data.fill(120);
function put(px, py, r, g, b) {
	for (let dy = 0; dy < SCALE; dy++)
		for (let dx = 0; dx < SCALE; dx++) {
			const i = ((py * SCALE + dy) * png.width + (px * SCALE + dx)) * 4;
			png.data[i] = r; png.data[i + 1] = g; png.data[i + 2] = b; png.data[i + 3] = 255;
		}
}
for (let ly = 0; ly < winH; ly++)
	for (let lx = 0; lx < winW; lx++) {
		const li = ly * winW + lx;
		put(lx, ly, sum[li * 3] / N, sum[li * 3 + 1] / N, sum[li * 3 + 2] / N);
		const f = ownCount[li] / N; // 0 -> white, 1 -> black; flicker mid-gray + red tint
		const v = 255 * (1 - f);
		const red = ownCount[li] > 0 && ownCount[li] < N ? 255 : v;
		put(lx + winW + GAP, ly, red, v, v);
		if (resN[li]) put(lx + (winW + GAP) * 2, ly, resSum[li * 3] / resN[li], resSum[li * 3 + 1] / resN[li], resSum[li * 3 + 2] / resN[li]);
		else put(lx + (winW + GAP) * 2, ly, 230, 230, 245); // owned by all: nothing ever contributed
	}
writeFileSync(outPath, PNG.sync.write(png));
console.log(`panels: mean | ownership frequency (red=flicker, black=all ${N}) | mean unowned residual`);
console.log(`render saved to ${outPath} — display alongside this receipt`);
