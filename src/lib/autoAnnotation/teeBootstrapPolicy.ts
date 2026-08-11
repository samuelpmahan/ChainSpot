import type { TeePadCandidate, TeePadRaster } from './teePadDetection';

/**
 * Clean-course tee bootstrap.
 *
 * This module deliberately separates three questions that the old fallback
 * path conflated:
 *
 * 1. is there convincing pad-like evidence at this location?
 * 2. can the pad axis be measured reliably?
 * 3. if so, which visible number badge does that axis own?
 *
 * The output is a review policy, not a forced 18-way assignment. A weak or
 * occluded pad may become REVIEW when ownership is strong, but ray agreement
 * alone never upgrades weak appearance evidence to AUTO.
 */

export const TEE_ORIENTATION_UNMEASURABLE_SCORE = 0.3;
export const TEE_ORIENTATION_STRONG_SCORE = 0.4;

const COARSE_ANGLE_STEP_DEG = 5;
const FINE_ANGLE_STEP_DEG = 2.5;
const PAD_ASPECT = 1.45;
const PAD_RIM_FRACTION = 0.11;
const TEMPLATE_MARGIN_PX = 2;
const COURSE_SIZE_FACTORS = [0.9, 1.2, 1.5] as const;
const OWNERSHIP_STRONG_ANGLE_DEG = 10;
const OWNERSHIP_PLAUSIBLE_ANGLE_DEG = 15;
const OWNERSHIP_DISTANCE_SEPARATION = 1.25;
const DISTANCE_ONLY_REVIEW_SEPARATION = 1.4;
const COMPETING_CANDIDATE_MARGIN = 0.12;

export type TeePadEvidence = 'strong' | 'weak';
export type TeeOrientationEvidence = 'strong' | 'weak' | 'unmeasurable';
export type TeeOwnershipEvidence = 'strong' | 'plausible' | 'ambiguous' | 'none';
export type TeeBootstrapDecision = 'auto' | 'review' | 'unresolved';

export interface TeeBadgeAnchor {
	readonly holeNumber: number;
	readonly xPx: number;
	readonly yPx: number;
	/** Badge-body dimensions in source-image pixels. Required for strong ray ownership. */
	readonly widthPx?: number;
	readonly heightPx?: number;
}

export interface TeeSweepCalibration {
	/** Candidate-derived world-scale pad sizes; never UDisc UI sizes. */
	readonly majorSizesPx: readonly number[];
	readonly representativeMajorPx: number;
}

export interface TeeOrientationMeasurement {
	readonly axisDeg: number;
	readonly score: number;
	readonly xPx: number;
	readonly yPx: number;
	readonly majorPx: number;
	readonly minorPx: number;
}

export interface TeeBadgeRayEvidence {
	readonly holeNumber: number;
	readonly distancePx: number;
	readonly angularErrorDeg: number;
	readonly acrossPx: number;
	readonly badgeRadiusPx?: number;
	readonly passesBadgeBody: boolean;
}

export interface TeeBootstrapAssignment {
	readonly holeNumber: number;
	readonly candidateIndex: number;
	readonly candidate: TeePadCandidate;
	readonly decision: Exclude<TeeBootstrapDecision, 'unresolved'>;
	readonly confidence: number;
	readonly padEvidence: TeePadEvidence;
	readonly orientationEvidence: TeeOrientationEvidence;
	readonly ownershipEvidence: TeeOwnershipEvidence;
	readonly orientation?: TeeOrientationMeasurement;
	readonly badgeRay?: TeeBadgeRayEvidence;
	readonly reasons: readonly string[];
}

export interface TeeBootstrapHoleResult {
	readonly holeNumber: number;
	readonly decision: TeeBootstrapDecision;
	readonly assignment?: TeeBootstrapAssignment;
	readonly reasons: readonly string[];
}

export interface TeeBootstrapResult {
	readonly calibration?: TeeSweepCalibration;
	readonly holes: readonly TeeBootstrapHoleResult[];
	readonly assignments: readonly TeeBootstrapAssignment[];
	readonly rejectedCandidateIndexes: readonly number[];
	readonly counts: {
		readonly auto: number;
		readonly review: number;
		readonly unresolved: number;
	};
}

