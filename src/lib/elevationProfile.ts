/**
 * ChainSpot hole elevation profiles.
 *
 * A hole's routing geometry is already a one-dimensional polyline. Once that
 * polyline has been transformed into a NAIP target raster, elevation is just a
 * deterministic lookup pipeline:
 *
 *   target pixels -> the exact NAIP request bbox -> WGS84 points -> USGS EPQS
 *
 * No raster segmentation or elevation inference happens here. Multi-tile NAIP
 * mosaics are deliberately georeferenced piece-by-piece instead of pretending
 * the whole mosaic is one affine bbox: each 2048px tile was requested with its
 * own known bbox, so using the tile that actually contains a pixel preserves
 * the mapping chosen before the imagery was fetched.
 *
 * The polyline itself reuses `TargetPoint` from `holeGraphics.ts` (target-image
 * pixels, the same convention `HoleGraphicPlan.centerline` already produces)
 * rather than minting a fifth `{xPx,yPx}` alias for the same shape.
 */
import { bboxFromCenter, NAIP_EXPORT_SIZE_PX } from './naip';
import type { GeoBoundingBox, GeoPoint } from './naip';
import type { TileGridPlan } from './naipGrid';
import type { TargetPoint } from './holeGraphics';

export interface GeoRasterTile {
	/** Tile origin inside the assembled target raster, in target-image pixels. */
	readonly xPx: number;
	readonly yPx: number;
	readonly widthPx: number;
	readonly heightPx: number;
	/** WGS84 bbox used to request this exact tile. */
	readonly bbox: GeoBoundingBox;
}

/**
 * Piecewise pixel-to-world mapping for one target raster. A single NAIP export
 * has one tile; an assembled grid has one entry per fetched tile.
 */
export interface GeoRasterReference {
	readonly widthPx: number;
	readonly heightPx: number;
	readonly tiles: readonly GeoRasterTile[];
}

/** Build the exact georeference for one NAIP exportImage request. */
export function naipImageGeoReference(
	center: GeoPoint,
	radiusMeters: number,
	sizePx: number = NAIP_EXPORT_SIZE_PX
): GeoRasterReference {
	if (!Number.isInteger(sizePx) || sizePx <= 0) {
		throw new Error(`naipImageGeoReference: sizePx must be a positive integer, got ${sizePx}`);
	}
	return {
		widthPx: sizePx,
		heightPx: sizePx,
		tiles: [
			{
				xPx: 0,
				yPx: 0,
				widthPx: sizePx,
				heightPx: sizePx,
				bbox: bboxFromCenter(center, radiusMeters)
			}
		]
	};
}

/**
 * Build the exact piecewise georeference for a row-major NAIP grid. This mirrors
 * `composeMosaic`: tile N is drawn at `(col * tileSizePx, row * tileSizePx)`.
 */
export function naipGridGeoReference(
	plan: TileGridPlan,
	tileSizePx: number = NAIP_EXPORT_SIZE_PX
): GeoRasterReference {
	if (!Number.isInteger(tileSizePx) || tileSizePx <= 0) {
		throw new Error(`naipGridGeoReference: tileSizePx must be a positive integer, got ${tileSizePx}`);
	}
	if (plan.rows <= 0 || plan.cols <= 0 || plan.centers.length !== plan.rows * plan.cols) {
		throw new Error(
			`naipGridGeoReference: expected rows * cols (${plan.rows * plan.cols}) centers, got ${plan.centers.length}`
		);
	}
	return {
		widthPx: plan.cols * tileSizePx,
		heightPx: plan.rows * tileSizePx,
		tiles: plan.centers.map((center, index) => {
			const row = Math.floor(index / plan.cols);
			const col = index % plan.cols;
			return {
				xPx: col * tileSizePx,
				yPx: row * tileSizePx,
				widthPx: tileSizePx,
				heightPx: tileSizePx,
				bbox: bboxFromCenter(center, plan.tileRadiusMeters)
			};
		})
	};
}

