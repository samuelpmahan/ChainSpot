<script lang="ts">
	/**
	 * The guided-demo rail: a small floating panel that rides along on top of the
	 * real routes while a tour is active.
	 *
	 * It is an overlay and never a wrapper. It does not proxy clicks, gate
	 * controls, or dim the page, because a prospective customer's most valuable
	 * moment is the one where they ignore the script and poke at the product
	 * themselves — the rail has to survive that without losing its place. Every
	 * control it offers is either navigation between narration steps or a call
	 * into the same intake path the route's own controls use.
	 *
	 * Mounted once in the app layout so it persists across client-side
	 * navigation; it renders nothing at all unless a tour is running.
	 */
	import { goto } from '$app/navigation';
	import { base } from '$app/paths';
	import { page } from '$app/state';
	import { onMount, untrack } from 'svelte';
	import { armDemoStep, stepHasArming } from '$lib/demo/arming';
	import { DEMO_STEPS, demoRouteLabel, demoStepUrl } from '$lib/demo/catalog';
	import { demoTour } from '$lib/demo/tour.svelte';

	let armBusy = $state(false);
	let armMessage = $state<string | null>(null);
	let armFailed = $state(false);

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
	 * rail. Without this the cursor stays behind, showing the previous step's
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
	 * The effect must depend on the pathname ONLY. `moveTo` advances the cursor
	 * before its own `goto` resolves; if cursor reads were tracked here, that
	 * window (old pathname, new step) would re-run the fallback against the
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
			// leaves the cursor alone: the rail should wait, not guess.
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
	async function moveTo(index: number): Promise<void> {
		const previousRoute = demoTour.step.route;
		const step = demoTour.goTo(index);
		armMessage = null;
		armFailed = false;
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
	 * place the rail deliberately does not use `goto`: the step's whole point is
	 * that in-memory product state does not survive a real reload, and an SPA
	 * navigation would leave retained editor sessions intact and make that claim
	 * false.
	 */
	function reloadAndAdvance(): void {
		const next = demoTour.goTo(demoTour.stepIndex + 1);
		window.location.assign(demoStepUrl(next));
	}

	async function loadStepInputs(): Promise<void> {
		if (armBusy) return;
		armBusy = true;
		armMessage = null;
		armFailed = false;
		try {
			const step = demoTour.step;
			const result = await armDemoStep(step);
			armMessage = result.message;
			armFailed = !result.ok;
			// Arming fills the destination route's inbox, so a visitor who wandered
			// off the step's route has to be back on it to see anything happen.
			if (result.ok) await goto(demoStepUrl(step));
		} finally {
			armBusy = false;
		}
	}

	function exitDemo(): void {
		demoTour.exit();
		armMessage = null;
		armFailed = false;
	}
</script>

{#if demoTour.active}
	<aside
		class="demo-rail"
		class:collapsed={demoTour.collapsed}
		data-testid="demo-guide"
		data-step-id={demoTour.step.id}
		aria-label="Product walkthrough"
	>
		<header class="rail-header">
			<div class="rail-progress">
				<span class="rail-badge">Demo</span>
				<span data-testid="demo-step-position">Step {demoTour.stepNumber} of {demoTour.stepCount}</span>
				<span class="rail-route">{demoRouteLabel(demoTour.step.route)}</span>
			</div>
			<div class="rail-header-actions">
				<button
					type="button"
					class="ghost"
					data-testid="demo-collapse"
					aria-expanded={!demoTour.collapsed}
					onclick={toggleCollapsed}
				>
					{demoTour.collapsed ? 'Expand' : 'Collapse'}
				</button>
				<button type="button" class="ghost" data-testid="demo-exit" onclick={exitDemo}>
					Exit demo
				</button>
			</div>
		</header>

		{#if !demoTour.collapsed}
			<div class="rail-body">
				<h2 data-testid="demo-step-title">{demoTour.step.title}</h2>
				<p class="lede">{demoTour.step.lede}</p>

				<ol class="actions" data-testid="demo-step-actions">
					{#each demoTour.step.actions as action (action)}
						<li>{action}</li>
					{/each}
				</ol>

				<details class="mechanism">
					<summary>What is actually happening</summary>
					<p>{demoTour.step.mechanism}</p>
				</details>

				{#if armMessage}
					<p
						class="arm-message"
						class:error={armFailed}
						data-testid="demo-arm-message"
						role={armFailed ? 'alert' : 'status'}
					>
						{armMessage}
					</p>
				{/if}
			</div>

			<footer class="rail-footer">
				{#if stepHasArming(demoTour.step)}
					<button
						type="button"
						class="primary"
						data-testid="demo-load-inputs"
						disabled={armBusy}
						onclick={loadStepInputs}
					>
						{armBusy ? 'Loading real inputs…' : 'Load the real inputs'}
					</button>
				{/if}
				<button
					type="button"
					data-testid="demo-previous"
					disabled={demoTour.isFirst || armBusy}
					onclick={() => moveTo(demoTour.stepIndex - 1)}
				>
					Back
				</button>
				{#if demoTour.step.kind === 'reload'}
					<button
						type="button"
						class="primary"
						data-testid="demo-reload"
						disabled={armBusy}
						onclick={reloadAndAdvance}
					>
						Reload the page
					</button>
				{:else if demoTour.isLast}
					<a class="finish-link" href="{base}/demo" data-testid="demo-finish">Finish</a>
				{:else}
					<button
						type="button"
						data-testid="demo-next"
						disabled={armBusy}
						onclick={() => moveTo(demoTour.stepIndex + 1)}
					>
						Next
					</button>
				{/if}
			</footer>
		{/if}
	</aside>
{/if}

<style>
	.demo-rail {
		position: fixed;
		right: max(1rem, env(safe-area-inset-right));
		bottom: max(1rem, env(safe-area-inset-bottom));
		z-index: 60;
		width: min(24rem, calc(100vw - 2rem));
		max-height: min(32rem, calc(100vh - 6rem));
		display: flex;
		flex-direction: column;
		background-color: #18181b;
		border: 1px solid #3f3f46;
		border-radius: 10px;
		box-shadow: 0 18px 40px rgba(0, 0, 0, 0.55);
		color: #e4e4e7;
		font-size: 0.875rem;
	}

	/*
	 * Collapsed, the rail docks bottom-LEFT instead of bottom-right. Even
	 * collapsed it's a pill sitting right on top of whatever corner UI the
	 * current route keeps in the bottom-right — the capture cards' Replace/
	 * Remove buttons on Stitch Map, the on-canvas zoom cluster
	 * (`viewport-zoom-*`) on the annotate/create-graphics panes. The
	 * bottom-right corner is otherwise reserved for the product's own controls;
	 * bottom-left is clear on every route the tour visits.
	 */
	.demo-rail.collapsed {
		max-height: none;
		left: max(1rem, env(safe-area-inset-left));
		right: auto;
		/* A pill only needs to be as wide as "Demo · Step N of 6 · <route> ·
		   Expand · Exit demo" — not the expanded panel's 24rem, which would
		   needlessly reach further across whatever sits at the bottom of the
		   page than the pill's own content does. */
		width: fit-content;
	}

	.rail-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		padding: 0.6rem 0.75rem;
		border-bottom: 1px solid #27272a;
	}

	.demo-rail.collapsed .rail-header {
		border-bottom: none;
	}

	.rail-progress {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.75rem;
		color: #a1a1aa;
		min-width: 0;
	}

	.rail-badge {
		background-color: #2563eb;
		color: #ffffff;
		border-radius: 999px;
		padding: 0.1rem 0.5rem;
		font-weight: 700;
		letter-spacing: 0.02em;
	}

	.rail-route {
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.rail-header-actions {
		display: flex;
		gap: 0.25rem;
		flex: 0 0 auto;
	}

	.rail-body {
		padding: 0.75rem;
		overflow-y: auto;
	}

	.rail-body h2 {
		margin: 0 0 0.4rem;
		font-size: 1rem;
		line-height: 1.3;
		color: #fafafa;
	}

	.lede {
		margin: 0 0 0.6rem;
		color: #d4d4d8;
		line-height: 1.45;
	}

	.actions {
		margin: 0 0 0.6rem;
		padding-left: 1.1rem;
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
		line-height: 1.4;
		color: #e4e4e7;
	}

	.mechanism summary {
		cursor: pointer;
		color: #a1a1aa;
		font-size: 0.8rem;
	}

	.mechanism p {
		margin: 0.4rem 0 0;
		color: #a1a1aa;
		font-size: 0.8rem;
		line-height: 1.45;
	}

	.arm-message {
		margin: 0.6rem 0 0;
		padding: 0.5rem 0.6rem;
		border-radius: 6px;
		background-color: #14532d;
		color: #dcfce7;
		line-height: 1.4;
	}

	.arm-message.error {
		background-color: #7f1d1d;
		color: #fee2e2;
	}

	.rail-footer {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
		padding: 0.6rem 0.75rem;
		border-top: 1px solid #27272a;
	}

	button,
	.finish-link {
		font: inherit;
		border-radius: 6px;
		border: 1px solid #3f3f46;
		background-color: #27272a;
		color: #e4e4e7;
		padding: 0.4rem 0.7rem;
		cursor: pointer;
		text-decoration: none;
		display: inline-flex;
		align-items: center;
	}

	button:hover:not(:disabled),
	.finish-link:hover {
		background-color: #3f3f46;
	}

	button:disabled {
		opacity: 0.55;
		cursor: default;
	}

	button:focus-visible,
	.finish-link:focus-visible {
		outline: 2px solid #3b82f6;
		outline-offset: 1px;
	}

	button.primary {
		background-color: #2563eb;
		border-color: #2563eb;
		color: #ffffff;
		font-weight: 600;
		flex: 1 1 100%;
		justify-content: center;
	}

	button.primary:hover:not(:disabled) {
		background-color: #1d4ed8;
	}

	button.ghost {
		background-color: transparent;
		border-color: transparent;
		color: #a1a1aa;
		padding: 0.25rem 0.45rem;
		font-size: 0.75rem;
	}

	button.ghost:hover {
		background-color: #27272a;
		color: #f4f4f5;
	}

	@media (max-width: 640px) {
		.demo-rail {
			left: max(0.75rem, env(safe-area-inset-left));
			right: max(0.75rem, env(safe-area-inset-right));
			width: auto;
			max-height: min(60vh, 28rem);
		}

		button,
		.finish-link {
			min-height: 2.5rem;
		}
	}
</style>
