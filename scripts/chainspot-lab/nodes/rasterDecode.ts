import { decodeImageBytes } from '../../nuthing/decode';
import { encodeRgbaRaster } from './rasterBinary';

export interface RasterDecodeParameters {
	readonly format: 'jpeg' | 'png';
}

export function runRasterDecode(
	sourceBytes: Uint8Array,
	parameters: RasterDecodeParameters
): Buffer {
	return encodeRgbaRaster(decodeImageBytes(sourceBytes, `source.${parameters.format}`));
}
