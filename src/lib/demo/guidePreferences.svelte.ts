/**
 * Demo-only presentation preferences (CHSPT-73).
 *
 * A deliberately separate store from `DemoTour`: the tour owns *where the
 * visitor is* in the walkthrough, this owns *how the guide looks while they
 * are there*. Changing a preference must never move the tour cursor, touch
 * product state, or arm an input — it is consumed by the guide shell purely
 * as a rendering choice, so switching styles mid-demo compares presentations
 * over the exact same underlying walkthrough state.
 *
 * Persisted to `sessionStorage` under its own key so the choice survives
 * ordinary route navigation and a mid-tour reload, but — like the tour cursor
 * itself — does not follow the visitor into a new tab or a new session. The
 * store is treated as untrusted exactly as `tour.svelte.ts` treats its own:
 * malformed values fall back to the default rather than throwing.
 *
 * Future demo-only preferences belong here as additional fields on
 * `PersistedDemoPreferences` plus a getter/setter pair, and as a new section
 * in `DemoSettings.svelte` — nothing about this module is specific to guide
 * rendering.
 */

const STORAGE_KEY = 'chainspot.demo.preferences';

/** The four switchable guide presentations. `baseline` is the current rail. */
export type DemoGuideStyle = 'baseline' | 'coach' | 'spotlight' | 'hud';

export interface DemoGuideStyleOption {
	readonly id: DemoGuideStyle;
	readonly label: string;
	/** One line for the settings popover; says how the presentation behaves. */
	readonly blurb: string;
}

export const GUIDE_STYLE_OPTIONS: readonly DemoGuideStyleOption[] = [
	{
		id: 'baseline',
		label: 'Baseline',
		blurb: 'The current corner rail — compact and unobtrusive.'
	},
	{
		id: 'coach',
		label: 'Coach card',
		blurb: 'A larger presenter card with one prominent “do this now” instruction.'
	},
	{
		id: 'spotlight',
		label: 'Spotlight',
		blurb: 'A compact card plus a subtle ring around the real control to use.'
	},
	{
		id: 'hud',
		label: 'Mission HUD',
		blurb: 'A persistent journey strip — Stitch → Annotate → Register → Export.'
	}
];

export const DEFAULT_GUIDE_STYLE: DemoGuideStyle = 'baseline';

function isGuideStyle(value: unknown): value is DemoGuideStyle {
	return GUIDE_STYLE_OPTIONS.some((option) => option.id === value);
}

interface PersistedDemoPreferences {
	guideStyle: DemoGuideStyle;
}

function readPersisted(): PersistedDemoPreferences | null {
	if (typeof sessionStorage === 'undefined') return null;
	let raw: string | null;
	try {
		raw = sessionStorage.getItem(STORAGE_KEY);
	} catch {
		// Storage can throw outright in some privacy modes; the default style
		// is a perfectly good demo.
		return null;
	}
	if (!raw) return null;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== 'object' || parsed === null) return null;
		const record = parsed as Record<string, unknown>;
		if (!isGuideStyle(record.guideStyle)) return null;
		return { guideStyle: record.guideStyle };
	} catch {
		return null;
	}
}

function writePersisted(value: PersistedDemoPreferences): void {
	if (typeof sessionStorage === 'undefined') return;
	try {
		sessionStorage.setItem(STORAGE_KEY, JSON.stringify(value));
	} catch {
		// Non-fatal: the choice keeps working from memory for this page view.
	}
}

export class DemoGuidePreferences {
	#guideStyle = $state<DemoGuideStyle>(DEFAULT_GUIDE_STYLE);

	get guideStyle(): DemoGuideStyle {
		return this.#guideStyle;
	}

	/**
	 * Applies a new guide style. Pure presentation: no navigation, no arming,
	 * no tour-cursor movement — callers rely on that.
	 */
	setGuideStyle(style: DemoGuideStyle): void {
		if (!isGuideStyle(style)) return;
		this.#guideStyle = style;
		writePersisted({ guideStyle: this.#guideStyle });
	}

	/** Restores preferences persisted earlier in this tab. Safe to call twice. */
	restore(): void {
		const persisted = readPersisted();
		if (!persisted) return;
		this.#guideStyle = persisted.guideStyle;
	}
}

/** The single preferences instance shared by the guide shell and settings. */
export const demoGuidePreferences = new DemoGuidePreferences();
