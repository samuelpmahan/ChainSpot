// C1 terminal compass v2 — factor ensemble over a muting ladder.
// Factors (each votes an angle or ABSTAINS):
//   F1 window   — sliding angular brightness-abnormality window whose width is
//                 DERIVED: 2*atan((W/2)/c1r) from the locally fitted hole width W.
//   F2 minRun   — sustained abnormal run crossing the annulus; arc length >= 10px
//                 defines an edge; no run, no vote.
//   F3 cap      — the path ribbon terminates in a visible semicircle of radius
//                 W/2 around the pole tip; the semicircle with sustained support
//                 at that radius is the incoming side.
// Muting ladder (same factors, three visibility regimes):
//   M0 control  — own basket muted by FULL BBOX (the naive historical control);
//   M1 border   — own basket muted by exact drawn-border ownership (bbox margin returns as evidence);
//   M2 all-owned— M1 plus every other object's owned pixels muted neutral.
// W is fitted locally: modal angular extent of abnormal runs across all baskets
// converted to px at c1r. Truth is used ONLY to score and order the sheet.
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { measureThreeFactor } from '../../../packages/alg/dist/detectors/threeFactor/index.js';
import { extractComponents } from '../../../packages/alg/dist/detectors/threeFactor/components.js';
import { acquireObjectGraphV1 } from '../../../packages/alg/dist/detectors/threeFactor/objects.js';

const require = createRequire(import.meta.url);
const { PNG } = require('pngjs');
const [rgbaPath, truthPath, outPath] = process.argv.slice(2);
const WIDTH = 1290, HEIGHT = 2083, DY = -4, MIN_RUN_PX = 10;
const rgba = new Uint8ClampedArray(readFileSync(rgbaPath).buffer.slice(0));
const truth = JSON.parse(readFileSync(truthPath, 'utf8'));

const measurement = measureThreeFactor({ imageId: 'dashs-canonical', widthPx: WIDTH, heightPx: HEIGHT, rgba }, {});
const bright = extractComponents(measurement.brightMask);
const dark = extractComponents(measurement.darkMask);
const graph = acquireObjectGraphV1(measurement, {
	width: WIDTH, height: HEIGHT,
	brightLabels: bright.labels, darkLabels: dark.labels,
	brightComponents: bright.components, darkComponents: dark.components
});
const baskets = measurement.baskets.filter((b) => b.tier !== 'occlusion-recovery');

// Ownership masks for the ladder.
const ownedByBasket = new Map(); // detId -> Set(packed)
const allOwned = new Uint8Array(WIDTH * HEIGHT);
for (const list of [graph.badges, graph.baskets, graph.tees])
	for (const o of list) {
		const asm = o.raster.componentAssembly;
		if (asm?.status !== 'assembled') continue;
		if (o.kind === 'basket') ownedByBasket.set(o.id, new Set(asm.ownedPixels));
		for (const p of asm.ownedPixels) allOwned[p] = 1;
	}
const basketGraphById = new Map(graph.baskets.map((o) => [o.id, o]));

const at = (x, y) => (Math.round(y) * WIDTH + Math.round(x)) * 4;
const packed = (x, y) => Math.round(y) * WIDTH + Math.round(x);
const luma = (i) => 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
const inBbox = (b, x, y, m = 3) => {
	const [gx, gy, gw, gh] = b.bbox;
	return x >= gx - m && x < gx + gw + m && y >= gy - m && y < gy + gh + m;
};

// C1 radius (as v1: aggregate radial edge, own-bbox neutral).
const edgeByR = new Float64Array(120);
for (const b of baskets)
	for (let r = 20; r < 118; r++) {
		let e = 0;
		for (let a = 0; a < 72; a++) {
			const th = (a / 72) * 2 * Math.PI;
			const x1 = b.tipXPx + (r - 1) * Math.cos(th), y1 = b.tipYPx + (r - 1) * Math.sin(th);
			const x2 = b.tipXPx + (r + 1) * Math.cos(th), y2 = b.tipYPx + (r + 1) * Math.sin(th);
			if (x2 < 1 || x2 >= WIDTH - 1 || y2 < 1 || y2 >= HEIGHT - 1 || x1 < 1 || y1 < 1) continue;
			if (inBbox(b, x2, y2) || inBbox(b, x1, y1)) continue;
			e += Math.abs(luma(at(x2, y2)) - luma(at(x1, y1)));
		}
		edgeByR[r] += e;
	}
