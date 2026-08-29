// G4 tee-shard recovery. The predecessor basket bounds discovery only. Each
// encountered non-occluded white component is accepted exactly when every
// visible pixel can contribute to a course-local tee pointing at the badge.

import type { BadgeEvidence, BasketEvidence, RecoveredTeeInput, TeeEvidence, OrientedQuad } from '../types';
import { statsForPixels, type ComponentStats } from '../components';
import type { Mask } from '../raster';
import type { SpriteMatch } from '../endpoints';
import basketSpriteData from '../assets/basket-sprite.json';
import type { ABFeature, EngineUnit, EvidenceBoard, FeatureContext } from './types';
import { teeRecoveryRender } from './g3.teeReceipts';
import type { OpaqueDetector } from '../occlusion';
import { detectScreenChromeRegions, pointInScreenChrome } from '../screenChrome';

/** Frozen seam interface for rail extraction (sibling worker A). Do not re-implement. */
export type { Px, OccluderFootprint, RailCandidate } from '../geometry/railExtraction';
export { extractRailCandidates } from '../geometry/railExtraction';
import type { Px, OccluderFootprint, RailCandidate } from '../geometry/railExtraction';
import { extractRailCandidates, MIN_RAIL_PIXELS } from '../geometry/railExtraction';

export interface RecoveryFit {
	readonly centerXPx: number;
	readonly centerYPx: number;
	readonly halfWidthPx: number;
	readonly halfHeightPx: number;
	readonly angleRad: number;
	/** Width of the observed course-local support band.  This is derived from
	 * the intact pads' area, not from a renderer/template constant. */
	readonly supportThicknessPx?: number;
	/** Rail projection is determined by observed pixels + known tee size. */
	readonly fitKind?: 'support-search' | 'rail-projection' | 'rail-extracted';
	readonly badgePerpendicularErrorPx?: number;
	readonly badgePerpendicularMissPx?: number;
	/** Error budget implied by observed rail uncertainty + the observed spread
	 * of already-known course-local pad widths + raster quantization. */
	readonly badgePerpendicularBoundPx?: number;
	readonly projectedLaneWidthPx?: number;
	readonly observedRailSpanPx?: number;
	/** Information about extracted rail when fitKind is 'rail-extracted'. */
	readonly extractedRailAngleRad?: number;
	readonly extractedRailLengthPx?: number;
	readonly extractedRailQualityScore?: number;
	readonly railCandidatesConsidered?: number;
	readonly occluderKindsSubtracted?: readonly string[];
}

export interface TeeRecoveryCandidate {
	readonly id: string;
	/** Badge-constrained feasibility fit used only for the recovery predicate. */
	readonly fit: RecoveryFit;
	/** Independent localization testimony used for corners/center when one
	 * detector-owned component spans both course-local pad axes. */
	readonly localizationFit?: RecoveryFit;
	readonly localizationSource?: 'support-fit' | 'full-span-component-pca';
	/** Bright pixels belonging to the surviving shard, in candidate coordinates. */
	readonly fragmentPixels: readonly (readonly [number, number])[];
	readonly supportingComponentIds: readonly string[];
	/** Candidate points are local to the cropped viewport unless explicitly original. */
	readonly coordinateFrame?: 'local' | 'original';
	/** Vertical offset used when candidate coordinates are viewport-local. */
	readonly viewportTopPx?: number;
	/** Badge ray used for the hard C1S angular constraint. */
	readonly teeToBadgeAngleRad?: number;
	readonly badgeAxisAngleRad?: number;
	readonly badgeId?: string;
	readonly badgeLabel?: string | null;
	readonly seedSource?: string;
	readonly bfsComponentsVisited?: number;
	/** Total unowned, non-occluded bright components considered for this
	 * candidate's target badge (the whole canonical raster; no spatial
	 * prefilter). Carried on the candidate so the receipt can honestly state
	 * the searched scope next to the accept/reject verdict. */
	readonly consideredComponentsGlobal?: number;
	/** Other numbered badges supported by this exact component set. G4 is
	 * deliberately nonmonotonic about belief but monotonic about evidence:
	 * multiclaim is preserved and every claimant is deferred, never collapsed
	 * to a local winner. */
	readonly ambiguityWithBadgeLabels?: readonly string[];
	/** false when NO pixel of this candidate's component group lies within
	 * the raster adjacency allowance of a known-occluder footprint -- by the
	 * completeness invariant such a group cannot be a partially-occluded tee
	 * (see the occluder-adjacency note in buildTeeRecoveryCandidates).
	 * Undefined = not measured (legacy/synthetic callers); only an explicit
	 * false rejects. */
	readonly occluderAdjacent?: boolean;
	/** The one honest exception to occluder adjacency: a threshold-DIMMED pad
	 * (the fired brightVMin ratchet class) has no occluder, yet one painted
	 * rail can still cross the brightness threshold. Such a survivor is ONE
	 * connected shard, spans at least the course's own shortest pad side
	 * along the fitted axis, and stays within a wall band (two thicknesses +
	 * raster tolerance) across it -- a rail, never a blob or a speck chain.
	 * All bounds course-derived; values carried for receipts. */
	readonly dimRailEscape?: {
		readonly qualifies: boolean;
		readonly singleShard: boolean;
		readonly alongSpanPx: number;
		readonly alongFloorPx: number;
		readonly acrossSpanPx: number;
		readonly acrossCapPx: number;
	};
}

export interface TeeRecoveryValues {
	readonly supportingPixels: number;
	readonly supportingComponents: number;
	readonly badgeAxisAlignment?: number;
	readonly coordinateFrame: 'original-image';
	readonly badgeAxisErrorRad?: number;
	readonly unexplainedVisiblePixels?: number;
	readonly supportFitCenterXPx?: number;
	readonly supportFitCenterYPx?: number;
	readonly localizedCenterXPx?: number;
	readonly localizedCenterYPx?: number;
	readonly fullSpanComponentLocalization?: number;
	readonly badgePerpendicularErrorPx?: number;
	readonly badgePerpendicularMissPx?: number;
	readonly badgePerpendicularBoundPx?: number;
	readonly projectedLaneWidthPx?: number;
	readonly observedRailSpanPx?: number;
	readonly railProjection?: number;
	readonly railExtracted?: number;
	readonly extractedRailAngleRad?: number;
	readonly extractedRailLengthPx?: number;
	readonly extractedRailQualityScore?: number;
	readonly railCandidatesConsidered?: number;
}

interface RecoveryGeometryOptions {
	readonly viewportTopPx?: number;
}

export interface TeeRecoveryResult {
	readonly id: string;
	readonly verdict: 'accepted' | 'rejected';
	readonly reason: string;
	readonly values: TeeRecoveryValues;
	readonly corners: OrientedQuad;
}

/** Promote one deterministic graph result per discovered component. */
function promoteGraphResults(
	candidates: readonly TeeRecoveryCandidate[],
	results: readonly TeeRecoveryResult[]
): readonly { readonly candidate: TeeRecoveryCandidate; readonly result: TeeRecoveryResult }[] {
	return results.flatMap((result, index) => {
		const candidate = candidates[index];
		return candidate ? [{ candidate, result }] : [];
	});
}

function numericTraceValues(values: TeeRecoveryValues): Record<string, number> {
	return Object.fromEntries(
		Object.entries(values).filter((entry): entry is [string, number] => typeof entry[1] === 'number')
	);
}

/** Split the evidence remaining after ownership/occlusion subtraction. The
 * source bright component can legitimately become several visible shards. */
function connectedPixelShards(points: readonly (readonly [number, number])[]): readonly (readonly (readonly [number, number])[])[] {
	const byKey = new Map<string, readonly [number, number]>(
		points.map((point) => [`${point[0]},${point[1]}`, point])
	);
	const unseen = new Set<string>(byKey.keys());
	const shards: (readonly [number, number])[][] = [];
	for (const start of [...unseen].sort((a, b) => {
		const [ax, ay] = a.split(',').map(Number);
		const [bx, by] = b.split(',').map(Number);
		return ay - by || ax - bx;
	})) {
		if (!unseen.delete(start)) continue;
		const queue = [start];
		const shard: (readonly [number, number])[] = [];
		for (let index = 0; index < queue.length; index++) {
			const key = queue[index]!;
			const point = byKey.get(key);
			if (!point) continue;
			shard.push(point);
			for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
				if (dx === 0 && dy === 0) continue;
				const neighbor = `${point[0] + dx},${point[1] + dy}`;
				if (unseen.delete(neighbor)) queue.push(neighbor);
			}
		}
		shard.sort(([ax, ay], [bx, by]) => ay - by || ax - bx);
		shards.push(shard);
	}
	return shards;
}

export const teeRecoveryFeature = {
	id: 'teeRecovery',
	gate: 'G4',
	kind: 'baseline',
	defaultEnabled: true,
	note: 'G4 endpoint completion: visible tees claim numbered badges by their own pad axis; only badges with zero visible-tee ray coverage enter shard recovery, and a shard becomes a recovered tee only when every visible pixel fits a course-local hollow tee support pointing at that badge. No path, basket assignment, or G6 decision is consulted.',
	render: teeRecoveryRender,
	knobs: {
		axisToleranceDeg: {
			default: 3,
			note: 'Soft ceiling per owner policy 2026-08-28: the strict 3° badge-axis gate (BADGE_AXIS_TARGET_DEG) stays the debugging TARGET, and this knob is the OPERATIVE limit a config can widen past it. NULL RESULT on the current corpus, recorded honestly rather than chased: after dc96000 ("Recovery owns every bright pixel inside badge bboxes") stopped badge-digit-glyph chrome from masquerading as tee-shard evidence, a sweep ladder (3/5/10/20/30/45/88°) across NorthPark/HeritagePark/AlexClark/DashsTrack found every hole the mechanism can currently capture is ALREADY captured at the strict 3° target -- HeritagePark recovers H10, AlexClark recovers H10+H11, DashsTrack holds 18/18 (H3/H5/H12 via recovery) with IDENTICAL fitted centers and axis errors (well under 2°) at every rung from 3° to 88°. NorthPark recovers zero tees at any tolerance: its real pads sit outside the current discovery search bounds, a separate bug this knob cannot fix. Because widening buys nothing real here, the default stays at the strict target (3°) rather than moving; the knob is landed and validated (0.5-90°) so a future corpus that genuinely needs slack is one config edit away, with the achieved axis-error distribution always visible via the teeRecovery/axisErrorDeg receipt measurement. See docs/INTAKE-ENGINE-HANDOFF.md and artifacts/orchestration/axis-ceiling-progress.md for the full ladder table and per-hypothesis center/badge-bbox-containment check.',
			validate: (value: unknown) =>
				typeof value === 'number' && Number.isFinite(value) && value >= 0.5 && value <= 90
					? null
					: 'axisToleranceDeg must be a finite number between 0.5 and 90'
		}
	}
} satisfies ABFeature;

function finite(value: number): boolean {
	return Number.isFinite(value);
}

function localPoint(candidate: TeeRecoveryCandidate, point: readonly [number, number], options: RecoveryGeometryOptions): readonly [number, number] {
	const offset = candidate.coordinateFrame === 'original' ? 0 : candidate.viewportTopPx ?? options.viewportTopPx ?? 0;
	return [point[0], point[1] + offset];
}

function rotate(ring: RecoveryFit, x: number, y: number): readonly [number, number] {
	const c = Math.cos(ring.angleRad);
	const s = Math.sin(ring.angleRad);
	return [ring.centerXPx + x * c - y * s, ring.centerYPx + x * s + y * c];
}

function poseOf(candidate: TeeRecoveryCandidate): RecoveryFit {
	// CL-1: what gated is what persists. A rail-kind fit won acceptance from
	// constrained geometry (centerline within a derived bound), so its pose IS
	// the tee's pose; fragment PCA localization is only trusted for
	// support-search fits, where a full-span single component earned it.
	const fk = candidate.fit.fitKind as string;
	if (fk === 'rail-projection' || fk === 'rail-extracted') return candidate.fit;
	return candidate.localizationFit ?? candidate.fit;
}

function cornersFor(candidate: TeeRecoveryCandidate, options: RecoveryGeometryOptions): OrientedQuad {
	const ring = poseOf(candidate);
	const offset = candidate.coordinateFrame === 'original' ? 0 : candidate.viewportTopPx ?? options.viewportTopPx ?? 0;
	const raw = [
		rotate(ring, -ring.halfWidthPx, -ring.halfHeightPx),
		rotate(ring, ring.halfWidthPx, -ring.halfHeightPx),
		rotate(ring, ring.halfWidthPx, ring.halfHeightPx),
		rotate(ring, -ring.halfWidthPx, ring.halfHeightPx)
	] as const;
	return raw.map(([x, y]) => [x, y + offset] as const) as unknown as OrientedQuad;
}

export function badgeAxisError(candidate: TeeRecoveryCandidate): number | undefined {
	const a = candidate.badgeAxisAngleRad;
	const b = candidate.teeToBadgeAngleRad;
	if (!finite(a ?? NaN) || !finite(b ?? NaN)) return undefined;
	const delta = Math.atan2(Math.sin((a as number) - (b as number)), Math.cos((a as number) - (b as number)));
	return Math.abs(delta);
}

// Half a raster cell plus its diagonal quantization allowance. The fitted
// course dimensions describe continuous geometry while evidence arrives as
// integer cell centers.
const RASTER_TOLERANCE_PX = 1.25;
/** The original hard gate: tee major axis within 3° of the center-to-badge
 * ray. Owner policy 2026-08-28: this becomes a SOFT CEILING while the pad
 * rectangle detection underperforms in places — the configured knob below
 * sets the operative limit, with a tightening roadmap of corpus P100 <= 5°
 * and then back to 3° as the rectangle improves. The strict gate stays the
 * target because it debugs like a greedy algorithm: it exposes every bad
 * assumption loudly. */
