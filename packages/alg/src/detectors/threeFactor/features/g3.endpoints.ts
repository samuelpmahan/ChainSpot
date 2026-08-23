// g3.endpoints — TEE candidate detection: enclosed-hole ring detection
// (detectTeeRings/detectTeeRingsPass) and the bright-component fallback tier
// (collectTeePoints), extracted from endpoints.ts. Baseline: default ON,
// knobs always apply, defaults byte-equal to the pre-extraction literals.
//
// endpoints.ts also holds the G2 basket-sprite matched-filter constants
// (SPRITE_COARSE_STRIDE, SPRITE_COARSE_THRESHOLD, DEFAULT_SPRITE_SCORE_MIN,
// BASKET_TIP_OFFSET, the coarse-gate y/x offsets) — those belong to the
// separate g2.sprite cluster and are NOT touched here, even though they
// share the file.
//
// teeRingDedupDistance (12) is NOT the g4.scoring ringTolerance knob
// (coincidentally also 12): that one gates basket-to-tee ring membership in
// scoring/assignment/measure; this one dedupes a candidate tee-by-component
// against an already-accepted tee-by-ring, purely within tee detection,
// before assignment ever runs. Coincidental equal value, separate knob.

import type { ABFeature } from './types';

export const g3EndpointsFeature = {
	id: 'endpoints',
	gate: 'G3',
	kind: 'baseline',
	defaultEnabled: true,
	note: 'Enclosed-hole tee-ring detection plus the bright-component fallback tier.',
	knobs: {
		holeAreaMin: {
			default: 10,
			note: 'minimum enclosed dark hole area for tee detection (was HOLE_AREA_MIN)'
		},
		holeAreaMax: {
			default: 480,
			note: 'maximum enclosed dark hole area for tee detection (was HOLE_AREA_MAX)'
		},
		holeDimMax: {
			default: 44,
			note: 'maximum hole bbox dimension, width or height (was HOLE_DIM_MAX)'
		},
		ringBand: {
			default: 3,
			note: 'ring band width (px) for bright-fraction measurement around the hole, and the dilation radius used to grow it (was RING_BAND)',
			validate: (value: unknown) =>
				Number.isInteger(value) && (value as number) >= 0
					? null
					: 'ringBand must be a non-negative integer'
		},
		ringFracMin: {
			default: 0.6,
			note: 'minimum bright fraction in the enclosing ring band (was RING_FRAC_MIN)'
		},
		dilationRadii: {
			default: [0, 1, 2, 3],
			note: 'dilation radii for the multi-scale hole detection passes; detections merge across radii, preferring the smallest'
		},
		largeRadiiThreshold: {
			default: 2,
			note: 'dilation radius at/above which the coarser (largeRadiiAreaMin) hole-area floor applies instead of holeAreaMin (missed by the original inventory sweep — only the resulting area floor, 40, was recorded, not this threshold)'
		},
		largeRadiiAreaMin: {
			default: 40,
			note: 'minimum hole area required for the larger dilation radii (radius >= largeRadiiThreshold)'
		},
		ringMergeProximity: {
			default: 10,
			note: 'distance threshold for merging ring detections found at different dilation radii'
		},
		elongationThreshold: {
			default: 1.18,
			note: 'principal-axis elongation ratio threshold distinguishing tee-rect from diamond (near-square) hole shape'
		},
		componentMinDim: {
			default: 8,
			note: 'minimum component width or height for the bright-component tee fallback tier'
		},
		componentMaxDim: {
			default: 42,
			note: 'maximum component width or height for the bright-component tee fallback tier'
		},
		componentMinArea: {
			default: 80,
			note: 'minimum component area for the bright-component tee fallback tier'
		},
		componentMaxArea: {
			default: 350,
			note: 'maximum component area for the bright-component tee fallback tier'
		},
		componentMinFill: {
			default: 0.2,
			note: 'minimum component fill (area/bbox) for the bright-component tee fallback tier'
		},
		componentMaxFill: {
			default: 0.85,
			note: 'maximum component fill (area/bbox) for the bright-component tee fallback tier'
		},
		teeRingDedupDistance: {
			default: 12,
			note: 'distance threshold excluding a component-tee candidate near an already-accepted ring-tee (coincidentally also 12, but distinct from g4.scoring.ringTolerance — see file header)'
		},
		teeSpriteExclusionDistance: {
			default: 24,
			note: 'distance threshold excluding a component-tee candidate near a matched basket-sprite center'
		}
	}
} satisfies ABFeature;