let c1r = 20;
for (let r = 20; r < 118; r++) if (edgeByR[r] > edgeByR[c1r]) c1r = r;

const SAMPLES = 360, BAND = 3;
// Annulus abnormality profile under a muting regime. Muted samples are null (neutral).
function ringProfile(b, mute) {
	const colors = [];
	for (let a = 0; a < SAMPLES; a++) {
		const th = (a / SAMPLES) * 2 * Math.PI;
		let n = 0, rr = 0, gg = 0, bb = 0;
		for (let dr = -BAND; dr <= BAND; dr++) {
			const x = b.tipXPx + (c1r + dr) * Math.cos(th), y = b.tipYPx + (c1r + dr) * Math.sin(th);
			if (x < 0 || x >= WIDTH || y < 0 || y >= HEIGHT || mute(x, y)) continue;
			const i = at(x, y);
			rr += rgba[i]; gg += rgba[i + 1]; bb += rgba[i + 2]; n++;
		}
		colors.push(n ? [rr / n, gg / n, bb / n] : null);
	}
	const live = colors.filter(Boolean);
	const med = [0, 1, 2].map((c) => live.map((p) => p[c]).sort((x, y) => x - y)[live.length >> 1] ?? 0);
	const profile = colors.map((p) => (p ? Math.hypot(p[0] - med[0], p[1] - med[1], p[2] - med[2]) : null));
	const devs = profile.filter((v) => v !== null).sort((a, b2) => a - b2);
	const noise = devs[devs.length >> 1] ?? 0, hi = devs[Math.floor(devs.length * 0.9)] ?? 0;
	return { profile, noise, hi };
}
const circMean = (votes) => {
	let sx = 0, sy = 0;
	for (const v of votes) { sx += v.w * Math.cos(v.a); sy += v.w * Math.sin(v.a); }
	return Math.atan2(sy, sx);
};

// F1: sliding derived-width window over abnormality; abstain when flat.
function f1Window(P, windowSamples) {
	let bestA = -1, bestS = -1, total = 0, live = 0;
	for (const v of P.profile) if (v !== null) { total += v; live++; }
	if (!live) return null;
	for (let a = 0; a < SAMPLES; a++) {
		let s = 0, n = 0;
		for (let d = -windowSamples >> 1; d <= windowSamples >> 1; d++) {
			const v = P.profile[(a + d + SAMPLES) % SAMPLES];
			if (v !== null) { s += v; n++; }
		}
		if (n && s / n > bestS) { bestS = s / n; bestA = a; }
	}
	const mean = total / live;
	if (bestS < mean + 2 * (P.hi - P.noise) * 0.5) return null; // window not above ring texture
	return { a: (bestA / SAMPLES) * 2 * Math.PI, w: bestS / (mean || 1) };
}
// F2: longest sustained abnormal run; arc length >= MIN_RUN_PX.
function f2Run(P) {
	const th = P.noise + (P.hi - P.noise) * 0.75;
	let bestLen = 0, bestMid = -1;
	for (let start = 0; start < SAMPLES; start++) {
		if (P.profile[start] === null || P.profile[start] < th) continue;
		let len = 0;
		while (len < SAMPLES) {
			const v = P.profile[(start + len) % SAMPLES];
			if (v === null || v < th) break;
			len++;
		}
		if (len > bestLen) { bestLen = len; bestMid = start + len / 2; }
	}
	const arcPx = (bestLen / SAMPLES) * 2 * Math.PI * c1r;
	if (arcPx < MIN_RUN_PX) return null;
	return { a: (bestMid / SAMPLES) * 2 * Math.PI, w: Math.min(2, arcPx / MIN_RUN_PX), arcPx };
}
// F3: W/2 cap — semicircle support on the small circle of radius W/2 around the tip.
function f3Cap(b, mute, halfW) {
	const N = 180, vals = [];
	for (let a = 0; a < N; a++) {
		const th = (a / N) * 2 * Math.PI;
		const x = b.tipXPx + halfW * Math.cos(th), y = b.tipYPx + halfW * Math.sin(th);
		if (x < 0 || x >= WIDTH || y < 0 || y >= HEIGHT || mute(x, y)) { vals.push(null); continue; }
		vals.push(luma(at(x, y)));
	}
	const live = vals.filter((v) => v !== null);
	if (live.length < N / 3) return null;
	const med = live.slice().sort((a, b2) => a - b2)[live.length >> 1];
	let bestA = -1, bestS = -1;
	for (let a = 0; a < N; a++) {
		let s = 0, n = 0;
		for (let d = -N / 4; d < N / 4; d++) {
			const v = vals[(a + d + N) % N];
			if (v !== null) { s += Math.abs(v - med); n++; }
		}
		if (n > N / 6 && s / n > bestS) { bestS = s / n; bestA = a; }
	}
	if (bestA < 0 || bestS < 4) return null; // cap indistinct
	return { a: (bestA / N) * 2 * Math.PI, w: 1 };
}

