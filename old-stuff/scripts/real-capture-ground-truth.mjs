/**
 * Establishes ground-truth pairwise offsets for the real UDisc capture.
 *
 * Ad-hoc investigation tool (not a gate, not part of any test budget). It does a
 * deliberately brute-force coarse-to-fine ZNCC peak search over the full-
 * resolution cropped tiles, sharing no implementation with the matcher it is
 * meant to judge, and then reports how trustworthy each peak is:
 *
 *   - `score`: ZNCC at the peak (1.0 = structurally identical).
 *   - `mismatch`: fraction of overlapping pixels differing by more than 8/255.
 *     For screenshots of one map at one zoom the overlap should be essentially
 *     pixel-identical, so a low number here is the real proof of a correct
 *     offset. A high number with a high ZNCC means something is rendering
 *     differently between the two shots (e.g. repositioned vector labels).
 *   - `margin`: how far the peak stands above the best clearly-displaced
 *     alternative, i.e. whether the answer is actually unambiguous.
 *
 * Usage:
 *   node scripts/real-capture-ground-truth.mjs
 */
import {
	available,
	loadCroppedTiles,
	findBestOffset,
	zncc,
	mismatchFraction
} from '../tests/helpers/realCapture.js';

if (!available()) {
	console.error(
		'Real capture not found in resources/real-capture/ (TL/TR/BL/BR.PNG).\n' +
			'These are deliberately uncommitted; add them locally to run this tool.'
	);
	process.exit(1);
}

const tiles = loadCroppedTiles();
const first = tiles['upper-left'];
console.log(
	`Cropped tile size: ${first.widthPx}x${first.heightPx} (shared interior, chrome removed)\n`
);

// The four expected-neighbor edges, with a generous full-resolution search
// window around each one's plausible translation. Horizontal neighbors are
// searched across most of the tile width with a wide vertical slack, and vice
// versa, so the true answer is never assumed.
const W = first.widthPx;
const H = first.heightPx;
const edges = [
	{ from: 'upper-left', to: 'upper-right', range: { dxMin: 300, dxMax: W - 100, dyMin: -400, dyMax: 400 } },
	{ from: 'lower-left', to: 'lower-right', range: { dxMin: 300, dxMax: W - 100, dyMin: -400, dyMax: 400 } },
	{ from: 'upper-left', to: 'lower-left', range: { dxMin: -400, dxMax: 400, dyMin: 600, dyMax: H - 200 } },
	{ from: 'upper-right', to: 'lower-right', range: { dxMin: -400, dxMax: 400, dyMin: 600, dyMax: H - 200 } }
];

const results = {};
for (const edge of edges) {
	const a = tiles[edge.from];
	const b = tiles[edge.to];
	const best = findBestOffset(a, b, edge.range);
	const mismatch = mismatchFraction(a, b, best.dx, best.dy);

	// Best clearly-displaced alternative: at least 5% of a tile dimension away,
	// so a neighbouring near-tie does not masquerade as a rival answer.
	const minSep = Math.round(0.05 * Math.max(W, H));
	let rival = -Infinity;
	for (let dx = edge.range.dxMin; dx <= edge.range.dxMax; dx += 8) {
		for (let dy = edge.range.dyMin; dy <= edge.range.dyMax; dy += 8) {
			if (Math.abs(dx - best.dx) < minSep && Math.abs(dy - best.dy) < minSep) continue;
			const score = zncc(a, b, dx, dy, 4, 500);
			if (score !== null && score > rival) rival = score;
		}
	}

	results[`${edge.from}>${edge.to}`] = best;
	console.log(`${edge.from} -> ${edge.to}`);
	console.log(`  offset:   (${best.dx}, ${best.dy})`);
	console.log(`  zncc:     ${best.score.toFixed(4)}`);
	console.log(
		`  mismatch: ${(mismatch.fraction * 100).toFixed(2)}% of ${mismatch.overlapPx.toLocaleString()} overlapping px differ by >8/255`
	);
	console.log(`  margin:   ${(best.score - rival).toFixed(4)} over best displaced alternative (${rival.toFixed(4)})\n`);
}

// Absolute placements with upper-left anchored at the origin, in the same
// convention `assignFour` produces, so a test can compare directly.
const ur = results['upper-left>upper-right'];
const ll = results['upper-left>lower-left'];
const lrViaRight = results['upper-right>lower-right'];
const lrViaBottom = results['lower-left>lower-right'];

console.log('Absolute placements (upper-left anchored at 0,0):');
console.log(`  upper-right: (${ur.dx}, ${ur.dy})`);
console.log(`  lower-left:  (${ll.dx}, ${ll.dy})`);
console.log(
	`  lower-right via upper-right: (${ur.dx + lrViaRight.dx}, ${ur.dy + lrViaRight.dy})`
);
console.log(
	`  lower-right via lower-left:  (${ll.dx + lrViaBottom.dx}, ${ll.dy + lrViaBottom.dy})`
);
console.log(
	'\nThe two lower-right paths disagreeing is EXPECTED for a hand-held capture and is not an error;\n' +
		'it is only reported here so the ground-truth fixture records both.'
);