const BADGE_AXIS_TARGET_DEG = 3;
let activeAxisLimitRad = BADGE_AXIS_TARGET_DEG * Math.PI / 180;
let activeAxisLimitDeg = BADGE_AXIS_TARGET_DEG;

/** Set per run from the resolved teeRecovery knobs (single-threaded engine;
 * the unit run installs this before any candidate is built or judged). */
export function setActiveAxisToleranceDeg(deg: number): void {
	activeAxisLimitDeg = deg;
	activeAxisLimitRad = deg * Math.PI / 180;
}
const MIN_SHARD_SUPPORT_PIXELS = 8;

/** The tee is a hollow outline, so membership means being in the outer
 * rectangle and in its border/support band.  The band width is estimated from
 * an intact pad's measured area using A = 2t(W+H)-4t². */
function pointExplainsTee(point: readonly [number, number], fit: RecoveryFit): boolean {
	const dx = point[0] - fit.centerXPx;
	const dy = point[1] - fit.centerYPx;
	const c = Math.cos(fit.angleRad);
	const s = Math.sin(fit.angleRad);
	const u = dx * c + dy * s;
	const v = -dx * s + dy * c;
	const hw = fit.halfWidthPx + RASTER_TOLERANCE_PX;
	const hh = fit.halfHeightPx + RASTER_TOLERANCE_PX;
	if (Math.abs(u) > hw || Math.abs(v) > hh) return false;
	const thickness = Math.max(0, fit.supportThicknessPx ?? Math.min(fit.halfWidthPx, fit.halfHeightPx));
	return Math.abs(u) >= fit.halfWidthPx - thickness - RASTER_TOLERANCE_PX ||
		Math.abs(v) >= fit.halfHeightPx - thickness - RASTER_TOLERANCE_PX;
}

/** Split of a candidate's non-band pixels into the two classes the owner's
 * 2026-08-29 holepath ruling names: interior brights (the hole path showing
 * through the hollow -- excused, never evidence, never a contradiction) and
 * true contradictions (bright outside the fitted footprint's support band
 * AND outside its hollow). */
export function partitionUnexplainedPixels(candidate: TeeRecoveryCandidate): {
	readonly contradictions: readonly (readonly [number, number])[];
	readonly interiorExcusedPx: number;
} {
	// Owner world-model ruling (2026-08-29, supersedes the env-gated
	// CHAINSPOT_POKE_INTERIOR probe and A1's discarded INTERIOR_PIXEL_BOUND
	// amnesty): the hole path is WIDER than the pad and runs beneath it, so a
	// bright pixel inside the hollow is the path showing through -- it never
	// contradicts a tee and never counts as evidence, for EVERY fit kind.
	// Supporting measurement (same night): every accepted visible Dev6 pad
	// has ZERO interior brights -- a ring only detects when the hollow
	// happens to read dark, and recovery must not demand that luck from
	// occluded pads.
	const f = candidate.fit;
	const c = Math.cos(f.angleRad), sn = Math.sin(f.angleRad);
	const innerU = f.halfWidthPx - Math.max(0, f.supportThicknessPx ?? 0) - RASTER_TOLERANCE_PX;
	const innerV = f.halfHeightPx - Math.max(0, f.supportThicknessPx ?? 0) - RASTER_TOLERANCE_PX;
	const base = rawUnexplainedPixels(candidate);
	const contradictions: (readonly [number, number])[] = [];
	let interiorExcusedPx = 0;
	for (const point of base) {
		const dx = point[0] - f.centerXPx, dy = point[1] - f.centerYPx;
		const u = dx * c + dy * sn, v = -dx * sn + dy * c;
		if (Math.abs(u) < innerU && Math.abs(v) < innerV) interiorExcusedPx++;
		else contradictions.push(point);
	}
	return { contradictions, interiorExcusedPx };
}

export function unexplainedPixels(candidate: TeeRecoveryCandidate): readonly (readonly [number, number])[] {
	return partitionUnexplainedPixels(candidate).contradictions;
}

function rawUnexplainedPixels(candidate: TeeRecoveryCandidate): readonly (readonly [number, number])[] {
	return candidate.fragmentPixels.filter((point) => !pointExplainsTee(point, candidate.fit));
}

function supportResidual(point: readonly [number, number], fit: RecoveryFit): number {
	const dx = point[0] - fit.centerXPx;
	const dy = point[1] - fit.centerYPx;
	const c = Math.cos(fit.angleRad);
	const s = Math.sin(fit.angleRad);
	const u = dx * c + dy * s;
	const v = -dx * s + dy * c;
	const outer = Math.hypot(
		Math.max(0, Math.abs(u) - fit.halfWidthPx),
		Math.max(0, Math.abs(v) - fit.halfHeightPx)
	);
	const edgeDistance = Math.min(
		Math.abs(Math.abs(u) - fit.halfWidthPx),
		Math.abs(Math.abs(v) - fit.halfHeightPx)
	);
	return outer * 4 + edgeDistance;
}

function supportThickness(pads: readonly TeeEvidence[]): number {
	const values = pads.map((tee) => {
		const pad = tee.pad;
		if (!pad || !finite(pad.majorPx) || !finite(pad.minorPx) || !finite(pad.area)) return undefined;
		const width = Math.max(pad.majorPx, pad.minorPx);
		const height = Math.min(pad.majorPx, pad.minorPx);
		// A solid bright fallback pad contains no evidence for a hollow border;
		// keep only the one-pixel raster tolerance in that case.
		if (pad.area >= width * height * 0.95) return 0;
		const discriminant = Math.max(0, (width + height) ** 2 - 4 * pad.area);
		// Solve the smaller root of the rectangular border-area equation.
		return Math.max(0, Math.min(height / 2, (width + height - Math.sqrt(discriminant)) / 4));
	}).filter((value): value is number => value !== undefined && finite(value));
	if (values.length === 0) return 0;
	values.sort((a, b) => a - b);
	return values[Math.floor(values.length / 2)] ?? 0;
}

/**
 * A rail knows its own line. The course-local tee width tells us where the
 * centerline can be. The badge is never allowed to rotate or translate the
 * tee; it contributes only a perpendicular residual against that projection.
 *
 * When extractedRail is provided, it is a pre-identified rail from geometric
 * extraction (sibling worker A); the angle and point cloud come from that rail
 * rather than from thin-band PCA. The perpendicular miss/bound math, raster
 * tolerance, and dimension constraints are FROZEN and apply identically
 * regardless of rail source.
 */
function projectRailFit(
	pixels: readonly [number, number][],
	component: ComponentStats,
	target: BadgeEvidence,
	viewportTopPx: number,
	halfWidth: number,
	halfHeight: number,
	halfHeightErrorPx: number,
	thickness: number,
	extractedRail?: RailCandidate
): RecoveryFit | undefined {
	if (pixels.length < 2) return undefined;

	// Use extracted rail if provided; otherwise compute from thin-band PCA.
	let angle: number;
	let cx: number, cy: number;
	let railSpan: number;
	let railThickness: number;
	let minAlong: number, maxAlong: number;

	if (extractedRail) {
		// Pre-identified rail: use its angle and points directly.
		angle = extractedRail.angleRad;
		// Compute center of mass from the extracted rail's points for projection.
		// The rail extraction module identifies the line; we use its direction
		// to project perpendicular to find the tee centerline.
		let sumX = 0, sumY = 0;
		for (const [x, y] of extractedRail.points) {
			sumX += x;
			sumY += y;
		}
		cx = sumX / extractedRail.points.length;
		cy = sumY / extractedRail.points.length;
		railSpan = extractedRail.lengthPx;
		// Rail thickness AND along-axis extent estimated from the extracted
		// rail's own points' spread relative to its own centroid -- same
		// projection the thin-band branch performs on its pixels below, so
		// the legacy along-axis center-bounds math applies unchanged.
		const c = Math.cos(angle);
		const ss = Math.sin(angle);
		const nx = -ss, ny = c;
		minAlong = Infinity; maxAlong = -Infinity;
		let minNormal = Infinity, maxNormal = -Infinity;
		for (const [x, y] of extractedRail.points) {
			const dx = x - cx, dy = y - cy;
			const along = dx * c + dy * ss;
			const normal = dx * nx + dy * ny;
			minAlong = Math.min(minAlong, along);
			maxAlong = Math.max(maxAlong, along);
			minNormal = Math.min(minNormal, normal);
			maxNormal = Math.max(maxNormal, normal);
		}
		railThickness = maxNormal - minNormal;
	} else {
		// Thin-band PCA: exact visible stats from the component's pixels.
		const exact = exactVisibleStats(component.label, pixels) ?? component;
		angle = exact.angle;
		if (!Number.isFinite(angle)) return undefined;
		cx = exact.cx;
		cy = exact.cy;

		// Project all pixels onto the identified line to find span and thickness.
		const c = Math.cos(angle);
		const ss = Math.sin(angle);
		const nx = -ss, ny = c;
		minAlong = Infinity; maxAlong = -Infinity;
		let minNormal = Infinity, maxNormal = -Infinity;
		for (const [x, y] of pixels) {
			const dx = x - cx, dy = y - cy;
			const along = dx * c + dy * ss;
			const normal = dx * nx + dy * ny;
			minAlong = Math.min(minAlong, along);
			maxAlong = Math.max(maxAlong, along);
			minNormal = Math.min(minNormal, normal);
			maxNormal = Math.max(maxNormal, normal);
		}
		railSpan = maxAlong - minAlong;
		railThickness = maxNormal - minNormal;
	}

	// FROZEN FORMULAS: perpendicular miss/bound math, raster tolerance, dimension constraints.
	// These apply identically regardless of whether the rail came from thin-band PCA or
	// geometric extraction.
	const c = Math.cos(angle);
	const ss = Math.sin(angle);
	const nx = -ss, ny = c;

	const allowedRailThickness = Math.max(0, thickness) + 2 * RASTER_TOLERANCE_PX;
	if (railThickness > allowedRailThickness || railSpan > 2 * halfWidth + 2 * RASTER_TOLERANCE_PX) return undefined;

	const lowCenterAlong = maxAlong - halfWidth;
	const highCenterAlong = minAlong + halfWidth;
	if (lowCenterAlong > highCenterAlong + RASTER_TOLERANCE_PX) return undefined;
	const centerAlong = Math.max(lowCenterAlong, Math.min(highCenterAlong, 0));

	const badgeX = target.cxPx;
	const badgeY = target.cyPx - viewportTopPx;
	const badgeNormalFromRail = (badgeX - cx) * nx + (badgeY - cy) * ny;
	// PCA is centered on the observed bright rail band, not its outer edge.
	// The center-to-rail distance is therefore half the known outer pad width
	// minus half the measured course-local border thickness.
	const projectedCenterOffsetPx = Math.max(0, halfHeight - Math.max(0, thickness) / 2);
	const plusError = Math.abs(badgeNormalFromRail - projectedCenterOffsetPx);
	const minusError = Math.abs(badgeNormalFromRail + projectedCenterOffsetPx);
	const side = plusError <= minusError ? 1 : -1;
	const perpendicularError = Math.min(plusError, minusError);
	// BUILT-IN ERROR BOUND: already-known pad widths tell us how uncertain the
	// half-width projection is; observed rail thickness bounds where its true
	// center can lie; the final raster allowance covers cell quantization.
	const railCenterUncertaintyPx = Math.max(RASTER_TOLERANCE_PX, railThickness / 2);
	const perpendicularBoundPx = RASTER_TOLERANCE_PX + halfHeightErrorPx + railCenterUncertaintyPx;
	const perpendicularMiss = Math.max(0, perpendicularError - perpendicularBoundPx);

	const fitKind = extractedRail ? 'rail-extracted' : 'rail-projection';
	return {
		centerXPx: cx + centerAlong * c + side * projectedCenterOffsetPx * nx,
		centerYPx: cy + centerAlong * ss + side * projectedCenterOffsetPx * ny,
		halfWidthPx: halfWidth,
		halfHeightPx: halfHeight,
		angleRad: angle,
		supportThicknessPx: thickness,
		fitKind,
		badgePerpendicularErrorPx: perpendicularError,
		badgePerpendicularMissPx: perpendicularMiss,
		badgePerpendicularBoundPx: perpendicularBoundPx,
		projectedLaneWidthPx: halfHeight * 2,
		observedRailSpanPx: railSpan,
		...(extractedRail ? {
			extractedRailAngleRad: extractedRail.angleRad,
			extractedRailLengthPx: extractedRail.lengthPx,
			extractedRailQualityScore: extractedRail.qualityScore
		} : {})
	};
}

/**
 * Build OccluderFootprints from existing occluder sources (badges, baskets,
 * screen chrome, and OpaqueDetector). This repackages data already computed
 * elsewhere rather than recomputing occluder geometry. Never re-derive.
 */
