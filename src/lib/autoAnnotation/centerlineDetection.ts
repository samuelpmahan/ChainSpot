/**
 * Hole-path (centerline) detection: a direct port of the proven CV probe's
 * `semantic_exact_anchor.py` ("semantic centerline v4").
 *
 * A hole's centerline is recovered as:
 *   own tee
 *     -> appearance trace to own-number-badge occlusion boundary
 *     -> geometric jump through the badge (its pixels are occlusion, its
 *        exact center is a hard anchor)
 *     -> appearance trace from the number center toward the basket, stopped
 *        at the first C2 crossing
 *     -> geometry-only C2 bridge (ribbon-midpoint anchored)
 *     -> geometry-only C1 bridge (ribbon-midpoint anchored)
 *     -> basket stem base
 *
 * The route never asks putting-circle pixels which way to go: every C1/C2
 * disk on the course (not just the current hole's) and every tee (foreign or
 * own) is masked as occlusion before tracing starts. That is what keeps a
 * hole from wandering onto a neighboring hole's fairway in a dense cluster
 * (the motivating H5/H6 failure, where H6's tee sits almost inside H5's
 * putting circles) — not an explicit repulsion term. `semantic_c2_entry` and
 * `cubic_bridge` in the source probe implement such a term but are never
 * actually called by its `build_centerlines`; this port only carries what
 * the working pipeline exercises.
 *
 * This is pure, environment-agnostic TypeScript: no OpenCV dependency at
 * all. Putting-circle radius detection needs a Sobel gradient magnitude,
 * which is a fixed 3x3 kernel cheap enough to hand-roll rather than pull in
 * `cv`, keeping this module trivially unit-testable and usable from a Node
 * CLI or a browser worker identically. Coordinates are always in whatever
 * pixel space the caller's raster is in (source-image pixels, if that's what
 * was supplied).
 */

export interface CenterlinePoint {
	readonly xPx: number;
	readonly yPx: number;
}

/** A located hole-number badge: its center plus its occlusion box. */
export interface CenterlineNumberBadge {
	readonly xPx: number;
	readonly yPx: number;
	readonly leftPx: number;
	readonly topPx: number;
	readonly widthPx: number;
	readonly heightPx: number;
}

export interface CenterlineHoleInput {
	readonly number: number;
	readonly numberBadge: CenterlineNumberBadge;
	readonly tee: CenterlinePoint;
	/** The basket's semantic stem-base point (`BasketCandidate.xPx/yPx`), not its icon center. */
	readonly basket: CenterlinePoint;
}

export interface CenterlineRaster {
	readonly rgba: Uint8Array | Uint8ClampedArray;
	readonly gray: Uint8Array;
	readonly widthPx: number;
	readonly heightPx: number;
}

/**
 * The raw evidence `ribbonSidePointsAndMidpoint` chose between at one
 * putting-circle crossing: every offset it sampled along the local path
 * normal, the appearance-feature value it read there, and which two offsets
 * (if any) it picked as the ribbon's edges. Exists purely for audit — so a
 * bad `left`/`right`/`midpoint` can be traced back to the actual scan that
 * produced it instead of being taken on faith.
 */
export interface RibbonSearchDebug {
	readonly crossingPx: CenterlinePoint;
	readonly normal: CenterlinePoint;
	readonly offsetsPx: readonly number[];
	readonly values: readonly number[];
	readonly chosenLeftOffsetPx: number | null;
	readonly chosenRightOffsetPx: number | null;
}

export interface CenterlineHoleResult {
	readonly number: number;
	/** [tee, ...traced points..., basket], in the raster's pixel space. */
	readonly centerline: readonly CenterlinePoint[];
	/** Index into `centerline` where the geometry-only C2/C1/basket terminal begins. */
	readonly terminalStartIndex: number;
	readonly c2Entry: CenterlinePoint;
	readonly c2Left: CenterlinePoint;
	readonly c2Right: CenterlinePoint;
	readonly c1Entry: CenterlinePoint;
	readonly c1Left: CenterlinePoint;
	readonly c1Right: CenterlinePoint;
	readonly c2RibbonSearch: RibbonSearchDebug;
	readonly c1RibbonSearch: RibbonSearchDebug;
}

export interface PuttingCircleRadii {
	readonly c1RadiusPx: number;
	readonly c2RadiusPx: number;
}

export interface DetectPuttingCircleRadiiOptions {
	/** C1 blind-search bounds in pixels. Defaults to 15..140 (wide enough for both a UDisc-native
	 * screenshot's ~25px C1 and a real photographed capture's much larger physical-to-pixel scale). */
	readonly c1RangeLowPx?: number;
	readonly c1RangeHighPx?: number;
}

// ---- small vector helpers -------------------------------------------------

interface Vec {
	readonly x: number;
	readonly y: number;
}

function vec(xPx: number, yPx: number): Vec {
	return { x: xPx, y: yPx };
}

function toPoint(v: Vec): CenterlinePoint {
	return { xPx: v.x, yPx: v.y };
}

function add(a: Vec, b: Vec): Vec {
	return { x: a.x + b.x, y: a.y + b.y };
}

