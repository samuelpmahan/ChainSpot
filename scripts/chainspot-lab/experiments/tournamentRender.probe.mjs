// Prototype VisualRender for a hypothesis tournament: project the winning
// hypothesis's evidence (per-angle leak fraction around the pole tip) through
// the shared RadialRender substrate in the TrueNorth frame, with the verdict
// table as plate annotations. The renderer does no math: this driver bins,
// normalizes to [0,1], and hands over NaN for empty bins.
import { readFileSync, writeFileSync } from 'node:fs';
import { measureThreeFactor } from '../../../packages/alg/dist/detectors/threeFactor/index.js';
import { extractComponents } from '../../../packages/alg/dist/detectors/threeFactor/components.js';
import { acquireObjectGraphV1 } from '../../../packages/alg/dist/detectors/threeFactor/objects.js';
import { renderTrueNorthSkeleton } from '/tmp/frame-radial-smoke-dist/radialRender.js';

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
const tipLX = M + bw0 / 2, tipLY = M + bh0; // pole tip in aligned-window coords
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

const kind = new Uint8Array(winW * winH);
for (let ly = 1; ly < winH - 1; ly++) for (let lx = 1; lx < winW - 1; lx++) {
	const li = idx(lx, ly);
	if (ownCount[li] !== 0 || meanOf[li] >= 140) continue;
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

// Per-angle leak fraction (1 - alpha) around the pole tip, 48 bins clockwise from north.
const BINS = 48;
const sums = new Float64Array(BINS), counts = new Uint32Array(BINS);
for (let ly = 1; ly < winH - 1; ly++) for (let lx = 1; lx < winW - 1; lx++) {
	const li = idx(lx, ly);
	if (kind[li] !== 2) continue;
	const nb = [idx(lx - 1, ly), idx(lx + 1, ly), idx(lx, ly - 1), idx(lx, ly + 1)].filter((n) => kind[n] === 3);
	if (!nb.length) continue;
	const sf = st(series[li]), sg = st(series[nb[0]]);
	if (sg.v < 2) continue;
	const leak = Math.sqrt(Math.max(0, Math.min(1.5, sf.v / sg.v)));
	// image coords: +y down; visual-north bin 0 = up. angle from tip:
	const th = Math.atan2(-(ly - tipLY), lx - tipLX); // math convention, up=+90deg
	const clockFromNorth = ((Math.PI / 2 - th) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
	const bin = Math.min(BINS - 1, Math.floor((clockFromNorth / (2 * Math.PI)) * BINS));
	sums[bin] += Math.min(1, leak); counts[bin]++;
}
const values = [...Array(BINS)].map((_, i) => (counts[i] ? sums[i] / counts[i] : NaN));
const covered = values.filter((v) => !Number.isNaN(v)).length;

const result = renderTrueNorthSkeleton({
	origin: { x: 0, y: 0, semantic: 'basket bottom-center pole tip (16-stamp aligned stack)' },
	series: [{ id: 'leakFraction', label: `outer-AA leak fraction (1-alpha), ${covered}/${BINS} bins covered`, values }],
	annotations: [
		'H-A alpha-blend      SUPPORTED  corr 0.828, estimator gap 0.093',
		'H-B opaque ink       REJECTED   corr 0.828 (needs ~0)',
		'H-C shadow           UNDECIDED  degenerate: ink luma 5.6 ~ 0 -> k = 1-a',
		'H-D sub-pixel jitter REJECTED   16/16 bboxes identical; corr high',
		'H-E compression noise REJECTED  fringe var 21.9x noise floor',
		'evidence: 99 outer-AA px x 16 stamps, DashsTrack (aaFringeHypotheses.probe)'
	]
});
for (const log of result.logs) console.log(`log[${log.level}] ${log.message}`);
console.log(`status=${result.status}`);
writeFileSync(outPath, result.svg);
console.log(`render saved to ${outPath} — display alongside this receipt`);
