// g2.sprite — renderer-family basket detection recovered from the surviving
// LAB smart-basket implementation. Pass 1 recognizes isolated 42x66 bright
// components with the expected white shape and local dark shell. Pass 2
// searches only around known badge/basket occluders for missing family
// members. Ownership remains downstream.

import basketSpriteData from '../assets/basket-sprite.json';
import { DEFAULT_SMART_BASKET_OPTIONS, type SmartBasketOptions } from '../smartBasket';
import type { ABFeature, Drawable, FeatureRender, RunTrace, UnitTrace } from './types';

const ASSET_WIDTH: number = (basketSpriteData as { width: number }).width;
const ASSET_HEIGHT: number = (basketSpriteData as { height: number }).height;

function fraction(value: unknown, name: string): string | null {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
		? null
		: `${name} must be in [0, 1]`;
}

function nonNegative(value: unknown, name: string): string | null {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0
		? null
		: `${name} must be non-negative`;
}

export interface SmartSpriteKnobs extends Required<SmartBasketOptions> {
	readonly spriteWidth: number;
	readonly spriteHeight: number;
}

const BASKETS_UNIT = 'baskets';
const BRIGHT_MASK_ARTIFACT = 'badgeStage.masks.bright';

function verdictOf(drawables: readonly Drawable[], verdict: Drawable['verdict']): Drawable[] {
	return drawables.filter((drawable) => drawable.verdict === verdict);
}