interface SweepTemplate {
	readonly angleDeg: number;
	readonly majorPx: number;
	readonly minorPx: number;
	readonly width: number;
	readonly height: number;
	readonly halfWidth: number;
	readonly halfHeight: number;
	readonly centered: Float32Array;
	readonly energy: number;
}

interface GrayRoi {
	readonly x0: number;
	readonly y0: number;
	readonly width: number;
	readonly height: number;
	readonly gray: Uint8Array;
}

interface CandidateAssessment {
	readonly candidateIndex: number;
	readonly candidate: TeePadCandidate;
	readonly proposedHoleNumber?: number;
	readonly confidence: number;
	readonly decision: TeeBootstrapDecision;
	readonly padEvidence: TeePadEvidence;
	readonly orientationEvidence: TeeOrientationEvidence;
	readonly ownershipEvidence: TeeOwnershipEvidence;
	readonly orientation?: TeeOrientationMeasurement;
	readonly badgeRay?: TeeBadgeRayEvidence;
	readonly reasons: readonly string[];
}

function clamp01(value: number): number {
	return Math.max(0, Math.min(1, value));
}

function median(values: readonly number[]): number | undefined {
	if (values.length === 0) return undefined;
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function normalizeAxisDeg(angleDeg: number): number {
	const normalized = angleDeg % 180;
	return normalized < 0 ? normalized + 180 : normalized;
}

function axisDifferenceDeg(a: number, b: number): number {
	const difference = Math.abs(normalizeAxisDeg(a) - normalizeAxisDeg(b));
	return Math.min(difference, 180 - difference);
}

function uniqueSortedSizes(values: readonly number[]): number[] {
	return [...new Set(values
		.filter((value) => Number.isFinite(value) && value >= 6)
		.map((value) => Math.round(value * 2) / 2))]
		.sort((a, b) => a - b);
}

/**
 * Derives the orientation template bank from the course's own tee proposals.
 * This is the key scale-space rule: pad glyphs are world-scaled, so the
 * bootstrap must not derive pad size from the UI-sized number badges.
 *
 * The detector's fitted rectangle often measures only the visible/interior
 * portion of an occluded pad. Sweeping around the robust course median with
 * relative factors lets the outer footprint win by NCC without embedding a
 * GoldenTeeSet/AlexClark/phone-resolution pixel constant.
 */
export function deriveTeeSweepCalibration(
	candidates: readonly Pick<TeePadCandidate, 'widthPx' | 'heightPx'>[]
): TeeSweepCalibration | undefined {
	const majors = candidates
		.map((candidate) => Math.max(candidate.widthPx, candidate.heightPx))
		.filter((value) => Number.isFinite(value) && value >= 6);
	const representativeMajorPx = median(majors);
	if (representativeMajorPx === undefined) return undefined;
	const majorSizesPx = uniqueSortedSizes(COURSE_SIZE_FACTORS.map((factor) => representativeMajorPx * factor));
	return majorSizesPx.length > 0 ? { majorSizesPx, representativeMajorPx } : undefined;
}

function synthesizeTemplate(majorPx: number, angleDeg: number): SweepTemplate {
	const minorPx = majorPx / PAD_ASPECT;
	const rimPx = Math.max(1, majorPx * PAD_RIM_FRACTION);
	const radians = (angleDeg * Math.PI) / 180;
	const cosine = Math.cos(radians);
	const sine = Math.sin(radians);
	const halfWidth = Math.ceil(Math.abs((majorPx / 2) * cosine) + Math.abs((minorPx / 2) * sine)) + TEMPLATE_MARGIN_PX;
	const halfHeight = Math.ceil(Math.abs((majorPx / 2) * sine) + Math.abs((minorPx / 2) * cosine)) + TEMPLATE_MARGIN_PX;
	const width = halfWidth * 2 + 1;
	const height = halfHeight * 2 + 1;
	const values = new Float32Array(width * height);
	let mean = 0;
	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			const dx = x - halfWidth;
			const dy = y - halfHeight;
			const localX = dx * cosine + dy * sine;
			const localY = -dx * sine + dy * cosine;
			const insideOuter = Math.abs(localX) <= majorPx / 2 && Math.abs(localY) <= minorPx / 2;
			const insideInner = Math.abs(localX) <= majorPx / 2 - rimPx && Math.abs(localY) <= minorPx / 2 - rimPx;
			const value = insideInner ? 158 : insideOuter ? 235 : 120;
			values[y * width + x] = value;
			mean += value;
		}
	}
	mean /= values.length;
	const centered = new Float32Array(values.length);
	let energy = 0;
	for (let index = 0; index < values.length; index += 1) {
		const value = values[index] - mean;
		centered[index] = value;
		energy += value * value;
	}
	return { angleDeg: normalizeAxisDeg(angleDeg), majorPx, minorPx, width, height, halfWidth, halfHeight, centered, energy };
}

