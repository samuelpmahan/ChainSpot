import { detectScreenChromeRegions } from '../../../src/lib/nuthing/screenChrome';
import { stableLocalEntityId } from '../core/identity';
import {
	parseJsonObject,
	type BrightComponentsObjectV1,
	type ChromeAttributionObjectV1
} from './endpointTypes';

function overlapsRegion(
	component: BrightComponentsObjectV1['components'][number],
	region: { x: number; y: number; width: number; height: number }
): boolean {
	const stats = component.stats;
	return (
		stats.bboxX <= region.x + region.width &&
		stats.bboxX + stats.bboxW >= region.x &&
		stats.bboxY <= region.y + region.height &&
		stats.bboxY + stats.bboxH >= region.y
	);
}

export function runChromeScreenSpace(componentBytes: Uint8Array): ChromeAttributionObjectV1 {
	const components = parseJsonObject<BrightComponentsObjectV1>(componentBytes);
	const regions = detectScreenChromeRegions(
		components.components.map((component) => component.stats),
		components.width,
		components.height
	);
	return {
		schemaVersion: 1,
		implementationId: 'chrome.screen-space-v1',
		width: components.width,
		height: components.height,
		regions: regions.map((region) => ({
			localId: stableLocalEntityId('screen-chrome-region', region),
			region,
			componentLocalIds: components.components
				.filter((component) => overlapsRegion(component, region))
				.map((component) => component.localId)
		}))
	};
}
