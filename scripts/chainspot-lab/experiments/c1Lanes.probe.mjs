// Two-lane comparison on the C1 polarity task, DashsTrack:
//   LANE A (blindness): mute EVERY known basket-affected pixel -- owned union,
//     inner AA, outer AA. Maximum safety, zero recovered signal.
//   LANE B (mining): mute owned + inner AA; RECONSTRUCT outer-AA pixels as
//     underneath = (obs - alpha*ink) / (1-alpha), alpha learned per sprite
//     offset from the 16-stamp stack, and let them vote as evidence.
// Baseline = the v1 bbox-muted scorer (13/17 correct-side) for continuity.
// Same scorer and truth eval everywhere; only basket-pixel treatment differs.
// Output ends with the cross-course hypothesis this run generates.
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { measureThreeFactor } from '../../../packages/alg/dist/detectors/threeFactor/index.js';
import { extractComponents } from '../../../packages/alg/dist/detectors/threeFactor/components.js';
import { acquireObjectGraphV1 } from '../../../packages/alg/dist/detectors/threeFactor/objects.js';

const require = createRequire(import.meta.url);
const { PNG } = require('pngjs');
const [rgbaPath, truthPath, outPath] = process.argv.slice(2);
const WIDTH = 1290, HEIGHT = 2083, DY = -4;
const rgba = new Uint8ClampedArray(readFileSync(rgbaPath).buffer.slice(0));
const truth = JSON.parse(readFileSync(truthPath, 'utf8'));

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

// --- Learn the per-offset footprint + alpha map from the aligned stack -----
const M = 8;
const [, , bw0, bh0] = assembled[0].raster.componentAssembly.bbox;
const winW = bw0 + 2 * M, winH = bh0 + 2 * M;
const idx = (lx, ly) => ly * winW + lx;
const ownCount = new Uint16Array(winW * winH);
const series = Array.from({ length: winW * winH }, () => new Float64Array(N));
const chanSum = new Float64Array(winW * winH * 3);
assembled.forEach((o, k) => {
	const [bx, by] = o.raster.componentAssembly.bbox;
	const owned = new Set(o.raster.componentAssembly.ownedPixels);
	for (let ly = 0; ly < winH; ly++) for (let lx = 0; lx < winW; lx++) {
		const x = bx - M + lx, y = by - M + ly;
		if (x < 0 || x >= WIDTH || y < 0 || y >= HEIGHT) continue;
		const li = idx(lx, ly), i = (y * WIDTH + x) * 4;
		series[li][k] = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
		for (let c = 0; c < 3; c++) chanSum[li * 3 + c] += rgba[i + c] / N;
		if (owned.has(y * WIDTH + x)) ownCount[li]++;
	}
});
const st = (arr) => { let m = 0; for (const v of arr) m += v; m /= arr.length; let v2 = 0; for (const v of arr) v2 += (v - m) * (v - m); return { m, v: v2 / arr.length }; };
const meanOf = new Float64Array(winW * winH);
for (let li = 0; li < winW * winH; li++) meanOf[li] = st(series[li]).m;
const kind = new Uint8Array(winW * winH); // 1 inner AA, 2 outer AA
for (let ly = 1; ly < winH - 1; ly++) for (let lx = 1; lx < winW - 1; lx++) {
	const li = idx(lx, ly);
	if (ownCount[li] !== 0 || meanOf[li] >= 140) continue;
	const nb = [idx(lx - 1, ly), idx(lx + 1, ly), idx(lx, ly - 1), idx(lx, ly + 1)];
	if (!nb.some((n) => ownCount[n] === N)) continue;
	kind[li] = nb.some((n) => ownCount[n] === 0 && meanOf[n] >= 140) ? 2 : 1;
}
const inkC = [0, 1, 2].map((c) => {
	const vals = [];
	for (let li = 0; li < winW * winH; li++) if (ownCount[li] === N && meanOf[li] < 100) vals.push(chanSum[li * 3 + c]);
	vals.sort((a, b) => a - b); return vals[vals.length >> 1] ?? 0;
});
const alphaOf = new Float64Array(winW * winH).fill(NaN);
for (let ly = 1; ly < winH - 1; ly++) for (let lx = 1; lx < winW - 1; lx++) {
	const li = idx(lx, ly);
	if (kind[li] !== 2) continue;
	const nb = [idx(lx - 1, ly), idx(lx + 1, ly), idx(lx, ly - 1), idx(lx, ly + 1)]
		.filter((n) => ownCount[n] === 0 && kind[n] === 0 && meanOf[n] >= 140);
	if (!nb.length) continue;
	const sf = st(series[li]), sg = st(series[nb[0]]);
	if (sg.v < 2) continue;
	alphaOf[li] = Math.min(0.9, Math.max(0, 1 - Math.sqrt(Math.min(1.5, sf.v / sg.v))));
}
const nAlpha = [...alphaOf].filter((v) => !Number.isNaN(v)).length;
console.log('C1 TWO-LANE COMPARISON');
console.log(`footprint learned from ${N}-stack: ink RGB [${inkC.map((v) => v.toFixed(0))}], reconstructable outer-AA offsets ${nAlpha}`);

