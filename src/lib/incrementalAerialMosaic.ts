import { bboxFromCenter, offsetPoint } from './naip';
import type { GeoBoundingBox, GeoPoint } from './naip';
import type { AerialProviderId } from './aerialProviders';
import type { EdgeDirection } from './edgeLoadZones';

export interface AerialGridCell {
	x: number;
	/** North-positive integer tile coordinate. */
	y: number;
}

export interface AerialTileManifest {
	cell: AerialGridCell;
	center: GeoPoint;
	bbox: GeoBoundingBox;
	providerId: AerialProviderId;
	requestedAt: string;
}

/**
 * JSON-serializable geospatial provenance for one incrementally assembled clean target.
 * Blob/image bytes stay transient; this manifest is the durable fact needed to refetch,
 * remap control points, or continue growing the raster later.
 */
export interface IncrementalAerialManifest {
	schemaVersion: 1;
	seedCenter: GeoPoint;
	tileRadiusMeters: number;
	tileSizePx: number;
	tiles: readonly AerialTileManifest[];
}

export interface GridLayout {
	minX: number;
	maxX: number;
	minY: number;
	maxY: number;
	cols: number;
	rows: number;
	widthPx: number;
	heightPx: number;
}

export interface PixelPoint {
	xPx: number;
	yPx: number;
}

export function cellKey(cell: AerialGridCell): string {
	return `${cell.x},${cell.y}`;
}

export function createIncrementalAerialManifest(
	seedCenter: GeoPoint,
	tileRadiusMeters: number,
	tileSizePx: number
): IncrementalAerialManifest {
	if (!Number.isFinite(tileRadiusMeters) || tileRadiusMeters <= 0) {
		throw new Error(`tileRadiusMeters must be positive, got ${tileRadiusMeters}.`);
	}
	if (!Number.isInteger(tileSizePx) || tileSizePx <= 0) {
		throw new Error(`tileSizePx must be a positive integer, got ${tileSizePx}.`);
	}
	return { schemaVersion: 1, seedCenter, tileRadiusMeters, tileSizePx, tiles: [] };
}

export function cellCenter(manifest: IncrementalAerialManifest, cell: AerialGridCell): GeoPoint {
	const span = manifest.tileRadiusMeters * 2;
	return offsetPoint(manifest.seedCenter, cell.x * span, cell.y * span);
}

export function cellBoundingBox(
	manifest: IncrementalAerialManifest,
	cell: AerialGridCell
): GeoBoundingBox {
	return bboxFromCenter(cellCenter(manifest, cell), manifest.tileRadiusMeters);
}

export function tileForCell(
	manifest: IncrementalAerialManifest,
	cell: AerialGridCell
): AerialTileManifest | undefined {
	const key = cellKey(cell);
	return manifest.tiles.find((tile) => cellKey(tile.cell) === key);
}

export function addTileManifest(
	manifest: IncrementalAerialManifest,
	cell: AerialGridCell,
	providerId: AerialProviderId,
	requestedAt = new Date().toISOString()
): IncrementalAerialManifest {
	if (tileForCell(manifest, cell)) return manifest;
	const center = cellCenter(manifest, cell);
	return {
		...manifest,
		tiles: [
			...manifest.tiles,
			{
				cell: { ...cell },
				center,
				bbox: bboxFromCenter(center, manifest.tileRadiusMeters),
				providerId,
				requestedAt
			}
		]
	};
}

export function gridLayout(manifest: IncrementalAerialManifest): GridLayout {
	if (manifest.tiles.length === 0) {
		return {
			minX: 0,
			maxX: 0,
			minY: 0,
			maxY: 0,
			cols: 1,
			rows: 1,
			widthPx: manifest.tileSizePx,
			heightPx: manifest.tileSizePx
		};
	}
	const xs = manifest.tiles.map((tile) => tile.cell.x);
	const ys = manifest.tiles.map((tile) => tile.cell.y);
	const minX = Math.min(...xs);
	const maxX = Math.max(...xs);
	const minY = Math.min(...ys);
	const maxY = Math.max(...ys);
	const cols = maxX - minX + 1;
	const rows = maxY - minY + 1;
	return {
		minX,
		maxX,
		minY,
		maxY,
		cols,
		rows,
		widthPx: cols * manifest.tileSizePx,
		heightPx: rows * manifest.tileSizePx
	};
}

/** Pixel top-left of one integer tile cell inside the current rectangular canvas. */
export function cellPixelOrigin(
	manifest: IncrementalAerialManifest,
	cell: AerialGridCell
): PixelPoint {
	const layout = gridLayout(manifest);
	return {
		xPx: (cell.x - layout.minX) * manifest.tileSizePx,
		yPx: (layout.maxY - cell.y) * manifest.tileSizePx
	};
}

