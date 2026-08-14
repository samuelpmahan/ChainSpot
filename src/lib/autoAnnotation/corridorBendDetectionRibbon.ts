/**
 * Third, EVALUATION-ONLY corridor-bend substrate -- and the first one built
 * on the correct premise. `corridorBendDetection.ts` (shipped) and
 * `corridorBendDetectionRibbonMass.ts` (eval-only) both try to infer a
 * hole's fairway SHAPE by classifying raw terrain pixels (grass color, or
 * whole-course lightness segmentation) as "open"/"traversable". That target
 * is wrong: the grey band visible between a hole's tee and basket on a UDisc
 * course-map screenshot is not terrain to infer at all -- it is UDisc's own
 * pre-rendered corridor overlay, already tracing the real hole path (bends
 * included), drawn semi-transparent grey over whatever is underneath via
 * ordinary alpha compositing:
 *
 *   observed = alpha * bandColor + (1 - alpha) * underlyingTerrainColor
 *
 * This module classifies pixels by how well they fit THAT model, not by raw
 * color similarity to a reference swatch and not by an abstract whole-course
 * lightness threshold. See `scripts/measure-corridor-band.ts` for the
 * empirical measurement this design is grounded in (run against
 * `resources/ribbon-reference/IMG_5641.jpg`, cross-checked against
 * `resources/real-capture/ReferenceStitch.png`): the band's pixel WIDTH
 * varies meaningfully by screenshot/zoom (measured ~39px median on IMG_5641,
 * ~9px median on ReferenceStitch at a different capture scale -- so width is
 * never assumed, only ever locally re-measured), while `alpha`/`bandColor`
 * are self-calibrated per hole rather than hard-coded from either photo (only
 * one of the two fixtures gave a clean, ground-truth-anchored fit -- see the
 * measurement report -- so nothing here assumes those numbers transfer to a
 * new screenshot; every hole recomputes both from its own crop).
 *
 * Pipeline, all self-calibrating per hole (no fixed cross-course thresholds):
 *  1. Sample (on-band, nearby off-band) color pairs near the tee and basket
 *     specifically -- NOT a ring in every direction (unlike
 *     `corridorBendDetection.ts`'s fairway-color ring: most directions around
 *     a tee/basket are just open terrain, not the band, so an all-directions
 *     ring would mostly mislabel terrain as "on-band"). Instead this samples
 *     along the tee<->basket direction close to each endpoint, on the
 *     reasonable assumption that a hole's rendered path starts out (and ends
 *     up) heading roughly toward the other endpoint even when it bends
 *     further out -- paired with an off-band reference sampled perpendicular
 *     to that direction, far enough out to clear the band (see
 *     `offBandOffsetSrcPx`).
 *  2. Fit `alpha`/`bandColor` by least squares over those pairs (linear once
 *     reparametrized -- see `fitAlphaComposite`'s doc comment). Bails out
 *     (returns no bends) if there aren't enough usable pairs or the fit comes
 *     out physically implausible (alpha outside (0,1)-ish, or NaN from a
 *     degenerate/singular fit) -- conservative by construction, matching the
 *     other two detectors' "propose nothing over propose something wrong"
 *     philosophy.
 *  3. Build a per-pixel LOCAL background estimate via a TRIMMED box-mean blur
 *     (see `trimmedBoxMean2D`) wide enough to mostly reflect surrounding
 *     terrain rather than the band itself (see `localBackgroundWindowSrcPx`),
 *     then classify each pixel by its residual distance from
 *     `alpha*bandColor + (1-alpha)*localBackground` -- small residual = fits
 *     the composite model = probably band. "Trimmed" (excludes obviously
 *     non-terrain pixels -- a dashed OB-circle outline, badge glyphs -- from
 *     the average) because a plain box mean lets a small but very
 *     high-contrast nearby UI feature measurably bias the background
 *     estimate at pixels well away from that feature itself; see
 *     `trimmedBoxMean2D`'s doc comment.
 *  4. Estimate the band's own local width directly from that mask by probing
 *     several candidate cross-section angles at each calibration point and
 *     keeping the SMALLEST (the band's true local "waist" -- see
 *     `measureMaskMinWidthAt`'s doc comment for why a single fixed
 *     tee<->basket-perpendicular probe is not safe near a sharp early bend),
 *     then use it as a plausibility filter: a binary morphological opening
 *     sized well UNDER the measured width strips out filaments/noise that
 *     could not plausibly be the band while preserving the band itself.
 *  5. Trace the shortest path through the cleaned mask and RDP-simplify it --
 *     reusing `traceShortestOpenPath`/`simplifyPolylineRDP` from
 *     `corridorBendDetection.ts` UNCHANGED, exactly like
 *     `corridorBendDetectionRibbonMass.ts` already does, not reimplemented.
 *
 * KNOWN LIMITATION, found and left honestly documented rather than papered
 * over: UDisc's course-map screenshots carry MORE than one semi-transparent
 * overlay near a basket -- the ribbon corridor itself, and Circle 1 (C1), the
 * standard disc golf ~10m/33ft putting-proximity ring UDisc renders as a
 * solid tinted fill around EVERY basket on EVERY hole (see
 * `docs/cv-udisc-rendered-ui-taxonomy.md`'s C1/C2 entry -- this is not an
 * occasional edge case, it is universal, the same way a basketball court
 * always has a free-throw semicircle). Measured directly (see the task
 * write-up): C1's fill composites into a similar mid-tone grey-green range as
 * the ribbon, at roughly a 90px radius on IMG_5641, so a hole whose fitted
 * `alpha`/`bandColor` happens to resemble C1's own blend will have its
 * residual mask swallow the circle's interior as if it were band.
 * `traceShortestOpenPath`'s detour-ratio guard usually keeps this from
 * producing an outright WRONG bend (an over-permissive blob rarely forms a
 * plausible direct path), but it means many genuinely bent holes near their
 * own basket's C1 ring collapse to "no path found" -- zero proposed bends --
 * rather than a correct dogleg. This is why this detector is very
 * conservative (see the benchmark numbers: it beats both other detectors'
 * false-bend rate) but currently recalls few real bends. Distinguishing
 * "ribbon" from "C1 fill" would need a signal this module does not yet use
 * (e.g. the ribbon's own measured WIDTH, since C1's fill is far wider than
 * any ribbon).
 *
 * Same output contract as the other two detectors: a plain `SourcePoint[]`,
 * ordered tee-to-basket, no confidence/provenance field ever attached (see
 * `annotatedRound.ts`'s provenance rule). This module is NOT wired into
 * `applyDetectedCorridorBends` or any live editing flow -- its only caller is
 * `scripts/benchmark-corridor-bend-detection.ts`.
 */
