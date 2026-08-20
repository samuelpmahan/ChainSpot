/**
 * ChainSpot clean-target coverage math (CHSPT-68).
 *
 * Thin composition over geometry that already exists — deliberately adding
 * only ONE new mapping to the codebase:
 *
 * - pixel → WGS84 is `pixelRectToGeoBox` (`naipGrid.ts`) with a zero-size
 *   rect (its bounds-free linear mapping, unlike `elevationProfile.ts`'s
 *   `pixelToGeo`, which throws outside the raster — remapping must tolerate
 *   edge and beyond-edge coordinates);
 * - geo-box → center + meters is `geoBoxCenterAndSize` (`naipGrid.ts`);
 * - the new piece is `naipGeoToPixel`, the exact linear INVERSE of that
 *   pixel→geo mapping, which nothing needed before point remapping.
 *
 * All of it rides the same equirectangular approximation as `bboxFromCenter`,
 * so a pixel mapped pixel→WGS84→pixel between two radius-fetched rasters can
 * never disagree with the bbox math that fetched them. Pure functions, no I/O.
 */

import { NAIP_EXPORT_SIZE_PX, bboxFromCenter } from './naip';
import type { GeoBoundingBox, GeoPoint } from './naip';
import { geoBoxCenterAndSize, pixelRectToGeoBox } from './naipGrid';

/** A point in a raster's own pixel space (x right, y down, origin top-left). */
export interface PixelPoint {
	xPx: number;
	yPx: number;
}

/** The retained geometry of a radius-based NAIP fetch: what `bboxFromCenter` was called with. */
export interface NaipFetchGeometry {
	center: GeoPoint;
	radiusMeters: number;
}

/** Axis-aligned pixel-space bounds of a point set. */
export interface PixelBounds {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
}

/**
 * WGS84 → pixel for a radius-fetched square NAIP raster: the exact inverse of
 * `pixelToGeo` over `naipImageGeoReference(center, radius, sizePx)` (row 0 is
 * the bbox's north edge, linear in both axes). The one mapping direction the
 * codebase didn't already have.
 */
export function naipGeoToPixel(
	geometry: NaipFetchGeometry,
	point: GeoPoint,
	sizePx: number = NAIP_EXPORT_SIZE_PX
): PixelPoint {
	if (!Number.isFinite(sizePx) || sizePx <= 0) {
		throw new Error(`naipGeoToPixel: sizePx must be a positive finite number, got ${sizePx}`);
	}
	const bbox = bboxFromCenter(geometry.center, geometry.radiusMeters);
	return {
		xPx: ((point.lon - bbox.minLon) / (bbox.maxLon - bbox.minLon)) * sizePx,
		yPx: ((bbox.maxLat - point.lat) / (bbox.maxLat - bbox.minLat)) * sizePx
	};
}

/**
 * Pixel → WGS84 for the same raster shape. Reuses `pixelRectToGeoBox`'s
 * linear mapping via a zero-size rect at the point: the degenerate box's
 * `minLon`/`maxLat` corner IS the point's coordinate. Bounds-free on purpose
 * (see module doc).
 */
export function naipPixelToGeo(
	geometry: NaipFetchGeometry,
	point: PixelPoint,
	sizePx: number = NAIP_EXPORT_SIZE_PX
): GeoPoint {
	if (!Number.isFinite(sizePx) || sizePx <= 0) {
		throw new Error(`naipPixelToGeo: sizePx must be a positive finite number, got ${sizePx}`);
	}
	const box = pixelRectToGeoBox(
		bboxFromCenter(geometry.center, geometry.radiusMeters),
		sizePx,
		{ x: point.xPx, y: point.yPx, width: 0, height: 0 }
	);
	return { lon: box.minLon, lat: box.maxLat };
}

/**
 * Deterministically maps a pixel of the OLD radius-fetched raster onto the NEW
 * one: old pixel → WGS84 → new pixel. Both rasters share the same linear bbox
 * math, so this is an exact affine mapping — no estimation, no resampling
 * ambiguity. This is what lets a coverage re-fetch keep placed correspondence
 * points instead of discarding them.
 */
export function remapNaipPixel(
	oldGeometry: NaipFetchGeometry,
	newGeometry: NaipFetchGeometry,
	point: PixelPoint,
	sizePx: number = NAIP_EXPORT_SIZE_PX
): PixelPoint {
	return naipGeoToPixel(newGeometry, naipPixelToGeo(oldGeometry, point, sizePx), sizePx);
}

export interface CoverageGap {
	/** True when at least one point lies outside the raster. */
	outside: boolean;
	/** How many of the given points lie outside the raster. */
	outsideCount: number;
	/** Bounds of ALL given points (inside or not); null when no points were given. */
	bounds: PixelBounds | null;
}

/**
 * Whether a transformed course (points already in target-raster pixel space)
 * fits inside the raster. Pure bounds arithmetic; the caller supplies whatever
 * points it considers course geometry (tees, baskets, bends, corridor bands…).
 */