function finitePoint(point: TargetPoint): boolean {
	return Number.isFinite(point.xPx) && Number.isFinite(point.yPx);
}

function tileContaining(point: TargetPoint, reference: GeoRasterReference): GeoRasterTile | null {
	return (
		reference.tiles.find(
			(tile) =>
				point.xPx >= tile.xPx &&
				point.yPx >= tile.yPx &&
				point.xPx < tile.xPx + tile.widthPx &&
				point.yPx < tile.yPx + tile.heightPx
		) ?? null
	);
}

/**
 * Convert one target-raster pixel coordinate to WGS84 using the bbox of the
 * actual NAIP tile underneath it. Pixel coordinates use ChainSpot's normal
 * canvas convention: 0 is the left/top edge and width/height are the excluded
 * right/bottom edges, matching `pixelRectToGeoBox` in `naipGrid.ts`.
 */
export function pixelToGeo(point: TargetPoint, reference: GeoRasterReference): GeoPoint {
	if (!finitePoint(point)) {
		throw new Error(`pixelToGeo: point must be finite, got (${point.xPx}, ${point.yPx})`);
	}
	if (
		point.xPx < 0 ||
		point.yPx < 0 ||
		point.xPx >= reference.widthPx ||
		point.yPx >= reference.heightPx
	) {
		throw new Error(
			`pixelToGeo: point (${point.xPx}, ${point.yPx}) is outside ${reference.widthPx} x ${reference.heightPx}`
		);
	}
	const tile = tileContaining(point, reference);
	if (!tile) {
		throw new Error(`pixelToGeo: no georeferenced tile covers (${point.xPx}, ${point.yPx})`);
	}
	const xFraction = (point.xPx - tile.xPx) / tile.widthPx;
	const yFraction = (point.yPx - tile.yPx) / tile.heightPx;
	return {
		lon: tile.bbox.minLon + xFraction * (tile.bbox.maxLon - tile.bbox.minLon),
		lat: tile.bbox.maxLat - yFraction * (tile.bbox.maxLat - tile.bbox.minLat)
	};
}

const EARTH_RADIUS_METERS = 6_371_008.8;

/** Great-circle distance; course-scale inputs make this effectively exact for our use. */
export function geoDistanceMeters(a: GeoPoint, b: GeoPoint): number {
	const radians = Math.PI / 180;
	const lat1 = a.lat * radians;
	const lat2 = b.lat * radians;
	const deltaLat = (b.lat - a.lat) * radians;
	const deltaLon = (b.lon - a.lon) * radians;
	const sinLat = Math.sin(deltaLat / 2);
	const sinLon = Math.sin(deltaLon / 2);
	const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLon * sinLon;
	return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(h)));
}

export interface ProfilePathSample {
	readonly pixel: TargetPoint;
	readonly point: GeoPoint;
	readonly distanceMeters: number;
}

export interface ResamplePathOptions {
	/** Desired spacing before the hard sample cap is applied. */
	sampleSpacingMeters?: number;
	/** Public elevation services should never receive an unbounded request fanout. */
	maxSamples?: number;
}

export const DEFAULT_ELEVATION_SAMPLE_SPACING_METERS = 8;
export const DEFAULT_ELEVATION_MAX_SAMPLES = 80;

/**
 * Walks the polyline by cumulative geographic length and returns evenly spaced
 * samples, preserving every dogleg because interpolation always happens on the
 * original segment that owns that distance. Endpoints are always included.
 */
