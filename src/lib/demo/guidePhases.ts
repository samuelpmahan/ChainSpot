/**
 * The Mission HUD's phase model: the six-step walkthrough script grouped into
 * the workflow journey a first-time visitor should keep in view — Stitch →
 * Annotate → On air → Register → Export.
 *
 * Purely a presentation grouping over `DEMO_STEPS`; it owns no state and adds
 * nothing to the tour machine. Phases must cover every step exactly once and
 * in script order (contiguously), which `demoGuidePhases.test.ts` pins, so a
 * catalog change that reorders or adds steps fails loudly here instead of
 * rendering a silently wrong journey strip.
 */
import { DEMO_STEPS } from './catalog';

export interface DemoPhase {
	readonly id: string;
	/** Short label for the persistent strip. */
	readonly label: string;
	/** Step ids from `DEMO_STEPS`, contiguous and in script order. */
	readonly stepIds: readonly string[];
}

export const DEMO_PHASES: readonly DemoPhase[] = [
	{ id: 'stitch', label: 'Stitch', stepIds: ['stitch'] },
	{ id: 'annotate', label: 'Annotate', stepIds: ['annotate-course'] },
	{ id: 'air', label: 'On air', stepIds: ['basemap-and-export'] },
	{ id: 'register', label: 'Register', stepIds: ['reload', 'map-round'] },
	{ id: 'export', label: 'Export', stepIds: ['export-round'] }
];

export type DemoPhaseStatus = 'completed' | 'current' | 'upcoming';

/** Index into `DEMO_PHASES` of the phase containing the step at `stepIndex`. */
export function phaseIndexForStep(stepIndex: number): number {
	const stepId = DEMO_STEPS[stepIndex]?.id;
	const index = DEMO_PHASES.findIndex((phase) => phase.stepIds.includes(stepId));
	return index >= 0 ? index : 0;
}

/** Status of the phase at `phaseIndex` while the tour sits on `stepIndex`. */
export function phaseStatus(phaseIndex: number, stepIndex: number): DemoPhaseStatus {
	const current = phaseIndexForStep(stepIndex);
	if (phaseIndex < current) return 'completed';
	if (phaseIndex > current) return 'upcoming';
	return 'current';
}
