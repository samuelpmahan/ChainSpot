/**
 * Tee-pad orientation via rotation-swept synthetic-pad NCC, and the
 * badge-ray invariant it feeds: a valid tee pad AIMS at its own number
 * badge, so a candidate whose fitted orientation ray does not pass through
 * the expected badge is almost certainly a false positive or a mislabel.
 *
 * This replaces an earlier dominant-line RANSAC fit over rim pixels
 * (`scripts/overfit-tees.ts`'s prior `fitPadAt`), which broke down whenever
 * the ring band swallowed part of the rim and left disjoint fragments.
 * Rotation-swept NCC instead matches the whole pad shape directly, with a
 * conservative occlusion-masked fallback pass for weak raw matches. Purely
 * geometric: no badge or basket position ever enters the orientation
 * estimate itself, only the later invariant check.
 *
 * Not yet wired into the production detection pipeline
 * (`teePadDetection.ts`'s occluded-edge-loop gap recovery still uses its
 * own Hough-line approach) — this module exists so the algorithm has one
 * real home instead of being duplicated across CLI scripts, and so it can
 * be run and scored on demand without being a hard gate on detection.
 */
import type { TeePadRaster } from './teePadDetection';

export interface FittedPad {
	readonly xPx: number;
	readonly yPx: number;
	/** Unit major-axis direction. */
	readonly ux: number;
	readonly uy: number;
	readonly halfMajorPx: number;
	readonly halfMinorPx: number;
	readonly evidenceCount: number;
	/** Rotation-swept template NCC confidence when this pad came from the sweep estimator. */
	readonly orientationScore?: number;
}

export interface BadgeAnchor {
	readonly number: number;
	readonly xPx: number;
	readonly yPx: number;
	readonly radiusPx: number;
}

export interface PadOrientationSweep {
	readonly axisDeg: number;
	readonly score: number;
	readonly xPx: number;
	readonly yPx: number;
}

interface SweepPadTemplate {
	readonly axisDeg: number;
	readonly width: number;
	readonly height: number;
	readonly halfWidth: number;
	readonly halfHeight: number;
	readonly centered: Float64Array;
	readonly energy: number;
}

interface SweepSearchResult extends PadOrientationSweep {
	readonly template: SweepPadTemplate;
}

interface SweepRoi {
	readonly x0: number;
	readonly y0: number;
	readonly width: number;
	readonly height: number;
	readonly gray: Float64Array;
	readonly trusted: Uint8Array;
	readonly integral: Float64Array;
	readonly integralSq: Float64Array;
}

const SWEEP_ANGLE_STEP_DEG = 2.5;
const SWEEP_SEARCH_RADIUS_UI = 4;
const SWEEP_OCCLUSION_SEARCH_RADIUS_UI = 2;
const SWEEP_RIM_UI = 1.4;
const SWEEP_PAD_MAJOR_UI = 13;
const SWEEP_PAD_MINOR_UI = 8;
const SWEEP_RAW_RELIABLE_SCORE = 0.4;
const SWEEP_MEASURABLE_SCORE = 0.3;
const SWEEP_MASKED_RESCUE_SCORE = 0.4;
const SWEEP_NEAR_RAW_DEG = 10;
const sweepTemplateCache = new Map<string, readonly SweepPadTemplate[]>();

