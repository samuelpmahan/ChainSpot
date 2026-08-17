<script lang="ts">
	/**
	 * Mission HUD presentation: a persistent, compact journey strip —
	 * Stitch → Annotate → On air → Register → Export — that keeps the whole
	 * workflow legible while six individual steps run underneath it, plus an
	 * expandable "current mission" card for the active step.
	 *
	 * The strip sits bottom-center (both bottom corners belong to product
	 * controls on the routes the tour visits) and stays small; the mission
	 * card is what `collapsed` hides, so the persistent footprint is one
	 * short bar. Same tour state, same actions, same controls as every other
	 * presentation — the phases are a read-only grouping over `DEMO_STEPS`
	 * (see `$lib/demo/guidePhases.ts`), never a second state machine.
	 */
	import { demoRouteLabel } from '$lib/demo/catalog';
	import { DEMO_PHASES, phaseIndexForStep, phaseStatus } from '$lib/demo/guidePhases';
	import { demoTour } from '$lib/demo/tour.svelte';
	import DemoSettings from './DemoSettings.svelte';
	import GuideControls from './GuideControls.svelte';
	import type { GuideActions, GuideArmState } from './guideApi';

	let { actions, arm }: { actions: GuideActions; arm: GuideArmState } = $props();

	const currentPhaseIndex = $derived(phaseIndexForStep(demoTour.stepIndex));
	const currentPhase = $derived(DEMO_PHASES[currentPhaseIndex]);
	const stepWithinPhase = $derived(
		currentPhase.stepIds.indexOf(demoTour.step.id) >= 0
			? currentPhase.stepIds.indexOf(demoTour.step.id) + 1
			: 1
	);
</script>

<aside
	class="mission-hud"
	data-testid="demo-guide"
	data-guide-style="hud"
	data-step-id={demoTour.step.id}
	aria-label="Product walkthrough"
