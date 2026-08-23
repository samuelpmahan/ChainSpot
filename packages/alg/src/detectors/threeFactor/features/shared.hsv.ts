// shared.hsv — bright/dark pixel-mask thresholds, extracted from
// raster.ts's computeBrightDarkMasks. Baseline: default ON, knobs always
// apply, defaults byte-equal to the pre-extraction literals.
//
// WIDEST BLAST RADIUS of any cluster: bright/dark masks feed EVERY
// downstream gate (badges, baskets, tees, screen chrome...). Verified there
// is exactly ONE call site of computeBrightDarkMasks — badgeStage.ts's
// runBadgeStage, itself called exactly once from measure.ts's 'badgeStage'
// EngineUnit — so resolving this feature there reaches the whole pipeline;
// there is no second mask-building call site threading could miss.
//
// brightSMax and darkVMax are different HSV axes despite both being 45:
//   S (saturation) = how COLORFUL a pixel is (0 = gray, 255 = fully saturated)
//   V (value)      = how BRIGHT a pixel is (0 = black, 255 = full brightness)
// brightSMax caps saturation for the "bright" mask (near-white/gray only);
// darkVMax caps brightness for the "dark" mask (near-black). Coincidentally
// equal value, unrelated axes, separate knobs.
//
// HSV_SHIFT (12, bit-shift precision for the fixed-point OpenCV-identical
// saturation table) stays a literal per knob-inventory merge note 3 — it's
// the fixed-point radix the reference algorithm's exact reproduction
// requires, not an experiment dimension.

import type { ABFeature } from './types';

export const sharedHsvFeature = {
	id: 'hsv',
	gate: 'shared',
	kind: 'baseline',
	defaultEnabled: true,
	note: 'Bright/dark pixel-mask HSV thresholds feeding every downstream gate.',
	knobs: {
		brightVMin: {
			default: 210,
			note: 'minimum V (brightness) for bright-pixel classification (was BRIGHT_V_MIN)'
		},
		brightSMax: {
			default: 45,
			note: 'maximum S (saturation — colorfulness) for bright-pixel classification (was BRIGHT_S_MAX); coincidentally also 45, but a different HSV axis from darkVMax — see file header'
		},
		darkVMax: {
			default: 45,
			note: 'maximum V (brightness) for dark-pixel classification (was DARK_V_MAX); coincidentally also 45, but a different HSV axis from brightSMax — see file header'
		}
	}
} satisfies ABFeature;
