// Recreation of the superseded C1-only "basket backwards" probe (11b7bcc named
// it throwaway glue; the dual-trace doc attests C1 polarity picked the correct
// 180-degree end 14/14 on NorthPark). C1 gives polarity, not just an axis:
// the incoming side carries the stem/altered composite entering the circle,
// the far side is plain ring. Decision is truth-blind per basket (ring pixels
// only); truth supplies only the evaluation angle and the worst-first order.
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { measureThreeFactor } from '../../../packages/alg/dist/detectors/threeFactor/index.js';

const require = createRequire(import.meta.url);
const { PNG } = require('pngjs');

const [rgbaPath, truthPath, outPath] = process.argv.slice(2);
const WIDTH = 1290, HEIGHT = 2083, DY = -4; // canonical = original + (0, -4) per sweep receipt insets 4/0/4/0
const rgba = new Uint8ClampedArray(readFileSync(rgbaPath).buffer.slice(0));
const truth = JSON.parse(readFileSync(truthPath, 'utf8'));

const measurement = measureThreeFactor({ imageId: 'dashs-canonical', widthPx: WIDTH, heightPx: HEIGHT, rgba }, {});
const baskets = measurement.baskets.filter((b) => b.tier !== 'occlusion-recovery');
console.log('C1 POLARITY PROBE (recreated)');
console.log(`baskets from measurement: ${baskets.length}`);

const luma = (i) => 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
const at = (x, y) => (Math.round(y) * WIDTH + Math.round(x)) * 4;
const inGlyph = (b, x, y) => {
	const [gx, gy, gw, gh] = b.bbox;
	return x >= gx - 3 && x < gx + gw + 3 && y >= gy - 3 && y < gy + gh + 3;
};

// Course C1 radius: strongest aggregate radial luma edge across all baskets.
const edgeByR = new Float64Array(120);
for (const b of baskets)
	for (let r = 20; r < 118; r++) {
		let e = 0;
		for (let a = 0; a < 72; a++) {
			const th = (a / 72) * 2 * Math.PI;
			const x1 = b.tipXPx + (r - 1) * Math.cos(th), y1 = b.tipYPx + (r - 1) * Math.sin(th);
			const x2 = b.tipXPx + (r + 1) * Math.cos(th), y2 = b.tipYPx + (r + 1) * Math.sin(th);
			if (x2 < 1 || x2 >= WIDTH - 1 || y2 < 1 || y2 >= HEIGHT - 1 || x1 < 1 || y1 < 1) continue;
			if (inGlyph(b, x2, y2) || inGlyph(b, x1, y1)) continue;
			e += Math.abs(luma(at(x2, y2)) - luma(at(x1, y1)));
		}
		edgeByR[r] += e;
	}
let c1r = 20;
for (let r = 20; r < 118; r++) if (edgeByR[r] > edgeByR[c1r]) c1r = r;
console.log(`course C1 radius estimate: ${c1r}px (max aggregate radial edge; runner-up ${
	[...edgeByR.keys()].filter((r) => r >= 20 && Math.abs(r - c1r) > 4).sort((a, b) => edgeByR[b] - edgeByR[a])[0]}px)`);

