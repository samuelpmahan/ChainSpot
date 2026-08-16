/**
 * Hand-built `CompositeProvenance` fixtures for CHSPT-55/51 ("Agent D —
 * generic sprite pose") tests. Agent B's real pose-estimation output may not
 * exist in this worktree yet -- `domain/provenance.ts`'s types are fully
 * defined and locked, so these fixtures construct synthetic composites
 * (multiple sources, real rotation/scale in their `SourceTransform`,
 * overlapping coverage polygons) directly, independent of whether Agent B
 * has landed. Every fixture this module produces satisfies
 * `assertCoherentProvenance` -- callers may assert that directly if a test
 * wants to double-check the fixture builder itself, not just the code under
 * test.
 */
import {
	applySourceTransform,
	buildSourceTransform,
	sealCompositeProvenance
} from '../../src/lib/domain/provenance';
import type {
	CompositeProvenance,
	CompositingPolicy,
	DraftComposite,
	SourceCapture,
	SourceCropRect,
	SourceRasterPoint,
	SourceTransform
} from '../../src/lib/domain/provenance';
import type { Affine6Coefficients } from '../../src/lib/geometry/affine6';

/** A fake-but-well-formed 64-hex sha256, distinct per source so `assertCoherentProvenance`'s no-op duplicate check (on `sourceId`, not hash) is never accidentally exercised by a copy-pasted fixture. */
export function fakeSha256(seed: string): string {
	const base = seed.replace(/[^a-f0-9]/gi, '').toLowerCase() || '0';
	return base.repeat(Math.ceil(64 / base.length)).slice(0, 64);
}

/** `[a, b, c, d, e, f]` for a pure rotation + uniform scale (a `'similarity'` transform), translated by `(dxPx, dyPx)`. Matches `domain/provenance.ts`'s `xOut = a*xIn + c*yIn + e`, `yOut = b*xIn + d*yIn + f` convention: the source's local x-axis maps to composite direction `(a, b)`, i.e. appears rotated by `rotationDeg` in composite space. */
export function similarityCoefficients(rotationDeg: number, scale: number, dxPx: number, dyPx: number): Affine6Coefficients {
	const radians = (rotationDeg * Math.PI) / 180;
	const cos = Math.cos(radians);
	const sin = Math.sin(radians);
	return [scale * cos, scale * sin, -scale * sin, scale * cos, dxPx, dyPx];
}

export function similaritySourceTransform(rotationDeg: number, scale: number, dxPx: number, dyPx: number): SourceTransform {
	return buildSourceTransform('similarity', similarityCoefficients(rotationDeg, scale, dxPx, dyPx));
}

/**
 * A `'similarity'` transform for `crop` whose translation is solved so
 * `crop`'s own center lands exactly at `targetCenter` in composite space,
 * regardless of `rotationDeg`/`scale`. Affine maps carry a rectangle's center
 * to its transformed image's centroid, so this is the simplest way to build
 * fixtures where several sources, each at a genuinely different pose, are
 * guaranteed to all cover one shared composite point -- the "2+ sources with
 * different poses in one overlap region" case the ticket calls out, without
 * hand-solving each transform's translation to make the polygons intersect.
 */
export function centeredSimilarityTransform(
	rotationDeg: number,
	scale: number,
	crop: SourceCropRect,
	targetCenter: { readonly xPx: number; readonly yPx: number }
): SourceTransform {
	const centerXPx = crop.xPx + crop.widthPx / 2;
	const centerYPx = crop.yPx + crop.heightPx / 2;
	const [a, b, c, d] = similarityCoefficients(rotationDeg, scale, 0, 0);
	const dxPx = targetCenter.xPx - (a * centerXPx + c * centerYPx);
	const dyPx = targetCenter.yPx - (b * centerXPx + d * centerYPx);
	return buildSourceTransform('similarity', [a, b, c, d, dxPx, dyPx]);
}

function cropCorners(crop: SourceCropRect): readonly SourceRasterPoint[] {
	return [
		{ xPx: crop.xPx, yPx: crop.yPx },
		{ xPx: crop.xPx + crop.widthPx, yPx: crop.yPx },
		{ xPx: crop.xPx + crop.widthPx, yPx: crop.yPx + crop.heightPx },
		{ xPx: crop.xPx, yPx: crop.yPx + crop.heightPx }
	];
}

export interface SourceCaptureFixtureParams {
	readonly sourceId: string;
	readonly widthPx: number;
	readonly heightPx: number;
	readonly crop: SourceCropRect;
	readonly transform: SourceTransform;
	readonly paintOrder: number;
	readonly fileName?: string;
	readonly mimeType?: string;
	readonly sha256?: string;
}

/** Builds one `SourceCapture`, deriving `coveragePolygon` from `transform(crop)` exactly the way `assertCoherentProvenance` requires -- a fixture that doesn't compute this itself would be checking nothing. */
export function sourceCaptureFixture(params: SourceCaptureFixtureParams): SourceCapture {
	return {
		sourceId: params.sourceId,
		fileName: params.fileName ?? `${params.sourceId}.png`,
		mimeType: params.mimeType ?? 'image/png',
		widthPx: params.widthPx,
		heightPx: params.heightPx,
		sha256: params.sha256 ?? fakeSha256(params.sourceId),
		crop: params.crop,
		transform: params.transform,
		coveragePolygon: cropCorners(params.crop).map((corner) => applySourceTransform(corner, params.transform)),
		paintOrder: params.paintOrder
	};
}

export interface CompositeProvenanceFixtureOptions {
	readonly outputWidthPx?: number;
	readonly outputHeightPx?: number;
	readonly compositingPolicy?: CompositingPolicy;
	readonly finalRasterSha256?: string;
}

/** Wraps `sources` (already-built via `sourceCaptureFixture`, in ascending `paintOrder`) into a sealed `CompositeProvenance`. Output extent defaults to a generous bound around every source's `coveragePolygon` so a fixture author rarely needs to compute it by hand. */
export function compositeProvenanceFixture(
	sources: readonly SourceCapture[],
	options: CompositeProvenanceFixtureOptions = {}
): CompositeProvenance {
	const allPoints = sources.flatMap((source) => source.coveragePolygon);
	const maxX = Math.max(...allPoints.map((point) => point.xPx));
	const maxY = Math.max(...allPoints.map((point) => point.yPx));
	const draft: DraftComposite = {
		schemaVersion: 1,
		renderVersion: 'chainspot-stitch-v1',
		outputWidthPx: options.outputWidthPx ?? Math.ceil(maxX) + 10,
		outputHeightPx: options.outputHeightPx ?? Math.ceil(maxY) + 10,
		compositingPolicy: options.compositingPolicy ?? (sources.length === 1 ? 'single-source-v1' : 'stitch-ascending-bottom-right-v1'),
		resampling: sources.length === 1 ? 'none' : 'bilinear',
		sources,
		overlaps: []
	};
	return sealCompositeProvenance(draft, options.finalRasterSha256 ?? fakeSha256('final-raster'));
}