function buildOccluderFootprints(
	owned: Set<string>,
	stage: RecoveryStage,
	badges: readonly BadgeEvidence[],
	baskets: readonly BasketEvidence[],
	sprites: readonly SpriteMatch[] | undefined,
	chromeRegions: readonly { readonly x: number; readonly y: number; readonly width: number; readonly height: number; readonly componentCount: number }[],
	search: { readonly occlusion?: OpaqueDetector },
	viewportTopPx: number
): OccluderFootprint[] {
	const footprints: OccluderFootprint[] = [];

	// Badge interior pixels: every bright pixel inside each badge bbox.
	const badgePixels = new Set<string>();
	const [x0, y0, x1, y1] = [0, 0, stage.width - 1, stage.height - 1];
	for (const badge of badges) {
		const bx0 = Math.max(x0, badge.bbox[0]), bx1 = Math.min(x1, badge.bbox[0] + badge.bbox[2] - 1);
		const by0 = Math.max(y0, badge.bbox[1] - viewportTopPx), by1 = Math.min(y1, badge.bbox[1] - viewportTopPx + badge.bbox[3] - 1);
		for (let y = by0; y <= by1; y++) for (let x = bx0; x <= bx1; x++) {
			if (stage.brightLabels[y * stage.width + x] > 0) badgePixels.add(`${x},${y}`);
		}
	}
	if (badgePixels.size > 0) footprints.push({ kind: 'badge', pixels: badgePixels });

	// Basket sprite pixels: exact 1-cells from matched sprites.
	const basketPixels = new Set<string>();
	for (const basket of baskets) {
		for (const pixel of exactBasketPixels(stage, basket, sprites, viewportTopPx)) {
			basketPixels.add(pixel);
		}
	}
	if (basketPixels.size > 0) footprints.push({ kind: 'basket', pixels: basketPixels });

	// Screen chrome region pixels (Apple Maps attribution, etc.).
	const chromePixels = new Set<string>();
	for (const region of chromeRegions) {
		for (let y = Math.max(0, region.y); y < Math.min(stage.height, region.y + region.height); y++) {
			for (let x = Math.max(0, region.x); x < Math.min(stage.width, region.x + region.width); x++) {
				chromePixels.add(`${x},${y}`);
			}
		}
	}
	if (chromePixels.size > 0) footprints.push({ kind: 'screen-chrome', pixels: chromePixels });

	return footprints;
}

function fitComponent(
	pixels: readonly [number, number][],
	component: ComponentStats,
	target: BadgeEvidence,
	viewportTopPx: number,
	halfWidth: number,
	halfHeight: number,
	halfHeightErrorPx: number,
	thickness: number,
	occluders?: OccluderFootprint[]
): RecoveryFit {
	const projectedRail = projectRailFit(pixels, component, target, viewportTopPx, halfWidth, halfHeight, halfHeightErrorPx, thickness);
	if (projectedRail) return projectedRail;

	// When thin-band gate fails, attempt rail extraction from the component's
	// visible pixels and known occluders.
	if (occluders && occluders.length > 0) {
		const pxArray: Px[] = pixels.map(([x, y]) => [x, y]);
		// Degenerate-rail guard (owner ruling 2026-08-29): a rail's direction
		// comes from its span along its own axis. MIN_RAIL_PIXELS collinear
		// cells span at least MIN_RAIL_PIXELS-1 px; a "rail" with less extent
		// than that (the receipted 'length 0px, quality 0.000' rail once
		// PASSED projection on Heritage) states no direction and must not
		// drive a projection -- the candidate falls through to the
		// support-search fallback instead of being decided by noise.
		const railCandidates = extractRailCandidates(pxArray, occluders).filter(
			(rail) => rail.lengthPx >= MIN_RAIL_PIXELS - 1 && rail.qualityScore > 0
		);
		if (railCandidates.length > 0) {
			// Use the first (best-ranked) rail candidate. The extractor returns
			// candidates ranked by quality; we take the top one.
			// C-SOLVE: three sides of a broken ring pin the pose jointly -- a
			// parallel pair's midline is the pad's long axis (no side guess),
			// and an end rail fixes where along that axis the pad sits. The
			// pad points at its badge, so the aim is judged as an ANGLE.
			const solved = (() => {
				const long = railCandidates[0]!;
				const midOf = (pts: readonly (readonly [number, number])[]) => {
					let sx = 0, sy = 0; for (const [px2, py2] of pts) { sx += px2; sy += py2; }
					return [sx / pts.length, sy / pts.length] as const;
				};
				const [lmx, lmy] = midOf(long.points);
				const pnX = -Math.sin(long.angleRad), pnY = Math.cos(long.angleRad);
				// A true opposite side sits the pad's own short width away; a twin
				// edge of the same border band sits only a border thickness away
				// and must not be mistaken for the other side of the pad.
				const par = railCandidates.find((r) => {
					if (r === long) return false;
					const dAng = Math.abs(Math.atan2(Math.sin(r.angleRad - long.angleRad), Math.cos(r.angleRad - long.angleRad)));
					if (Math.min(dAng, Math.PI - dAng) > 0.18) return false;
					if (r.lengthPx < long.lengthPx * 0.4) return false;
					const [rmx, rmy] = midOf(r.points);
					const sep = Math.abs((rmx - lmx) * pnX + (rmy - lmy) * pnY);
					const want = 2 * halfHeight;
					return Math.abs(sep - want) <= Math.max(0, thickness) + 2 * RASTER_TOLERANCE_PX + 1;
				});
				const perp = railCandidates.find((r) =>
					Math.abs(Math.abs(Math.atan2(Math.sin(r.angleRad - long.angleRad), Math.cos(r.angleRad - long.angleRad))) - Math.PI / 2) < 0.35);
				if (!par && !perp) return undefined;
				const mid = midOf;
				const [lx, ly] = [lmx, lmy];
				const dirX = Math.cos(long.angleRad), dirY = Math.sin(long.angleRad);
				const nX = -dirY, nY = dirX;
				let cX: number, cY: number;
				if (par) {
					const [px2, py2] = mid(par.points);
					cX = (lx + px2) / 2; cY = (ly + py2) / 2;
				} else {
					// single long edge: center sits half the short width inward,
					// on whichever side holds more of the component's pixels.
					let side = 0;
					for (const [qx, qy] of pixels) side += Math.sign((qx - lx) * nX + (qy - ly) * nY);
					const sgn = side >= 0 ? 1 : -1;
					const inward = Math.max(0, halfHeight - Math.max(0, thickness) / 2);
					cX = lx + sgn * nX * inward; cY = ly + sgn * nY * inward;
				}
				if (perp) {
					const [ex, ey] = mid(perp.points);
					const along = (cX - ex) * dirX + (cY - ey) * dirY;
					const sgnA = along >= 0 ? 1 : -1;
					const inwardA = Math.max(0, halfWidth - Math.max(0, thickness) / 2);
					cX = ex + sgnA * dirX * inwardA; cY = ey + sgnA * dirY * inwardA;
				}
				const bX = target.cxPx, bY = target.cyPx - viewportTopPx;
				const aim = Math.atan2(bY - cY, bX - cX);
				const axisErr = Math.abs(Math.atan2(Math.sin(aim - long.angleRad), Math.cos(aim - long.angleRad)));
				const axisErrFolded = Math.min(axisErr, Math.PI - axisErr);
				if (axisErrFolded > activeAxisLimitRad) return undefined;
				// The solve enforced the aim angle, so its lane numbers are stated
				// honestly: error = how far the badge sits off the aim axis,
				// bound = the window that same angular tolerance sweeps at this
				// range, miss = 0 by construction (error <= bound always here).
				const rangePx = Math.hypot(bX - cX, bY - cY);
				const perpErrPx = Math.sin(axisErrFolded) * rangePx;
				const perpBoundPx = Math.tan(activeAxisLimitRad) * rangePx + RASTER_TOLERANCE_PX;
				const fit: RecoveryFit = {
					centerXPx: cX, centerYPx: cY,
					halfWidthPx: halfWidth, halfHeightPx: halfHeight,
					angleRad: aim,
					supportThicknessPx: Math.max(0, thickness),
					fitKind: 'rail-extracted',
					badgePerpendicularErrorPx: perpErrPx,
					badgePerpendicularBoundPx: perpBoundPx,
					badgePerpendicularMissPx: 0
				};
				return fit;
			})();
			if (solved) {
				const occluderKinds = new Set(occluders.map(f => f.kind));
				return {
					...solved,
					railCandidatesConsidered: railCandidates.length,
					occluderKindsSubtracted: Array.from(occluderKinds).sort()
				};
			}
			const bestRail = railCandidates[0]!;
			// An extracted rail is a boundary EDGE of the painted border, but the
			// projection math expects the border band's CENTERLINE (the same line
			// whether the chain came from the band's outer or inner edge -- which
			// is what makes a broken-ring fragment safe). Re-center each rail
			// point onto the midpoint of the bright run found along the rail's
			// normal within one border thickness.
			const nx = -Math.sin(bestRail.angleRad);
			const ny = Math.cos(bestRail.angleRad);
			const reach = Math.max(1, Math.ceil(Math.max(0, thickness)) + 1);
			const pixelKeySet = new Set(pixels.map(([px2, py2]) => `${px2},${py2}`));
			const centered: [number, number][] = bestRail.points.map(([rx, ry]) => {
				let lo = 0, hi = 0;
				for (let d = 1; d <= reach; d++) {
					if (pixelKeySet.has(`${Math.round(rx + nx * d)},${Math.round(ry + ny * d)}`)) hi = d; else break;
				}
				for (let d = 1; d <= reach; d++) {
					if (pixelKeySet.has(`${Math.round(rx - nx * d)},${Math.round(ry - ny * d)}`)) lo = d; else break;
				}
				const mid = (hi - lo) / 2;
				return [rx + nx * mid, ry + ny * mid];
			});
			const centeredRail = { ...bestRail, points: centered as readonly (readonly [number, number])[] };
			const railFit = projectRailFit(pixels, component, target, viewportTopPx, halfWidth, halfHeight, halfHeightErrorPx, thickness, centeredRail);
			if (railFit) {
				// Track extraction metadata for receipts.
				const occluderKinds = new Set(occluders.map(f => f.kind));
				return {
					...railFit,
					railCandidatesConsidered: railCandidates.length,
					occluderKindsSubtracted: Array.from(occluderKinds).sort()
				};
			}
		}
	}
	// Non-rail fragments retain the legacy full-support feasibility fallback.
	const outerRadius = Math.hypot(
		halfWidth + RASTER_TOLERANCE_PX,
		halfHeight + RASTER_TOLERANCE_PX
	);
	let minCenterX = -Infinity, maxCenterX = Infinity;
	let minCenterY = -Infinity, maxCenterY = Infinity;
	for (const [x, y] of pixels) {
		minCenterX = Math.max(minCenterX, x - outerRadius);
		maxCenterX = Math.min(maxCenterX, x + outerRadius);
		minCenterY = Math.max(minCenterY, y - outerRadius);
		maxCenterY = Math.min(maxCenterY, y + outerRadius);
	}
	const badgeX = target.cxPx;
	const badgeY = target.cyPx - viewportTopPx;
	const fallback: RecoveryFit = {
		centerXPx: component.cx,
		centerYPx: component.cy,
		halfWidthPx: halfWidth,
		halfHeightPx: halfHeight,
		angleRad: Math.atan2(badgeY - component.cy, badgeX - component.cx),
		supportThicknessPx: thickness,
		fitKind: 'support-search'
	};
	if (minCenterX > maxCenterX || minCenterY > maxCenterY) return fallback;

	let best = fallback;
	let bestUnexplained = Infinity;
	let bestResidual = Infinity;
	let bestAxisOffset = Infinity;

	const outerHalfWidth = halfWidth + RASTER_TOLERANCE_PX;
	const outerHalfHeight = halfHeight + RASTER_TOLERANCE_PX;
	const effectiveThickness = Math.max(0, thickness);
	const innerEdgeU = halfWidth - effectiveThickness - RASTER_TOLERANCE_PX;
	const innerEdgeV = halfHeight - effectiveThickness - RASTER_TOLERANCE_PX;
	const scanRangeDeg = Math.max(0.5, activeAxisLimitDeg - 0.5);
	const axisOffsets: { rad: number; c: number; s: number }[] = [];
	for (let degrees = -scanRangeDeg; degrees <= scanRangeDeg + 1e-9; degrees += 0.5) {
		const rad = degrees * Math.PI / 180;
		axisOffsets.push({ rad, c: Math.cos(rad), s: Math.sin(rad) });
	}

	const consider = (
		centerX: number,
		centerY: number,
		rayC: number,
		rayS: number,
		axisOffset: { rad: number; c: number; s: number }
	) => {
		// cos(ray + offset), sin(ray + offset), with the tiny offset trig cached
		// once per fit call instead of invoking sin/cos for every pose.
		const c = rayC * axisOffset.c - rayS * axisOffset.s;
		const s = rayS * axisOffset.c + rayC * axisOffset.s;
		let unexplained = 0;
		for (const point of pixels) {
			const dx = point[0] - centerX;
			const dy = point[1] - centerY;
			const u = dx * c + dy * s;
			const v = -dx * s + dy * c;
			const absU = Math.abs(u);
			const absV = Math.abs(v);
			if (
				absU > outerHalfWidth ||
				absV > outerHalfHeight ||
				(absU < innerEdgeU && absV < innerEdgeV)
			) {
				unexplained++;
				if (unexplained > bestUnexplained) break;
			}
		}
		if (unexplained > bestUnexplained) return;

		let residual = 0;
		for (const point of pixels) {
			const dx = point[0] - centerX;
			const dy = point[1] - centerY;
			const u = dx * c + dy * s;
			const v = -dx * s + dy * c;
			const absU = Math.abs(u);
			const absV = Math.abs(v);
			const outer = Math.hypot(
				Math.max(0, absU - halfWidth),
				Math.max(0, absV - halfHeight)
			);
			const edgeDistance = Math.min(
				Math.abs(absU - halfWidth),
				Math.abs(absV - halfHeight)
			);
			residual += outer * 4 + edgeDistance;
		}
		const absOffset = Math.abs(axisOffset.rad);
		if (
			unexplained < bestUnexplained ||
			(unexplained === bestUnexplained && residual < bestResidual) ||
			(unexplained === bestUnexplained && residual === bestResidual && absOffset < bestAxisOffset)
		) {
			// Preserve the detector's original stored angle expression exactly;
			// vector arithmetic is only the hot-loop evaluator.
			const badgeRay = Math.atan2(badgeY - centerY, badgeX - centerX);
			best = {
				centerXPx: centerX,
				centerYPx: centerY,
				halfWidthPx: halfWidth,
				halfHeightPx: halfHeight,
				angleRad: badgeRay + axisOffset.rad,
				supportThicknessPx: thickness,
				fitKind: 'support-search'
			};
			bestUnexplained = unexplained;
			bestResidual = residual;
			bestAxisOffset = absOffset;
		}
	};

	// Exact broad phase over the SAME center lattice. Every pixel of any legal
	// rotated tee must satisfy both necessary bounds below. They only prove a
	// center impossible; they never remove a component, badge, or legal pose.
	const outerRadiusSq = outerRadius * outerRadius;
	let rayFrameHalfWidth = 0;
	let rayFrameHalfHeight = 0;
	for (const axisOffset of axisOffsets) {
		rayFrameHalfWidth = Math.max(
			rayFrameHalfWidth,
			outerHalfWidth * Math.abs(axisOffset.c) + outerHalfHeight * Math.abs(axisOffset.s)
		);
		rayFrameHalfHeight = Math.max(
			rayFrameHalfHeight,
			outerHalfWidth * Math.abs(axisOffset.s) + outerHalfHeight * Math.abs(axisOffset.c)
		);
	}
	const broadPhaseEpsilon = 1e-9;
	for (let y = minCenterY; y <= maxCenterY + 1e-9; y += 0.5) {
		for (let x = minCenterX; x <= maxCenterX + 1e-9; x += 0.5) {
			let possible = true;
			for (const point of pixels) {
				const dx = point[0] - x;
				const dy = point[1] - y;
				if (dx * dx + dy * dy > outerRadiusSq + broadPhaseEpsilon) {
					possible = false;
					break;
				}
			}
			if (!possible) continue;

			const rayX = badgeX - x;
			const rayY = badgeY - y;
			const rayLength = Math.hypot(rayX, rayY);
			const rayC = rayLength === 0 ? 1 : rayX / rayLength;
			const rayS = rayLength === 0 ? 0 : rayY / rayLength;
			for (const point of pixels) {
				const dx = point[0] - x;
				const dy = point[1] - y;
				const u = dx * rayC + dy * rayS;
				const v = -dx * rayS + dy * rayC;
				if (
					Math.abs(u) > rayFrameHalfWidth + broadPhaseEpsilon ||
					Math.abs(v) > rayFrameHalfHeight + broadPhaseEpsilon
				) {
					possible = false;
					break;
				}
			}
			if (!possible) continue;

			for (const axisOffset of axisOffsets) consider(x, y, rayC, rayS, axisOffset);
		}
	}
	return best;
}

