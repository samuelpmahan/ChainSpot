// PCA compass: no muting at all. The 17 C1 ring profiles share a common mode
// (the upright sprite crossing the ring + the ring furniture itself -- both
// deterministic in tip-anchored angle), so subtract the cross-basket mean
// profile and the top-K PCA factors; what remains per basket is the stuff
// unique to that hole -- dominantly its path. Heading = max residual
// semicircle. Lost mass is modeled (the basket appears in the mean and is
// removed), not zeroed.
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { measureThreeFactor } from '../../../packages/alg/dist/detectors/threeFactor/index.js';

const require = createRequire(import.meta.url);
const { PNG } = require('pngjs');
const [rgbaPath, truthPath, outPath] = process.argv.slice(2);
const WIDTH = 1290, HEIGHT = 2083, DY = -4, K = 2;
const rgba = new Uint8ClampedArray(readFileSync(rgbaPath).buffer.slice(0));
const truth = JSON.parse(readFileSync(truthPath, 'utf8'));
const measurement = measureThreeFactor({ imageId: 'dashs-canonical', widthPx: WIDTH, heightPx: HEIGHT, rgba }, {});
const baskets = measurement.baskets.filter((b) => b.tier !== 'occlusion-recovery');
const NB = baskets.length;
const c1r = 46, SAMPLES = 360, BAND = 3;
const at = (x, y) => (Math.round(y) * WIDTH + Math.round(x)) * 4;

// Profile matrix: NB x (SAMPLES*3), raw ring colors, tip-anchored angles.
const D = SAMPLES * 3;
const P = baskets.map((b) => {
	const row = new Float64Array(D);
	for (let s = 0; s < SAMPLES; s++) {
		const th = (s / SAMPLES) * 2 * Math.PI;
		let n = 0, acc = [0, 0, 0];
		for (let dr = -BAND; dr <= BAND; dr++) {
			const x = b.tipXPx + (c1r + dr) * Math.cos(th), y = b.tipYPx + (c1r + dr) * Math.sin(th);
			if (x < 0 || x >= WIDTH || y < 0 || y >= HEIGHT) continue;
			const i = at(x, y);
			for (let c = 0; c < 3; c++) acc[c] += rgba[i + c];
			n++;
		}
		for (let c = 0; c < 3; c++) row[s * 3 + c] = n ? acc[c] / n : 0;
	}
	return row;
});
// Remove per-dimension mean (rank-0 common mode: sprite crossing + ring furniture).
const mean = new Float64Array(D);
for (const row of P) for (let d = 0; d < D; d++) mean[d] += row[d] / NB;
const X = P.map((row) => row.map((v, d) => v - mean[d]));
// Top-K PCA factors via Gram power iteration; deflate and record variance shares.
const gram = () => {
	const G = Array.from({ length: NB }, () => new Float64Array(NB));
	for (let i = 0; i < NB; i++) for (let j = 0; j < NB; j++) { let s = 0; for (let d = 0; d < D; d++) s += X[i][d] * X[j][d]; G[i][j] = s; }
	return G;
};
let total = 0;
for (const row of X) for (const v of row) total += v * v;
const shares = [];
for (let k = 0; k < K; k++) {
	const G = gram();
	let v = new Float64Array(NB).fill(1), lam = 0;
	for (let it = 0; it < 80; it++) {
		const w = new Float64Array(NB);
		for (let i = 0; i < NB; i++) for (let j = 0; j < NB; j++) w[i] += G[i][j] * v[j];
		lam = Math.hypot(...w); v = w.map((x) => x / (lam || 1));
	}
	// factor direction in profile space, then deflate rows.
	const f = new Float64Array(D);
	for (let i = 0; i < NB; i++) for (let d = 0; d < D; d++) f[d] += v[i] * X[i][d];
	const fn = Math.hypot(...f) || 1;
	for (let d = 0; d < D; d++) f[d] /= fn;
	let removed = 0;
	for (let i = 0; i < NB; i++) {
		let proj = 0;
		for (let d = 0; d < D; d++) proj += X[i][d] * f[d];
		removed += proj * proj;
		for (let d = 0; d < D; d++) X[i][d] -= proj * f[d];
	}
	shares.push(removed / total);
}
console.log('C1 PCA COMPASS (no muting)');
console.log(`profiles: ${NB} baskets x ${SAMPLES} angles x RGB; common mode removed = per-angle mean + ${K} factors (${shares.map((s) => (s * 100).toFixed(1) + '%').join(', ')} of centered variance)`);

