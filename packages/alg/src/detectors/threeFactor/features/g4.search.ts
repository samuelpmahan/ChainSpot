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
		},
		padClaimOutlierFactor: {
			default: 3,
			note: 'Owner directive 2026-08-28 ("the step-4 input must never come from step 6"): one course-derived geometric bound -- median greedy badge<->tee claim distance on THIS run x this factor, never an absolute pixel literal (150ft holes and 1700ft holes exist) -- shared by BOTH consumers of badge/tee geometry: (1) teeRecovery derives its hunted-badge set from these claims instead of the G6 solver output, whose Heritage H5 mis-pairing (ledger row 27: badge-5 held H4\'s pad from 317px at rank 1) masked a missing tee from the hunt entirely; (2) assignment prunes (badge, tee) pairings beyond the bound before selection, so a scarcity-driven far pairing loses to an empty slot the hunt can then see, with every dropped pairing receipt-named (never a silent prune). Recovered tees are exempt from the distance rule and instead hard-bound to the badge whose strict predicate accepted them.',
			validate: (value: unknown) =>
				typeof value === 'number' && Number.isFinite(value) && value >= 1 && value <= 20
					? null
					: 'padClaimOutlierFactor must be a finite number between 1 and 20'
		}
	}
} satisfies ABFeature;
