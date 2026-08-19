import { detectBadgeFamily } from '../../../src/lib/nuthing/badgeStage';
import { stableLocalEntityId } from '../core/identity';
import { decodeBrightDarkMasks } from './rasterBinary';
import {
	parseJsonObject,
	type BadgesObjectV1,
	type BrightComponentsObjectV1
} from './endpointTypes';

export function runBadgesDetect(
	maskBytes: Uint8Array,
	componentBytes: Uint8Array
): BadgesObjectV1 {
	const masks = decodeBrightDarkMasks(maskBytes);
	const components = parseJsonObject<BrightComponentsObjectV1>(componentBytes);
	const byLabel = new Map(components.components.map((component) => [component.sourceLabel, component]));
	const badges = detectBadgeFamily(
		components.width,
		{ width: masks.width, height: masks.height, data: masks.dark },
		components.components.map((component) => component.stats)
	);
	return {
		schemaVersion: 1,
		width: components.width,
		height: components.height,
		badges: badges.map((stats) => {
			const component = byLabel.get(stats.label);
			if (!component) throw new Error(`Badge component is missing: label ${stats.label}`);
			return {
				localId: stableLocalEntityId('badge', { componentLocalId: component.localId }),
				componentLocalId: component.localId,
				stats
			};
		})
	};
}
