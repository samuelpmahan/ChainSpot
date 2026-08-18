/**
 * Deterministic Stitch Map renderer (CHSPT-50/55) plus CHSPT-79's exact-byte
 * source-landmark evidence registration.
 *
 * Integer translations copy source pixels directly. Any other affine uses a
 * hand-written nearest-neighbour inverse map. The encoded PNG is hashed and
 * that hash seals provenance; source-landmark evidence is registered only
 * after that seal, so Annotate can later require an exact raster-byte match.
 */
import { applyAffine6 } from '../geometry/affine6';
import type { Affine6Coefficients } from '../geometry/affine6';
import { invertSourceTransform, sealCompositeProvenance } from '../domain/provenance';
import type {
	CompositeProvenance,
	DraftComposite,
	SourceCapture,
	SourceTransform
} from '../domain/provenance';
import { sha256Hex } from '../imageIntake';
import { recordRenderedSourceLandmarkEvidence } from '../autoAnnotation/sourceLandmarkBridge';
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
	readonly data: Uint8ClampedArray;
}

export interface PipelineRenderEnv {
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
			throw new PipelineRenderError(
				'canvas',
				'Could not allocate an offscreen canvas to read source pixels.'
			);
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
				reject(
					new PipelineRenderError(
						'canvas',
						'Could not allocate an offscreen canvas to encode the composite.'
					)
				);
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

/** True only for an exact integer pure translation. */
export function integerTranslationOf(
	transform: SourceTransform
): { dxPx: number; dyPx: number } | null {
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
			const mapped = applyAffine6(
				{ xPx: dstX + 0.5, yPx: dstY + 0.5 },
				inverseCoefficients
			);
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

export function compositeDraftPixels(
	draft: DraftComposite,
	sourcePixels: ReadonlyMap<string, RgbaBuffer>
): RgbaBuffer {
	const output = new Uint8ClampedArray(draft.outputWidthPx * draft.outputHeightPx * 4);
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
			paintIntegerTranslation(
				output,
				draft.outputWidthPx,
				draft.outputHeightPx,
				source.crop,
				pixels,
				translation.dxPx,
				translation.dyPx
			);
		} else {
			paintResampled(output, draft.outputWidthPx, draft.outputHeightPx, source, pixels);
		}
	}
	return { widthPx: draft.outputWidthPx, heightPx: draft.outputHeightPx, data: output };
}

export async function renderPipelineComposite(
	draft: DraftComposite,
	sources: ReadonlyMap<string, HTMLImageElement>,
	env: PipelineRenderEnv = defaultPipelineRenderEnv
): Promise<{ readonly blob: Blob; readonly provenance: CompositeProvenance }> {
	if (
		draft.outputWidthPx > MAX_CANVAS_DIMENSION ||
		draft.outputHeightPx > MAX_CANVAS_DIMENSION
	) {
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
		pixelsBySource.set(
			source.sourceId,
			env.extractSourcePixels(image, source.widthPx, source.heightPx)
		);
	}

	const composite = compositeDraftPixels(draft, pixelsBySource);
	const blob = await env.encode(composite);
	const bytes = new Uint8Array(await blob.arrayBuffer());
	const finalRasterSha256 = await sha256Hex(bytes);
	const provenance = sealCompositeProvenance(draft, finalRasterSha256);
	// Evidence registration is observational only. Failure must never make a
	// previously renderable composite fail; exact-byte lookup will simply miss
	// and Annotate retains the historical global path.
	try {
		recordRenderedSourceLandmarkEvidence(provenance);
	} catch (error) {
		console.warn('[ChainSpot handoff] source landmark evidence registration failed.', error);
	}
	return { blob, provenance };
}

const _renderContractCheck: RenderPipelineCompositeContract = renderPipelineComposite;
void _renderContractCheck;