export function resampleGeoReferencedPath(
	path: readonly TargetPoint[],
	reference: GeoRasterReference,
	options: ResamplePathOptions = {}
): ProfilePathSample[] {
	if (path.length < 2) throw new Error('resampleGeoReferencedPath: path needs at least two points');
	const {
		sampleSpacingMeters = DEFAULT_ELEVATION_SAMPLE_SPACING_METERS,
		maxSamples = DEFAULT_ELEVATION_MAX_SAMPLES
	} = options;
	if (!(sampleSpacingMeters > 0) || !Number.isFinite(sampleSpacingMeters)) {
		throw new Error(`resampleGeoReferencedPath: sampleSpacingMeters must be positive, got ${sampleSpacingMeters}`);
	}
	if (!Number.isInteger(maxSamples) || maxSamples < 2) {
		throw new Error(`resampleGeoReferencedPath: maxSamples must be an integer >= 2, got ${maxSamples}`);
	}

	const geoVertices = path.map((point) => pixelToGeo(point, reference));
	const cumulative = [0];
	for (let index = 1; index < path.length; index++) {
		cumulative.push(cumulative[index - 1] + geoDistanceMeters(geoVertices[index - 1], geoVertices[index]));
	}
	const totalDistance = cumulative[cumulative.length - 1];
	if (!(totalDistance > 0)) {
		throw new Error('resampleGeoReferencedPath: path has zero geographic length');
	}

	const desiredSamples = Math.ceil(totalDistance / sampleSpacingMeters) + 1;
	const sampleCount = Math.min(maxSamples, Math.max(2, desiredSamples));
	const samples: ProfilePathSample[] = [];
	let segment = 0;
	for (let index = 0; index < sampleCount; index++) {
		const distanceMeters = index === sampleCount - 1 ? totalDistance : (totalDistance * index) / (sampleCount - 1);
		while (segment < cumulative.length - 2 && distanceMeters > cumulative[segment + 1]) segment++;
		const startDistance = cumulative[segment];
		const endDistance = cumulative[segment + 1];
		const fraction = endDistance > startDistance ? (distanceMeters - startDistance) / (endDistance - startDistance) : 0;
		const start = path[segment];
		const end = path[segment + 1];
		const pixel = {
			xPx: start.xPx + (end.xPx - start.xPx) * fraction,
			yPx: start.yPx + (end.yPx - start.yPx) * fraction
		};
		samples.push({ pixel, point: pixelToGeo(pixel, reference), distanceMeters });
	}
	return samples;
}

export type ElevationUnits = 'Feet' | 'Meters';
export type ElevationProfileErrorKind = 'network' | 'http-error' | 'bad-payload';

export class ElevationProfileError extends Error {
	readonly kind: ElevationProfileErrorKind;
	readonly sampleIndex: number | null;

	constructor(kind: ElevationProfileErrorKind, message: string, sampleIndex: number | null = null) {
		super(message);
		this.name = 'ElevationProfileError';
		this.kind = kind;
		this.sampleIndex = sampleIndex;
	}
}

const EPQS_JSON_URL = 'https://epqs.nationalmap.gov/v1/json';

/** Current USGS Elevation Point Query Service request for a WGS84 point. */
export function buildEpqsUrl(point: GeoPoint, units: ElevationUnits = 'Feet'): string {
	const params = new URLSearchParams({
		x: String(point.lon),
		y: String(point.lat),
		units,
		wkid: '4326',
		includeDate: 'False'
	});
	return `${EPQS_JSON_URL}?${params.toString()}`;
}

interface EpqsPayload {
	value?: unknown;
}

function invalidElevationValue(value: unknown): boolean {
	if (typeof value !== 'number' && typeof value !== 'string') return true;
	if (typeof value === 'string' && value.trim() === '') return true;
	const numeric = Number(value);
	// EPQS uses -1000000 when it cannot resolve an elevation at the requested point.
	return !Number.isFinite(numeric) || numeric <= -999_999;
}

