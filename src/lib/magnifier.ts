/**
 * ChainSpot magnifier/precision preview (P0-012).
 *
 * A compact magnified preview inside each pane that helps place and correct a
 * control point. The preview samples the ORIGINAL decoded raster directly
 * (`drawImage` from the decoded `HTMLImageElement`), never an already-downscaled
 * Konva screen canvas, whenever the decoded original is available. The only
 * browser-only pieces are the drawing entry point; every coordinate decision is a
 * pure function so the sampling contract is unit-testable against known fixtures.
 *
 * Model:
 * - The magnifier is a square canvas of `MAGNIFIER_SIZE` CSS pixels.
 * - Display scale (CSS pixels per original image pixel) is deterministic:
 *   `max(MAGNIFIER_MIN_IMAGE_SCALE, viewZoom * MAGNIFIER_VIEW_ZOOM_FACTOR)`.
 *   At normal fit zooms this is a strong fixed zoom; once the user zooms close to
 *   or past that, the magnifier keeps at least twice the current view detail. The
 *   view zoom is the only transient input, so the same anchor and view always
 *   sample the same pixels.
 * - A source rectangle of `size / displayScale` original-image pixels, centered on
 *   the anchor, is clamped to the image bounds. The anchor therefore keeps its
 *   exact pixel coordinate and lands at `anchorX/anchorY` CSS pixels inside the
 *   canvas; near image edges the region shifts and the crosshair marks the anchor
 *   offset from center.
 * - `drawMagnifier` paints that clamped region into the full canvas and draws an
 *   exact crosshair (dark then light passes) through the anchor so it stays
 *   readable over both bright and dark imagery.
 *
 * The magnifier is transient display state only: it never mutates domain state,
 * history, dirty state, or the decoded image.
 */
import type { PointCoordinates } from './domain/project';

/** Fixed magnifier preview size in CSS pixels. */
export const MAGNIFIER_SIZE = 144;

/** Minimum magnifier display scale in CSS pixels per original image pixel. */
export const MAGNIFIER_MIN_IMAGE_SCALE = 4;

/** View-zoom multiplier applied when the current view exceeds the minimum scale. */
export const MAGNIFIER_VIEW_ZOOM_FACTOR = 2;

/** Preferred gap between the anchor and the magnifier box in CSS pixels. */
export const MAGNIFIER_GAP_PX = 12;

export interface MagnifierSampling {
	/** Clamped source rectangle in original-image pixels. */
	readonly sourceX: number;
	readonly sourceY: number;
	readonly sourceWidth: number;
	readonly sourceHeight: number;
	/** Anchor position in CSS pixels inside the magnifier canvas. */
	readonly anchorX: number;
	readonly anchorY: number;
	/** CSS pixels per original-image pixel used by this sampling. */
	readonly displayScale: number;
}

export interface ScreenPoint {
	readonly x: number;
	readonly y: number;
}

export interface PaneSize {
	readonly width: number;
	readonly height: number;
}

export interface BoxPosition {
	readonly x: number;
	readonly y: number;
}

function assertPositive(value: number, context: string, name: string): void {
	if (!Number.isFinite(value) || value <= 0) {
		throw new Error(`${context}: ${name} must be a positive finite number, got ${value}`);
	}
}

function assertFinite(value: number, context: string, name: string): void {
	if (!Number.isFinite(value)) {
		throw new Error(`${context}: ${name} must be a finite number, got ${value}`);
	}
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max);
}

/**
 * Deterministic magnifier display scale: at least `MAGNIFIER_MIN_IMAGE_SCALE` CSS
 * pixels per image pixel, and at least twice the current view detail.
 */
export function magnifierDisplayScale(viewZoom: number): number {
	assertPositive(viewZoom, 'magnifierDisplayScale', 'viewZoom');
	return Math.max(MAGNIFIER_MIN_IMAGE_SCALE, viewZoom * MAGNIFIER_VIEW_ZOOM_FACTOR);
}

/**
 * Computes the clamped original-pixel source rectangle and the exact CSS-pixel
 * anchor offset for a magnifier of `size` CSS pixels. Pure: identical inputs give
 * identical outputs, so tests can pin the values against known fixture dimensions.
 */