/** A component whose measured PCA span covers both course-local pad axes owns
 * useful center/angle testimony even when its area/fill proves it incomplete.
 * Smaller or split shards stay on the badge-constrained support fit: their
 * centroids are not tee centers. The three-cell allowance is raster geometry,
 * not a course-specific offset. */
function fullSpanComponentLocalization(
	component: ComponentStats,
	halfWidth: number,
	halfHeight: number,
	thickness: number
): RecoveryFit | undefined {
	const spanAllowance = 3 * RASTER_TOLERANCE_PX;
	if (
		component.major + spanAllowance < halfWidth * 2 ||
		component.minor + spanAllowance < halfHeight * 2
	) return undefined;
	return {
		centerXPx: component.cx,
		centerYPx: component.cy,
		halfWidthPx: halfWidth,
		halfHeightPx: halfHeight,
		angleRad: component.angle,
		supportThicknessPx: thickness
	};
}

/** Recompute PCA after ownership/occlusion subtraction. ComponentStats from
 * the global mask may still include pixels now owned by another object, and
 * those pixels must never influence recovered localization. */
function exactVisibleStats(
	label: number,
	pixels: readonly (readonly [number, number])[]
): ComponentStats | undefined {
	if (pixels.length < 2) return undefined;
	const xs = new Float64Array(pixels.length);
	const ys = new Float64Array(pixels.length);
	let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
	for (let index = 0; index < pixels.length; index++) {
		const [x, y] = pixels[index]!;
		xs[index] = x;
		ys[index] = y;
		minX = Math.min(minX, x);
		maxX = Math.max(maxX, x);
		minY = Math.min(minY, y);
		maxY = Math.max(maxY, y);
	}
	return statsForPixels(
		label,
		{ xs, ys, count: pixels.length },
		minX,
		minY,
		maxX - minX + 1,
		maxY - minY + 1
	) ?? undefined;
}

function componentPixels(stage: RecoveryStage, component: ComponentStats): [number, number][] {
	const pixels: [number, number][] = [];
	for (let y = component.bboxY; y < component.bboxY + component.bboxH; y++) {
		for (let x = component.bboxX; x < component.bboxX + component.bboxW; x++) {
			if (stage.brightLabels[y * stage.width + x] === component.label) pixels.push([x, y]);
		}
	}
	return pixels;
}

interface RecoveryStage {
	readonly brightLabels: Int32Array;
	readonly brightComponents: readonly ComponentStats[];
	readonly brightMask: Mask;
	readonly width: number;
	readonly height: number;
}

interface RecoveryViewport { readonly topPx: number }

/** Legacy-shaped internal adapter telling the existing candidate builder
 * which numbered badges already have visible-tee coverage. These rows are produced locally
 * from G3 tee-pad axes; they are NOT G6 assignments. basketId is a compatibility
 * placeholder and is never read by shard recovery. */
export interface TeeRecoveryAssignmentContext {
	readonly assignments: readonly { readonly badgeId: string; readonly basketId: string }[];
}

export interface TeeRecoverySearchContext {
	readonly assignment?: TeeRecoveryAssignmentContext;
	readonly sprites?: readonly SpriteMatch[];
	/** The run-scoped service is queried only for exact OPAQUE sprite pixels.
	 * ALPHA and UNKNOWN never remove white evidence. */
	readonly occlusion?: OpaqueDetector;
}

function numberLabel(badge: BadgeEvidence): number | undefined {
	if (!/^\d+$/.test(badge.label ?? '')) return undefined;
	const n = Number(badge.label);
	return Number.isInteger(n) && n > 0 ? n : undefined;
}


export interface VisibleTeeBadgeRayClaim {
	readonly teeId: string;
	readonly badgeId: string;
	readonly badgeLabel: string | null;
	readonly axisErrorRad: number;
	readonly perpendicularErrorPx: number;
	readonly alongPx: number;
	readonly direction: -1 | 1;
}

export interface VisibleTeeBadgeRayResolution {
	/** Every first-intercept claim supported by a visible tee half-rail. */
	readonly claims: readonly VisibleTeeBadgeRayClaim[];
	/** Strictly unique tee↔badge claims. Locks are belief; claims remain evidence. */
	readonly locks: readonly VisibleTeeBadgeRayClaim[];
	/** Union of every badge touched by POSSIBLE visible-tee testimony. Only a
	 * numbered badge absent from this set is eligible for recovery. */
	readonly coveredBadgeIds: readonly string[];
	readonly ambiguousTeeIds: readonly string[];
	readonly conflictedBadgeIds: readonly string[];
}

/** Tee-pad major axes are undirected: theta and theta+pi are identical. */
function undirectedAxisError(axisRad: number, rayRad: number): number {
	const delta = Math.abs(Math.atan2(Math.sin(axisRad - rayRad), Math.cos(axisRad - rayRad)));
	return Math.min(delta, Math.PI - delta);
}

/**
 * Cheap G4 testimony for already-visible tees. A tee claims a numbered badge
 * only when exactly one badge lies on its own measured pad axis within the
 * same strict tolerance used by recovery, and that badge has exactly one tee
 * claimant. Any ambiguity stays unclaimed and therefore widens recovery.
 */
export function resolveVisibleTeeBadgeRays(
	tees: readonly TeeEvidence[],
	badges: readonly BadgeEvidence[]
): VisibleTeeBadgeRayResolution {
	const numbered = badges.filter((badge) => numberLabel(badge) !== undefined);
	const claims: VisibleTeeBadgeRayClaim[] = [];
	const ambiguousTeeIds: string[] = [];

	for (const tee of tees) {
		const pose = tee.pad?.minAreaPose;
		const axisRad = pose?.angleRad ?? tee.pad?.angleRad ?? tee.angleRad;
		const xPx = pose?.centerXPx ?? tee.pad?.centerXPx ?? tee.xPx;
		const yPx = pose?.centerYPx ?? tee.pad?.centerYPx ?? tee.yPx;
		const majorPx = pose?.majorPx ?? tee.pad?.majorPx;
		const minorPx = pose?.minorPx ?? tee.pad?.minorPx;
		if (!tee.pad || axisRad === null || !Number.isFinite(axisRad) || !majorPx || !minorPx) continue;
		const c = Math.cos(axisRad), ss = Math.sin(axisRad);
		// POSSIBLE testimony is intentionally a pad-width corridor, not a point
		// winner. It exists only to answer "could this already-visible tee own
		// this badge?" so G4 does not hallucinate a recovery on top of evidence
		// it already has. Later stages may resolve the relation.
		const halfLane = minorPx / 2 + RASTER_TOLERANCE_PX;
		const halfPad = majorPx / 2;
		const byDirection = new Map<-1 | 1, { claim: VisibleTeeBadgeRayClaim; alongPx: number }[]>();
		for (const badge of numbered) {
			const dx = badge.cxPx - xPx;
			const dy = badge.cyPx - yPx;
			const along = dx * c + dy * ss;
			const perpendicular = Math.abs(-dx * ss + dy * c);
			if (perpendicular > halfLane || Math.abs(along) <= halfPad) continue;
			const direction = (along < 0 ? -1 : 1) as -1 | 1;
			const bucket = byDirection.get(direction) ?? [];
			bucket.push({
				claim: {
					teeId: tee.detId,
					badgeId: badge.detId,
					badgeLabel: badge.label,
					axisErrorRad: undirectedAxisError(axisRad, Math.atan2(dy, dx)),
					perpendicularErrorPx: perpendicular,
					alongPx: Math.abs(along),
					direction
				},
				alongPx: Math.abs(along)
			});
			byDirection.set(direction, bucket);
		}
		const firstIntercepts: VisibleTeeBadgeRayClaim[] = [];
		for (const bucket of byDirection.values()) {
			bucket.sort((a, b) => a.alongPx - b.alongPx || a.claim.badgeId.localeCompare(b.claim.badgeId));
			if (bucket[0]) firstIntercepts.push(bucket[0].claim);
		}
		claims.push(...firstIntercepts);
		if (firstIntercepts.length > 1) ambiguousTeeIds.push(tee.detId);
	}

	const byTee = new Map<string, VisibleTeeBadgeRayClaim[]>();
	const byBadge = new Map<string, VisibleTeeBadgeRayClaim[]>();
	for (const claim of claims) {
		const teeBucket = byTee.get(claim.teeId);
		if (teeBucket) teeBucket.push(claim); else byTee.set(claim.teeId, [claim]);
		const badgeBucket = byBadge.get(claim.badgeId);
		if (badgeBucket) badgeBucket.push(claim); else byBadge.set(claim.badgeId, [claim]);
	}
	const locks = claims.filter((claim) =>
		(byTee.get(claim.teeId)?.length ?? 0) === 1 &&
		(byBadge.get(claim.badgeId)?.length ?? 0) === 1
	);
	const conflictedBadgeIds = [...byBadge.entries()]
		.filter(([, bucket]) => bucket.length > 1)
		.map(([badgeId]) => badgeId)
		.sort();
	const coveredBadgeIds = [...new Set(claims.map((claim) => claim.badgeId))].sort();
	claims.sort((a, b) => a.badgeId.localeCompare(b.badgeId) || a.teeId.localeCompare(b.teeId));
	locks.sort((a, b) => a.badgeId.localeCompare(b.badgeId) || a.teeId.localeCompare(b.teeId));
	ambiguousTeeIds.sort();
	return { claims, locks, coveredBadgeIds, ambiguousTeeIds, conflictedBadgeIds };
}

function exactBasketPixels(
	stage: RecoveryStage,
	basket: BasketEvidence,
	sprites: readonly SpriteMatch[] | undefined,
	viewportTopPx: number
): Set<string> {
	const owned = new Set<string>();
	const source = sprites?.find((sprite) =>
		Math.abs(sprite.cx - basket.centerXPx) < 3 && Math.abs(sprite.cy + viewportTopPx - basket.centerYPx) < 3
	);
	if (source) {
		// The asset's 1-cells are the fixed renderer-owned white rows.  A bright
		// anomaly in the semantic bbox is not removed unless it is one of these
		// exact owned cells.
		const rows = (basketSpriteData as { readonly rows: readonly string[] }).rows;
		for (let y = 0; y < rows.length; y++) for (let x = 0; x < rows[y]!.length; x++) {
			if (rows[y]![x] !== '1') continue;
			const gx = source.x + x;
			const gy = source.y + y;
			if (gx >= 0 && gx < stage.width && gy >= 0 && gy < stage.height && stage.brightMask.data[gy * stage.width + gx]) owned.add(`${gx},${gy}`);
		}
	}
	// Without a matched sprite we cannot honestly attribute any basket pixel.
	// The semantic bbox only bounds the local graph; it is never ownership.
	return owned;
}

/** Every bright pixel already spoken for: basket sprites, badge interiors,
 * and known tee pads. Recovery discovery never claims spatial bounds of its
 * own -- ownership always spans the whole canonical raster, for every
 * basket, not only the one the caller happens to be near. */
