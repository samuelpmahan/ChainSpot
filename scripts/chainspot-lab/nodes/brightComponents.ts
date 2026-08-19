import { extractComponents } from '../../../src/lib/nuthing/components';
import { stableLocalEntityId } from '../core/identity';
import { decodeBrightDarkMasks } from './rasterBinary';
import type { BrightComponentsObjectV1 } from './endpointTypes';

export function runBrightComponents(maskBytes: Uint8Array): BrightComponentsObjectV1 {
	const masks = decodeBrightDarkMasks(maskBytes);
	const labeled = extractComponents({
		width: masks.width,
		height: masks.height,
		data: masks.bright
	});
	return {
		schemaVersion: 1,
		width: masks.width,
		height: masks.height,
		frame: masks.frame ?? {
			sourceWidth: masks.width,
			sourceHeight: masks.height,
			originX: 0,
			originY: 0
		},
		components: labeled.components.map((stats) => ({
			localId: stableLocalEntityId('bright-component', {
				bbox: [stats.bboxX, stats.bboxY, stats.bboxW, stats.bboxH],
				area: stats.area,
				centroid: [stats.cx, stats.cy]
			}),
			sourceLabel: stats.label,
			stats
		}))
	};
}