export function coverageGap(
	points: readonly PixelPoint[],
	widthPx: number,
	heightPx: number
): CoverageGap {
	if (!Number.isFinite(widthPx) || widthPx <= 0 || !Number.isFinite(heightPx) || heightPx <= 0) {
		throw new Error(`coverageGap: raster dimensions must be positive finite numbers, got ${widthPx} x ${heightPx}`);
	}
	let bounds: PixelBounds | null = null;
	let outsideCount = 0;
	for (const point of points) {
		if (!Number.isFinite(point.xPx) || !Number.isFinite(point.yPx)) continue;
		bounds = bounds
			? {
					minX: Math.min(bounds.minX, point.xPx),
					minY: Math.min(bounds.minY, point.yPx),
					maxX: Math.max(bounds.maxX, point.xPx),
					maxY: Math.max(bounds.maxY, point.yPx)
				}
			: { minX: point.xPx, minY: point.yPx, maxX: point.xPx, maxY: point.yPx };
		if (point.xPx < 0 || point.yPx < 0 || point.xPx > widthPx || point.yPx > heightPx) {
			outsideCount += 1;
		}
	}
	return { outside: outsideCount > 0, outsideCount, bounds };
}

/**
 * Chooses the center/radius for a coverage re-fetch: the smallest radius-based
 * fetch (plus margin) whose square bbox contains BOTH the old raster's full
 * extent and the course bounds (given in the old raster's pixel space).
 *
 * Containing the old extent — not just the course — is what guarantees every
 * already-placed target point remaps in-bounds onto the new raster, so the
 * re-fetch can promise "points survive" unconditionally.
 */
export function expandedFetchGeometry(
	oldGeometry: NaipFetchGeometry,
	courseBoundsPx: PixelBounds,
	options: { sizePx?: number; marginFraction?: number } = {}
): NaipFetchGeometry {
	const { sizePx = NAIP_EXPORT_SIZE_PX, marginFraction = 0.1 } = options;
	if (!Number.isFinite(marginFraction) || marginFraction < 0) {
		throw new Error(`expandedFetchGeometry: marginFraction must be a non-negative finite number, got ${marginFraction}`);
	}

	// Old raster corners union course-bounds corners, all in old-raster pixels,
	// converted with the exact machinery the tile-grid selection box already uses.
	const unionMinX = Math.min(0, courseBoundsPx.minX);
	const unionMinY = Math.min(0, courseBoundsPx.minY);
	const geoBox = pixelRectToGeoBox(
		bboxFromCenter(oldGeometry.center, oldGeometry.radiusMeters),
		sizePx,
		{
			x: unionMinX,
			y: unionMinY,
			width: Math.max(sizePx, courseBoundsPx.maxX) - unionMinX,
			height: Math.max(sizePx, courseBoundsPx.maxY) - unionMinY
		}
	);
	const { center, widthMeters, heightMeters } = geoBoxCenterAndSize(geoBox);
	return {
		center,
		radiusMeters: (Math.max(widthMeters, heightMeters) / 2) * (1 + marginFraction)
	};
}

/**
 * Fallback radius when a geocoder result has no usable bounding box; also the
 * long-standing default of the radius input this flow replaces as the primary
 * path.
 */
export const DEFAULT_VIEWPORT_RADIUS_METERS = 300;
/** Boxes smaller than this across are point-defaults, not real place extents. */
export const MIN_USEFUL_VIEWPORT_METERS = 120;
/** Clamp bounds for a viewport-derived radius (see CHSPT-68 audit discussion). */
export const MIN_VIEWPORT_RADIUS_METERS = 150;
export const MAX_VIEWPORT_RADIUS_METERS = 1500;
/** Breathing margin applied to a viewport-derived half-extent. */
export const VIEWPORT_RADIUS_MARGIN = 1.15;

export interface ViewportFetchGeometry extends NaipFetchGeometry {
	/** True when the radius came from a real provider box rather than the default. */
	fromViewport: boolean;
}

/**
 * Turns a geocoder result's bounding box into a fetch center/radius. A
 * missing or degenerate box (smaller than `MIN_USEFUL_VIEWPORT_METERS` across
 * — providers return point-default rectangles for unmapped POIs) yields the
 * result's own center at `DEFAULT_VIEWPORT_RADIUS_METERS` with
 * `fromViewport: false`, so callers can keep their own fallback flows (e.g.
 * the keyed MapConfirm midpoint step).
 */
export function fetchGeometryFromViewport(
	resultCenter: GeoPoint,
	viewport: GeoBoundingBox | undefined
): ViewportFetchGeometry {
	if (!viewport) {
		return { center: resultCenter, radiusMeters: DEFAULT_VIEWPORT_RADIUS_METERS, fromViewport: false };
	}
	const { center, widthMeters, heightMeters } = geoBoxCenterAndSize(viewport);
	if (
		!Number.isFinite(widthMeters) ||
		!Number.isFinite(heightMeters) ||
		widthMeters < 0 ||
		heightMeters < 0 ||
		Math.max(widthMeters, heightMeters) < MIN_USEFUL_VIEWPORT_METERS
	) {
		return { center: resultCenter, radiusMeters: DEFAULT_VIEWPORT_RADIUS_METERS, fromViewport: false };
	}
	const radiusMeters = Math.min(
		MAX_VIEWPORT_RADIUS_METERS,
		Math.max(
			MIN_VIEWPORT_RADIUS_METERS,
			(Math.max(widthMeters, heightMeters) / 2) * VIEWPORT_RADIUS_MARGIN
		)
	);
	return { center, radiusMeters, fromViewport: true };
}
