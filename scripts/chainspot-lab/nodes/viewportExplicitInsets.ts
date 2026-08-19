import { cropRows } from '../../../src/lib/nuthing/viewport';
import { decodeRgbaRaster, encodeRgbaRaster } from './rasterBinary';
import type { ExplicitInsetsViewportParameters, ViewportCropResult } from './viewportTypes';

export function runExplicitInsetsViewport(
	inputBytes: Uint8Array,
	parameters: ExplicitInsetsViewportParameters
): ViewportCropResult {
	if (
		![parameters.topInsetPx, parameters.bottomInsetPx].every(
			(value) => Number.isInteger(value) && value >= 0
		)
	) {
		throw new TypeError('Viewport insets must be non-negative integer pixels');
	}
	const image = decodeRgbaRaster(inputBytes);
	const top = parameters.topInsetPx;
	const bottom = image.height - parameters.bottomInsetPx;
	if (bottom <= top) throw new RangeError(`Explicit viewport is empty: [${top}, ${bottom})`);
	return {
		bytes: encodeRgbaRaster(cropRows(image, { top, bottom }), {
			sourceWidth: image.frame.sourceWidth,
			sourceHeight: image.frame.sourceHeight,
			originX: image.frame.originX,
			originY: image.frame.originY + top,
			detectedTop: image.frame.originY + top,
			detectedBottom: image.frame.originY + bottom
		}),
		viewport: {
			detectedTop: top,
			detectedBottom: bottom,
			appliedTop: top,
			appliedBottom: bottom
		}
	};
}