// Fit local W: modal abnormal-run arc length across all baskets under M2 muting.
const muteM2own = (own) => (x, y) => {
	const p = packed(x, y);
	return allOwned[p] === 1;
};
const runArcs = [];
for (const b of baskets) {
	const P = ringProfile(b, muteM2own(null));
	const r2 = f2Run(P);
	if (r2) runArcs.push(r2.arcPx);
}
runArcs.sort((a, b) => a - b);
const W = runArcs.length ? runArcs[runArcs.length >> 1] : NaN;
const windowRad = 2 * Math.atan((W / 2) / c1r);
const windowSamples = Math.max(8, Math.round((windowRad / (2 * Math.PI)) * SAMPLES));
console.log('C1 TERMINAL COMPASS v2');
console.log(`c1r=${c1r}px (aggregate radial edge)`);
console.log(`local W fit: median abnormal-run arc = ${Number.isFinite(W) ? W.toFixed(1) : 'UNKNOWN'}px over ${runArcs.length} runs -> window ${(windowRad * 180 / Math.PI).toFixed(1)}deg (${windowSamples} samples), cap radius ${(W / 2).toFixed(1)}px`);

// The ladder.
const regimes = {
	'M0 bbox-control': (b, own) => (x, y) => inBbox(b, x, y),
	'M1 border-owned': (b, own) => (x, y) => own ? own.has(packed(x, y)) : inBbox(b, x, y),
	'M2 all-owned': (b, own) => (x, y) => allOwned[packed(x, y)] === 1 || (own === null && inBbox(b, x, y))
};
const trueAngleFor = (b) => {
	let best = null;
	for (const h of truth.holes) {
		const d = Math.hypot(h.basket.xPx - b.tipXPx, h.basket.yPx + DY - b.tipYPx);
		if (!best || d < best.d) best = { h, d };
	}
	const last = best.h.corridorBends.length ? best.h.corridorBends[best.h.corridorBends.length - 1] : best.h.tee;
	return { hole: best.h.number, a: Math.atan2(last.yPx + DY - b.tipYPx, last.xPx - b.tipXPx) };
};
const errDeg = (a, t) => Math.abs((((a - t) % (2 * Math.PI)) + 3 * Math.PI) % (2 * Math.PI) - Math.PI) * 180 / Math.PI;

