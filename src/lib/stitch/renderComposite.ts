/**
 * ChainSpot Stitch Map pipeline renderer (CHSPT-50/55): paints a
 * `DraftComposite` (crop + transform + coveragePolygon + paintOrder per
 * source, from `stitchPipeline.ts`/`poseGraph.ts`) to raster bytes and seals
 * `CompositeProvenance`. This is `pipelineResult.ts`'s `renderPipelineComposite`
 * — the ONE function that touches pixels for both N=1 (AutoCrop only,
 * `compositingPolicy: 'single-source-v1'`) and N>1 (Stitch,
 * `'stitch-ascending-bottom-right-v1'`); see `stitchPipeline.ts` for how both
 * paths build the same `DraftComposite` shape and land here identically.
 *
 * RESAMPLING (load-bearing; see `domain/provenance.ts`'s module doc in
 * full): a source whose `transform` is EXACTLY an integer pure translation
 * (`[1,0,0,1,e,f]`, `e`/`f` integers) is painted with a direct pixel copy —
 * the same "no resampling occurs" guarantee today's `render.ts` relies on.
 * Every other source (real rotation, non-uniform/non-integer scale, or
 * shear) is painted by `paintResampled` below: a hand-written, pure-
 * TypeScript nearest-neighbour sampler that inverse-maps each output pixel
 * back into the source's raster space via `invertSourceTransform` and reads
 * one source pixel per output pixel. Nearest-neighbour (`resampling:
 * 'nearest'`, never `'bilinear'`) is the deliberate choice here: bilinear
 * would blend multiple source pixels per output pixel, and while that math
 * is itself perfectly reproducible, it is meaningfully more code (edge
 * handling, weight computation) for a visual-quality gain that is out of
 * scope for CHSPT-50 — the requirement is determinism, not visual quality,
 * and nearest-neighbour is the simplest sampler that satisfies it exactly.
 * Both paths are pure integer/floating-point arithmetic over raw pixel
 * arrays with no browser API in the loop, so they reproduce bit-for-bit
 * across any environment running this same code — unlike a transformed
 * `drawImage`, which browsers do not guarantee that for.
 *
 * `compositeDraftPixels` (the actual per-pixel compositor) is a pure
 * function over already-extracted RGBA buffers with no DOM dependency, so
 * the determinism guarantee above is directly testable by calling it twice
 * with the same inputs and comparing bytes — no canvas/browser needed for
 * that test at all. `renderPipelineComposite` is the thin, DOM-touching
 * wrapper: it extracts each source's pixels via one straight, unscaled 1:1
 * `drawImage`+`getImageData` (an exact copy, not a resampling operation —
 * safe for the same reason pure-translation compositing is), runs the pure
 * compositor, encodes the result, and hashes the encoded bytes.
 */
import { applyAffine6 } from '../geometry/affine6';
import type { Affine6Coefficients } from '../geometry/affine6';
import { invertSourceTransform, sealCompositeProvenance } from '../domain/provenance';
import type { CompositeProvenance, DraftComposite, SourceCapture, SourceTransform } from '../domain/provenance';
import { sha256Hex } from '../imageIntake';
import { MAX_CANVAS_DIMENSION } from './render';
import type { RenderPipelineComposite as RenderPipelineCompositeContract } from './pipelineResult';

export class PipelineRenderError extends Error {
	readonly kind: 'canvas' | 'encode' | 'dimension' | 'missing-source';

	constructor(kind: PipelineRenderError['kind'], message: string) {
		super(message);
		this.name = 'PipelineRenderError';
		this.kind = kind;
	}
}

export interface RgbaBuffer {
	readonly widthPx: number;
	readonly heightPx: number;
	/** RGBA, 4 bytes per pixel, row-major, top-left origin. */
	readonly data: Uint8ClampedArray;
}

export interface PipelineRenderEnv {
	/** Extracts `image`'s pixels at its own native `widthPx x heightPx`, via a straight unscaled 1:1 draw — an exact copy, never a resample. */
	extractSourcePixels(image: HTMLImageElement, widthPx: number, heightPx: number): RgbaBuffer;
	encode(pixels: RgbaBuffer): Promise<Blob>;
}

