// g2.sprite — basket matched-filter sprite detection (coarse scan, stride-1
// refinement, matching-pursuit dedupe), extracted from endpoints.ts's
// matchBasketSprites, plus the basket bbox width/height from measure.ts's
// makeBaskets. Baseline: default ON, knobs always apply, defaults byte-equal
// to the pre-extraction literals.
//
// spriteWidth/spriteHeight are STRUCTURALLY COUPLED to the committed
// resources/nuthing-p2/endpoints/basket-sprite.json template asset (loaded
// as assets/basket-sprite.json): matchBasketSprites itself always matches
// using the template's own actual width/height (template.w/template.h, read
// from the JSON at load time), but the reported BasketEvidence.bbox in
// measure.ts's makeBaskets used a hardcoded [42, 66] independent of that —
// coincidentally equal to the asset's real dimensions, not derived from it.
// validate() below checks the configured value against the asset's real
// width/height so a mismatched config value fails at config-resolve time
// with a clear reason instead of silently reporting a basket bbox that
// doesn't match what was actually matched.
//
// coarseThreshold (0.18) and scoreMin (0.28) are two DIFFERENT thresholds on
// the same score formula (onFrac - offFrac): coarseThreshold gates the
// coarse sampled-template pass, scoreMin gates final acceptance after
// stride-1 refinement. scoreMin (0.28) is also coincidentally equal to
// g5.zfit's alignedWorstCeiling (0.28) — a different feature, different
// quantity (aligned worst-window support vs. sprite match score) — no
// relationship, not reused.
//
// NOT extracted: prepareSpriteTemplate's internal `sample(a, 4)` stride —
// see the doc comment on SpriteKnobs in endpoints.ts for why (module-load-
// time singleton, before any config exists).

import basketSpriteData from '../assets/basket-sprite.json';
import type { ABFeature } from './types';

const ASSET_WIDTH: number = (basketSpriteData as { width: number }).width;
const ASSET_HEIGHT: number = (basketSpriteData as { height: number }).height;

export const g2SpriteFeature = {
	id: 'sprite',
	gate: 'G2',
	kind: 'baseline',
	defaultEnabled: true,
	note: 'Basket matched-filter sprite detection: coarse scan, stride-1 refinement, matching-pursuit dedupe.',
	knobs: {
		coarseStride: {
			default: 3,
			note: 'pixel stride for the coarse sprite-matching scan pass (was SPRITE_COARSE_STRIDE)'
		},
		coarseThreshold: {
			default: 0.18,
			note: 'score threshold for coarse sprite-matching peaks (was SPRITE_COARSE_THRESHOLD)'
		},
		scoreMin: {
			default: 0.28,
			note: 'minimum score for final sprite match acceptance, after refinement (was DEFAULT_SPRITE_SCORE_MIN; coincidentally also g5.zfit.alignedWorstCeiling\'s value — see file header, unrelated)'
		},
		tipOffset: {
			default: 4,
			note: 'offset from basket center to the pole-tip annotation point (was BASKET_TIP_OFFSET)'
		},
		coarseGateYOffset: {
			default: 10,
			note: 'y offset (from the sprite top) used by the cheap coarse-pass bright-pixel gate'
		},
		coarseGateXOffset: {
			default: 4,
			note: 'x offset (±) used by the cheap coarse-pass bright-pixel gate'
		},
		refinementRadius: {
			default: 2,
			note: 'stride-1 search radius around each coarse peak during refinement (missed by the original inventory sweep)'
		},
		staleScoreEpsilon: {
			default: 1e-3,
			note: 'minimum score drop, versus the live (partially-erased) mask, before a matching-pursuit candidate is treated as stale and re-scored (missed by the original inventory sweep)'
		},
		spriteWidth: {
			default: 42,
			note: 'reported basket bbox width — see file header on the coupling to the basket-sprite.json asset',
			validate: (value: unknown) =>
				value === ASSET_WIDTH
					? null
					: `spriteWidth must match the basket-sprite.json asset width (${ASSET_WIDTH})`
		},
		spriteHeight: {
			default: 66,
			note: 'reported basket bbox height — see file header on the coupling to the basket-sprite.json asset',
			validate: (value: unknown) =>
				value === ASSET_HEIGHT
					? null
					: `spriteHeight must match the basket-sprite.json asset height (${ASSET_HEIGHT})`
		}
	}
} satisfies ABFeature;