function sub(a: Vec, b: Vec): Vec {
	return { x: a.x - b.x, y: a.y - b.y };
}

function scale(a: Vec, s: number): Vec {
	return { x: a.x * s, y: a.y * s };
}

function dot(a: Vec, b: Vec): number {
	return a.x * b.x + a.y * b.y;
}

function length(a: Vec): number {
	return Math.hypot(a.x, a.y);
}

function normalize(a: Vec): Vec {
	const len = Math.max(length(a), 1e-9);
	return { x: a.x / len, y: a.y / len };
}

function lerp(a: Vec, b: Vec, t: number): Vec {
	return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

function clamp(value: number, minimum: number, maximum: number): number {
	return Math.max(minimum, Math.min(maximum, value));
}

function median(values: readonly number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

// ---- overlay feature + band contrast (from static_course_parser.py) ------

const DEFAULT_MIN_SAMPLE_COUNT = 20;

/**
 * A per-pixel scalar field that scores "looks like plain course ground"
 * high (low saturation, mid brightness) so a band that crosses a fairway
 * scores higher than one that crosses UI chrome, grass-line edges, etc.
 * Matches the proven probe's `overlay_feature` exactly.
 */
export function computeOverlayFeature(raster: CenterlineRaster): Float32Array {
	const feature = new Float32Array(raster.widthPx * raster.heightPx);
	for (let pixel = 0, offset = 0; pixel < feature.length; pixel += 1, offset += 4) {
		const r = raster.rgba[offset];
		const g = raster.rgba[offset + 1];
		const b = raster.rgba[offset + 2];
		const maximum = Math.max(r, g, b);
		const minimum = Math.min(r, g, b);
		const value = maximum;
		const saturation = maximum === 0 ? 0 : ((maximum - minimum) / maximum) * 255;
		feature[pixel] = -(0.8 * saturation + 0.35 * Math.abs(value - 160));
	}
	return feature;
}

/**
 * Mean feature value inside a `length` x `width` band centered at (cx, cy)
 * oriented along `angleDeg`, minus the mean feature value in two side bands
 * just outside it. High when the band itself looks like fairway and its
 * flanks don't (a real cross-section), near zero or negative otherwise.
 * Matches the proven probe's `band_contrast` exactly.
 */
function bandContrast(
	feature: Float32Array,
	widthPx: number,
	heightPx: number,
	cx: number,
	cy: number,
	angleDeg: number,
	bandLength: number,
	bandWidth: number
): number {
	const theta = (angleDeg * Math.PI) / 180;
	const ux = Math.cos(theta);
	const uy = Math.sin(theta);
	const nx = -uy;
	const ny = ux;
	const halfLength = bandLength / 2;
	const halfWidth = bandWidth / 2;
	const sideGap = 3;
	const sideWidth = 10;
	const radius = Math.ceil(Math.max(halfLength, halfWidth + sideGap + sideWidth)) + 2;
	const x0 = Math.max(0, Math.floor(cx - radius));
	const x1 = Math.min(widthPx, Math.ceil(cx + radius + 1));
	const y0 = Math.max(0, Math.floor(cy - radius));
	const y1 = Math.min(heightPx, Math.ceil(cy + radius + 1));

	let insideSum = 0;
	let insideCount = 0;
	let sideSum = 0;
	let sideCount = 0;
	for (let y = y0; y < y1; y += 1) {
		for (let x = x0; x < x1; x += 1) {
			const dx = x - cx;
			const dy = y - cy;
			const along = dx * ux + dy * uy;
			if (Math.abs(along) > halfLength) continue;
			const perpendicular = dx * nx + dy * ny;
			const absPerpendicular = Math.abs(perpendicular);
			const value = feature[y * widthPx + x];
			if (absPerpendicular <= halfWidth) {
				insideSum += value;
				insideCount += 1;
			} else if (absPerpendicular >= halfWidth + sideGap && absPerpendicular <= halfWidth + sideGap + sideWidth) {
				sideSum += value;
				sideCount += 1;
			}
		}
	}
	if (insideCount < DEFAULT_MIN_SAMPLE_COUNT || sideCount < DEFAULT_MIN_SAMPLE_COUNT) return -1e9;
	return insideSum / insideCount - sideSum / sideCount;
}

// ---- putting-circle radius detection --------------------------------------

/**
 * A fixed 3x3 Sobel kernel, hand-rolled rather than delegated to `cv.Sobel`
 * so this module has no OpenCV dependency at all.
 */
function sobelGradientMagnitude(gray: Uint8Array, widthPx: number, heightPx: number): Float32Array {
	const at = (x: number, y: number): number => {
		const cx = clamp(x, 0, widthPx - 1);
		const cy = clamp(y, 0, heightPx - 1);
		return gray[cy * widthPx + cx];
	};
	const magnitude = new Float32Array(widthPx * heightPx);
	for (let y = 0; y < heightPx; y += 1) {
		for (let x = 0; x < widthPx; x += 1) {
			const gx =
				at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1) - (at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1));
			const gy =
				at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1) - (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1));
			magnitude[y * widthPx + x] = Math.hypot(gx, gy);
		}
	}
	return magnitude;
}