function buildGrayRoi(
	raster: TeePadRaster,
	centerXPx: number,
	centerYPx: number,
	halfSizePx: number
): GrayRoi | undefined {
	const x0 = Math.max(0, Math.floor(centerXPx - halfSizePx));
	const y0 = Math.max(0, Math.floor(centerYPx - halfSizePx));
	const x1 = Math.min(raster.widthPx - 1, Math.ceil(centerXPx + halfSizePx));
	const y1 = Math.min(raster.heightPx - 1, Math.ceil(centerYPx + halfSizePx));
	const width = x1 - x0 + 1;
	const height = y1 - y0 + 1;
	if (width <= 0 || height <= 0) return undefined;
	const gray = new Uint8Array(width * height);
	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			const sourceOffset = ((y0 + y) * raster.widthPx + x0 + x) * 4;
			gray[y * width + x] = (
				raster.rgba[sourceOffset] * 0.299 +
				raster.rgba[sourceOffset + 1] * 0.587 +
				raster.rgba[sourceOffset + 2] * 0.114 +
				0.5
			) | 0;
		}
	}
	return { x0, y0, width, height, gray };
}

function nccAt(roi: GrayRoi, template: SweepTemplate, centerXPx: number, centerYPx: number): number | undefined {
	const left = Math.round(centerXPx) - template.halfWidth - roi.x0;
	const top = Math.round(centerYPx) - template.halfHeight - roi.y0;
	if (left < 0 || top < 0 || left + template.width > roi.width || top + template.height > roi.height) return undefined;
	let patchMean = 0;
	const count = template.width * template.height;
	for (let y = 0; y < template.height; y += 1) {
		const row = (top + y) * roi.width + left;
		for (let x = 0; x < template.width; x += 1) patchMean += roi.gray[row + x];
	}
	patchMean /= count;
	let cross = 0;
	let patchEnergy = 0;
	for (let y = 0; y < template.height; y += 1) {
		const rasterRow = (top + y) * roi.width + left;
		const templateRow = y * template.width;
		for (let x = 0; x < template.width; x += 1) {
			const patchValue = roi.gray[rasterRow + x] - patchMean;
			cross += patchValue * template.centered[templateRow + x];
			patchEnergy += patchValue * patchValue;
		}
	}
	if (patchEnergy <= 1e-9 || template.energy <= 1e-9) return undefined;
	return cross / Math.sqrt(patchEnergy * template.energy);
}

interface SweepBest extends TeeOrientationMeasurement {
	readonly template: SweepTemplate;
}

function considerSweep(
	roi: GrayRoi,
	templates: readonly SweepTemplate[],
	centerXPx: number,
	centerYPx: number,
	searchRadiusPx: number,
	stridePx: number,
	current?: SweepBest
): SweepBest | undefined {
	let best = current;
	for (const template of templates) {
		for (let dy = -searchRadiusPx; dy <= searchRadiusPx; dy += stridePx) {
			for (let dx = -searchRadiusPx; dx <= searchRadiusPx; dx += stridePx) {
				const xPx = Math.round(centerXPx) + dx;
				const yPx = Math.round(centerYPx) + dy;
				const score = nccAt(roi, template, xPx, yPx);
				if (score === undefined || (best && score <= best.score)) continue;
				best = {
					axisDeg: template.angleDeg,
					score,
					xPx,
					yPx,
					majorPx: template.majorPx,
					minorPx: template.minorPx,
					template
				};
			}
		}
	}
	return best;
}

