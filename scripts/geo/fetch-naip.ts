/**
 * Headless aerial fetch for one course: keyless federal providers tried in the old front end's order
 * (src/lib/geo/aerialProviders.ts: USDA NAIP, USGS NAIP Plus, USGS NAIP, USGS ImageryOnly), on `naip.ts`'s bbox math.
 *
 *   NODE_USE_ENV_PROXY=1 npx tsx scripts/geo/fetch-naip.ts --lat <deg> --lon <deg> --radius <m> --out <dir> [--size 2048]
 *
 * Writes <out>/naip.png and <out>/naip.geo.json: the provider that served, every attempt (and why each failed), centre,
 * radius, size, the exact ground scale (`naipMetersPerPixel`: the request is 2r metres square at size px), the URL and
 * the fetch time. The `basemap.naip` block of a `chainspot.alignment-pairs` file is the sidecar's `naip` object.
 * When every provider fails, the attempts are printed and the script exits 1; no image is written.
 * Node's fetch ignores HTTPS_PROXY unless NODE_USE_ENV_PROXY=1 (Node >= 22.21).
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fetchAerialWithFallback } from '../../src/lib/geo/aerialProviders';
import { NAIP_EXPORT_SIZE_PX, bboxFromCenter, naipMetersPerPixel } from '../../src/lib/naip';

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

const center = { lat, lon };
const bbox = bboxFromCenter(center, radiusMeters);
const result = await fetchAerialWithFallback(bbox, { widthPx: sizePx, heightPx: sizePx });
if (!result.ok) {
	console.error(result.message);
	for (const attempt of result.attempts) console.error(`  ${attempt.providerId}: ${attempt.kind}: ${attempt.message}`);
	process.exit(1);
}
const bytes = Buffer.from(result.bytes);
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'naip.png'), bytes);
const sidecar = {
	source: result.provider.id,
	provider: { id: result.provider.id, label: result.provider.label, dynamic: result.provider.dynamic },
	attempts: result.attempts,
	naip: { center, radiusMeters, sizePx },
	bbox,
	metersPerPixel: naipMetersPerPixel(radiusMeters, sizePx),
	contentType: result.contentType,
	sha256: createHash('sha256').update(bytes).digest('hex'),
	url: result.url,
	fetchedAt: new Date().toISOString()
};
writeFileSync(join(outDir, 'naip.geo.json'), JSON.stringify(sidecar, null, 1) + '\n');
console.log(JSON.stringify({ file: join(outDir, 'naip.png'), provider: result.provider.id, bytes: bytes.length, metersPerPixel: sidecar.metersPerPixel }));
