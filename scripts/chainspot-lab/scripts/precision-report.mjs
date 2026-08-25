// First precision measurement of ChainSpot detection.
//
// Replaces "matched within 26px: 18/18" with a continuous score, because a
// binary at 26px discards the precision the annotations were authored with.
// Observed error on the one working oracle is 5-6px; the gate asks for 26.
//
// THREE THINGS THIS DOES THAT THE OLD ORACLE DID NOT
//
// 1. RECOVERS THE TRUTH OFFSET FROM DATA instead of trusting metadata.
//    The corpus annotations record source dimensions that no longer match
//    their images (only DashsTrack still does), so matchTruth returns null
//    and four of five courses silently never score. Rather than a tolerance
//    fudge, the translation between truth space and detection space is
//    estimated from the correspondences themselves: median of the
//    nearest-neighbour vectors, which is robust to outliers and needs no
//    threshold. A coherent offset proves the pairing; an incoherent one
//    proves truth belongs to a different raster. Self-validating.
//
// 2. BIPARTITE MATCHING, not nearest-neighbour. The old oracle loops over
//    truth points taking the closest detection each time, so ONE detection
//    can be claimed by TWO holes and both count as matched. With 41 tee
//    candidates for 18 holes that is a live bug. Hungarian assignment spends
//    each detection once and maximises total score globally.
//
// 3. CONTINUOUS SCORE, steepest near zero:
//       score(d) = max(0, 1 - ln(1+d)/ln(1+D))
//    The old 26 is not a pass line any more, it is where credit reaches zero.
//    Nothing that passed before newly fails; everything that passed is graded.
//    D is REPORTED ACROSS A RANGE here rather than chosen, because nobody has
//    seen this distribution before and picking D first would be guessing.
//
// Usage, from repo root through WSL with nvm:
//   node --import tsx scripts/chainspot-lab/scripts/precision-report.mjs

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import {
	DEFAULT_EXECUTION,
	parseConfig,
	resolveConfig,
	runThreeFactor,
	canonicalJson,
	sha256Hex
} from '@chainspot/alg/detectors/threeFactor';
import defaultConfigJson from '@chainspot/alg/detectors/threeFactor/configs/default.json' with { type: 'json' };

// scripts/chainspot-lab/scripts -> repo root is 3 up; corpus is a sibling of it.
const HERE = dirname(fileURLToPath(import.meta.url));
const CORPUS = resolve(HERE, '../../../../chainspot-corpus/dev/Annotated');
const D_VALUES = [8, 12, 26];

function decode(path) {
	const bytes = readFileSync(path);
	const imageId = createHash('sha256').update(bytes).digest('hex');
	if (extname(path).toLowerCase() === '.png') {
		const png = PNG.sync.read(bytes);
		return { imageId, widthPx: png.width, heightPx: png.height, rgba: new Uint8ClampedArray(png.data) };
	}
	const d = jpeg.decode(bytes, { useTArray: true, maxMemoryUsageInMB: 2048 });
	return { imageId, widthPx: d.width, heightPx: d.height, rgba: new Uint8ClampedArray(d.data.buffer, d.data.byteOffset, d.data.byteLength) };
}

const xy = (o) => (o == null ? null : { x: o.cxPx ?? o.cx ?? o.xPx, y: o.cyPx ?? o.cy ?? o.yPx });
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const median = (arr) => {
	if (!arr.length) return 0;
	const s = [...arr].sort((a, b) => a - b);
	const m = s.length >> 1;
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Median of nearest-neighbour vectors. Robust: needs no threshold. */
function recoverOffset(truthPts, detPts) {
	if (!truthPts.length || !detPts.length) return { dx: 0, dy: 0, spread: Infinity };
	const vx = [];
	const vy = [];
	for (const t of truthPts) {
		let best = null;
		let bd = Infinity;
		for (const d of detPts) {
			const dd = dist(t, d);
			if (dd < bd) { bd = dd; best = d; }
		}
		if (best) { vx.push(best.x - t.x); vy.push(best.y - t.y); }
	}
	const dx = median(vx);
	const dy = median(vy);
	// Spread = median absolute deviation. Small => coherent translation.
	const spread = median(vx.map((v, i) => Math.hypot(v - dx, vy[i] - dy)));
	return { dx, dy, spread };
}

/** Hungarian (Kuhn-Munkres) for rectangular cost matrices. Minimises cost. */
function hungarian(cost) {
	const n = cost.length;
	const m = cost[0]?.length ?? 0;
	if (!n || !m) return [];
	const INF = 1e18;
	const dim = Math.max(n, m);
	const a = Array.from({ length: dim }, (_, i) =>
		Array.from({ length: dim }, (_, j) => (i < n && j < m ? cost[i][j] : 0))
	);
	const u = new Array(dim + 1).fill(0);
	const v = new Array(dim + 1).fill(0);
	const p = new Array(dim + 1).fill(0);
	const way = new Array(dim + 1).fill(0);
	for (let i = 1; i <= dim; i++) {
		p[0] = i;
		let j0 = 0;
		const minv = new Array(dim + 1).fill(INF);
		const used = new Array(dim + 1).fill(false);
		do {
			used[j0] = true;
			const i0 = p[j0];
			let delta = INF;
			let j1 = 0;
			for (let j = 1; j <= dim; j++) {
				if (used[j]) continue;
				const cur = a[i0 - 1][j - 1] - u[i0] - v[j];
				if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
				if (minv[j] < delta) { delta = minv[j]; j1 = j; }
			}
			for (let j = 0; j <= dim; j++) {
				if (used[j]) { u[p[j]] += delta; v[j] -= delta; }
				else minv[j] -= delta;
			}
			j0 = j1;
		} while (p[j0] !== 0);
		do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0);
	}
	const assign = new Array(n).fill(-1);
	for (let j = 1; j <= dim; j++) if (p[j] >= 1 && p[j] <= n && j <= m) assign[p[j] - 1] = j - 1;
	return assign;
}