export function magnifierSampling(
	anchor: PointCoordinates,
	imageWidth: number,
	imageHeight: number,
	size: number,
	viewZoom: number
): MagnifierSampling {
	assertFinite(anchor.xPx, 'magnifierSampling', 'anchor.xPx');
	assertFinite(anchor.yPx, 'magnifierSampling', 'anchor.yPx');
	assertPositive(imageWidth, 'magnifierSampling', 'imageWidth');
	assertPositive(imageHeight, 'magnifierSampling', 'imageHeight');
	assertPositive(size, 'magnifierSampling', 'size');
	const displayScale = magnifierDisplayScale(viewZoom);

	const sourceWidth = Math.min(size / displayScale, imageWidth);
	const sourceHeight = Math.min(size / displayScale, imageHeight);
	const sourceX = clamp(anchor.xPx - sourceWidth / 2, 0, imageWidth - sourceWidth);
	const sourceY = clamp(anchor.yPx - sourceHeight / 2, 0, imageHeight - sourceHeight);

	return {
		sourceX,
		sourceY,
		sourceWidth,
		sourceHeight,
		anchorX: (anchor.xPx - sourceX) * displayScale,
		anchorY: (anchor.yPx - sourceY) * displayScale,
		displayScale
	};
}

/**
 * Positions the magnifier box in pane-local CSS pixels without covering the
 * anchor: preferred upper-left of the anchor, flipping to the lower-right side
 * when it would overflow the pane edge, and always fully clamped into the pane.
 */
export function magnifierBoxPosition(
	anchorScreen: ScreenPoint,
	paneSize: PaneSize,
	size: number = MAGNIFIER_SIZE,
	gap: number = MAGNIFIER_GAP_PX
): BoxPosition {
	assertFinite(anchorScreen.x, 'magnifierBoxPosition', 'anchorScreen.x');
	assertFinite(anchorScreen.y, 'magnifierBoxPosition', 'anchorScreen.y');
	assertPositive(paneSize.width, 'magnifierBoxPosition', 'paneSize.width');
	assertPositive(paneSize.height, 'magnifierBoxPosition', 'paneSize.height');
	assertPositive(size, 'magnifierBoxPosition', 'size');
	assertFinite(gap, 'magnifierBoxPosition', 'gap');

	const maxX = Math.max(0, paneSize.width - size);
	const maxY = Math.max(0, paneSize.height - size);
	let x = anchorScreen.x - size - gap;
	let y = anchorScreen.y - size - gap;
	if (x < 0) x = Math.min(anchorScreen.x + gap, maxX);
	if (y < 0) y = Math.min(anchorScreen.y + gap, maxY);
	return { x: clamp(x, 0, maxX), y: clamp(y, 0, maxY) };
}

/** Minimal structural 2D-context surface used by `drawMagnifier` (testable in jsdom). */
export interface Canvas2DLike {
	setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
	clearRect(x: number, y: number, width: number, height: number): void;
	drawImage(
		image: CanvasImageSource,
		sx: number,
		sy: number,
		sw: number,
		sh: number,
		dx: number,
		dy: number,
		dw: number,
		dh: number
	): void;
	beginPath(): void;
	moveTo(x: number, y: number): void;
	lineTo(x: number, y: number): void;
	stroke(): void;
	strokeStyle: string | CanvasGradient | CanvasPattern;
	lineWidth: number;
}

/** Crosshair outline pass: readable over bright imagery. */
export const CROSSHAIR_DARK = 'rgba(15, 23, 42, 0.65)';

/** Crosshair core pass: readable over dark imagery. */
export const CROSSHAIR_LIGHT = 'rgba(255, 255, 255, 0.95)';

/**
 * Draws the exact crosshair through `(x, y)` in the current transform space. The
 * line coordinates snap to half-pixel boundaries so the 1px passes render crisp
 * rows/columns; the intersection stays within half a CSS pixel of the anchor.
 */
export function drawCrosshair(
	context: Canvas2DLike,
	x: number,
	y: number,
	size: number
): void {
	const cx = Math.round(x) + 0.5;
	const cy = Math.round(y) + 0.5;
	for (const pass of [
		{ style: CROSSHAIR_DARK, width: 3 },
		{ style: CROSSHAIR_LIGHT, width: 1 }
	]) {
		context.strokeStyle = pass.style;
		context.lineWidth = pass.width;
		context.beginPath();
		context.moveTo(0, cy);
		context.lineTo(size, cy);
		context.moveTo(cx, 0);
		context.lineTo(cx, size);
		context.stroke();
	}
}

/**
 * Samples `sampling.sourceX/sourceY/sourceWidth/sourceHeight` from the decoded
 * original and paints it across the full `size × size` canvas, then draws the
 * exact anchor crosshair. The caller owns canvas sizing and the device-pixel-ratio
 * transform; this function draws in CSS-pixel space.
 */
export function drawMagnifier(
	context: Canvas2DLike,
	image: CanvasImageSource,
	sampling: MagnifierSampling,
	size: number = MAGNIFIER_SIZE
): void {
	assertPositive(size, 'drawMagnifier', 'size');
	context.clearRect(0, 0, size, size);
	context.drawImage(
		image,
		sampling.sourceX,
		sampling.sourceY,
		sampling.sourceWidth,
		sampling.sourceHeight,
		0,
		0,
		size,
		size
	);
	drawCrosshair(context, sampling.anchorX, sampling.anchorY, size);
}