export const defaultPipelineRenderEnv: PipelineRenderEnv = {
	extractSourcePixels(image, widthPx, heightPx) {
		const canvas = document.createElement('canvas');
		canvas.width = widthPx;
		canvas.height = heightPx;
		const context = canvas.getContext('2d');
		if (!context) {
			throw new PipelineRenderError('canvas', 'Could not allocate an offscreen canvas to read source pixels.');
		}
		context.drawImage(image, 0, 0, widthPx, heightPx);
		const imageData = context.getImageData(0, 0, widthPx, heightPx);
		return { widthPx, heightPx, data: imageData.data };
	},
	encode(pixels) {
		return new Promise((resolve, reject) => {
			const canvas = document.createElement('canvas');
			canvas.width = pixels.widthPx;
			canvas.height = pixels.heightPx;
			const context = canvas.getContext('2d');
			if (!context) {
				reject(new PipelineRenderError('canvas', 'Could not allocate an offscreen canvas to encode the composite.'));
				return;
			}
			const imageData = context.createImageData(pixels.widthPx, pixels.heightPx);
			imageData.data.set(pixels.data);
			context.putImageData(imageData, 0, 0);
			canvas.toBlob((blob) => {
				if (blob) resolve(blob);
				else reject(new PipelineRenderError('encode', 'PNG encoding failed. Try again.'));
			}, 'image/png');
		});
	}
};

/**
 * True only for an EXACT integer pure translation — the one case safe to
 * paint with a direct pixel copy. Exported so `stitchPipeline.ts` can decide
 * `CompositeProvenance.resampling` ('none' vs 'nearest') with the identical
 * criterion this renderer actually paints with, rather than a second,
 * potentially-drifting copy of the same check.
 */
export function integerTranslationOf(transform: SourceTransform): { dxPx: number; dyPx: number } | null {
	const [a, b, c, d, e, f] = transform.coefficients;
	if (a !== 1 || b !== 0 || c !== 0 || d !== 1) return null;
	if (!Number.isInteger(e) || !Number.isInteger(f)) return null;
	return { dxPx: e, dyPx: f };
}

function paintIntegerTranslation(
	output: Uint8ClampedArray,
	outWidthPx: number,
	outHeightPx: number,
	crop: SourceCapture['crop'],
	pixels: RgbaBuffer,
	dxPx: number,
	dyPx: number
): void {
	for (let y = 0; y < crop.heightPx; y += 1) {
		const srcY = crop.yPx + y;
		const dstY = srcY + dyPx;
		if (dstY < 0 || dstY >= outHeightPx || srcY < 0 || srcY >= pixels.heightPx) continue;
		for (let x = 0; x < crop.widthPx; x += 1) {
			const srcX = crop.xPx + x;
			const dstX = srcX + dxPx;
			if (dstX < 0 || dstX >= outWidthPx || srcX < 0 || srcX >= pixels.widthPx) continue;
			const srcIndex = (srcY * pixels.widthPx + srcX) * 4;
			const dstIndex = (dstY * outWidthPx + dstX) * 4;
			output[dstIndex] = pixels.data[srcIndex];
			output[dstIndex + 1] = pixels.data[srcIndex + 1];
			output[dstIndex + 2] = pixels.data[srcIndex + 2];
			output[dstIndex + 3] = pixels.data[srcIndex + 3];
		}
	}
}

/**
 * Hand-written nearest-neighbour resampler (see the module doc comment for
 * why nearest and why hand-written): for every output pixel inside this
 * source's `coveragePolygon` bounding box, inverse-maps the pixel center
 * back into the source's own raster space and copies the single nearest
 * source pixel — the standard destination-to-source direction for image
 * warps, chosen (over forward source-to-destination mapping) specifically
 * because it cannot leave unpainted gaps between adjacent output pixels.
 */
function paintResampled(
	output: Uint8ClampedArray,
	outWidthPx: number,
	outHeightPx: number,
	source: SourceCapture,
	pixels: RgbaBuffer
): void {
	const inverse = invertSourceTransform(source.transform);
	if (!inverse) return;
	const inverseCoefficients: Affine6Coefficients = inverse.coefficients;

	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const corner of source.coveragePolygon) {
		minX = Math.min(minX, corner.xPx);
		maxX = Math.max(maxX, corner.xPx);
		minY = Math.min(minY, corner.yPx);
		maxY = Math.max(maxY, corner.yPx);
	}
	const x0 = Math.max(0, Math.floor(minX));
	const y0 = Math.max(0, Math.floor(minY));
	const x1 = Math.min(outWidthPx - 1, Math.ceil(maxX));
	const y1 = Math.min(outHeightPx - 1, Math.ceil(maxY));
	const crop = source.crop;

	for (let dstY = y0; dstY <= y1; dstY += 1) {
		for (let dstX = x0; dstX <= x1; dstX += 1) {
			// Sample at the pixel's own center — the standard nearest-neighbour
			// convention, then floor to the containing source pixel index.
			const mapped = applyAffine6({ xPx: dstX + 0.5, yPx: dstY + 0.5 }, inverseCoefficients);
			const srcX = Math.floor(mapped.xPx);
			const srcY = Math.floor(mapped.yPx);
			if (
				srcX < crop.xPx ||
				srcY < crop.yPx ||
				srcX >= crop.xPx + crop.widthPx ||
				srcY >= crop.yPx + crop.heightPx ||
				srcX < 0 ||
				srcY < 0 ||
				srcX >= pixels.widthPx ||
				srcY >= pixels.heightPx
			) {
				continue;
			}
			const srcIndex = (srcY * pixels.widthPx + srcX) * 4;
			const dstIndex = (dstY * outWidthPx + dstX) * 4;
			output[dstIndex] = pixels.data[srcIndex];
			output[dstIndex + 1] = pixels.data[srcIndex + 1];
			output[dstIndex + 2] = pixels.data[srcIndex + 2];
			output[dstIndex + 3] = pixels.data[srcIndex + 3];
		}
	}
}

