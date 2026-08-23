// g5.routing — bucketed-priority-queue pathfinding geometry (routing.ts's
// `flood`), plus the corridor/route-search parameters from measure.ts's
// makeParameters. Baseline: default ON, knobs always apply, defaults
// byte-equal to the pre-extraction literals.
//
// corridorWidthPx/orientations/widthsSrc/alignmentPower/worstWindowSrcPx are
// NOT threaded as routing.ts/scoring.ts function parameters: they already
// flow as ThreeFactorParams -> CorridorParams via measure.ts's
// makeParameters (same mechanism as g5.ribbon's fieldScale/supportTau), so
// engine.ts's shared params-bridge helper injects the resolved knob values
// at that existing site instead of re-plumbing.
//
// quantum/ring are the bucket-queue's geometry — see the RoutingKnobs doc
// comment in routing.ts and validateRoutingRingQuantum in config.ts for the
// cross-feature invariant with ribbon.costMultiplier that catches a bad
// combination at config-resolve time instead of corrupting routing
// silently.
//
// seedClampRadiusCells was missed by the original inventory sweep (only the
// clamp VALUE, 1.4, was listed) and found on re-scan: the radius (and its
// derived "36" comparison, which is just radius²) shapes how large a
// neighborhood around the search seed gets the softened cost.

import type { ABFeature } from './types';

export const g5RoutingFeature = {
	id: 'routing',
	gate: 'G5',
	kind: 'baseline',
	defaultEnabled: true,
	note: 'Bucketed-priority-queue pathfinding geometry plus the corridor/route-search parameters.',
	knobs: {
		quantum: {
			default: 0.125,
			note: 'distance quantum (bucket width) for the bucketed priority queue in pathfinding (was QUANTUM)',
			validate: (value: unknown) =>
				typeof value === 'number' && Number.isFinite(value) && value > 0
					? null
					: 'quantum must be a positive finite number'
		},
		ring: {
			default: 64,
			note: 'ring buffer size (bucket count) for the pathfinding queue (was RING); see validateRoutingRingQuantum for the cross-feature relationship to quantum and ribbon.costMultiplier',
			validate: (value: unknown) =>
				Number.isInteger(value) && (value as number) > 0 ? null : 'ring must be a positive integer'
		},
		seedCostClamp: {
			default: 1.4,
			note: 'local cost cap applied to the seed neighborhood in pathfinding'
		},
		seedClampRadiusCells: {
			default: 6,
			note: 'radius (field cells) of the seed neighborhood that gets seedCostClamp applied (missed by the original inventory sweep — only the clamp value was recorded, not this radius)'
		},
		corridorWidthPx: {
			default: 37,
			note: 'corridor width in pixels for leg search (was measure.ts DEFAULT_CORRIDOR_WIDTH; rides CorridorParams, see file header)'
		},
		orientations: {
			default: 12,
			note: 'number of angle orientations sampled for routing (was measure.ts DEFAULT_ORIENTATIONS; rides CorridorParams, see file header)'
		},
		widthsSrc: {
			default: [24, 32, 40, 48, 56, 64],
			note: 'width scales for tee-to-tee leg routing (was measure.ts DEFAULT_WIDTHS_SRC; rides CorridorParams, see file header)'
		},
		alignmentPower: {
			default: 2,
			note: 'alignment weighting power for routing (was measure.ts DEFAULT_ALIGNMENT_POWER; rides CorridorParams, see file header)'
		},
		worstWindowSrcPx: {
			default: 90,
			note: 'worst-case search window size in pixels (was measure.ts DEFAULT_WORST_WINDOW; rides CorridorParams, see file header)'
		}
	}
} satisfies ABFeature;
