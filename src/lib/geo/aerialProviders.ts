/**
 * Keyless federal aerial providers, tried in order until one returns image bytes. Ported from the old front end's
 * `aerialProviders.ts` (`9f4b9e4^:old-stuff/src/lib/aerialProviders.ts`), same providers and the same order:
 *
 *   1. USDA latest NAIP          apps.geo.fpac.usda.gov   ImageServer (dynamic)
 *   2. USGS NAIP Plus / HRO      imagery.nationalmap.gov  ImageServer (dynamic)
 *   3. USGS NAIP                 imagery.nationalmap.gov  ImageServer (dynamic; the one `naip.ts` uses)
 *   4. USGS ImageryOnly          basemap.nationalmap.gov  MapServer (compressed cached basemap: fallback only)
 *
 * Every request is the same WGS84 bbox (`naip.ts`'s `bboxFromCenter`, `bboxSR=4326`) rendered in Web Mercator
 * (`imageSR=3857`), asked for as JSON (`f=json`) so the service reports the extent it actually rendered; the image is
 * then read from the returned `href`. That extent is the raster's georeference (`webMercator.ts`). The old module asked
 * for `imageSR=4326`, which the service answers with pixels square in degrees: on the ground the image comes back
 * squeezed vertically by cos(latitude) (measured at Dash's Track: 0.3906 m/px across, 0.4665 m/px down).
 * Every attempt is recorded (provider, URL, outcome, network cause), and the result names the provider that served.
 * Failure is a returned result, never a throw.
 */
import type { GeoBoundingBox } from '../naip';
import type { GeoRaster } from './webMercator';

export type AerialProviderId = 'usda-naip' | 'usgs-naip-plus' | 'usgs-naip' | 'usgs-imagery-only';

export interface AerialProvider {
	readonly id: AerialProviderId;
	readonly label: string;
	readonly kind: 'image-server' | 'map-server';
	readonly baseUrl: string;
	readonly maxWidthPx: number;
	readonly maxHeightPx: number;
	/** True for the dynamic image services; false for the compressed cached basemap fallback. */
	readonly dynamic: boolean;
}

export const AERIAL_PROVIDERS: readonly AerialProvider[] = [
	{
		id: 'usda-naip',
		label: 'USDA latest NAIP',
		kind: 'image-server',
		baseUrl: 'https://apps.geo.fpac.usda.gov/geo-imagery/rest/services/naip/conus_naip/ImageServer/exportImage',
		maxWidthPx: 15000,
		maxHeightPx: 4100,
		dynamic: true
	},
	{
		id: 'usgs-naip-plus',
		label: 'USGS NAIP Plus / HRO',
		kind: 'image-server',
		baseUrl: 'https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPPlus/ImageServer/exportImage',
		maxWidthPx: 4000,
		maxHeightPx: 4000,
		dynamic: true
	},
	{
		id: 'usgs-naip',
		label: 'USGS NAIP',
		kind: 'image-server',
		baseUrl: 'https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPImagery/ImageServer/exportImage',
		maxWidthPx: 4000,
		maxHeightPx: 4000,
		dynamic: true
	},
	{
		id: 'usgs-imagery-only',
		label: 'USGS ImageryOnly cached fallback',
		kind: 'map-server',
		baseUrl: 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/export',
		maxWidthPx: 4096,
		maxHeightPx: 4096,
		dynamic: false
	}
];

export interface AerialRasterSize {
	readonly widthPx: number;
	readonly heightPx: number;
}

export type AerialAttemptKind = 'size-cap' | 'network' | 'http-error' | 'bad-content-type' | 'bad-json';

export interface AerialFetchAttempt {
	readonly providerId: AerialProviderId;
	readonly providerLabel: string;
	readonly url: string;
	readonly ok: boolean;
	readonly kind?: AerialAttemptKind;
	readonly message?: string;
}

export type AerialFetchResult =
	| {
			readonly ok: true;
			readonly bytes: Uint8Array;
			readonly contentType: string;
			readonly provider: AerialProvider;
			/** The export request (JSON); `imageUrl` is the rendered image it pointed to. */
			readonly url: string;
			readonly imageUrl: string;
			/** The extent the service actually rendered, and the raster size. */
			readonly raster: GeoRaster;
			readonly attempts: readonly AerialFetchAttempt[];
	  }
	| { readonly ok: false; readonly attempts: readonly AerialFetchAttempt[]; readonly message: string };

/** One export URL, WGS84 in and out. Throws only for a size over the provider's cap (a caller error, recorded as an attempt). */
export function buildAerialExportUrl(provider: AerialProvider, bbox: GeoBoundingBox, size: AerialRasterSize): string {
	if (!Number.isInteger(size.widthPx) || !Number.isInteger(size.heightPx) || size.widthPx <= 0 || size.heightPx <= 0) {
		throw new Error(`Aerial raster size must be positive integers, got ${size.widthPx} x ${size.heightPx}.`);
	}
	if (size.widthPx > provider.maxWidthPx || size.heightPx > provider.maxHeightPx) {
		throw new Error(`${provider.label} caps exports at ${provider.maxWidthPx} x ${provider.maxHeightPx}; requested ${size.widthPx} x ${size.heightPx}.`);
	}
	const params = new URLSearchParams({
		bbox: `${bbox.minLon},${bbox.minLat},${bbox.maxLon},${bbox.maxLat}`,
		bboxSR: '4326',
		imageSR: '3857',
		size: `${size.widthPx},${size.heightPx}`,
		format: provider.kind === 'map-server' ? 'png32' : 'png',
		f: 'json'
	});
	return `${provider.baseUrl}?${params.toString()}`;
}

