/**
 * ChainSpot coordinate and view-transform mathematics.
 *
 * Coordinate spaces (detailed plan section 9):
 * - Original image space: pixels of the original raster. `xPx in [0, width)` and
 *   `yPx in [0, height)`. Authoritative for every annotation and independent of pan,
 *   zoom, fit, window resize, and device pixel ratio.
 * - Normalized space: `xNorm = xPx / width`, `yNorm = yPx / height`, derived from the
 *   original pixels and intrinsic dimensions; pixels remain authoritative.
 * - View/screen space: CSS pixels inside a pane. `screen = image * zoom + translation`.
 *   The `ViewTransformState` shape (zoom, panX, panY) is the same plain serializable
 *   shape used for optional persisted view state; it is display state only.
 *
 * Boundary: every pointer or canvas event must be inverted through `screenToImage`
 * before any domain update. Konva node coordinates, canvas backing-store pixels, and
 * CSS bounding rectangles are view-space values and never authoritative. Device pixel
 * ratio never participates in these conversions: screen space is CSS pixels, and the
 * high-DPI backing store is a rendering concern only.
 *
 * Round-trip guarantee: `screenToImage(imageToScreen(p, t), t)` returns `p` within
 * `ROUND_TRIP_TOLERANCE` original-image pixels for the supported scale range.
 */

import type { ViewTransformState } from './domain/project';

export type { ViewTransformState };

/** Image-space round-trip tolerance in original-image pixels. */
export const ROUND_TRIP_TOLERANCE = 1e-9;

/** Tolerance for comparing serialized normalized values against pixel-derived values. */
export const NORMALIZED_TOLERANCE = 1e-9;

/**
 * Policy epsilon used by clamping so clamped values remain inside the half-open
 * bounds `[0, width) x [0, height)` at every edge.
 */
export const BOUNDS_EPSILON = 1e-9;

export interface ScreenSpacePoint {
	x: number;
	y: number;
}

export interface ImageSpacePoint {
	xPx: number;
	yPx: number;
}

export interface NormalizedPoint {
	xNorm: number;
	yNorm: number;
}

export interface PixelAndNormalizedPoint {
	xPx: number;
	yPx: number;
	xNorm: number;
	yNorm: number;
}

function assertPositiveDimensions(width: number, height: number, context: string): void {
	if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
		throw new Error(
			`${context}: width and height must be positive finite numbers, got width=${width}, height=${height}`
		);
	}
}

function assertValidTransform(transform: ViewTransformState, context: string): void {
	if (
		!Number.isFinite(transform.zoom) ||
		transform.zoom <= 0 ||
		!Number.isFinite(transform.panX) ||
		!Number.isFinite(transform.panY)
	) {
		throw new Error(
			`${context}: zoom must be a positive finite number and panX/panY must be finite, got ${JSON.stringify(transform)}`
		);
	}
}

export function identityViewTransform(): ViewTransformState {
	return { zoom: 1, panX: 0, panY: 0 };
}

export function imageToScreen(
	point: ImageSpacePoint,
	transform: ViewTransformState
): ScreenSpacePoint {
	assertValidTransform(transform, 'imageToScreen');
	return {
		x: point.xPx * transform.zoom + transform.panX,
		y: point.yPx * transform.zoom + transform.panY
	};
}

export function screenToImage(
	point: ScreenSpacePoint,
	transform: ViewTransformState
): ImageSpacePoint {
	assertValidTransform(transform, 'screenToImage');
	return {
		xPx: (point.x - transform.panX) / transform.zoom,
		yPx: (point.y - transform.panY) / transform.zoom
	};
}

export function toNormalizedCoordinates(
	point: ImageSpacePoint,
	width: number,
	height: number
): NormalizedPoint {
	assertPositiveDimensions(width, height, 'toNormalizedCoordinates');
	return {
		xNorm: point.xPx / width,
		yNorm: point.yPx / height
	};
}

/**
 * Verifies that stored normalized values match the values derived from the
 * authoritative pixel coordinates and intrinsic dimensions. Pixels win: a caller
 * observing an inconsistent result must recompute normalized values from pixels
 * rather than trust the stored ones.
 */
export function normalizedConsistentWithPixels(
	point: PixelAndNormalizedPoint,
	width: number,
	height: number,
	tolerance: number = NORMALIZED_TOLERANCE
): boolean {
	if (!Number.isFinite(tolerance) || tolerance < 0) {
		throw new Error(
			`normalizedConsistentWithPixels: tolerance must be a finite non-negative number, got ${tolerance}`
		);
	}
	const expected = toNormalizedCoordinates({ xPx: point.xPx, yPx: point.yPx }, width, height);
	return (
		Math.abs(expected.xNorm - point.xNorm) <= tolerance &&
		Math.abs(expected.yNorm - point.yNorm) <= tolerance
	);
}

export function pointInBounds(point: ImageSpacePoint, width: number, height: number): boolean {
	assertPositiveDimensions(width, height, 'pointInBounds');
	if (!Number.isFinite(point.xPx) || !Number.isFinite(point.yPx)) {
		return false;
	}
	return point.xPx >= 0 && point.xPx < width && point.yPx >= 0 && point.yPx < height;
}

export function clampPointToImageBounds(
	point: ImageSpacePoint,
	width: number,
	height: number
): ImageSpacePoint {
	assertPositiveDimensions(width, height, 'clampPointToImageBounds');
	if (!Number.isFinite(point.xPx) || !Number.isFinite(point.yPx)) {
		throw new Error(
			`clampPointToImageBounds: point coordinates must be finite, got xPx=${point.xPx}, yPx=${point.yPx}`
		);
	}
	return {
		xPx: Math.min(Math.max(point.xPx, 0), width - BOUNDS_EPSILON),
		yPx: Math.min(Math.max(point.yPx, 0), height - BOUNDS_EPSILON)
	};
}

/**
 * Deterministic fit transform: the largest zoom that shows the entire image inside the
 * pane without changing its aspect ratio, centered in both axes. Returns the same
 * result for the same image and pane dimensions.
 */
export function fitViewTransform(
	imageWidth: number,
	imageHeight: number,
	paneWidth: number,
	paneHeight: number
): ViewTransformState {
	assertPositiveDimensions(imageWidth, imageHeight, 'fitViewTransform');
	assertPositiveDimensions(paneWidth, paneHeight, 'fitViewTransform');
	const zoom = Math.min(paneWidth / imageWidth, paneHeight / imageHeight);
	return {
		zoom,
		panX: (paneWidth - imageWidth * zoom) / 2,
		panY: (paneHeight - imageHeight * zoom) / 2
	};
}