function radialEdgeScore(
	gradient: Float32Array,
	widthPx: number,
	heightPx: number,
	center: CenterlinePoint,
	radiusPx: number
): number {
	let sum = 0;
	let count = 0;
	for (let index = 0; index < 180; index += 1) {
		const theta = (2 * Math.PI * index) / 180;
		const x = Math.round(center.xPx + radiusPx * Math.cos(theta));
		const y = Math.round(center.yPx + radiusPx * Math.sin(theta));
		if (x >= 0 && x < widthPx && y >= 0 && y < heightPx) {
			sum += gradient[y * widthPx + x];
			count += 1;
		}
	}
	return count > 0 ? sum / count : 0;
}

const DEFAULT_C1_RANGE_LOW_PX = 15;
const DEFAULT_C1_RANGE_HIGH_PX = 140;

/**
 * Recovers the course's C1/C2 putting-circle radii from repeated
 * basket-centered radial edge strength (median across all baskets, so one
 * occluded/noisy basket can't dominate).
 *
 * The basket icon's own graphic (and, separately, the solid C1 ring itself)
 * both produce real, strong single-radius edge peaks below the true C2 ring,
 * so a plain argmax — even smoothed — over the radial-edge-score curve can't
 * reliably tell "icon edge" apart from "real C1 edge" apart from "real C2
 * edge" by strength or width alone. Instead this searches for the radius `r`
 * whose score AND whose score at `2r` are *both* strong at once, using disc
 * golf's fixed C1:C2 = 1:2 ratio (10m/20m) as the discriminator: only a real
 * C1/C2 pair lights up together at that exact ratio, whereas a basket icon's
 * incidental edge doesn't have a matching edge at double its radius. Verified
 * against a real fixture with the on-image circles visible for comparison:
 * recovers C1=46px/C2=92px, matching the rendered inner solid / outer dashed
 * rings exactly (previous single-radius approaches variously locked onto the
 * icon's own edge or onto the outer ring alone, mislabeling it as C1).
 */
export function detectPuttingCircleRadii(
	raster: CenterlineRaster,
	basketPoints: readonly CenterlinePoint[],
	options: DetectPuttingCircleRadiiOptions = {}
): PuttingCircleRadii {
	const low = options.c1RangeLowPx ?? DEFAULT_C1_RANGE_LOW_PX;
	const high = options.c1RangeHighPx ?? DEFAULT_C1_RANGE_HIGH_PX;
	if (!(high > low)) throw new Error('detectPuttingCircleRadii requires c1RangeHighPx > c1RangeLowPx.');
	if (basketPoints.length === 0) throw new Error('detectPuttingCircleRadii requires at least one basket point.');
	const c1High = Math.floor(high / 2);
	if (!(c1High >= low)) throw new Error('detectPuttingCircleRadii requires c1RangeHighPx >= 2 * c1RangeLowPx.');

	const gradient = sobelGradientMagnitude(raster.gray, raster.widthPx, raster.heightPx);
	const scoreByRadius = new Map<number, number>();
	for (let radius = low; radius <= high; radius += 1) {
		const scores = basketPoints.map((point) => radialEdgeScore(gradient, raster.widthPx, raster.heightPx, point, radius));
		scoreByRadius.set(radius, median(scores));
	}

	let bestC1Radius = low;
	let bestPairScore = -Infinity;
	for (let radius = low; radius <= c1High; radius += 1) {
		const c1Score = scoreByRadius.get(radius)!;
		const c2Score = scoreByRadius.get(radius * 2)!;
		const pairScore = Math.min(c1Score, c2Score);
		if (pairScore > bestPairScore) {
			bestPairScore = pairScore;
			bestC1Radius = radius;
		}
	}
	return { c1RadiusPx: bestC1Radius, c2RadiusPx: bestC1Radius * 2 };
}

// ---- occlusion mask ---------------------------------------------------------

function fillRect(mask: Uint8Array, widthPx: number, heightPx: number, x0: number, y0: number, x1: number, y1: number): void {
	const left = clamp(Math.floor(x0), 0, widthPx - 1);
	const right = clamp(Math.ceil(x1), 0, widthPx - 1);
	const top = clamp(Math.floor(y0), 0, heightPx - 1);
	const bottom = clamp(Math.ceil(y1), 0, heightPx - 1);
	for (let y = top; y <= bottom; y += 1) mask.fill(255, y * widthPx + left, y * widthPx + right + 1);
}

function fillCircle(mask: Uint8Array, widthPx: number, heightPx: number, cx: number, cy: number, radiusPx: number): void {
	const radiusSquared = radiusPx * radiusPx;
	const left = clamp(Math.floor(cx - radiusPx), 0, widthPx - 1);
	const right = clamp(Math.ceil(cx + radiusPx), 0, widthPx - 1);
	const top = clamp(Math.floor(cy - radiusPx), 0, heightPx - 1);
	const bottom = clamp(Math.ceil(cy + radiusPx), 0, heightPx - 1);
	for (let y = top; y <= bottom; y += 1) {
		for (let x = left; x <= right; x += 1) {
			const dx = x - cx;
			const dy = y - cy;
			if (dx * dx + dy * dy <= radiusSquared) mask[y * widthPx + x] = 255;
		}
	}
}

