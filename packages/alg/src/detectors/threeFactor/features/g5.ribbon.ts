// g5.ribbon — support-field construction (blur, gradient sampling,
// normalization) and badge-occlusion patching, extracted from ribbon.ts,
// plus fieldScale/supportTau from measure.ts. Baseline: default ON, knobs
// always apply, defaults byte-equal to the pre-extraction literals.
//
// fieldScale/supportTau are NOT threaded as ribbon.ts function parameters:
// they already flow as ThreeFactorParams -> CorridorParams via measure.ts's
// makeParameters (params?.fieldScale ?? DEFAULT_FIELD_SCALE, same for
// supportTau), so re-plumbing them through ribbon.ts's functions would just
// shadow an existing mechanism. Instead engine.ts bridges the resolved knob
// values in at that existing parameter-default site (mirroring the zfit
// "feature -> params bridge" precedent) so a config deviation still reaches
// CorridorParams instead of being silently dropped.
//
// Two knobs (blurRadiusSigmas, insideBadgeMargin's sibling haloBboxMargin,
// and patchAcceptanceThreshold) were missed by the original inventory sweep
// and found on a targeted re-scan of ribbon.ts (see PR discussion / commit
// note) — flagged individually below.

import type { ABFeature } from './types';

export const g5RibbonFeature = {
	id: 'ribbon',
	gate: 'G5',
	kind: 'baseline',
	defaultEnabled: true,
	note: 'Support-field construction (blur, gradient ribbon sampling, normalization) and badge-occlusion patching.',
	knobs: {
		fieldScale: {
			default: 3,
			note: 'support-field downsampling scale factor (was measure.ts DEFAULT_FIELD_SCALE; rides CorridorParams, see file header)'
		},
		supportTau: {
			default: 0.5,
			note: 'support-field gradient percentile threshold (was measure.ts DEFAULT_SUPPORT_TAU; rides CorridorParams, see file header)'
		},
		gaussianSigma: {
			default: 0.8,
			note: 'sigma for the initial gaussian blur of the support field (was GAUSSIAN_SIGMA)'
		},
		blurRadiusSigmas: {
			default: 4,
			note: 'blur kernel radius, as a multiple of gaussianSigma (missed by the original inventory sweep: a THIRD distinct literal "4" in this file, alongside gradientDeltaMultiplier and costMultiplier)'
		},
		gradientDeltaMultiplier: {
			default: 4,
			note: 'multiplier scaling ribbon half-width for edge-difference (gradient) sampling — coincidentally also 4, but a distinct knob from blurRadiusSigmas/costMultiplier'
		},
		normalizationPercentile: {
			default: 0.995,
			note: 'percentile of raw support magnitude used for normalization'
		},
		supportGamma: {
			default: 0.7,
			note: 'gamma exponent for support-field power normalization'
		},
		costMultiplier: {
			default: 4,
			note: 'multiplicative boost to unsupported regions in the routing cost field — coincidentally also 4, but a distinct knob from gradientDeltaMultiplier/blurRadiusSigmas'
		},
		haloSupportThreshold: {
			default: 0.5,
			note: 'support level capped for cells under a badge (halo occlusion) — separate from patchAcceptanceThreshold despite the same value'
		},
		patchReachMargin: {
			default: 6,
			note: 'pixel margin added to badge half-width for patch-search expansion'
		},
		sampleOffsetPx: {
			default: 2.5,
			note: 'symmetric inner/outer offset from ribbon half-width for edge-patch orientation sampling (one knob: the code uses the same value on both sides, half-2.5 and half+2.5)'
		},
		patchOrientations: {
			default: 24,
			note: 'number of angles sampled when testing badge-edge patching'
		},
		centerOuterGrayMargin: {
			default: 8,
			note: 'grayscale difference threshold used to reject a badge-edge patch candidate'
		},
		liftThreshold: {
			default: 45,
			note: 'grayscale lift (inner-outer difference) that normalizes to a full-strength patch score'
		},
		patchAcceptanceThreshold: {
			default: 0.5,
			note: 'minimum patch score (from liftThreshold normalization) before a cell is patched at all (missed by the original inventory sweep — coincidentally also 0.5, but a distinct knob from haloSupportThreshold)'
		},
		patchedCellSupportCap: {
			default: 0.85,
			note: 'maximum support value assigned to a patched cell'
		},
		haloBboxMargin: {
			default: 3,
			note: 'pixel margin expanding a badge bbox for the halo-capping scan (missed by the original inventory sweep; distinct from insideBadgeMargin and from patchReachMargin)'
		},
		insideBadgeMargin: {
			default: 2,
			note: 'pixel margin used by the "is this point inside a badge" occlusion test during patch search (missed by the original inventory sweep; distinct from haloBboxMargin)'
		}
	}
} satisfies ABFeature;
