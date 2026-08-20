import { extname, join, resolve, dirname } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import { IMG_5641_GROUND_TRUTH } from '../src/lib/autoAnnotation/courseGroundTruth';
import type { SourcePoint } from '../src/lib/domain/annotatedRound';
import { buildDashGroundTruth } from './corridorBendGroundTruth';

/**
 * Empirical measurement script (see task step 1): measures UDisc's
 * pre-rendered corridor-ribbon band's width and alpha-composite color
 * signature directly from pixels, on the real IMG_5641 fixture (using known
 * tee/basket/bend ground truth for direction), plus a width-only sanity
 * cross-check on ReferenceStitch.png at a different resolution/scale.
 *
 * This is a read-only analysis script -- it does not modify any fixture or
 * detector, and its numbers feed the design of
 * `src/lib/autoAnnotation/corridorBendDetectionRibbon.ts`.
 */

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = resolve(dirname(scriptPath), '..');

// ---------------------------------------------------------------------------
// Raster decoding -- same pattern as scripts/benchmark-corridor-bend-detection.ts.
// ---------------------------------------------------------------------------

interface DecodedRaster {
	readonly rgba: Uint8Array;
	readonly widthPx: number;
	readonly heightPx: number;
}

function decodeRaster(bytes: Uint8Array, fileName: string): DecodedRaster {
	const extension = extname(fileName).toLowerCase();
	if (extension === '.png') {
		const decoded = PNG.sync.read(Buffer.from(bytes));
		return { rgba: new Uint8Array(decoded.data), widthPx: decoded.width, heightPx: decoded.height };
	}
	if (extension === '.jpg' || extension === '.jpeg') {
		const decoded = jpeg.decode(Buffer.from(bytes), { useTArray: true });
		return { rgba: new Uint8Array(decoded.data), widthPx: decoded.width, heightPx: decoded.height };
	}
	throw new Error(`Unsupported image format '${extension}'.`);
}

function loadImage(path: string): DecodedRaster {
	return decodeRaster(new Uint8Array(readFileSync(path)), path);
}

function bilinearSample(raster: DecodedRaster, x: number, y: number): readonly [number, number, number] {
	const cx = Math.min(Math.max(x, 0), raster.widthPx - 1);
	const cy = Math.min(Math.max(y, 0), raster.heightPx - 1);
	const x0 = Math.floor(cx);
	const y0 = Math.floor(cy);
	const x1 = Math.min(raster.widthPx - 1, x0 + 1);
	const y1 = Math.min(raster.heightPx - 1, y0 + 1);
	const fx = cx - x0;
	const fy = cy - y0;
	const at = (xi: number, yi: number, channel: number): number => raster.rgba[(yi * raster.widthPx + xi) * 4 + channel];
	const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
	const sampleChannel = (channel: number): number => {
		const top = lerp(at(x0, y0, channel), at(x1, y0, channel), fx);
		const bottom = lerp(at(x0, y1, channel), at(x1, y1, channel), fx);
		return lerp(top, bottom, fy);
	};
	return [sampleChannel(0), sampleChannel(1), sampleChannel(2)];
}

function colorDistance(a: readonly [number, number, number], b: readonly [number, number, number]): number {
	const dr = a[0] - b[0];
	const dg = a[1] - b[1];
	const db = a[2] - b[2];
	return Math.sqrt(dr * dr + dg * dg + db * db);
}

