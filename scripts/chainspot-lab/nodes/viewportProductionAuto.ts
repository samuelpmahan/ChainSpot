import { cropRows, detectMapViewport } from '../../../src/lib/nuthing/viewport';
import { decodeRgbaRaster, encodeRgbaRaster } from './rasterBinary';
import type { ProductionAutoViewportParameters, ViewportCropResult } from './viewportTypes';

export function runProductionAutoViewport(
	inputBytes: Uint8Array,
	parameters: ProductionAutoViewportParameters
): ViewportCropResult {
	if (
		![parameters.topAdjustmentPx, parameters.bottomAdjustmentPx].every(
			(value) => Number.isInteger(value) && value >= 0
		)
	) {
		throw new TypeError('Viewport adjustments must be non-negative integer pixels');
	}
	const image = decodeRgbaRaster(inputBytes);
	const detected = detectMapViewport(image);
	const top = detected.top + parameters.topAdjustmentPx;
	const bottom = detected.bottom - parameters.bottomAdjustmentPx;
	if (top < 0 || bottom > image.height || bottom <= top) {
		throw new RangeError(`Adjusted viewport is outside the raster: [${top}, ${bottom})`);
	}
	return {
		bytes: encodeRgbaRaster(cropRows(image, { top, bottom }), {
			sourceWidth: image.frame.sourceWidth,
			sourceHeight: image.frame.sourceHeight,
			originX: image.frame.originX,
			originY: image.frame.originY + top,
			detectedTop: image.frame.originY + detected.top,
			detectedBottom: image.frame.originY + detected.bottom
		}),
		viewport: {
			detectedTop: detected.top,
			detectedBottom: detected.bottom,
			appliedTop: top,
			appliedBottom: bottom
		}
	};
}
