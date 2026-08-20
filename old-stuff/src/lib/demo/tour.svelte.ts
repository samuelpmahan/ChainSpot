/**
 * ChainSpot guided-demo tour state.
 *
 * A tiny reactive cursor over `DEMO_STEPS` plus the guide rail's collapsed
 * flag. It owns narration position and nothing else — no images, no project
 * state, no editor. That separation is the point: a running tour must be
 * abandonable at any moment without disturbing whatever the visitor has built,
 * and "Exit demo" therefore only has to clear this cursor.
 *
 * Position is mirrored into `sessionStorage` (never `localStorage`) so a full
 * page reload — which clears every in-memory session the product keeps — leaves
 * the visitor reading the same step instead of dumped back at the cover page.
 * Only two small integers and a flag are stored; loaded images and project
 * state deliberately do not survive a reload, exactly as in normal use. The
 * store is treated as untrusted: an out-of-range or malformed value resets to a
 * closed tour rather than throwing on mount, since a private-mode or
 * storage-disabled browser must still be able to run the demo.
 */
import { DEMO_STEPS, DEMO_STEP_COUNT } from './catalog';
import type { DemoStep } from './catalog';

const STORAGE_KEY = 'chainspot.demo.tour';

interface PersistedTour {
	active: boolean;
	stepIndex: number;
	collapsed: boolean;
}

function readPersisted(): PersistedTour | null {
	if (typeof sessionStorage === 'undefined') return null;
	let raw: string | null;
	try {
		raw = sessionStorage.getItem(STORAGE_KEY);
	} catch {
		// Storage can throw outright in some privacy modes; a demo that cannot
		// remember its position is still a working demo.
		return null;
	}
	if (!raw) return null;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== 'object' || parsed === null) return null;
		const record = parsed as Record<string, unknown>;
		const stepIndex = record.stepIndex;
		if (typeof record.active !== 'boolean' || typeof stepIndex !== 'number') return null;
		if (!Number.isInteger(stepIndex) || stepIndex < 0 || stepIndex >= DEMO_STEP_COUNT) return null;
		return {
			active: record.active,
			stepIndex,
			collapsed: record.collapsed === true
		};
	} catch {
		return null;
	}
}

function writePersisted(value: PersistedTour): void {
	if (typeof sessionStorage === 'undefined') return;
	try {
		sessionStorage.setItem(STORAGE_KEY, JSON.stringify(value));
	} catch {
		// Non-fatal: the tour keeps working from memory for this page view.
	}
}

function clearPersisted(): void {
	if (typeof sessionStorage === 'undefined') return;
	try {
		sessionStorage.removeItem(STORAGE_KEY);
	} catch {
		// Non-fatal, as above.
	}
}

export class DemoTour {
	#active = $state(false);
	#stepIndex = $state(0);
	#collapsed = $state(false);

	/** True while the guide rail should be shown over the real routes. */
	get active(): boolean {
		return this.#active;
	}

	/** Zero-based position in `DEMO_STEPS`. */
	get stepIndex(): number {
		return this.#stepIndex;
	}

	/** One-based position, for display. */
	get stepNumber(): number {
		return this.#stepIndex + 1;
	}

	get stepCount(): number {
		return DEMO_STEP_COUNT;
	}

	get step(): DemoStep {
		return DEMO_STEPS[this.#stepIndex];
	}

	get collapsed(): boolean {
		return this.#collapsed;
	}

	get isFirst(): boolean {
		return this.#stepIndex === 0;
	}

	get isLast(): boolean {
		return this.#stepIndex === DEMO_STEP_COUNT - 1;
	}

	/** Restores a tour interrupted by a full page reload. Safe to call twice. */
	restore(): void {
		const persisted = readPersisted();
		if (!persisted) return;
		this.#active = persisted.active;
		this.#stepIndex = persisted.stepIndex;
		this.#collapsed = persisted.collapsed;
	}

	/** Opens the tour at `stepIndex`, defaulting to the first step. */
	start(stepIndex = 0): DemoStep {
		this.#stepIndex = this.#clampIndex(stepIndex);
		this.#active = true;
		this.#collapsed = false;
		this.#persist();
		return this.step;
	}

	goTo(stepIndex: number): DemoStep {
		this.#stepIndex = this.#clampIndex(stepIndex);
		this.#persist();
		return this.step;
	}

	next(): DemoStep {
		return this.goTo(this.#stepIndex + 1);
	}

	previous(): DemoStep {
		return this.goTo(this.#stepIndex - 1);
	}

	setCollapsed(collapsed: boolean): void {
		this.#collapsed = collapsed;
		this.#persist();
	}

	/**
	 * Ends the tour. Everything the visitor loaded stays exactly where it is —
	 * exiting the demo is meant to leave a prospective customer holding a real,
	 * fully usable project, not to reset the app.
	 */
	exit(): void {
		this.#active = false;
		this.#collapsed = false;
		this.#stepIndex = 0;
		clearPersisted();
	}

	#clampIndex(index: number): number {
		if (!Number.isFinite(index)) return 0;
		return Math.min(Math.max(Math.trunc(index), 0), DEMO_STEP_COUNT - 1);
	}

	#persist(): void {
		writePersisted({
			active: this.#active,
			stepIndex: this.#stepIndex,
			collapsed: this.#collapsed
		});
	}
}

/** The single tour shared by `/demo` and the guide rail in the app layout. */
export const demoTour = new DemoTour();