// Heading from residual magnitude per angle; visibility is full so plain sum is fair.
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
const rows = baskets.map((b, i) => {
	const prof = new Float64Array(SAMPLES);
	for (let s = 0; s < SAMPLES; s++) prof[s] = Math.hypot(X[i][s * 3], X[i][s * 3 + 1], X[i][s * 3 + 2]);
	let bestA = 0, bestS = -1, oppS = 0;
	for (let s = 0; s < SAMPLES; s++) {
		let sum = 0;
		for (let d = -SAMPLES / 4; d < SAMPLES / 4; d++) sum += prof[(s + d + SAMPLES) % SAMPLES];
		if (sum > bestS) { bestS = sum; bestA = s; }
	}
	for (let d = -SAMPLES / 4; d < SAMPLES / 4; d++) oppS += prof[(bestA + SAMPLES / 2 + d + SAMPLES) % SAMPLES];
	const t = trueAngleFor(b);
	const predicted = (bestA / SAMPLES) * 2 * Math.PI;
	return { b, hole: t.hole, predicted, trueA: t.a, errDeg: err(predicted, t.a), margin: (bestS - oppS) / Math.max(1, bestS + oppS) };
});
const cs = rows.filter((r) => r.errDeg < 90).length, tw = rows.filter((r) => r.errDeg <= 20).length;
console.log(`PCA-residual heading: correct-side ${cs}/${NB}  <=20deg ${tw}/${NB}  (references: bbox 12/17, mute-all footprint 14/17)`);
for (const r of rows.slice().sort((a, b) => b.errDeg - a.errDeg))
	console.log(`  H${String(r.hole).padStart(2)} err=${r.errDeg.toFixed(1)}deg margin=${r.margin.toFixed(3)}`);

// Sheet worst-first: red=PCA heading, green=truth.
const sorted = rows.slice().sort((a, b) => b.errDeg - a.errDeg);
const TILE = 2 * (c1r + 12), SCALE = 2, COLS = 4;
const png = new PNG({ width: COLS * TILE * SCALE, height: Math.ceil(sorted.length / COLS) * TILE * SCALE });
png.data.fill(30);
const px = (Xp, Yp, r, g, b2) => { if (Xp < 0 || Yp < 0 || Xp >= png.width || Yp >= png.height) return; const i = (Yp * png.width + Xp) * 4; png.data[i] = r; png.data[i + 1] = g; png.data[i + 2] = b2; png.data[i + 3] = 255; };
sorted.forEach((res, k) => {
	const ox = (k % COLS) * TILE, oy = Math.floor(k / COLS) * TILE;
	for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
		const sx = Math.round(res.b.tipXPx) - TILE / 2 + x, sy = Math.round(res.b.tipYPx) - TILE / 2 + y;
		let r = 15, g = 15, bl = 15;
		if (sx >= 0 && sx < WIDTH && sy >= 0 && sy < HEIGHT) { const i = (sy * WIDTH + sx) * 4; r = rgba[i]; g = rgba[i + 1]; bl = rgba[i + 2]; }
		for (let dy = 0; dy < SCALE; dy++) for (let dx = 0; dx < SCALE; dx++) px((ox + x) * SCALE + dx, (oy + y) * SCALE + dy, r, g, bl);
	}
	for (const [ang, col] of [[res.predicted, [255, 40, 40]], [res.trueA, [40, 220, 40]]])
		for (let t = 8; t < c1r + 10; t++) {
			const Xp = Math.round((ox + TILE / 2 + t * Math.cos(ang)) * SCALE), Yp = Math.round((oy + TILE / 2 + t * Math.sin(ang)) * SCALE);
			for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) px(Xp + dx, Yp + dy, ...col);
		}
});
writeFileSync(outPath, PNG.sync.write(png));
console.log('sheet: worst-first; red=PCA-residual heading, green=truth; no pixels were muted -- the basket is removed as common mode');
console.log(`render saved to ${outPath} — display alongside this receipt`);