import type { SourcePoint } from '../domain/annotatedRound';
import { simplifyPolylineRDP, traceShortestOpenPath } from './corridorBendDetection';
import type { CorridorBendRaster } from './corridorBendDetection';

// ---------------------------------------------------------------------------
// Small geometry helpers -- same private conventions
// `corridorBendDetectionRibbonMass.ts` uses (re-declared, not imported,
// because they are unexported in `corridorBendDetection.ts` and that module
// must not be modified to add exports).
// ---------------------------------------------------------------------------

function polylineLength(points: readonly SourcePoint[]): number {
	let total = 0;
	for (let i = 1; i < points.length; i += 1) {
		total += Math.hypot(points[i].xPx - points[i - 1].xPx, points[i].yPx - points[i - 1].yPx);
	}
	return total;
}

function turnAngleDeg(a: SourcePoint, b: SourcePoint, c: SourcePoint): number {
	const v1x = b.xPx - a.xPx;
	const v1y = b.yPx - a.yPx;
	const v2x = c.xPx - b.xPx;
	const v2y = c.yPx - b.yPx;
	const len1 = Math.hypot(v1x, v1y);
	const len2 = Math.hypot(v2x, v2y);
	if (len1 === 0 || len2 === 0) return 0;
	const dot = (v1x * v2x + v1y * v2y) / (len1 * len2);
	return (Math.acos(Math.min(1, Math.max(-1, dot))) * 180) / Math.PI;
}

function filterByTurnAngle(simplified: readonly SourcePoint[], minTurnAngleDeg: number): SourcePoint[] {
	const interior = simplified.slice(1, -1);
	const kept: SourcePoint[] = [];
	for (let i = 0; i < interior.length; i += 1) {
		const prev = i === 0 ? simplified[0] : interior[i - 1];
		const current = interior[i];
		const next = i === interior.length - 1 ? simplified[simplified.length - 1] : interior[i + 1];
		if (turnAngleDeg(prev, current, next) >= minTurnAngleDeg) kept.push(current);
	}
	return kept;
}

function toLocal(raster: CorridorBendRaster, point: SourcePoint): SourcePoint {
	return { xPx: (point.xPx - raster.originXPx) / raster.scale, yPx: (point.yPx - raster.originYPx) / raster.scale };
}

function inBounds(raster: CorridorBendRaster, point: SourcePoint): boolean {
	return point.xPx >= 0 && point.xPx < raster.widthPx && point.yPx >= 0 && point.yPx < raster.heightPx;
}

type RGB = readonly [number, number, number];

