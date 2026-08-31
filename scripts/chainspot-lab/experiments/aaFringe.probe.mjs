// AA-fringe split + leak test, basket-focused, on the aligned 16-basket stack.
// The never-owned ghost splits into an INNER antialias ring (ink blending into
// ink -- mute it, carries nothing) and an OUTER ring (border ink blended over
// the underneath scene). Question: does underneath color leak through the
// outer ring? Method: across 16 deterministic stamps the sprite contributes
// zero cross-instance variance, so any variance/correlation an outer-ring
// pixel shares with its adjacent background is leak-through. PCA across
// instances factors it; per-pixel alpha comes from the variance ratio
// var(fringe)/var(neighbor background) = (1-alpha)^2.
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
const measurement = measureThreeFactor({ imageId: 'dashs-canonical', widthPx: WIDTH, heightPx: HEIGHT, rgba }, {});
const bright = extractComponents(measurement.brightMask);
const dark = extractComponents(measurement.darkMask);
const graph = acquireObjectGraphV1(measurement, {
	width: WIDTH, height: HEIGHT,
	brightLabels: bright.labels, darkLabels: dark.labels,
	brightComponents: bright.components, darkComponents: dark.components
});
const assembled = graph.baskets.filter((b) => b.raster.componentAssembly?.status === 'assembled');
const N = assembled.length;
console.log('AA FRINGE LEAK PROBE');
console.log(`aligned baskets: ${N}`);

const M = 8;
const [, , bw0, bh0] = assembled[0].raster.componentAssembly.bbox;
const winW = bw0 + 2 * M, winH = bh0 + 2 * M;
const lumaAt = (x, y) => {
	const i = (y * WIDTH + x) * 4;
	return 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
};

// Per aligned pixel: ownership count, per-instance luma samples, mean color.
const ownCount = new Uint16Array(winW * winH);
const lumaSeries = Array.from({ length: winW * winH }, () => new Float64Array(N));
const meanL = new Float64Array(winW * winH);
assembled.forEach((o, k) => {
	const asm = o.raster.componentAssembly;
	const [bx, by] = asm.bbox;
	const owned = new Set(asm.ownedPixels);
	for (let ly = 0; ly < winH; ly++)
		for (let lx = 0; lx < winW; lx++) {
			const x = bx - M + lx, y = by - M + ly;
			if (x < 0 || x >= WIDTH || y < 0 || y >= HEIGHT) continue;
			const li = ly * winW + lx, L = lumaAt(x, y);
			lumaSeries[li][k] = L; meanL[li] += L / N;
			if (owned.has(y * WIDTH + x)) ownCount[li]++;
		}
});

// Ghost = never-owned but consistently dark vs local mean scene (the residual outline band):
// classify by adjacency to the always-owned union.
const alwaysOwned = (li) => ownCount[li] === N;
const neverOwned = (li) => ownCount[li] === 0;
const idx = (lx, ly) => ly * winW + lx;
const kind = new Uint8Array(winW * winH); // 0 none, 1 inner AA, 2 outer AA, 3 background ref
for (let ly = 1; ly < winH - 1; ly++)
	for (let lx = 1; lx < winW - 1; lx++) {
		const li = idx(lx, ly);
		if (!neverOwned(li)) continue;
		const darkish = meanL[li] < 140; // ghost band is dark ink blend; scene mean here is ~150+
		const nbrs = [idx(lx - 1, ly), idx(lx + 1, ly), idx(lx, ly - 1), idx(lx, ly + 1)];
		const touchesOwned = nbrs.some(alwaysOwned);
		if (!darkish || !touchesOwned) continue;
		// outer if any neighbor is plain background (never-owned, not dark)
		const touchesBg = nbrs.some((n) => neverOwned(n) && meanL[n] >= 140);
		kind[li] = touchesBg ? 2 : 1;
	}
// background reference ring: never-owned bright pixels adjacent to an outer-AA pixel.
for (let ly = 1; ly < winH - 1; ly++)
	for (let lx = 1; lx < winW - 1; lx++) {
		const li = idx(lx, ly);
		if (!neverOwned(li) || kind[li] !== 0 || meanL[li] < 140) continue;
		const nbrs = [idx(lx - 1, ly), idx(lx + 1, ly), idx(lx, ly - 1), idx(lx, ly + 1)];
		if (nbrs.some((n) => kind[n] === 2)) kind[li] = 3;
	}
const count = (k) => kind.filter ? [...kind].filter((v) => v === k).length : 0;
const nInner = count(1), nOuter = count(2), nBg = count(3);
console.log(`ghost split: inner AA ${nInner}px, outer AA ${nOuter}px, background reference ${nBg}px (per aligned window; x${N} instances)`);