/** The export's JSON answer: the image href, its size, and the EPSG:3857 extent actually rendered. */
async function readExportJson(response: Response, size: AerialRasterSize): Promise<(GeoRaster & { href: string }) | string> {
	let body: unknown;
	try {
		body = await response.json();
	} catch {
		return `expected the export's JSON, got ${response.headers.get('content-type') || 'no content type'}`;
	}
	const b = body as { href?: unknown; width?: unknown; height?: unknown; extent?: Record<string, unknown>; error?: { message?: string } };
	if (b.error) return `service error: ${b.error.message ?? JSON.stringify(b.error)}`;
	const e = b.extent;
	const wkid = (e?.spatialReference as { latestWkid?: number; wkid?: number } | undefined) ?? {};
	if (
		typeof b.href !== 'string' ||
		typeof b.width !== 'number' ||
		typeof b.height !== 'number' ||
		!e ||
		![e.xmin, e.ymin, e.xmax, e.ymax].every((v) => typeof v === 'number' && Number.isFinite(v))
	) {
		return 'export JSON lacks href, width, height or extent';
	}
	if ((wkid.latestWkid ?? wkid.wkid) !== 3857 && wkid.wkid !== 102100) return `extent is not in EPSG:3857 (${JSON.stringify(wkid)})`;
	if (b.width !== size.widthPx || b.height !== size.heightPx) return `asked for ${size.widthPx} x ${size.heightPx} px, got ${b.width} x ${b.height}`;
	return {
		href: b.href,
		widthPx: b.width,
		heightPx: b.height,
		extent: { xmin: e.xmin as number, ymin: e.ymin as number, xmax: e.xmax as number, ymax: e.ymax as number }
	};
}

function causeOf(error: unknown): string {
	const e = error as { message?: string; cause?: { code?: string; message?: string } };
	return [e?.message, e?.cause?.code, e?.cause?.message].filter(Boolean).join(' | ') || String(error);
}

export async function fetchAerialWithFallback(
	bbox: GeoBoundingBox,
	size: AerialRasterSize,
	options: { fetch?: typeof fetch; providers?: readonly AerialProvider[] } = {}
): Promise<AerialFetchResult> {
	const fetchImpl = options.fetch ?? globalThis.fetch;
	const attempts: AerialFetchAttempt[] = [];
	for (const provider of options.providers ?? AERIAL_PROVIDERS) {
		const base = { providerId: provider.id, providerLabel: provider.label };
		let url: string;
		try {
			url = buildAerialExportUrl(provider, bbox, size);
		} catch (error) {
			attempts.push({ ...base, url: provider.baseUrl, ok: false, kind: 'size-cap', message: causeOf(error) });
			continue;
		}
		let response: Response;
		try {
			response = await fetchImpl(url);
		} catch (error) {
			attempts.push({ ...base, url, ok: false, kind: 'network', message: causeOf(error) });
			continue;
		}
		if (!response.ok) {
			attempts.push({ ...base, url, ok: false, kind: 'http-error', message: `HTTP ${response.status}` });
			continue;
		}
		const raster = await readExportJson(response, size);
		if (typeof raster === 'string') {
			attempts.push({ ...base, url, ok: false, kind: 'bad-json', message: raster });
			continue;
		}
		// The image: the returned href first; some services (USDA's) answer that href with HTTP 400 from a node that does
		// not hold the file, so the same export is then asked for as `f=image` (same request, same extent).
		const imageUrls = [raster.href, url.replace('f=json', 'f=image')];
		let served: { bytes: Uint8Array; contentType: string; imageUrl: string } | null = null;
		for (const imageUrl of imageUrls) {
			let image: Response;
			try {
				image = await fetchImpl(imageUrl);
			} catch (error) {
				attempts.push({ ...base, url: imageUrl, ok: false, kind: 'network', message: causeOf(error) });
				continue;
			}
			const contentType = image.headers.get('content-type') ?? '';
			if (!image.ok || !contentType.toLowerCase().startsWith('image/')) {
				attempts.push({
					...base,
					url: imageUrl,
					ok: false,
					kind: image.ok ? 'bad-content-type' : 'http-error',
					message: image.ok ? `expected image bytes, got ${contentType || 'no content type'}` : `HTTP ${image.status}`
				});
				continue;
			}
			served = { bytes: new Uint8Array(await image.arrayBuffer()), contentType, imageUrl };
			break;
		}
		if (!served) continue;
		attempts.push({ ...base, url, ok: true });
		const { href: _href, ...georeference } = raster;
		return { ok: true, bytes: served.bytes, contentType: served.contentType, provider, url, imageUrl: served.imageUrl, raster: georeference, attempts };
	}
	return { ok: false, attempts, message: 'No federal aerial provider returned image bytes.' };
}
