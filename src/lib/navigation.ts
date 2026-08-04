/**
 * ChainSpot pane navigation mathematics (P0-006).
 *
 * Pure view-navigation functions for one pane. Screen space is CSS pixels inside the
 * pane (the Konva stage coordinate space); device pixel ratio never participates.
 * The plain `ViewTransformState` (zoom, panX, panY) is the authoritative transient
 * view state; Konva rendering is an adapter applied elsewhere.
 *
 * Wheel rule (deterministic): `wheelZoomFactor(deltaY) = 2^(-deltaY / 200)`.
 * Chromium mouse-wheel notches report deltaY = 100, so one notch zooms by 2^(-1/2)
 * and two notches by 2^(-1). Trackpad scroll and trackpad pinch (Chromium ctrl+wheel)
 * report proportional deltaY values and follow the same rule.
 *
 * Zoom limits: interactive zoom is clamped to pane-specific limits derived from the
 * current fit zoom so the default fit is always reachable:
 * `min = min(0.01, fitZoom / 16)` and `max = max(64, fitZoom * 16)`.
 *
 * Fit is never clamped: `defaultFitTransform` is exactly `fitViewTransform`, so Fit
 * always shows the complete image regardless of image or pane size.
 *
 * Resize policy: if the current transform is the default fit for the previous pane
 * size, recompute the default fit for the new pane size. Otherwise retain zoom and
 * keep the image-space point that was under the previous pane center under the new
 * pane center.
 */

import { fitViewTransform, screenToImage } from './coords';
import type { ScreenSpacePoint, ViewTransformState } from './coords';

export type { ScreenSpacePoint, ViewTransformState };

/** Absolute floor for interactive zoom when the derived minimum would exceed it. */
export const ABSOLUTE_MIN_VIEW_ZOOM = 0.01;

/** Absolute ceiling for interactive zoom when the derived maximum would exceed it. */
export const ABSOLUTE_MAX_VIEW_ZOOM = 64;

/** Fit-zoom factor used to widen the absolute limits so fit is always allowed. */
export const ZOOM_LIMIT_FIT_RATIO = 16;

/** Wheel deltaY units that halve/double the zoom (see `wheelZoomFactor`). */
export const WHEEL_ZOOM_STEP_DELTA = 200;

export interface ViewZoomLimits {
	min: number;
	max: number;
}

export const DEFAULT_VIEW_ZOOM_LIMITS: ViewZoomLimits = {
	min: ABSOLUTE_MIN_VIEW_ZOOM,
	max: ABSOLUTE_MAX_VIEW_ZOOM
};

function assertPositiveFinite(value: number, context: string, name: string): void {
	if (!Number.isFinite(value) || value <= 0) {
		throw new Error(`${context}: ${name} must be a positive finite number, got ${value}`);
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

function assertFinitePoint(point: ScreenSpacePoint, context: string): void {
	if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
		throw new Error(
			`${context}: pointer coordinates must be finite, got ${JSON.stringify(point)}`
		);
	}
}

/**
 * Deterministic wheel-to-zoom factor: each `WHEEL_ZOOM_STEP_DELTA` deltaY units
 * doubles (negative deltaY) or halves (positive deltaY) the zoom.
 */
export function wheelZoomFactor(deltaY: number): number {
	if (!Number.isFinite(deltaY)) {
		throw new Error(`wheelZoomFactor: deltaY must be finite, got ${deltaY}`);
	}
	return Math.pow(2, -deltaY / WHEEL_ZOOM_STEP_DELTA);
}

/**
 * Pane-specific interactive zoom limits that always include the current fit zoom:
 * `min = min(0.01, fitZoom / 16)`, `max = max(64, fitZoom * 16)`.
 */
export function zoomLimitsForFit(fitZoom: number): ViewZoomLimits {
	assertPositiveFinite(fitZoom, 'zoomLimitsForFit', 'fitZoom');
	return {
		min: Math.min(ABSOLUTE_MIN_VIEW_ZOOM, fitZoom / ZOOM_LIMIT_FIT_RATIO),
		max: Math.max(ABSOLUTE_MAX_VIEW_ZOOM, fitZoom * ZOOM_LIMIT_FIT_RATIO)
	};
}

/** Clamps a zoom value into the supplied interactive limits. */
export function clampViewZoom(zoom: number, limits: ViewZoomLimits): number {
	if (!Number.isFinite(zoom) || zoom <= 0) {
		throw new Error(`clampViewZoom: zoom must be a positive finite number, got ${zoom}`);
	}
	if (
		!Number.isFinite(limits.min) ||
		!Number.isFinite(limits.max) ||
		limits.min <= 0 ||
		limits.max <= 0 ||
		limits.min > limits.max
	) {
		throw new Error(`clampViewZoom: invalid limits ${JSON.stringify(limits)}`);
	}
	return Math.min(Math.max(zoom, limits.min), limits.max);
}

/**
 * Pointer-centered zoom. The image-space location under `pointer` is preserved
 * (within the coordinate round-trip tolerance), including when the zoom clamps.
 */
export function zoomAtPointer(
	transform: ViewTransformState,
	pointer: ScreenSpacePoint,
	zoomFactor: number,
	limits: ViewZoomLimits = DEFAULT_VIEW_ZOOM_LIMITS
): ViewTransformState {
	assertValidTransform(transform, 'zoomAtPointer');
	assertFinitePoint(pointer, 'zoomAtPointer');
	if (!Number.isFinite(zoomFactor) || zoomFactor <= 0) {
		throw new Error(`zoomAtPointer: zoomFactor must be a positive finite number, got ${zoomFactor}`);
	}
	const nextZoom = clampViewZoom(transform.zoom * zoomFactor, limits);
	const k = nextZoom / transform.zoom;
	return {
		zoom: nextZoom,
		panX: pointer.x - (pointer.x - transform.panX) * k,
		panY: pointer.y - (pointer.y - transform.panY) * k
	};
}

/** Applies a pan delta in CSS-pixel screen space, retaining zoom. */
export function panBy(
	transform: ViewTransformState,
	deltaX: number,
	deltaY: number
): ViewTransformState {
	assertValidTransform(transform, 'panBy');
	if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) {
		throw new Error(
			`panBy: deltaX/deltaY must be finite, got deltaX=${deltaX}, deltaY=${deltaY}`
		);
	}
	return {
		zoom: transform.zoom,
		panX: transform.panX + deltaX,
		panY: transform.panY + deltaY
	};
}

