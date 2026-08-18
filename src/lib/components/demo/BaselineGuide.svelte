<script lang="ts">
	/**
	 * Baseline presentation: the pre-CHSPT-73 corner rail, kept intact as the
	 * comparison reference. Identical markup and behavior to the original
	 * `DemoGuide.svelte` body, now consuming the shared tour state and the
	 * shell's actions like every other presentation instead of owning them.
	 */
	import { demoRouteLabel } from '$lib/demo/catalog';
	import { demoTour } from '$lib/demo/tour.svelte';
	import DemoSettings from './DemoSettings.svelte';
	import GuideControls from './GuideControls.svelte';
	import type { GuideActions, GuideArmState } from './guideApi';

	let { actions, arm }: { actions: GuideActions; arm: GuideArmState } = $props();
</script>

<aside
	class="demo-rail"
	class:collapsed={demoTour.collapsed}
	data-testid="demo-guide"
	data-guide-style="baseline"
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
			<DemoSettings />
			<button
				type="button"
				class="ghost"
				data-testid="demo-collapse"
				aria-expanded={!demoTour.collapsed}
				onclick={() => actions.toggleCollapsed()}
			>
				{demoTour.collapsed ? 'Expand' : 'Collapse'}
			</button>
			<button type="button" class="ghost" data-testid="demo-exit" onclick={() => actions.exit()}>
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
		</div>

		<footer class="rail-footer">
			<GuideControls {actions} {arm} />
		</footer>
	{/if}
</aside>

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
	 * Collapsed, the rail docks bottom-LEFT instead of bottom-right — the
	 * bottom-right corner is reserved for the product's own controls on every
	 * route the tour visits (capture cards' Replace/Remove, the on-canvas zoom
	 * cluster). Bottom-left is clear on every route.
	 */
	.demo-rail.collapsed {
		max-height: none;
		left: max(1rem, env(safe-area-inset-left));
		right: auto;
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

	/* The step counter must never wrap; the route label absorbs the squeeze
	   via its ellipsis instead. */
	.rail-progress > span {
		white-space: nowrap;
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
		align-items: center;
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

	.rail-footer {
		padding: 0.6rem 0.75rem;
		border-top: 1px solid #27272a;
	}

	button.ghost {
		font: inherit;
		background-color: transparent;
		border: 1px solid transparent;
		border-radius: 6px;
		color: #a1a1aa;
		padding: 0.25rem 0.45rem;
		font-size: 0.75rem;
		cursor: pointer;
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
		.demo-rail {
			left: max(0.75rem, env(safe-area-inset-left));
			right: max(0.75rem, env(safe-area-inset-right));
			width: auto;
			max-height: min(60vh, 28rem);
		}
	}
</style>
