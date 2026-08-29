// LAB scope — the pure vocabulary. NO node:* imports, ever.
//
// This is the half of scope that a browser, a CLI, and an HTTP server all
// share: what a scope REQUEST means, where it focuses, and whether it is
// valid. It performs no I/O, so it runs unchanged in a worker, in Node, or
// in a test.
//
// The node-bound half (reading a raster from a path, writing a PNG to a
// directory) lives in operation.ts and imports from here. Same split
// @chainspot/alg already uses for adapters/browser.ts vs adapters/node.ts.
//
// RULE: if you are about to add `from 'node:...'` to this file, you are
// putting a transport concern in the vocabulary. Put it in operation.ts.

import type { CanonicalTruth } from '@chainspot/alg/g0/truth';
import type { G0Report } from '../sweep/inputShim';
import type {
	PointTuple,
	Rect,
	ScopeCanonicalMeta,
	ScopeRequest,
	ScopeResolvedRequest
} from './types';

export function scopeSlug(value: string): string {
	return value.trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'scope';
}

export function scopeBounds(points: readonly PointTuple[], pad = 0): Rect {
	const xs = points.map((point) => point[0]);
	const ys = points.map((point) => point[1]);
	const x0 = Math.min(...xs);
	const x1 = Math.max(...xs);
	const y0 = Math.min(...ys);
	const y1 = Math.max(...ys);
	return {
		x: x0 - pad,
		y: y0 - pad,
		w: Math.max(1, x1 - x0 + pad * 2),
		h: Math.max(1, y1 - y0 + pad * 2)
	};
}

export function scopeCanonicalMeta(report: G0Report): ScopeCanonicalMeta {
	return {
		imageId: report.imageId,
		widthPx: report.widthPx,
		heightPx: report.heightPx,
		stripChrome: report.stripChrome,
		alreadyCanonicalInput: report.alreadyCanonicalInput,
		autoStitch: {
			sourceCount: report.autoStitch.sourceCount,
			hadFallback: report.autoStitch.hadFallback
		}
	};
}

export function resolveScopeRequest(
	request: ScopeRequest,
	truth: CanonicalTruth | undefined,
	width: number,
	height: number
): ScopeResolvedRequest {
	const template = request.full ? 'full' : request.template ?? 'default';
	const color = request.color ?? 0;
	const common = { template, color, view: request.view, richOverlay: request.richOverlay };
	if (request.full) {
		return {
			...common,
			name: request.name ?? 'full',
			kind: 'full',
			focus: { x: 0, y: 0, w: width, h: height },
			points: [],
			richOverlay: false
		};
	}
	if (request.point) {
		return {
			...common,
			name: request.name ?? `point-${Math.round(request.point[0])}-${Math.round(request.point[1])}`,
			kind: 'point',
			focus: { x: request.point[0], y: request.point[1], w: 1, h: 1 },
			points: [request.point]
		};
	}
	if (request.box) {
		return {
			...common,
			name: request.name ?? `box-${request.box.map((n) => Math.round(n)).join('-')}`,
			kind: 'box',
			focus: { x: request.box[0], y: request.box[1], w: request.box[2], h: request.box[3] },
			points: []
		};
	}
	if (request.mark) {
		return {
			...common,
			name: request.name ?? 'mark',
			kind: 'mark',
			focus: { x: request.mark[0], y: request.mark[1], w: 1, h: 1 },
			points: [request.mark]
		};
	}
	if (request.dots) {
		if (request.dots.length < 2) throw new Error('lab scope: dots requires at least two points.');
		return { ...common, name: request.name ?? 'dots', kind: 'dots', focus: scopeBounds(request.dots), points: request.dots };
	}
	if (request.path) {
		if (request.path.length < 1) throw new Error('lab scope: path requires at least one point.');
		if (request.pointLabels && request.pointLabels.length !== request.path.length) {
			throw new Error('lab scope: path pointLabels must match path point count.');
		}
		return {
			...common,
			name: request.name ?? 'path',
			kind: 'path',
			focus: scopeBounds(request.path),
			points: request.path,
			pointLabels: request.pointLabels
		};
	}
	if (request.hole !== undefined) {
		if (!truth) throw new Error(`lab scope: hole ${request.hole} requires annotation; BLIND mode will not derive truth.`);
		const hole = truth.holes.find((candidate) => candidate.number === request.hole);
		if (!hole) throw new Error(`lab scope: annotation has no hole ${request.hole}.`);
		const points: PointTuple[] = [
			[hole.tee.xPx, hole.tee.yPx],
			...hole.corridorBends.map((point) => [point.xPx, point.yPx] as PointTuple),
			[hole.basket.xPx, hole.basket.yPx]
		];
		const pad = Math.max(0, hole.corridorWidthPx / 2);
		return {
			...common,
			name: request.name ?? `hole-${request.hole}`,
			kind: 'hole',
			focus: scopeBounds(points, pad),
			points,
			hole: request.hole
		};
	}
	throw new Error('lab scope: empty request.');
}

export function validateScopeRequest(request: ScopeResolvedRequest, width: number, height: number): void {
	const inside = ([x, y]: PointTuple) => x >= 0 && y >= 0 && x < width && y < height;
	for (const point of request.points) {
		if (!inside(point)) throw new Error(`lab scope: canonical point ${point[0]},${point[1]} is outside ${width}x${height}.`);
	}
	if (request.kind === 'box') {
		const rect = request.focus;
		if (rect.x < 0 || rect.y < 0 || rect.x + rect.w > width || rect.y + rect.h > height) {
			throw new Error(`lab scope: canonical box exceeds ${width}x${height}.`);
		}
	}
}