// Leak test per outer pixel: correlation + variance ratio vs its background neighbor.
const stats = (arr) => {
	const m = arr.reduce((a, b) => a + b, 0) / arr.length;
	const v = arr.reduce((a, b) => a + (b - m) * (b - m), 0) / arr.length;
	return { m, v };
};
const alphas = [], cors = [];
const alphaMap = new Float64Array(winW * winH).fill(NaN);
for (let ly = 1; ly < winH - 1; ly++)
	for (let lx = 1; lx < winW - 1; lx++) {
		const li = idx(lx, ly);
		if (kind[li] !== 2) continue;
		const nbrs = [idx(lx - 1, ly), idx(lx + 1, ly), idx(lx, ly - 1), idx(lx, ly + 1)].filter((n) => kind[n] === 3);
		if (!nbrs.length) continue;
		const f = lumaSeries[li], g = lumaSeries[nbrs[0]];
		const sf = stats([...f]), sg = stats([...g]);
		if (sg.v < 1) continue;
		let c = 0;
		for (let k = 0; k < N; k++) c += (f[k] - sf.m) * (g[k] - sg.m);
		c /= N * Math.sqrt(sf.v * sg.v || 1);
		const alpha = 1 - Math.sqrt(Math.max(0, Math.min(1.5, sf.v / sg.v)));
		alphas.push(alpha); cors.push(c); alphaMap[li] = alpha;
	}
alphas.sort((a, b) => a - b); cors.sort((a, b) => a - b);
const q = (arr, p) => arr.length ? arr[Math.floor(p * (arr.length - 1))] : NaN;
console.log(`outer-AA leak: ${alphas.length} testable pixels`);
console.log(`  correlation with adjacent background: median ${q(cors, 0.5).toFixed(3)} (q25 ${q(cors, 0.25).toFixed(3)}, q75 ${q(cors, 0.75).toFixed(3)}) -- >0 means underneath leaks through`);
console.log(`  recovered ink alpha: median ${q(alphas, 0.5).toFixed(3)} (q25 ${q(alphas, 0.25).toFixed(3)}, q75 ${q(alphas, 0.75).toFixed(3)}) -- leak fraction (1-alpha) median ${(1 - q(alphas, 0.5)).toFixed(3)}`);

// PCA across instances: outer-AA matrix vs background matrix -- compare top-factor share.
function topFactorShare(pixels) {
	if (pixels.length < 3) return NaN;
	const X = pixels.map((li) => {
		const s = stats([...lumaSeries[li]]);
		return [...lumaSeries[li]].map((v) => v - s.m);
	}); // dims x N
	const C = Array.from({ length: N }, () => new Float64Array(N));
	for (const row of X) for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) C[i][j] += row[i] * row[j];
	let v = new Float64Array(N).fill(1), lam = 0, tot = 0;
	for (let i = 0; i < N; i++) tot += C[i][i];
	for (let it = 0; it < 60; it++) {
		const w = new Float64Array(N);
		for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) w[i] += C[i][j] * v[j];
		lam = Math.hypot(...w); v = w.map((x) => x / (lam || 1));
	}
	return lam / (tot || 1);
}
const outerPx = [], bgPx = [];
for (let li = 0; li < winW * winH; li++) { if (kind[li] === 2) outerPx.push(li); if (kind[li] === 3) bgPx.push(li); }
console.log(`  PCA top-factor share: outer AA ${(topFactorShare(outerPx) * 100).toFixed(1)}% vs background ${(topFactorShare(bgPx) * 100).toFixed(1)}% (similar share = same underneath structure, attenuated)`);

// Render: mean | classification (inner=blue, outer=orange, bgref=teal) | alpha map (dark=opaque ink, bright=leaky).
const SCALE = 6, GAP = 2;
const png = new PNG({ width: (winW * 3 + GAP * 2) * SCALE, height: winH * SCALE });
png.data.fill(120);
const put = (px2, py, r, g, b) => {
	for (let dy = 0; dy < SCALE; dy++) for (let dx = 0; dx < SCALE; dx++) {
		const i = ((py * SCALE + dy) * png.width + (px2 * SCALE + dx)) * 4;
		png.data[i] = r; png.data[i + 1] = g; png.data[i + 2] = b; png.data[i + 3] = 255;
	}
};
for (let ly = 0; ly < winH; ly++)
	for (let lx = 0; lx < winW; lx++) {
		const li = idx(lx, ly), L = meanL[li];
		put(lx, ly, L, L, L);
		const k = kind[li];
		put(lx + winW + GAP, ly, k === 1 ? 70 : k === 2 ? 255 : k === 3 ? 40 : L * 0.5, k === 1 ? 110 : k === 2 ? 150 : k === 3 ? 190 : L * 0.5, k === 1 ? 255 : k === 2 ? 40 : k === 3 ? 190 : L * 0.5);
		const a = alphaMap[li];
		put(lx + (winW + GAP) * 2, ly, Number.isNaN(a) ? L * 0.35 : 255 * (1 - a), Number.isNaN(a) ? L * 0.35 : 255 * (1 - a), Number.isNaN(a) ? L * 0.35 : 60);
	}
writeFileSync(outPath, PNG.sync.write(png));
console.log('panels: mean | fringe classification (blue=inner AA mute, orange=outer AA, teal=background ref) | leak map (yellow-bright = underneath leaks)');
console.log(`render saved to ${outPath} — display alongside this receipt`);