/**
 * Known UDisc/course foreground (every number badge, every basket's C2 disk,
 * every tee) should be crossed by continuity, not learned as if it were
 * fairway texture. Every basket and tee on the WHOLE course is masked here,
 * not just the current hole's — that is what stops a dense-cluster route
 * from treating a neighboring hole's tee as attractive appearance evidence.
 */
export function buildOcclusionMask(
	widthPx: number,
	heightPx: number,
	numberBadges: readonly CenterlineNumberBadge[],
	basketPoints: readonly CenterlinePoint[],
	teePoints: readonly CenterlinePoint[],
	c2RadiusPx: number
): Uint8Array {
	const mask = new Uint8Array(widthPx * heightPx);
	const pad = 10;
	for (const marker of numberBadges) {
		fillRect(
			mask,
			widthPx,
			heightPx,
			marker.leftPx - pad,
			marker.topPx - pad,
			marker.leftPx + marker.widthPx + pad,
			marker.topPx + marker.heightPx + pad
		);
	}
	// The +10px halo also removes the strong C2 ring edge / antialiasing.
	for (const basket of basketPoints) fillCircle(mask, widthPx, heightPx, basket.xPx, basket.yPx, c2RadiusPx + 10);
	for (const tee of teePoints) fillCircle(mask, widthPx, heightPx, tee.xPx, tee.yPx, 12);
	return mask;
}

function patchIsOccluded(mask: Uint8Array, widthPx: number, heightPx: number, x: number, y: number, radius = 4): boolean {
	const ix = Math.round(x);
	const iy = Math.round(y);
	const x0 = Math.max(0, ix - radius);
	const x1 = Math.min(widthPx, ix + radius + 1);
	const y0 = Math.max(0, iy - radius);
	const y1 = Math.min(heightPx, iy + radius + 1);
	if (x0 >= x1 || y0 >= y1) return true;
	let onCount = 0;
	let total = 0;
	for (let y = y0; y < y1; y += 1) {
		for (let x = x0; x < x1; x += 1) {
			total += 1;
			if (mask[y * widthPx + x] > 0) onCount += 1;
		}
	}
	return total > 0 && onCount / total > 0.25;
}

// ---- coast_segment: the appearance tracker --------------------------------

function lineSamples(start: Vec, end: Vec, step = 5.5): Vec[] {
	const dist = length(sub(end, start));
	const count = Math.max(3, Math.ceil(dist / step) + 1);
	const points: Vec[] = [];
	for (let index = 0; index < count; index += 1) points.push(lerp(start, end, index / (count - 1)));
	return points;
}

const COAST_OFFSET_MAX = 30;
const COAST_OFFSET_STEP = 2;
const COAST_CONTINUITY_WEIGHT = 0.2;
const COAST_GUIDE_WEIGHT = 0.01;
const COAST_VISUAL_WEIGHT = 1.12;
const COAST_VISUAL_MIN = -30;
const COAST_VISUAL_MAX = 85;
const COAST_WEAK_EVIDENCE_FLOOR = 5;
const COAST_VELOCITY_MAX = 7;
const COAST_UNKNOWN_VELOCITY_DECAY = 0.85;
const COAST_VELOCITY_SMOOTHING = 0.35;

/**
 * Direction-sensitive local trace that coasts through missing evidence
 * (occlusion, or a cross-section with no strong fairway signal at all)
 * rather than snapping to whatever's locally brightest. A bounded lateral
 * offset search at each step, penalized for deviating from the predicted
 * (velocity-smoothed) offset, so the route can't jump to an unrelated
 * fairway even when local appearance briefly favors it. Matches the proven
 * probe's `coast_segment` exactly.
 */