/**
 * Rotation-swept hollow-pad NCC using a course-derived world-size bank.
 * The coarse pass uses 5-degree/2px sampling, then refines the winning size,
 * angle, and center at 2.5 degrees/1px. This keeps the production cost bounded
 * without sacrificing the orientation precision the invariant needs.
 */
export function sweepPadOrientation(
	raster: TeePadRaster,
	centerXPx: number,
	centerYPx: number,
	calibration: TeeSweepCalibration
): TeeOrientationMeasurement | undefined {
	if (!Number.isFinite(centerXPx) || !Number.isFinite(centerYPx)) return undefined;
	const maxMajorPx = Math.max(...calibration.majorSizesPx);
	const searchRadiusPx = Math.max(2, Math.round(calibration.representativeMajorPx * 0.2));
	const halfRoiPx = maxMajorPx + searchRadiusPx + TEMPLATE_MARGIN_PX + 4;
	const roi = buildGrayRoi(raster, centerXPx, centerYPx, halfRoiPx);
	if (!roi) return undefined;

	const coarseTemplates: SweepTemplate[] = [];
	for (const majorPx of calibration.majorSizesPx) {
		for (let angleDeg = 0; angleDeg < 180; angleDeg += COARSE_ANGLE_STEP_DEG) {
			coarseTemplates.push(synthesizeTemplate(majorPx, angleDeg));
		}
	}
	const coarse = considerSweep(roi, coarseTemplates, centerXPx, centerYPx, searchRadiusPx, 2);
	if (!coarse) return undefined;

	const fineTemplates: SweepTemplate[] = [];
	for (let offset = -COARSE_ANGLE_STEP_DEG; offset <= COARSE_ANGLE_STEP_DEG + 1e-9; offset += FINE_ANGLE_STEP_DEG) {
		fineTemplates.push(synthesizeTemplate(coarse.majorPx, coarse.axisDeg + offset));
	}
	const fine = considerSweep(roi, fineTemplates, coarse.xPx, coarse.yPx, 2, 1, coarse);
	if (!fine) return undefined;
	const { template: _template, ...measurement } = fine;
	return measurement;
}

function badgeRadiusPx(badge: TeeBadgeAnchor): number | undefined {
	if (!Number.isFinite(badge.widthPx) || !Number.isFinite(badge.heightPx)) return undefined;
	const width = badge.widthPx as number;
	const height = badge.heightPx as number;
	return width > 0 && height > 0 ? Math.hypot(width, height) / 2 : undefined;
}

function rayEvidence(measurement: TeeOrientationMeasurement, badge: TeeBadgeAnchor): TeeBadgeRayEvidence {
	const dx = badge.xPx - measurement.xPx;
	const dy = badge.yPx - measurement.yPx;
	const distancePx = Math.hypot(dx, dy);
	const bearingDeg = normalizeAxisDeg((Math.atan2(dy, dx) * 180) / Math.PI);
	const angularErrorDeg = axisDifferenceDeg(measurement.axisDeg, bearingDeg);
	const acrossPx = distancePx * Math.sin((angularErrorDeg * Math.PI) / 180);
	const radius = badgeRadiusPx(badge);
	const passesBadgeBody = radius !== undefined && distancePx >= measurement.majorPx / 2 && acrossPx <= radius;
	return {
		holeNumber: badge.holeNumber,
		distancePx,
		angularErrorDeg,
		acrossPx,
		...(radius === undefined ? {} : { badgeRadiusPx: radius }),
		passesBadgeBody
	};
}

function padEvidence(candidate: TeePadCandidate): TeePadEvidence {
	return new Set(candidate.support).size >= 2 ? 'strong' : 'weak';
}