function countByReason(drawables: readonly Drawable[]): Array<[string, number]> {
	const counts = new Map<string, number>();
	for (const drawable of drawables) {
		const reason = drawable.reason ?? '(no reason recorded -- invalid silent drop)';
		counts.set(reason, (counts.get(reason) ?? 0) + 1);
	}
	return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/** The sprite feature owns this plan. LAB only rasterizes its traced geometry. */
export const G2_SPRITE_RENDER: FeatureRender = {
	units: [BASKETS_UNIT],
	draw(unit: UnitTrace, run: RunTrace) {
		const accepted = verdictOf(unit.drawables, 'accepted');
		const rejected = verdictOf(unit.drawables, 'rejected');
		const whiteBounds = verdictOf(unit.drawables, 'info').filter(
			(drawable) => drawable.type === 'box' && drawable.ref?.endsWith(':white-component')
		);
		const semanticTips = verdictOf(unit.drawables, 'info').filter(
			(drawable) => drawable.type === 'point' && drawable.ref?.endsWith(':semantic-tip')
		);
		const notes = [
			`feature:      sprite (g2.sprite) -- ${unit.gate}, trace unit '${unit.id}'`,
			`unit enabled: ${unit.enabled}  (source: UnitTrace.enabled)`,
			`config:       ${run.configName}`,
			`paramsHash:   ${run.paramsHash || 'UNKNOWN -- caller ran the engine without one'}`,
			`unit ms:      ${unit.ms.toFixed(2)}  (source: UnitTrace.ms; wall clock, not quality)`,
			`knobsDeviating: ${unit.knobsDeviating.length ? unit.knobsDeviating.join(', ') : 'none'}  (source: UnitTrace.knobsDeviating)`,
			'',
			`accepted basket candidates: ${accepted.length}   (source: accepted UnitTrace.drawables)`,
			`rejected basket candidates: ${rejected.length}   (source: rejected UnitTrace.drawables)`,
			`examined renderer-family candidates: ${accepted.length + rejected.length}`,
			'',
			'green/red candidate boxes are full-sprite bounds learned from white + associated black family support.',
			'cyan boxes are the detector-local bright connected components and are never emitted as object bounds.',
			'ownership: UNKNOWN -- G2 localizes sprites; downstream assignment owns course-hole ownership.',
			'',
			'rejections by reason:'
		];
		const reasons = countByReason(rejected);
		if (reasons.length === 0) notes.push('  none');
		else for (const [reason, count] of reasons) notes.push(`  ${String(count).padStart(4)} x  ${reason}`);
		for (const measurement of unit.measurements) {
			notes.push(
				`measurement '${measurement.name}': n=${measurement.count} min=${measurement.min} max=${measurement.max} mean=${(measurement.sum / Math.max(1, measurement.count)).toFixed(4)}  (source: UnitTrace.measurements)`
			);
		}
		return {
			title: `g2.sprite -- full basket bounds (${run.configName})`,
			base: BRIGHT_MASK_ARTIFACT,
			layers: [
				{
					name: 'basket full-sprite bounds rejected (G2)',
					note: 'full learned sprite bounding box plus measured rejection testimony',
					drawables: rejected
				},
				{
					name: 'basket full-sprite bounds accepted (G2)',
					note: 'full learned sprite bounding box emitted to downstream evidence',
					drawables: accepted
				},
				{
					name: 'basket white-component bounds (G2)',
					note: 'detector-local bright support, retained separately and never represented as object bounds',
					drawables: whiteBounds
				},
				{
					name: 'basket semantic endpoints (G2)',
					note: 'engine-emitted geometric endpoints; informational only, never ownership',
					drawables: semanticTips
				}
			],
			notes
		};
	}
};

export const g2SpriteFeature = {
	id: 'sprite',
	gate: 'G2',
	kind: 'baseline',
	defaultEnabled: true,
	note: 'Two-pass basket renderer-family detection: intact connected components, then occlusion recovery seeded by known renderer objects.',
	render: G2_SPRITE_RENDER,
	knobs: {
		bboxTolerancePx: {
			default: DEFAULT_SMART_BASKET_OPTIONS.bboxTolerancePx,
			note: 'allowed difference from the 42x66 connected-component family bbox',
			validate: (value: unknown) =>
				Number.isInteger(value) && (value as number) >= 0
					? null
					: 'bboxTolerancePx must be a non-negative integer'
		},
		areaRatioMin: {
			default: DEFAULT_SMART_BASKET_OPTIONS.areaRatioMin,
			validate: (value: unknown) => nonNegative(value, 'areaRatioMin')
		},
		areaRatioMax: {
			default: DEFAULT_SMART_BASKET_OPTIONS.areaRatioMax,
			validate: (value: unknown) => nonNegative(value, 'areaRatioMax')
		},
		cleanWhiteCoverageMin: {
			default: DEFAULT_SMART_BASKET_OPTIONS.cleanWhiteCoverageMin,
			validate: (value: unknown) => fraction(value, 'cleanWhiteCoverageMin')
		},
		cleanDarkShellMin: {
			default: DEFAULT_SMART_BASKET_OPTIONS.cleanDarkShellMin,
			validate: (value: unknown) => fraction(value, 'cleanDarkShellMin')
		},
		cleanDarkCoherenceMin: {
			default: DEFAULT_SMART_BASKET_OPTIONS.cleanDarkCoherenceMin,
			validate: (value: unknown) => fraction(value, 'cleanDarkCoherenceMin')
		},
		shellRadiusPx: {
			default: DEFAULT_SMART_BASKET_OPTIONS.shellRadiusPx,
			validate: (value: unknown) =>
				Number.isInteger(value) && (value as number) >= 1
					? null
					: 'shellRadiusPx must be a positive integer'
		},
		blackConsensusFraction: {
			default: DEFAULT_SMART_BASKET_OPTIONS.blackConsensusFraction,
			validate: (value: unknown) => fraction(value, 'blackConsensusFraction')
		},
		blackConsensusMarginPx: {
			default: DEFAULT_SMART_BASKET_OPTIONS.blackConsensusMarginPx,
			validate: (value: unknown) => nonNegative(value, 'blackConsensusMarginPx')
		},
		recoveryIdentityMin: {
			default: DEFAULT_SMART_BASKET_OPTIONS.recoveryIdentityMin,
			validate: (value: unknown) => fraction(value, 'recoveryIdentityMin')
		},
		recoveryWhiteCoverageMin: {
			default: DEFAULT_SMART_BASKET_OPTIONS.recoveryWhiteCoverageMin,
			validate: (value: unknown) => fraction(value, 'recoveryWhiteCoverageMin')
		},
		recoveryBlackSupportMin: {
			default: DEFAULT_SMART_BASKET_OPTIONS.recoveryBlackSupportMin,
			validate: (value: unknown) => fraction(value, 'recoveryBlackSupportMin')
		},
		recoveryVisibilityMin: {
			default: DEFAULT_SMART_BASKET_OPTIONS.recoveryVisibilityMin,
			validate: (value: unknown) => fraction(value, 'recoveryVisibilityMin')
		},
		highVisibilityMin: {
			default: DEFAULT_SMART_BASKET_OPTIONS.highVisibilityMin,
			validate: (value: unknown) => fraction(value, 'highVisibilityMin')
		},
		dedupeRadiusPx: {
			default: DEFAULT_SMART_BASKET_OPTIONS.dedupeRadiusPx,
			validate: (value: unknown) => nonNegative(value, 'dedupeRadiusPx')
		},
		semanticTipOffsetPx: {
			default: DEFAULT_SMART_BASKET_OPTIONS.semanticTipOffsetPx,
			note: 'offset below the 42x66 family bbox to the pole-tip endpoint',
			validate: (value: unknown) => nonNegative(value, 'semanticTipOffsetPx')
		},
		maxChildrenPerSeed: {
			default: DEFAULT_SMART_BASKET_OPTIONS.maxChildrenPerSeed,
			validate: (value: unknown) =>
				Number.isInteger(value) && (value as number) >= 1
					? null
					: 'maxChildrenPerSeed must be a positive integer'
		},
		spriteWidth: {
			default: ASSET_WIDTH,
			validate: (value: unknown) =>
				value === ASSET_WIDTH
					? null
					: `spriteWidth must match basket-sprite.json width (${ASSET_WIDTH})`
		},
		spriteHeight: {
			default: ASSET_HEIGHT,
			validate: (value: unknown) =>
				value === ASSET_HEIGHT
					? null
					: `spriteHeight must match basket-sprite.json height (${ASSET_HEIGHT})`
		}
	}
} satisfies ABFeature;
