import type { PointDrawable, PolylineDrawable } from './types';

export type TeePoseCorner = readonly [number, number];

export interface TeePoseDecoration {
	readonly cornerTicks: readonly PointDrawable[];
	readonly diagonals: readonly PolylineDrawable[];
}

/**
 * Build the one presentation contract shared by visible and shard-recovered
 * tees. The four coordinates are detector-emitted testimony; this helper only
 * joins them and carries their already-established pose into the renderer.
 */
export function teePoseDecoration(
	corners: readonly TeePoseCorner[],
	ref: string,
	source: string
): TeePoseDecoration {
	if (
		corners.length !== 4 ||
		corners.some(([x, y]) => !Number.isFinite(x) || !Number.isFinite(y))
	) {
		return { cornerTicks: [], diagonals: [] };
	}
	const axisAngleRad = Math.atan2(corners[1][1] - corners[0][1], corners[1][0] - corners[0][0]);
	const centerXPx = corners.reduce((sum, [x]) => sum + x, 0) / 4;
	const centerYPx = corners.reduce((sum, [, y]) => sum + y, 0) / 4;
	const commonValues = { teeAxisAngleRad: axisAngleRad, centerXPx, centerYPx };
	return {
		cornerTicks: corners.map(([xPx, yPx], cornerIndex) => ({
			type: 'point',
			xPx,
			yPx,
			verdict: 'info',
			visualRole: 'tee-corner-tick',
			ref: `${ref}:tee-corner-tick-${cornerIndex}`,
			reason: `${source}; corner ${cornerIndex + 1} of 4`,
			values: { ...commonValues, cornerIndex }
		})),
		diagonals: [
			{
				type: 'polyline',
				path: [corners[0], corners[2]],
				verdict: 'info',
				visualRole: 'tee-diagonal',
				ref: `${ref}:tee-diagonal-0`,
				reason: `${source}; opposite-corner diagonal whose intersection is the fitted center`,
				values: { ...commonValues, diagonalIndex: 0 }
			},
			{
				type: 'polyline',
				path: [corners[1], corners[3]],
				verdict: 'info',
				visualRole: 'tee-diagonal',
				ref: `${ref}:tee-diagonal-1`,
				reason: `${source}; opposite-corner diagonal whose intersection is the fitted center`,
				values: { ...commonValues, diagonalIndex: 1 }
			}
		]
	};
}