function median(values: readonly number[]): number {
	const sorted = values.slice().sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function mean(values: readonly number[]): number {
	return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function stddev(values: readonly number[]): number {
	const m = mean(values);
	return Math.sqrt(mean(values.map((v) => (v - m) ** 2)));
}

// ---------------------------------------------------------------------------
// Cross-section geometry: perpendicular profile at a point t along a segment.
// ---------------------------------------------------------------------------

interface CrossSection {
	readonly center: SourcePoint;
	readonly perp: SourcePoint; // unit vector
	readonly offsets: readonly number[]; // s values, in px along perp
	readonly colors: readonly (readonly [number, number, number])[];
}

function sampleCrossSection(
	raster: DecodedRaster,
	a: SourcePoint,
	b: SourcePoint,
	t: number,
	halfLenPx: number,
	stepPx: number
): CrossSection | null {
	const dx = b.xPx - a.xPx;
	const dy = b.yPx - a.yPx;
	const len = Math.hypot(dx, dy);
	if (len < 1e-6) return null;
	const ux = dx / len;
	const uy = dy / len;
	// Perpendicular (rotate 90deg).
	const px = -uy;
	const py = ux;
	const center: SourcePoint = { xPx: a.xPx + ux * len * t, yPx: a.yPx + uy * len * t };

	const offsets: number[] = [];
	const colors: (readonly [number, number, number])[] = [];
	for (let s = -halfLenPx; s <= halfLenPx; s += stepPx) {
		const sx = center.xPx + px * s;
		const sy = center.yPx + py * s;
		if (sx < 0 || sx >= raster.widthPx || sy < 0 || sy >= raster.heightPx) continue;
		offsets.push(s);
		colors.push(bilinearSample(raster, sx, sy));
	}
	if (offsets.length < halfLenPx) return null; // too close to image edge to be useful
	return { center, perp: { xPx: px, yPx: py }, offsets, colors };
}

// ---------------------------------------------------------------------------
// Width measurement via FWHM-style edge detection.
// ---------------------------------------------------------------------------

interface WidthMeasurement {
	readonly leftEdgePx: number; // s value
	readonly rightEdgePx: number;
	readonly widthPx: number;
	readonly centerOffsetPx: number; // (left+right)/2 -- should be near 0 if tee-basket line is the band centerline
	readonly plateauContrast: number; // dPlateau - dBg, a confidence signal
	readonly backgroundColor: readonly [number, number, number]; // average of both sides
	readonly leftBackgroundColor: readonly [number, number, number];
	readonly rightBackgroundColor: readonly [number, number, number];
	readonly plateauColor: readonly [number, number, number];
}

// Real course photos are cluttered with high-contrast UI chrome besides the
// ribbon itself -- black number badges, white tee/basket icons, a dashed
// OB-circle outline, and a real (terrain, not overlay) mowed-green halo
// around each basket. None of those is the signal this script is after, and
// left unguarded they masquerade as huge, spurious "band" edges (a badge's
// near-black pixels read as a >100-unit color jump, dwarfing the ribbon's own
// real but subtle contrast). `isUniformZone` rejects any candidate zone that
// looks like it clips one of these instead of plain terrain: extreme
// brightness/darkness, or high internal variance (a sign the zone straddles
// an edge rather than sitting on uniform ground).
const DEFAULT_ZONES: WidthZoneParams = { outerLo: 45, outerHi: 70, inner: 8 };
const MAX_PLAUSIBLE_WIDTH_PX = 100;
const MIN_PLAUSIBLE_CONTRAST = 5;
const MAX_PLAUSIBLE_CONTRAST = 70;

interface WidthZoneParams {
	/** Off-band background sample zone, s in [outerLo, outerHi] on each side -- must clear the true band's edge. */
	readonly outerLo: number;
	readonly outerHi: number;
	/** On-band plateau sample zone, s in [-inner, inner] -- must stay inside the true band. */
	readonly inner: number;
}

function isUniformZone(indices: readonly number[], colors: readonly (readonly [number, number, number])[]): boolean {
	if (indices.length === 0) return false;
	for (const i of indices) {
		const [r, g, b] = colors[i];
		if (Math.min(r, g, b) < 35 || Math.max(r, g, b) > 232) return false;
	}
	for (let c = 0; c < 3; c += 1) {
		const values = indices.map((i) => colors[i][c]);
		if (stddev(values) > 22) return false;
	}
	return true;
}

function measureWidth(section: CrossSection, zones: WidthZoneParams = DEFAULT_ZONES): WidthMeasurement | null {
	const { offsets, colors } = section;
	const outerIdx = (side: 1 | -1): number[] =>
		offsets
			.map((s, i) => [s, i] as const)
			.filter(([s]) => side * s >= zones.outerLo && side * s <= zones.outerHi)
			.map(([, i]) => i);
	const leftOuter = outerIdx(-1);
	const rightOuter = outerIdx(1);
	if (leftOuter.length < 5 || rightOuter.length < 5) return null;
	if (!isUniformZone(leftOuter, colors) || !isUniformZone(rightOuter, colors)) return null;

	const channelMedian = (indices: readonly number[], channel: number): number =>
		median(indices.map((i) => colors[i][channel]));
	const leftBackgroundColor: readonly [number, number, number] = [
		channelMedian(leftOuter, 0),
		channelMedian(leftOuter, 1),
		channelMedian(leftOuter, 2)
	];
	const rightBackgroundColor: readonly [number, number, number] = [
		channelMedian(rightOuter, 0),
		channelMedian(rightOuter, 1),
		channelMedian(rightOuter, 2)
	];
	const backgroundColor: readonly [number, number, number] = [
		(leftBackgroundColor[0] + rightBackgroundColor[0]) / 2,
		(leftBackgroundColor[1] + rightBackgroundColor[1]) / 2,
		(leftBackgroundColor[2] + rightBackgroundColor[2]) / 2
	];

	const d = colors.map((c) => colorDistance(c, backgroundColor));
	const dBgSamples = [...leftOuter, ...rightOuter].map((i) => d[i]);
	const dBg = median(dBgSamples);

	const innerIdx = offsets.map((s, i) => [s, i] as const).filter(([s]) => Math.abs(s) <= zones.inner).map(([, i]) => i);
	if (!isUniformZone(innerIdx, colors)) return null;
	const dPlateau = median(innerIdx.map((i) => d[i]));
	const plateauColor: readonly [number, number, number] = [
		median(innerIdx.map((i) => colors[i][0])),
		median(innerIdx.map((i) => colors[i][1])),
		median(innerIdx.map((i) => colors[i][2]))
	];

	const plateauContrast = dPlateau - dBg;
	if (plateauContrast < MIN_PLAUSIBLE_CONTRAST || plateauContrast > MAX_PLAUSIBLE_CONTRAST) return null;

	const threshold = dBg + 0.5 * plateauContrast;
	const centerIdx = offsets.findIndex((s) => s === 0);
	if (centerIdx === -1) return null;

	// Walk outward from center; interpolate the crossing sub-pixel.
	function findEdge(direction: 1 | -1): number | null {
		let i = centerIdx;
		while (i >= 0 && i < offsets.length && d[i] >= threshold) i += direction;
		if (i < 0 || i >= offsets.length) return null;
		// i is first index below threshold; i-direction is last index >= threshold.
		const iAbove = i - direction;
		const sAbove = offsets[iAbove];
		const sBelow = offsets[i];
		const dAbove = d[iAbove];
		const dBelow = d[i];
		if (dAbove === dBelow) return sBelow;
		const frac = (threshold - dAbove) / (dBelow - dAbove);
		return sAbove + (sBelow - sAbove) * frac;
	}

	const leftEdgePx = findEdge(-1);
	const rightEdgePx = findEdge(1);
	if (leftEdgePx === null || rightEdgePx === null) return null;
	const widthPx = rightEdgePx - leftEdgePx;
	if (widthPx <= 0 || widthPx > MAX_PLAUSIBLE_WIDTH_PX) return null;

	return {
		leftEdgePx,
		rightEdgePx,
		widthPx,
		centerOffsetPx: (leftEdgePx + rightEdgePx) / 2,
		plateauContrast,
		backgroundColor,
		leftBackgroundColor,
		rightBackgroundColor,
		plateauColor
	};
}

// ---------------------------------------------------------------------------
// Phase 1: width measurement on IMG_5641's straight holes.
// ---------------------------------------------------------------------------

const STRAIGHT_HOLE_NUMBERS = [3, 6, 9, 10, 11, 12, 13, 16, 17];
const T_SAMPLES = [0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85];

function measureDashWidths(raster: DecodedRaster): WidthMeasurement[] {
	const holesByNumber = new Map(IMG_5641_GROUND_TRUTH.holes.map((h) => [h.number, h]));
	const results: WidthMeasurement[] = [];
	console.log('\n=== Dash (IMG_5641) straight-hole cross-section width measurements ===');
	console.log('(only cross-sections that clear the contamination guard -- see isUniformZone -- are shown; candidates')
	console.log(' rejected for crossing a badge/icon/OB-circle edge are silently skipped, tallied below)');
	console.log('hole | t    | width(px) | centerOffset(px) | plateauContrast | bg RGB           | plateau RGB');
	for (const number of STRAIGHT_HOLE_NUMBERS) {
		const hole = holesByNumber.get(number);
		if (!hole) continue;
		let accepted = 0;
		for (const t of T_SAMPLES) {
			const section = sampleCrossSection(raster, hole.tee, hole.basket, t, 80, 1);
			if (!section) continue;
			const w = measureWidth(section);
			if (!w) continue;
			accepted += 1;
			results.push(w);
			const fmt = (c: readonly [number, number, number]) => c.map((v) => v.toFixed(0)).join(',');
			console.log(
				`${String(number).padStart(4)} | ${t.toFixed(2)} | ${w.widthPx.toFixed(1).padStart(9)} | ${w.centerOffsetPx.toFixed(1).padStart(17)} | ${w.plateauContrast.toFixed(1).padStart(16)} | ${fmt(w.backgroundColor).padStart(16)} | ${fmt(w.plateauColor)}`
			);
		}
		console.log(`     (hole ${number}: ${accepted}/${T_SAMPLES.length} candidate cross-sections accepted)`);
	}
	return results;
}

// ---------------------------------------------------------------------------
// Phase 2: alpha/bandColor least-squares fit using (onBand, nearbyOffBand)
// pixel pairs pooled across many holes/segments/terrain types.
// ---------------------------------------------------------------------------

interface OnOffPair {
	readonly holeNumber: number;
	readonly onBand: readonly [number, number, number];
	readonly offBand: readonly [number, number, number];
}

/**
 * Pairs each accepted cross-section's contamination-filtered plateau (on-band)
 * color with its LEFT and RIGHT background (off-band) colors separately
 * (rather than the pre-averaged `backgroundColor`) -- two pairs per
 * cross-section, doubling the pool and letting genuinely different terrain on
 * either side of the same band both contribute their own data point. Reuses
 * `measureWidth`'s own contamination guard (`isUniformZone`, plausible-width/
 * contrast bounds) rather than re-deriving a separate, weaker check, so every
 * pair fed to the fit sits on a cross-section already confirmed to look like
 * plain terrain outside a real band, not a badge/icon/OB-circle edge.
 *
 * Segments are drawn from ALL 18 holes' tee-[bend...]-basket ground-truth
 * polylines (not just the 9 straight ones used for the width stat) --
 * spanning bent holes too is what supplies the terrain variety the task asks
 * for (different holes cross different lighting/ground-cover).
 */
function collectOnOffPairs(raster: DecodedRaster): OnOffPair[] {
	const truth = buildDashGroundTruth();
	const truthByNumber = new Map(truth.map((t) => [t.holeNumber, t]));
	const pairs: OnOffPair[] = [];

	for (const hole of IMG_5641_GROUND_TRUTH.holes) {
		const bendTruth = truthByNumber.get(hole.number);
		const polyline: SourcePoint[] = [hole.tee, ...(bendTruth?.truthBends ?? []), hole.basket];
		for (let i = 0; i < polyline.length - 1; i += 1) {
			const a = polyline[i];
			const b = polyline[i + 1];
			const segLen = Math.hypot(b.xPx - a.xPx, b.yPx - a.yPx);
			if (segLen < 100) continue; // too short to safely sample away from endpoints
			for (const t of T_SAMPLES) {
				const section = sampleCrossSection(raster, a, b, t, 80, 1);
				if (!section) continue;
				const w = measureWidth(section);
				if (!w) continue;
				pairs.push({ holeNumber: hole.number, onBand: w.plateauColor, offBand: w.leftBackgroundColor });
				pairs.push({ holeNumber: hole.number, onBand: w.plateauColor, offBand: w.rightBackgroundColor });
			}
		}
	}
	return pairs;
}

interface AlphaFitResult {
	readonly alpha: number;
	readonly bandColor: readonly [number, number, number];
	readonly rmse: number;
	readonly meanAbsError: number;
	readonly maxError: number;
	readonly n: number;
}

/**
 * Least-squares fit of the alpha-composite model
 * `onBand_c = alpha*bandColor_c + (1-alpha)*offBand_c` across all pooled
 * pairs and channels. Reparametrized as linear in (alpha, alpha*bandColor_r,
 * alpha*bandColor_g, alpha*bandColor_b) -- see module doc / task write-up for
 * the derivation -- then solved via the 4x4 normal equations.
 */
function fitAlphaComposite(pairs: readonly OnOffPair[]): AlphaFitResult {
	// Accumulate ATA (4x4, symmetric) and ATb (4) directly, since each row is
	// sparse: unknowns are [alpha, y_r, y_g, y_b] with y_c = alpha*bandColor_c.
	const ATA = Array.from({ length: 4 }, () => new Array(4).fill(0));
	const ATb = new Array(4).fill(0);
	let n = 0;
	for (const pair of pairs) {
		for (let c = 0; c < 3; c += 1) {
			const off = pair.offBand[c];
			const diff = pair.onBand[c] - off;
			// row: [-off, e_c] . [alpha, y_r,y_g,y_b] = diff
			const yIdx = 1 + c;
			ATA[0][0] += off * off;
			ATA[0][yIdx] += -off;
			ATA[yIdx][0] += -off;
			ATA[yIdx][yIdx] += 1;
			ATb[0] += -off * diff;
			ATb[yIdx] += diff;
			n += 1;
		}
	}

	const u = solve4x4(ATA, ATb);
	const alpha = u[0];
	const bandColor: [number, number, number] = [u[1] / alpha, u[2] / alpha, u[3] / alpha];

	const errors: number[] = [];
	for (const pair of pairs) {
		for (let c = 0; c < 3; c += 1) {
			const predicted = alpha * bandColor[c] + (1 - alpha) * pair.offBand[c];
			errors.push(Math.abs(predicted - pair.onBand[c]));
		}
	}
	const rmse = Math.sqrt(mean(errors.map((e) => e * e)));
	return { alpha, bandColor, rmse, meanAbsError: mean(errors), maxError: Math.max(...errors), n };
}

function solve4x4(A: number[][], b: number[]): number[] {
	const n = 4;
	const M = A.map((row, i) => [...row, b[i]]);
	for (let col = 0; col < n; col += 1) {
		let pivot = col;
		for (let row = col + 1; row < n; row += 1) if (Math.abs(M[row][col]) > Math.abs(M[pivot][col])) pivot = row;
		[M[col], M[pivot]] = [M[pivot], M[col]];
		const pivotVal = M[col][col];
		if (Math.abs(pivotVal) < 1e-12) throw new Error('Singular matrix in solve4x4');
		for (let k = col; k <= n; k += 1) M[col][k] /= pivotVal;
		for (let row = 0; row < n; row += 1) {
			if (row === col) continue;
			const factor = M[row][col];
			for (let k = col; k <= n; k += 1) M[row][k] -= factor * M[col][k];
		}
	}
	return M.map((row) => row[n]);
}

// ---------------------------------------------------------------------------
// ReferenceStitch.png cross-check: width-only, at manually-identified points
// (no ground truth exists for this fixture -- see the task write-up for how
// these were located).
// ---------------------------------------------------------------------------

interface ManualSegment {
	readonly label: string;
	readonly a: SourcePoint;
	readonly b: SourcePoint;
}

/**
 * Segment endpoints below are NOT ground truth (none exists for this fixture)
 * -- they started as rough manual picks (from gridded, downscaled crops; see
 * task write-up) that visibly sat near, but not exactly on, a straight ribbon
 * stretch, then were locally refined by nudging each endpoint perpendicular
 * to the tee-basket direction (independently, +-30px) to the offset that
 * maximizes plateau-vs-background contrast at t=0.3/0.4/0.5/0.6 -- the same
 * physical act as dragging an endpoint to visually align with the band, just
 * done by search instead of by eye. This is a same-fixture calibration of an
 * approximate manual pick, not a fabricated ground truth. `zones` uses a
 * tighter inner/outer split than IMG_5641's default -- this fixture's band
 * turned out much narrower (see report), so IMG_5641's +-8px inner zone would
 * itself straddle the band edge here.
 */
function measureReferenceStitchWidths(raster: DecodedRaster, segments: readonly ManualSegment[]): WidthMeasurement[] {
	const results: WidthMeasurement[] = [];
	const zones: WidthZoneParams = { outerLo: 25, outerHi: 45, inner: 3 };
	console.log('\n=== ReferenceStitch.png width cross-check (locally-refined segments, no ground truth exists) ===');
	console.log('segment              | t    | width(px) | centerOffset(px) | plateauContrast | bg RGB           | plateau RGB');
	for (const seg of segments) {
		let accepted = 0;
		for (const t of T_SAMPLES) {
			const section = sampleCrossSection(raster, seg.a, seg.b, t, 60, 1);
			if (!section) continue;
			const w = measureWidth(section, zones);
			if (!w) continue;
			accepted += 1;
			results.push(w);
			const fmt = (c: readonly [number, number, number]) => c.map((v) => v.toFixed(0)).join(',');
			console.log(
				`${seg.label.padEnd(20)} | ${t.toFixed(2)} | ${w.widthPx.toFixed(1).padStart(9)} | ${w.centerOffsetPx.toFixed(1).padStart(17)} | ${w.plateauContrast.toFixed(1).padStart(16)} | ${fmt(w.backgroundColor).padStart(16)} | ${fmt(w.plateauColor)}`
			);
		}
		console.log(`     (${seg.label}: ${accepted}/${T_SAMPLES.length} candidate cross-sections accepted)`);
	}
	return results;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function summarize(label: string, widths: readonly number[]): void {
	if (widths.length === 0) {
		console.log(`${label}: no usable measurements`);
		return;
	}
	console.log(
		`${label}: n=${widths.length}  mean=${mean(widths).toFixed(1)}px  median=${median(widths).toFixed(1)}px  ` +
			`stdev=${stddev(widths).toFixed(1)}px  min=${Math.min(...widths).toFixed(1)}px  max=${Math.max(...widths).toFixed(1)}px`
	);
}

async function main(): Promise<void> {
	const outputDir = resolve('/tmp/chainspot-corridor-band-measurement');
	mkdirSync(outputDir, { recursive: true });

	const dashPath = join(projectRoot, 'resources/ribbon-reference/IMG_5641.jpg');
	const dashRaster = loadImage(dashPath);
	console.log(`Loaded ${dashPath}: ${dashRaster.widthPx}x${dashRaster.heightPx}`);

	const dashWidths = measureDashWidths(dashRaster);
	summarize('\nDash (IMG_5641) straight-hole band width', dashWidths.map((w) => w.widthPx));
	summarize('Dash (IMG_5641) center offset from tee-basket line', dashWidths.map((w) => w.centerOffsetPx));

	const pairs = collectOnOffPairs(dashRaster);
	console.log(`Collected ${pairs.length} (onBand, offBand) pixel pairs across ${new Set(pairs.map((p) => p.holeNumber)).size} holes.`);
	const offBandLightnessSpread = pairs.map((p) => (p.offBand[0] + p.offBand[1] + p.offBand[2]) / 3);
	console.log(
		`Off-band sample terrain variety check: mean-channel value range ${Math.min(...offBandLightnessSpread).toFixed(0)}-${Math.max(...offBandLightnessSpread).toFixed(0)} ` +
			`(mean ${mean(offBandLightnessSpread).toFixed(0)}, stdev ${stddev(offBandLightnessSpread).toFixed(0)})`
	);

	const fit = fitAlphaComposite(pairs);
	console.log('\n=== Alpha-composite fit (least squares over pooled pairs) ===');
	console.log(`alpha = ${fit.alpha.toFixed(4)}`);
	console.log(`bandColor (RGB) = [${fit.bandColor.map((v) => v.toFixed(1)).join(', ')}]`);
	console.log(`n = ${fit.n} (channel-equations, ${fit.n / 3} pixel pairs)`);
	console.log(`RMSE = ${fit.rmse.toFixed(2)} (0-255 scale, per channel)`);
	console.log(`mean abs error = ${fit.meanAbsError.toFixed(2)}`);
	console.log(`max abs error = ${fit.maxError.toFixed(2)}`);

	// ReferenceStitch.png cross-check. Segments manually located by visual
	// inspection of downscaled/gridded crops (see task write-up) -- endpoints
	// are NOT claimed as precise tee/basket ground truth, just two points that
	// visibly sit on the same straight, clean ribbon stretch.
	const refPath = join(projectRoot, 'resources/real-capture/ReferenceStitch.png');
	const refRaster = loadImage(refPath);
	console.log(`\nLoaded ${refPath}: ${refRaster.widthPx}x${refRaster.heightPx}`);

	const refSegments: ManualSegment[] = [
		{ label: 'fairway-A (~h9 area)', a: { xPx: 249.4, yPx: 2689.8 }, b: { xPx: 390.3, yPx: 2761.1 } },
		{ label: 'fairway-B (~h13/14)', a: { xPx: 1237.0, yPx: 2918.0 }, b: { xPx: 512.2, yPx: 3084.2 } },
		{ label: 'short-C (~h13, noisier)', a: { xPx: 1202.8, yPx: 3006.6 }, b: { xPx: 1251.3, yPx: 3129.3 } }
	];
	const refWidths = measureReferenceStitchWidths(refRaster, refSegments);
	summarize('\nReferenceStitch.png band width', refWidths.map((w) => w.widthPx));

	const report = {
		dash: {
			widthMeasurements: dashWidths,
			alphaFit: fit,
			nPairs: pairs.length
		},
		referenceStitch: {
			widthMeasurements: refWidths
		}
	};
	writeFileSync(join(outputDir, 'measurement-report.json'), `${JSON.stringify(report, null, 2)}\n`);
	console.log(`\nFull report: ${join(outputDir, 'measurement-report.json')}`);
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
	process.exitCode = 1;
});
