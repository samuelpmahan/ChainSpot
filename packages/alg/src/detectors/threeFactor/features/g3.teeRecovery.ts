// G4 tee-shard recovery. The predecessor basket bounds discovery only. Each
// encountered non-occluded white component is accepted exactly when every
// visible pixel can contribute to a course-local tee pointing at the badge.

import type { BadgeEvidence, BasketEvidence, RecoveredTeeInput, TeeEvidence, OrientedQuad, ThreeFactorAssignment } from '../types';
import { statsForPixels, type ComponentStats } from '../components';
import type { Mask } from '../raster';
import type { SpriteMatch } from '../endpoints';
import basketSpriteData from '../assets/basket-sprite.json';
import { assignThreeFactor, type SearchKnobs } from '../assignment';
import type { RibbonKnobs } from '../ribbon';
import type { RoutingKnobs } from '../routing';
import type { ScoringKnobs, ZfitKnobs } from '../scoring';
import { zfitFeature } from './g5.zfit';
import { g4ScoringFeature } from './g4.scoring';
import { g4SearchFeature } from './g4.search';
import { g5RibbonFeature } from './g5.ribbon';
import { g5RoutingFeature } from './g5.routing';
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
	/** Set when this exact component set also satisfies the strict predicate
	 * for another missing badge that wins the axis-error tiebreak. Forces
	 * rejection here so a genuine ambiguity is never silently resolved by
	 * loop order -- the winner's badge label is named so the trade-off is
	 * visible. */
	readonly ambiguityLostToBadgeLabel?: string | null;
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
	note: 'Frozen baseline: recover assignment-missing tees when every visible component pixel fits a course-local hollow tee support pointing at its numbered badge; phantom completion remains terminal and default-OFF.',
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