function exactKnownPixels(stage: RecoveryStage, badges: readonly BadgeEvidence[], tees: readonly TeeEvidence[], baskets: readonly BasketEvidence[], sprites: readonly SpriteMatch[] | undefined, viewportTopPx: number): Set<string> {
	const owned = new Set<string>();
	for (const basket of baskets) for (const pixel of exactBasketPixels(stage, basket, sprites, viewportTopPx)) owned.add(pixel);
	const [x0, y0, x1, y1] = [0, 0, stage.width - 1, stage.height - 1];
	// NOTE (2026-08-29, integration night): do NOT own bright pixels inside
	// basket semantic bboxes the way badges do below. It was tried, to kill
	// basket furniture masquerading as remnants, and it silently ate REAL
	// occluded-tee evidence -- Heritage T10's dim pad sits inside basket-7's
	// bbox and vanished from candidacy (never rejected, never accepted).
	// Basket bboxes CONTAIN tee remnants by design; that is the whole
	// occluded-tee-recovery domain. Badge ownership is safe because badge
	// plates are opaque chrome; basket glyphs are not.
	for (const badge of badges) {
		// Own EVERY bright pixel inside the badge bbox, not only the plate
		// outline's own component: the digit glyphs are separate bright
		// components inside the plate's dark interior, and un-owned they
		// masquerade as "visible tee shards" (observed on NorthPark: H14's
		// rejected recovery candidate was badge 15's "5" glyph, H16's was
		// badge 16's own "1"). G3 already excludes rings inside badge bboxes
		// as chrome; recovery must treat badge interiors the same way.
		const bx0 = Math.max(x0, badge.bbox[0]), bx1 = Math.min(x1, badge.bbox[0] + badge.bbox[2] - 1);
		const by0 = Math.max(y0, badge.bbox[1] - viewportTopPx), by1 = Math.min(y1, badge.bbox[1] - viewportTopPx + badge.bbox[3] - 1);
		for (let y = by0; y <= by1; y++) for (let x = bx0; x <= bx1; x++) if (stage.brightLabels[y * stage.width + x] > 0) owned.add(`${x},${y}`);
	}
	for (const tee of tees) {
		const label = tee.pad?.componentLabel;
		if (label === undefined) continue;
		const tb = tee.pad?.bbox;
		if (!tb) continue;
		const tx0 = Math.max(x0, tb[0]), tx1 = Math.min(x1, tb[0] + tb[2] - 1);
		const ty0 = Math.max(y0, tb[1] - viewportTopPx), ty1 = Math.min(y1, tb[1] - viewportTopPx + tb[3] - 1);
		for (let y = ty0; y <= ty1; y++) for (let x = tx0; x <= tx1; x++) if (stage.brightLabels[y * stage.width + x] === label) owned.add(`${x},${y}`);
	}
	return owned;
}

/** Stable OpaqueDetector-provider shape for this run. Only fixed, bright
 * basket sprite 1-cells are claimed; bboxes remain traversal bounds. */
function basketOpaqueProvider(
	stage: RecoveryStage,
	baskets: readonly BasketEvidence[],
	sprites: readonly SpriteMatch[] | undefined,
	viewportTopPx: number
): OpaqueDetector {
	const points = new Set<string>();
	for (const basket of baskets) {
		for (const pixel of exactBasketPixels(stage, basket, sprites, viewportTopPx)) {
			const [x, y] = pixel.split(',').map(Number);
			points.add(`${x},${y + viewportTopPx}`);
		}
	}
	return {
		kindAt(xPx, yPx) {
			return points.has(`${xPx},${yPx}`) ? 'OPAQUE' : 'UNKNOWN';
		}
	};
}

/**
 * FORENSIC HISTORY (2026-08-28), kept for the diagnostic measure below, no
 * longer used to gate discovery:
 *
 * Root-cause finding for "NorthPark H16/H14 candidates=0": traced
 * buildTeeRecoveryCandidates on the real NorthPark canonical raster with the
 * predecessor-basket-radius box that used to gate discovery.
 *   - H16 (badge 16): its own tee pad IS the 19x14/area-153 bright component
 *     at (798,1169), right next to badge 16's own bbox [870,1143,55,42]. That
 *     component's coordinate math DOES land inside the old ~89px predecessor
 *     radius box (distance to basket-9's tip (764,1123) = 57px < radius
 *     88.59px). It was excluded anyway: `ownership`, not the region test,
 *     killed it. G3 had already registered this exact component as
 *     `tee-11`'s pad (componentLabel 306), and G5/G6 assignment/scoring had
 *     mis-paired tee-11 to badge-4 (hole 12) with a near-zero garbage score
 *     (2.4e-13) instead of hole 16. `exactKnownPixels` correctly owns every
 *     pixel of any already-known tee pad (by design -- G4 must never
 *     re-discover a G3-visible tee as a "stray" shard), so the component
 *     never reaches `visibleComponents` regardless of box size. This is an
 *     assignment/scoring bug (a tee stolen by a near-zero-score row), not a
 *     discovery-region bug; no widening of the search region can fix it.
 *   - H14 (badge 14): no bright component anywhere near badge 14's own bbox
 *     [674,946,56,42] was ever registered as a tee pad by G3 at all -- this
 *     is a genuine "tee not yet discovered" case. Its predecessor's basket
 *     (basket-8, hole 13's basket, tip (919,1095)) sits ~245px from badge
 *     14's own position, well outside the ~89px predecessor-anchored box, so
 *     the old box structurally could never search where H14's evidence (if
 *     any survives on the raster) would be. This is the genuine discovery
 *     footgun the owner's law names: a search bound baked to "touches basket
 *     N-1" cannot see a hole whose course geometry does not chain that way.
 *
 * Fix direction taken: discovery now has NO spatial prefilter at all (see
 * buildTeeRecoveryCandidates) -- every unowned, non-occluded bright
 * component on the whole canonical raster is a candidate for every missing
 * badge, and the strict acceptance predicate is the only filter. That
 * structurally covers the H14 shape of bug. It cannot fix the H16 shape of
 * bug (an already-known tee stolen by assignment/scoring), which is out of
 * scope for this lane.
 */
export function graphCandidateResult(candidate: TeeRecoveryCandidate): TeeRecoveryResult {
	const support = candidate.fragmentPixels.length;
	const componentCount = candidate.supportingComponentIds.length;
	const axisError = badgeAxisError(candidate);
	const railMissPx = (candidate.fit.fitKind === 'rail-projection' || candidate.fit.fitKind === 'rail-extracted') ? candidate.fit.badgePerpendicularMissPx ?? Infinity : undefined;
	const axisRejected = candidate.badgeLabel !== null && candidate.badgeLabel !== undefined && /^\d+$/.test(candidate.badgeLabel) && (
		railMissPx !== undefined ? railMissPx > 0 : (axisError ?? Infinity) >= activeAxisLimitRad
	);
	const { contradictions: unexplained, interiorExcusedPx } = partitionUnexplainedPixels(candidate);
	const insufficientSupport = support < MIN_SHARD_SUPPORT_PIXELS;
	const ambiguity = (candidate.ambiguityWithBadgeLabels?.length ?? 0) > 0;
	const notOccluderAdjacent =
		candidate.occluderAdjacent === false && candidate.dimRailEscape?.qualifies !== true;
	const accepted =
		!insufficientSupport && unexplained.length === 0 && !axisRejected && !ambiguity && !notOccluderAdjacent;
	const localized = poseOf(candidate);
	const coordinateOffset = candidate.coordinateFrame === 'original' ? 0 : candidate.viewportTopPx ?? 0;
	const localizationEvidence = candidate.localizationSource === 'full-span-component-pca'
		? '; localization uses the exact centroid/axis of the single detector-owned component spanning both course-local pad axes'
		: '; localization uses the badge-constrained support fit because the visible evidence is small or split';
	const interiorNote = interiorExcusedPx > 0
		? `; interiorExcusedPx=${interiorExcusedPx} (holepath ruling 2026-08-29: the hole path is wider than the pad and runs beneath it, so brights inside the hollow are the path showing through -- excused, never evidence, never a contradiction)`
		: '';
	const pixelEvidence = (unexplained.length
		? `; unexplained visible component pixels: ${unexplained.slice(0, 8).map(([x, y]) => `(${x},${y})`).join(', ')}${unexplained.length > 8 ? ` (+${unexplained.length - 8} more)` : ''}`
		: '') + interiorNote;
	// This candidate is already anchored to one specific badge (target.badge in
	// buildTeeRecoveryCandidates), so the real hole number is known whenever an
	// exact digit read exists — surface it so a rejection is legible without
	// cross-referencing the raw badgeId embedded in candidate.id/ref.
	const holePrefix = candidate.badgeLabel && /^\d+$/.test(candidate.badgeLabel)
		? `badge ${candidate.badgeLabel}: `
		: '';
	// Owner policy 2026-08-28: discovery has no spatial prefilter of any kind
	// (no predecessor-basket radius, no course-derived distribution box). Every
	// unowned, non-occluded bright component on the whole canonical raster is a
	// candidate; the strict acceptance predicate below is the only filter. This
	// line states that scope so a rejection or acceptance is never mistaken for
	// "outside the searched region" -- there is no region.
	const searchScope = `considered all ${candidate.consideredComponentsGlobal ?? 0} unowned, non-occluded bright component${candidate.consideredComponentsGlobal === 1 ? '' : 's'} on the whole canonical raster (global bright mask; no spatial prefilter)`;
	const railExtractionNote = candidate.fit.fitKind === 'rail-extracted'
		? ` Rail-extracted fit: angle ${(candidate.fit.extractedRailAngleRad ?? 0).toFixed(3)} rad, length ${(candidate.fit.extractedRailLengthPx ?? 0).toFixed(0)}px, quality ${(candidate.fit.extractedRailQualityScore ?? 0).toFixed(3)}, from ${candidate.fit.railCandidatesConsidered ?? 0} candidate${(candidate.fit.railCandidatesConsidered ?? 0) === 1 ? '' : 's'}, with occluders subtracted: ${(candidate.fit.occluderKindsSubtracted ?? []).join(', ') || 'none'}.`
		: '';

	// Every failed gate prints -- a rejection names ALL its reasons, so a
	// reader never mistakes "adjacency failed" for "the fit was fine".
	const adjacencyClause = notOccluderAdjacent
		? `; component group touches NO known-occluder footprint within the 2px raster adjacency allowance -- by the completeness invariant a partially-occluded tee's remnant must touch its occluder, so this is scenery or a G3-owned miss, never a recovery claim` +
			(candidate.dimRailEscape
				? `; dim-rail escape refused: singleShard=${candidate.dimRailEscape.singleShard} alongSpanPx=${candidate.dimRailEscape.alongSpanPx.toFixed(1)} (floor ${candidate.dimRailEscape.alongFloorPx.toFixed(1)} = course's shortest pad side) acrossSpanPx=${candidate.dimRailEscape.acrossSpanPx.toFixed(1)} (cap ${candidate.dimRailEscape.acrossCapPx.toFixed(1)} = two wall thicknesses + raster tolerance)`
				: '')
		: '';
	const reason = accepted
		? `every non-occluded visible component pixel across ${componentCount} visible shard${componentCount === 1 ? '' : 's'} fits a course-local hollow tee support whose major axis points at badge ${candidate.badgeLabel ?? candidate.badgeId ?? 'UNKNOWN'}; ${searchScope}${localizationEvidence}${railExtractionNote}`
		: ambiguity
			? `${holePrefix}${searchScope}; this exact component set also supports badge${candidate.ambiguityWithBadgeLabels!.length === 1 ? '' : 's'} ${candidate.ambiguityWithBadgeLabels!.join(', ')}; multiclaim preserved and every claimant is DEFERRED — G4 selects no local winner${adjacencyClause}`
			: `${holePrefix}${searchScope}; ${insufficientSupport
				? `visible component support ${support} < ${MIN_SHARD_SUPPORT_PIXELS}`
				: `${axisRejected
					? candidate.fit.fitKind === 'rail-projection'
						? `observed rail projected by the known pad width misses the inferred centerline bound by ${(candidate.fit.badgePerpendicularMissPx ?? Infinity).toFixed(3)}px (centerline error ${(candidate.fit.badgePerpendicularErrorPx ?? Infinity).toFixed(3)}px > built-in ${(candidate.fit.badgePerpendicularBoundPx ?? Infinity).toFixed(3)}px error bound)`
						: candidate.fit.fitKind === 'rail-extracted'
						? `extracted rail fit centerline miss: ${(candidate.fit.badgePerpendicularMissPx ?? Infinity).toFixed(3)}px (error ${(candidate.fit.badgePerpendicularErrorPx ?? Infinity).toFixed(3)}px > bound ${(candidate.fit.badgePerpendicularBoundPx ?? Infinity).toFixed(3)}px); ${railExtractionNote}`
						: `badge-axis angular error ${(axisError! * 180 / Math.PI).toFixed(3)}° is not < ${activeAxisLimitDeg}° (non-rail fallback only)`
					: candidate.fit.fitKind === 'rail-projection'
						? `rail projection passes: centerline error ${(candidate.fit.badgePerpendicularErrorPx ?? Infinity).toFixed(3)}px <= built-in ${(candidate.fit.badgePerpendicularBoundPx ?? Infinity).toFixed(3)}px bound from known pad width + observed rail + raster error; no badge-driven pose search was performed`
						: candidate.fit.fitKind === 'rail-extracted'
						? `extracted rail projection passes: centerline error ${(candidate.fit.badgePerpendicularErrorPx ?? Infinity).toFixed(3)}px <= bound; ${railExtractionNote}`
						: `no hollow tee support fit within ${activeAxisLimitDeg}° of the badge ray explains every visible component pixel (non-rail fallback only)`}${unexplained.length ? pixelEvidence : '; visible component pixels otherwise lie on the fitted support footprint'}${adjacencyClause}`}`;
	return {
		id: candidate.id,
		verdict: accepted ? 'accepted' : 'rejected',
		reason,
		values: {
			supportingPixels: support,
			supportingComponents: componentCount,
			coordinateFrame: 'original-image',
			supportFitCenterXPx: candidate.fit.centerXPx,
			supportFitCenterYPx: candidate.fit.centerYPx + coordinateOffset,
			localizedCenterXPx: localized.centerXPx,
			localizedCenterYPx: localized.centerYPx + coordinateOffset,
			fullSpanComponentLocalization: candidate.localizationSource === 'full-span-component-pca' ? 1 : 0,
			...(axisError === undefined ? {} : { badgeAxisAlignment: Math.cos(axisError), badgeAxisErrorRad: axisError }),
			...(candidate.fit.fitKind === 'rail-projection' ? {
				badgePerpendicularErrorPx: candidate.fit.badgePerpendicularErrorPx ?? Infinity,
				badgePerpendicularMissPx: candidate.fit.badgePerpendicularMissPx ?? Infinity,
				badgePerpendicularBoundPx: candidate.fit.badgePerpendicularBoundPx ?? Infinity,
				projectedLaneWidthPx: candidate.fit.projectedLaneWidthPx ?? 0,
				observedRailSpanPx: candidate.fit.observedRailSpanPx ?? 0,
				railProjection: 1
			} : candidate.fit.fitKind === 'rail-extracted' ? {
				badgePerpendicularErrorPx: candidate.fit.badgePerpendicularErrorPx ?? Infinity,
				badgePerpendicularMissPx: candidate.fit.badgePerpendicularMissPx ?? Infinity,
				badgePerpendicularBoundPx: candidate.fit.badgePerpendicularBoundPx ?? Infinity,
				projectedLaneWidthPx: candidate.fit.projectedLaneWidthPx ?? 0,
				observedRailSpanPx: candidate.fit.observedRailSpanPx ?? 0,
				railExtracted: 1,
				extractedRailAngleRad: candidate.fit.extractedRailAngleRad ?? 0,
				extractedRailLengthPx: candidate.fit.extractedRailLengthPx ?? 0,
				extractedRailQualityScore: candidate.fit.extractedRailQualityScore ?? 0,
				railCandidatesConsidered: candidate.fit.railCandidatesConsidered ?? 0
			} : {}),
			...(unexplained.length ? { unexplainedVisiblePixels: unexplained.length } : {})
		},
		corners: cornersFor(candidate, {})
	};
}

