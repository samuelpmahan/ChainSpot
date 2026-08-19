import type { ComponentStats } from '../../../src/lib/nuthing/components';
import type { ScreenChromeRegion } from '../../../src/lib/nuthing/screenChrome';
import type { SpriteMatch, TeeRing } from '../../../src/lib/nuthing/endpoints';
import type { RasterCoordinateFrame } from './rasterBinary';

export interface BrightComponentEntity {
	readonly localId: string;
	readonly sourceLabel: number;
	readonly stats: ComponentStats;
}

export interface BrightComponentsObjectV1 {
	readonly schemaVersion: 1;
	readonly width: number;
	readonly height: number;
	readonly frame: Pick<RasterCoordinateFrame, 'sourceWidth' | 'sourceHeight' | 'originX' | 'originY'>;
	readonly components: readonly BrightComponentEntity[];
}

export interface BadgeEntity {
	readonly localId: string;
	readonly componentLocalId: string;
	readonly stats: ComponentStats;
}

export interface BadgesObjectV1 {
	readonly schemaVersion: 1;
	readonly width: number;
	readonly height: number;
	readonly badges: readonly BadgeEntity[];
}

export interface BasketEntity {
	readonly localId: string;
	readonly match: SpriteMatch;
	readonly width: number;
	readonly height: number;
	readonly supportingComponentLocalIds: readonly string[];
}

export interface BasketsObjectV1 {
	readonly schemaVersion: 1;
	readonly width: number;
	readonly height: number;
	readonly baskets: readonly BasketEntity[];
}

export interface ChromeRegionEntity {
	readonly localId: string;
	readonly region: ScreenChromeRegion;
	readonly componentLocalIds: readonly string[];
}

export interface ChromeAttributionObjectV1 {
	readonly schemaVersion: 1;
	readonly implementationId: 'chrome.none' | 'chrome.screen-space-v1';
	readonly width: number;
	readonly height: number;
	readonly regions: readonly ChromeRegionEntity[];
}

export interface RingEntity {
	readonly localId: string;
	readonly ring: TeeRing;
	readonly supportingComponentLocalIds: readonly string[];
}

export interface TeeCandidateEntity {
	readonly localId: string;
	readonly cx: number;
	readonly cy: number;
	readonly tier: 'ring' | 'component';
	readonly originEntityLocalId: string;
	readonly componentLocalIds: readonly string[];
}

export interface SuppressedTeeCandidate extends TeeCandidateEntity {
	readonly reasonCode: 'screen-chrome-attributed';
	readonly chromeRegionLocalIds: readonly string[];
}

export interface TeeCandidatesObjectV1 {
	readonly schemaVersion: 1;
	readonly width: number;
	readonly height: number;
	readonly frame: Pick<RasterCoordinateFrame, 'sourceWidth' | 'sourceHeight' | 'originX' | 'originY'>;
	readonly rings: readonly RingEntity[];
	readonly rawCandidates: readonly TeeCandidateEntity[];
	readonly candidates: readonly TeeCandidateEntity[];
	readonly suppressedCandidates: readonly SuppressedTeeCandidate[];
}

export function parseJsonObject<T>(bytes: Uint8Array): T {
	return JSON.parse(Buffer.from(bytes).toString('utf8')) as T;
}
