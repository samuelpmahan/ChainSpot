// Z-fit pair rescue as the first retrofitted ABFeature (LAB card
// D10-zfit-pair-rescue). Deviation, default OFF — enabling it makes the
// salvage pass in assignment.ts reachable through the public path for the
// first time (makeParameters used to silently drop the flag).

import type { ABFeature } from './types';

export const zfitFeature = {
	id: 'zfit',
	gate: 'G5',
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
			note: 'skip salvage when the aligned worst-window support is already at/above this',
			validate: (value: unknown) =>
				typeof value === 'number' && value >= 0 && value <= 1
					? null
					: 'alignedWorstCeiling must be in [0, 1]'
		}
	}
} satisfies ABFeature;