function sweepTemplates(uiScalePx: number): readonly SweepPadTemplate[] {
	const key = uiScalePx.toFixed(6);
	const cached = sweepTemplateCache.get(key);
	if (cached) return cached;

	const rim = Math.max(1, SWEEP_RIM_UI * uiScalePx);
	const margin = Math.ceil(rim) + 1;
	const templates: SweepPadTemplate[] = [];
	// The 13x8 UI canonical rectangle describes the pad body/rim centerline
	// closely, but real UDisc captures in this repo expose two nearby outer
	// footprints. Search both UI-derived interpretations instead of choosing a
	// fixture-specific size: compact adds one rim to each full dimension,
	// full adds a rim on each side. NCC decides from pixels at runtime.
	for (const outerRimMultiples of [1, 2] as const) {
		const major = SWEEP_PAD_MAJOR_UI * uiScalePx + outerRimMultiples * rim;
		const minor = SWEEP_PAD_MINOR_UI * uiScalePx + outerRimMultiples * rim;
		for (let axisDeg = 0; axisDeg < 180 - 1e-9; axisDeg += SWEEP_ANGLE_STEP_DEG) {
			const radians = (axisDeg * Math.PI) / 180;
			const cosine = Math.cos(radians);
			const sine = Math.sin(radians);
			const halfWidth = Math.ceil(Math.abs((major / 2) * cosine) + Math.abs((minor / 2) * sine)) + margin;
			const halfHeight = Math.ceil(Math.abs((major / 2) * sine) + Math.abs((minor / 2) * cosine)) + margin;
			const width = halfWidth * 2 + 1;
			const height = halfHeight * 2 + 1;
			const values = new Float64Array(width * height);
			let mean = 0;
			for (let y = 0; y < height; y += 1) {
				for (let x = 0; x < width; x += 1) {
					const dx = x - halfWidth;
					const dy = y - halfHeight;
					const localX = dx * cosine + dy * sine;
					const localY = -dx * sine + dy * cosine;
					const insideOuter = Math.abs(localX) <= major / 2 && Math.abs(localY) <= minor / 2;
					const insideInner = Math.abs(localX) <= major / 2 - rim && Math.abs(localY) <= minor / 2 - rim;
					const value = insideInner ? 158 : insideOuter ? 235 : 120;
					values[y * width + x] = value;
					mean += value;
				}
			}
			mean /= values.length;
			const centered = new Float64Array(values.length);
			let energy = 0;
			for (let index = 0; index < values.length; index += 1) {
				const value = values[index] - mean;
				centered[index] = value;
				energy += value * value;
			}
			templates.push({ axisDeg, width, height, halfWidth, halfHeight, centered, energy });
		}
	}
	sweepTemplateCache.set(key, templates);
	return templates;
}

function buildSweepRoi(
	raster: TeePadRaster,
	centerXPx: number,
	centerYPx: number,
	searchRadiusPx: number,
	templates: readonly SweepPadTemplate[],
	uiScalePx: number
): SweepRoi | undefined {
	const maxHalfWidth = Math.max(...templates.map((template) => template.halfWidth));
	const maxHalfHeight = Math.max(...templates.map((template) => template.halfHeight));
	const centerX = Math.round(centerXPx);
	const centerY = Math.round(centerYPx);
	const x0 = Math.max(0, centerX - searchRadiusPx - maxHalfWidth);
	const y0 = Math.max(0, centerY - searchRadiusPx - maxHalfHeight);
	const x1 = Math.min(raster.widthPx - 1, centerX + searchRadiusPx + maxHalfWidth);
	const y1 = Math.min(raster.heightPx - 1, centerY + searchRadiusPx + maxHalfHeight);
	const width = x1 - x0 + 1;
	const height = y1 - y0 + 1;
	if (width <= 0 || height <= 0) return undefined;

	const gray = new Float64Array(width * height);
	const black = new Uint8Array(width * height);
	const integralStride = width + 1;
	const integral = new Float64Array((width + 1) * (height + 1));
	const integralSq = new Float64Array((width + 1) * (height + 1));
	for (let y = 0; y < height; y += 1) {
		let rowSum = 0;
		let rowSumSq = 0;
		for (let x = 0; x < width; x += 1) {
			const sourceOffset = ((y0 + y) * raster.widthPx + x0 + x) * 4;
			const red = raster.rgba[sourceOffset];
			const green = raster.rgba[sourceOffset + 1];
			const blue = raster.rgba[sourceOffset + 2];
			const value = red * 0.299 + green * 0.587 + blue * 0.114;
			const index = y * width + x;
			gray[index] = value;
			black[index] = Math.max(red, green, blue) < 70 ? 1 : 0;
			rowSum += value;
			rowSumSq += value * value;
			const above = y * integralStride + x + 1;
			const here = (y + 1) * integralStride + x + 1;
			integral[here] = integral[above] + rowSum;
			integralSq[here] = integralSq[above] + rowSumSq;
		}
	}

	// Black outlines belong overwhelmingly to glyphs/badges/baskets rather
	// than the translucent pad. On weak raw matches only, masked NCC ignores a
	// small UI-scaled halo around those pixels instead of allowing a glyph edge
	// to dictate pad orientation.
	const trusted = new Uint8Array(width * height);
	trusted.fill(1);
	const halo = Math.max(1, Math.round(1.1 * uiScalePx));
	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			if (!black[y * width + x]) continue;
			for (let dy = -halo; dy <= halo; dy += 1) {
				for (let dx = -halo; dx <= halo; dx += 1) {
					const nx = x + dx;
					const ny = y + dy;
					if (nx >= 0 && ny >= 0 && nx < width && ny < height) trusted[ny * width + nx] = 0;
				}
			}
		}
	}
	return { x0, y0, width, height, gray, trusted, integral, integralSq };
}

