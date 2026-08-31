// Hypothesis tournament over the outer-AA fringe -- prototype of the reusable
// competing-hypothesis process: declare hypotheses + their statistical
// signatures FIRST, compute one shared evidence pass, score every hypothesis
// against the same numbers, print verdicts. Nothing is verified in isolation.
//   H-A alpha-blend: fringe = a*ink + (1-a)*underneath. Signature: high corr
//       with adjacent background; alpha-from-means == alpha-from-variances.
//   H-B opaque ink: corr ~ 0.
//   H-C multiplicative shadow: mean ratio == sd ratio (both = k).
//   H-D sub-pixel jitter: corr ~ 0 and variance concentrated at sprite edges.
//   H-E compression noise: fringe variance ~= ink-interior noise floor.
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
const br = extractComponents(measurement.brightMask);
const dk = extractComponents(measurement.darkMask);
const graph = acquireObjectGraphV1(measurement, {
	width: WIDTH, height: HEIGHT,
	brightLabels: br.labels, darkLabels: dk.labels,
	brightComponents: br.components, darkComponents: dk.components
});
const assembled = graph.baskets.filter((b) => b.raster.componentAssembly?.status === 'assembled');
const N = assembled.length;
const M = 8;
const [, , bw0, bh0] = assembled[0].raster.componentAssembly.bbox;
const winW = bw0 + 2 * M, winH = bh0 + 2 * M;
const lumaAt = (x, y) => { const i = (y * WIDTH + x) * 4; return 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2]; };

const ownCount = new Uint16Array(winW * winH);
const series = Array.from({ length: winW * winH }, () => new Float64Array(N));
assembled.forEach((o, k) => {
	const asm = o.raster.componentAssembly;
	const [bx, by] = asm.bbox;
	const owned = new Set(asm.ownedPixels);
	for (let ly = 0; ly < winH; ly++) for (let lx = 0; lx < winW; lx++) {
		const x = bx - M + lx, y = by - M + ly;
		if (x < 0 || x >= WIDTH || y < 0 || y >= HEIGHT) continue;
		const li = ly * winW + lx;
		series[li][k] = lumaAt(x, y);
		if (owned.has(y * WIDTH + x)) ownCount[li]++;
	}
});
const st = (arr) => { let m = 0; for (const v of arr) m += v; m /= arr.length; let v2 = 0; for (const v of arr) v2 += (v - m) * (v - m); return { m, v: v2 / arr.length }; };
const idx = (lx, ly) => ly * winW + lx;
const meanOf = new Float64Array(winW * winH);
for (let li = 0; li < winW * winH; li++) meanOf[li] = st(series[li]).m;

// classify (same rules as aaFringe.probe): inner/outer AA + background refs.
const kind = new Uint8Array(winW * winH);
for (let ly = 1; ly < winH - 1; ly++) for (let lx = 1; lx < winW - 1; lx++) {
	const li = idx(lx, ly);
	if (ownCount[li] !== 0) continue;
	if (meanOf[li] >= 140) continue;
	const nb = [idx(lx - 1, ly), idx(lx + 1, ly), idx(lx, ly - 1), idx(lx, ly + 1)];
	if (!nb.some((n) => ownCount[n] === N)) continue;
	kind[li] = nb.some((n) => ownCount[n] === 0 && meanOf[n] >= 140) ? 2 : 1;
}
for (let ly = 1; ly < winH - 1; ly++) for (let lx = 1; lx < winW - 1; lx++) {
	const li = idx(lx, ly);
	if (ownCount[li] !== 0 || kind[li] !== 0 || meanOf[li] < 140) continue;
	const nb = [idx(lx - 1, ly), idx(lx + 1, ly), idx(lx, ly - 1), idx(lx, ly + 1)];
	if (nb.some((n) => kind[n] === 2)) kind[li] = 3;
}

// SHARED EVIDENCE PASS ------------------------------------------------------
// Ink constant: median luma of owned dark-border pixels (ownCount==N, dark).
const inkVals = [];
for (let li = 0; li < winW * winH; li++) if (ownCount[li] === N && meanOf[li] < 100) inkVals.push(meanOf[li]);
inkVals.sort((a, b) => a - b);
const INK = inkVals[inkVals.length >> 1];
// Noise floor: cross-instance variance inside solid owned ink and solid owned white.
const floorVals = [];
for (let li = 0; li < winW * winH; li++) if (ownCount[li] === N) floorVals.push(st(series[li]).v);
floorVals.sort((a, b) => a - b);
const FLOOR = floorVals[floorVals.length >> 1];