async function queryElevation(
	point: GeoPoint,
	units: ElevationUnits,
	fetchImpl: typeof fetch,
	sampleIndex: number,
	signal?: AbortSignal
): Promise<number> {
	let response: Response;
	try {
		response = await fetchImpl(buildEpqsUrl(point, units), { mode: 'cors', signal });
	} catch {
		throw new ElevationProfileError(
			'network',
			`Could not reach the USGS elevation service for sample ${sampleIndex + 1}.`,
			sampleIndex
		);
	}
	if (!response.ok) {
		throw new ElevationProfileError(
			'http-error',
			`USGS elevation service returned HTTP ${response.status} for sample ${sampleIndex + 1}.`,
			sampleIndex
		);
	}
	let payload: EpqsPayload;
	try {
		payload = (await response.json()) as EpqsPayload;
	} catch {
		throw new ElevationProfileError('bad-payload', 'USGS elevation service returned invalid JSON.', sampleIndex);
	}
	if (invalidElevationValue(payload.value)) {
		throw new ElevationProfileError(
			'bad-payload',
			`USGS elevation service returned no numeric elevation for sample ${sampleIndex + 1}.`,
			sampleIndex
		);
	}
	return Number(payload.value);
}

export interface ElevationSample extends ProfilePathSample {
	readonly elevation: number;
}

export interface ElevationProfile {
	readonly units: ElevationUnits;
	readonly samples: readonly ElevationSample[];
	readonly totalDistanceMeters: number;
	readonly minElevation: number;
	readonly maxElevation: number;
	/** Sum of positive sample-to-sample changes. */
	readonly totalClimb: number;
	/** Positive magnitude of all sample-to-sample drops. */
	readonly totalDescent: number;
}

export interface BuildElevationProfileOptions extends ResamplePathOptions {
	units?: ElevationUnits;
	fetch?: typeof fetch;
	concurrency?: number;
	signal?: AbortSignal;
}

export const DEFAULT_ELEVATION_FETCH_CONCURRENCY = 6;

/**
 * Samples 3DEP through EPQS with a small bounded worker pool. Results retain path
 * order even though requests run concurrently; a failed point fails the profile
 * rather than silently drawing a fabricated gap.
 */
export async function buildElevationProfile(
	path: readonly TargetPoint[],
	reference: GeoRasterReference,
	options: BuildElevationProfileOptions = {}
): Promise<ElevationProfile> {
	const {
		units = 'Feet',
		fetch: fetchImpl = globalThis.fetch,
		concurrency = DEFAULT_ELEVATION_FETCH_CONCURRENCY,
		signal,
		...resampleOptions
	} = options;
	if (!Number.isInteger(concurrency) || concurrency < 1) {
		throw new Error(`buildElevationProfile: concurrency must be a positive integer, got ${concurrency}`);
	}
	const pathSamples = resampleGeoReferencedPath(path, reference, resampleOptions);
	const elevations = new Array<number>(pathSamples.length);
	let nextIndex = 0;
	let firstError: unknown = null;

	async function worker(): Promise<void> {
		for (;;) {
			if (firstError) return;
			const index = nextIndex++;
			if (index >= pathSamples.length) return;
			try {
				elevations[index] = await queryElevation(pathSamples[index].point, units, fetchImpl, index, signal);
			} catch (error) {
				firstError ??= error;
				return;
			}
		}
	}

	await Promise.all(Array.from({ length: Math.min(concurrency, pathSamples.length) }, () => worker()));
	if (firstError) throw firstError;

	const samples = pathSamples.map((sample, index) => ({ ...sample, elevation: elevations[index] }));
	let minElevation = samples[0].elevation;
	let maxElevation = samples[0].elevation;
	let totalClimb = 0;
	let totalDescent = 0;
	for (let index = 1; index < samples.length; index++) {
		minElevation = Math.min(minElevation, samples[index].elevation);
		maxElevation = Math.max(maxElevation, samples[index].elevation);
		const delta = samples[index].elevation - samples[index - 1].elevation;
		if (delta > 0) totalClimb += delta;
		else totalDescent -= delta;
	}
	return {
		units,
		samples,
		totalDistanceMeters: samples[samples.length - 1].distanceMeters,
		minElevation,
		maxElevation,
		totalClimb,
		totalDescent
	};
}