function sampleNearest(raster: CorridorBendRaster, xPx: number, yPx: number): RGB {
	const xi = Math.min(raster.widthPx - 1, Math.max(0, Math.round(xPx)));
	const yi = Math.min(raster.heightPx - 1, Math.max(0, Math.round(yPx)));
	const p = (yi * raster.widthPx + xi) * raster.channels;
	return [raster.data[p], raster.data[p + 1], raster.data[p + 2]];
}

function colorDistance(a: RGB, b: RGB): number {
	const dr = a[0] - b[0];
	const dg = a[1] - b[1];
	const db = a[2] - b[2];
	return Math.sqrt(dr * dr + dg * dg + db * db);
}

// ---------------------------------------------------------------------------
// Step 1/2: self-calibration -- (on-band, nearby off-band) pairs near tee and
// basket, and the alpha-composite least-squares fit over them.
// ---------------------------------------------------------------------------

export interface OnOffColorPair {
	readonly onBand: RGB;
	readonly offBand: RGB;
}

/**
 * Samples calibration pairs near ONE endpoint (`fromLocal`), heading toward
 * the other (`towardLocal`): at each distance in `distancesLocalPx`
 * (already capped to the endpoint-to-endpoint length -- see call site), the
 * on-line point is the presumed on-band sample, and points offset
 * perpendicular to the line by +-`offBandOffsetLocalPx` are the off-band
 * (local terrain) reference. Skips any sample that would land outside the
 * raster.
 */
function collectPairsNearEndpoint(
	raster: CorridorBendRaster,
	fromLocal: SourcePoint,
	towardLocal: SourcePoint,
	distancesLocalPx: readonly number[],
	offBandOffsetLocalPx: number
): OnOffColorPair[] {
	const dx = towardLocal.xPx - fromLocal.xPx;
	const dy = towardLocal.yPx - fromLocal.yPx;
	const len = Math.hypot(dx, dy);
	if (len < 1e-6) return [];
	const ux = dx / len;
	const uy = dy / len;
	const px = -uy;
	const py = ux;

	const pairs: OnOffColorPair[] = [];
	for (const d of distancesLocalPx) {
		const cx = fromLocal.xPx + ux * d;
		const cy = fromLocal.yPx + uy * d;
		if (cx < 0 || cx >= raster.widthPx || cy < 0 || cy >= raster.heightPx) continue;
		const onBand = sampleNearest(raster, cx, cy);
		for (const side of [-1, 1] as const) {
			const ox = cx + px * side * offBandOffsetLocalPx;
			const oy = cy + py * side * offBandOffsetLocalPx;
			if (ox < 0 || ox >= raster.widthPx || oy < 0 || oy >= raster.heightPx) continue;
			pairs.push({ onBand, offBand: sampleNearest(raster, ox, oy) });
		}
	}
	return pairs;
}

export interface AlphaCompositeFit {
	readonly alpha: number;
	readonly bandColor: RGB;
	/** RMSE (0-255 scale, per channel) of the fit over the pairs it was built from. */
	readonly rmse: number;
	readonly pairCount: number;
}

function solve4x4(A: readonly (readonly number[])[], b: readonly number[]): number[] | null {
	const n = 4;
	const M = A.map((row, i) => [...row, b[i]]);
	for (let col = 0; col < n; col += 1) {
		let pivot = col;
		for (let row = col + 1; row < n; row += 1) if (Math.abs(M[row][col]) > Math.abs(M[pivot][col])) pivot = row;
		[M[col], M[pivot]] = [M[pivot], M[col]];
		const pivotVal = M[col][col];
		if (Math.abs(pivotVal) < 1e-9) return null; // singular -- not enough independent evidence to fit
		for (let k = col; k <= n; k += 1) M[col][k] /= pivotVal;
		for (let row = 0; row < n; row += 1) {
			if (row === col) continue;
			const factor = M[row][col];
			for (let k = col; k <= n; k += 1) M[row][k] -= factor * M[col][k];
		}
	}
	return M.map((row) => row[n]);
}

/**
 * Least-squares fit of `onBand_c = alpha*bandColor_c + (1-alpha)*offBand_c`
 * across all pooled pairs and channels. Reparametrized as linear in
 * `(alpha, alpha*bandColor_r, alpha*bandColor_g, alpha*bandColor_b)`: per
 * channel, `onBand_c - offBand_c = (alpha*bandColor_c) - alpha*offBand_c`,
 * linear in the four unknowns even though the original model is bilinear in
 * (alpha, bandColor). Solved via the 4x4 normal equations. Returns null when
 * there's not enough independent evidence to fit (fewer than 2 pairs) or the
 * system is singular (e.g. every off-band sample identical) -- callers must
 * treat null the same as "no calibration," not crash.
 */
