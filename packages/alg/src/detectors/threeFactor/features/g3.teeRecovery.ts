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
	readonly fitKind?: 'support-search' | 'rail-projection' | 'rail-pair-projection';
	readonly badgePerpendicularErrorPx?: number;
	readonly badgePerpendicularMissPx?: number;
	/** Error budget implied by observed rail uncertainty + the observed spread
	 * of already-known course-local pad widths + raster quantization. */
	readonly badgePerpendicularBoundPx?: number;
	readonly railAngleBoundRad?: number;
	readonly railSeparationErrorPx?: number;
	readonly railSeparationBoundPx?: number;
	readonly projectedLaneWidthPx?: number;
	readonly observedRailSpanPx?: number;
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
	readonly railAngleBoundRad?: number;
	readonly railSeparationErrorPx?: number;
	readonly railSeparationBoundPx?: number;
	readonly projectedLaneWidthPx?: number;
	readonly observedRailSpanPx?: number;
	readonly railProjection?: number;
	readonly railPairProjection?: number;
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
	note: 'G4 endpoint completion: visible tees claim numbered badges by their own pad axis; only uniquely visible-locked badges skip shard search; POSSIBLE badges remain searchable but can promote only by consensus, and a shard becomes a recovered tee only when every visible pixel fits a course-local hollow tee support pointing at that badge. No path, basket assignment, or G6 decision is consulted.',
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