// --- v1 scorer with a pluggable per-pixel treatment ------------------------
const baskets = measurement.baskets.filter((b) => b.tier !== 'occlusion-recovery');
const c1r = 46, SAMPLES = 360, BAND = 3;
const at = (x, y) => (Math.round(y) * WIDTH + Math.round(x)) * 4;
// offset lookup: basket bbox anchor -> window coords (only valid for 46x72 stamps)
function treatmentFor(b, lane) {
	const [bx, by, bw, bh] = b.bbox;
	const standard = bw === bw0 && bh === bh0;
	return (x, y) => {
		// returns null (mute), [r,g,b] (use this color), or undefined (raw pixel)
		if (!standard) {
			// non-standard stamp (overlap case): bbox mute in every lane, loudly counted.
			if (x >= bx - 3 && x < bx + bw + 3 && y >= by - 3 && y < by + bh + 3) return null;
			return undefined;
		}
		const lx = Math.round(x) - (bx - M), ly = Math.round(y) - (by - M);
		if (lx < 0 || lx >= winW || ly < 0 || ly >= winH) return undefined;
		const li = idx(lx, ly);
		if (ownCount[li] === N || kind[li] === 1) return null;      // owned + inner AA: always mute
		if (kind[li] === 2) {
			if (lane === 'A') return null;                            // blindness
			const a = alphaOf[li];
			if (Number.isNaN(a) || a >= 0.9) return null;             // unreconstructable: stay muted
			const i = at(x, y);
			return [0, 1, 2].map((c) => Math.max(0, Math.min(255, (rgba[i + c] - a * inkC[c]) / (1 - a))));
		}
		return undefined;
	};
}
function polarity(b, treat) {
	const colors = [];
	for (let s = 0; s < SAMPLES; s++) {
		const th = (s / SAMPLES) * 2 * Math.PI;
		let n = 0, acc = [0, 0, 0];
		for (let dr = -BAND; dr <= BAND; dr++) {
			const x = b.tipXPx + (c1r + dr) * Math.cos(th), y = b.tipYPx + (c1r + dr) * Math.sin(th);
			if (x < 0 || x >= WIDTH || y < 0 || y >= HEIGHT) continue;
			const t = treat(x, y);
			if (t === null) continue;
			const px3 = t ?? [rgba[at(x, y)], rgba[at(x, y) + 1], rgba[at(x, y) + 2]];
			for (let c = 0; c < 3; c++) acc[c] += px3[c];
			n++;
		}
		colors.push(n ? acc.map((v) => v / n) : null);
	}
	const med = [0, 1, 2].map((c) => {
		const v = colors.filter(Boolean).map((p) => p[c]).sort((a, b) => a - b);
		return v[v.length >> 1] ?? 0;
	});
	const profile = colors.map((p) => (p ? Math.hypot(p[0] - med[0], p[1] - med[1], p[2] - med[2]) : 0));
	let bestA = 0, bestS = -1, oppS = 0;
	for (let s = 0; s < SAMPLES; s++) {
		let sum = 0;
		for (let d = -SAMPLES / 4; d < SAMPLES / 4; d++) sum += profile[(s + d + SAMPLES) % SAMPLES];
		if (sum > bestS) { bestS = sum; bestA = s; }
	}
	for (let d = -SAMPLES / 4; d < SAMPLES / 4; d++) oppS += profile[(bestA + SAMPLES / 2 + d + SAMPLES) % SAMPLES];
	return { a: (bestA / SAMPLES) * 2 * Math.PI, margin: (bestS - oppS) / Math.max(1, bestS + oppS) };
}
const trueAngleFor = (b) => {
	let best = null;
	for (const h of truth.holes) {
		const d = Math.hypot(h.basket.xPx - b.tipXPx, h.basket.yPx + DY - b.tipYPx);
		if (!best || d < best.d) best = { h, d };
	}
	const last = best.h.corridorBends.length ? best.h.corridorBends[best.h.corridorBends.length - 1] : best.h.tee;
	return { hole: best.h.number, a: Math.atan2(last.yPx + DY - b.tipYPx, last.xPx - b.tipXPx) };
};
const err = (a, t) => Math.abs((((a - t) % (2 * Math.PI)) + 3 * Math.PI) % (2 * Math.PI) - Math.PI) * 180 / Math.PI;