function sweepAngleDifferenceDeg(a: number, b: number): number {
	const difference = Math.abs(a - b) % 180;
	return Math.min(difference, 180 - difference);
}

function rawSweepSearch(
	roi: SweepRoi,
	centerXPx: number,
	centerYPx: number,
	searchRadiusPx: number,
	templates: readonly SweepPadTemplate[],
	angleNearDeg?: number
): SweepSearchResult | undefined {
	const integralStride = roi.width + 1;
	const rectSum = (table: Float64Array, x: number, y: number, width: number, height: number): number => {
		const a = y * integralStride + x;
		const b = y * integralStride + x + width;
		const c = (y + height) * integralStride + x;
		const d = (y + height) * integralStride + x + width;
		return table[d] - table[b] - table[c] + table[a];
	};
	const centerX = Math.round(centerXPx);
	const centerY = Math.round(centerYPx);
	let best: SweepSearchResult | undefined;
	for (const template of templates) {
		if (angleNearDeg !== undefined && sweepAngleDifferenceDeg(template.axisDeg, angleNearDeg) > SWEEP_NEAR_RAW_DEG) continue;
		if (template.energy <= 0) continue;
		const count = template.width * template.height;
		for (let refinedY = centerY - searchRadiusPx; refinedY <= centerY + searchRadiusPx; refinedY += 1) {
			const localTop = refinedY - template.halfHeight - roi.y0;
			if (localTop < 0 || localTop + template.height > roi.height) continue;
			for (let refinedX = centerX - searchRadiusPx; refinedX <= centerX + searchRadiusPx; refinedX += 1) {
				const localLeft = refinedX - template.halfWidth - roi.x0;
				if (localLeft < 0 || localLeft + template.width > roi.width) continue;
				const sum = rectSum(roi.integral, localLeft, localTop, template.width, template.height);
				const sumSq = rectSum(roi.integralSq, localLeft, localTop, template.width, template.height);
				const patchEnergy = sumSq - (sum * sum) / count;
				if (patchEnergy <= 1e-9) continue;
				let cross = 0;
				for (let y = 0; y < template.height; y += 1) {
					const rasterRow = (localTop + y) * roi.width + localLeft;
					const templateRow = y * template.width;
					for (let x = 0; x < template.width; x += 1) {
						cross += roi.gray[rasterRow + x] * template.centered[templateRow + x];
					}
				}
				const score = cross / Math.sqrt(patchEnergy * template.energy);
				if (!best || score > best.score) best = { axisDeg: template.axisDeg, score, xPx: refinedX, yPx: refinedY, template };
			}
		}
	}
	return best;
}