/**
 * Existing target-space coordinates only need a translation when the rectangular
 * mosaic grows to the west and/or north. East/south growth leaves the old raster's
 * top-left fixed. This is exactly the remap delta the Create Graphics control points
 * should receive after an incremental append.
 */
export function oldRasterShiftAfterAppend(
	before: IncrementalAerialManifest,
	after: IncrementalAerialManifest
): PixelPoint {
	const oldLayout = gridLayout(before);
	const nextLayout = gridLayout(after);
	return {
		xPx: (oldLayout.minX - nextLayout.minX) * before.tileSizePx,
		yPx: (nextLayout.maxY - oldLayout.maxY) * before.tileSizePx
	};
}

/** One centered neighboring cell for the large directional ghost-tile affordance. */
export function nextDirectionalCell(
	manifest: IncrementalAerialManifest,
	direction: EdgeDirection
): AerialGridCell {
	const layout = gridLayout(manifest);
	const middleX = Math.round((layout.minX + layout.maxX) / 2);
	const middleY = Math.round((layout.minY + layout.maxY) / 2);
	switch (direction) {
		case 'north':
			return { x: middleX, y: layout.maxY + 1 };
		case 'east':
			return { x: layout.maxX + 1, y: middleY };
		case 'south':
			return { x: middleX, y: layout.minY - 1 };
		case 'west':
			return { x: layout.minX - 1, y: middleY };
	}
}

/**
 * Maps arbitrary target-image pixel coordinates — including points beyond the current
 * raster bounds — to the integer tile cells that contain them. This lets the existing
 * coverage-gap detector request the exact missing tiles without first converting the
 * points through a separate geographic representation.
 */
export function cellsRequiredForPixelPoints(
	manifest: IncrementalAerialManifest,
	points: readonly PixelPoint[]
): AerialGridCell[] {
	const layout = gridLayout(manifest);
	const size = manifest.tileSizePx;
	const required = new Map<string, AerialGridCell>();
	for (const point of points) {
		if (!Number.isFinite(point.xPx) || !Number.isFinite(point.yPx)) continue;
		const x = layout.minX + Math.floor(point.xPx / size);
		const y = layout.maxY - Math.floor(point.yPx / size);
		const cell = { x, y };
		if (!tileForCell(manifest, cell)) required.set(cellKey(cell), cell);
	}
	return [...required.values()];
}

export function translatePixelPoints(points: readonly PixelPoint[], delta: PixelPoint): PixelPoint[] {
	if (delta.xPx === 0 && delta.yPx === 0) return points.map((point) => ({ ...point }));
	return points.map((point) => ({ xPx: point.xPx + delta.xPx, yPx: point.yPx + delta.yPx }));
}

export function manifestBoundingBox(manifest: IncrementalAerialManifest): GeoBoundingBox | null {
	if (manifest.tiles.length === 0) return null;
	return manifest.tiles.reduce<GeoBoundingBox>(
		(bounds, tile) => ({
			minLon: Math.min(bounds.minLon, tile.bbox.minLon),
			minLat: Math.min(bounds.minLat, tile.bbox.minLat),
			maxLon: Math.max(bounds.maxLon, tile.bbox.maxLon),
			maxLat: Math.max(bounds.maxLat, tile.bbox.maxLat)
		}),
		{ ...manifest.tiles[0].bbox }
	);
}

export function metersPerPixel(manifest: IncrementalAerialManifest): number {
	return (manifest.tileRadiusMeters * 2) / manifest.tileSizePx;
}

/** Strict-enough parser for prototype local persistence/refetch. */
export function parseIncrementalAerialManifest(value: unknown): IncrementalAerialManifest | null {
	if (!value || typeof value !== 'object') return null;
	const input = value as Partial<IncrementalAerialManifest>;
	if (input.schemaVersion !== 1) return null;
	if (
		!input.seedCenter ||
		typeof input.seedCenter.lat !== 'number' ||
		typeof input.seedCenter.lon !== 'number' ||
		!Number.isFinite(input.seedCenter.lat) ||
		!Number.isFinite(input.seedCenter.lon) ||
		typeof input.tileRadiusMeters !== 'number' ||
		!Number.isFinite(input.tileRadiusMeters) ||
		input.tileRadiusMeters <= 0 ||
		typeof input.tileSizePx !== 'number' ||
		!Number.isInteger(input.tileSizePx) ||
		input.tileSizePx <= 0 ||
		!Array.isArray(input.tiles)
	) {
		return null;
	}
	for (const tile of input.tiles) {
		if (!tile || typeof tile !== 'object') return null;
		const candidate = tile as AerialTileManifest;
		if (
			!candidate.cell ||
			!Number.isInteger(candidate.cell.x) ||
			!Number.isInteger(candidate.cell.y) ||
			!candidate.center ||
			!candidate.bbox ||
			typeof candidate.providerId !== 'string'
		) {
			return null;
		}
	}
	return input as IncrementalAerialManifest;
}