/** One badge's best-fit candidate plus the runners-up considered for it,
 * kept so a candidate-less or ambiguous target still prints exactly what was
 * searched instead of vanishing silently. */
interface TargetSearchOutcome {
	readonly badgeId: string;
	readonly badgeLabel: string | null;
	readonly consideredComponents: number;
	readonly winner?: TeeRecoveryCandidate;
	/** Every other component group considered for this badge, most-supported
	 * first. Not capped here -- the receipt caller caps what it prints. */
	readonly runnerUps: readonly TeeRecoveryCandidate[];
}

/** Records that a component was NOT dropped whole but had K of its pixels
 * subtracted as a known screen-chrome occluder, so the exclusion is always
 * receipt-visible ("no silent cuts"). */
interface ChromeSubtractionNote {
	readonly componentLabel: number;
	readonly subtractedPixels: number;
	readonly remainingPixels: number;
	readonly regionCount: number;
}

/** Records that a component group was silently dropped as a duplicate, so every
 * drop is receipt-visible. */
interface SilentDuplicateDropNote {
	readonly badgeId: string;
	readonly badgeLabel: string | null;
	readonly groupKey: string;
	readonly duplicateOfGroupKey: string;
}

/**
 * DESIGN NOTE, designed-but-deferred (owner request 2026-08-28): C1S/C2D
 * range-circle dash subtraction.
 *
 * Every basket renders a solid C1S ring (10m real radius) and a dashed C2D
 * ring (20m real radius) around its tip. Each dash is a small bright
 * component lying on a common circle, and their fragments can satisfy the
 * hollow-tee-support predicate the same way a screen-chrome glyph can. The
 * z-order is NOT fixed: NorthPark's T16 pad renders ON TOP of its C2D (the
 * pad is the non-occluded case -- see targetPredecessors' forensic note and
 * the classification table in the final report), while DashsTrack's T5 pad
 * renders UNDER its C2D (the genuinely occluded case). Either way, the fix
 * must be PIXEL subtraction, never whole-component removal: dropping any
 * component that touches a range-circle dash would eat a merged pad.
 *
 * Shape of the fix (not yet implemented -- flagged for a follow-up lane):
 * 1. Per course, per basket, collect small bright components near the
 *    basket tip within a generous radius (course-observed span, same
 *    provenance discipline as this file's fitted geometry -- never an
 *    absolute pixel literal).
 * 2. Fit a circle (least-squares) to those components' centroids; a good
 *    fit (low residual, count consistent with a dashed/solid ring) yields a
 *    MEASURED radius in pixels for that specific course and basket. Never
 *    assume a radius -- it is zoom-dependent and must come from the fit.
 * 3. Subtract only the pixels within one raster-tolerance band of that
 *    fitted circle from every component, mirroring the screen-chrome
 *    pattern above (component keeps its remnant).
 * 4. Bonus measurement (record only, do not gate anything on it): the
 *    C1S/C2D fitted pixel radii imply a per-course metersPerPixel figure
 *    from their known real-world radii (10m/20m) -- this is the
 *    course-derived ruler the owner wants to eventually replace absolute-
 *    pixel literals elsewhere (see the footgun inventory in the final
 *    report). Emit it once the circle fit lands; not emitted by this lane.
 */

/**
 * Owner policy 2026-08-28: discovery has NO spatial prefilter of any kind --
 * no predecessor-basket radius, no anchor, no course-derived distribution
 * box. "A recoverable tee touches basket N-1" was a baked-in worldview that
 * missed courses whose layout does not chain that way (see the forensic
 * history on targetPredecessors above). Every unowned, non-occluded bright
 * component on the whole canonical raster is a candidate for every missing
 * numbered badge; the strict acceptance predicate (every visible pixel
 * explained, support >= MIN_SHARD_SUPPORT_PIXELS, axis gate) is the only
 * filter, and it is unchanged. The predicate's own center-intersection bound
 * in fitComponent already rejects an oversized/impossible component almost
 * immediately, so this stays cheap despite visiting every component.
 */