function maskedSweepSearch(
	roi: SweepRoi,
	centerXPx: number,
	centerYPx: number,
	searchRadiusPx: number,
	templates: readonly SweepPadTemplate[],
	angleNearDeg?: number
): SweepSearchResult | undefined {
	const centerX = Math.round(centerXPx);
	const centerY = Math.round(centerYPx);
	let best: SweepSearchResult | undefined;
	for (const template of templates) {
		if (angleNearDeg !== undefined && sweepAngleDifferenceDeg(template.axisDeg, angleNearDeg) > SWEEP_NEAR_RAW_DEG) continue;
		for (let refinedY = centerY - searchRadiusPx; refinedY <= centerY + searchRadiusPx; refinedY += 1) {
			const localTop = refinedY - template.halfHeight - roi.y0;
			if (localTop < 0 || localTop + template.height > roi.height) continue;
			for (let refinedX = centerX - searchRadiusPx; refinedX <= centerX + searchRadiusPx; refinedX += 1) {
				const localLeft = refinedX - template.halfWidth - roi.x0;
				if (localLeft < 0 || localLeft + template.width > roi.width) continue;
				let count = 0;
				let patchSum = 0;
				let templateSum = 0;
				for (let y = 0; y < template.height; y += 1) {
					const rasterRow = (localTop + y) * roi.width + localLeft;
					const templateRow = y * template.width;
					for (let x = 0; x < template.width; x += 1) {
						const rasterIndex = rasterRow + x;
						if (!roi.trusted[rasterIndex]) continue;
						count += 1;
						patchSum += roi.gray[rasterIndex];
						templateSum += template.centered[templateRow + x];
					}
				}
				if (count < template.width * template.height * 0.45) continue;
				const patchMean = patchSum / count;
				const templateCenteredMean = templateSum / count;
				let cross = 0;
				let patchEnergy = 0;
				let templateEnergy = 0;
				for (let y = 0; y < template.height; y += 1) {
					const rasterRow = (localTop + y) * roi.width + localLeft;
					const templateRow = y * template.width;
					for (let x = 0; x < template.width; x += 1) {
						const rasterIndex = rasterRow + x;
						if (!roi.trusted[rasterIndex]) continue;
						const patchValue = roi.gray[rasterIndex] - patchMean;
						const templateValue = template.centered[templateRow + x] - templateCenteredMean;
						cross += patchValue * templateValue;
						patchEnergy += patchValue * patchValue;
						templateEnergy += templateValue * templateValue;
					}
				}
				if (patchEnergy <= 1e-9 || templateEnergy <= 1e-9) continue;
				const score = cross / Math.sqrt(patchEnergy * templateEnergy);
				if (!best || score > best.score) best = { axisDeg: template.axisDeg, score, xPx: refinedX, yPx: refinedY, template };
			}
		}
	}
	return best;
}

/**
 * Measure pad orientation with a rotation sweep of synthesized hollow-pad
 * templates. The ordinary path is TM_CCOEFF_NORMED-equivalent grayscale NCC
 * over a +-4 UI search window. Only weak raw matches invoke a second,
 * conservative pass that ignores black-glyph halos; no badge or basket
 * geometry enters the orientation estimate.
 */
