import type { ViewTransformState } from './coords';

/** Geographic/image edge exposed by panning beyond the currently loaded raster. */
export type EdgeDirection = 'north' | 'east' | 'south' | 'west';

/**
 * Extra checkerboard that must be exposed beyond the normal fitted view before
 * a load-more affordance appears. The button itself is ~52px, so 72px keeps it
 * wholly inside unloaded space rather than over the image.
 */
export const EDGE_LOAD_REVEAL_PX = 72;

export interface EdgeLoadExposureInput {
	view: ViewTransformState;
	fitView: ViewTransformState;
	viewportWidthPx: number;
	viewportHeightPx: number;
	imageWidthPx: number;
	imageHeightPx: number;
	revealPx?: number;
}

/**
 * Returns only edges for which the user has exposed MORE blank space than the
 * fitted view already contained. This deliberately ignores ordinary
 * letterboxing: a square aerial in a wide pane should not show load controls
 * until the user actually pans toward an edge.
 *
 * This helper assumes the raster is north-up. ImagePane suppresses the controls
 * while manual target rotation is active, because screen-down is no longer
 * geographic south in that state.
 */
export function exposedLoadEdges(input: EdgeLoadExposureInput): EdgeDirection[] {
	const {
		view,
		fitView,
		viewportWidthPx,
		viewportHeightPx,
		imageWidthPx,
		imageHeightPx,
		revealPx = EDGE_LOAD_REVEAL_PX
	} = input;
	if (
		![
			viewportWidthPx,
			viewportHeightPx,
			imageWidthPx,
			imageHeightPx,
			revealPx,
			view.zoom,
			view.panX,
			view.panY,
			fitView.zoom,
			fitView.panX,
			fitView.panY
		].every(Number.isFinite) ||
		viewportWidthPx <= 0 ||
		viewportHeightPx <= 0 ||
		imageWidthPx <= 0 ||
		imageHeightPx <= 0 ||
		revealPx < 0
	) {
		return [];
	}

	const currentLeft = view.panX;
	const currentTop = view.panY;
	const currentRight = currentLeft + imageWidthPx * view.zoom;
	const currentBottom = currentTop + imageHeightPx * view.zoom;

	const fitLeft = fitView.panX;
	const fitTop = fitView.panY;
	const fitRight = fitLeft + imageWidthPx * fitView.zoom;
	const fitBottom = fitTop + imageHeightPx * fitView.zoom;

	// Express every edge as "extra blank pixels beyond the fit". The viewport
	// dimensions cancel algebraically for east/south, but retaining the explicit
	// blank-space form documents the screen-space meaning and catches bad sizes.
	const northExtra = currentTop - fitTop;
	const westExtra = currentLeft - fitLeft;
	const eastExtra =
		(viewportWidthPx - currentRight) - (viewportWidthPx - fitRight);
	const southExtra =
		(viewportHeightPx - currentBottom) - (viewportHeightPx - fitBottom);

	const result: EdgeDirection[] = [];
	if (northExtra >= revealPx) result.push('north');
	if (eastExtra >= revealPx) result.push('east');
	if (southExtra >= revealPx) result.push('south');
	if (westExtra >= revealPx) result.push('west');
	return result;
}
