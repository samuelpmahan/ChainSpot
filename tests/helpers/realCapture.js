/**
 * Node-side loader for the real UDisc capture (`resources/real-capture/`).
 *
 * These are the user's own screenshots, including a personal GPS track, so they
 * are deliberately NOT committed (`resources/` is gitignored). Every consumer
 * must therefore tolerate their absence: `available()` reports whether the set
 * is present, and tests skip rather than fail when it is not. CI and a fresh
 * clone stay green; a developer with the capture in place gets the real
 * regression coverage.
 *
 * Decoding is pure-JS (`pngjs`) so unit tests can read the real pixels directly
 * without booting a browser — that is what makes a tight matcher-iteration loop
 * possible at all.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

const captureDir = join(
	dirname(fileURLToPath(import.meta.url)),
	'..',
	'..',
	'resources',
	'real-capture'
);

/** Slot -> file name, per the capture's own naming. */
export const REAL_CAPTURE_FILES = {
	'upper-left': 'TL.PNG',
	'upper-right': 'TR.PNG',
	'lower-left': 'BL.PNG',
	'lower-right': 'BR.PNG'
};

export const REFERENCE_STITCH_FILE = 'ReferenceStitch.png';

/**
 * The shared chrome the capture carries: UDisc's status bar + title block at the
 * top and its bottom tab bar. These are the insets the app's own crop analyzer
 * independently proposes with high confidence for this set, restated here so a
 * matcher test can work on the same interior region without depending on the
 * crop analyzer being correct.
 */
export const REAL_CAPTURE_CROP = { topPx: 413, rightPx: 0, bottomPx: 251, leftPx: 0 };

/** True when the (uncommitted) real capture is present in this working copy. */
export function available() {
	return Object.values(REAL_CAPTURE_FILES).every((name) => existsSync(join(captureDir, name)));
}

export function referenceStitchAvailable() {
	return existsSync(join(captureDir, REFERENCE_STITCH_FILE));
}

/**
 * @typedef {{ widthPx: number, heightPx: number, gray: Uint8Array }} GrayImage
 */

/**
 * Decodes one capture file to full-resolution grayscale using the same
 * luminance weights as the app's `toAnalysisRaster`, so Node-side analysis and
 * browser-side analysis describe the same pixels.
 * @param {string} fileName
 * @returns {GrayImage}
 */
export function loadGray(fileName) {
	const png = PNG.sync.read(readFileSync(join(captureDir, fileName)));
	const { width, height, data } = png;
	const gray = new Uint8Array(width * height);
	for (let i = 0; i < width * height; i += 1) {
		const o = i * 4;
		gray[i] = Math.round(0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2]);
	}
	return { widthPx: width, heightPx: height, gray };
}

/**
 * Crops a grayscale image to the shared interior, removing the repeated chrome.
 * @param {GrayImage} image
 * @param {{topPx: number, rightPx: number, bottomPx: number, leftPx: number}} [crop]
 * @returns {GrayImage}
 */
export function cropGray(image, crop = REAL_CAPTURE_CROP) {
	const widthPx = image.widthPx - crop.leftPx - crop.rightPx;
	const heightPx = image.heightPx - crop.topPx - crop.bottomPx;
	const gray = new Uint8Array(widthPx * heightPx);
	for (let y = 0; y < heightPx; y += 1) {
		const src = (y + crop.topPx) * image.widthPx + crop.leftPx;
		gray.set(image.gray.subarray(src, src + widthPx), y * widthPx);
	}
	return { widthPx, heightPx, gray };
}

/** Loads all four tiles, cropped to the shared interior, keyed by slot. */
export function loadCroppedTiles() {
	/** @type {Record<string, GrayImage>} */
	const tiles = {};
	for (const [slot, name] of Object.entries(REAL_CAPTURE_FILES)) {
		tiles[slot] = cropGray(loadGray(name));
	}
	return tiles;
}