export function fitAlphaComposite(pairs: readonly OnOffColorPair[]): AlphaCompositeFit | null {
	if (pairs.length < 2) return null;
	const ATA = Array.from({ length: 4 }, () => new Array(4).fill(0));
	const ATb = new Array(4).fill(0);
	for (const pair of pairs) {
		for (let c = 0; c < 3; c += 1) {
			const off = pair.offBand[c];
			const diff = pair.onBand[c] - off;
			const yIdx = 1 + c;
			ATA[0][0] += off * off;
			ATA[0][yIdx] += -off;
			ATA[yIdx][0] += -off;
			ATA[yIdx][yIdx] += 1;
			ATb[0] += -off * diff;
			ATb[yIdx] += diff;
		}
	}
	const u = solve4x4(ATA, ATb);
	if (!u) return null;
	const [alpha, yr, yg, yb] = u;
	if (!Number.isFinite(alpha) || Math.abs(alpha) < 1e-6) return null;
	const bandColor: RGB = [yr / alpha, yg / alpha, yb / alpha];
	if (bandColor.some((v) => !Number.isFinite(v))) return null;

	let sumSq = 0;
	let n = 0;
	for (const pair of pairs) {
		for (let c = 0; c < 3; c += 1) {
			const predicted = alpha * bandColor[c] + (1 - alpha) * pair.offBand[c];
			const err = predicted - pair.onBand[c];
			sumSq += err * err;
			n += 1;
		}
	}
	return { alpha, bandColor, rmse: Math.sqrt(sumSq / n), pairCount: pairs.length };
}

// ---------------------------------------------------------------------------
// Step 3: per-pixel local background (separable box mean, reflect boundary)
// and the residual-based mask.
//
// A dedicated O(width*height) sliding-window implementation, NOT the
// O(n*windowSize) `boxMeanReflect` in `ribbonMass.ts`: that module downscales
// to a whole-course evidence map first (its window is small relative to that
// already-shrunk image), where this module runs at a single hole's
// near-native-resolution crop with a window that can be a large fraction of
// the crop's own size -- the naive approach's extra `windowSize` factor is
// worth avoiding here, and keeping this module independent of ribbonMass.ts
// (a different, whole-course, admittedly-must-never-gate-production substrate)
// also keeps its cost story self-contained.
// ---------------------------------------------------------------------------

function reflectIndex(i: number, n: number): number {
	if (n === 1) return 0;
	let idx = i;
	while (idx < 0 || idx >= n) {
		if (idx < 0) idx = -1 - idx;
		else idx = 2 * n - 1 - idx;
	}
	return idx;
}

/** O(n) sliding-window box mean of one line, reflect-padded (scipy `uniform_filter` boundary convention). */
function boxMean1D(values: Float32Array, size: number): Float32Array {
	const n = values.length;
	if (size <= 1) return values.slice();
	const left = Math.floor(size / 2);
	const extLen = n + size - 1;
	const prefix = new Float64Array(extLen + 1);
	for (let i = 0; i < extLen; i += 1) {
		prefix[i + 1] = prefix[i] + values[reflectIndex(i - left, n)];
	}
	const out = new Float32Array(n);
	for (let i = 0; i < n; i += 1) out[i] = (prefix[i + size] - prefix[i]) / size;
	return out;
}

/** Separable 2-D box mean: `boxMean1D` along rows, then columns. */
function boxMean2D(plane: Float32Array, w: number, h: number, size: number): Float32Array {
	const afterRows = new Float32Array(plane.length);
	const rowBuf = new Float32Array(w);
	for (let y = 0; y < h; y += 1) {
		for (let x = 0; x < w; x += 1) rowBuf[x] = plane[y * w + x];
		const filtered = boxMean1D(rowBuf, size);
		for (let x = 0; x < w; x += 1) afterRows[y * w + x] = filtered[x];
	}
	const out = new Float32Array(plane.length);
	const colBuf = new Float32Array(h);
	for (let x = 0; x < w; x += 1) {
		for (let y = 0; y < h; y += 1) colBuf[y] = afterRows[y * w + x];
		const filtered = boxMean1D(colBuf, size);
		for (let y = 0; y < h; y += 1) out[y * w + x] = filtered[y];
	}
	return out;
}

/** Small (not necessarily O(n)) binary erosion/dilation extremum pass -- kernels here are small (a fraction of the measured band width), so the naive O(n*size) cost is negligible. Mirrors `ribbonMass.ts`'s `extremumPass`/`greyOpeningReflect`, re-declared rather than imported to keep this module's cost story independent (see the box-mean comment above) -- opening only (erode then dilate), which is all a plausibility filter needs. */
function extremum1D(values: Float32Array, size: number, sign: 1 | -1): Float32Array {
	const n = values.length;
	const left = Math.floor(size / 2);
	const out = new Float32Array(n);
	for (let i = 0; i < n; i += 1) {
		let best = sign * Infinity;
		for (let k = 0; k < size; k += 1) {
			const v = values[reflectIndex(i - left + k, n)];
			if (sign === 1 ? v < best : v > best) best = v;
		}
		out[i] = best;
	}
	return out;
}