function orientationEvidence(measurement: TeeOrientationMeasurement | undefined): TeeOrientationEvidence {
	if (!measurement || measurement.score < TEE_ORIENTATION_UNMEASURABLE_SCORE) return 'unmeasurable';
	return measurement.score >= TEE_ORIENTATION_STRONG_SCORE ? 'strong' : 'weak';
}

function nearestBadgeByDistance(
	candidate: TeePadCandidate,
	badges: readonly TeeBadgeAnchor[]
): { badge: TeeBadgeAnchor; separated: boolean } | undefined {
	const sorted = badges
		.map((badge) => ({ badge, distancePx: Math.hypot(badge.xPx - candidate.xPx, badge.yPx - candidate.yPx) }))
		.sort((a, b) => a.distancePx - b.distancePx);
	if (!sorted[0]) return undefined;
	const separated = !sorted[1] || sorted[1].distancePx / Math.max(1, sorted[0].distancePx) >= DISTANCE_ONLY_REVIEW_SEPARATION;
	return { badge: sorted[0].badge, separated };
}

function assessCandidate(
	raster: TeePadRaster,
	candidate: TeePadCandidate,
	candidateIndex: number,
	badges: readonly TeeBadgeAnchor[],
	calibration: TeeSweepCalibration
): CandidateAssessment {
	const pad = padEvidence(candidate);
	const measurement = sweepPadOrientation(raster, candidate.xPx, candidate.yPx, calibration);
	const orientation = orientationEvidence(measurement);
	const reasons: string[] = [];

	if (orientation === 'unmeasurable') {
		if (pad === 'strong') {
			const nearest = nearestBadgeByDistance(candidate, badges);
			if (nearest?.separated) {
				reasons.push('strong pad appearance but orientation is unmeasurable; nearest badge is clearly separated');
				return {
					candidateIndex,
					candidate,
					proposedHoleNumber: nearest.badge.holeNumber,
					confidence: 0.48,
					decision: 'review',
					padEvidence: pad,
					orientationEvidence: orientation,
					ownershipEvidence: 'plausible',
					...(measurement ? { orientation: measurement } : {}),
					reasons
				};
			}
		}
		reasons.push('orientation is unmeasurable and ownership cannot be established safely');
		return {
			candidateIndex,
			candidate,
			confidence: pad === 'strong' ? 0.35 : 0.15,
			decision: 'unresolved',
			padEvidence: pad,
			orientationEvidence: orientation,
			ownershipEvidence: 'none',
			...(measurement ? { orientation: measurement } : {}),
			reasons
		};
	}

	const rays = badges.map((badge) => rayEvidence(measurement!, badge));
	const passing = rays
		.filter((evidence) => evidence.passesBadgeBody)
		.sort((a, b) => a.distancePx - b.distancePx || a.angularErrorDeg - b.angularErrorDeg);
	const best = passing[0];
	if (!best) {
		reasons.push('measurable pad axis does not intersect any visible badge body');
		return {
			candidateIndex,
			candidate,
			confidence: 0.1,
			decision: 'unresolved',
			padEvidence: pad,
			orientationEvidence: orientation,
			ownershipEvidence: 'none',
			orientation: measurement!,
			reasons
		};
	}

	const second = passing[1];
	const separated = !second || second.distancePx / Math.max(1, best.distancePx) >= OWNERSHIP_DISTANCE_SEPARATION;
	const ownership: TeeOwnershipEvidence = !separated
		? 'ambiguous'
		: best.angularErrorDeg <= OWNERSHIP_STRONG_ANGLE_DEG
			? 'strong'
			: best.angularErrorDeg <= OWNERSHIP_PLAUSIBLE_ANGLE_DEG
				? 'plausible'
				: 'ambiguous';

	const normalizedOrientation = clamp01((measurement!.score - TEE_ORIENTATION_UNMEASURABLE_SCORE) / 0.35);
	const normalizedRay = best.badgeRadiusPx
		? clamp01(1 - best.acrossPx / Math.max(1, best.badgeRadiusPx))
		: 0;
	const confidence = clamp01((pad === 'strong' ? 0.35 : 0.15) + normalizedOrientation * 0.35 + normalizedRay * 0.30);

	if (ownership === 'strong' && orientation === 'strong' && pad === 'strong') {
		reasons.push('strong pad appearance, strong orientation, and unique badge-ray ownership');
		return {
			candidateIndex,
			candidate,
			proposedHoleNumber: best.holeNumber,
			confidence,
			decision: 'auto',
			padEvidence: pad,
			orientationEvidence: orientation,
			ownershipEvidence: ownership,
			orientation: measurement!,
			badgeRay: best,
			reasons
		};
	}

	if (ownership === 'strong' || ownership === 'plausible') {
		reasons.push(
			pad === 'weak'
				? 'badge ownership is strong enough to propose, but pad appearance is weak/occluded'
				: orientation === 'weak'
					? 'pad is visible and badge ownership is plausible, but orientation confidence is weak'
					: 'ownership is plausible but not strong enough for automatic acceptance'
		);
		return {
			candidateIndex,
			candidate,
			proposedHoleNumber: best.holeNumber,
			confidence: Math.min(confidence, 0.69),
			decision: 'review',
			padEvidence: pad,
			orientationEvidence: orientation,
			ownershipEvidence: ownership,
			orientation: measurement!,
			badgeRay: best,
			reasons
		};
	}

	reasons.push('multiple badges are similarly compatible with this pad axis');
	return {
		candidateIndex,
		candidate,
		proposedHoleNumber: best.holeNumber,
		confidence: Math.min(confidence, 0.45),
		decision: 'review',
		padEvidence: pad,
		orientationEvidence: orientation,
		ownershipEvidence: 'ambiguous',
		orientation: measurement!,
		badgeRay: best,
		reasons
	};
}