const score = (d, D) => Math.max(0, 1 - Math.log(1 + d) / Math.log(1 + D));

const courses = readdirSync(CORPUS, { withFileTypes: true })
	.filter((e) => e.isDirectory())
	.map((e) => {
		const dir = join(CORPUS, e.name);
		const files = readdirSync(dir);
		const ann = files.find((f) => f.endsWith('.annotation.json'));
		const img = files.find((f) => /\.(png|jpe?g)$/i.test(f));
		return ann && img ? { name: e.name, image: join(dir, img), annotation: join(dir, ann) } : null;
	})
	.filter(Boolean);

const resolved = resolveConfig(parseConfig(defaultConfigJson), DEFAULT_EXECUTION);
const paramsHash = await sha256Hex(canonicalJson(resolved));
console.log(`paramsHash=${paramsHash}`);
console.log(`courses=${courses.length}  score(d)=1-ln(1+d)/ln(1+D)\n`);

const allErrors = { tee: [], basket: [] };
const pathfinderTriggers = [];

for (const course of courses) {
	const truth = JSON.parse(readFileSync(course.annotation, 'utf8'));
	const raster = decode(course.image);
	let run;
	try {
		run = runThreeFactor(raster, { config: resolved, paramsHash });
	} catch (err) {
		console.log(`${course.name}: RUN FAILED -- ${err.message}\n`);
		continue;
	}
	const m = run.measurement ?? run;
	const dets = { basket: (m.baskets ?? []).map(xy).filter(Boolean), tee: (m.tees ?? []).map(xy).filter(Boolean) };

	console.log(`=== ${course.name} ===`);
	console.log(`  raster ${raster.widthPx}x${raster.heightPx}   truth records ${truth.sourceImage?.widthPx ?? '?'}x${truth.sourceImage?.heightPx ?? '?'}`);
	console.log(`  truth holes=${truth.holes.length}   detected baskets=${dets.basket.length} tees=${dets.tee.length}`);

	for (const kind of ['basket', 'tee']) {
		const tPts = truth.holes.map((h) => (h[kind] ? { x: h[kind].xPx, y: h[kind].yPx, hole: h.number } : null)).filter(Boolean);
		const dPts = dets[kind];
		if (!tPts.length || !dPts.length) { console.log(`  ${kind}: no data`); continue; }

		const off = recoverOffset(tPts, dPts);
		const shifted = tPts.map((t) => ({ ...t, x: t.x + off.dx, y: t.y + off.dy }));

		const cost = shifted.map((t) => dPts.map((d) => dist(t, d)));
		const assign = hungarian(cost);

		const errs = [];
		for (let i = 0; i < shifted.length; i++) {
			const j = assign[i];
			if (j < 0) { pathfinderTriggers.push(`${course.name} h${shifted[i].hole} ${kind}`); errs.push(Infinity); continue; }
			errs.push(cost[i][j]);
		}
		const finite = errs.filter(Number.isFinite);
		allErrors[kind].push(...finite);

		const sorted = [...finite].sort((a, b) => a - b);
		const p50 = sorted.length ? sorted[sorted.length >> 1] : NaN;
		const worst = sorted.length ? sorted[sorted.length - 1] : NaN;
		const scores = D_VALUES.map((D) => {
			const s = errs.map((e) => (Number.isFinite(e) ? score(e, D) : 0));
			return (s.reduce((a, b) => a + b, 0) / s.length).toFixed(3);
		});

		console.log(
			`  ${kind.padEnd(7)} offset=(${off.dx.toFixed(0)},${off.dy.toFixed(0)}) spread=${off.spread.toFixed(1)}px  ` +
			`err p50=${p50.toFixed(2)} worst=${worst.toFixed(2)}  ` +
			`score D8=${scores[0]} D12=${scores[1]} D26=${scores[2]}  ` +
			`unmatched=${errs.length - finite.length}`
		);
	}
	console.log('');
}

console.log('================ OVERALL ================');
for (const kind of ['basket', 'tee']) {
	const e = allErrors[kind].sort((a, b) => a - b);
	if (!e.length) { console.log(`${kind}: no measurements`); continue; }
	const q = (f) => e[Math.min(e.length - 1, Math.floor(f * e.length))].toFixed(2);
	console.log(`${kind.padEnd(7)} n=${String(e.length).padStart(3)}  p50=${q(0.5)}  p90=${q(0.9)}  worst=${e[e.length - 1].toFixed(2)}px`);
}
console.log(`\npathfinder triggers (missing objects): ${pathfinderTriggers.length}`);
for (const t of pathfinderTriggers) console.log(`  ${t}`);
