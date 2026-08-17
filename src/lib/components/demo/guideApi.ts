/**
 * The contract between the guide shell (`DemoGuide.svelte`) and its four
 * presentation components (Baseline, Coach, Spotlight, Mission HUD).
 *
 * There is exactly one walkthrough state machine (`demoTour`) and one set of
 * behaviors (route sync, arming, reload, Back/Next, Exit), all owned by the
 * shell. Presentations read the shared `demoTour` singleton for reactive
 * state and receive these callbacks for every action — they render, and
 * nothing else. A presentation that needs a new behavior gets it added here
 * and implemented once in the shell, never privately.
 */

/** Arming feedback owned by the shell, shared read-only by presentations. */
export interface GuideArmState {
	readonly busy: boolean;
	readonly message: string | null;
	readonly failed: boolean;
}

export interface GuideActions {
	/** Move the narration to `stepIndex`, navigating if the route changes. */
	goToStep(stepIndex: number): Promise<void>;
	/** Advance past the reload step with a real browser reload. */
	reloadAndAdvance(): void;
	/**
	 * Load the current step's real inputs. The one and only path by which the
	 * demo touches product intake — always behind an explicit user click.
	 */
	loadStepInputs(): Promise<void>;
	/** End the tour, leaving all product state exactly where it is. */
	exit(): void;
	/** Toggle the presentation's minimized form (shared across styles). */
	toggleCollapsed(): void;
}

/** Props every presentation component accepts. */
export interface GuidePresentationProps {
	actions: GuideActions;
	arm: GuideArmState;
}