function percentile(sorted: readonly number[], fraction: number): number | undefined {
	if (sorted.length === 0) return undefined;
	const index = Math.max(0, Math.min(sorted.length - 1, Math.round((sorted.length - 1) * fraction)));
	return sorted[index];
}

/**
 * Generic weak-pad discovery for badges still UNRESOLVED after the normal
 * candidate pool has been assessed.
 *
 * This is intentionally not the old H5 fallback. It does not use a fixed
 * badge radius, UI-derived pad size, detector score floor, or a grammar
 * failure to choose a hole-specific algorithm. Instead it learns two pieces
 * of geometry from the current course:
 *
 * - pad world scale from `TeeSweepCalibration`; and
 * - a robust tee-to-badge distance band from already-owned pads.
 *
 * For each unresolved badge it searches that learned annulus. At every sample
 * point the expected pad axis is already constrained by the invariant (the
 * center-to-badge bearing), so only a few template orientations are needed.
 * Emitted candidates carry only `template-search` support and therefore remain
 * weak appearance evidence: they can become REVIEW but never AUTO by
 * themselves.
 */
export function proposeWeakTeeCandidates(
	raster: TeePadRaster,
	badges: readonly TeeBadgeAnchor[],
	calibration: TeeSweepCalibration,
	bootstrap: TeeBootstrapResult,
	existingCandidates: readonly TeePadCandidate[]
): readonly TeePadCandidate[] {
	const ownedDistances = bootstrap.assignments
		.map((assignment) => assignment.badgeRay?.distancePx)
		.filter((distance): distance is number => Number.isFinite(distance));
	if (ownedDistances.length < 4) return [];
	const sortedDistances = [...ownedDistances].sort((a, b) => a - b);
	const lowObserved = percentile(sortedDistances, 0.1);
	const highObserved = percentile(sortedDistances, 0.9);
	if (lowObserved === undefined || highObserved === undefined) return [];

	const minimumDistancePx = Math.max(calibration.representativeMajorPx, lowObserved * 0.7);
	const maximumDistancePx = Math.max(minimumDistancePx, highObserved * 1.3);
	const radialStepPx = Math.max(2, calibration.representativeMajorPx * 0.4);
	const angleStepDeg = 10;
	const maxMajorPx = Math.max(...calibration.majorSizesPx);
	const duplicateRadiusPx = calibration.representativeMajorPx * 0.35;
	const unresolvedNumbers = new Set(
		bootstrap.holes.filter((hole) => hole.decision === 'unresolved').map((hole) => hole.holeNumber)
	);
	const proposals: TeePadCandidate[] = [];

	for (const badge of badges) {
		if (!unresolvedNumbers.has(badge.holeNumber)) continue;
		const roi = buildGrayRoi(raster, badge.xPx, badge.yPx, maximumDistancePx + maxMajorPx + 8);
		if (!roi) continue;
		let best: SweepBest | undefined;
		for (let distancePx = minimumDistancePx; distancePx <= maximumDistancePx + 1e-6; distancePx += radialStepPx) {
			for (let bearingDeg = 0; bearingDeg < 360; bearingDeg += angleStepDeg) {
				const radians = (bearingDeg * Math.PI) / 180;
				const xPx = badge.xPx - Math.cos(radians) * distancePx;
				const yPx = badge.yPx - Math.sin(radians) * distancePx;
				if (
					existingCandidates.some((candidate) =>
						Math.hypot(candidate.xPx - xPx, candidate.yPx - yPx) < duplicateRadiusPx
					)
				) continue;
				const axisDeg = normalizeAxisDeg(bearingDeg);
				for (const majorPx of calibration.majorSizesPx) {
					for (const offsetDeg of [-FINE_ANGLE_STEP_DEG, 0, FINE_ANGLE_STEP_DEG] as const) {
						const template = synthesizeTemplate(majorPx, axisDeg + offsetDeg);
						const score = nccAt(roi, template, xPx, yPx);
						if (score === undefined || (best && score <= best.score)) continue;
						best = {
							axisDeg: template.angleDeg,
							score,
							xPx: Math.round(xPx),
							yPx: Math.round(yPx),
							majorPx: template.majorPx,
							minorPx: template.minorPx,
							template
						};
					}
				}
			}
		}
		if (!best || best.score < TEE_ORIENTATION_UNMEASURABLE_SCORE) continue;

		const refineRadiusPx = Math.max(1, Math.round(calibration.representativeMajorPx * 0.15));
		const fineTemplates: SweepTemplate[] = [];
		for (const majorPx of calibration.majorSizesPx) {
			for (let offsetDeg = -COARSE_ANGLE_STEP_DEG; offsetDeg <= COARSE_ANGLE_STEP_DEG + 1e-9; offsetDeg += FINE_ANGLE_STEP_DEG) {
				fineTemplates.push(synthesizeTemplate(majorPx, best.axisDeg + offsetDeg));
			}
		}
		const refined = considerSweep(roi, fineTemplates, best.xPx, best.yPx, refineRadiusPx, 1, best) ?? best;
		proposals.push({
			xPx: refined.xPx,
			yPx: refined.yPx,
			orientationDeg: refined.axisDeg,
			widthPx: refined.majorPx,
			heightPx: refined.minorPx,
			score: refined.score,
			support: ['template-search']
		});
	}
	return proposals;
}