>
	{#if !demoTour.collapsed}
		<section class="mission-card" data-testid="hud-mission-card" aria-label="Current mission">
			<header class="mission-header">
				<h2 data-testid="demo-step-title">{demoTour.step.title}</h2>
				<span class="mission-route">{demoRouteLabel(demoTour.step.route)}</span>
			</header>

			<p class="mission-now" data-testid="hud-mission-now">{demoTour.step.actions[0]}</p>

			{#if demoTour.step.actions.length > 1}
				<details class="mission-more">
					<summary>Full step ({demoTour.step.actions.length} actions)</summary>
					<ol class="actions" data-testid="demo-step-actions">
						{#each demoTour.step.actions as action (action)}
							<li>{action}</li>
						{/each}
					</ol>
					<p class="mechanism">{demoTour.step.mechanism}</p>
				</details>
			{/if}

			<footer class="mission-footer">
				<GuideControls {actions} {arm} />
			</footer>
		</section>
	{/if}

	<div class="hud-strip">
		<span class="hud-badge">Demo</span>
		<ol class="hud-phases" data-testid="hud-phases">
			{#each DEMO_PHASES as phase, index (phase.id)}
				{@const status = phaseStatus(index, demoTour.stepIndex)}
				<li
					class="hud-phase"
					class:completed={status === 'completed'}
					class:current={status === 'current'}
					data-testid="hud-phase-{phase.id}"
					data-status={status}
				>
					<span class="phase-mark" aria-hidden="true">
						{#if status === 'completed'}✓{:else}{index + 1}{/if}
					</span>
					<span class="phase-label">{phase.label}</span>
					{#if status === 'current' && currentPhase.stepIds.length > 1}
						<span class="phase-sub">{stepWithinPhase}/{currentPhase.stepIds.length}</span>
					{/if}
				</li>
			{/each}
		</ol>
		<span class="hud-position" data-testid="demo-step-position"
			>Step {demoTour.stepNumber} of {demoTour.stepCount}</span
		>
		<div class="hud-strip-actions">
			<DemoSettings />
			<button
				type="button"
				class="ghost"
				data-testid="demo-collapse"
				aria-expanded={!demoTour.collapsed}
				onclick={() => actions.toggleCollapsed()}
			>
				{demoTour.collapsed ? 'Expand' : 'Hide'}
			</button>
			<button type="button" class="ghost" data-testid="demo-exit" onclick={() => actions.exit()}>
				Exit demo
			</button>
		</div>
	</div>
</aside>

<style>
	.mission-hud {
		position: fixed;
		left: 50%;
		bottom: max(0.85rem, env(safe-area-inset-bottom));
		transform: translateX(-50%);
		z-index: 60;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.5rem;
		width: min(46rem, calc(100vw - 2rem));
		color: #e4e4e7;
		font-size: 0.85rem;
		pointer-events: none;
	}

	.mission-card,
	.hud-strip {
		pointer-events: auto;
	}

	.mission-card {
		width: min(30rem, 100%);
		background-color: #18181b;
		border: 1px solid #3f3f46;
		border-radius: 12px;
		box-shadow: 0 18px 44px rgba(0, 0, 0, 0.55);
		padding: 0.75rem 0.85rem 0.7rem;
		max-height: min(24rem, calc(100vh - 10rem));
		overflow-y: auto;
	}

	.mission-header {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 0.6rem;
		margin-bottom: 0.45rem;
	}

	.mission-header h2 {
		margin: 0;
		font-size: 1rem;
		line-height: 1.3;
		color: #fafafa;
	}

	.mission-route {
		flex: 0 0 auto;
		font-size: 0.7rem;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: #71717a;
	}

	.mission-now {
		margin: 0 0 0.55rem;
		padding: 0.5rem 0.65rem;
		border-radius: 8px;
		background-color: rgba(37, 99, 235, 0.14);
		border: 1px solid rgba(59, 130, 246, 0.45);
		color: #fafafa;
		font-weight: 600;
		line-height: 1.4;
	}

	.mission-more {
		margin: 0 0 0.55rem;
	}

	.mission-more summary {
		cursor: pointer;
		color: #a1a1aa;
		font-size: 0.78rem;
	}

	.actions {
		margin: 0.45rem 0 0;
		padding-left: 1.15rem;
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		line-height: 1.4;
		color: #d4d4d8;
		font-size: 0.82rem;
	}

	.mechanism {
		margin: 0.5rem 0 0;
		color: #a1a1aa;
		font-size: 0.76rem;
		line-height: 1.45;
	}

	.mission-footer {
		border-top: 1px solid #27272a;
		padding-top: 0.55rem;
	}

	.hud-strip {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		max-width: 100%;
		background-color: #18181b;
		border: 1px solid #3f3f46;
		border-radius: 999px;
		box-shadow: 0 12px 30px rgba(0, 0, 0, 0.5);
		padding: 0.3rem 0.65rem;
		/* The settings popover opens upward out of this strip; the strip must
		   not clip it (any overflow value would) and must paint above the
		   mission card it opens over. Horizontal squeeze is handled by the
		   phase list scrolling on its own instead. */
		position: relative;
		z-index: 2;
	}

	.hud-badge {
		background-color: #2563eb;
		color: #ffffff;
		border-radius: 999px;
		padding: 0.1rem 0.5rem;
		font-weight: 700;
		letter-spacing: 0.02em;
		font-size: 0.72rem;
		flex: 0 0 auto;
	}

	.hud-phases {
		list-style: none;
		display: flex;
		align-items: center;
		gap: 0.55rem;
		margin: 0;
		padding: 0;
		flex: 0 1 auto;
		min-width: 0;
		overflow-x: auto;
	}

	.hud-phase {
		display: flex;
		align-items: center;
		gap: 0.3rem;
		color: #71717a;
		white-space: nowrap;
		font-size: 0.78rem;
	}

	.hud-phase + .hud-phase::before {
		content: '→';
		margin-right: 0.25rem;
		color: #3f3f46;
	}

	.hud-phase.completed {
		color: #86efac;
	}

	.hud-phase.current {
		color: #fafafa;
		font-weight: 600;
	}

	.phase-mark {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.15rem;
		height: 1.15rem;
		border-radius: 999px;
		border: 1px solid currentColor;
		font-size: 0.65rem;
		flex: 0 0 auto;
	}

	.hud-phase.current .phase-mark {
		background-color: #2563eb;
		border-color: #2563eb;
		color: #ffffff;
	}

	.phase-sub {
		font-size: 0.68rem;
		color: #a1a1aa;
	}

	.hud-position {
		flex: 0 0 auto;
		font-size: 0.72rem;
		color: #a1a1aa;
		white-space: nowrap;
	}

	.hud-strip-actions {
		display: flex;
		align-items: center;
		gap: 0.15rem;
		flex: 0 0 auto;
	}

	button.ghost {
		font: inherit;
		background-color: transparent;
		border: 1px solid transparent;
		border-radius: 6px;
		color: #a1a1aa;
		padding: 0.2rem 0.4rem;
		font-size: 0.72rem;
		cursor: pointer;
		white-space: nowrap;
	}

	button.ghost:hover {
		background-color: #27272a;
		color: #f4f4f5;
	}

	button.ghost:focus-visible {
		outline: 2px solid #3b82f6;
		outline-offset: 1px;
	}

	@media (max-width: 640px) {
		.mission-hud {
			width: calc(100vw - 1.5rem);
		}
	}
</style>
