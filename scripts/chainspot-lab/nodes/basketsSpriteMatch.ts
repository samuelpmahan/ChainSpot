import {
	matchBasketSprites,
	prepareSpriteTemplate,
	type SpriteTemplate
} from '../../../src/lib/nuthing/endpoints';
import { stableLocalEntityId } from '../core/identity';
import { decodeBrightDarkMasks } from './rasterBinary';
import {
	parseJsonObject,
	type BasketsObjectV1,
	type BrightComponentsObjectV1
} from './endpointTypes';

function overlaps(
	component: BrightComponentsObjectV1['components'][number],
	x: number,
	y: number,
	width: number,
	height: number
): boolean {
	const stats = component.stats;
	return (
		stats.bboxX < x + width &&
		stats.bboxX + stats.bboxW > x &&
		stats.bboxY < y + height &&
		stats.bboxY + stats.bboxH > y
	);
}

export function runBasketsSpriteMatch(
	maskBytes: Uint8Array,
	componentBytes: Uint8Array,
	templateBytes: Uint8Array
): BasketsObjectV1 {
	const masks = decodeBrightDarkMasks(maskBytes);
	const components = parseJsonObject<BrightComponentsObjectV1>(componentBytes);
	const template = prepareSpriteTemplate(parseJsonObject<SpriteTemplate>(templateBytes));
	const matches = matchBasketSprites(
		{ width: masks.width, height: masks.height, data: masks.bright },
		template
	);
	return {
		schemaVersion: 1,
		width: masks.width,
		height: masks.height,
		baskets: matches.map((match) => ({
			localId: stableLocalEntityId('basket-sprite-match', {
				bbox: [match.x, match.y, template.w, template.h],
				tip: [match.tipX, match.tipY]
			}),
			match,
			width: template.w,
			height: template.h,
			supportingComponentLocalIds: components.components
				.filter((component) => overlaps(component, match.x, match.y, template.w, template.h))
				.map((component) => component.localId)
		}))
	};
}