function extremum2D(plane: Float32Array, w: number, h: number, size: number, sign: 1 | -1): Float32Array {
	const afterRows = new Float32Array(plane.length);
	const rowBuf = new Float32Array(w);
	for (let y = 0; y < h; y += 1) {
		for (let x = 0; x < w; x += 1) rowBuf[x] = plane[y * w + x];
		const filtered = extremum1D(rowBuf, size, sign);
		for (let x = 0; x < w; x += 1) afterRows[y * w + x] = filtered[x];
	}
	const out = new Float32Array(plane.length);
	const colBuf = new Float32Array(h);
	for (let x = 0; x < w; x += 1) {
		for (let y = 0; y < h; y += 1) colBuf[y] = afterRows[y * w + x];
		const filtered = extremum1D(colBuf, size, sign);
		for (let y = 0; y < h; y += 1) out[y * w + x] = filtered[y];
	}
	return out;
}

function binaryOpen(mask: Uint8Array, w: number, h: number, size: number): Uint8Array {
	if (size < 2) return mask.slice();
	const plane = Float32Array.from(mask);
	const eroded = extremum2D(plane, w, h, size, 1);
	const opened = extremum2D(eroded, w, h, size, -1);
	const out = new Uint8Array(mask.length);
	for (let i = 0; i < out.length; i += 1) out[i] = opened[i] >= 0.5 ? 1 : 0;
	return out;
}

function extractPlanes(raster: CorridorBendRaster): { r: Float32Array; g: Float32Array; b: Float32Array } {
	const n = raster.widthPx * raster.heightPx;
	const r = new Float32Array(n);
	const g = new Float32Array(n);
	const b = new Float32Array(n);
	for (let i = 0; i < n; i += 1) {
		const p = i * raster.channels;
		r[i] = raster.data[p];
		g[i] = raster.data[p + 1];
		b[i] = raster.data[p + 2];
	}
	return { r, g, b };
}

/** A pixel that is unambiguously UI chrome (a dashed OB-circle line, badge glyph) rather than any plausible terrain/band color -- measured directly: IMG_5641's dashed circle line samples at roughly RGB(230,234,241); every terrain and band/plateau color this module's design measured (`scripts/measure-corridor-band.ts`) sat well inside (15, 225). Deliberately a much wider "obviously not terrain" band than the band-color plausibility check below -- this one only needs to catch extremes, not discriminate band from background. */
function isLikelyChrome(r: number, g: number, b: number): boolean {
	return (r > 225 && g > 225 && b > 225) || (r < 15 && g < 15 && b < 15);
}

/**
 * Trimmed local background: a `windowRasterPx`-wide box mean that EXCLUDES
 * `isLikelyChrome` pixels from the average, computed as
 * `boxMean(maskedValue) / boxMean(validityIndicator)` (both box means share
 * the same window, so the `/windowSize` factors cancel, leaving the mean over
 * only the non-chrome pixels) -- falls back to the untrimmed box mean at any
 * pixel whose whole window happens to be chrome (validity mean ~0).
 *
 * A PLAIN box mean is the wrong tool here: real course screenshots carry
 * small but very high-contrast UI features (a dashed white OB-circle outline,
 * black number badges) near the corridor, and this module's background
 * window is necessarily large relative to the band (see
 * `localBackgroundWindowSrcPx`'s doc comment) -- large enough that even a
 * pixel nowhere near a chrome feature itself can have its background
 * estimate measurably pulled toward it. A plain per-pixel brightness guard on
 * the classified pixel alone does NOT fix this (that pixel's own color can be
 * perfectly plausible terrain; it is its NEIGHBORHOOD estimate that is
 * biased) -- trimming the window itself is what's needed.
 */
function trimmedBoxMean2D(plane: Float32Array, validity: Float32Array, w: number, h: number, size: number): Float32Array {
	const maskedPlane = new Float32Array(plane.length);
	for (let i = 0; i < plane.length; i += 1) maskedPlane[i] = plane[i] * validity[i];
	const maskedMean = boxMean2D(maskedPlane, w, h, size);
	const validityMean = boxMean2D(validity, w, h, size);
	const untrimmed = boxMean2D(plane, w, h, size); // fallback for the rare pixel whose whole window is chrome
	const out = new Float32Array(plane.length);
	for (let i = 0; i < plane.length; i += 1) {
		out[i] = validityMean[i] > 0.05 ? maskedMean[i] / validityMean[i] : untrimmed[i];
	}
	return out;
}

