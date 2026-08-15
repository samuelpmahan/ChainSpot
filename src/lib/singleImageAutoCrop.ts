/**
 * ChainSpot single-image autocrop for annotate-course / annotate-round uploads.
 *
 * Unlike Stitch Map's cross-tile crop consensus (`stitch/autoCrop.ts`'s
 * `proposeCropDetailed`), a freshly chosen single image has no sibling tile to
 * agree with, so detection here delegates entirely to `proposeSingleImageCrop`
 * — see that function's doc comment for why only a top/bottom phone-chrome
 * band is ever proposed, and only for images that look like real phone
 * screenshots. `detectSingleImageCrop` only ever returns a proposal for the
 * caller (`ImageEditorPane`) to confirm or override; `renderCroppedImage` is
 * the separate, explicit step that actually rasterizes a crop once the user
 * has approved one.
 */
import { toCropRaster } from './stitch/analysis';
import { proposeSingleImageCrop } from './stitch/autoCrop';
import type { SingleImageCropProposal } from './stitch/autoCrop';
import { cropSize } from './stitch/geometry';
import type { CropInsets } from './stitch/geometry';
import { defaultStitchRenderEnv } from './stitch/render';
import type { StitchRenderEnv } from './stitch/render';

/** Proposes a top/bottom crop for one freshly decoded image, or null when there's no evidence to crop. */
export function detectSingleImageCrop(image: HTMLImageElement): SingleImageCropProposal {
	return proposeSingleImageCrop(toCropRaster(image));
}

export class SingleImageCropError extends Error {}

/**
 * Renders `image` cropped to `insets` as a same-`mimeType` Blob, at native
 * resolution (no resampling — identical source and destination sizes).
 */
export async function renderCroppedImage(
	image: HTMLImageElement,
	widthPx: number,
	heightPx: number,
	insets: CropInsets,
	mimeType: string,
	env: StitchRenderEnv = defaultStitchRenderEnv
): Promise<Blob> {
	const validation = cropSize(insets, widthPx, heightPx);
	if (!validation.ok) {
		throw new SingleImageCropError('The crop removes the entire image; adjust the values.');
	}
	const canvas = env.createCanvas();
	canvas.width = validation.widthPx;
	canvas.height = validation.heightPx;
	const context = canvas.getContext('2d');
	if (!context) {
		throw new SingleImageCropError('Could not allocate a canvas to crop the image.');
	}
	context.drawImage(
		image,
		insets.leftPx,
		insets.topPx,
		validation.widthPx,
		validation.heightPx,
		0,
		0,
		validation.widthPx,
		validation.heightPx
	);
	const blob = await env.toBlob(canvas, mimeType);
	if (!blob) {
		throw new SingleImageCropError('Encoding the cropped image failed. Try again.');
	}
	return blob;
}
