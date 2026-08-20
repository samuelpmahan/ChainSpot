/**
 * Ad-hoc probe: does OpenCV `matchTemplate` (TM_CCOEFF_NORMED) recover the real
 * capture's ground-truth offsets WITHOUT any bounded cross-axis search window?
 *
 * This exists to de-risk the matcher rewrite before any pipeline refactor. The
 * bug it is testing for is specific: the original matcher constrained cross-axis
 * drift to +/-6% of a tile dimension (+/-77px here), while the real capture was
 * panned diagonally and needs -246px. No metric change can fix a search space
 * that excludes the answer, so the question is whether an unbounded
 * normalized-cross-correlation search finds it.
 *
 * Usage:
 *   node scripts/probe-cv-match.mjs
 */
import cvReady from '@techstark/opencv-js';
import {
	available,
	loadCroppedTiles,
	REAL_CAPTURE_GROUND_TRUTH,
	zncc
} from '../tests/helpers/realCapture.js';

if (!available()) {
	console.error('Real capture not found in resources/real-capture/.');
	process.exit(1);
}

const cv = await cvReady;
const tiles = loadCroppedTiles();

/** Wraps a grayscale image as a single-channel OpenCV Mat. */
function toMat(image) {
	const mat = new cv.Mat(image.heightPx, image.widthPx, cv.CV_8UC1);
	mat.data.set(image.gray);
	return mat;
}

/** Extracts a rectangular region as its own Mat (caller deletes it). */
function region(mat, x, y, width, height) {
	return mat.roi(new cv.Rect(x, y, width, height));
}

/**
 * Finds the translation of `b` relative to `a` by locating a template taken
 * from b's expected-overlap edge anywhere within the whole of a.
 *
 * The template is deliberately a modest fraction of the tile so the result map
 * spans a wide translation range: with a template of width tw, discoverable dx
 * runs from -tx to (aWidth - tw - tx), and likewise for y. No assumption is made
 * about how straight the user's pan was.
 */
function matchTranslation(a, b, orientation) {
	const aMat = toMat(a);
	const bMat = toMat(b);

	// Template anchored in the edge of b that should fall inside the overlap,
	// sized so the search range comfortably exceeds any plausible hand pan.
	let tx;
	let ty;
	let tw;
	let th;
	if (orientation === 'left-right') {
		tw = Math.round(b.widthPx * 0.22);
		th = Math.round(b.heightPx * 0.5);
		tx = 0;
		ty = Math.round(b.heightPx * 0.25);
	} else {
		tw = Math.round(b.widthPx * 0.5);
		th = Math.round(b.heightPx * 0.14);
		tx = Math.round(b.widthPx * 0.25);
		ty = 0;
	}

	const template = region(bMat, tx, ty, tw, th);
	const result = new cv.Mat();
	cv.matchTemplate(aMat, template, result, cv.TM_CCOEFF_NORMED);
	const mm = cv.minMaxLoc(result);

	const dxPx = mm.maxLoc.x - tx;
	const dyPx = mm.maxLoc.y - ty;
	const range = {
		dxMin: -tx,
		dxMax: a.widthPx - tw - tx,
		dyMin: -ty,
		dyMax: a.heightPx - th - ty
	};

	template.delete();
	result.delete();
	aMat.delete();
	bMat.delete();
	return { dxPx, dyPx, peak: mm.maxVal, range };
}

const edges = [
	{ key: 'upper-left>upper-right', from: 'upper-left', to: 'upper-right', orientation: 'left-right' },
	{ key: 'lower-left>lower-right', from: 'lower-left', to: 'lower-right', orientation: 'left-right' },
	{ key: 'upper-left>lower-left', from: 'upper-left', to: 'lower-left', orientation: 'top-bottom' },
	{ key: 'upper-right>lower-right', from: 'upper-right', to: 'lower-right', orientation: 'top-bottom' }
];

console.log('OpenCV matchTemplate (TM_CCOEFF_NORMED), unbounded search:\n');
let worst = 0;
for (const edge of edges) {
	const a = tiles[edge.from];
	const b = tiles[edge.to];
	const truth = REAL_CAPTURE_GROUND_TRUTH.edges[edge.key];
	const got = matchTranslation(a, b, edge.orientation);
	const errX = got.dxPx - truth.dxPx;
	const errY = got.dyPx - truth.dyPx;
	worst = Math.max(worst, Math.abs(errX), Math.abs(errY));

	console.log(`${edge.key} (${edge.orientation})`);
	console.log(`  truth:  (${truth.dxPx}, ${truth.dyPx})`);
	console.log(`  got:    (${got.dxPx}, ${got.dyPx})   peak=${got.peak.toFixed(4)}`);
	console.log(`  error:  (${errX >= 0 ? '+' : ''}${errX}, ${errY >= 0 ? '+' : ''}${errY}) px`);
	console.log(
		`  search range: dx ${got.range.dxMin}..${got.range.dxMax}, dy ${got.range.dyMin}..${got.range.dyMax}`
	);
	console.log(
		`  zncc at result vs truth: ${zncc(a, b, got.dxPx, got.dyPx, 2).toFixed(4)} vs ${zncc(a, b, truth.dxPx, truth.dyPx, 2).toFixed(4)}\n`
	);
}

console.log(`Worst per-axis error across all four edges: ${worst}px`);
console.log(
	worst <= 2
		? '=> matchTemplate recovers ground truth. The bounded search window was the defect.'
		: '=> Does NOT yet recover ground truth; template geometry or metric needs more work.'
);
