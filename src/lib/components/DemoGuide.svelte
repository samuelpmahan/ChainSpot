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
	import { onMount } from 'svelte';
	import { armDemoStep, stepHasArming } from '$lib/demo/arming';
	import { demoRouteLabel, demoStepUrl } from '$lib/demo/catalog';
	import { demoTour } from '$lib/demo/tour.svelte';

	let armBusy = $state(false);
	let armMessage = $state<string | null>(null);
	let armFailed = $state(false);

	onMount(() => {
		demoTour.restore();
	});

	/**
	 * Moves the narration and, when the next step lives on another route, takes
	 * the visitor there. Staying put when the route is unchanged matters: steps 3
	 * to 5 all happen on Create Graphics, and re-navigating would throw away the
	 * basemap and correspondences the visitor just created.
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
					onclick={() => demoTour.setCollapsed(!demoTour.collapsed)}
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
				{#if demoTour.isLast}
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

	.demo-rail.collapsed {
		max-height: none;
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