export function sweepPadOrientation(
	raster: TeePadRaster,
	centerXPx: number,
	centerYPx: number,
	uiScalePx: number
): PadOrientationSweep | undefined {
	if (!Number.isFinite(centerXPx) || !Number.isFinite(centerYPx) || !Number.isFinite(uiScalePx) || uiScalePx <= 0) return undefined;
	const templates = sweepTemplates(uiScalePx);
	if (templates.length === 0) return undefined;
	const rawRadius = Math.max(1, Math.round(SWEEP_SEARCH_RADIUS_UI * uiScalePx));
	const roi = buildSweepRoi(raster, centerXPx, centerYPx, rawRadius, templates, uiScalePx);
	if (!roi) return undefined;
	const raw = rawSweepSearch(roi, centerXPx, centerYPx, rawRadius, templates);
	if (!raw || raw.score >= SWEEP_RAW_RELIABLE_SCORE) return raw;

	const maskedRadius = Math.max(1, Math.round(SWEEP_OCCLUSION_SEARCH_RADIUS_UI * uiScalePx));
	const maskedNear = maskedSweepSearch(roi, centerXPx, centerYPx, maskedRadius, templates, raw.axisDeg);
	const maskedGlobal = maskedSweepSearch(roi, centerXPx, centerYPx, maskedRadius, templates);

	// A strongly better free-axis masked match means the raw axis itself was
	// the glyph casualty. Require both reliable absolute evidence and a clear
	// margin over the near-raw alternative before rotating freely (Alex tee 11).
	if (
		maskedGlobal &&
		maskedGlobal.score >= SWEEP_MASKED_RESCUE_SCORE &&
		sweepAngleDifferenceDeg(maskedGlobal.axisDeg, raw.axisDeg) > SWEEP_NEAR_RAW_DEG &&
		maskedGlobal.score > (maskedNear?.score ?? -1) + 0.05
	) {
		return maskedGlobal;
	}

	// Strong masked evidence close to the raw axis may refine the angle and
	// center (Golden tee 12). With merely measurable evidence, keep the raw
	// angle/center and use the masked score only as confidence: that avoids
	// over-rotating a partly visible pad when the two independent estimates
	// already agree locally (Alex tee 13).
	if (maskedNear && maskedNear.score >= SWEEP_MASKED_RESCUE_SCORE) return maskedNear;
	if (maskedNear && maskedNear.score >= SWEEP_MEASURABLE_SCORE) {
		return { axisDeg: raw.axisDeg, xPx: raw.xPx, yPx: raw.yPx, score: maskedNear.score };
	}
	if (maskedGlobal && maskedGlobal.score >= SWEEP_MASKED_RESCUE_SCORE) return maskedGlobal;

	// No trustworthy orientation survived occlusion cleanup. Deliberately
	// force the confidence below the measurable threshold so callers report
	// UNMEASURABLE rather than a false invariant verdict (Alex tee 12).
	const fallbackScore = Math.max(maskedNear?.score ?? -1, maskedGlobal?.score ?? -1);
	return fallbackScore >= 0 ? { ...raw, score: Math.min(fallbackScore, SWEEP_MEASURABLE_SCORE - 1e-6) } : raw;
}

/** Converts a sweep result into a `FittedPad` for `badgeRayInvariantHolds`, at the canonical UI pad half-extents. */
export function fittedPadFromSweep(sweep: PadOrientationSweep, uiScalePx: number): FittedPad {
	const radians = (sweep.axisDeg * Math.PI) / 180;
	return {
		xPx: sweep.xPx,
		yPx: sweep.yPx,
		ux: Math.cos(radians),
		uy: Math.sin(radians),
		halfMajorPx: 6.5 * uiScalePx,
		halfMinorPx: 4 * uiScalePx,
		evidenceCount: 0,
		orientationScore: sweep.score
	};
}

/**
 * The badge-ray invariant: a valid tee pad AIMS at its own number badge —
 * the rays along both long sides and the ray perpendicular to the front
 * (short) edge, i.e. the major-axis ray from the front-edge midpoint, all
 * intersect the badge. Checked as: the badge disc lies ahead of the pad
 * along its major axis, and all three parallel rays (center and the two
 * long-side offsets) pass within the badge disc.
 */
export function badgeRayInvariantHolds(pad: FittedPad, badge: BadgeAnchor): boolean {
	const toBadgeX = badge.xPx - pad.xPx;
	const toBadgeY = badge.yPx - pad.yPx;
	let ux = pad.ux;
	let uy = pad.uy;
	if (toBadgeX * ux + toBadgeY * uy < 0) {
		ux = -ux;
		uy = -uy;
	}
	const along = toBadgeX * ux + toBadgeY * uy;
	if (along <= pad.halfMajorPx) return false;
	const across = Math.abs(-toBadgeX * uy + toBadgeY * ux);
	const halfMinor = Math.min(Math.max(pad.halfMinorPx, 4), 16);
	// All three parallel rays — the front-perpendicular ray through the pad
	// center and the two long-side rays offset +/- halfMinor — must pass
	// within the badge disc.
	return (
		across <= badge.radiusPx &&
		Math.abs(across - halfMinor) <= badge.radiusPx &&
		across + halfMinor <= badge.radiusPx
	);
}