function isRailProjectionFit(fit: RecoveryFit): boolean {
	return fit.fitKind === 'rail-projection' || fit.fitKind === 'rail-pair-projection';
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

function cornersFor(candidate: TeeRecoveryCandidate, options: RecoveryGeometryOptions): OrientedQuad {
	const ring = candidate.localizationFit ?? candidate.fit;
	const offset = candidate.coordinateFrame === 'original' ? 0 : candidate.viewportTopPx ?? options.viewportTopPx ?? 0;
	const raw = [
		rotate(ring, -ring.halfWidthPx, -ring.halfHeightPx),
		rotate(ring, ring.halfWidthPx, -ring.halfHeightPx),
		rotate(ring, ring.halfWidthPx, ring.halfHeightPx),
		rotate(ring, -ring.halfWidthPx, ring.halfHeightPx)
	] as const;
	return raw.map(([x, y]) => [x, y + offset] as const) as unknown as OrientedQuad;
}

function badgeAxisError(candidate: TeeRecoveryCandidate): number | undefined {
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

function unexplainedPixels(candidate: TeeRecoveryCandidate): readonly (readonly [number, number])[] {
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

/** A measured border rail, independent of every badge. */
interface RailObservation {
	readonly label: number;
	readonly cx: number;
	readonly cy: number;
	readonly angleRad: number;
	readonly c: number;
	readonly s: number;
	readonly nx: number;
	readonly ny: number;
	readonly spanPx: number;
	readonly thicknessPx: number;
	/** Conservative orientation uncertainty induced by finite rail span and
	 * raster/rail-band uncertainty. This is geometry, not a tuned sigma. */
	readonly angleBoundRad: number;
	readonly centerNormalBoundPx: number;
	readonly pixels: readonly (readonly [number, number])[];
}

function observeRail(
	pixels: readonly (readonly [number, number])[],
	component: ComponentStats,
	halfWidth: number,
	thickness: number
): RailObservation | undefined {
	if (pixels.length < 2) return undefined;
	const exact = exactVisibleStats(component.label, pixels) ?? component;
	const angle = exact.angle;
	if (!Number.isFinite(angle)) return undefined;
	const c = Math.cos(angle), s = Math.sin(angle);
	const nx = -s, ny = c;
	let minAlong = Infinity, maxAlong = -Infinity;
	let minNormal = Infinity, maxNormal = -Infinity;
	for (const [x, y] of pixels) {
		const dx = x - exact.cx, dy = y - exact.cy;
		const along = dx * c + dy * s;
		const normal = dx * nx + dy * ny;
		minAlong = Math.min(minAlong, along);
		maxAlong = Math.max(maxAlong, along);
		minNormal = Math.min(minNormal, normal);
		maxNormal = Math.max(maxNormal, normal);
	}
	const spanPx = maxAlong - minAlong;
	const thicknessPx = maxNormal - minNormal;
	const allowedRailThickness = Math.max(0, thickness) + 2 * RASTER_TOLERANCE_PX;
	if (thicknessPx > allowedRailThickness || spanPx > 2 * halfWidth + 2 * RASTER_TOLERANCE_PX) return undefined;
	const centerNormalBoundPx = Math.max(RASTER_TOLERANCE_PX, thicknessPx / 2);
	const halfSpan = Math.max(RASTER_TOLERANCE_PX, spanPx / 2);
	const angleBoundRad = Math.atan2(RASTER_TOLERANCE_PX + centerNormalBoundPx, halfSpan);
	return {
		label: component.label,
		cx: exact.cx,
		cy: exact.cy,
		angleRad: angle,
		c, s, nx, ny,
		spanPx, thicknessPx,
		angleBoundRad,
		centerNormalBoundPx,
		pixels
	};
}

/**
 * One rail fixes orientation. The known course-local pad width fixes the two
 * possible centerlines. The badge chooses only between those TWO discrete
 * projections and contributes a perpendicular residual; it can never rotate
 * or continuously translate the tee.
 */
function projectRailFit(
	pixels: readonly [number, number][],
	component: ComponentStats,
	target: BadgeEvidence,
	viewportTopPx: number,
	halfWidth: number,
	halfHeight: number,
	halfHeightErrorPx: number,
	thickness: number
): RecoveryFit | undefined {
	const rail = observeRail(pixels, component, halfWidth, thickness);
	if (!rail) return undefined;
	let minAlong = Infinity, maxAlong = -Infinity;
	for (const [x, y] of pixels) {
		const along = (x - rail.cx) * rail.c + (y - rail.cy) * rail.s;
		minAlong = Math.min(minAlong, along);
		maxAlong = Math.max(maxAlong, along);
	}
	const lowCenterAlong = maxAlong - halfWidth;
	const highCenterAlong = minAlong + halfWidth;
	if (lowCenterAlong > highCenterAlong + RASTER_TOLERANCE_PX) return undefined;
	const centerAlong = Math.max(lowCenterAlong, Math.min(highCenterAlong, 0));

	const badgeX = target.cxPx;
	const badgeY = target.cyPx - viewportTopPx;
	const badgeNormalFromRail = (badgeX - rail.cx) * rail.nx + (badgeY - rail.cy) * rail.ny;
	// Bright rail PCA is centered in the border band, so its center is t/2
	// inside the pad's outer edge. The known OUTER pad width therefore projects
	// the tee center by halfWidthMinor - t/2.
	const projectedCenterOffsetPx = Math.max(0, halfHeight - Math.max(0, thickness) / 2);
	const plusError = Math.abs(badgeNormalFromRail - projectedCenterOffsetPx);
	const minusError = Math.abs(badgeNormalFromRail + projectedCenterOffsetPx);
	const side = plusError <= minusError ? 1 : -1;
	const perpendicularError = Math.min(plusError, minusError);
	const centerX = rail.cx + centerAlong * rail.c + side * projectedCenterOffsetPx * rail.nx;
	const centerY = rail.cy + centerAlong * rail.s + side * projectedCenterOffsetPx * rail.ny;
	const alongToBadge = Math.abs((badgeX - centerX) * rail.c + (badgeY - centerY) * rail.s);
	const orientationBoundPx = alongToBadge * Math.sin(rail.angleBoundRad);
	// Built-in bound, all measured: P100 course-local pad-width spread + where
	// the rail center can lie inside its raster band + angular uncertainty from
	// finite observed rail span + one final raster-cell allowance.
	const perpendicularBoundPx = RASTER_TOLERANCE_PX + halfHeightErrorPx + rail.centerNormalBoundPx + orientationBoundPx;
	const perpendicularMiss = Math.max(0, perpendicularError - perpendicularBoundPx);
	return {
		centerXPx: centerX,
		centerYPx: centerY,
		halfWidthPx: halfWidth,
		halfHeightPx: halfHeight,
		angleRad: rail.angleRad,
		supportThicknessPx: thickness,
		fitKind: 'rail-projection',
		badgePerpendicularErrorPx: perpendicularError,
		badgePerpendicularMissPx: perpendicularMiss,
		badgePerpendicularBoundPx: perpendicularBoundPx,
		railAngleBoundRad: rail.angleBoundRad,
		projectedLaneWidthPx: halfHeight * 2,
		observedRailSpanPx: rail.spanPx
	};
}

interface RailComponentEntry {
	readonly component: ComponentStats;
	readonly pixels: readonly [number, number][];
}

/**
 * Two parallel border rails are stronger than one: if their measured
 * separation matches the KNOWN pad width (minus the measured border band),
 * they directly bracket the centerline. The badge contributes only its
 * perpendicular residual to that bracketed line.
 */
function projectRailPairFit(
	entries: readonly RailComponentEntry[],
	target: BadgeEvidence,
	viewportTopPx: number,
	halfWidth: number,
	halfHeight: number,
	halfHeightErrorPx: number,
	thickness: number
): { readonly fit: RecoveryFit; readonly labels: readonly number[] } | undefined {
	const observed = entries.flatMap((entry) => {
		const rail = observeRail(entry.pixels, entry.component, halfWidth, thickness);
		return rail ? [{ entry, rail }] : [];
	});
	let best: { fit: RecoveryFit; labels: readonly number[]; separationMiss: number } | undefined;
	for (let i = 0; i < observed.length; i++) for (let j = i + 1; j < observed.length; j++) {
		let a = observed[i]!, b = observed[j]!;
		if (b.rail.spanPx > a.rail.spanPx) [a, b] = [b, a];
		const axisError = undirectedAxisError(a.rail.angleRad, b.rail.angleRad);
		const parallelBound = a.rail.angleBoundRad + b.rail.angleBoundRad;
		if (axisError > parallelBound) continue;
		const dx = b.rail.cx - a.rail.cx;
		const dy = b.rail.cy - a.rail.cy;
		const signedSeparation = dx * a.rail.nx + dy * a.rail.ny;
		const separationPx = Math.abs(signedSeparation);
		const expectedRailCenterSeparationPx = Math.max(0, 2 * halfHeight - Math.max(0, thickness));
		const separationErrorPx = Math.abs(separationPx - expectedRailCenterSeparationPx);
		const alongBetween = Math.abs(dx * a.rail.c + dy * a.rail.s);
		const angularSeparationBoundPx = alongBetween * Math.sin(parallelBound);
		const separationBoundPx = 2 * halfHeightErrorPx + a.rail.centerNormalBoundPx + b.rail.centerNormalBoundPx + RASTER_TOLERANCE_PX + angularSeparationBoundPx;
		if (separationErrorPx > separationBoundPx) continue;

		// Midpoint between the two measured rail centers fixes the centerline in
		// the normal direction. Along-axis center remains bounded by known pad
		// length; choose the primary rail's own center whenever legal.
		const centerBaseX = a.rail.cx + 0.5 * signedSeparation * a.rail.nx;
		const centerBaseY = a.rail.cy + 0.5 * signedSeparation * a.rail.ny;
		let lowCenterAlong = -Infinity, highCenterAlong = Infinity;
		for (const item of [a, b]) for (const [x, y] of item.entry.pixels) {
			const along = (x - centerBaseX) * a.rail.c + (y - centerBaseY) * a.rail.s;
			lowCenterAlong = Math.max(lowCenterAlong, along - halfWidth);
			highCenterAlong = Math.min(highCenterAlong, along + halfWidth);
		}
		if (lowCenterAlong > highCenterAlong + RASTER_TOLERANCE_PX) continue;
		const centerAlong = Math.max(lowCenterAlong, Math.min(highCenterAlong, 0));
		const centerX = centerBaseX + centerAlong * a.rail.c;
		const centerY = centerBaseY + centerAlong * a.rail.s;
		const badgeX = target.cxPx;
		const badgeY = target.cyPx - viewportTopPx;
		const perpendicularError = Math.abs((badgeX - centerX) * a.rail.nx + (badgeY - centerY) * a.rail.ny);
		const alongToBadge = Math.abs((badgeX - centerX) * a.rail.c + (badgeY - centerY) * a.rail.s);
		const orientationBoundPx = alongToBadge * Math.sin(a.rail.angleBoundRad + axisError / 2);
		const centerlineBoundPx = RASTER_TOLERANCE_PX + (a.rail.centerNormalBoundPx + b.rail.centerNormalBoundPx) / 2 + orientationBoundPx;
		const perpendicularMiss = Math.max(0, perpendicularError - centerlineBoundPx);
		const fit: RecoveryFit = {
			centerXPx: centerX,
			centerYPx: centerY,
			halfWidthPx: halfWidth,
			halfHeightPx: halfHeight,
			angleRad: a.rail.angleRad,
			supportThicknessPx: thickness,
			fitKind: 'rail-pair-projection',
			badgePerpendicularErrorPx: perpendicularError,
			badgePerpendicularMissPx: perpendicularMiss,
			badgePerpendicularBoundPx: centerlineBoundPx,
			railAngleBoundRad: a.rail.angleBoundRad + axisError / 2,
			railSeparationErrorPx: separationErrorPx,
			railSeparationBoundPx: separationBoundPx,
			projectedLaneWidthPx: halfHeight * 2,
			observedRailSpanPx: Math.max(a.rail.spanPx, b.rail.spanPx)
		};
		const separationMiss = Math.max(0, separationErrorPx - separationBoundPx);
		if (!best || perpendicularMiss < (best.fit.badgePerpendicularMissPx ?? Infinity) ||
			(perpendicularMiss === (best.fit.badgePerpendicularMissPx ?? Infinity) && separationMiss < best.separationMiss)) {
			best = { fit, labels: [a.entry.component.label, b.entry.component.label].sort((x, y) => x - y), separationMiss };
		}
	}
	return best ? { fit: best.fit, labels: best.labels } : undefined;
}

function fitComponent(
	pixels: readonly [number, number][],
	component: ComponentStats,
	target: BadgeEvidence,
	viewportTopPx: number,
	halfWidth: number,
	halfHeight: number,
	halfHeightErrorPx: number,
	thickness: number
): RecoveryFit {
	const projectedRail = projectRailFit(pixels, component, target, viewportTopPx, halfWidth, halfHeight, halfHeightErrorPx, thickness);
	if (projectedRail) return projectedRail;
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
	/** Kept as presentation testimony only; no degree threshold gates visible ownership. */
	readonly axisErrorRad: number;
	readonly perpendicularErrorPx: number;
	/** Measured geometry-derived allowance at this badge distance. */
	readonly perpendicularBoundPx: number;
	readonly angleBoundRad: number;
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
 * Cheap G4 testimony for already-visible tees.
 *
 * The badge target is its semantic CENTER, not its generous bbox. A visible
 * pad supplies a measured centerline plus a built-in uncertainty envelope:
 * raster center uncertainty + the course-local P100 pad-width spread + the
 * finite major-span orientation uncertainty projected out to badge distance.
 * No degree threshold, pathfinding, or assignment evidence participates.
 */
export function resolveVisibleTeeBadgeRays(
	tees: readonly TeeEvidence[],
	badges: readonly BadgeEvidence[]
): VisibleTeeBadgeRayResolution {
	const numbered = badges.filter((badge) => numberLabel(badge) !== undefined);
	const claims: VisibleTeeBadgeRayClaim[] = [];
	const ambiguousTeeIds: string[] = [];
	const measuredWidths = tees
		.map((tee) => tee.pad?.minorPx)
		.filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0)
		.sort((a, b) => a - b);
	const knownPadWidthPx = measuredWidths[Math.floor(measuredWidths.length / 2)] ?? 0;
	const knownHalfWidthErrorPx = measuredWidths.length === 0
		? 0
		: Math.max(...measuredWidths.map((width) => Math.abs(width - knownPadWidthPx))) / 2;

	for (const tee of tees) {
		const pose = tee.pad?.minAreaPose;
		const axisRad = pose?.angleRad ?? tee.pad?.angleRad ?? tee.angleRad;
		const xPx = pose?.centerXPx ?? tee.pad?.centerXPx ?? tee.xPx;
		const yPx = pose?.centerYPx ?? tee.pad?.centerYPx ?? tee.yPx;
		const majorPx = pose?.majorPx ?? tee.pad?.majorPx;
		const minorPx = pose?.minorPx ?? tee.pad?.minorPx;
		if (!tee.pad || axisRad === null || !Number.isFinite(axisRad) || !majorPx || !minorPx) continue;
		const c = Math.cos(axisRad), ss = Math.sin(axisRad);
		const halfPad = majorPx / 2;
		// A full visible pad's centerline is bracketed by its own rails. The only
		// normal-position allowance is raster quantization plus the measured
		// course-local width spread; orientation uncertainty is independently
		// derived from finite observed major span.
		const centerNormalBoundPx = RASTER_TOLERANCE_PX + knownHalfWidthErrorPx;
		const angleBoundRad = Math.atan2(RASTER_TOLERANCE_PX, Math.max(RASTER_TOLERANCE_PX, majorPx / 2));
		const firstIntercepts: VisibleTeeBadgeRayClaim[] = [];
		for (const direction of [-1, 1] as const) {
			const hits = numbered.flatMap((badge) => {
				const dx = badge.cxPx - xPx, dy = badge.cyPx - yPx;
				const alongSigned = dx * c + dy * ss;
				const alongPx = direction * alongSigned;
				if (alongPx <= halfPad) return [];
				const perpendicularErrorPx = Math.abs(-dx * ss + dy * c);
				const orientationBoundPx = alongPx * Math.sin(angleBoundRad);
				const perpendicularBoundPx = centerNormalBoundPx + orientationBoundPx;
				if (perpendicularErrorPx > perpendicularBoundPx) return [];
				return [{
					claim: {
						teeId: tee.detId,
						badgeId: badge.detId,
						badgeLabel: badge.label,
						axisErrorRad: undirectedAxisError(axisRad, Math.atan2(dy, dx)),
						perpendicularErrorPx,
						perpendicularBoundPx,
						angleBoundRad,
						alongPx,
						direction
					} satisfies VisibleTeeBadgeRayClaim,
					alongPx
				}];
			}).sort((a, b) => a.alongPx - b.alongPx || a.claim.badgeId.localeCompare(b.claim.badgeId));
			if (hits[0]) firstIntercepts.push(hits[0].claim);
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
function graphCandidateResult(candidate: TeeRecoveryCandidate): TeeRecoveryResult {
	const support = candidate.fragmentPixels.length;
	const componentCount = candidate.supportingComponentIds.length;
	const axisError = badgeAxisError(candidate);
	const railMissPx = isRailProjectionFit(candidate.fit) ? candidate.fit.badgePerpendicularMissPx ?? Infinity : undefined;
	const axisRejected = candidate.badgeLabel !== null && candidate.badgeLabel !== undefined && /^\d+$/.test(candidate.badgeLabel) && (
		railMissPx !== undefined ? railMissPx > 0 : (axisError ?? Infinity) >= activeAxisLimitRad
	);
	const unexplained = unexplainedPixels(candidate);
	const insufficientSupport = support < MIN_SHARD_SUPPORT_PIXELS;
	const ambiguity = (candidate.ambiguityWithBadgeLabels?.length ?? 0) > 0;
	const accepted = !insufficientSupport && unexplained.length === 0 && !axisRejected && !ambiguity;
	const localized = candidate.localizationFit ?? candidate.fit;
	const coordinateOffset = candidate.coordinateFrame === 'original' ? 0 : candidate.viewportTopPx ?? 0;
	const localizationEvidence = candidate.localizationSource === 'full-span-component-pca'
		? '; localization uses the exact centroid/axis of the single detector-owned component spanning both course-local pad axes'
		: '; localization uses the badge-constrained support fit because the visible evidence is small or split';
	const pixelEvidence = unexplained.length
		? `; unexplained visible component pixels: ${unexplained.slice(0, 8).map(([x, y]) => `(${x},${y})`).join(', ')}${unexplained.length > 8 ? ` (+${unexplained.length - 8} more)` : ''}`
		: '';
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
	const reason = accepted
		? `every non-occluded visible component pixel across ${componentCount} visible shard${componentCount === 1 ? '' : 's'} fits a course-local hollow tee support whose major axis points at badge ${candidate.badgeLabel ?? candidate.badgeId ?? 'UNKNOWN'}; ${searchScope}${localizationEvidence}`
		: ambiguity
			? `${holePrefix}${searchScope}; this exact component set also supports badge${candidate.ambiguityWithBadgeLabels!.length === 1 ? '' : 's'} ${candidate.ambiguityWithBadgeLabels!.join(', ')}; multiclaim preserved and every claimant is DEFERRED — G4 selects no local winner`
			: `${holePrefix}${searchScope}; ${insufficientSupport
				? `visible component support ${support} < ${MIN_SHARD_SUPPORT_PIXELS}`
				: `${axisRejected
					? isRailProjectionFit(candidate.fit)
						? `observed rail projected by the known pad width misses the inferred centerline bound by ${(candidate.fit.badgePerpendicularMissPx ?? Infinity).toFixed(3)}px (centerline error ${(candidate.fit.badgePerpendicularErrorPx ?? Infinity).toFixed(3)}px > built-in ${(candidate.fit.badgePerpendicularBoundPx ?? Infinity).toFixed(3)}px error bound)`
						: `badge-axis angular error ${(axisError! * 180 / Math.PI).toFixed(3)}° is not < ${activeAxisLimitDeg}° (knob axisToleranceDeg; non-rail fallback only)`
					: isRailProjectionFit(candidate.fit)
						? `rail projection passes: centerline error ${(candidate.fit.badgePerpendicularErrorPx ?? Infinity).toFixed(3)}px <= built-in ${(candidate.fit.badgePerpendicularBoundPx ?? Infinity).toFixed(3)}px bound from known pad width + observed rail + raster error; no badge-driven pose search was performed`
						: `no hollow tee support fit within ${activeAxisLimitDeg}° of the badge ray explains every visible component pixel (knob axisToleranceDeg; non-rail fallback only)`}${unexplained.length ? pixelEvidence : '; visible component pixels otherwise lie on the fitted support footprint'}`}`;
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
			...(isRailProjectionFit(candidate.fit) ? {
				badgePerpendicularErrorPx: candidate.fit.badgePerpendicularErrorPx ?? Infinity,
				badgePerpendicularMissPx: candidate.fit.badgePerpendicularMissPx ?? Infinity,
				badgePerpendicularBoundPx: candidate.fit.badgePerpendicularBoundPx ?? Infinity,
				railAngleBoundRad: candidate.fit.railAngleBoundRad ?? Infinity,
				railSeparationErrorPx: candidate.fit.railSeparationErrorPx ?? 0,
				railSeparationBoundPx: candidate.fit.railSeparationBoundPx ?? 0,
				projectedLaneWidthPx: candidate.fit.projectedLaneWidthPx ?? 0,
				observedRailSpanPx: candidate.fit.observedRailSpanPx ?? 0,
				railProjection: 1,
				railPairProjection: candidate.fit.fitKind === 'rail-pair-projection' ? 1 : 0
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
): { readonly candidates: readonly TeeRecoveryCandidate[]; readonly claimCandidates: readonly TeeRecoveryCandidate[]; readonly searchOutcomes: readonly TargetSearchOutcome[]; readonly chromeSubtractionNotes: readonly ChromeSubtractionNote[] } {
	/** Receipt/debug winners only. Never used as the semantic claim universe. */
	const candidates: TeeRecoveryCandidate[] = [];
	/** Every shard→badge hypothesis that independently satisfies G4 local geometry. */
	const claimCandidates: TeeRecoveryCandidate[] = [];
	const searchOutcomes: TargetSearchOutcome[] = [];
	const chromeSubtractionNotes: ChromeSubtractionNote[] = [];
	const pads = tees.map((tee) => tee.pad).filter((pad): pad is NonNullable<typeof pad> => pad !== undefined);
	if (pads.length === 0) return { candidates, claimCandidates, searchOutcomes, chromeSubtractionNotes };
	const median = (values: readonly number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;
	const halfWidth = median(pads.map((pad) => pad.majorPx / 2));
	const minorWidths = pads.map((pad) => pad.minorPx);
	const knownPadWidthPx = median(minorWidths);
	const halfHeight = knownPadWidthPx / 2;
	// P100 deviation is intentionally a bound, not a fitted sigma: every pad
	// already accepted by G3 is part of the course-local width contract.
	const halfHeightErrorPx = minorWidths.length === 0
		? 0
		: Math.max(...minorWidths.map((width) => Math.abs(width - knownPadWidthPx))) / 2;
	const thickness = supportThickness(tees);
	const coveredBadgeIds = new Set(search.assignment?.assignments.map((row) => row.badgeId) ?? []);
	const targets = badges.filter((badge) => numberLabel(badge) !== undefined && !coveredBadgeIds.has(badge.detId));
	if (targets.length === 0) return { candidates, claimCandidates, searchOutcomes, chromeSubtractionNotes };

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
		return pixels.length ? [{ component, pixels }] : [];
	});

	for (const target of targets) {
		const targetCandidates: TeeRecoveryCandidate[] = [];
		const seenGroups = new Set<string>();
		for (const seed of visibleComponents) {
			let fit = fitComponent(seed.pixels, seed.component, target, viewportTopPx, halfWidth, halfHeight, halfHeightErrorPx, thickness);
			const compatibleWith = (candidateFit: RecoveryFit) => visibleComponents.filter((entry) =>
				entry.component.label === seed.component.label ||
				entry.pixels.every((point) => pointExplainsTee(point, candidateFit))
			);
			let compatible = compatibleWith(fit);
			// Refit only when the first pose actually attracted another component.
			// If compatible is just the seed, union is byte-for-byte the exact pixels
			// fit above, so solving the same exhaustive optimization again is a no-op.
			if (compatible.length > 1) {
				const railPair = projectRailPairFit(compatible, target, viewportTopPx, halfWidth, halfHeight, halfHeightErrorPx, thickness);
				if (railPair) {
					fit = railPair.fit;
					const labels = new Set(railPair.labels);
					compatible = compatible.filter((entry) => labels.has(entry.component.label));
				} else {
					for (let pass = 0; pass < 2; pass++) {
						const union = compatible.flatMap((entry) => entry.pixels);
						if (union.length === 0) break;
						fit = fitComponent(union, seed.component, target, viewportTopPx, halfWidth, halfHeight, halfHeightErrorPx, thickness);
						const next = compatibleWith(fit);
						if (next.map((entry) => entry.component.label).join(',') === compatible.map((entry) => entry.component.label).join(',')) break;
						compatible = next;
					}
				}
			}
			if (compatible.length === 0) continue;
			const groupKey = compatible.map((entry) => entry.component.label).sort((a, b) => a - b).join('+');
			if (!groupKey || seenGroups.has(groupKey)) continue;
			seenGroups.add(groupKey);
			const pixels = compatible.flatMap((entry) => entry.pixels);
			const visibleShards = compatible.flatMap((entry) => connectedPixelShards(entry.pixels));
			const localizationStats = fit.fitKind !== 'rail-pair-projection' && compatible.length === 1 && visibleShards.length === 1
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
				badgeLabel: target.label
			});
		}
		// Evaluate the predicate before choosing. A large basket/badge component
		// must never hide a smaller component whose every visible pixel fits.
		for (const candidate of targetCandidates) {
			const unexplained = unexplainedPixels(candidate).length;
			const axisError = badgeAxisError(candidate) ?? Infinity;
			const railMiss = isRailProjectionFit(candidate.fit) ? candidate.fit.badgePerpendicularMissPx ?? Infinity : undefined;
			const locallyValid = candidate.fragmentPixels.length >= MIN_SHARD_SUPPORT_PIXELS &&
				unexplained === 0 &&
				(railMiss !== undefined ? railMiss === 0 : axisError < activeAxisLimitRad);
			if (locallyValid) claimCandidates.push(candidate);
		}
		// Presentation ordering only. It must never decide which claim exists.
		targetCandidates.sort((a, b) => {
			const ar = unexplainedPixels(a).length, br = unexplainedPixels(b).length;
			const aa = badgeAxisError(a) ?? Infinity, ba = badgeAxisError(b) ?? Infinity;
			const aRailMiss = isRailProjectionFit(a.fit) ? a.fit.badgePerpendicularMissPx ?? Infinity : undefined;
			const bRailMiss = isRailProjectionFit(b.fit) ? b.fit.badgePerpendicularMissPx ?? Infinity : undefined;
			const aAccepted = a.fragmentPixels.length >= MIN_SHARD_SUPPORT_PIXELS && ar === 0 && (aRailMiss !== undefined ? aRailMiss === 0 : aa < activeAxisLimitRad);
			const bAccepted = b.fragmentPixels.length >= MIN_SHARD_SUPPORT_PIXELS && br === 0 && (bRailMiss !== undefined ? bRailMiss === 0 : ba < activeAxisLimitRad);
			if (aAccepted !== bAccepted) return aAccepted ? -1 : 1;
			if (aAccepted) {
				const aResidual = isRailProjectionFit(a.fit) ? a.fit.badgePerpendicularErrorPx ?? Infinity : aa;
				const bResidual = isRailProjectionFit(b.fit) ? b.fit.badgePerpendicularErrorPx ?? Infinity : ba;
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
	const accepted = claimCandidates.filter((candidate) => {
		const support = candidate.fragmentPixels.length;
		const railMiss = isRailProjectionFit(candidate.fit) ? candidate.fit.badgePerpendicularMissPx ?? Infinity : undefined;
		return support >= MIN_SHARD_SUPPORT_PIXELS &&
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
			const index = claimCandidates.indexOf(candidate);
			if (index >= 0) claimCandidates[index] = { ...candidate, ambiguityWithBadgeLabels: others };
		}
	}

	return { candidates, claimCandidates, searchOutcomes, chromeSubtractionNotes };
}


interface G4ClaimRow {
	readonly id: string;
	readonly kind: 'visible' | 'recovery';
	readonly badgeIds: readonly string[];
	/** Every pose witness for a physical recovery-object→badge edge. Identity
	 * consensus never chooses among these. */
	readonly candidateIndexesByBadge?: ReadonlyMap<string, readonly number[]>;
}

interface G4MatchingSolution {
	readonly score: number;
	readonly visibleMatched: number;
	readonly recoveryMatched: number;
	readonly badgeByRow: readonly (string | null)[];
}

interface G4ClaimConsensus {
	/** One localization witness selected AFTER each identity edge is proven forced. */
	readonly forcedCandidateIndexes: ReadonlySet<number>;
	/** Locally valid identity edges that remain genuinely ambiguous. */
	readonly deferredCandidateIndexes: ReadonlySet<number>;
	/** Alternative pose testimony for an already-forced identity edge. */
	readonly alternateWitnessCandidateIndexes: ReadonlySet<number>;
	readonly base: G4MatchingSolution;
	readonly recoveryRows: number;
	readonly forcedEdges: number;
}

function physicalComponentLabels(candidate: TeeRecoveryCandidate): readonly string[] {
	const labels = new Set<string>();
	for (const id of candidate.supportingComponentIds) {
		for (const label of id.split(':')[0]!.split('+')) if (label) labels.add(label);
	}
	return [...labels].sort();
}

function candidateLocallySupportsBadge(candidate: TeeRecoveryCandidate): boolean {
	if (candidate.fragmentPixels.length < MIN_SHARD_SUPPORT_PIXELS) return false;
	if (unexplainedPixels(candidate).length !== 0) return false;
	if (isRailProjectionFit(candidate.fit)) return (candidate.fit.badgePerpendicularMissPx ?? Infinity) === 0;
	return (badgeAxisError(candidate) ?? Infinity) < activeAxisLimitRad;
}


function localizationWitnessRank(candidate: TeeRecoveryCandidate): number {
	if (candidate.fit.fitKind === 'rail-pair-projection') return 0;
	if (candidate.localizationSource === 'full-span-component-pca') return 1;
	if (candidate.fit.fitKind === 'rail-projection') return 2;
	return 3;
}

function selectForcedLocalizationWitness(
	indexes: readonly number[],
	candidates: readonly TeeRecoveryCandidate[]
): number | undefined {
	return [...indexes].sort((a, b) => {
		const ca = candidates[a]!, cb = candidates[b]!;
		return localizationWitnessRank(ca) - localizationWitnessRank(cb) ||
			cb.fragmentPixels.length - ca.fragmentPixels.length ||
			ca.id.localeCompare(cb.id);
	})[0];
}

/**
 * Maximum-weight bipartite matching over LOCAL G4 claims only.
 *
 * This is not an assignment oracle. Visible tees have weight B where
 * B > the maximum possible number of recovery edges, so the objective is
 * lexicographic: preserve as many already-visible tee identities as the claim
 * graph permits, THEN maximize how many independent shard objects can coexist.
 * There is no residual/angle/score in the weights. A recovery edge is promoted
 * only when deleting that edge makes the optimum strictly worse — i.e. that
 * exact edge occurs in EVERY optimal solution. Matching never chooses among
 * equally supported alternatives; those remain DEFERRED testimony.
 */
function solveG4ClaimMatching(
	rows: readonly G4ClaimRow[],
	badgeIds: readonly string[],
	excludedEdge?: string
): G4MatchingSolution {
	if (rows.length === 0) return { score: 0, visibleMatched: 0, recoveryMatched: 0, badgeByRow: [] };
	const badgeIndex = new Map(badgeIds.map((id, index) => [id, index]));
	const visibleWeight = badgeIds.length + 1;
	const unsupported = -1_000_000;
	// One dummy column per row means every object may remain unresolved rather
	// than being forced onto an unsupported badge.
	const columns = badgeIds.length + rows.length;
	const weights = rows.map((row) => {
		const values = new Array<number>(columns).fill(0);
		for (let j = 0; j < badgeIds.length; j++) values[j] = unsupported;
		for (const badgeId of row.badgeIds) {
			const j = badgeIndex.get(badgeId);
			if (j === undefined) continue;
			if (excludedEdge === `${row.id}|${badgeId}`) continue;
			values[j] = row.kind === 'visible' ? visibleWeight : 1;
		}
		return values;
	});

	// Hungarian algorithm (rectangular minimization form), using negated
	// weights. n<=m because of the dummy columns above.
	const n = rows.length, m = columns;
	const u = new Array<number>(n + 1).fill(0);
	const v = new Array<number>(m + 1).fill(0);
	const p = new Array<number>(m + 1).fill(0);
	const way = new Array<number>(m + 1).fill(0);
	for (let i = 1; i <= n; i++) {
		p[0] = i;
		let j0 = 0;
		const minv = new Array<number>(m + 1).fill(Infinity);
		const used = new Array<boolean>(m + 1).fill(false);
		do {
			used[j0] = true;
			const i0 = p[j0]!;
			let delta = Infinity, j1 = 0;
			for (let j = 1; j <= m; j++) {
				if (used[j]) continue;
				const cur = -weights[i0 - 1]![j - 1]! - u[i0]! - v[j]!;
				if (cur < minv[j]!) { minv[j] = cur; way[j] = j0; }
				if (minv[j]! < delta) { delta = minv[j]!; j1 = j; }
			}
			for (let j = 0; j <= m; j++) {
				if (used[j]) { u[p[j]!] += delta; v[j] -= delta; }
				else minv[j] -= delta;
			}
			j0 = j1;
		} while (p[j0] !== 0);
		do {
			const j1 = way[j0]!;
			p[j0] = p[j1]!;
			j0 = j1;
		} while (j0 !== 0);
	}
	const columnByRow = new Array<number>(n).fill(-1);
	for (let j = 1; j <= m; j++) if (p[j]! > 0) columnByRow[p[j]! - 1] = j - 1;
	let score = 0, visibleMatched = 0, recoveryMatched = 0;
	const badgeByRow: (string | null)[] = [];
	for (let i = 0; i < n; i++) {
		const j = columnByRow[i]!;
		const real = j >= 0 && j < badgeIds.length && weights[i]![j]! > 0;
		badgeByRow.push(real ? badgeIds[j]! : null);
		if (!real) continue;
		score += weights[i]![j]!;
		if (rows[i]!.kind === 'visible') visibleMatched++; else recoveryMatched++;
	}
	return { score, visibleMatched, recoveryMatched, badgeByRow };
}

function resolveG4ClaimConsensus(
	tees: readonly TeeEvidence[],
	visibleClaims: readonly VisibleTeeBadgeRayClaim[],
	candidates: readonly TeeRecoveryCandidate[],
	badges: readonly BadgeEvidence[]
): G4ClaimConsensus {
	const badgeIds = badges.filter((badge) => numberLabel(badge) !== undefined).map((badge) => badge.detId).sort();
	const visibleByTee = new Map<string, Set<string>>();
	for (const tee of tees) visibleByTee.set(tee.detId, new Set());
	for (const claim of visibleClaims) visibleByTee.get(claim.teeId)?.add(claim.badgeId);
	const visibleRows: G4ClaimRow[] = tees.map((tee) => {
		const claims = [...(visibleByTee.get(tee.detId) ?? [])].sort();
		// A visible tee with zero local relation testimony still physically
		// exists and therefore consumes one badge slot. Wildcarding only this
		// zero-evidence case reserves that cardinality without fabricating a
		// relation claim or suppressing any recorded alternative.
		return { id: `visible:${tee.detId}`, kind: 'visible', badgeIds: claims.length > 0 ? claims : badgeIds };
	});

	// Overlapping component hypotheses are one physical evidence cluster: the
	// same bright pixel may not become two recovered tees merely because one
	// target used a subset/superset group key.
	const localIndexes = candidates.map((candidate, index) => ({ candidate, index })).filter(({ candidate }) => candidateLocallySupportsBadge(candidate));
	const parent = localIndexes.map((_, index) => index);
	const find = (x: number): number => parent[x] === x ? x : (parent[x] = find(parent[x]!));
	const unite = (a: number, b: number) => { a = find(a); b = find(b); if (a !== b) parent[b] = a; };
	const labels = localIndexes.map(({ candidate }) => new Set(physicalComponentLabels(candidate)));
	for (let i = 0; i < labels.length; i++) for (let j = i + 1; j < labels.length; j++) {
		if ([...labels[i]!].some((label) => labels[j]!.has(label))) unite(i, j);
	}
	const members = new Map<number, typeof localIndexes>();
	for (let i = 0; i < localIndexes.length; i++) {
		const root = find(i); const bucket = members.get(root); if (bucket) bucket.push(localIndexes[i]!); else members.set(root, [localIndexes[i]!]);
	}
	const recoveryRows: G4ClaimRow[] = [...members.entries()].map(([root, bucket]) => {
		const candidateIndexesByBadge = new Map<string, number[]>();
		for (const { candidate, index } of bucket) {
			if (!candidate.badgeId) continue;
			const witnesses = candidateIndexesByBadge.get(candidate.badgeId);
			if (witnesses) witnesses.push(index); else candidateIndexesByBadge.set(candidate.badgeId, [index]);
		}
		return {
			id: `recovery:${[...new Set(bucket.flatMap(({ candidate }) => physicalComponentLabels(candidate)))].sort().join('+') || root}`,
			kind: 'recovery',
			badgeIds: [...candidateIndexesByBadge.keys()].sort(),
			candidateIndexesByBadge
		};
	});
	const rows = [...visibleRows, ...recoveryRows];
	const base = solveG4ClaimMatching(rows, badgeIds);
	const forcedCandidateIndexes = new Set<number>();
	const forcedRelationCandidateIndexes = new Set<number>();
	const alternateWitnessCandidateIndexes = new Set<number>();
	const allLocalCandidateIndexes = new Set(localIndexes.map(({ index }) => index));
	let forcedEdges = 0;
	for (const row of recoveryRows) {
		for (const badgeId of row.badgeIds) {
			const witnessIndexes = row.candidateIndexesByBadge?.get(badgeId) ?? [];
			if (witnessIndexes.length === 0) continue;
			const without = solveG4ClaimMatching(rows, badgeIds, `${row.id}|${badgeId}`);
			if (without.score >= base.score) continue;
			forcedEdges++;
			for (const index of witnessIndexes) forcedRelationCandidateIndexes.add(index);
			const selected = selectForcedLocalizationWitness(witnessIndexes, candidates);
			if (selected !== undefined) forcedCandidateIndexes.add(selected);
			for (const index of witnessIndexes) if (index !== selected) alternateWitnessCandidateIndexes.add(index);
		}
	}
	const deferredCandidateIndexes = new Set([...allLocalCandidateIndexes].filter((index) => !forcedRelationCandidateIndexes.has(index)));
	return { forcedCandidateIndexes, deferredCandidateIndexes, alternateWitnessCandidateIndexes, base, recoveryRows: recoveryRows.length, forcedEdges };
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
		const lockedBadgeIds = new Set(rayResolution.locks.map((claim) => claim.badgeId));
		const lockedKeys = new Set(rayResolution.locks.map((claim) => `${claim.teeId}|${claim.badgeId}`));
		const numberedBadges = badges.filter((badge) => numberLabel(badge) !== undefined);
		ctx.measure('teeRecovery', 'visibleRayClaims', rayResolution.claims.length);
		ctx.measure('teeRecovery', 'visibleRayLocks', rayResolution.locks.length);
		for (const claim of rayResolution.claims) {
			ctx.measure('teeRecovery', 'visibleRayPerpendicularErrorPx', claim.perpendicularErrorPx);
			ctx.measure('teeRecovery', 'visibleRayPerpendicularBoundPx', claim.perpendicularBoundPx);
			ctx.measure('teeRecovery', 'visibleRayAngleBoundDeg', claim.angleBoundRad * 180 / Math.PI);
		}
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
					? `LOCK: visible ${tee.detId} has one first-intercept badge and badge ${badge.label ?? badge.detId} has one visible-tee claimant; projected centerline miss ${claim.perpendicularErrorPx.toFixed(3)}px <= built-in ${claim.perpendicularBoundPx.toFixed(3)}px bound; no pathfinding or assignment testimony read`
					: `POSSIBLE: visible ${tee.detId} supplies first-intercept testimony for badge ${badge.label ?? badge.detId}; projected centerline miss ${claim.perpendicularErrorPx.toFixed(3)}px <= built-in ${claim.perpendicularBoundPx.toFixed(3)}px bound; multiclaim/conflict is preserved as coverage, not erased into a false recovery target`
			});
		}
		if (lockedBadgeIds.size === numberedBadges.length) {
			board.set('recoveredTees', board.get<readonly RecoveredTeeInput[]>('recoveredTees'));
			stop();
			return;
		}
		const localRayClaims: TeeRecoveryAssignmentContext = {
			assignments: [...lockedBadgeIds].sort().map((badgeId) => ({ badgeId, basketId: 'G4-visible-ray-lock' }))
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
		if (!tees.some((tee) => tee.pad)) {
			ctx.measure('teeRecovery', 'noCourseLocalPadGeometry', 1);
			stop();
			return;
		}
		const geometryFittingStop = ctx.span('teeRecovery.geometryFitting');
		const allResults = built.claimCandidates.map(graphCandidateResult);
		geometryFittingStop();
		ctx.measure('teeRecovery', 'localClaimEdges', built.claimCandidates.length);
		ctx.measure('teeRecovery', 'presentationWinners', built.candidates.length);
		ctx.measure('teeRecovery', 'seedFragments', new Set(built.claimCandidates.map((candidate) => candidate.id.match(/^tee-shard-[^-]+/)?.[0] ?? candidate.id)).size);
		ctx.measure('teeRecovery', 'componentHypotheses', allResults.length);
		for (const candidate of built.claimCandidates) ctx.measure('teeRecovery', 'bfsComponentsVisited', candidate.bfsComponentsVisited ?? 0);
		const badgeSupportStop = ctx.span('teeRecovery.badgeSupport');
		const consensus = resolveG4ClaimConsensus(tees, rayResolution.claims, built.claimCandidates, numberedBadges);
		badgeSupportStop();
		ctx.measure('teeRecovery', 'claimConsensusVisibleMatched', consensus.base.visibleMatched);
		ctx.measure('teeRecovery', 'claimConsensusRecoveryMatched', consensus.base.recoveryMatched);
		ctx.measure('teeRecovery', 'claimConsensusRecoveryObjects', consensus.recoveryRows);
		ctx.measure('teeRecovery', 'claimConsensusForcedEdges', consensus.forcedEdges);
		ctx.measure('teeRecovery', 'claimConsensusDeferredEdges', consensus.deferredCandidateIndexes.size);
		ctx.measure('teeRecovery', 'claimConsensusAlternateWitnesses', consensus.alternateWitnessCandidateIndexes.size);
		const promoted = [...consensus.forcedCandidateIndexes].sort((a, b) => a - b).map((index) => {
			const candidate = built.claimCandidates[index]!;
			const baseResult = allResults[index]!;
			return {
				candidate,
				result: {
					...baseResult,
					verdict: 'accepted' as const,
					reason: `G4 CONSENSUS LOCK: this physical shard→badge claim occurs in every maximum-consistency mapping that preserves visible tee claims; ${baseResult.reason}`
				}
			};
		});
		const results = promoted.map((entry) => entry.result);
		for (let index = 0; index < built.candidates.length; index++) {
			const candidate = built.claimCandidates[index]!;
			if (consensus.forcedCandidateIndexes.has(index)) continue;
			const baseResult = allResults[index]!;
			const xPx = candidate.fit.centerXPx;
			const yPx = candidate.fit.centerYPx + (candidate.coordinateFrame === 'original' ? 0 : candidate.viewportTopPx ?? 0);
			if (consensus.alternateWitnessCandidateIndexes.has(index)) {
				ctx.overlay('teeRecovery', {
					type: 'point', xPx, yPx, verdict: 'info', visualRole: 'tee-rejection', ref: `${candidate.id}:alternate-witness`,
					reason: `ALTERNATE WITNESS: shard→badge identity is already forced by consensus; this independently valid pose witness is preserved but is less constrained than the selected localization witness`,
					values: numericTraceValues(baseResult.values)
				});
			} else if (consensus.deferredCandidateIndexes.has(index)) {
				ctx.overlay('teeRecovery', {
					type: 'point', xPx, yPx, verdict: 'info', visualRole: 'tee-rejection', ref: `${candidate.id}:consensus-defer`,
					reason: `DEFER: local shard→badge testimony survives, but this edge is not present in every maximum-consistency G4 mapping; no residual score, pathfinding, or loop order may select it`,
					values: numericTraceValues(baseResult.values)
				});
			} else {
				ctx.overlay('teeRecovery', { type: 'point', xPx, yPx, verdict: 'rejected', visualRole: 'tee-rejection', ref: `${candidate.id}:local-reject`, reason: baseResult.reason, values: numericTraceValues(baseResult.values) });
			}
		}
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
			if (isRailProjectionFit(candidate.fit) && candidate.badgeId) {
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
			if (result.values.railAngleBoundRad !== undefined) ctx.measure('teeRecovery', 'railAngleBoundDeg', result.values.railAngleBoundRad * 180 / Math.PI);
			if (result.values.railSeparationErrorPx !== undefined) ctx.measure('teeRecovery', 'railSeparationErrorPx', result.values.railSeparationErrorPx);
			if (result.values.railSeparationBoundPx !== undefined) ctx.measure('teeRecovery', 'railSeparationBoundPx', result.values.railSeparationBoundPx);
			for (const [index, corner] of result.corners.entries()) ctx.overlay('teeRecovery', { type: 'point', xPx: corner[0], yPx: corner[1], verdict: 'info', visualRole: 'tee-corner-tick', ref: `${result.id}:tee-corner-tick-${index}`, reason: 'calculated tee recovery corner' });
			const xs = result.corners.map((point) => point[0]);
			const ys = result.corners.map((point) => point[1]);
			additions.push({ xPx: centerX, yPx: centerY, bbox: [Math.floor(Math.min(...xs)), Math.floor(Math.min(...ys)), Math.ceil(Math.max(...xs) - Math.min(...xs)), Math.ceil(Math.max(...ys) - Math.min(...ys))], provenance: { source: 'tee-shard-recovery', note: `teeRecovery support fit ${result.id}: every non-occluded visible component pixel contributes; discovery seed ${candidate.seedSource ?? 'UNKNOWN'}` } });
		}
		board.set('recoveredTees', [...existing, ...additions]);
		ctx.measure('teeRecovery', 'candidates', allResults.length);
		ctx.measure('teeRecovery', 'accepted', additions.length);
		ctx.measure('teeRecovery', 'promoted', additions.length);
		stop();
	}
};