/**
 * Pure per-pixel compositor: no DOM, no canvas, deterministic given the same
 * inputs (the property the renderer determinism test exercises directly).
 * Paints `draft.sources` in ascending `paintOrder`, each via
 * `paintIntegerTranslation` (exact copy) when its `transform` is exactly an
 * integer pure translation, `paintResampled` (nearest-neighbour) otherwise.
 * Output starts fully transparent; a source with a hole in its own coverage
 * (should not occur for a coherent `DraftComposite`) simply leaves those
 * output pixels untouched rather than guessing a fill.
 */
export function compositeDraftPixels(
	draft: DraftComposite,
	sourcePixels: ReadonlyMap<string, RgbaBuffer>
): RgbaBuffer {
	const outWidthPx = draft.outputWidthPx;
	const outHeightPx = draft.outputHeightPx;
	const output = new Uint8ClampedArray(outWidthPx * outHeightPx * 4);

	const paintOrder = [...draft.sources].sort((a, b) => a.paintOrder - b.paintOrder);
	for (const source of paintOrder) {
		const pixels = sourcePixels.get(source.sourceId);
		if (!pixels) {
			throw new PipelineRenderError(
				'missing-source',
				`compositeDraftPixels: no pixel buffer supplied for source '${source.sourceId}'`
			);
		}
		const translation = integerTranslationOf(source.transform);
		if (translation) {
			paintIntegerTranslation(output, outWidthPx, outHeightPx, source.crop, pixels, translation.dxPx, translation.dyPx);
		} else {
			paintResampled(output, outWidthPx, outHeightPx, source, pixels);
		}
	}

	return { widthPx: outWidthPx, heightPx: outHeightPx, data: output };
}

/**
 * `pipelineResult.ts`'s `renderPipelineComposite`: extracts each source's
 * pixels (unscaled 1:1, exact), composites via `compositeDraftPixels`,
 * encodes, and hashes the encoded bytes to seal `CompositeProvenance`. `env`
 * is injectable for deterministic tests (mirroring `render.ts`'s own
 * `StitchRenderEnv` pattern); production code never passes it, defaulting
 * to the real canvas-backed implementation above.
 */
export async function renderPipelineComposite(
	draft: DraftComposite,
	sources: ReadonlyMap<string, HTMLImageElement>,
	env: PipelineRenderEnv = defaultPipelineRenderEnv
): Promise<{ readonly blob: Blob; readonly provenance: CompositeProvenance }> {
	if (draft.outputWidthPx > MAX_CANVAS_DIMENSION || draft.outputHeightPx > MAX_CANVAS_DIMENSION) {
		throw new PipelineRenderError(
			'dimension',
			`The composite output (${draft.outputWidthPx} x ${draft.outputHeightPx}) exceeds the browser's practical canvas limit of ${MAX_CANVAS_DIMENSION} x ${MAX_CANVAS_DIMENSION} pixels.`
		);
	}

	const pixelsBySource = new Map<string, RgbaBuffer>();
	for (const source of draft.sources) {
		const image = sources.get(source.sourceId);
		if (!image) {
			throw new PipelineRenderError(
				'missing-source',
				`renderPipelineComposite: no image supplied for source '${source.sourceId}'`
			);
		}
		pixelsBySource.set(source.sourceId, env.extractSourcePixels(image, source.widthPx, source.heightPx));
	}

	const composite = compositeDraftPixels(draft, pixelsBySource);
	const blob = await env.encode(composite);
	const bytes = new Uint8Array(await blob.arrayBuffer());
	const finalRasterSha256 = await sha256Hex(bytes);
	return { blob, provenance: sealCompositeProvenance(draft, finalRasterSha256) };
}

// Compile-time-only check that `renderPipelineComposite` stays assignable to
// `pipelineResult.ts`'s locked `RenderPipelineComposite` contract (its extra
// `env` parameter is optional, so this is a widening, not a narrowing, of
// that type). Never referenced at runtime.
const _renderContractCheck: RenderPipelineCompositeContract = renderPipelineComposite;
void _renderContractCheck;
