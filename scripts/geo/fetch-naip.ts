/**
 * Headless NAIP fetch through the app's own src/lib/naip.ts (no key; USGS National Map exportImage).
 *
 *   NODE_USE_ENV_PROXY=1 npx tsx scripts/geo/fetch-naip.ts --lat <deg> --lon <deg> --radius <m> --out <dir> [--size 2048]
 *
 * Writes <out>/naip.png and <out>/naip.geo.json: centre, radius, size, the exact ground scale (`naipMetersPerPixel`),
 * the request URL and the fetch time. The `basemap` block of a `chainspot.alignment-pairs` file is that sidecar's
 * `naip` object. A failed fetch prints naip.ts's typed error (and the network cause) and exits 1; nothing is written.
 * Node's fetch ignores HTTPS_PROXY unless NODE_USE_ENV_PROXY=1 (Node >= 22.21).
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NAIP_EXPORT_SIZE_PX, bboxFromCenter, fetchNaipImage, naipMetersPerPixel } from '../../src/lib/naip';

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
let cause = '';
const tracingFetch: typeof fetch = async (input, init) => {
	try {
		return await fetch(input, init);
	} catch (caught) {
		const error = caught as { message?: string; cause?: { code?: string; message?: string } };
		cause = [error.message, error.cause?.code, error.cause?.message].filter(Boolean).join(' | ');
		throw caught;
	}
};

const result = await fetchNaipImage(center, radiusMeters, { sizePx, fetch: tracingFetch });
if (!result.ok) {
	console.error(`NAIP fetch failed: ${result.error.kind}: ${result.error.message}${cause ? ` (cause: ${cause})` : ''}`);
	process.exit(1);
}
const bytes = Buffer.from(await result.blob.arrayBuffer());
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'naip.png'), bytes);
const sidecar = {
	source: 'usgs-naip',
	naip: { center, radiusMeters, sizePx },
	bbox: bboxFromCenter(center, radiusMeters),
	metersPerPixel: naipMetersPerPixel(radiusMeters, sizePx),
	sha256: createHash('sha256').update(bytes).digest('hex'),
	url: result.url,
	fetchedAt: new Date().toISOString()
};
writeFileSync(join(outDir, 'naip.geo.json'), JSON.stringify(sidecar, null, 1) + '\n');
console.log(JSON.stringify({ file: join(outDir, 'naip.png'), bytes: bytes.length, metersPerPixel: sidecar.metersPerPixel, sha256: sidecar.sha256 }));