/**
 * Box-downsamples by an integer factor (averaging, so it is a genuine low-pass
 * step rather than nearest-neighbour decimation).
 * @param {GrayImage} image
 * @param {number} factor
 * @returns {GrayImage}
 */
export function downsample(image, factor) {
	if (factor <= 1) return image;
	const widthPx = Math.floor(image.widthPx / factor);
	const heightPx = Math.floor(image.heightPx / factor);
	const gray = new Uint8Array(widthPx * heightPx);
	for (let y = 0; y < heightPx; y += 1) {
		for (let x = 0; x < widthPx; x += 1) {
			let sum = 0;
			for (let dy = 0; dy < factor; dy += 1) {
				const row = (y * factor + dy) * image.widthPx + x * factor;
				for (let dx = 0; dx < factor; dx += 1) sum += image.gray[row + dx];
			}
			gray[y * widthPx + x] = Math.round(sum / (factor * factor));
		}
	}
	return { widthPx, heightPx, gray };
}

/**
 * Zero-mean normalized cross-correlation of `b` placed at `(dx, dy)` relative to
 * `a`, over their overlap only. Returns a value in [-1, 1] (1 = identical up to
 * brightness/contrast), or `null` when the overlap is too small to judge.
 *
 * ZNCC rather than the mean-absolute-difference the original matcher used:
 * aerial imagery is dominated by large low-contrast regions (grass, pavement),
 * where MAD produces a shallow, noisy optimum. Subtracting the mean and
 * dividing by the standard deviation makes the score depend on how well the
 * *structure* agrees, not on how similar the average brightness is.
 *
 * @param {GrayImage} a
 * @param {GrayImage} b
 * @param {number} dx
 * @param {number} dy
 * @param {number} [stride]
 * @param {number} [minOverlapPx]
 */
export function zncc(a, b, dx, dy, stride = 1, minOverlapPx = 2000) {
	const x0 = Math.max(0, dx);
	const x1 = Math.min(a.widthPx, b.widthPx + dx);
	const y0 = Math.max(0, dy);
	const y1 = Math.min(a.heightPx, b.heightPx + dy);
	if (x1 <= x0 || y1 <= y0) return null;

	let n = 0;
	let sumA = 0;
	let sumB = 0;
	let sumAA = 0;
	let sumBB = 0;
	let sumAB = 0;
	for (let y = y0; y < y1; y += stride) {
		const aRow = y * a.widthPx;
		const bRow = (y - dy) * b.widthPx;
		for (let x = x0; x < x1; x += stride) {
			const va = a.gray[aRow + x];
			const vb = b.gray[bRow + (x - dx)];
			n += 1;
			sumA += va;
			sumB += vb;
			sumAA += va * va;
			sumBB += vb * vb;
			sumAB += va * vb;
		}
	}
	if (n * stride * stride < minOverlapPx) return null;
	const meanA = sumA / n;
	const meanB = sumB / n;
	const varA = sumAA / n - meanA * meanA;
	const varB = sumBB / n - meanB * meanB;
	if (varA <= 1e-6 || varB <= 1e-6) return null;
	return (sumAB / n - meanA * meanB) / Math.sqrt(varA * varB);
}

/**
 * Fraction of overlapping pixels that differ by more than `tolerance`. A
 * near-zero value means the two tiles genuinely render the same content at this
 * offset, which is the real question for screenshots of one map at one zoom.
 * @param {GrayImage} a
 * @param {GrayImage} b
 * @param {number} dx
 * @param {number} dy
 * @param {number} [tolerance]
 */
export function mismatchFraction(a, b, dx, dy, tolerance = 8) {
	const x0 = Math.max(0, dx);
	const x1 = Math.min(a.widthPx, b.widthPx + dx);
	const y0 = Math.max(0, dy);
	const y1 = Math.min(a.heightPx, b.heightPx + dy);
	if (x1 <= x0 || y1 <= y0) return { fraction: 1, overlapPx: 0 };
	let differing = 0;
	let total = 0;
	for (let y = y0; y < y1; y += 1) {
		const aRow = y * a.widthPx;
		const bRow = (y - dy) * b.widthPx;
		for (let x = x0; x < x1; x += 1) {
			if (Math.abs(a.gray[aRow + x] - b.gray[bRow + (x - dx)]) > tolerance) differing += 1;
			total += 1;
		}
	}
	return { fraction: differing / total, overlapPx: total };
}

