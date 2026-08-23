// g1.digits — badge digit segmentation (noise/height/wide-merge gates,
// valley-split search window) and canonical digit-mask normalization,
// extracted from digits/segment.ts and digits/normalize.ts. Baseline:
// default ON, knobs always apply, defaults byte-equal to the
// pre-extraction literals.
//
// MODEL COUPLING (digitW/digitH): investigated and CONFIRMED. The trained
// digit classifier (assets/logistic.json) stores one weight ROW per class,
// each of length 768 — logisticInference.ts's predictProbs even falls back
// to `?? 768` when reading the row length, and its own doc comment calls it
// "One 10x768 matrix multiply". 768 = 24 x 32 = the exact DIGIT_W x DIGIT_H
// pre-extraction literals: normalizeDigitMask flattens the normalized mask
// row-major and readBadges.ts feeds it straight into the model as the
// feature vector, position-for-position. The model was trained on exactly
// this flattened 24x32 layout; changing digitW or digitH — even without
// changing their product — would misalign or resize the feature vector and
// silently corrupt every digit prediction (no crash: extra/missing features
// just multiply against the wrong weights or read past the mask). Verified
// directly against the committed asset: W[0].length === 768 (checked via a
// one-off read of assets/logistic.json), and MODEL_FEATURE_COUNT below
// re-derives that same 768 from the loaded model at import time as a
// standing tripwire — if the asset is ever swapped for a differently-shaped
// model without updating this file, the registry fails to load instead of
// quietly producing garbage predictions.
//
// Each dimension is validated independently against its known-trained
// value (not just checking digitW*digitH === 768): the model was trained on
// this specific WxH split, not merely on 768 total pixels, so e.g. 32x24
// would pass a product check but still be wrong.
//
// VALLEY_SEARCH_LO/HI ordered-pair investigation: an inverted or degenerate
// pair (lo >= hi) is NOT corrupting. trySplit's own `if (hi <= lo)` guard
// (segment.ts) already treats that as "no valid interior search window" and
// falls back to keeping the component whole — the exact same safe path a
// too-narrow component takes today. It just disables valley-splitting (a
// useless, not unsafe, configuration), so unlike g5.routing/g5.ribbon's
// ring*quantum invariant, this does NOT need a resolveConfig-level
// cross-knob check — there is nothing for one to guard against. See the
// DigitsKnobs doc comment in segment.ts for the same finding in-code.
//
// Over-report re-scan: segment.ts and normalize.ts have no further tunables
// (remaining literals are numerical guards, identities, or the already-
// excluded 0.5 center-pixel sampling offset). badgeGlyph.ts and
// readBadges.ts were checked too, per the cluster's caution — confirmed
// empty: both are pure bbox/argmax bookkeeping with no threshold literals.

import logisticModelData from '../assets/logistic.json';
import type { ABFeature } from './types';

const MODEL_FEATURE_COUNT: number =
	(logisticModelData as { W: readonly (readonly number[])[] }).W[0]?.length ?? 0;

// Standing tripwire: fails at REGISTRY IMPORT time (before any config is
// even parsed) if the committed model asset's shape ever drifts out of sync
// with the digitW/digitH this file assumes.
if (24 * 32 !== MODEL_FEATURE_COUNT) {
	throw new Error(
		`g1.digits: assets/logistic.json's weight rows are length ${MODEL_FEATURE_COUNT}, expected 768 ` +
			`(24x32) — the model asset and digitW/digitH have drifted out of sync; retrain the model or ` +
			`update the knob defaults together, not separately.`
	);
}

export const g1DigitsFeature = {
	id: 'digits',
	gate: 'G1',
	kind: 'baseline',
	defaultEnabled: true,
	note: 'Badge digit segmentation (noise/height/wide-merge gates) and canonical digit-mask normalization.',
	knobs: {
		minComponentArea: {
			default: 6,
			note: 'minimum pixel area for a connected component to be a digit candidate (was MIN_COMPONENT_AREA)'
		},
		heightRatioMin: {
			default: 0.5,
			note: 'minimum height, as a fraction of the tallest surviving component, for a digit candidate (was HEIGHT_RATIO_MIN)'
		},
		wideRatio: {
			default: 0.95,
			note: 'width-to-height ratio threshold for detecting a merged (touching) digit pair (was WIDE_RATIO)'
		},
		valleySearchLo: {
			default: 0.3,
			note: 'lower bound (fraction of width) for the interior valley-search window (was VALLEY_SEARCH_LO); see file header — an inverted pair vs. valleySearchHi is safe, not corrupting'
		},
		valleySearchHi: {
			default: 0.7,
			note: 'upper bound (fraction of width) for the interior valley-search window (was VALLEY_SEARCH_HI); see file header — an inverted pair vs. valleySearchLo is safe, not corrupting'
		},
		digitW: {
			default: 24,
			note: 'normalized digit mask width fed to the trained classifier (was DIGIT_W) — see file header on the model coupling',
			validate: (value: unknown) =>
				value === 24
					? null
					: `digitW must equal 24 — the trained digit classifier (assets/logistic.json, ${MODEL_FEATURE_COUNT}-length weight rows = 24x32 flattened) was trained on exactly this size; changing it requires retraining the model.`
		},
		digitH: {
			default: 32,
			note: 'normalized digit mask height fed to the trained classifier (was DIGIT_H) — see file header on the model coupling',
			validate: (value: unknown) =>
				value === 32
					? null
					: `digitH must equal 32 — the trained digit classifier (assets/logistic.json, ${MODEL_FEATURE_COUNT}-length weight rows = 24x32 flattened) was trained on exactly this size; changing it requires retraining the model.`
		}
	}
} satisfies ABFeature;
