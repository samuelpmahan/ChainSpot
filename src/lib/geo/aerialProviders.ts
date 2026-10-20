/**
 * Keyless federal aerial providers, tried in order until one returns image bytes. Ported from the old front end's
 * `aerialProviders.ts` (`9f4b9e4^:old-stuff/src/lib/aerialProviders.ts`), same providers and the same order:
 *
 *   1. USDA latest NAIP          apps.geo.fpac.usda.gov   ImageServer (dynamic)
 *   2. USGS NAIP Plus / HRO      imagery.nationalmap.gov  ImageServer (dynamic)
 *   3. USGS NAIP                 imagery.nationalmap.gov  ImageServer (dynamic; the one `naip.ts` uses)
 *   4. USGS ImageryOnly          basemap.nationalmap.gov  MapServer (compressed cached basemap: fallback only)
 *
 * Every request is the same WGS84 bbox (`naip.ts`'s `bboxFromCenter`) in and out (`bboxSR=imageSR=4326`), so a square
 * request of `2r` metres at `size` px has the same exact ground scale from every provider (`naipMetersPerPixel`).
 * Every attempt is recorded (provider, URL, outcome, network cause), and the result names the provider that served.
 * Failure is a returned result, never a throw.
 */
import type { GeoBoundingBox } from '../naip';

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

export type AerialAttemptKind = 'size-cap' | 'network' | 'http-error' | 'bad-content-type';

export interface AerialFetchAttempt {
	readonly providerId: AerialProviderId;
	readonly providerLabel: string;
	readonly url: string;
	readonly ok: boolean;
	readonly kind?: AerialAttemptKind;
	readonly message?: string;
}

export type AerialFetchResult =
	| { readonly ok: true; readonly bytes: Uint8Array; readonly contentType: string; readonly provider: AerialProvider; readonly url: string; readonly attempts: readonly AerialFetchAttempt[] }
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
		imageSR: '4326',
		size: `${size.widthPx},${size.heightPx}`,
		format: provider.kind === 'map-server' ? 'png32' : 'png',
		f: 'image'
	});
	return `${provider.baseUrl}?${params.toString()}`;
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
		const contentType = response.headers.get('content-type') ?? '';
		if (!contentType.toLowerCase().startsWith('image/')) {
			attempts.push({ ...base, url, ok: false, kind: 'bad-content-type', message: `expected image bytes, got ${contentType || 'no content type'}` });
			continue;
		}
		const bytes = new Uint8Array(await response.arrayBuffer());
		attempts.push({ ...base, url, ok: true });
		return { ok: true, bytes, contentType, provider, url, attempts };
	}
	return { ok: false, attempts, message: 'No federal aerial provider returned image bytes.' };
}