export function coastSegment(
	feature: Float32Array,
	widthPx: number,
	heightPx: number,
	occlusionMask: Uint8Array,
	start: CenterlinePoint,
	end: CenterlinePoint
): CenterlinePoint[] {
	const startVec = vec(start.xPx, start.yPx);
	const endVec = vec(end.xPx, end.yPx);
	const base = lineSamples(startVec, endVec);
	const offsets: number[] = [];
	for (let offset = -COAST_OFFSET_MAX; offset <= COAST_OFFSET_MAX + 1e-9; offset += COAST_OFFSET_STEP) offsets.push(offset);

	const chosen: Vec[] = [base[0]];
	let previousOffset = 0;
	let lateralVelocity = 0;

	for (let index = 1; index < base.length - 1; index += 1) {
		const point = base[index];
		const tangent = normalize(sub(base[Math.min(index + 1, base.length - 1)], base[Math.max(0, index - 1)]));
		const normal = vec(-tangent.y, tangent.x);
		const angleDeg = (((Math.atan2(tangent.y, tangent.x) * 180) / Math.PI) % 180 + 180) % 180;
		const predictedOffset = clamp(previousOffset + lateralVelocity, -COAST_OFFSET_MAX, COAST_OFFSET_MAX);

		interface Raw {
			readonly offset: number;
			readonly candidate: Vec;
			readonly visual: number;
			readonly occluded: boolean;
		}
		const raw: Raw[] = [];
		for (const offset of offsets) {
			const candidate = add(point, scale(normal, offset));
			if (!(candidate.x > 6 && candidate.x < widthPx - 6 && candidate.y > 6 && candidate.y < heightPx - 6)) continue;
			const occluded = patchIsOccluded(occlusionMask, widthPx, heightPx, candidate.x, candidate.y);
			const visual = bandContrast(feature, widthPx, heightPx, candidate.x, candidate.y, angleDeg, 20, 16);
			raw.push({ offset, candidate, visual, occluded });
		}

		const visibleScores = raw.filter((entry) => !entry.occluded).map((entry) => entry.visual);
		const weakEvidence = visibleScores.length === 0 || Math.max(...visibleScores) < COAST_WEAK_EVIDENCE_FLOOR;

		let bestScore = -Infinity;
		let bestOffset = predictedOffset;
		let bestCandidate = point;
		let bestUnknown = true;
		for (const entry of raw) {
			const unknown = entry.occluded || weakEvidence;
			const visualTerm = unknown ? 0 : clamp(entry.visual, COAST_VISUAL_MIN, COAST_VISUAL_MAX);
			const continuityPenalty = COAST_CONTINUITY_WEIGHT * (entry.offset - predictedOffset) ** 2;
			const guidePenalty = COAST_GUIDE_WEIGHT * entry.offset ** 2;
			const score = COAST_VISUAL_WEIGHT * visualTerm - continuityPenalty - guidePenalty;
			if (score > bestScore) {
				bestScore = score;
				bestOffset = entry.offset;
				bestCandidate = entry.candidate;
				bestUnknown = unknown;
			}
		}

		if (raw.length === 0) {
			chosen.push(point);
			continue;
		}

		const observedVelocity = clamp(bestOffset - previousOffset, -COAST_VELOCITY_MAX, COAST_VELOCITY_MAX);
		lateralVelocity = bestUnknown
			? lateralVelocity * COAST_UNKNOWN_VELOCITY_DECAY
			: COAST_VELOCITY_SMOOTHING * lateralVelocity + (1 - COAST_VELOCITY_SMOOTHING) * observedVelocity;
		chosen.push(bestCandidate);
		previousOffset = bestOffset;
	}

	chosen.push(endVec);

	// One light smoothing pass only -- two passes visibly rounded UDisc's
	// intentional dogleg corners into long gradual arcs.
	if (chosen.length >= 5) {
		const smoothed = [...chosen];
		for (let index = 1; index < chosen.length - 1; index += 1) {
			smoothed[index] = add(
				add(scale(chosen[index - 1], 0.15), scale(chosen[index], 0.7)),
				scale(chosen[index + 1], 0.15)
			);
		}
		smoothed[0] = startVec;
		smoothed[smoothed.length - 1] = endVec;
		return smoothed.map(toPoint);
	}

	chosen[0] = startVec;
	chosen[chosen.length - 1] = endVec;
	return chosen.map(toPoint);
}

// ---- geometry: badge exit point, circle crossings, ribbon anchors --------

/**
 * Ray from a badge center toward another point, returning where that ray
 * first exits the badge's padded occlusion box. Matches `rectangle_exit_point`.
 */
export function rectangleExitPoint(
	center: CenterlinePoint,
	toward: CenterlinePoint,
	marker: CenterlineNumberBadge,
	pad = 8
): CenterlinePoint {
	const centerVec = vec(center.xPx, center.yPx);
	const direction = sub(vec(toward.xPx, toward.yPx), centerVec);
	const len = length(direction);
	if (len < 1e-9) return center;
	const unit = scale(direction, 1 / len);

	const x0 = marker.leftPx - pad;
	const x1 = marker.leftPx + marker.widthPx + pad;
	const y0 = marker.topPx - pad;
	const y1 = marker.topPx + marker.heightPx + pad;

	const intersections: number[] = [];
	if (Math.abs(unit.x) > 1e-9) {
		intersections.push((x0 - centerVec.x) / unit.x, (x1 - centerVec.x) / unit.x);
	}
	if (Math.abs(unit.y) > 1e-9) {
		intersections.push((y0 - centerVec.y) / unit.y, (y1 - centerVec.y) / unit.y);
	}

	for (const distance of intersections.filter((value) => value > 0).sort((a, b) => a - b)) {
		const point = add(centerVec, scale(unit, distance));
		if (point.x >= x0 - 1e-6 && point.x <= x1 + 1e-6 && point.y >= y0 - 1e-6 && point.y <= y1 + 1e-6) return toPoint(point);
	}
	return toPoint(add(centerVec, scale(unit, Math.max(marker.widthPx, marker.heightPx))));
}

/** Exact first segment/circle intersection travelling from `outside` toward `inside`. */
function segmentCircleEntry(outside: Vec, inside: Vec, center: Vec, radiusPx: number): Vec {
	const d = sub(inside, outside);
	const f = sub(outside, center);
	const a = dot(d, d);
	const b = 2 * dot(f, d);
	const c = dot(f, f) - radiusPx * radiusPx;
	const discriminant = Math.max(0, b * b - 4 * a * c);
	const sqrtDiscriminant = Math.sqrt(discriminant);
	const roots = [(-b - sqrtDiscriminant) / (2 * a), (-b + sqrtDiscriminant) / (2 * a)];
	const valid = roots.filter((t) => t >= 0 && t <= 1);
	const t = valid.length > 0 ? Math.min(...valid) : 1;
	return add(outside, scale(d, t));
}