/**
 * Builds the residual-based band mask: 1 where a pixel's color sits within
 * `tolerancePx` of `alpha*bandColor + (1-alpha)*localBackground` (local
 * background = the TRIMMED box mean above) AND the pixel's own raw color
 * falls within `rawColorBounds`, 0 otherwise.
 *
 * The raw-color bound is a second, independent guard on the classified pixel
 * itself (as opposed to `trimmedBoxMean2D`'s guard on its neighborhood):
 * a loose or poorly-calibrated tolerance can otherwise let an extreme pixel
 * through on the residual test alone. Grounded in the same measurement as
 * `isLikelyChrome` -- every band/plateau color this module's design measured
 * sat in the ~110-165 range, well inside this bound.
 *
 * Exported standalone (raster + fit + explicit params, no self-calibration)
 * so it is unit-testable against a synthetic raster with a known composited
 * band, mirroring `buildTraversabilityMask` in `corridorBendDetection.ts`.
 */
export function buildResidualMask(
	raster: CorridorBendRaster,
	fit: Pick<AlphaCompositeFit, 'alpha' | 'bandColor'>,
	tolerancePx: number,
	windowRasterPx: number,
	rawColorBounds: readonly [number, number] = [20, 235]
): Uint8Array {
	const { r, g, b } = extractPlanes(raster);
	const size = Math.max(1, Math.round(windowRasterPx));
	const n0 = raster.widthPx * raster.heightPx;
	const validity = new Float32Array(n0);
	for (let i = 0; i < n0; i += 1) validity[i] = isLikelyChrome(r[i], g[i], b[i]) ? 0 : 1;
	const bgR = trimmedBoxMean2D(r, validity, raster.widthPx, raster.heightPx, size);
	const bgG = trimmedBoxMean2D(g, validity, raster.widthPx, raster.heightPx, size);
	const bgB = trimmedBoxMean2D(b, validity, raster.widthPx, raster.heightPx, size);

	const { alpha, bandColor } = fit;
	const [rawLo, rawHi] = rawColorBounds;
	const n = raster.widthPx * raster.heightPx;
	const open = new Uint8Array(n);
	for (let i = 0; i < n; i += 1) {
		const rv = r[i];
		const gv = g[i];
		const bv = b[i];
		if (Math.min(rv, gv, bv) < rawLo || Math.max(rv, gv, bv) > rawHi) continue;
		const predictedR = alpha * bandColor[0] + (1 - alpha) * bgR[i];
		const predictedG = alpha * bandColor[1] + (1 - alpha) * bgG[i];
		const predictedB = alpha * bandColor[2] + (1 - alpha) * bgB[i];
		const dr = rv - predictedR;
		const dg = gv - predictedG;
		const db = bv - predictedB;
		const residual = Math.sqrt(dr * dr + dg * dg + db * db);
		open[i] = residual <= tolerancePx ? 1 : 0;
	}
	return open;
}

// ---------------------------------------------------------------------------
// Step 4: local width estimate from the mask itself (plausibility filter).
// ---------------------------------------------------------------------------

/** Walks the binary mask along a given axis direction at `atLocal`, both ways, up to `maxWalkPx`. Returns the full open-run length in raster px along that axis, or null if `atLocal` itself isn't open. */
function measureMaskRunAlongAxis(
	open: Uint8Array,
	width: number,
	height: number,
	atLocal: SourcePoint,
	axisX: number,
	axisY: number,
	maxWalkPx: number
): number | null {
	const isOpenAt = (s: number): boolean => {
		const xi = Math.round(atLocal.xPx + axisX * s);
		const yi = Math.round(atLocal.yPx + axisY * s);
		if (xi < 0 || xi >= width || yi < 0 || yi >= height) return false;
		return open[yi * width + xi] === 1;
	};
	if (!isOpenAt(0)) return null;

	let leftExtent = 0;
	while (leftExtent < maxWalkPx && isOpenAt(-(leftExtent + 1))) leftExtent += 1;
	let rightExtent = 0;
	while (rightExtent < maxWalkPx && isOpenAt(rightExtent + 1)) rightExtent += 1;
	return leftExtent + rightExtent + 1;
}

const WIDTH_PROBE_ANGLE_COUNT = 8;

/**
 * Estimates the mask's own local "waist" width at `atLocal`: the SMALLEST
 * open-run length found by sweeping `WIDTH_PROBE_ANGLE_COUNT` candidate
 * cross-section directions (0..pi, since a direction and its opposite probe
 * the same axis) rather than assuming the true local band direction is
 * perpendicular to the tee<->basket line. That assumption holds near a
 * straight stretch but can be badly wrong near a sharp bend close to either
 * endpoint (the calibration points sit close to tee/basket specifically so
 * they land on real band, which is also where a sharp early turn is most
 * likely to throw off a single fixed-direction probe) -- probing several
 * angles and keeping the minimum finds the band's true narrow axis instead
 * of an inflated diagonal cross-section, which matters here because the
 * result directly sizes the opening kernel: an inflated width estimate would
 * size a kernel large enough to sever a genuine corridor at a corner.
 */
