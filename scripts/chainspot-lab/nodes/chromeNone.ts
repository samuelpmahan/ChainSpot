import {
	parseJsonObject,
	type BrightComponentsObjectV1,
	type ChromeAttributionObjectV1
} from './endpointTypes';

export function runChromeNone(componentBytes: Uint8Array): ChromeAttributionObjectV1 {
	const components = parseJsonObject<BrightComponentsObjectV1>(componentBytes);
	return {
		schemaVersion: 1,
		implementationId: 'chrome.none',
		width: components.width,
		height: components.height,
		regions: []
	};
}
