// G4 tee-shard recovery. The predecessor basket bounds discovery only. Each
// encountered non-occluded white component is accepted exactly when every
// visible pixel can contribute to a course-local tee pointing at the badge.

import type { BadgeEvidence, BasketEvidence, RecoveredTeeInput, TeeEvidence, OrientedQuad, ThreeFactorAssignment } from '../types';
import type { ComponentStats } from '../components';
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
	readonly fit: RecoveryFit;
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
}

export interface TeeRecoveryValues {
	readonly supportingPixels: number;
	readonly supportingComponents: number;
	readonly badgeAxisAlignment?: number;
	readonly coordinateFrame: 'original-image';
	readonly badgeAxisErrorRad?: number;
	readonly unexplainedVisiblePixels?: number;
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
	knobs: {}
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
	const ring = candidate.fit;
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
const BADGE_AXIS_LIMIT_RAD = 3 * Math.PI / 180;
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
	const consider = (centerX: number, centerY: number, axisOffset: number) => {
		const badgeRay = Math.atan2(badgeY - centerY, badgeX - centerX);
		const fit: RecoveryFit = {
			centerXPx: centerX,
			centerYPx: centerY,
			halfWidthPx: halfWidth,
			halfHeightPx: halfHeight,
			angleRad: badgeRay + axisOffset,
			supportThicknessPx: thickness
		};
		let unexplained = 0;
		let residual = 0;
		for (const point of pixels) {
			if (!pointExplainsTee(point, fit)) unexplained++;
			residual += supportResidual(point, fit);
			if (unexplained > bestUnexplained) break;
		}
		const absOffset = Math.abs(axisOffset);
		if (
			unexplained < bestUnexplained ||
			(unexplained === bestUnexplained && residual < bestResidual) ||
			(unexplained === bestUnexplained && residual === bestResidual && absOffset < bestAxisOffset)
		) {
			best = fit;
			bestUnexplained = unexplained;
			bestResidual = residual;
			bestAxisOffset = absOffset;
		}
	};
	const scan = (
		x0: number,
		x1: number,
		y0: number,
		y1: number,
		centerStep: number,
		angleStepDeg: number
	) => {
		for (let y = y0; y <= y1 + 1e-9; y += centerStep) {
			for (let x = x0; x <= x1 + 1e-9; x += centerStep) {
				for (let degrees = -2.5; degrees <= 2.5 + 1e-9; degrees += angleStepDeg) {
					consider(x, y, degrees * Math.PI / 180);
				}
			}
		}
	};
	// The intersection above is already tiny: a complete H3/H5-sized component
	// leaves only a handful of possible centers. Search it on the native
	// half-pixel centroid lattice so a coarse local optimum cannot hide a valid
	// all-pixels explanation.
	scan(minCenterX, maxCenterX, minCenterY, maxCenterY, 0.5, 0.5);
	return best;
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

function exactKnownPixels(stage: RecoveryStage, badges: readonly BadgeEvidence[], tees: readonly TeeEvidence[], basket: BasketEvidence, sprites: readonly SpriteMatch[] | undefined, viewportTopPx: number, bounds?: readonly [number, number, number, number]): Set<string> {
	const owned = exactBasketPixels(stage, basket, sprites, viewportTopPx);
	const [x0, y0, x1, y1] = bounds ?? [0, 0, stage.width - 1, stage.height - 1];
	for (const badge of badges) {
		const label = badge.component.label;
		const bx0 = Math.max(x0, badge.bbox[0]), bx1 = Math.min(x1, badge.bbox[0] + badge.bbox[2] - 1);
		const by0 = Math.max(y0, badge.bbox[1] - viewportTopPx), by1 = Math.min(y1, badge.bbox[1] - viewportTopPx + badge.bbox[3] - 1);
		for (let y = by0; y <= by1; y++) for (let x = bx0; x <= bx1; x++) if (stage.brightLabels[y * stage.width + x] === label) owned.add(`${x},${y}`);
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
	const axisRejected = candidate.badgeLabel !== null && candidate.badgeLabel !== undefined && /^\d+$/.test(candidate.badgeLabel) && (axisError ?? Infinity) >= BADGE_AXIS_LIMIT_RAD;
	const unexplained = unexplainedPixels(candidate);
	const insufficientSupport = support < MIN_SHARD_SUPPORT_PIXELS;
	const accepted = !insufficientSupport && unexplained.length === 0 && !axisRejected;
	const pixelEvidence = unexplained.length
		? `; unexplained visible component pixels: ${unexplained.slice(0, 8).map(([x, y]) => `(${x},${y})`).join(', ')}${unexplained.length > 8 ? ` (+${unexplained.length - 8} more)` : ''}`
		: '';
	const reason = accepted
		? `every non-occluded visible component pixel across ${componentCount} visible shard${componentCount === 1 ? '' : 's'} fits a course-local hollow tee support whose major axis points at badge ${candidate.badgeLabel ?? candidate.badgeId ?? 'UNKNOWN'}; search seed ${candidate.seedSource ?? 'UNKNOWN'}`
		: insufficientSupport
			? `visible component support ${support} < ${MIN_SHARD_SUPPORT_PIXELS}`
			: `${axisRejected
				? `badge-axis angular error ${(axisError! * 180 / Math.PI).toFixed(3)}° is not < 3°`
				: 'no hollow tee support fit within 3° of the badge ray explains every visible component pixel'}${unexplained.length ? pixelEvidence : '; visible component pixels otherwise lie on the fitted support footprint'}`;
	return {
		id: candidate.id,
		verdict: accepted ? 'accepted' : 'rejected',
		reason,
		values: {
			supportingPixels: support,
			supportingComponents: componentCount,
			coordinateFrame: 'original-image',
			...(axisError === undefined ? {} : { badgeAxisAlignment: Math.cos(axisError), badgeAxisErrorRad: axisError }),
			...(unexplained.length ? { unexplainedVisiblePixels: unexplained.length } : {})
		},
		corners: cornersFor(candidate, {})
	};
}

/**
 * Use B(n-1) only to bound discovery. Once a global source component is
 * encountered, evaluate its complete non-occluded pixel set with geometric
 * tee support; basket contact and raster templates are not acceptance rules.
 */
export function buildTeeRecoveryCandidates(
	stage: RecoveryStage,
	badges: readonly BadgeEvidence[],
	baskets: readonly BasketEvidence[],
	tees: readonly TeeEvidence[],
	viewportTopPx = 0,
	search: TeeRecoverySearchContext = {}
): { readonly candidates: readonly TeeRecoveryCandidate[] } {
	const candidates: TeeRecoveryCandidate[] = [];
	const pads = tees.map((tee) => tee.pad).filter((pad): pad is NonNullable<typeof pad> => pad !== undefined);
	if (pads.length === 0) return { candidates };
	const median = (values: readonly number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;
	const halfWidth = median(pads.map((pad) => pad.majorPx / 2));
	const halfHeight = median(pads.map((pad) => pad.minorPx / 2));
	const thickness = supportThickness(tees);
	const targets = targetPredecessors(badges, baskets, search.assignment);
	for (const target of targets) {
		const anchorX = target.basket.tipXPx;
		const anchorY = target.basket.tipYPx - viewportTopPx;
		const observedSpan = Math.max(target.basket.bbox[2], target.basket.bbox[3], ...pads.map((pad) => Math.max(pad.majorPx, pad.minorPx)));
		const radius = Math.hypot(halfWidth, halfHeight) + observedSpan + 4;
		const minX = Math.max(0, Math.floor(anchorX - radius));
		const maxX = Math.min(stage.width - 1, Math.ceil(anchorX + radius));
		const minY = Math.max(0, Math.floor(anchorY - radius));
		const maxY = Math.min(stage.height - 1, Math.ceil(anchorY + radius));
		// The basket tip only supplies a bounded search origin.  Once a global
		// component intersects that origin, retain every pixel carrying its label;
		// clipping here would turn an unsupported tail into a false tee.
		const targetCandidates: TeeRecoveryCandidate[] = [];
		const owned = exactKnownPixels(
			stage,
			badges,
			tees,
			target.basket,
			search.sprites,
			viewportTopPx
		);
		const visibleComponents = stage.brightComponents.flatMap((component) => {
			const componentPixelsAll = componentPixels(stage, component);
			const pixels = componentPixelsAll.filter(([x, y]) =>
				!owned.has(`${x},${y}`) &&
				search.occlusion?.kindAt(x, y + viewportTopPx) !== 'OPAQUE'
			);
			if (pixels.length === 0) return [];
			if (!pixels.some(([x, y]) => x >= minX && x <= maxX && y >= minY && y <= maxY)) return [];
			return [{ component, pixels }];
		});
		const seenGroups = new Set<string>();
		for (const seed of visibleComponents) {
			let fit = fitComponent(seed.pixels, seed.component, target.badge, viewportTopPx, halfWidth, halfHeight, thickness);
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
				fit = fitComponent(union, seed.component, target.badge, viewportTopPx, halfWidth, halfHeight, thickness);
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
			const teeToBadgeAngleRad = Math.atan2(
				target.badge.cyPx - (fit.centerYPx + viewportTopPx),
				target.badge.cxPx - fit.centerXPx
			);
			targetCandidates.push({
				id: `tee-shard-${target.badge.detId}-${groupKey}`,
				fit,
				fragmentPixels: pixels,
				supportingComponentIds: visibleShards.map((_, index) => `${groupKey}:${index + 1}`),
				viewportTopPx,
				seedSource: target.basket.detId,
				bfsComponentsVisited: stage.brightComponents.length,
				badgeAxisAngleRad: fit.angleRad,
				teeToBadgeAngleRad,
				badgeId: target.badge.detId,
				badgeLabel: target.badge.label
			});
		}
		// Evaluate the predicate before choosing. A large basket/badge component
		// must never hide a smaller component whose every visible pixel fits.
		targetCandidates.sort((a, b) => {
			const ar = unexplainedPixels(a).length, br = unexplainedPixels(b).length;
			const aa = badgeAxisError(a) ?? Infinity, ba = badgeAxisError(b) ?? Infinity;
			const aAccepted = a.fragmentPixels.length >= MIN_SHARD_SUPPORT_PIXELS && ar === 0 && aa < BADGE_AXIS_LIMIT_RAD;
			const bAccepted = b.fragmentPixels.length >= MIN_SHARD_SUPPORT_PIXELS && br === 0 && ba < BADGE_AXIS_LIMIT_RAD;
			if (aAccepted !== bAccepted) return aAccepted ? -1 : 1;
			if (aAccepted) return b.fragmentPixels.length - a.fragmentPixels.length || aa - ba || a.supportingComponentIds[0]!.localeCompare(b.supportingComponentIds[0]!);
			const aFraction = ar / a.fragmentPixels.length;
			const bFraction = br / b.fragmentPixels.length;
			return aFraction - bFraction || ar - br || b.fragmentPixels.length - a.fragmentPixels.length || a.supportingComponentIds[0]!.localeCompare(b.supportingComponentIds[0]!);
		});
		if (targetCandidates[0]) candidates.push(targetCandidates[0]);
	}
	return { candidates };
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
		const missingNumbered = badges.filter((badge) => /^\d+$/.test(badge.label ?? '') && !assignedBadgeIds.has(badge.detId));
		if (missingNumbered.length > 0 && built.candidates.length === 0) {
			const hasPredecessor = targetPredecessors(badges, baskets, assignment).length > 0;
			if (!hasPredecessor) ctx.measure('teeRecovery', 'noPredecessorAssignment', missingNumbered.length);
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
		for (const { candidate, result } of promoted) {
			const centerX = result.corners.reduce((sum, point) => sum + point[0], 0) / 4;
			const centerY = result.corners.reduce((sum, point) => sum + point[1], 0) / 4;
			const duplicate = tees.some((tee) => Math.hypot(tee.xPx - centerX, tee.yPx - centerY) < 14) ||
				existing.some((tee) => Math.hypot(tee.xPx - centerX, tee.yPx - centerY) < 14) ||
				additions.some((tee) => Math.hypot(tee.xPx - centerX, tee.yPx - centerY) < 14);
			if (duplicate && result.verdict === 'accepted') {
				ctx.measure('teeRecovery', 'duplicateSuppressed', 1);
				ctx.overlay('teeRecovery', { type: 'point', xPx: centerX, yPx: centerY, verdict: 'rejected', visualRole: 'tee-rejection', ref: `${result.id}:duplicate`, reason: 'recovery center within 14px of an existing tee; duplicate suppressed', values: numericTraceValues(result.values) });
				continue;
			}
			const shardPixels = candidate.fragmentPixels.map((point) => localPoint(candidate, point, {}));
			if (result.verdict === 'accepted') ctx.overlay('teeRecovery', { type: 'pixelSet', pixels: shardPixels, verdict: 'accepted', visualRole: 'tee-shard', ref: `${result.id}:tee-shard`, reason: result.reason, values: numericTraceValues(result.values) });
			else ctx.overlay('teeRecovery', { type: 'point', xPx: centerX, yPx: centerY, verdict: 'rejected', visualRole: 'tee-rejection', ref: result.id, reason: result.reason, values: numericTraceValues(result.values) });
			if (result.verdict !== 'accepted') continue;
			for (const [index, corner] of result.corners.entries()) ctx.overlay('teeRecovery', { type: 'point', xPx: corner[0], yPx: corner[1], verdict: 'info', visualRole: 'tee-corner-tick', ref: `${result.id}:tee-corner-tick-${index}`, reason: 'calculated tee recovery corner' });
			const xs = result.corners.map((point) => point[0]);
			const ys = result.corners.map((point) => point[1]);
			additions.push({ xPx: centerX, yPx: centerY, bbox: [Math.floor(Math.min(...xs)), Math.floor(Math.min(...ys)), Math.ceil(Math.max(...xs) - Math.min(...xs)), Math.ceil(Math.max(...ys) - Math.min(...ys))], provenance: { source: 'tee-shard-recovery', note: `teeRecovery support fit ${result.id}: every non-occluded visible component pixel contributes; discovery seed ${candidate.seedSource ?? 'UNKNOWN'}` } });
		}
		board.set('recoveredTees', [...existing, ...additions]);
		if (additions.length > 0 && measurement.rawPairs.length > 0) {
			const zfit = ctx.resolve(zfitFeature).knobs as unknown as ZfitKnobs;
			const scoring = ctx.resolve(g4ScoringFeature).knobs as unknown as ScoringKnobs;
			const search = ctx.resolve(g4SearchFeature).knobs as unknown as SearchKnobs;
			const ribbon = ctx.resolve(g5RibbonFeature).knobs as unknown as RibbonKnobs;
			const routing = ctx.resolve(g5RoutingFeature).knobs as unknown as RoutingKnobs;
			board.set('assignment', assignThreeFactor(measurement, [...existing, ...additions], zfit, scoring, search, ribbon, routing));
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
