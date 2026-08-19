import { collectTeePoints, detectTeeRings, type TeePoint, type TeeRing } from '../../../src/lib/nuthing/endpoints';
import { pointInScreenChrome } from '../../../src/lib/nuthing/screenChrome';
import { stableLocalEntityId } from '../core/identity';
import { decodeBrightDarkMasks } from './rasterBinary';
import {
	parseJsonObject,
	type BadgeEntity,
	type BadgesObjectV1,
	type BasketsObjectV1,
	type BrightComponentEntity,
	type BrightComponentsObjectV1,
	type ChromeAttributionObjectV1,
	type RingEntity,
	type TeeCandidateEntity,
	type TeeCandidatesObjectV1
} from './endpointTypes';

function insideBadge(x: number, y: number, badges: readonly BadgeEntity[]): boolean {
	return badges.some(
		(badge) =>
			x >= badge.stats.bboxX - 3 &&
			x <= badge.stats.bboxX + badge.stats.bboxW + 3 &&
			y >= badge.stats.bboxY - 3 &&
			y <= badge.stats.bboxY + badge.stats.bboxH + 3
	);
}

function componentSupportsRing(component: BrightComponentEntity, ring: TeeRing): boolean {
	const stats = component.stats;
	const x = ring.bboxX - 3;
	const y = ring.bboxY - 3;
	const width = ring.bboxW + 6;
	const height = ring.bboxH + 6;
	return (
		stats.bboxX <= x + width &&
		stats.bboxX + stats.bboxW >= x &&
		stats.bboxY <= y + height &&
		stats.bboxY + stats.bboxH >= y
	);
}

function candidateFromPoint(
	point: TeePoint,
	rings: readonly RingEntity[],
	components: readonly BrightComponentEntity[]
): TeeCandidateEntity {
	if (point.tier === 'ring') {
		const origin = rings.find((entry) => entry.ring === point.ring);
		if (!origin) throw new Error('Tee ring origin is missing');
		return {
			localId: stableLocalEntityId('tee-candidate', { tier: 'ring', origin: origin.localId }),
			cx: point.cx,
			cy: point.cy,
			tier: 'ring',
			originEntityLocalId: origin.localId,
			componentLocalIds: origin.supportingComponentLocalIds
		};
	}
	const origin = components.find(
		(component) => component.stats.cx === point.cx && component.stats.cy === point.cy
	);
	if (!origin) throw new Error(`Fallback component origin is missing at ${point.cx},${point.cy}`);
	return {
		localId: stableLocalEntityId('tee-candidate', { tier: 'component', origin: origin.localId }),
		cx: point.cx,
		cy: point.cy,
		tier: 'component',
		originEntityLocalId: origin.localId,
		componentLocalIds: [origin.localId]
	};
}

export function runTeesCandidates(
	maskBytes: Uint8Array,
	componentBytes: Uint8Array,
	badgeBytes: Uint8Array,
	basketBytes: Uint8Array,
	chromeBytes: Uint8Array
): TeeCandidatesObjectV1 {
	const masks = decodeBrightDarkMasks(maskBytes);
	const components = parseJsonObject<BrightComponentsObjectV1>(componentBytes);
	const badges = parseJsonObject<BadgesObjectV1>(badgeBytes);
	const baskets = parseJsonObject<BasketsObjectV1>(basketBytes);
	const chrome = parseJsonObject<ChromeAttributionObjectV1>(chromeBytes);
	const detectedRings = detectTeeRings({
		width: masks.width,
		height: masks.height,
		data: masks.bright
	});
	const rings: RingEntity[] = detectedRings.map((ring) => ({
		localId: stableLocalEntityId('hollow-ring', {
			center: [ring.cx, ring.cy],
			bbox: [ring.bboxX, ring.bboxY, ring.bboxW, ring.bboxH],
			kind: ring.kind
		}),
		ring,
		supportingComponentLocalIds: components.components
			.filter((component) => componentSupportsRing(component, ring))
			.map((component) => component.localId)
	}));
	const badgeLabels = new Set(badges.badges.map((badge) => badge.stats.label));
	const withoutBadgeRings = detectedRings.filter((ring) => !insideBadge(ring.cx, ring.cy, badges.badges));
	const withoutBadgeComponents = components.components.filter(
		(component) =>
			!badgeLabels.has(component.sourceLabel) &&
			!insideBadge(component.stats.cx, component.stats.cy, badges.badges)
	);
	const spriteCenters = baskets.baskets.map((basket) => basket.match);
	const rawPoints = collectTeePoints(
		withoutBadgeRings,
		withoutBadgeComponents.map((component) => component.stats),
		spriteCenters
	);
	const chromeRegions = chrome.regions.map((region) => region.region);
	const freeRings = withoutBadgeRings.filter(
		(ring) => !pointInScreenChrome(ring.cx, ring.cy, chromeRegions)
	);
	const freeComponents = withoutBadgeComponents.filter(
		(component) =>
			!pointInScreenChrome(component.stats.cx, component.stats.cy, chromeRegions)
	);
	const freePoints = collectTeePoints(
		freeRings,
		freeComponents.map((component) => component.stats),
		spriteCenters
	);
	const rawCandidates = rawPoints.map((point) => candidateFromPoint(point, rings, components.components));
	const candidates = freePoints.map((point) => candidateFromPoint(point, rings, components.components));
	const freeIds = new Set(candidates.map((candidate) => candidate.localId));
	const suppressedCandidates = rawCandidates
		.filter((candidate) => !freeIds.has(candidate.localId))
		.map((candidate) => ({
			...candidate,
			reasonCode: 'screen-chrome-attributed' as const,
			chromeRegionLocalIds: chrome.regions
				.filter((region) => pointInScreenChrome(candidate.cx, candidate.cy, [region.region]))
				.map((region) => region.localId)
		}));
	return {
		schemaVersion: 1,
		width: components.width,
		height: components.height,
		frame: components.frame,
		rings,
		rawCandidates,
		candidates,
		suppressedCandidates
	};
}