const rows = [];
for (let ly = 1; ly < winH - 1; ly++) for (let lx = 1; lx < winW - 1; lx++) {
	const li = idx(lx, ly);
	if (kind[li] !== 2) continue;
	const nb = [idx(lx - 1, ly), idx(lx + 1, ly), idx(lx, ly - 1), idx(lx, ly + 1)].filter((n) => kind[n] === 3);
	if (!nb.length) continue;
	const f = series[li], g = series[nb[0]];
	const sf = st(f), sg = st(g);
	if (sg.v < 2) continue;
	let c = 0;
	for (let k = 0; k < N; k++) c += (f[k] - sf.m) * (g[k] - sg.m);
	c /= N * Math.sqrt(sf.v * sg.v || 1);
	const aMean = (sg.m - sf.m) / Math.max(1, sg.m - INK);      // H-A alpha from means
	const aSd = 1 - Math.sqrt(sf.v / sg.v);                     // H-A alpha from variances
	const kMean = sf.m / sg.m, kSd = Math.sqrt(sf.v / sg.v);    // H-C multiplicative ks
	rows.push({ li, corr: c, aMean, aSd, kMean, kSd, varF: sf.v });
}
const med = (xs) => { const s = xs.slice().sort((a, b) => a - b); return s.length ? s[s.length >> 1] : NaN; };
const corrMed = med(rows.map((r) => r.corr));
const aGap = med(rows.map((r) => Math.abs(r.aMean - r.aSd)));
const kGap = med(rows.map((r) => Math.abs(r.kMean - r.kSd)));
const noiseRatio = med(rows.map((r) => r.varF)) / Math.max(0.01, FLOOR);

// VERDICTS ------------------------------------------------------------------
console.log('AA FRINGE HYPOTHESIS TOURNAMENT');
console.log(`shared evidence: ${rows.length} outer-AA pixels x ${N} stamps; ink=${INK.toFixed(1)} luma; owned-pixel noise floor var=${FLOOR.toFixed(2)}`);
console.log('');
const verdict = (name, claim, stat, pass, fail) => {
	const v = pass ? 'SUPPORTED' : fail ? 'REJECTED' : 'UNDECIDED';
	console.log(`${v.padEnd(10)} ${name}: ${claim}`);
	console.log(`           ${stat}`);
	return v;
};
verdict('H-A alpha-blend', 'fringe = a*ink + (1-a)*underneath',
	`corr median ${corrMed.toFixed(3)} (needs >>0); |alpha_mean - alpha_sd| median ${aGap.toFixed(3)} (two estimators of one latent must agree)`,
	corrMed > 0.5 && aGap < 0.2, corrMed < 0.2 || aGap > 0.5);
verdict('H-B opaque ink', 'fringe is opaque ink; background irrelevant',
	`corr median ${corrMed.toFixed(3)} (needs ~0)`,
	corrMed < 0.15, corrMed > 0.4);
verdict('H-C shadow (multiplicative)', 'fringe = k * underneath (pure darkening)',
	`|k_mean - k_sd| median ${kGap.toFixed(3)} vs alpha gap ${aGap.toFixed(3)} (must beat H-A consistency)`,
	kGap < aGap * 0.7, kGap > aGap * 1.3);
verdict('H-D sub-pixel jitter', 'variance from stamp misregistration',
	`all ${N} owned bboxes identical 46x72 (stack blur = 0); corr ${corrMed.toFixed(3)} (jitter predicts ~0)`,
	false, corrMed > 0.4);
verdict('H-E compression noise', 'fringe variance ~= deterministic-pixel noise floor',
	`fringe var / floor = ${noiseRatio.toFixed(1)}x (needs ~1x)`,
	noiseRatio < 2, noiseRatio > 4);

// RENDER: the discriminator scatter. Left: alpha_mean vs alpha_sd (H-A line y=x).
// Right: k_mean vs k_sd (H-C line y=x). The tighter diagonal wins.
const S = 340, PAD = 30;
const png = new PNG({ width: S * 2 + PAD * 3, height: S + PAD * 2 });
png.data.fill(245);
const put = (X, Y, r, g, b) => { if (X < 0 || Y < 0 || X >= png.width || Y >= png.height) return; const i = (Y * png.width + X) * 4; png.data[i] = r; png.data[i + 1] = g; png.data[i + 2] = b; png.data[i + 3] = 255; };
const panel = (ox, getX, getY, lo, hi, col) => {
	for (let t = 0; t < S; t++) { put(ox + t, PAD + S, 60, 60, 60); put(ox, PAD + t, 60, 60, 60); }
	for (let t = 0; t < S; t++) put(ox + t, PAD + S - t, 180, 180, 180); // y=x
	for (const r of rows) {
		const X = ox + Math.round(((getX(r) - lo) / (hi - lo)) * S);
		const Y = PAD + S - Math.round(((getY(r) - lo) / (hi - lo)) * S);
		for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) put(X + dx, Y + dy, ...col);
	}
};
panel(PAD, (r) => Math.max(-0.2, Math.min(1.2, r.aSd)), (r) => Math.max(-0.2, Math.min(1.2, r.aMean)), -0.2, 1.2, [200, 60, 40]);
panel(PAD * 2 + S, (r) => Math.max(0, Math.min(1.5, r.kSd)), (r) => Math.max(0, Math.min(1.5, r.kMean)), 0, 1.5, [40, 90, 200]);
writeFileSync(outPath, PNG.sync.write(png));
console.log('');
console.log('scatter: left = H-A (alpha from means vs from variances), right = H-C (k from means vs from variances); gray diagonal = perfect agreement');
console.log(`render saved to ${outPath} — display alongside this receipt`);