/**
 * Coarse-to-fine exhaustive ZNCC peak search over a pyramid, used to establish
 * ground truth independently of whatever matcher the app ships. Deliberately
 * brute force and slow: correctness here is the point, and it must not share an
 * implementation (or a bug) with the code it is meant to judge.
 *
 * @param {GrayImage} a
 * @param {GrayImage} b
 * @param {{dxMin: number, dxMax: number, dyMin: number, dyMax: number}} range full-resolution search bounds
 * @param {number[]} [pyramid] downsample factors, coarsest first
 */
export function findBestOffset(a, b, range, pyramid = [8, 4, 2, 1]) {
	let best = { dx: 0, dy: 0, score: -Infinity };
	let bounds = { ...range };

	for (const factor of pyramid) {
		const da = downsample(a, factor);
		const db = downsample(b, factor);
		const step = 1;
		const dxMin = Math.floor(bounds.dxMin / factor);
		const dxMax = Math.ceil(bounds.dxMax / factor);
		const dyMin = Math.floor(bounds.dyMin / factor);
		const dyMax = Math.ceil(bounds.dyMax / factor);

		let localBest = { dx: dxMin, dy: dyMin, score: -Infinity };
		for (let dx = dxMin; dx <= dxMax; dx += step) {
			for (let dy = dyMin; dy <= dyMax; dy += step) {
				const score = zncc(da, db, dx, dy, 1, 500);
				if (score !== null && score > localBest.score) localBest = { dx, dy, score };
			}
		}
		best = { dx: localBest.dx * factor, dy: localBest.dy * factor, score: localBest.score };
		// Next level refines within one coarse cell of this level's peak.
		const pad = factor * 2;
		bounds = {
			dxMin: best.dx - pad,
			dxMax: best.dx + pad,
			dyMin: best.dy - pad,
			dyMax: best.dy + pad
		};
	}
	return best;
}

/**
 * Ground-truth pairwise offsets for the real capture, established by
 * `scripts/real-capture-ground-truth.mjs` (brute-force coarse-to-fine ZNCC over
 * the full-resolution cropped tiles, sharing no code with the shipped matcher).
 *
 * Confidence in these numbers: every edge peaks at ZNCC 0.86-0.98 with a margin
 * of 0.55-0.62 over the best clearly-displaced alternative (i.e. unambiguous),
 * 1-5% of overlapping pixels differ by more than 8/255 (i.e. the tiles really do
 * render the same content there), and — the strongest check — the two
 * independent paths to lower-right, via upper-right and via lower-left, agree
 * on (666, 1607) exactly.
 *
 * Note the -246px horizontal drift on the upper-left -> lower-left edge: the
 * capture was panned diagonally by hand, which is ordinary user behaviour and
 * must not be treated as a defect.
 */
export const REAL_CAPTURE_GROUND_TRUTH = {
	edges: {
		'upper-left>upper-right': { dxPx: 822, dyPx: -90 },
		'lower-left>lower-right': { dxPx: 912, dyPx: -86 },
		'upper-left>lower-left': { dxPx: -246, dyPx: 1693 },
		'upper-right>lower-right': { dxPx: -156, dyPx: 1697 }
	},
	/** Absolute placements with upper-left anchored at the origin. */
	placements: {
		'upper-left': { xPx: 0, yPx: 0 },
		'upper-right': { xPx: 822, yPx: -90 },
		'lower-left': { xPx: -246, yPx: 1693 },
		'lower-right': { xPx: 666, yPx: 1607 }
	}
};
