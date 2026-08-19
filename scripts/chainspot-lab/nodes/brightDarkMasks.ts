import { computeBrightDarkMasks } from '../../../src/lib/nuthing/raster';
import { decodeRgbaRaster, encodeBrightDarkMasks } from './rasterBinary';

export interface BrightDarkMaskParameters {
	readonly brightVMin: 210;
	readonly brightSMax: 45;
	readonly darkVMax: 45;
}

export function runBrightDarkMasks(inputBytes: Uint8Array): Buffer {
	const image = decodeRgbaRaster(inputBytes);
	const masks = computeBrightDarkMasks(image);
	return encodeBrightDarkMasks({
		width: image.width,
		height: image.height,
		bright: masks.bright.data,
		dark: masks.dark.data,
		frame: image.frame
	});
}