// Per-basket blind polarity from the C1 annulus band only.
const SAMPLES = 360, BAND = 3;
const results = [];
for (const b of baskets) {
	const profile = new Float64Array(SAMPLES);
	const colors = [];
	for (let a = 0; a < SAMPLES; a++) {
		const th = (a / SAMPLES) * 2 * Math.PI;
		let n = 0, rr = 0, gg = 0, bb = 0;
		for (let dr = -BAND; dr <= BAND; dr++) {
			const x = b.tipXPx + (c1r + dr) * Math.cos(th), y = b.tipYPx + (c1r + dr) * Math.sin(th);
			if (x < 0 || x >= WIDTH || y < 0 || y >= HEIGHT) continue;
			const i = at(x, y);
			rr += rgba[i]; gg += rgba[i + 1]; bb += rgba[i + 2]; n++;
		}
		colors.push(n ? [rr / n, gg / n, bb / n] : null);
	}
	const med = [0, 1, 2].map((c) => {
		const v = colors.filter(Boolean).map((p) => p[c]).sort((x, y) => x - y);
		return v[v.length >> 1];
	});
	for (let a = 0; a < SAMPLES; a++) {
		const p = colors[a];
		profile[a] = p ? Math.hypot(p[0] - med[0], p[1] - med[1], p[2] - med[2]) : 0;
	}
	let bestA = 0, bestS = -1, oppS = 0;
	for (let a = 0; a < SAMPLES; a++) {
		let s = 0;
		for (let d = -SAMPLES / 4; d < SAMPLES / 4; d++) s += profile[(a + d + SAMPLES) % SAMPLES];
		if (s > bestS) { bestS = s; bestA = a; }
	}
	for (let d = -SAMPLES / 4; d < SAMPLES / 4; d++) oppS += profile[(bestA + SAMPLES / 2 + d + SAMPLES) % SAMPLES];
	const predicted = (bestA / SAMPLES) * 2 * Math.PI;
	results.push({ b, predicted, margin: (bestS - oppS) / Math.max(1, bestS + oppS) });
}

// Truth evaluation: incoming = basket -> last pre-basket path point.
for (const r of results) {
	let best = null;
	for (const h of truth.holes) {
		const bx = h.basket.xPx, by = h.basket.yPx + DY;
		const d = Math.hypot(bx - r.b.tipXPx, by - r.b.tipYPx);
		if (!best || d < best.d) best = { h, d };
	}
	const h = best.h;
	const last = h.corridorBends.length ? h.corridorBends[h.corridorBends.length - 1] : h.tee;
	const trueA = Math.atan2(last.yPx + DY - r.b.tipYPx, last.xPx - r.b.tipXPx);
	let err = Math.abs(((r.predicted - trueA) % (2 * Math.PI) + 3 * Math.PI) % (2 * Math.PI) - Math.PI) * 180 / Math.PI;
	Object.assign(r, { hole: h.number, truthDistPx: best.d, trueA, errDeg: err, bends: h.corridorBends.length });
}
results.sort((a, b) => b.errDeg - a.errDeg);
const within = (d) => results.filter((r) => r.errDeg <= d).length;
console.log(`polarity (correct 180-side): ${results.filter((r) => r.errDeg < 90).length}/${results.length};  <=20deg: ${within(20)}/${results.length}`);
for (const r of results)
	console.log(`H${String(r.hole).padStart(2)} err=${r.errDeg.toFixed(1)}deg margin=${r.margin.toFixed(3)} bends=${r.bends} truthMatchDist=${r.truthDistPx.toFixed(1)}px`);

// Worst-first contact sheet: red = predicted incoming, green = truth incoming.
const TILE = 2 * (c1r + 12), SCALE = 2, COLS = 4;
const rows = Math.ceil(results.length / COLS);
const png = new PNG({ width: COLS * TILE * SCALE, height: rows * TILE * SCALE });
png.data.fill(30);
function px(X, Y, r, g, b) {
	if (X < 0 || Y < 0 || X >= png.width || Y >= png.height) return;
	const i = (Y * png.width + X) * 4;
	png.data[i] = r; png.data[i + 1] = g; png.data[i + 2] = b; png.data[i + 3] = 255;
}
results.forEach((res, k) => {
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
	for (const [ang, col] of [[res.predicted, [255, 40, 40]], [res.trueA, [40, 220, 40]]])
		for (let t = 8; t < c1r + 10; t++) {
			const X = Math.round((ox + TILE / 2 + t * Math.cos(ang)) * SCALE), Y = Math.round((oy + TILE / 2 + t * Math.sin(ang)) * SCALE);
			for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) px(X + dx, Y + dy, ...col);
		}
});
writeFileSync(outPath, PNG.sync.write(png));
console.log('sheet order: worst-first (top-left = biggest polarity error); red=predicted incoming, green=truth incoming');
console.log(`render saved to ${outPath} — display alongside this receipt`);