function assessmentRank(assessment: CandidateAssessment): number {
	return assessment.confidence + (assessment.decision === 'auto' ? 0.25 : assessment.decision === 'review' ? 0.1 : 0);
}

/**
 * Applies the AUTO / REVIEW / UNRESOLVED confidence ladder to an already
 * detected generic tee-candidate pool. It never forces all holes to own a tee.
 * Collisions are resolved conservatively: a close runner-up downgrades the
 * winner to REVIEW rather than allowing a global assignment cascade.
 */
export function assessTeeBootstrap(
	raster: TeePadRaster,
	candidates: readonly TeePadCandidate[],
	badges: readonly TeeBadgeAnchor[]
): TeeBootstrapResult {
	const calibration = deriveTeeSweepCalibration(candidates);
	if (!calibration) {
		return {
			holes: badges.map((badge) => ({
				holeNumber: badge.holeNumber,
				decision: 'unresolved',
				reasons: ['no stable course-level pad world scale could be derived']
			})),
			assignments: [],
			rejectedCandidateIndexes: candidates.map((_, index) => index),
			counts: { auto: 0, review: 0, unresolved: badges.length }
		};
	}

	const assessments = candidates.map((candidate, index) => assessCandidate(raster, candidate, index, badges, calibration));

	// AUTO requires all three independent evidence families and has proven
	// high precision on the labeled courses. Use those strong assignments to
	// learn a robust course-level tee-to-badge distance band. REVIEW candidates
	// with a measured ray far outside that band are not useful proposals; they
	// are usually distant structures that happen to share the badge bearing.
	// This is course-derived geometry, not a pixel/UI/per-hole constant.
	const autoDistances = assessments
		.filter((assessment) => assessment.decision === 'auto')
		.map((assessment) => assessment.badgeRay?.distancePx)
		.filter((distance): distance is number => Number.isFinite(distance))
		.sort((a, b) => a - b);
	const autoDistanceLow = autoDistances.length >= 4 ? percentile(autoDistances, 0.1) : undefined;
	const autoDistanceHigh = autoDistances.length >= 4 ? percentile(autoDistances, 0.9) : undefined;
	const reviewDistanceBand = autoDistanceLow !== undefined && autoDistanceHigh !== undefined
		? { minimumPx: autoDistanceLow * 0.65, maximumPx: autoDistanceHigh * 1.35 }
		: undefined;

	const assignments: TeeBootstrapAssignment[] = [];
	const usedCandidates = new Set<number>();
	const holes: TeeBootstrapHoleResult[] = [];

	for (const badge of badges) {
		let contenders = assessments
			.filter((assessment) => assessment.proposedHoleNumber === badge.holeNumber && assessment.decision !== 'unresolved')
			.sort((a, b) => assessmentRank(b) - assessmentRank(a));
		if (reviewDistanceBand) {
			contenders = contenders.filter((assessment) => {
				if (assessment.decision === 'auto' || !assessment.badgeRay) return true;
				return assessment.badgeRay.distancePx >= reviewDistanceBand.minimumPx
					&& assessment.badgeRay.distancePx <= reviewDistanceBand.maximumPx;
			});
		}
		const winner = contenders[0];
		if (!winner) {
			holes.push({
				holeNumber: badge.holeNumber,
				decision: 'unresolved',
				reasons: [reviewDistanceBand
					? 'no tee candidate survives ownership plus the course-derived tee-to-badge distance band'
					: 'no tee candidate has trustworthy ownership evidence for this badge']
			});
			continue;
		}

		let decision: 'auto' | 'review' = winner.decision === 'auto' ? 'auto' : 'review';
		const reasons = [...winner.reasons];
		const runnerUp = contenders[1];
		if (runnerUp && assessmentRank(winner) - assessmentRank(runnerUp) < COMPETING_CANDIDATE_MARGIN) {
			decision = 'review';
			reasons.push('another candidate has nearly equal ownership evidence; automatic acceptance suppressed');
		}
		const assignment: TeeBootstrapAssignment = {
			holeNumber: badge.holeNumber,
			candidateIndex: winner.candidateIndex,
			candidate: winner.candidate,
			decision,
			confidence: decision === 'auto' ? winner.confidence : Math.min(winner.confidence, 0.69),
			padEvidence: winner.padEvidence,
			orientationEvidence: winner.orientationEvidence,
			ownershipEvidence: winner.ownershipEvidence,
			...(winner.orientation ? { orientation: winner.orientation } : {}),
			...(winner.badgeRay ? { badgeRay: winner.badgeRay } : {}),
			reasons
		};
		assignments.push(assignment);
		usedCandidates.add(winner.candidateIndex);
		holes.push({ holeNumber: badge.holeNumber, decision, assignment, reasons });
	}

	const auto = holes.filter((hole) => hole.decision === 'auto').length;
	const review = holes.filter((hole) => hole.decision === 'review').length;
	const unresolved = holes.filter((hole) => hole.decision === 'unresolved').length;
	return {
		calibration,
		holes,
		assignments,
		rejectedCandidateIndexes: candidates.map((_, index) => index).filter((index) => !usedCandidates.has(index)),
		counts: { auto, review, unresolved }
	};
}
