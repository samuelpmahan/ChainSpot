/**
 * Headless aerial fetch for one course: keyless federal providers tried in the old front end's order
 * (src/lib/geo/aerialProviders.ts: USDA NAIP, USGS NAIP Plus, USGS NAIP, USGS ImageryOnly), on `naip.ts`'s bbox math.
 *
 *   NODE_USE_ENV_PROXY=1 npx tsx scripts/geo/fetch-naip.ts --lat <deg> --lon <deg> --radius <m> --out <dir> [--size 2048]
 *
 * Writes <out>/naip.png and <out>/naip.geo.json: the provider that served, every attempt (and why each failed), centre,
 * radius, size, the EPSG:3857 extent the service rendered (the raster's georeference, `webMercator.ts`), the ground
 * scale measured from that extent per axis (and `naipMetersPerPixel`'s nominal 2r / size beside it), the URLs and the
 * fetch time. scripts/geo/tile.ts `basemapBlock` turns the sidecar into a pairs file's `basemap`.
 * When every provider fails, the attempts are printed and the script exits 1; no image is written.
 * Node's fetch ignores HTTPS_PROXY unless NODE_USE_ENV_PROXY=1 (Node >= 22.21).
 */
import { NAIP_EXPORT_SIZE_PX } from '../../src/lib/naip';
import { fetchTile } from './tile';

function arg(name: string): string | null {
	const index = process.argv.indexOf(name);
	return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}

const lat = Number(arg('--lat'));
const lon = Number(arg('--lon'));
const radiusMeters = Number(arg('--radius'));
const sizePx = arg('--size') ? Number(arg('--size')) : NAIP_EXPORT_SIZE_PX;
const outDir = arg('--out');
if (!outDir || !Number.isFinite(lat) || !Number.isFinite(lon) || !(radiusMeters > 0) || !Number.isInteger(sizePx)) {
	console.error('usage: tsx scripts/geo/fetch-naip.ts --lat <deg> --lon <deg> --radius <m> --out <dir> [--size 2048]');
	process.exit(2);
}

try {
	const tile = await fetchTile({ lat, lon }, radiusMeters, sizePx, outDir);
	const s = tile.sidecar;
	console.log(JSON.stringify({ file: tile.imagePath, provider: s.source, sha256: s.sha256, metersPerPixel: s.metersPerPixel, attempts: s.attempts.map((a) => `${a.providerId}:${a.ok ? 'ok' : a.kind}`) }));
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