export function buildTeeRecoveryCandidates(
	stage: RecoveryStage,
	badges: readonly BadgeEvidence[],
	baskets: readonly BasketEvidence[],
	tees: readonly TeeEvidence[],
	viewportTopPx = 0,
	search: TeeRecoverySearchContext = {}
): { readonly candidates: readonly TeeRecoveryCandidate[]; readonly searchOutcomes: readonly TargetSearchOutcome[]; readonly chromeSubtractionNotes: readonly ChromeSubtractionNote[]; readonly silentDrops: readonly SilentDuplicateDropNote[] } {
	const candidates: TeeRecoveryCandidate[] = [];
	const searchOutcomes: TargetSearchOutcome[] = [];
	const chromeSubtractionNotes: ChromeSubtractionNote[] = [];
	const silentDrops: SilentDuplicateDropNote[] = [];
	const pads = tees.map((tee) => tee.pad).filter((pad): pad is NonNullable<typeof pad> => pad !== undefined);
	if (pads.length === 0) return { candidates, searchOutcomes, chromeSubtractionNotes, silentDrops };
	// Owner law (2026-08-29): NO central tendency for pad size. A median
	// invents a "typical pad" no one measured; the observed BRACKET of this
	// course's own accepted pads is the contract (the cd77412 P100 pattern):
	// the window is centered on the bracket midpoint and is wide enough to
	// admit every pad G3 already accepted -- min and max alike, so no real
	// pad on this course can sit outside its own course's window.
	const bracket = (values: readonly number[]) => {
		let lo = Infinity, hi = -Infinity;
		for (const value of values) { if (value < lo) lo = value; if (value > hi) hi = value; }
		return { lo, hi, mid: (lo + hi) / 2, half: (hi - lo) / 2 };
	};
	const majorBracket = bracket(pads.map((pad) => pad.majorPx));
	const minorBracket = bracket(pads.map((pad) => pad.minorPx));
	const halfWidth = majorBracket.mid / 2;
	const knownPadWidthPx = minorBracket.mid;
	const halfHeight = knownPadWidthPx / 2;
	const halfHeightErrorPx = minorBracket.half / 2;
	const thickness = supportThickness(tees);
	const coveredBadgeIds = new Set(search.assignment?.assignments.map((row) => row.badgeId) ?? []);
	const targets = badges.filter((badge) => numberLabel(badge) !== undefined && !coveredBadgeIds.has(badge.detId));
	if (targets.length === 0) return { candidates, searchOutcomes, chromeSubtractionNotes, silentDrops };

	// Ownership and occlusion are properties of the raster, not of any one
	// target, so they are computed exactly once for every missing badge.
	const owned = exactKnownPixels(stage, badges, tees, baskets, search.sprites, viewportTopPx);
	// Known-occluder PIXEL subtraction (owner invariant, 2026-08-28): every
	// tee is either non-occluded (G3 must have found it) or occluded by a
	// known, named occluder (badge/basket/screen-chrome/[C1S-C2D deferred] --
	// see the design note above fitComponent) that G4 recovers from the
	// remaining pixels. Screen chrome (Apple Maps attribution, MAP/SAT pill)
	// is the one additional known occluder wired in here: its glyph
	// fragments are UI, never course geometry, but they are NOT whole
	// components to drop -- only the pixels actually inside the detected
	// chrome region are subtracted, so a component that is legitimately part
	// tee-pad and part accidental chrome overlap keeps its remnant alive.
	const chromeRegions = detectScreenChromeRegions(stage.brightComponents, stage.width, stage.height);
	// Build occluder footprints once for rail extraction. These repackage existing
	// data (owned, chrome regions, badges, baskets) without re-deriving occluder geometry.
	const occluders = buildOccluderFootprints(owned, stage, badges, baskets, search.sprites, chromeRegions, search, viewportTopPx);

	// Occluder-adjacency (owner completeness invariant, applied 2026-08-29):
	// every missing tee is either non-occluded (then G3 owns the miss -- a
	// defect to fix at G3, never recovery's to guess) or occluded by a KNOWN
	// occluder -- in which case its visible remnant necessarily TOUCHES that
	// occluder's footprint. A component nowhere near any known occluder
	// therefore cannot be a partially-occluded tee; before this rule, distant
	// scenery (a Lenard roof 774px from H3's truth, a Heritage shadow speck)
	// won C-solves because a 3-degree aim window sweeps tens of pixels at
	// long range. The adjacency allowance is 2px chebyshev -- the same
	// raster-geometry margin class as RASTER_TOLERANCE_PX, not a course
	// distance.
	const OCCLUDER_ADJACENCY_PX = 2;
	const occluderPixelSet = new Set<string>();
	for (const footprint of occluders) for (const key of footprint.pixels) occluderPixelSet.add(key);
	const touchesOccluder = (pixels: readonly (readonly [number, number])[]): boolean => {
		for (const [x, y] of pixels) {
			for (let dy = -OCCLUDER_ADJACENCY_PX; dy <= OCCLUDER_ADJACENCY_PX; dy++) {
				for (let dx = -OCCLUDER_ADJACENCY_PX; dx <= OCCLUDER_ADJACENCY_PX; dx++) {
					if (occluderPixelSet.has(`${x + dx},${y + dy}`)) return true;
					// The run-scoped occlusion service's exact OPAQUE cells are
					// known occluders too (sprite bodies etc.); the service is
					// query-only, so probe it here rather than enumerating it.
					if (search.occlusion?.kindAt(x + dx, y + dy + viewportTopPx) === 'OPAQUE') return true;
				}
			}
		}
		return false;
	};

	const visibleComponents = stage.brightComponents.flatMap((component) => {
		const afterOwnership = componentPixels(stage, component).filter(([x, y]) =>
			!owned.has(`${x},${y}`) &&
			search.occlusion?.kindAt(x, y + viewportTopPx) !== 'OPAQUE'
		);
		if (afterOwnership.length === 0) return [];
		const pixels = chromeRegions.length === 0
			? afterOwnership
			: afterOwnership.filter(([x, y]) => !pointInScreenChrome(x, y, chromeRegions));
		const subtracted = afterOwnership.length - pixels.length;
		if (subtracted > 0) {
			chromeSubtractionNotes.push({
				componentLabel: component.label,
				subtractedPixels: subtracted,
				remainingPixels: pixels.length,
				regionCount: chromeRegions.length
			});
		}
		return pixels.length
			? [{ component, pixels, occluderAdjacent: touchesOccluder(pixels) }]
			: [];
	});

	const globalSeenGroups = new Map<string, { badgeId: string; badgeLabel: string | null }>();
	for (const target of targets) {
		const targetCandidates: TeeRecoveryCandidate[] = [];
		const seenGroups = new Set<string>();
		for (const seed of visibleComponents) {
			let fit = fitComponent(seed.pixels, seed.component, target, viewportTopPx, halfWidth, halfHeight, halfHeightErrorPx, thickness, occluders);
			const compatibleWith = (candidateFit: RecoveryFit) => visibleComponents.filter((entry) =>
				entry.component.label === seed.component.label ||
				entry.pixels.every((point) => pointExplainsTee(point, candidateFit))
			);
			let compatible = compatibleWith(fit);
			// Refit only when the first pose actually attracted another component.
			// If compatible is just the seed, union is byte-for-byte the exact pixels
			// fit above, so solving the same exhaustive optimization again is a no-op.
			if (compatible.length > 1) {
				for (let pass = 0; pass < 2; pass++) {
					const union = compatible.flatMap((entry) => entry.pixels);
					if (union.length === 0) break;
					fit = fitComponent(union, seed.component, target, viewportTopPx, halfWidth, halfHeight, halfHeightErrorPx, thickness, occluders);
					const next = compatibleWith(fit);
					if (next.map((entry) => entry.component.label).join(',') === compatible.map((entry) => entry.component.label).join(',')) break;
					compatible = next;
				}
			}
			if (compatible.length === 0) continue;
			const groupKey = compatible.map((entry) => entry.component.label).sort((a, b) => a - b).join('+');
			if (!groupKey) continue;
			if (seenGroups.has(groupKey)) {
				// Silently dropped as a duplicate within this badge's search.
				// Record it so the receipt is never silent.
				const prior = globalSeenGroups.get(groupKey);
				if (prior) {
					silentDrops.push({
						badgeId: target.detId,
						badgeLabel: target.label ?? null,
						groupKey,
						duplicateOfGroupKey: prior.badgeId
					});
				}
				continue;
			}
			seenGroups.add(groupKey);
			if (!globalSeenGroups.has(groupKey)) {
				globalSeenGroups.set(groupKey, { badgeId: target.detId, badgeLabel: target.label ?? null });
			}
			const pixels = compatible.flatMap((entry) => entry.pixels);
			const visibleShards = compatible.flatMap((entry) => connectedPixelShards(entry.pixels));
			// Dim-rail escape measurement (see TeeRecoveryCandidate.dimRailEscape):
			// extents of the group along/across the FITTED axis, judged against
			// this course's own pad bracket and wall thickness.
			const dimRailEscape = (() => {
				const c = Math.cos(fit.angleRad), s = Math.sin(fit.angleRad);
				let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
				for (const [px, py] of pixels) {
					const u = px * c + py * s;
					const v = -px * s + py * c;
					if (u < uMin) uMin = u; if (u > uMax) uMax = u;
					if (v < vMin) vMin = v; if (v > vMax) vMax = v;
				}
				const alongSpanPx = pixels.length ? uMax - uMin + 1 : 0;
				const acrossSpanPx = pixels.length ? vMax - vMin + 1 : 0;
				const alongFloorPx = minorBracket.lo;
				const acrossCapPx = 2 * (Math.max(0, thickness) + RASTER_TOLERANCE_PX);
				// Two escape shapes (2026-08-29, third pass -- the second pass
				// judged rails per-shard for EVERY count, which readmitted an
				// elongated Lenard roof blob):
				//  (a) ONE thin shard whose GROUP extents are a rail -- the
				//      original threshold-dimmed-pad survivor (Heritage T10);
				//  (b) TWO to FOUR shards that are EACH a strict rail on their
				//      own axis (span >= shortest pad side, across within ONE
				//      wall + raster tolerance) -- the broken-ring pair the
				//      C-solve exists for (AlexClark badge-10's 36+38px arms).
				// Speck chains fail (b)'s per-shard span; single blobs fail
				// (a)'s group across cap.
				const oneWallCapPx = Math.max(0, thickness) + 2 * RASTER_TOLERANCE_PX;
				const shardStats = visibleShards.map((shard) => exactVisibleStats(0, shard));
				const everyShardIsStrictRail =
					visibleShards.length >= 2 &&
					visibleShards.length <= 4 &&
					shardStats.every((stats) => {
						if (!stats) return false;
						const along = (stats.axisMajorMax ?? 0) - (stats.axisMajorMin ?? 0) + 1;
						const across = (stats.axisMinorMax ?? 0) - (stats.axisMinorMin ?? 0) + 1;
						return along >= alongFloorPx && across <= oneWallCapPx;
					});
				const singleShard = visibleShards.length === 1;
				const singleThinRail =
					singleShard && alongSpanPx >= alongFloorPx && acrossSpanPx <= acrossCapPx;
				return {
					qualifies: singleThinRail || (everyShardIsStrictRail && alongSpanPx >= alongFloorPx),
					singleShard,
					alongSpanPx,
					alongFloorPx,
					acrossSpanPx,
					acrossCapPx
				};
			})();
			const localizationStats = compatible.length === 1 && visibleShards.length === 1
				? exactVisibleStats(compatible[0]!.component.label, compatible[0]!.pixels)
				: undefined;
			const localizationFit = localizationStats
				? fullSpanComponentLocalization(localizationStats, halfWidth, halfHeight, thickness)
				: undefined;
			const teeToBadgeAngleRad = Math.atan2(
				target.cyPx - (fit.centerYPx + viewportTopPx),
				target.cxPx - fit.centerXPx
			);
			targetCandidates.push({
				id: `tee-shard-${target.detId}-${groupKey}`,
				fit,
				...(localizationFit ? { localizationFit } : {}),
				localizationSource: localizationFit ? 'full-span-component-pca' : 'support-fit',
				fragmentPixels: pixels,
				supportingComponentIds: visibleShards.map((_, index) => `${groupKey}:${index + 1}`),
				viewportTopPx,
				seedSource: 'global-bright-mask',
				bfsComponentsVisited: stage.brightComponents.length,
				consideredComponentsGlobal: visibleComponents.length,
				badgeAxisAngleRad: fit.angleRad,
				teeToBadgeAngleRad,
				badgeId: target.detId,
				badgeLabel: target.label,
				occluderAdjacent: compatible.some((entry) => entry.occluderAdjacent),
				dimRailEscape
			});
		}
		// Evaluate the predicate before choosing. A large basket/badge component
		// must never hide a smaller component whose every visible pixel fits.
		targetCandidates.sort((a, b) => {
			const ar = unexplainedPixels(a).length, br = unexplainedPixels(b).length;
			const aa = badgeAxisError(a) ?? Infinity, ba = badgeAxisError(b) ?? Infinity;
			const aRailMiss = (a.fit.fitKind === 'rail-projection' || a.fit.fitKind === 'rail-extracted') ? a.fit.badgePerpendicularMissPx ?? Infinity : undefined;
			const bRailMiss = (b.fit.fitKind === 'rail-projection' || b.fit.fitKind === 'rail-extracted') ? b.fit.badgePerpendicularMissPx ?? Infinity : undefined;
			const aAdjacent = a.occluderAdjacent !== false || a.dimRailEscape?.qualifies === true;
			const bAdjacent = b.occluderAdjacent !== false || b.dimRailEscape?.qualifies === true;
			const aAccepted = aAdjacent && a.fragmentPixels.length >= MIN_SHARD_SUPPORT_PIXELS && ar === 0 && (aRailMiss !== undefined ? aRailMiss === 0 : aa < activeAxisLimitRad);
			const bAccepted = bAdjacent && b.fragmentPixels.length >= MIN_SHARD_SUPPORT_PIXELS && br === 0 && (bRailMiss !== undefined ? bRailMiss === 0 : ba < activeAxisLimitRad);
			if (aAccepted !== bAccepted) return aAccepted ? -1 : 1;
			if (aAccepted) {
				const aResidual = (a.fit.fitKind === 'rail-projection' || a.fit.fitKind === 'rail-extracted') ? a.fit.badgePerpendicularErrorPx ?? Infinity : aa;
				const bResidual = (b.fit.fitKind === 'rail-projection' || b.fit.fitKind === 'rail-extracted') ? b.fit.badgePerpendicularErrorPx ?? Infinity : ba;
				return b.fragmentPixels.length - a.fragmentPixels.length || aResidual - bResidual || a.supportingComponentIds[0]!.localeCompare(b.supportingComponentIds[0]!);
			}
			const aFraction = ar / a.fragmentPixels.length;
			const bFraction = br / b.fragmentPixels.length;
			return aFraction - bFraction || ar - br || b.fragmentPixels.length - a.fragmentPixels.length || a.supportingComponentIds[0]!.localeCompare(b.supportingComponentIds[0]!);
		});
		const [winner, ...runnerUps] = targetCandidates;
		if (winner) candidates.push(winner);
		searchOutcomes.push({
			badgeId: target.detId,
			badgeLabel: target.label ?? null,
			consideredComponents: visibleComponents.length,
			winner,
			runnerUps
		});
	}

	// Cross-target multiclaim: the same physical shard may satisfy more than one
	// numbered badge. G4 has no authority to turn a smaller residual into object
	// identity. Preserve every claimant and DEFER them all; later evidence may
	// resolve the relation without erasing what the shard actually testified.
	const accepted = candidates.filter((candidate) => {
		const support = candidate.fragmentPixels.length;
		const railMiss = (candidate.fit.fitKind === 'rail-projection' || candidate.fit.fitKind === 'rail-extracted') ? candidate.fit.badgePerpendicularMissPx ?? Infinity : undefined;
		return (candidate.occluderAdjacent !== false || candidate.dimRailEscape?.qualifies === true) &&
			support >= MIN_SHARD_SUPPORT_PIXELS &&
			unexplainedPixels(candidate).length === 0 &&
			(railMiss !== undefined ? railMiss === 0 : (badgeAxisError(candidate) ?? Infinity) < activeAxisLimitRad);
	});
	const byComponentSet = new Map<string, TeeRecoveryCandidate[]>();
	for (const candidate of accepted) {
		const key = candidate.supportingComponentIds.map((id) => id.split(':')[0]).sort().join('+');
		const bucket = byComponentSet.get(key);
		if (bucket) bucket.push(candidate); else byComponentSet.set(key, [candidate]);
	}
	for (const bucket of byComponentSet.values()) {
		if (bucket.length < 2) continue;
		for (const candidate of bucket) {
			const others = bucket
				.filter((other) => other !== candidate)
				.map((other) => other.badgeLabel ?? other.badgeId ?? 'UNKNOWN')
				.sort();
			const index = candidates.indexOf(candidate);
			if (index >= 0) candidates[index] = { ...candidate, ambiguityWithBadgeLabels: others };
		}
	}

	return { candidates, searchOutcomes, chromeSubtractionNotes, silentDrops };
}