/**
 * Traces from the exact number-badge center toward the basket while every
 * putting circle on the course is masked, then keeps only the portion
 * outside the first C2 crossing (the C2 entry is therefore a consequence of
 * the selected route, not an independently-detected point). Matches
 * `trace_number_center_to_c2`.
 */
function traceNumberCenterToC2(
	feature: Float32Array,
	widthPx: number,
	heightPx: number,
	occlusionMask: Uint8Array,
	numberPoint: CenterlinePoint,
	basketPoint: CenterlinePoint,
	c2RadiusPx: number
): { outside: CenterlinePoint[]; entry: CenterlinePoint } {
	const tracked = coastSegment(feature, widthPx, heightPx, occlusionMask, numberPoint, basketPoint).map((p) =>
		vec(p.xPx, p.yPx)
	);
	const basketVec = vec(basketPoint.xPx, basketPoint.yPx);
	const distances = tracked.map((point) => length(sub(point, basketVec)));
	const firstInsideIndex = distances.findIndex((distance) => distance <= c2RadiusPx);

	if (firstInsideIndex === -1) {
		const direction = normalize(sub(vec(numberPoint.xPx, numberPoint.yPx), basketVec));
		const entry = add(basketVec, scale(direction, c2RadiusPx));
		return { outside: [...tracked, entry].map(toPoint), entry: toPoint(entry) };
	}
	if (firstInsideIndex === 0) {
		return { outside: [tracked[0]].map(toPoint), entry: toPoint(tracked[0]) };
	}
	const entry = segmentCircleEntry(tracked[firstInsideIndex - 1], tracked[firstInsideIndex], basketVec, c2RadiusPx);
	return { outside: [...tracked.slice(0, firstInsideIndex), entry].map(toPoint), entry: toPoint(entry) };
}

function polylineCircleFirstCrossing(
	points: readonly Vec[],
	center: Vec,
	radiusPx: number
): { index: number; crossing: Vec } | null {
	const distances = points.map((point) => length(sub(point, center)));
	for (let index = 1; index < points.length; index += 1) {
		if (distances[index - 1] > radiusPx && distances[index] <= radiusPx) {
			return { index, crossing: segmentCircleEntry(points[index - 1], points[index], center, radiusPx) };
		}
	}
	return null;
}

const RIBBON_SEARCH_HALF_WIDTH = 26;
const RIBBON_MIN_WIDTH = 8;
const RIBBON_MAX_WIDTH = 30;
const RIBBON_TANGENT_OFFSETS = [-3, 0, 3];

/**
 * The only place this module inspects raw appearance inside an
 * otherwise-fully-masked putting circle: at a circle crossing, samples a
 * cross-section along the local path normal, finds a rising/falling edge
 * pair bounding a plausible ribbon-width plateau, and returns the two side
 * points plus their midpoint (all reprojected exactly onto the circle).
 * Matches `_ribbon_side_points_and_midpoint`.
 */
