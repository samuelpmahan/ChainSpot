import type { CanonicalTruth } from '@chainspot/alg/g0/truth';
import { polarOffset, TRAVERSE_DIRECTIONS } from '../scope/render';
import type { PointTuple } from '../scope/types';
import {
	trailByName,
	traversalByName,
	visibleTrailPoints,
	type SearchState
} from '../search/searchState';

export const DEFAULT_TRAVERSE_RADIUS = 75;

export function traversalCurrentPoint(state: SearchState, name: string): PointTuple {
	const traversal = traversalByName(state, name);
	const trail = trailByName(state, traversal.trailName);
	const point = visibleTrailPoints(trail).at(-1);
	if (!point) throw new Error(`lab traverse: '${name}' has no visible position.`);
	return point.point;
}

export function assertTraverseInside(point: PointTuple, width: number, height: number): void {
	if (point[0] < 0 || point[1] < 0 || point[0] >= width || point[1] >= height) {
		throw new Error(`lab traverse: target ${point[0].toFixed(1)},${point[1].toFixed(1)} leaves canonical raster ${width}x${height}.`);
	}
}

export function traverseAnchorPoint(anchor: string, truth: CanonicalTruth | undefined): PointTuple {
	const match = /^([TNB])(\d+)$/i.exec(anchor);
	if (!match) throw new Error(`lab traverse: --start must be Tn, Nn, or Bn; got '${anchor}'.`);
	const kind = match[1].toUpperCase();
	const number = Number(match[2]);
	const hole = truth?.holes.find((candidate) => candidate.number === number);
	if (!hole) throw new Error(`lab traverse: annotation has no hole ${number}.`);
	if (kind === 'T') return [hole.tee.xPx, hole.tee.yPx];
	if (kind === 'B') return [hole.basket.xPx, hole.basket.yPx];
	const badge = hole.numberBadge ?? hole.badge;
	if (!badge) {
		throw new Error(`lab traverse: annotation hole ${number} has no explicit Number/Badge anchor. N${number} will not be guessed; use T${number}, B${number}, or x,y.`);
	}
	return [badge.xPx, badge.yPx];
}

export type TraverseMove =
	| { readonly kind: 'hex'; readonly neighbor: number }
	| { readonly kind: 'xy'; readonly dx: number; readonly dy: number }
	| { readonly kind: 'polar'; readonly distance: number; readonly angleDeg: number }
	| { readonly kind: 'absolute'; readonly point: PointTuple };

export interface TraverseTarget {
	readonly point: PointTuple;
	readonly detail: string;
}

export function traverseTarget(current: PointTuple, radiusPx: number, move: TraverseMove): TraverseTarget {
	if (move.kind === 'absolute') {
		return { point: move.point, detail: `xy ${move.point[0] - current[0]},${move.point[1] - current[1]}` };
	}
	if (move.kind === 'xy') {
		return { point: [current[0] + move.dx, current[1] + move.dy], detail: `xy ${move.dx},${move.dy}` };
	}
	if (move.kind === 'polar') {
		if (!Number.isFinite(move.distance) || move.distance <= 0) throw new Error('lab traverse: polar distance must be positive.');
		const offset = polarOffset(move.distance, move.angleDeg);
		return {
			point: [current[0] + offset[0], current[1] + offset[1]],
			detail: `polar ${move.distance},${move.angleDeg}`
		};
	}
	const direction = TRAVERSE_DIRECTIONS.find((candidate) => candidate.n === move.neighbor);
	if (!direction) throw new Error('lab traverse: neighbor must be 1..6.');
	const offset = polarOffset(radiusPx, direction.angleDeg);
	return {
		point: [current[0] + offset[0], current[1] + offset[1]],
		detail: `hex ${move.neighbor} ${direction.angleDeg}deg r=${radiusPx}`
	};
}

export function traversalNeighbors(current: PointTuple, radiusPx: number): readonly { n: number; angleDeg: number; point: PointTuple }[] {
	return TRAVERSE_DIRECTIONS.map((direction) => {
		const offset = polarOffset(radiusPx, direction.angleDeg);
		return {
			n: direction.n,
			angleDeg: direction.angleDeg,
			point: [current[0] + offset[0], current[1] + offset[1]] as PointTuple
		};
	});
}