/**
 * The documented default fit for a pane: exactly `fitViewTransform`, never clamped,
 * so the complete image is always displayed, centered, aspect preserved. Fit, Reset,
 * initial load, and image replacement all use this.
 */
export function defaultFitTransform(
	imageWidth: number,
	imageHeight: number,
	paneWidth: number,
	paneHeight: number
): ViewTransformState {
	return fitViewTransform(imageWidth, imageHeight, paneWidth, paneHeight);
}

function transformsNearlyEqual(a: ViewTransformState, b: ViewTransformState): boolean {
	const epsilon = 1e-9;
	return (
		Math.abs(a.zoom - b.zoom) <= epsilon &&
		Math.abs(a.panX - b.panX) <= epsilon &&
		Math.abs(a.panY - b.panY) <= epsilon
	);
}

/**
 * Explicit pane-resize policy. At the default fit for the previous pane size, the
 * default fit for the new pane size is used. From a custom view, zoom is retained
 * and the image-space point under the previous pane center is placed under the new
 * pane center. Original-image coordinates are never changed by this function.
 */
export function resizeViewTransform(
	transform: ViewTransformState,
	imageWidth: number,
	imageHeight: number,
	oldPaneWidth: number,
	oldPaneHeight: number,
	newPaneWidth: number,
	newPaneHeight: number
): ViewTransformState {
	assertValidTransform(transform, 'resizeViewTransform');
	assertPositiveFinite(imageWidth, 'resizeViewTransform', 'imageWidth');
	assertPositiveFinite(imageHeight, 'resizeViewTransform', 'imageHeight');
	assertPositiveFinite(oldPaneWidth, 'resizeViewTransform', 'oldPaneWidth');
	assertPositiveFinite(oldPaneHeight, 'resizeViewTransform', 'oldPaneHeight');
	assertPositiveFinite(newPaneWidth, 'resizeViewTransform', 'newPaneWidth');
	assertPositiveFinite(newPaneHeight, 'resizeViewTransform', 'newPaneHeight');

	if (
		transformsNearlyEqual(
			transform,
			defaultFitTransform(imageWidth, imageHeight, oldPaneWidth, oldPaneHeight)
		)
	) {
		return defaultFitTransform(imageWidth, imageHeight, newPaneWidth, newPaneHeight);
	}

	const anchor = screenToImage(
		{ x: oldPaneWidth / 2, y: oldPaneHeight / 2 },
		transform
	);
	return {
		zoom: transform.zoom,
		panX: newPaneWidth / 2 - anchor.xPx * transform.zoom,
		panY: newPaneHeight / 2 - anchor.yPx * transform.zoom
	};
}