const lanes = { 'baseline bbox (v1)': null, 'LANE A mute-all': 'A', 'LANE B reconstruct': 'B' };
const results = {};
for (const [name, lane] of Object.entries(lanes)) {
	const rows = baskets.map((b) => {
		const treat = lane === null
			? (x, y) => (x >= b.bbox[0] - 3 && x < b.bbox[0] + b.bbox[2] + 3 && y >= b.bbox[1] - 3 && y < b.bbox[1] + b.bbox[3] + 3 ? null : undefined)
			: treatmentFor(b, lane);
		const p = polarity(b, treat);
		const t = trueAngleFor(b);
		return { b, hole: t.hole, predicted: p.a, margin: p.margin, trueA: t.a, errDeg: err(p.a, t.a) };
	});
	results[name] = rows;
	const cs = rows.filter((r) => r.errDeg < 90).length, tw = rows.filter((r) => r.errDeg <= 20).length;
	const medMargin = rows.map((r) => r.margin).sort((a, b) => a - b)[rows.length >> 1];
	console.log(`${name.padEnd(20)} correct-side ${cs}/${rows.length}  <=20deg ${tw}/${rows.length}  median margin ${medMargin.toFixed(3)}`);
}
console.log('');
console.log('per-hole where lanes disagree (A vs B):');
const A = results['LANE A mute-all'], B = results['LANE B reconstruct'];
for (let i = 0; i < A.length; i++)
	if (Math.abs(A[i].errDeg - B[i].errDeg) > 10)
		console.log(`  H${A[i].hole}: A ${A[i].errDeg.toFixed(1)}deg (m ${A[i].margin.toFixed(2)})  B ${B[i].errDeg.toFixed(1)}deg (m ${B[i].margin.toFixed(2)})`);

// Sheet: worst-first by lane B; orange = lane A, red = lane B, green = truth.
const rows = B.map((r, i) => ({ ...r, aPred: A[i].predicted })).sort((x, y) => y.errDeg - x.errDeg);
const TILE = 2 * (c1r + 12), SCALE = 2, COLS = 4;
const png = new PNG({ width: COLS * TILE * SCALE, height: Math.ceil(rows.length / COLS) * TILE * SCALE });
png.data.fill(30);
const px = (X, Y, r, g, b2) => { if (X < 0 || Y < 0 || X >= png.width || Y >= png.height) return; const i = (Y * png.width + X) * 4; png.data[i] = r; png.data[i + 1] = g; png.data[i + 2] = b2; png.data[i + 3] = 255; };
rows.forEach((res, k) => {
	const ox = (k % COLS) * TILE, oy = Math.floor(k / COLS) * TILE;
	for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
		const sx = Math.round(res.b.tipXPx) - TILE / 2 + x, sy = Math.round(res.b.tipYPx) - TILE / 2 + y;
		let r = 15, g = 15, bl = 15;
		if (sx >= 0 && sx < WIDTH && sy >= 0 && sy < HEIGHT) { const i = (sy * WIDTH + sx) * 4; r = rgba[i]; g = rgba[i + 1]; bl = rgba[i + 2]; }
		for (let dy = 0; dy < SCALE; dy++) for (let dx = 0; dx < SCALE; dx++) px((ox + x) * SCALE + dx, (oy + y) * SCALE + dy, r, g, bl);
	}
	for (const [ang, col] of [[res.aPred, [255, 160, 40]], [res.predicted, [255, 40, 40]], [res.trueA, [40, 220, 40]]])
		for (let t = 8; t < c1r + 10; t++) {
			const X = Math.round((ox + TILE / 2 + t * Math.cos(ang)) * SCALE), Y = Math.round((oy + TILE / 2 + t * Math.sin(ang)) * SCALE);
			for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) px(X + dx, Y + dy, ...col);
		}
});
writeFileSync(outPath, PNG.sync.write(png));
console.log('');
console.log('CROSS-COURSE HYPOTHESIS (to test on Lenard/TowneLake/Heritage/AlexClark):');
console.log('  reconstruction beats blindness exactly where the ring crosses the glyph outline;');
console.log('  elsewhere the lanes tie. If B < A anywhere, the alpha map is wrong there, not the idea.');
console.log('sheet: worst-first by lane B; orange=lane A, red=lane B, green=truth');
console.log(`render saved to ${outPath} — display alongside this receipt`);
