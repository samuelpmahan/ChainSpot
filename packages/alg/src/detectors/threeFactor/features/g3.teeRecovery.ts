// G4 tee-shard recovery. The detector starts from an assignment-missing
// numbered badge and its assigned predecessor basket, then searches only a
// bounded white-component graph for an unowned remainder/extension.

import type { BadgeEvidence, BasketEvidence, RecoveredTeeInput, TeeEvidence, OrientedQuad, ThreeFactorAssignment } from '../types';
import { extractComponents, type ComponentStats } from '../components';
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

/** A compact boundary walk for receipt-only shard highlighting. Keeping the
 * trace drawable as one accepted semantic object preserves candidate counts;
 * unlike row-sorting raw pixels it cannot zig-zag through the component. */
function shardContour(points: readonly (readonly [number, number])[]): readonly (readonly [number, number])[] {
	if (points.length <= 2) return points;
	const occupied = new Set(points.map(([x, y]) => `${x},${y}`));
	const boundary = points.filter(([x, y]) =>
		[[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => !occupied.has(`${x + dx},${y + dy}`))
	);
	const source = boundary.length >= 2 ? boundary : points;
	const cx = source.reduce((sum, [x]) => sum + x, 0) / source.length;
	const cy = source.reduce((sum, [, y]) => sum + y, 0) / source.length;
	const ordered = source.slice().sort(([ax, ay], [bx, by]) =>
		Math.atan2(ay - cy, ax - cx) - Math.atan2(by - cy, bx - cx) ||
		Math.hypot(ax - cx, ay - cy) - Math.hypot(bx - cx, by - cy) || ay - by || ax - bx
	);
	return [...ordered, ordered[0]!];
}

export const teeRecoveryFeature = {
	id: 'teeRecovery',
	gate: 'G4',
	kind: 'deviation',
	defaultEnabled: false,
	note: 'Recover assignment-missing tees from bounded predecessor-basket white-component anomalies; phantom completion remains terminal.',
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

function bboxAsOpaque(bbox: readonly [number, number, number, number]) {
	return { x0: bbox[0], y0: bbox[1], x1: bbox[0] + bbox[2] - 1, y1: bbox[1] + bbox[3] - 1 };
}

function bboxDistance(x: number, y: number, box: ReturnType<typeof bboxAsOpaque>): number {
	return Math.hypot(Math.max(box.x0 - x, 0, x - box.x1), Math.max(box.y0 - y, 0, y - box.y1));
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


interface RecoveryCluster {
	readonly labels: readonly number[];
	readonly pixels: readonly [number, number][];
	readonly area: number;
	readonly cx: number;
	readonly cy: number;
	readonly bboxW: number;
	readonly bboxH: number;
}

/** Bounded BFS over white-mask components, with a one-pixel gap bridge. */
function boundedComponentGraph(labels: Int32Array, width: number, components: readonly ComponentStats[]): readonly RecoveryCluster[] {
	const entries = components.map((component) => {
		const pixels: [number, number][] = [];
		for (let y = component.bboxY; y < component.bboxY + component.bboxH; y++) for (let x = component.bboxX; x < component.bboxX + component.bboxW; x++) if (labels[y * width + x] === component.label) pixels.push([x, y]);
		return { component, pixels };
	});
	const gap = (a: ComponentStats, b: ComponentStats) => {
		const ax = a.bboxX + a.bboxW - 1, ay = a.bboxY + a.bboxH - 1;
		const bx = b.bboxX + b.bboxW - 1, by = b.bboxY + b.bboxH - 1;
		return Math.hypot(Math.max(a.bboxX - bx - 1, b.bboxX - ax - 1, 0), Math.max(a.bboxY - by - 1, b.bboxY - ay - 1, 0));
	};
	const seen = new Set<number>(), out: RecoveryCluster[] = [];
	for (let start = 0; start < entries.length; start++) {
		if (seen.has(start)) continue;
		const queue = [start], members: number[] = [];
		seen.add(start);
		while (queue.length) {
			const index = queue.shift()!;
			members.push(index);
			for (let next = 0; next < entries.length; next++) if (!seen.has(next) && gap(entries[index]!.component, entries[next]!.component) <= 1) { seen.add(next); queue.push(next); }
		}
		const pixels = members.flatMap((index) => entries[index]!.pixels);
		const xs = pixels.map(([x]) => x), ys = pixels.map(([, y]) => y);
		out.push({ labels: members.map((index) => entries[index]!.component.label).sort((a, b) => a - b), pixels, area: pixels.length, cx: pixels.reduce((sum, [x]) => sum + x, 0) / Math.max(1, pixels.length), cy: pixels.reduce((sum, [, y]) => sum + y, 0) / Math.max(1, pixels.length), bboxW: Math.max(...xs) - Math.min(...xs) + 1, bboxH: Math.max(...ys) - Math.min(...ys) + 1 });
	}
	return out;
}

function graphCandidateResult(candidate: TeeRecoveryCandidate): TeeRecoveryResult {
	const support = candidate.fragmentPixels.length;
	const componentCount = candidate.supportingComponentIds.length;
	const axisError = badgeAxisError(candidate);
	const axisRejected = candidate.badgeLabel !== null && candidate.badgeLabel !== undefined && /^\d+$/.test(candidate.badgeLabel) && (axisError ?? Infinity) >= 3 * Math.PI / 180;
	const accepted = support >= 8 && componentCount <= 2 && !axisRejected;
	const reason = accepted
		? `accepted unowned white remainder from predecessor-basket BFS; seed ${candidate.seedSource ?? 'UNKNOWN'}`
		: axisRejected
			? `badge-axis angular error ${(axisError! * 180 / Math.PI).toFixed(3)}° >= 3°`
			: support < 8 ? `white-component support ${support} < 8` : `supporting components ${componentCount} > 2`;
	return {
		id: candidate.id,
		verdict: accepted ? 'accepted' : 'rejected',
		reason,
		values: {
			supportingPixels: support,
			supportingComponents: componentCount,
			coordinateFrame: 'original-image',
			...(axisError === undefined ? {} : { badgeAxisAlignment: Math.cos(axisError), badgeAxisErrorRad: axisError })
		},
		corners: cornersFor(candidate, {})
	};
}

/**
 * Produce hypotheses from a tiny component graph rooted at B(n-1).  There is
 * no global pose/template search: each missing badge contributes one bounded
 * window, components are joined only while touching that window, and one
 * edge fit is derived from the anomaly axis.
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
		const owned = exactKnownPixels(stage, badges, tees, target.basket, search.sprites, viewportTopPx, [minX, minY, maxX, maxY]);
		const bounded = new Uint8Array((maxX - minX + 1) * (maxY - minY + 1));
		for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
			const opaque = search.occlusion?.kindAt(x, y + viewportTopPx) === 'OPAQUE';
			if (stage.brightMask.data[y * stage.width + x] && !owned.has(`${x},${y}`) && !opaque) bounded[(y - minY) * (maxX - minX + 1) + x - minX] = 1;
		}
		const local = extractComponents({ width: maxX - minX + 1, height: maxY - minY + 1, data: bounded });
		for (const cluster of boundedComponentGraph(local.labels, maxX - minX + 1, local.components)) {
			if (cluster.area < 8 || cluster.area > 300 || cluster.bboxW > 34 || cluster.bboxH > 34) continue;
			const pixels: [number, number][] = cluster.pixels.map(([x, y]) => [x + minX, y + minY]);
			if (pixels.length < 8 || !pixels.some(([x, y]) => bboxDistance(x, y + viewportTopPx, bboxAsOpaque(target.basket.bbox)) <= 3)) continue;
			// The numbered-badge ray gives the inferred tee major axis after an
			// anomaly is discovered. Component shape is support evidence only,
			// never a global pose/template search.
			const angleRad = search.assignment
				? Math.atan2(target.badge.cyPx - (anchorY + viewportTopPx), target.badge.cxPx - anchorX)
				: (finite(pads[0]?.angleRad ?? NaN) ? (pads[0]?.angleRad as number) : 0);
			const c = Math.cos(angleRad), s = Math.sin(angleRad);
			const dx = cluster.cx - anchorX;
			const dy = cluster.cy - anchorY;
			const u = dx * c + dy * s;
			const v = -dx * s + dy * c;
			const edgeU = Math.abs(halfWidth - Math.abs(u)) <= Math.abs(halfHeight - Math.abs(v)) ? Math.sign(u || 1) * halfWidth : 0;
			const edgeV = edgeU === 0 ? Math.sign(v || 1) * halfHeight : 0;
			let centerX = cluster.cx - edgeU * c + edgeV * s;
			let centerY = cluster.cy - edgeU * s - edgeV * c;
			// Keep the tangent coordinate in the predecessor-rooted local span.
			// This is the bounded graph's single fit, and prevents a long vertical
			// shard from moving the inferred tee away from the predecessor basket.
			const tangent = -(centerX - anchorX) * s + (centerY - anchorY) * c;
			const tangentClamped = Math.max(-halfHeight, Math.min(halfHeight, tangent));
			const tangentDelta = tangentClamped - tangent;
			centerX -= s * tangentDelta;
			centerY += c * tangentDelta;
			const probe: TeeRecoveryCandidate = { id: `tee-shard-${target.badge.detId}-${cluster.labels.join('-')}`, fit: { centerXPx: centerX, centerYPx: centerY, halfWidthPx: halfWidth, halfHeightPx: halfHeight, angleRad }, fragmentPixels: pixels, supportingComponentIds: cluster.labels.map(String), viewportTopPx, seedSource: target.basket.detId, bfsComponentsVisited: local.components.length };
			const teeToBadgeAngleRad = Math.atan2(target.badge.cyPx - (centerY + viewportTopPx), target.badge.cxPx - centerX);
			const badgeAxisAngleRad = angleRad;
			candidates.push({ ...probe, supportingComponentIds: cluster.labels.map(String), badgeAxisAngleRad, teeToBadgeAngleRad, badgeId: target.badge.detId, badgeLabel: target.badge.label });
		}
	}
	return { candidates };
}

export const teeRecoveryUnit: EngineUnit = {
	id: 'teeRecovery',
	gate: 'G4',
	consumes: ['stage', 'badges', 'baskets', 'tees', 'sprites', 'viewport', 'recoveredTees', 'assignment', 'measurement'],
	produces: ['recoveredTees', 'assignment'],
	note: 'visible tee-shard recovery from predecessor-basket white-component graphs with exact opaque sprite ownership',
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
		// The bounded component graph is internal evidence. Keep one deterministic
		// promoted verdict per source fragment, so trace/CLI/render stay inspectable.
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
			const shardPath = shardContour(candidate.fragmentPixels).map((point) => localPoint(candidate, point, {}));
			if (result.verdict === 'accepted') ctx.overlay('teeRecovery', { type: 'polyline', path: shardPath, verdict: 'accepted', visualRole: 'tee-shard', ref: `${result.id}:tee-shard`, reason: result.reason, values: numericTraceValues(result.values) });
			else ctx.overlay('teeRecovery', { type: 'point', xPx: centerX, yPx: centerY, verdict: 'rejected', visualRole: 'tee-rejection', ref: result.id, reason: result.reason, values: numericTraceValues(result.values) });
			if (result.verdict !== 'accepted') continue;
			for (const [index, corner] of result.corners.entries()) ctx.overlay('teeRecovery', { type: 'point', xPx: corner[0], yPx: corner[1], verdict: 'info', visualRole: 'tee-corner-tick', ref: `${result.id}:tee-corner-tick-${index}`, reason: 'calculated tee recovery corner' });
			const xs = result.corners.map((point) => point[0]);
			const ys = result.corners.map((point) => point[1]);
			additions.push({ xPx: centerX, yPx: centerY, bbox: [Math.floor(Math.min(...xs)), Math.floor(Math.min(...ys)), Math.ceil(Math.max(...xs) - Math.min(...xs)), Math.ceil(Math.max(...ys) - Math.min(...ys))], provenance: { source: 'tee-shard-recovery', note: `teeRecovery graph fit ${result.id}: unowned visible shard from ${candidate.seedSource ?? 'UNKNOWN'}; appearance UNKNOWN` } });
		}
		board.set('recoveredTees', [...existing, ...additions]);
		if (additions.length > 0) {
			const zfit = ctx.resolve(zfitFeature).knobs as unknown as ZfitKnobs;
			const scoring = ctx.resolve(g4ScoringFeature).knobs as unknown as ScoringKnobs;
			const search = ctx.resolve(g4SearchFeature).knobs as unknown as SearchKnobs;
			const ribbon = ctx.resolve(g5RibbonFeature).knobs as unknown as RibbonKnobs;
			const routing = ctx.resolve(g5RoutingFeature).knobs as unknown as RoutingKnobs;
			board.set('assignment', assignThreeFactor(measurement, [...existing, ...additions], zfit, scoring, search, ribbon, routing));
		} else board.set('assignment', assignment);
		ctx.measure('teeRecovery', 'candidates', allResults.length);
		ctx.measure('teeRecovery', 'accepted', additions.length);
		ctx.measure('teeRecovery', 'promoted', results.length);
		stop();
	}
};