export const teeRecoveryUnit: EngineUnit = {
	id: 'teeRecovery',
	gate: 'G4',
	consumes: ['stage', 'badges', 'baskets', 'tees', 'sprites', 'viewport', 'recoveredTees'],
	produces: ['recoveredTees'],
	note: 'visible tee-shard recovery by all-visible-pixels badge-pointing tee-support feasibility with exact opaque ownership',
	run(board: EvidenceBoard, ctx: FeatureContext) {
		const stop = ctx.span('teeRecovery');
		const state = ctx.resolve(teeRecoveryFeature);
		// Legacy/unit-test resolvers may supply an incomplete knobs object
		// (e.g. `knobs: {}`); only install a configured value when it is an
		// actual finite number, so a caller that never threads this knob keeps
		// the module's own default rather than corrupting shared module state
		// with NaN for every run in the process.
		const configuredAxisToleranceDeg = state.knobs.axisToleranceDeg;
		if (typeof configuredAxisToleranceDeg === 'number' && Number.isFinite(configuredAxisToleranceDeg)) {
			setActiveAxisToleranceDeg(configuredAxisToleranceDeg);
		}
		if (!state.enabled) { stop(); return; }
		const stage = board.get<RecoveryStage>('stage');
		const viewportTopPx = board.get<RecoveryViewport>('viewport').topPx;
		const badges = board.get<readonly BadgeEvidence[]>('badges');
		const baskets = board.get<readonly BasketEvidence[]>('baskets');
		const tees = board.get<readonly TeeEvidence[]>('tees');
		const rayResolution = resolveVisibleTeeBadgeRays(tees, badges);
		const coveredBadgeIds = new Set(rayResolution.coveredBadgeIds);
		const lockedKeys = new Set(rayResolution.locks.map((claim) => `${claim.teeId}|${claim.badgeId}`));
		const numberedBadges = badges.filter((badge) => numberLabel(badge) !== undefined);
		ctx.measure('teeRecovery', 'visibleRayClaims', rayResolution.claims.length);
		ctx.measure('teeRecovery', 'visibleRayLocks', rayResolution.locks.length);
		ctx.measure('teeRecovery', 'visibleRayCoveredBadges', coveredBadgeIds.size);
		ctx.measure('teeRecovery', 'visibleRayAmbiguousTees', rayResolution.ambiguousTeeIds.length);
		ctx.measure('teeRecovery', 'visibleRayConflictedBadges', rayResolution.conflictedBadgeIds.length);
		ctx.measure('teeRecovery', 'missingNumberedTees', numberedBadges.length - coveredBadgeIds.size);
		for (const claim of rayResolution.claims) {
			const tee = tees.find((candidate) => candidate.detId === claim.teeId);
			const badge = badges.find((candidate) => candidate.detId === claim.badgeId);
			if (!tee || !badge) continue;
			const locked = lockedKeys.has(`${claim.teeId}|${claim.badgeId}`);
			ctx.overlay('teeRecovery', {
				type: 'polyline',
				path: [[tee.xPx, tee.yPx], [badge.cxPx, badge.cyPx]],
				verdict: 'info',
				visualRole: 'tee-badge-path',
				ref: `visible-ray-${tee.detId}-${badge.detId}`,
				reason: locked
					? `LOCK: visible ${tee.detId} has one first-intercept badge and badge ${badge.label ?? badge.detId} has one visible-tee claimant; perpendicular corridor error ${claim.perpendicularErrorPx.toFixed(3)}px; no pathfinding or assignment testimony read`
					: `POSSIBLE: visible ${tee.detId} supplies first-intercept testimony for badge ${badge.label ?? badge.detId} (perpendicular corridor error ${claim.perpendicularErrorPx.toFixed(3)}px); multiclaim/conflict is preserved as coverage, not erased into a false recovery target`
			});
		}
		if (coveredBadgeIds.size === numberedBadges.length) {
			board.set('recoveredTees', board.get<readonly RecoveredTeeInput[]>('recoveredTees'));
			stop();
			return;
		}
		const localRayClaims: TeeRecoveryAssignmentContext = {
			assignments: [...coveredBadgeIds].sort().map((badgeId) => ({ badgeId, basketId: 'G4-visible-ray-coverage' }))
		};
		const shardDiscoveryStop = ctx.span('teeRecovery.shardDiscovery');
		const sprites = board.has('sprites') ? board.get<readonly SpriteMatch[]>('sprites') : undefined;
		ctx.occlusion.registerOpaque(basketOpaqueProvider(stage, baskets, sprites, viewportTopPx));
		const built = buildTeeRecoveryCandidates(stage, badges, baskets, tees, viewportTopPx, { assignment: localRayClaims, sprites, occlusion: ctx.occlusion });
		shardDiscoveryStop();
		// Known-occluder pixel subtraction (screen chrome) is never a silent cut:
		// name the component, the exact pixel count removed, and what remains.
		for (const note of built.chromeSubtractionNotes) {
			const component = stage.brightComponents.find((entry) => entry.label === note.componentLabel);
			ctx.overlay('teeRecovery', {
				type: 'point',
				xPx: component?.cx ?? 0,
				yPx: component?.cy ?? 0,
				verdict: 'info',
				ref: `tee-recovery-chrome-subtraction-${note.componentLabel}`,
				reason: `component ${note.componentLabel}: ${note.subtractedPixels} pixel${note.subtractedPixels === 1 ? '' : 's'} subtracted as screen chrome (${note.regionCount} detected chrome region${note.regionCount === 1 ? '' : 's'}); ${note.remainingPixels} pixel${note.remainingPixels === 1 ? '' : 's'} remain${note.remainingPixels === 1 ? 's' : ''} as live candidate evidence`
			});
		}
		ctx.measure('teeRecovery', 'chromeSubtractedComponents', built.chromeSubtractionNotes.length);
		// Component group duplicates: the same groupKey was silently dropped because
		// it had already been claimed by an earlier badge's search. Each drop gets
		// a receipt line so nothing is silent.
		for (const drop of built.silentDrops) {
			const badge = badges.find((entry) => entry.detId === drop.badgeId);
			ctx.overlay('teeRecovery', {
				type: 'point',
				xPx: badge?.cxPx ?? 0,
				yPx: (badge?.cyPx ?? 0) - viewportTopPx,
				verdict: 'info',
				ref: `tee-recovery-silent-drop-${drop.badgeId}-${drop.groupKey}`,
				reason: `badge ${drop.badgeLabel ?? drop.badgeId}: component group (${drop.groupKey}) was silently dropped as a duplicate; it was previously claimed for badge ${drop.duplicateOfGroupKey}`
			});
		}
		ctx.measure('teeRecovery', 'silentlyDroppedGroupsWithDuplicates', built.silentDrops.length);
		// No spatial prefilter means "candidates=0 for a missing badge" now only
		// happens when the whole canonical raster has zero unowned, non-occluded
		// bright components left to consider -- print that fact explicitly so
		// the target never just vanishes from the trace.
		const RUNNER_UP_RECEIPT_CAP = 10;
		for (const outcome of built.searchOutcomes) {
			if (outcome.winner) continue;
			const holePrefix = outcome.badgeLabel ? `badge ${outcome.badgeLabel}: ` : '';
			const badge = badges.find((entry) => entry.detId === outcome.badgeId);
			ctx.overlay('teeRecovery', {
				type: 'point',
				xPx: badge?.cxPx ?? 0,
				yPx: (badge?.cyPx ?? 0) - viewportTopPx,
				verdict: 'rejected',
				visualRole: 'tee-rejection',
				ref: `tee-recovery-no-candidate-${outcome.badgeId}`,
				reason: `${holePrefix}considered all ${outcome.consideredComponents} unowned, non-occluded bright component${outcome.consideredComponents === 1 ? '' : 's'} on the whole canonical raster (global bright mask; no spatial prefilter); none survived even a degenerate single-component fit`
			});
		}
		for (const outcome of built.searchOutcomes) {
			if (outcome.runnerUps.length === 0) continue;
			const byNames = [...outcome.runnerUps].sort((a, b) => b.fragmentPixels.length - a.fragmentPixels.length);
			for (const runnerUp of byNames.slice(0, RUNNER_UP_RECEIPT_CAP)) {
				const runnerUpResult = graphCandidateResult(runnerUp);
				ctx.overlay('teeRecovery', {
					type: 'point',
					xPx: runnerUp.fit.centerXPx,
					yPx: runnerUp.fit.centerYPx + (runnerUp.coordinateFrame === 'original' ? 0 : runnerUp.viewportTopPx ?? 0),
					verdict: 'rejected',
					visualRole: 'tee-rejection',
					ref: `${runnerUpResult.id}:considered`,
					reason: `also considered (not chosen): ${runnerUpResult.reason}`
				});
			}
			if (byNames.length > RUNNER_UP_RECEIPT_CAP) {
				ctx.measure('teeRecovery', 'runnerUpsBeyondReceiptCap', byNames.length - RUNNER_UP_RECEIPT_CAP);
			}
		}
		// Permanent ranked candidate table per badge: unconditional, no env vars.
		// Shows all candidates considered for each badge in ranked order (winner first if exists).
		for (const outcome of built.searchOutcomes) {
			const allCandidatesForBadge = outcome.winner ? [outcome.winner, ...outcome.runnerUps] : outcome.runnerUps;
			if (allCandidatesForBadge.length === 0) continue;
			const badge = badges.find((entry) => entry.detId === outcome.badgeId);
			const rows: string[] = [];
			for (let i = 0; i < allCandidatesForBadge.length; i++) {
				const cnd = allCandidatesForBadge[i]!;
				const unexplained = unexplainedPixels(cnd).length;
				const axisErr = badgeAxisError(cnd);
				const miss = (cnd.fit.fitKind === 'rail-projection' || cnd.fit.fitKind === 'rail-extracted')
					? cnd.fit.badgePerpendicularMissPx ?? Infinity
					: axisErr ?? Infinity;
				const rank = i === 0 && outcome.winner ? '★' : `${i + 1}`;
				rows.push(`${rank}. id=${cnd.id} px=${cnd.fragmentPixels.length} unexpl=${unexplained} kind=${cnd.fit.fitKind ?? 'support-search'} c=(${cnd.fit.centerXPx.toFixed(1)},${cnd.fit.centerYPx.toFixed(1)}) miss=${typeof miss === 'number' ? miss.toFixed(3) : miss}`);
			}
			ctx.overlay('teeRecovery', {
				type: 'point',
				xPx: badge?.cxPx ?? 0,
				yPx: (badge?.cyPx ?? 0) - viewportTopPx,
				verdict: 'info',
				ref: `tee-recovery-ranked-candidates-${outcome.badgeId}`,
				reason: `Badge ${outcome.badgeLabel ?? outcome.badgeId}: ranked candidate table (${allCandidatesForBadge.length} total considered):\n${rows.join('\n')}`
			});
		}
		if (!tees.some((tee) => tee.pad)) {
			ctx.measure('teeRecovery', 'noCourseLocalPadGeometry', 1);
			stop();
			return;
		}
		const geometryFittingStop = ctx.span('teeRecovery.geometryFitting');
		const allResults = built.candidates.map(graphCandidateResult);
		geometryFittingStop();
		ctx.measure('teeRecovery', 'seedFragments', new Set(built.candidates.map((candidate) => candidate.id.match(/^tee-shard-[^-]+/)?.[0] ?? candidate.id)).size);
		ctx.measure('teeRecovery', 'componentHypotheses', allResults.length);
		for (const candidate of built.candidates) ctx.measure('teeRecovery', 'bfsComponentsVisited', candidate.bfsComponentsVisited ?? 0);
		// Keep one deterministic component verdict per missing numbered badge so
		// trace, CLI, and visual receipt remain one-to-one.
		const badgeSupportStop = ctx.span('teeRecovery.badgeSupport');
		const promoted = promoteGraphResults(built.candidates, allResults);
		badgeSupportStop();
		const results = promoted.map((entry) => entry.result);
		const existing = board.get<readonly RecoveredTeeInput[]>('recoveredTees');
		const additions: RecoveredTeeInput[] = [];
		// No G6 search knob may decide whether G4 observed a tee. Cross-target
		// source-component ambiguity is settled above; only exact repeated
		// recovery centers are deduplicated here.
		for (const { candidate, result } of promoted) {
			const centerX = result.corners.reduce((sum, point) => sum + point[0], 0) / 4;
			const centerY = result.corners.reduce((sum, point) => sum + point[1], 0) / 4;
			const duplicate = existing.some((tee) => tee.xPx === centerX && tee.yPx === centerY) ||
				additions.some((tee) => tee.xPx === centerX && tee.yPx === centerY);
			if (duplicate && result.verdict === 'accepted') {
				ctx.measure('teeRecovery', 'duplicateSuppressed', 1);
				ctx.overlay('teeRecovery', { type: 'point', xPx: centerX, yPx: centerY, verdict: 'rejected', visualRole: 'tee-rejection', ref: `${result.id}:duplicate`, reason: 'exact recovered center already exists; duplicate suppressed without a proximity/search heuristic', values: numericTraceValues(result.values) });
				continue;
			}
			const shardPixels = candidate.fragmentPixels.map((point) => localPoint(candidate, point, {}));
			if (candidate.fit.fitKind === 'rail-projection' && candidate.badgeId) {
				const badge = badges.find((entry) => entry.detId === candidate.badgeId);
				if (badge) {
					const fitY = candidate.fit.centerYPx + (candidate.coordinateFrame === 'original' ? 0 : candidate.viewportTopPx ?? 0);
					const c = Math.cos(candidate.fit.angleRad), ss = Math.sin(candidate.fit.angleRad);
					const nx = -ss, ny = c;
					const dx = badge.cxPx - candidate.fit.centerXPx, dy = badge.cyPx - fitY;
					const along = dx * c + dy * ss;
					const foot: readonly [number, number] = [candidate.fit.centerXPx + along * c, fitY + along * ss];
					for (const side of [-1, 1] as const) {
						const ox = side * candidate.fit.halfHeightPx * nx, oy = side * candidate.fit.halfHeightPx * ny;
						ctx.overlay('teeRecovery', { type: 'polyline', path: [[candidate.fit.centerXPx + ox, fitY + oy], [foot[0] + ox, foot[1] + oy]], verdict: 'info', visualRole: 'tee-badge-path', ref: `${result.id}:projected-rail-${side}`, reason: `projected known tee-width boundary; perpendicular badge miss ${(candidate.fit.badgePerpendicularMissPx ?? Infinity).toFixed(3)}px` });
					}
					ctx.overlay('teeRecovery', { type: 'polyline', path: [foot, [badge.cxPx, badge.cyPx]], verdict: (candidate.fit.badgePerpendicularMissPx ?? Infinity) > 0 ? 'rejected' : 'info', visualRole: 'tee-badge-path', ref: `${result.id}:perpendicular-residual`, reason: `rail projection centerline error ${(candidate.fit.badgePerpendicularErrorPx ?? Infinity).toFixed(3)}px vs built-in known-width error bound ${(candidate.fit.badgePerpendicularBoundPx ?? Infinity).toFixed(3)}px; excess miss ${(candidate.fit.badgePerpendicularMissPx ?? Infinity).toFixed(3)}px` });
				}
			}
			if (result.verdict === 'accepted') ctx.overlay('teeRecovery', { type: 'pixelSet', pixels: shardPixels, verdict: 'accepted', visualRole: 'tee-shard', ref: `${result.id}:tee-shard`, reason: result.reason, values: numericTraceValues(result.values) });
			else ctx.overlay('teeRecovery', { type: 'point', xPx: centerX, yPx: centerY, verdict: 'rejected', visualRole: 'tee-rejection', ref: result.id, reason: result.reason, values: numericTraceValues(result.values) });
			if (result.verdict !== 'accepted') continue;
			if (result.values.badgeAxisErrorRad !== undefined) ctx.measure('teeRecovery', 'axisErrorDeg', result.values.badgeAxisErrorRad * 180 / Math.PI);
			if (result.values.badgePerpendicularErrorPx !== undefined) ctx.measure('teeRecovery', 'badgePerpendicularErrorPx', result.values.badgePerpendicularErrorPx);
			if (result.values.badgePerpendicularBoundPx !== undefined) ctx.measure('teeRecovery', 'badgePerpendicularBoundPx', result.values.badgePerpendicularBoundPx);
			if (result.values.badgePerpendicularMissPx !== undefined) ctx.measure('teeRecovery', 'badgePerpendicularMissPx', result.values.badgePerpendicularMissPx);
			for (const [index, corner] of result.corners.entries()) ctx.overlay('teeRecovery', { type: 'point', xPx: corner[0], yPx: corner[1], verdict: 'info', visualRole: 'tee-corner-tick', ref: `${result.id}:tee-corner-tick-${index}`, reason: 'calculated tee recovery corner' });
			const xs = result.corners.map((point) => point[0]);
			const ys = result.corners.map((point) => point[1]);
			additions.push({ xPx: centerX, yPx: centerY, bbox: [Math.floor(Math.min(...xs)), Math.floor(Math.min(...ys)), Math.ceil(Math.max(...xs) - Math.min(...xs)), Math.ceil(Math.max(...ys) - Math.min(...ys))], provenance: { source: 'tee-shard-recovery', note: `teeRecovery support fit ${result.id}: every non-occluded visible component pixel contributes; discovery seed ${candidate.seedSource ?? 'UNKNOWN'}` } });
		}
		board.set('recoveredTees', [...existing, ...additions]);
		ctx.measure('teeRecovery', 'candidates', allResults.length);
		ctx.measure('teeRecovery', 'accepted', additions.length);
		ctx.measure('teeRecovery', 'promoted', results.length);
		stop();
	}
};