function measureMaskMinWidthAt(open: Uint8Array, width: number, height: number, atLocal: SourcePoint, maxWalkPx: number): number | null {
	let best: number | null = null;
	for (let k = 0; k < WIDTH_PROBE_ANGLE_COUNT; k += 1) {
		const theta = (Math.PI * k) / WIDTH_PROBE_ANGLE_COUNT;
		const run = measureMaskRunAlongAxis(open, width, height, atLocal, Math.cos(theta), Math.sin(theta), maxWalkPx);
		if (run !== null && (best === null || run < best)) best = run;
	}
	return best;
}

function median(values: readonly number[]): number | null {
	if (values.length === 0) return null;
	const sorted = values.slice().sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export interface DetectCorridorBendsRibbonParams {
	/** Source-px distances from each endpoint (tee, then basket), heading toward the other, sampled as presumed on-band calibration points. */
	readonly onBandDistancesSrcPx: readonly number[];
	/** Source-px perpendicular offset for the paired off-band (local terrain) reference sample. Should clear the band's own width -- see the measurement report; 80px clears every width measured on either fixture. */
	readonly offBandOffsetSrcPx: number;
	/** Caps the largest on-band distance to this fraction of the tee-basket straight-line length, so a very short hole doesn't sample past its own basket. */
	readonly maxOnBandFractionOfLength: number;
	/** Minimum (onBand, offBand) pairs required to attempt a fit; below this, propose nothing. */
	readonly minCalibrationPairs: number;
	/** Fitted alpha outside this range is treated as an implausible/degenerate fit (a real semi-transparent overlay is neither fully transparent nor fully opaque). */
	readonly alphaPlausibleRange: readonly [number, number];
	/** Local-background box-mean window, source px -- wider than any width measured on either fixture (max ~64px on IMG_5641) so surrounding terrain dominates over the band itself. */
	readonly localBackgroundWindowSrcPx: number;
	/** Per-pixel classification tolerance floor (0-255 color-distance units) and multiplier applied to the calibration fit's own RMSE, whichever is larger. */
	readonly toleranceFloorPx: number;
	readonly toleranceMultiplier: number;
	/** Binary opening kernel = measured local mask width / this divisor (kept well under the measured width so the true band survives the erosion step). */
	readonly openingKernelDivisor: number;
	readonly minOpeningKernelRasterPx: number;
	/** Max raster-px walk when measuring the mask's own local width. */
	readonly maxWidthWalkRasterPx: number;
	/** RDP epsilon, in SOURCE-image pixels (same validated ~10px the other two detectors use). */
	readonly rdpEpsilonPx: number;
	readonly minTurnAngleDeg: number;
	readonly maxDetourRatio: number;
	readonly maxBends: number;
	readonly searchRadiusPx: number;
}

/** Numeric values mirror `DEFAULT_CORRIDOR_BEND_PARAMS`/`DEFAULT_RIBBON_MASS_CORRIDOR_BEND_PARAMS` wherever the three substrates share a concept (RDP epsilon, turn-angle floor, detour ratio, bend cap, search radius), so a difference in benchmark results reflects the substrate, not a tuning mismatch. The rest (calibration distances, tolerance, window/kernel sizing) are grounded in `scripts/measure-corridor-band.ts`'s findings -- see that script and this module's doc comment. */
export const DEFAULT_CORRIDOR_BEND_RIBBON_PARAMS: DetectCorridorBendsRibbonParams = {
	onBandDistancesSrcPx: [28, 40, 52],
	offBandOffsetSrcPx: 80,
	maxOnBandFractionOfLength: 0.35,
	minCalibrationPairs: 6,
	alphaPlausibleRange: [0.05, 0.98],
	localBackgroundWindowSrcPx: 140,
	toleranceFloorPx: 14,
	toleranceMultiplier: 2.5,
	openingKernelDivisor: 3,
	minOpeningKernelRasterPx: 3,
	maxWidthWalkRasterPx: 120,
	rdpEpsilonPx: 10,
	minTurnAngleDeg: 12,
	maxDetourRatio: 1.6,
	maxBends: 3,
	searchRadiusPx: 20
};

/**
 * Proposes zero or more corridor bend points between `teeSrcPx` and
 * `basketSrcPx`, in source-image pixels, ordered tee-to-basket -- the
 * band-targeted sibling of `detectCorridorBends`/`detectCorridorBendsRibbonMass`.
 * Pure: takes an already-extracted raster, directly unit-testable with
 * synthetic crops (see the module's `.test.ts`).
 */
export function detectCorridorBendsRibbon(
	raster: CorridorBendRaster,
	teeSrcPx: SourcePoint,
	basketSrcPx: SourcePoint,
	params: DetectCorridorBendsRibbonParams = DEFAULT_CORRIDOR_BEND_RIBBON_PARAMS
): SourcePoint[] {
	const teeLocal = toLocal(raster, teeSrcPx);
	const basketLocal = toLocal(raster, basketSrcPx);
	if (!inBounds(raster, teeLocal) || !inBounds(raster, basketLocal)) return [];

	const straightLineSrcPx = Math.hypot(basketSrcPx.xPx - teeSrcPx.xPx, basketSrcPx.yPx - teeSrcPx.yPx);
	if (straightLineSrcPx <= 0) return [];
	const cappedMaxDistSrcPx = straightLineSrcPx * params.maxOnBandFractionOfLength;
	const distancesSrcPx = params.onBandDistancesSrcPx.filter((d) => d <= cappedMaxDistSrcPx);
	const distancesLocalPx = distancesSrcPx.map((d) => d / raster.scale);
	const offBandOffsetLocalPx = params.offBandOffsetSrcPx / raster.scale;

	const pairs = [
		...collectPairsNearEndpoint(raster, teeLocal, basketLocal, distancesLocalPx, offBandOffsetLocalPx),
		...collectPairsNearEndpoint(raster, basketLocal, teeLocal, distancesLocalPx, offBandOffsetLocalPx)
	];
	if (pairs.length < params.minCalibrationPairs) return [];

	const fit = fitAlphaComposite(pairs);
	if (!fit) return [];
	const [alphaLo, alphaHi] = params.alphaPlausibleRange;
	if (fit.alpha < alphaLo || fit.alpha > alphaHi) return [];
	if (fit.bandColor.some((c) => c < -20 || c > 275)) return []; // wildly outside byte range -> degenerate fit

	const windowRasterPx = Math.max(3, Math.round(params.localBackgroundWindowSrcPx / raster.scale));
	const tolerancePx = Math.max(params.toleranceFloorPx, fit.rmse * params.toleranceMultiplier);
	let open = buildResidualMask(raster, fit, tolerancePx, windowRasterPx);

	// Plausibility filter: estimate the mask's own local width near the
	// calibration points and strip anything narrower than a conservative
	// fraction of it (binary opening) -- a "band" much narrower than the
	// measured local width is more likely noise than a real corridor.
	const widthSamples: number[] = [];
	for (const [fromLocal, towardLocal] of [
		[teeLocal, basketLocal],
		[basketLocal, teeLocal]
	] as const) {
		for (const d of distancesLocalPx) {
			const dx = towardLocal.xPx - fromLocal.xPx;
			const dy = towardLocal.yPx - fromLocal.yPx;
			const len = Math.hypot(dx, dy);
			if (len < 1e-6) continue;
			const atLocal: SourcePoint = { xPx: fromLocal.xPx + (dx / len) * d, yPx: fromLocal.yPx + (dy / len) * d };
			const w = measureMaskMinWidthAt(open, raster.widthPx, raster.heightPx, atLocal, params.maxWidthWalkRasterPx);
			if (w !== null) widthSamples.push(w);
		}
	}
	const widthEstimateRasterPx = median(widthSamples);
	if (widthEstimateRasterPx !== null) {
		const kernel = Math.max(params.minOpeningKernelRasterPx, Math.round(widthEstimateRasterPx / params.openingKernelDivisor));
		open = binaryOpen(open, raster.widthPx, raster.heightPx, kernel);
	}

	const searchRadiusLocalPx = Math.max(4, Math.round(params.searchRadiusPx / raster.scale));
	const path = traceShortestOpenPath(open, raster.widthPx, raster.heightPx, teeLocal, basketLocal, searchRadiusLocalPx);
	if (!path || path.length < 2) return [];

	const straightDistanceLocal = Math.hypot(basketLocal.xPx - teeLocal.xPx, basketLocal.yPx - teeLocal.yPx);
	if (straightDistanceLocal <= 0) return [];
	const detourRatio = polylineLength(path) / straightDistanceLocal;
	if (detourRatio > params.maxDetourRatio) return [];

	const simplified = simplifyPolylineRDP(path, params.rdpEpsilonPx / raster.scale);
	if (simplified.length <= 2) return [];

	const bends = filterByTurnAngle(simplified, params.minTurnAngleDeg).slice(0, params.maxBends);
	if (bends.length === 0) return [];

	return bends.map((point) => ({
		xPx: point.xPx * raster.scale + raster.originXPx,
		yPx: point.yPx * raster.scale + raster.originYPx
	}));
}