function ribbonSidePointsAndMidpoint(
	feature: Float32Array,
	widthPx: number,
	heightPx: number,
	crossing: Vec,
	tangentIn: Vec,
	basketPoint: Vec,
	radiusPx: number
): { left: Vec; right: Vec; midpoint: Vec; debug: RibbonSearchDebug } {
	const tangent = normalize(tangentIn);
	const normal = vec(-tangent.y, tangent.x);

	const offsets: number[] = [];
	for (let offset = -RIBBON_SEARCH_HALF_WIDTH; offset <= RIBBON_SEARCH_HALF_WIDTH; offset += 1) offsets.push(offset);

	const values = offsets.map((offset) => {
		const samples: number[] = [];
		for (const along of RIBBON_TANGENT_OFFSETS) {
			const point = add(add(crossing, scale(normal, offset)), scale(tangent, along));
			const x = Math.round(point.x);
			const y = Math.round(point.y);
			if (x >= 0 && x < widthPx && y >= 0 && y < heightPx) samples.push(feature[y * widthPx + x]);
		}
		return samples.length > 0 ? samples.reduce((sum, value) => sum + value, 0) / samples.length : -1e9;
	});

	// Light 3-tap smoothing, then a central-difference gradient.
	const smooth = values.map((_, index) => {
		const previous = values[Math.max(0, index - 1)];
		const current = values[index];
		const next = values[Math.min(values.length - 1, index + 1)];
		return (previous + current + next) / 3;
	});
	const gradient = smooth.map((_, index) => {
		const previous = smooth[Math.max(0, index - 1)];
		const next = smooth[Math.min(smooth.length - 1, index + 1)];
		const denom = index === 0 || index === smooth.length - 1 ? 1 : 2;
		return (next - previous) / denom;
	});

	let bestScore = -Infinity;
	let bestLeftIndex = -1;
	let bestRightIndex = -1;
	for (let leftIndex = 2; leftIndex < offsets.length - 3; leftIndex += 1) {
		for (let rightIndex = leftIndex + 1; rightIndex < offsets.length - 2; rightIndex += 1) {
			const width = offsets[rightIndex] - offsets[leftIndex];
			if (width < RIBBON_MIN_WIDTH || width > RIBBON_MAX_WIDTH) continue;
			const leftEdge = gradient[leftIndex];
			const rightEdge = -gradient[rightIndex];
			if (leftEdge <= 0 || rightEdge <= 0) continue;

			const inside = smooth.slice(leftIndex + 1, rightIndex);
			if (inside.length === 0) continue;
			const outsideLeft = smooth.slice(Math.max(0, leftIndex - 5), leftIndex);
			const outsideRight = smooth.slice(rightIndex + 1, Math.min(smooth.length, rightIndex + 6));
			if (outsideLeft.length === 0 || outsideRight.length === 0) continue;

			const mean = (values: readonly number[]): number => values.reduce((sum, v) => sum + v, 0) / values.length;
			const interiorAdvantage = mean(inside) - 0.5 * (mean(outsideLeft) + mean(outsideRight));
			const midpointOffset = 0.5 * (offsets[leftIndex] + offsets[rightIndex]);
			const score =
				2 * leftEdge +
				2 * rightEdge +
				0.8 * interiorAdvantage -
				0.025 * midpointOffset * midpointOffset -
				0.015 * (width - 16) ** 2;
			if (score > bestScore) {
				bestScore = score;
				bestLeftIndex = leftIndex;
				bestRightIndex = rightIndex;
			}
		}
	}

	let left: Vec;
	let right: Vec;
	if (bestLeftIndex === -1) {
		// Keep the geometric crossing if no credible side pair exists.
		left = add(crossing, scale(normal, -7));
		right = add(crossing, scale(normal, 7));
	} else {
		left = add(crossing, scale(normal, offsets[bestLeftIndex]));
		right = add(crossing, scale(normal, offsets[bestRightIndex]));
	}

	const projectToCircle = (point: Vec): Vec => add(basketPoint, scale(normalize(sub(point, basketPoint)), radiusPx));
	const projectedLeft = projectToCircle(left);
	const projectedRight = projectToCircle(right);
	const midpointDirection = normalize(sub(scale(add(projectedLeft, projectedRight), 0.5), basketPoint));
	const midpoint = add(basketPoint, scale(midpointDirection, radiusPx));
	const debug: RibbonSearchDebug = {
		crossingPx: toPoint(crossing),
		normal: toPoint(normal),
		offsetsPx: offsets,
		values,
		chosenLeftOffsetPx: bestLeftIndex === -1 ? null : offsets[bestLeftIndex],
		chosenRightOffsetPx: bestRightIndex === -1 ? null : offsets[bestRightIndex]
	};
	return { left: projectedLeft, right: projectedRight, midpoint, debug };
}

interface ForcedCircleAnchor {
	readonly points: Vec[];
	readonly left: Vec;
	readonly right: Vec;
	readonly midpoint: Vec;
	readonly debug: RibbonSearchDebug;
}

/**
 * Forces a traced polyline's putting-circle crossing through the measured
 * ribbon midpoint rather than trusting the raw appearance-tracked crossing
 * point. Matches `_force_circle_side_midpoint_anchor`.
 */
function forceCircleSideMidpointAnchor(
	points: readonly Vec[],
	feature: Float32Array,
	widthPx: number,
	heightPx: number,
	basketPoint: Vec,
	radiusPx: number
): ForcedCircleAnchor {
	const crossingInfo = polylineCircleFirstCrossing(points, basketPoint, radiusPx);
	if (!crossingInfo) {
		const crossing = points[points.length - 1];
		const tangent = sub(points[points.length - 1], points[points.length - 2]);
		const { left, right, midpoint, debug } = ribbonSidePointsAndMidpoint(
			feature,
			widthPx,
			heightPx,
			crossing,
			tangent,
			basketPoint,
			radiusPx
		);
		return { points: [...points], left, right, midpoint, debug };
	}

	const { index, crossing } = crossingInfo;
	const tangent = sub(points[index], points[index - 1]);
	const { left, right, midpoint, debug } = ribbonSidePointsAndMidpoint(
		feature,
		widthPx,
		heightPx,
		crossing,
		tangent,
		basketPoint,
		radiusPx
	);
	return { points: [...points.slice(0, index), midpoint], left, right, midpoint, debug };
}

/** A cubic Bezier from `entry` to `basket`, tangent-continuous with the incoming route direction. Matches `cubic_terminal_segment`. */
function cubicTerminalSegment(entry: Vec, basket: Vec, incomingTangent: Vec, step = 7): Vec[] {
	const vector = sub(basket, entry);
	const distance = length(vector);
	if (distance < 1e-6) return [entry, basket];

	const radial = scale(vector, 1 / distance);
	let tangent = normalize(incomingTangent);
	if (dot(tangent, radial) < 0) tangent = scale(tangent, -1);

	const p0 = entry;
	const p1 = add(entry, scale(tangent, distance * 0.38));
	const p2 = sub(basket, scale(radial, distance * 0.2));
	const p3 = basket;
	const count = Math.max(4, Math.ceil(distance / step) + 1);

	const points: Vec[] = [];
	for (let index = 0; index < count; index += 1) {
		const t = index / (count - 1);
		const u = 1 - t;
		points.push(
			add(
				add(scale(p0, u ** 3), scale(p1, 3 * u ** 2 * t)),
				add(scale(p2, 3 * u * t ** 2), scale(p3, t ** 3))
			)
		);
	}
	return points;
}