const perRegime = {};
for (const [name, muteFor] of Object.entries(regimes)) {
	const rows = [];
	for (const b of baskets) {
		// own owned set: match graph basket by tip proximity (ids differ between measurement and graph lists).
		let own = null, bestD = 1e9;
		for (const [id, set] of ownedByBasket) {
			const g = basketGraphById.get(id);
			const [gx, gy, gw, gh] = g.raster.componentAssembly.bbox;
			const d = Math.hypot(gx + gw / 2 - b.centerXPx, gy + gh / 2 - b.centerYPx);
			if (d < bestD) { bestD = d; own = set; }
		}
		if (bestD > 40) own = null;
		const mute = muteFor(b, own);
		const P = ringProfile(b, mute);
		const votes = [];
		const v1 = f1Window(P, windowSamples); if (v1) votes.push({ ...v1, f: 'F1' });
		const v2 = f2Run(P); if (v2) votes.push({ ...v2, f: 'F2' });
		const v3 = Number.isFinite(W) ? f3Cap(b, mute, W / 2) : null; if (v3) votes.push({ ...v3, f: 'F3' });
		const t = trueAngleFor(b);
		if (!votes.length) { rows.push({ b, hole: t.hole, abstain: true, votes: [], trueA: t.a }); continue; }
		const a = circMean(votes);
		rows.push({ b, hole: t.hole, abstain: false, predicted: a, votes, trueA: t.a, errDeg: errDeg(a, t.a) });
	}
	perRegime[name] = rows;
	const voted = rows.filter((r) => !r.abstain);
	console.log(`${name}: voted ${voted.length}/${rows.length} (abstain ${rows.length - voted.length}); correct-side ${voted.filter((r) => r.errDeg < 90).length}/${voted.length}; <=20deg ${voted.filter((r) => r.errDeg <= 20).length}/${voted.length}`);
	for (const r of voted.slice().sort((x, y) => y.errDeg - x.errDeg).slice(0, 3))
		console.log(`   worst H${r.hole}: ${r.errDeg.toFixed(1)}deg via ${r.votes.map((v) => v.f).join('+')}`);
}

// Worst-first sheet for M2 (abstainers last, marked); red=prediction, green=truth, yellow ticks=factor votes.
const rows = perRegime['M2 all-owned'].slice().sort((x, y) => (y.abstain ? -1 : y.errDeg) - (x.abstain ? -1 : x.errDeg));
const TILE = 2 * (c1r + 12), SCALE = 2, COLS = 4;
const png = new PNG({ width: COLS * TILE * SCALE, height: Math.ceil(rows.length / COLS) * TILE * SCALE });
png.data.fill(30);
const px = (X, Y, r, g, b) => {
	if (X < 0 || Y < 0 || X >= png.width || Y >= png.height) return;
	const i = (Y * png.width + X) * 4;
	png.data[i] = r; png.data[i + 1] = g; png.data[i + 2] = b; png.data[i + 3] = 255;
};
rows.forEach((res, k) => {
	const ox = (k % COLS) * TILE, oy = Math.floor(k / COLS) * TILE;
	for (let y = 0; y < TILE; y++)
		for (let x = 0; x < TILE; x++) {
			const sx = Math.round(res.b.tipXPx) - TILE / 2 + x, sy = Math.round(res.b.tipYPx) - TILE / 2 + y;
			let r = 15, g = 15, bl = 15;
			if (sx >= 0 && sx < WIDTH && sy >= 0 && sy < HEIGHT) {
				const i = (sy * WIDTH + sx) * 4;
				r = rgba[i]; g = rgba[i + 1]; bl = rgba[i + 2];
			}
			for (let dy = 0; dy < SCALE; dy++) for (let dx = 0; dx < SCALE; dx++)
				px((ox + x) * SCALE + dx, (oy + y) * SCALE + dy, r, g, bl);
		}
	const ray = (ang, col, t0, t1) => {
		for (let t = t0; t < t1; t++) {
			const X = Math.round((ox + TILE / 2 + t * Math.cos(ang)) * SCALE), Y = Math.round((oy + TILE / 2 + t * Math.sin(ang)) * SCALE);
			for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) px(X + dx, Y + dy, ...col);
		}
	};
	for (const v of res.votes) ray(v.a, [255, 220, 40], c1r - 6, c1r + 8);
	ray(res.trueA, [40, 220, 40], 8, c1r + 10);
	if (res.abstain) { for (let t = 0; t < TILE / 3; t++) { ray(Math.PI / 4, [255, 120, 255], t, t + 1); ray((3 * Math.PI) / 4, [255, 120, 255], t, t + 1); } }
	else ray(res.predicted, [255, 40, 40], 8, c1r + 10);
});
writeFileSync(outPath, PNG.sync.write(png));
console.log('sheet: M2 worst-first; red=combined, green=truth, yellow=factor votes, magenta X=abstain');
console.log(`render saved to ${outPath} — display alongside this receipt`);
