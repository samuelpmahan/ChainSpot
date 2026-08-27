// g4.search — assignment search tunables: candidate-row windows, exchange
// pass limits, and the recovered-tee dedupe distance. All four knobs are
// internal to assignment.ts's local-search optimizer. IMPROVEMENT_EPSILON
// stays a literal per knob-inventory merge note 3 (numerical guard, not an
// experiment dimension). Baseline: default ON, knobs always apply, defaults
// byte-equal to the pre-extraction literals.

import type { ABFeature } from './types';

export const g4SearchFeature = {
	id: 'search',
	gate: 'G6',
	kind: 'baseline',
	defaultEnabled: true,
	note: 'Assignment local search: candidate-row windows, pairwise exchange passes, recovered-tee dedupe.',
	knobs: {
		assignTopRows: {
			default: 60,
			note: 'window size (top-N by score) of candidate pairs per badge kept for the search (was ASSIGN_TOP_ROWS)'
		},
		exchangeTopK: {
			default: 12,
			note: 'top-k limit per badge for pairwise exchange optimization (was EXCHANGE_TOP_K)'
		},
		maxAssignPasses: {
			default: 60,
			note: 'iteration limit for the assignment optimization loop (was MAX_ASSIGN_PASSES)'
		},
		recoveredTeeDedupeDistance: {
			default: 14,
			note: 'minimum separation (px) between a recovered tee and an existing tee before it is dropped as a duplicate'
		}
	}
} satisfies ABFeature;
