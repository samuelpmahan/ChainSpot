// Z-fit pair rescue as the first retrofitted ABFeature (LAB card
// D10-zfit-pair-rescue). Deviation, default OFF — enabling it makes the
// salvage pass in assignment.ts reachable through the public path for the
// first time (makeParameters used to silently drop the flag).
//
// topK/alignedWorstCeiling are the original retrofit knobs. The rest were
// added per knob-inventory merge note 5: scoring.ts's zfitFactor search
// internals join this SAME feature rather than getting their own file. The
// scoring.ts:178 early-return ceiling is NOT a new knob here — it reuses
// alignedWorstCeiling (see the ZfitKnobs doc comment in scoring.ts for why:
// it is the same aligned-worst quantity checked against the same threshold
// as the salvage gate below, not an independent eligibility concept).
//
// distanceStartOffset/distanceStepPx: the inventory sweep tagged the `+ 8`
// loop start as "distance stride", but the actual per-iteration stride is
// the `+= 14` it missed entirely (over-report rule failure upstream, not an
// extraction error) — split into two correctly-named knobs.
// maxPathOvershootFraction: a second inventory miss found on re-scan of
// zfitFactor (the `> 1.4 * chord` overshoot check), extracted here too.

import type { ABFeature } from './types';

export const zfitFeature = {
	id: 'zfit',
	gate: 'G7',
	kind: 'deviation',
	defaultEnabled: false,
	note: 'Z-shaped route salvage for top-K assignment rows whose corridor support is weak.',
	knobs: {
		topK: {
			default: 80,
			note: 'assignment rows eligible for the salvage re-score (was ZFIT_TOP_K)',
			validate: (value: unknown) =>
				Number.isInteger(value) && (value as number) > 0 ? null : 'topK must be a positive integer'
		},
		alignedWorstCeiling: {
			default: 0.28,
			note: 'skip salvage when the aligned worst-window support is already at/above this (also the zfitFactor early-return ceiling — same check, same value)',
			validate: (value: unknown) =>
				typeof value === 'number' && value >= 0 && value <= 1
					? null
					: 'alignedWorstCeiling must be in [0, 1]'
		},
		distanceStartOffset: {
			default: 8,
			note: 'pixel offset past the first leg length where zfit waypoint search begins'
		},
		distanceStepPx: {
			default: 14,
			note: 'spacing between successive waypoint distances tried in the zfit search'
		},
		maxChordFraction: {
			default: 0.85,
			note: 'maximum detour ratio (of the tee-basket chord) allowed in zfit path search'
		},
		maxAdditionalDistance: {
			default: 220,
			note: 'maximum extra distance beyond the first leg for zfit waypoint searches'
		},
		bendAngles: {
			default: [-60, -45, -30, -20, 0, 20, 30, 45, 60],
			note: 'bend angle samples (degrees) tried at each zfit waypoint'
		},
		bendLengthShort: {
			default: 0.8,
			note: 'shortest bend-segment length, as a multiple of corridor width, tried at each non-zero bend angle'
		},
		bendLengthMedium: {
			default: 1.6,
			note: 'middle bend-segment length, as a multiple of corridor width, tried at each non-zero bend angle'
		},
		bendLengthLong: {
			default: 3,
			note: 'longest bend-segment length, as a multiple of corridor width, tried at each non-zero bend angle'
		},
		maxPathOvershootFraction: {
			default: 1.4,
			note: 'maximum total bent-path length, as a multiple of the direct tee-basket chord, before a candidate waypoint/bend is rejected (missed by the original inventory sweep)'
		},
		bendFactorWithSegment: {
			default: 0.8,
			note: 'score multiplier when the bent path has a non-zero second segment'
		},
		bendFactorWithoutSegment: {
			default: 0.9,
			note: 'score multiplier when the bent path has no second segment (angle bends immediately into the basket leg)'
		},
		scoreMultiplier: {
			default: 0.9,
			note: 'final multiplier applied to every zfit candidate score, on top of the bend factor'
		}
	}
} satisfies ABFeature;