export interface ElevationProfileRenderOptions {
	widthPx?: number;
	heightPx?: number;
	title?: string;
	/** Prevent tiny DEM noise from being vertically exaggerated into a mountain. */
	minimumElevationRange?: number;
}

export interface ElevationProfileRenderEnv {
	createCanvas(): HTMLCanvasElement;
	toBlob(canvas: HTMLCanvasElement, type: string): Promise<Blob | null>;
}

export const defaultElevationProfileRenderEnv: ElevationProfileRenderEnv = {
	createCanvas() {
		return document.createElement('canvas');
	},
	toBlob(canvas, type) {
		return new Promise((resolve, reject) => {
			canvas.toBlob((blob) => {
				if (blob) resolve(blob);
				else reject(new Error('Elevation profile PNG encoding failed. Try again.'));
			}, type);
		});
	}
};

/**
 * Renders the deliberately spare broadcast treatment from the product sketch:
 * black 16:9 field, centered white "Elevation" title, thick rounded red profile,
 * no axes or GIS chrome. The geometry remains reusable; this is only one style.
 */
export async function renderElevationProfile(
	profile: ElevationProfile,
	options: ElevationProfileRenderOptions = {},
	env: ElevationProfileRenderEnv = defaultElevationProfileRenderEnv
): Promise<Blob> {
	if (profile.samples.length < 2) throw new Error('renderElevationProfile: profile needs at least two samples');
	const widthPx = options.widthPx ?? 1200;
	const heightPx = options.heightPx ?? 675;
	if (!Number.isInteger(widthPx) || !Number.isInteger(heightPx) || widthPx <= 0 || heightPx <= 0) {
		throw new Error(`renderElevationProfile: dimensions must be positive integers, got ${widthPx} x ${heightPx}`);
	}
	const canvas = env.createCanvas();
	const context = canvas.getContext('2d');
	if (!context) throw new Error('Could not allocate a canvas for the elevation profile.');
	canvas.width = widthPx;
	canvas.height = heightPx;

	context.fillStyle = '#000';
	context.fillRect(0, 0, widthPx, heightPx);

	context.fillStyle = '#fff';
	context.font = `500 ${Math.round(heightPx * 0.075)}px system-ui, sans-serif`;
	context.textAlign = 'center';
	context.textBaseline = 'middle';
	context.fillText(options.title ?? 'Elevation', widthPx / 2, heightPx * 0.21);

	const plotLeft = widthPx * 0.1;
	const plotRight = widthPx * 0.92;
	const plotTop = heightPx * 0.43;
	const plotBottom = heightPx * 0.82;
	const actualRange = profile.maxElevation - profile.minElevation;
	const defaultMinimumRange = profile.units === 'Feet' ? 10 : 3;
	const elevationRange = Math.max(actualRange, options.minimumElevationRange ?? defaultMinimumRange);
	const midpoint = (profile.minElevation + profile.maxElevation) / 2;
	const rangeMin = midpoint - elevationRange / 2;
	const rangeMax = midpoint + elevationRange / 2;
	const totalDistance = Math.max(profile.totalDistanceMeters, Number.EPSILON);

	context.beginPath();
	profile.samples.forEach((sample, index) => {
		const x = plotLeft + (sample.distanceMeters / totalDistance) * (plotRight - plotLeft);
		const normalized = (sample.elevation - rangeMin) / (rangeMax - rangeMin);
		const y = plotBottom - normalized * (plotBottom - plotTop);
		if (index === 0) context.moveTo(x, y);
		else context.lineTo(x, y);
	});
	context.strokeStyle = '#ff1616';
	context.lineWidth = Math.max(8, heightPx * 0.018);
	context.lineCap = 'round';
	context.lineJoin = 'round';
	context.stroke();

	const blob = await env.toBlob(canvas, 'image/png');
	if (!blob) throw new Error('Elevation profile PNG encoding failed. Try again.');
	return blob;
}