function fitComponent(
	pixels: readonly [number, number][],
	component: ComponentStats,
	target: BadgeEvidence,
	viewportTopPx: number,
	halfWidth: number,
	halfHeight: number,
	thickness: number
): RecoveryFit {
	// A shard centroid is not a tee center. Solve the actual existence question:
	// search the small center region capable of containing every visible pixel;
	// at each center, constrain the tee major axis to within three degrees of
	// the center-to-badge ray and test every pixel against the hollow support.
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
		supportThicknessPx: thickness
	};
	if (minCenterX > maxCenterX || minCenterY > maxCenterY) return fallback;

	let best = fallback;
	let bestUnexplained = Infinity;
	let bestResidual = Infinity;
	let bestAxisOffset = Infinity;

	// The center lattice and angle lattice are unchanged. The speedup is purely
	// evaluation reuse: badgeRay is a property of one center (not one angle),
	// and the support dimensions are properties of this fit call (not one
	// pixel). Only materialize a RecoveryFit when a pose actually becomes the
	// current best instead of allocating one for every pose we inspect.
	const outerHalfWidth = halfWidth + RASTER_TOLERANCE_PX;
	const outerHalfHeight = halfHeight + RASTER_TOLERANCE_PX;
	const effectiveThickness = Math.max(0, thickness);
	const innerEdgeU = halfWidth - effectiveThickness - RASTER_TOLERANCE_PX;
	const innerEdgeV = halfHeight - effectiveThickness - RASTER_TOLERANCE_PX;
	const scanRangeDeg = Math.max(0.5, activeAxisLimitDeg - 0.5);
	const axisOffsets: number[] = [];
	for (let degrees = -scanRangeDeg; degrees <= scanRangeDeg + 1e-9; degrees += 0.5) {
		axisOffsets.push(degrees * Math.PI / 180);
	}

	const consider = (centerX: number, centerY: number, badgeRay: number, axisOffset: number) => {
		const angleRad = badgeRay + axisOffset;
		const c = Math.cos(angleRad);
		const s = Math.sin(angleRad);
		let unexplained = 0;
		let residual = 0;
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
			) unexplained++;
			const outer = Math.hypot(
				Math.max(0, absU - halfWidth),
				Math.max(0, absV - halfHeight)
			);
			const edgeDistance = Math.min(
				Math.abs(absU - halfWidth),
				Math.abs(absV - halfHeight)
			);
			residual += outer * 4 + edgeDistance;
			if (unexplained > bestUnexplained) break;
		}
		const absOffset = Math.abs(axisOffset);
		if (
			unexplained < bestUnexplained ||
			(unexplained === bestUnexplained && residual < bestResidual) ||
			(unexplained === bestUnexplained && residual === bestResidual && absOffset < bestAxisOffset)
		) {
			best = {
				centerXPx: centerX,
				centerYPx: centerY,
				halfWidthPx: halfWidth,
				halfHeightPx: halfHeight,
				angleRad,
				supportThicknessPx: thickness
			};
			bestUnexplained = unexplained;
			bestResidual = residual;
			bestAxisOffset = absOffset;
		}
	};
	// Same y -> x -> angle visitation order as the original exhaustive scan.
	for (let y = minCenterY; y <= maxCenterY + 1e-9; y += 0.5) {
		for (let x = minCenterX; x <= maxCenterX + 1e-9; x += 0.5) {
			const badgeRay = Math.atan2(badgeY - y, badgeX - x);
			for (const axisOffset of axisOffsets) consider(x, y, badgeRay, axisOffset);
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

/** The recovery producer is deliberately assignment anchored.  These are
 * structural views so callers can pass the normal assignment object without
 * coupling this deviation to the assignment implementation. */
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
function targetPredecessors(
	badges: readonly BadgeEvidence[],
	baskets: readonly BasketEvidence[],
	assignment: TeeRecoveryAssignmentContext | undefined
): readonly { badge: BadgeEvidence; basket: BasketEvidence }[] {
	const byBadge = new Map(badges.map((badge) => [badge.detId, badge]));
	const byBasket = new Map(baskets.map((basket) => [basket.detId, basket]));
	const assigned = new Set(assignment?.assignments.map((row) => row.badgeId) ?? []);
	const rows = assignment?.assignments ?? [];
	const out: { badge: BadgeEvidence; basket: BasketEvidence }[] = [];
	for (const badge of badges) {
		const hole = numberLabel(badge);
		if (hole === undefined || assigned.has(badge.detId)) continue;
		const predecessor = badges.find((candidate) => numberLabel(candidate) === hole - 1);
		if (!predecessor) continue;
		const row = rows.find((candidate) => candidate.badgeId === predecessor.detId);
		const basket = row ? byBasket.get(row.basketId) : undefined;
		if (basket) out.push({ badge, basket });
	}
	return out;
}


function graphCandidateResult(candidate: TeeRecoveryCandidate): TeeRecoveryResult {
	const support = candidate.fragmentPixels.length;
	const componentCount = candidate.supportingComponentIds.length;
	const axisError = badgeAxisError(candidate);
	const axisRejected = candidate.badgeLabel !== null && candidate.badgeLabel !== undefined && /^\d+$/.test(candidate.badgeLabel) && (axisError ?? Infinity) >= activeAxisLimitRad;
	const unexplained = unexplainedPixels(candidate);
	const insufficientSupport = support < MIN_SHARD_SUPPORT_PIXELS;
	const ambiguityLost = candidate.ambiguityLostToBadgeLabel != null;
	const accepted = !insufficientSupport && unexplained.length === 0 && !axisRejected && !ambiguityLost;
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
		: ambiguityLost
			? `${holePrefix}${searchScope}; this exact component set also satisfies the strict predicate for badge ${candidate.ambiguityLostToBadgeLabel}, whose badge-axis angular error is smaller; ambiguity resolved in that badge's favor, never silently dropped`
			: `${holePrefix}${searchScope}; ${insufficientSupport
				? `visible component support ${support} < ${MIN_SHARD_SUPPORT_PIXELS}`
				: `${axisRejected
					? `badge-axis angular error ${(axisError! * 180 / Math.PI).toFixed(3)}° is not < ${activeAxisLimitDeg}° (knob axisToleranceDeg; soft ceiling, target P100 5° then ${BADGE_AXIS_TARGET_DEG}°)`
					: `no hollow tee support fit within ${activeAxisLimitDeg}° of the badge ray explains every visible component pixel (knob axisToleranceDeg; soft ceiling, target P100 5° then ${BADGE_AXIS_TARGET_DEG}°)`}${unexplained.length ? pixelEvidence : '; visible component pixels otherwise lie on the fitted support footprint'}`}`;
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
): { readonly candidates: readonly TeeRecoveryCandidate[]; readonly searchOutcomes: readonly TargetSearchOutcome[]; readonly chromeSubtractionNotes: readonly ChromeSubtractionNote[] } {
	const candidates: TeeRecoveryCandidate[] = [];
	const searchOutcomes: TargetSearchOutcome[] = [];
	const chromeSubtractionNotes: ChromeSubtractionNote[] = [];
	const pads = tees.map((tee) => tee.pad).filter((pad): pad is NonNullable<typeof pad> => pad !== undefined);
	if (pads.length === 0) return { candidates, searchOutcomes, chromeSubtractionNotes };
	const median = (values: readonly number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;
	const halfWidth = median(pads.map((pad) => pad.majorPx / 2));
	const halfHeight = median(pads.map((pad) => pad.minorPx / 2));
	const thickness = supportThickness(tees);
	const assignedBadgeIds = new Set(search.assignment?.assignments.map((row) => row.badgeId) ?? []);
	const targets = badges.filter((badge) => numberLabel(badge) !== undefined && !assignedBadgeIds.has(badge.detId));
	if (targets.length === 0) return { candidates, searchOutcomes, chromeSubtractionNotes };

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
			let fit = fitComponent(seed.pixels, seed.component, target, viewportTopPx, halfWidth, halfHeight, thickness);
			const compatibleWith = (candidateFit: RecoveryFit) => visibleComponents.filter((entry) =>
				entry.component.label === seed.component.label ||
				entry.pixels.every((point) => pointExplainsTee(point, candidateFit))
			);
			let compatible = compatibleWith(fit);
			// The first pose may be underdetermined by a tiny shard. Refit the union,
			// then retain only complete components that still fit the shared pose.
			for (let pass = 0; pass < 2; pass++) {
				const union = compatible.flatMap((entry) => entry.pixels);
				if (union.length === 0) break;
				fit = fitComponent(union, seed.component, target, viewportTopPx, halfWidth, halfHeight, thickness);
				const next = compatibleWith(fit);
				if (next.map((entry) => entry.component.label).join(',') === compatible.map((entry) => entry.component.label).join(',')) break;
				compatible = next;
			}
			if (compatible.length === 0) continue;
			const groupKey = compatible.map((entry) => entry.component.label).sort((a, b) => a - b).join('+');
			if (!groupKey || seenGroups.has(groupKey)) continue;
			seenGroups.add(groupKey);
			const pixels = compatible.flatMap((entry) => entry.pixels);
			const visibleShards = compatible.flatMap((entry) => connectedPixelShards(entry.pixels));
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
				badgeLabel: target.label
			});
		}
		// Evaluate the predicate before choosing. A large basket/badge component
		// must never hide a smaller component whose every visible pixel fits.
		targetCandidates.sort((a, b) => {
			const ar = unexplainedPixels(a).length, br = unexplainedPixels(b).length;
			const aa = badgeAxisError(a) ?? Infinity, ba = badgeAxisError(b) ?? Infinity;
			const aAccepted = a.fragmentPixels.length >= MIN_SHARD_SUPPORT_PIXELS && ar === 0 && aa < activeAxisLimitRad;
			const bAccepted = b.fragmentPixels.length >= MIN_SHARD_SUPPORT_PIXELS && br === 0 && ba < activeAxisLimitRad;
			if (aAccepted !== bAccepted) return aAccepted ? -1 : 1;
			if (aAccepted) return b.fragmentPixels.length - a.fragmentPixels.length || aa - ba || a.supportingComponentIds[0]!.localeCompare(b.supportingComponentIds[0]!);
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

	// Cross-target ambiguity: with no spatial prefilter, the exact same bright
	// component can independently satisfy the strict predicate for more than
	// one missing badge (each target refits its own badge-pointing pose). This
	// is never resolved by loop order/silent drop -- the badge with the
	// smaller badge-axis angular error keeps the accepted candidate; every
	// other claimant is forced to a named rejection in graphCandidateResult.
	const accepted = candidates.filter((candidate) => {
		const support = candidate.fragmentPixels.length;
		return support >= MIN_SHARD_SUPPORT_PIXELS &&
			unexplainedPixels(candidate).length === 0 &&
			(badgeAxisError(candidate) ?? Infinity) < activeAxisLimitRad;
	});
	const byComponentSet = new Map<string, TeeRecoveryCandidate[]>();
	for (const candidate of accepted) {
		const key = candidate.supportingComponentIds.map((id) => id.split(':')[0]).sort().join('+');
		const bucket = byComponentSet.get(key);
		if (bucket) bucket.push(candidate); else byComponentSet.set(key, [candidate]);
	}
	for (const bucket of byComponentSet.values()) {
		if (bucket.length < 2) continue;
		const ranked = [...bucket].sort((a, b) => (badgeAxisError(a) ?? Infinity) - (badgeAxisError(b) ?? Infinity));
		const winner = ranked[0]!;
		for (const loser of ranked.slice(1)) {
			const index = candidates.indexOf(loser);
			if (index >= 0) candidates[index] = { ...loser, ambiguityLostToBadgeLabel: winner.badgeLabel ?? winner.badgeId ?? null };
		}
	}

	return { candidates, searchOutcomes, chromeSubtractionNotes };
}

export const teeRecoveryUnit: EngineUnit = {
	id: 'teeRecovery',
	gate: 'G4',
	consumes: ['stage', 'badges', 'baskets', 'tees', 'sprites', 'viewport', 'recoveredTees', 'assignment', 'measurement'],
	produces: ['recoveredTees', 'assignment'],
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
		const assignment = board.get<ThreeFactorAssignment>('assignment');
		const measurement = board.get<import('../types').ThreeFactorMeasurement>('measurement');
		const badgeIds = new Set(badges.filter((badge) => /^\d+$/.test(badge.label ?? '')).map((badge) => badge.detId));
		const assignedBadgeIds = new Set(assignment.assignments.map((entry) => entry.badgeId));
		if ([...badgeIds].every((badgeId) => assignedBadgeIds.has(badgeId))) {
			ctx.measure('teeRecovery', 'missingNumberedTees', 0);
			board.set('recoveredTees', board.get<readonly RecoveredTeeInput[]>('recoveredTees'));
			board.set('assignment', assignment);
			stop();
			return;
		}
		const shardDiscoveryStop = ctx.span('teeRecovery.shardDiscovery');
		const sprites = board.has('sprites') ? board.get<readonly SpriteMatch[]>('sprites') : undefined;
		ctx.occlusion.registerOpaque(basketOpaqueProvider(stage, baskets, sprites, viewportTopPx));
		const built = buildTeeRecoveryCandidates(stage, badges, baskets, tees, viewportTopPx, { assignment, sprites, occlusion: ctx.occlusion });
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
		// Footgun fix (2026-08-28 inventory): this dedupe distance already has a
		// config-provenanced knob (g4.search.ts's `recoveredTeeDedupeDistance`,
		// default 14) that was resolved further below for reassignment but never
		// actually consumed here -- the literal `14` was live instead. Resolve
		// once, up front, and use it for every check below.
		const searchKnobs = ctx.resolve(g4SearchFeature).knobs as unknown as SearchKnobs;
		const dedupeDistancePx = searchKnobs.recoveredTeeDedupeDistance;
		for (const { candidate, result } of promoted) {
			const centerX = result.corners.reduce((sum, point) => sum + point[0], 0) / 4;
			const centerY = result.corners.reduce((sum, point) => sum + point[1], 0) / 4;
			const duplicate = tees.some((tee) => Math.hypot(tee.xPx - centerX, tee.yPx - centerY) < dedupeDistancePx) ||
				existing.some((tee) => Math.hypot(tee.xPx - centerX, tee.yPx - centerY) < dedupeDistancePx) ||
				additions.some((tee) => Math.hypot(tee.xPx - centerX, tee.yPx - centerY) < dedupeDistancePx);
			if (duplicate && result.verdict === 'accepted') {
				ctx.measure('teeRecovery', 'duplicateSuppressed', 1);
				ctx.overlay('teeRecovery', { type: 'point', xPx: centerX, yPx: centerY, verdict: 'rejected', visualRole: 'tee-rejection', ref: `${result.id}:duplicate`, reason: `recovery center within ${dedupeDistancePx}px of an existing tee (knob recoveredTeeDedupeDistance); duplicate suppressed`, values: numericTraceValues(result.values) });
				continue;
			}
			const shardPixels = candidate.fragmentPixels.map((point) => localPoint(candidate, point, {}));
			if (result.verdict === 'accepted') ctx.overlay('teeRecovery', { type: 'pixelSet', pixels: shardPixels, verdict: 'accepted', visualRole: 'tee-shard', ref: `${result.id}:tee-shard`, reason: result.reason, values: numericTraceValues(result.values) });
			else ctx.overlay('teeRecovery', { type: 'point', xPx: centerX, yPx: centerY, verdict: 'rejected', visualRole: 'tee-rejection', ref: result.id, reason: result.reason, values: numericTraceValues(result.values) });
			if (result.verdict !== 'accepted') continue;
			if (result.values.badgeAxisErrorRad !== undefined) ctx.measure('teeRecovery', 'axisErrorDeg', result.values.badgeAxisErrorRad * 180 / Math.PI);
			for (const [index, corner] of result.corners.entries()) ctx.overlay('teeRecovery', { type: 'point', xPx: corner[0], yPx: corner[1], verdict: 'info', visualRole: 'tee-corner-tick', ref: `${result.id}:tee-corner-tick-${index}`, reason: 'calculated tee recovery corner' });
			const xs = result.corners.map((point) => point[0]);
			const ys = result.corners.map((point) => point[1]);
			additions.push({ xPx: centerX, yPx: centerY, bbox: [Math.floor(Math.min(...xs)), Math.floor(Math.min(...ys)), Math.ceil(Math.max(...xs) - Math.min(...xs)), Math.ceil(Math.max(...ys) - Math.min(...ys))], provenance: { source: 'tee-shard-recovery', note: `teeRecovery support fit ${result.id}: every non-occluded visible component pixel contributes; discovery seed ${candidate.seedSource ?? 'UNKNOWN'}` } });
		}
		board.set('recoveredTees', [...existing, ...additions]);
		if (additions.length > 0 && measurement.rawPairs.length > 0) {
			const zfit = ctx.resolve(zfitFeature).knobs as unknown as ZfitKnobs;
			const scoring = ctx.resolve(g4ScoringFeature).knobs as unknown as ScoringKnobs;
			const ribbon = ctx.resolve(g5RibbonFeature).knobs as unknown as RibbonKnobs;
			const routing = ctx.resolve(g5RoutingFeature).knobs as unknown as RoutingKnobs;
			board.set('assignment', assignThreeFactor(measurement, [...existing, ...additions], zfit, scoring, searchKnobs, ribbon, routing));
		} else {
			if (additions.length > 0) ctx.measure('teeRecovery', 'reassignmentSkippedNoRawPairs', 1);
			board.set('assignment', assignment);
		}
		ctx.measure('teeRecovery', 'candidates', allResults.length);
		ctx.measure('teeRecovery', 'accepted', additions.length);
		ctx.measure('teeRecovery', 'promoted', results.length);
		stop();
	}
};
