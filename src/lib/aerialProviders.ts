import type { GeoBoundingBox } from './naip';

export type AerialProviderId =
	| 'usda-naip'
	| 'usgs-naip-plus'
	| 'usgs-naip'
	| 'usgs-imagery-only';

export interface AerialProvider {
	id: AerialProviderId;
	label: string;
	kind: 'image-server' | 'map-server';
	baseUrl: string;
	maxWidthPx: number;
	maxHeightPx: number;
	/** True for the dynamic image services; false for the compressed cached basemap fallback. */
	dynamic: boolean;
}

/**
 * Prototype provider order. USDA's public latest-NAIP ImageServer is first because it
 * advertises the largest export surface (15,000 x 4,100) and WGS84-native coverage.
 * The two dynamic USGS ImageServers follow. USGSImageryOnly is intentionally LAST:
 * it is browser-friendly, but it is a compressed cached basemap and should be treated
 * as locator/fallback imagery rather than the clean-target quality ceiling.
 */
export const AERIAL_PROVIDERS: readonly AerialProvider[] = [
	{
		id: 'usda-naip',
		label: 'USDA latest NAIP',
		kind: 'image-server',
		baseUrl:
			'https://apps.geo.fpac.usda.gov/geo-imagery/rest/services/naip/conus_naip/ImageServer/exportImage',
		maxWidthPx: 15000,
		maxHeightPx: 4100,
		dynamic: true
	},
	{
		id: 'usgs-naip-plus',
		label: 'USGS NAIP Plus / HRO',
		kind: 'image-server',
		baseUrl:
			'https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPPlus/ImageServer/exportImage',
		maxWidthPx: 4000,
		maxHeightPx: 4000,
		dynamic: true
	},
	{
		id: 'usgs-naip',
		label: 'USGS NAIP',
		kind: 'image-server',
		baseUrl:
			'https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPImagery/ImageServer/exportImage',
		maxWidthPx: 4000,
		maxHeightPx: 4000,
		dynamic: true
	},
	{
		id: 'usgs-imagery-only',
		label: 'USGS ImageryOnly cached fallback',
		kind: 'map-server',
		baseUrl:
			'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/export',
		maxWidthPx: 4096,
		maxHeightPx: 4096,
		dynamic: false
	}
] as const;

export interface AerialRasterSize {
	widthPx: number;
	heightPx: number;
}

export interface AerialFetchAttempt {
	providerId: AerialProviderId;
	providerLabel: string;
	url: string;
	ok: boolean;
	kind?: 'cors-or-network' | 'http-error' | 'bad-content-type';
	message?: string;
}

export type AerialFetchResult =
	| {
			ok: true;
			blob: Blob;
			provider: AerialProvider;
			url: string;
			attempts: readonly AerialFetchAttempt[];
	  }
	| {
			ok: false;
			attempts: readonly AerialFetchAttempt[];
			message: string;
	  };

export type AerialFetchLike = typeof fetch;

export function providerById(id: AerialProviderId): AerialProvider {
	const provider = AERIAL_PROVIDERS.find((candidate) => candidate.id === id);
	if (!provider) throw new Error(`Unknown aerial provider '${id}'.`);
	return provider;
}

function assertRasterSize(size: AerialRasterSize): void {
	if (
		!Number.isInteger(size.widthPx) ||
		!Number.isInteger(size.heightPx) ||
		size.widthPx <= 0 ||
		size.heightPx <= 0
	) {
		throw new Error(`Aerial raster size must be positive integers, got ${size.widthPx} x ${size.heightPx}.`);
	}
}

/** Builds one direct image response URL while keeping WGS84 input/output explicit. */
export function buildAerialExportUrl(
	provider: AerialProvider,
	bbox: GeoBoundingBox,
	size: AerialRasterSize
): string {
	assertRasterSize(size);
	if (size.widthPx > provider.maxWidthPx || size.heightPx > provider.maxHeightPx) {
		throw new Error(
			`${provider.label} caps exports at ${provider.maxWidthPx} x ${provider.maxHeightPx}; requested ${size.widthPx} x ${size.heightPx}.`
		);
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

/**
 * Browser probe + fallback in one place. A fetch TypeError cannot distinguish CORS
 * rejection from a real network failure, so the prototype reports that category
 * honestly as `cors-or-network` and proceeds to the next provider. A successful
 * result is required to be an image response whose bytes are readable as a Blob —
 * merely being displayable in an <img> is not enough for ChainSpot's local mosaic.
 */
export async function fetchAerialBoundingBoxWithFallback(
	bbox: GeoBoundingBox,
	size: AerialRasterSize,
	options: {
		fetch?: AerialFetchLike;
		providers?: readonly AerialProvider[];
	} = {}
): Promise<AerialFetchResult> {
	const fetchImpl = options.fetch ?? globalThis.fetch;
	const providers = options.providers ?? AERIAL_PROVIDERS;
	const attempts: AerialFetchAttempt[] = [];

	for (const provider of providers) {
		let url: string;
		try {
			url = buildAerialExportUrl(provider, bbox, size);
		} catch (error) {
			attempts.push({
				providerId: provider.id,
				providerLabel: provider.label,
				url: provider.baseUrl,
				ok: false,
				kind: 'http-error',
				message: error instanceof Error ? error.message : String(error)
			});
			continue;
		}

		let response: Response;
		try {
			response = await fetchImpl(url, { mode: 'cors' });
		} catch {
			attempts.push({
				providerId: provider.id,
				providerLabel: provider.label,
				url,
				ok: false,
				kind: 'cors-or-network',
				message: 'Browser could not read the response (CORS rejection or network failure).'
			});
			continue;
		}

		if (!response.ok) {
			attempts.push({
				providerId: provider.id,
				providerLabel: provider.label,
				url,
				ok: false,
				kind: 'http-error',
				message: `HTTP ${response.status}`
			});
			continue;
		}

		const contentType = response.headers.get('content-type') ?? '';
		if (!contentType.toLowerCase().startsWith('image/')) {
			attempts.push({
				providerId: provider.id,
				providerLabel: provider.label,
				url,
				ok: false,
				kind: 'bad-content-type',
				message: `Expected image bytes, got ${contentType || 'unknown content type'}.`
			});
			continue;
		}

		const blob = await response.blob();
		attempts.push({ providerId: provider.id, providerLabel: provider.label, url, ok: true });
		return { ok: true, blob, provider, url, attempts };
	}

	return {
		ok: false,
		attempts,
		message: 'No configured aerial provider returned browser-readable image bytes.'
	};
}
