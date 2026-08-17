<script lang="ts">
	/**
	 * The guided-demo shell: owns every walkthrough *behavior* — route
	 * synchronization, Back/Next movement, the real-reload step, explicit
	 * input arming, exit, collapse defaults — and delegates all *rendering*
	 * to one of four presentation components selected by the Demo Settings
	 * guide-style preference (CHSPT-73):
	 *
	 *   baseline  → BaselineGuide  (the original corner rail)
	 *   coach     → CoachGuide     (large presenter card)
	 *   spotlight → SpotlightGuide (compact card + anchor ring)
	 *   hud       → MissionHud     (persistent journey strip)
	 *
	 * There is exactly one tour state machine (`demoTour`) regardless of
	 * presentation; switching styles swaps markup in place and must never
	 * navigate, move the cursor, touch product state, or arm an input.
	 *
	 * The guide is an overlay and never a wrapper. It does not proxy clicks,
	 * gate controls, or dim the page, because a prospective customer's most
	 * valuable moment is the one where they ignore the script and poke at the
	 * product themselves — the guide has to survive that without losing its
	 * place. Every control it offers is either navigation between narration
	 * steps or a call into the same intake path the route's own controls use.
	 *
	 * Mounted once in the app layout so it persists across client-side
	 * navigation; it renders nothing at all unless a tour is running.
	 */
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { onMount, untrack } from 'svelte';
	import { armDemoStep } from '$lib/demo/arming';
	import { DEMO_STEPS, demoStepUrl } from '$lib/demo/catalog';
	import { demoGuidePreferences } from '$lib/demo/guidePreferences.svelte';
	import { demoTour } from '$lib/demo/tour.svelte';
	import BaselineGuide from './demo/BaselineGuide.svelte';
	import CoachGuide from './demo/CoachGuide.svelte';
	import { demoSettingsUi } from './demo/settingsState.svelte';
	import type { GuideActions } from './demo/guideApi';
	import MissionHud from './demo/MissionHud.svelte';
	import SpotlightGuide from './demo/SpotlightGuide.svelte';

	const arm = $state({ busy: false, message: null as string | null, failed: false });

	const PRESENTATIONS = {
		baseline: BaselineGuide,
		coach: CoachGuide,
		spotlight: SpotlightGuide,
		hud: MissionHud
	} as const;

	const Presentation = $derived(PRESENTATIONS[demoGuidePreferences.guideStyle]);

	// The rail's expanded form is comfortable on a wide monitor and crowded on a
	// 13" laptop. Below this width it opens collapsed by default; above it, the
	// original expanded-by-default behavior is unchanged.
	const NARROW_VIEWPORT_MAX_WIDTH = 1280;
	const COLLAPSE_PREF_KEY = 'chainspot.demo.railCollapsed';

	/**
	 * A visitor's own expand/collapse choice, remembered in `localStorage` (a
	 * standing preference, unlike the per-run tour position in `sessionStorage`)
	 * so it always wins over the viewport-based default below.
	 */
	function readCollapsePreference(): boolean | null {
		try {
			const raw = localStorage.getItem(COLLAPSE_PREF_KEY);
			if (raw === 'true') return true;
			if (raw === 'false') return false;
		} catch {
			// Storage can throw outright in some privacy modes; fall through to
			// the viewport-based default.
		}
		return null;
	}

	function writeCollapsePreference(collapsed: boolean): void {
		try {
			localStorage.setItem(COLLAPSE_PREF_KEY, String(collapsed));
		} catch {
			// Non-fatal: the choice just won't be remembered for next time.
		}
	}

	function toggleCollapsed(): void {
		const next = !demoTour.collapsed;
		demoTour.setCollapsed(next);
		writeCollapsePreference(next);
	}

	/**
	 * Applies the initial collapsed state for a tour that just started fresh in
	 * this tab. A stored preference always wins; otherwise the rail opens
	 * collapsed on narrow viewports and expanded on wide ones (today's default).
	 */
	function applyInitialCollapseDefault(): void {
		const preference = readCollapsePreference();
		if (preference !== null) {
			if (preference !== demoTour.collapsed) demoTour.setCollapsed(preference);
			return;
		}
		if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
		if (window.matchMedia(`(max-width: ${NARROW_VIEWPORT_MAX_WIDTH}px)`).matches) {
			demoTour.setCollapsed(true);
		}
	}

	// True only for the one mount where `restore()` resumes a tour that was
	// already active (a full-page reload mid-tour) — that resumed `collapsed`
	// value must be left alone, never re-defaulted.
	let skipNextActivationDefault = false;

	onMount(() => {
		demoTour.restore();
		demoGuidePreferences.restore();
		skipNextActivationDefault = demoTour.active;
	});

	// Fires once when the tour transitions from inactive to active. On the
	// initial mount that only happens via a resumed (reloaded) tour, which the
	// flag above skips; every later transition is a fresh "Start demo" click,
	// which gets the narrow-viewport default applied.
	$effect(() => {
		const active = demoTour.active;
		untrack(() => {
			if (!active) return;
			if (skipNextActivationDefault) {
				skipNextActivationDefault = false;
				return;
			}
			applyInitialCollapseDefault();
		});
	});

	/**
	 * Keeps the narration on the route the visitor is actually looking at.
	 *
	 * The script deliberately tells visitors to advance using the product's own
	 * controls — "Use as UDisc source" on Stitch Map, "Done" on Annotate Course
	 * or Map Round — and those call `goto` directly, knowing nothing about this
	 * guide. Without this the cursor stays behind, showing the previous step's
	 * instructions and, worse, a "Load the real inputs" button that would
	 * navigate the visitor backward and re-trigger Smart Import's replace
	 * confirmation.
	 *
	 * Only a pathname that no longer matches the current step moves the cursor.
	 * One route is still visited more than once (Create Graphics runs the
	 * basemap/export step, the reload step, and the export-the-round step —
	 * Annotate Course and Map Round split what used to be Annotate Round's two
	 * repeated visits into their own distinct routes, one visit each), so a
	 * match on the current step must always win over the fallback lookup below
	 * — the fallback is only ever a guess for when the current step's own URL
	 * stopped matching.
	 *
	 * That fallback prefers the *nearest step at or after the current position*
	 * that matches the route, falling back further to the first occurrence in
	 * the script only when none exists ahead. A plain first-match `findIndex`
	 * would always resolve a repeated route to its earliest step — correct when
	 * a repeated route's steps run contiguously, but wrong here: navigating
	 * from the reload step (script position 4) to Create Graphics via the
	 * product's own header link must land on the export-the-round step (6),
	 * not snap back to the basemap step (3).
	 *
	 * The effect must depend on the pathname ONLY. `goToStep` advances the
	 * cursor before its own `goto` resolves; if cursor reads were tracked here,
	 * that window (old pathname, new step) would re-run the fallback against the
	 * stale route and drag the cursor backward — with repeated routes it then
	 * "corrects" to the wrong occurrence after the navigation lands.
	 */
	$effect(() => {
		const pathname = page.url.pathname;
		untrack(() => {
			if (!demoTour.active) return;
			if (pathname === demoStepUrl(demoTour.step)) return;
			const currentIndex = demoTour.stepIndex;
			let index = DEMO_STEPS.findIndex(
				(step, candidateIndex) => candidateIndex > currentIndex && demoStepUrl(step) === pathname
			);
			if (index < 0) index = DEMO_STEPS.findIndex((step) => demoStepUrl(step) === pathname);
			// A route outside the script (the visitor wandered off to Ribbon Goldens)
			// leaves the cursor alone: the guide should wait, not guess.
			if (index >= 0) demoTour.goTo(index);
		});
	});

	/**
	 * Moves the narration and, when the next step lives on another route, takes
	 * the visitor there. Staying put when the route is unchanged matters: the
	 * basemap/export step and the reload step both run on Create Graphics, and
	 * re-navigating between them would throw away the basemap and
	 * correspondences the visitor just created.
	 */
	async function goToStep(index: number): Promise<void> {
		const previousRoute = demoTour.step.route;
		const step = demoTour.goTo(index);
		arm.message = null;
		arm.failed = false;
		if (step.route !== previousRoute) {
			await goto(demoStepUrl(step));
		}
	}

	/**
	 * Advances past a `kind: 'reload'` step with a real browser reload instead
	 * of an SPA `goto`. `demoTour.goTo` persists the *next* step's position to
	 * `sessionStorage` before the navigation fires, so the reload's `restore()`
	 * (see `tour.svelte.ts`) resumes the tour already on the reload step's
	 * successor rather than back on the reload step itself. This is the one
	 * place the guide deliberately does not use `goto`: the step's whole point
	 * is that in-memory product state does not survive a real reload, and an
	 * SPA navigation would leave retained editor sessions intact and make that
	 * claim false.
	 */
	function reloadAndAdvance(): void {
		const next = demoTour.goTo(demoTour.stepIndex + 1);
		window.location.assign(demoStepUrl(next));
	}

	async function loadStepInputs(): Promise<void> {
		if (arm.busy) return;
		arm.busy = true;
		arm.message = null;
		arm.failed = false;
		try {
			const step = demoTour.step;
			const result = await armDemoStep(step);
			arm.message = result.message;
			arm.failed = !result.ok;
			// Arming fills the destination route's inbox, so a visitor who wandered
			// off the step's route has to be back on it to see anything happen.
			if (result.ok) await goto(demoStepUrl(step));
		} finally {
			arm.busy = false;
		}
	}

	function exitDemo(): void {
		demoTour.exit();
		arm.message = null;
		arm.failed = false;
		// The popover's open flag is module-level so it survives presentation
		// swaps; without this reset it would also survive Exit demo and pop
		// open unrequested on the next tour start.
		demoSettingsUi.open = false;
	}

	const actions: GuideActions = {
		goToStep,
		reloadAndAdvance,
		loadStepInputs,
		exit: exitDemo,
		toggleCollapsed
	};
</script>

{#if demoTour.active}
	<Presentation {actions} {arm} />
{/if}
