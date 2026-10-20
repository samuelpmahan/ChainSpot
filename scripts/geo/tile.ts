/**
 * One aerial tile on disk: fetched through the federal providers in order (src/lib/geo/aerialProviders.ts), written as
 * <dir>/naip.png + <dir>/naip.geo.json (provider, attempts, the rendered EPSG:3857 extent, measured ground m/px).
 * Shared by fetch-naip.ts and slice.ts. A failed fetch throws with every provider's attempt in the message.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fetchAerialWithFallback } from '../../src/lib/geo/aerialProviders';
import type { AerialFetchAttempt } from '../../src/lib/geo/aerialProviders';
import { groundMetersPerPixel } from '../../src/lib/geo/webMercator';
import type { GeoRaster, LonLat } from '../../src/lib/geo/webMercator';
import { bboxFromCenter, naipMetersPerPixel } from '../../src/lib/naip';
import type { GeoBoundingBox } from '../../src/lib/naip';
import { sha256Of } from './fitProject';

export interface TileSidecar {
	readonly source: string;
	readonly provider: { readonly id: string; readonly label: string; readonly dynamic: boolean };
	readonly attempts: readonly AerialFetchAttempt[];
	readonly naip: { readonly center: LonLat; readonly radiusMeters: number; readonly sizePx: number };
	readonly bbox: GeoBoundingBox;
	readonly raster: GeoRaster;
	readonly metersPerPixel: number;
	readonly metersPerPixelXY: { readonly x: number; readonly y: number };
	readonly nominalMetersPerPixel: number;
	readonly contentType: string;
	readonly sha256: string;
	readonly url: string;
	readonly imageUrl: string;
	readonly fetchedAt: string;
}

export interface Tile {
	readonly imagePath: string;
	readonly sidecarPath: string;
	readonly sidecar: TileSidecar;
}

export function readTile(dir: string): Tile | null {
	const imagePath = join(dir, 'naip.png');
	const sidecarPath = join(dir, 'naip.geo.json');
	if (!existsSync(imagePath) || !existsSync(sidecarPath)) return null;
	const sidecar = JSON.parse(readFileSync(sidecarPath, 'utf8')) as TileSidecar;
	if (sha256Of(readFileSync(imagePath)) !== sidecar.sha256) throw new Error(`integrity: ${imagePath} does not match its sidecar's sha256`);
	return { imagePath, sidecarPath, sidecar };
}

export async function fetchTile(center: LonLat, radiusMeters: number, sizePx: number, dir: string): Promise<Tile> {
	const bbox = bboxFromCenter(center, radiusMeters);
	const result = await fetchAerialWithFallback(bbox, { widthPx: sizePx, heightPx: sizePx });
	if (!result.ok) {
		throw new Error(`${result.message}\n${result.attempts.map((a) => `  ${a.providerId}: ${a.kind}: ${a.message}`).join('\n')}`);
	}
	const bytes = Buffer.from(result.bytes);
	mkdirSync(dir, { recursive: true });
	const imagePath = join(dir, 'naip.png');
	writeFileSync(imagePath, bytes);
	const ground = groundMetersPerPixel(result.raster);
	const sidecar: TileSidecar = {
		source: result.provider.id,
		provider: { id: result.provider.id, label: result.provider.label, dynamic: result.provider.dynamic },
		attempts: result.attempts,
		naip: { center, radiusMeters, sizePx },
		bbox,
		raster: result.raster,
		// Measured from the rendered extent; x and y agree to well under 0.1% at course scale.
		metersPerPixel: (ground.x + ground.y) / 2,
		metersPerPixelXY: { x: ground.x, y: ground.y },
		nominalMetersPerPixel: naipMetersPerPixel(radiusMeters, sizePx),
		contentType: result.contentType,
		sha256: sha256Of(bytes),
		url: result.url,
		imageUrl: result.imageUrl,
		fetchedAt: new Date().toISOString()
	};
	const sidecarPath = join(dir, 'naip.geo.json');
	writeFileSync(sidecarPath, JSON.stringify(sidecar, null, 1) + '\n');
	return { imagePath, sidecarPath, sidecar };
}

/** The `basemap` block of a chainspot.alignment-pairs file for this tile. */
export function basemapBlock(tile: Tile, fileName = 'naip.png') {
	const s = tile.sidecar;
	return {
		fileName,
		sha256: s.sha256,
		widthPx: s.raster.widthPx,
		heightPx: s.raster.heightPx,
		naip: s.naip,
		metersPerPixel: s.metersPerPixel,
		raster: s.raster,
		provider: s.provider.id
	};
}