// ---- per-hole and whole-course orchestration ------------------------------

/**
 * Builds one hole's centerline. Callers building all 18 holes should reuse
 * one `computeOverlayFeature`/`buildOcclusionMask`/`detectPuttingCircleRadii`
 * result across every hole (see `buildCenterlines`) rather than recomputing
 * per hole -- they depend only on the whole course's numbers/tees/baskets,
 * not on which hole is currently being traced.
 */
export function buildHoleCenterline(
	hole: CenterlineHoleInput,
	raster: CenterlineRaster,
	feature: Float32Array,
	occlusionMask: Uint8Array,
	c1RadiusPx: number,
	c2RadiusPx: number
): CenterlineHoleResult {
	const { widthPx, heightPx } = raster;
	const teePoint = vec(hole.tee.xPx, hole.tee.yPx);
	const numberPoint = vec(hole.numberBadge.xPx, hole.numberBadge.yPx);
	const basketPoint = vec(hole.basket.xPx, hole.basket.yPx);

	// The number badge's exact center is a ground-truth centerline point (UDisc
	// renders it there); its pixels are occlusion, but the center is a hard
	// anchor the route must pass through.
	const teeSide = rectangleExitPoint(toPoint(teePoint), toPoint(numberPoint), hole.numberBadge);
	const teeToNumber = coastSegment(feature, widthPx, heightPx, occlusionMask, hole.tee, teeSide).map((p) => vec(p.xPx, p.yPx));

	const { outside: numberToC2 } = traceNumberCenterToC2(
		feature,
		widthPx,
		heightPx,
		occlusionMask,
		toPoint(numberPoint),
		toPoint(basketPoint),
		c2RadiusPx
	);

	const outsideC2Raw = [...teeToNumber.slice(0, -1), vec(teeSide.xPx, teeSide.yPx), ...numberToC2.map((p) => vec(p.xPx, p.yPx))];
	const c2Anchor = forceCircleSideMidpointAnchor(outsideC2Raw, feature, widthPx, heightPx, basketPoint, c2RadiusPx);

	const incoming =
		c2Anchor.points.length >= 2
			? sub(c2Anchor.points[c2Anchor.points.length - 1], c2Anchor.points[c2Anchor.points.length - 2])
			: sub(basketPoint, c2Anchor.midpoint);
	const terminal = cubicTerminalSegment(c2Anchor.midpoint, basketPoint, incoming);
	const c1Anchor = forceCircleSideMidpointAnchor(terminal, feature, widthPx, heightPx, basketPoint, c1RadiusPx);

	const finalTerminal = [...c1Anchor.points, basketPoint];
	const terminalStartIndex = c2Anchor.points.length - 1;
	const centerline = [...c2Anchor.points.slice(0, -1), ...finalTerminal];

	return {
		number: hole.number,
		centerline: centerline.map(toPoint),
		terminalStartIndex,
		c2Entry: toPoint(c2Anchor.midpoint),
		c2Left: toPoint(c2Anchor.left),
		c2Right: toPoint(c2Anchor.right),
		c1Entry: toPoint(c1Anchor.midpoint),
		c1Left: toPoint(c1Anchor.left),
		c1Right: toPoint(c1Anchor.right),
		c2RibbonSearch: c2Anchor.debug,
		c1RibbonSearch: c1Anchor.debug
	};
}

export interface BuildCenterlinesResult {
	readonly holes: readonly CenterlineHoleResult[];
	readonly c1RadiusPx: number;
	readonly c2RadiusPx: number;
}

/**
 * Builds every hole's centerline in one pass, computing the shared overlay
 * feature, occlusion mask, and putting-circle radii once.
 */
export function buildCenterlines(
	holes: readonly CenterlineHoleInput[],
	raster: CenterlineRaster,
	options: DetectPuttingCircleRadiiOptions = {}
): BuildCenterlinesResult {
	const feature = computeOverlayFeature(raster);
	const basketPoints = holes.map((hole) => hole.basket);
	const teePoints = holes.map((hole) => hole.tee);
	const numberBadges = holes.map((hole) => hole.numberBadge);
	const { c1RadiusPx, c2RadiusPx } = detectPuttingCircleRadii(raster, basketPoints, options);
	const occlusionMask = buildOcclusionMask(raster.widthPx, raster.heightPx, numberBadges, basketPoints, teePoints, c2RadiusPx);

	const results = holes.map((hole) => buildHoleCenterline(hole, raster, feature, occlusionMask, c1RadiusPx, c2RadiusPx));
	return { holes: results, c1RadiusPx, c2RadiusPx };
}
