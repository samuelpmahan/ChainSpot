<script lang="ts">
	/**
	 * Spotlight presentation: a compact narrative card plus a restrained
	 * pulsing ring around the REAL product control the current step points
	 * at, resolved through the `data-demo-anchor` contract (see
	 * `$lib/demo/catalog.ts` and `./anchors.ts`).
	 *
	 * The ring is decoration only: `pointer-events: none`, no dimming, no
	 * cloned or proxied controls — the visitor keeps interacting with the
	 * product directly. A step without an anchor, or whose anchor is not
	 * currently usable (not yet rendered, hidden, gone), renders the card
	 * alone; the ring is never a dependency.
	 */
	import { demoRouteLabel } from '$lib/demo/catalog';
	import { demoTour } from '$lib/demo/tour.svelte';
	import { observeDemoAnchor } from './anchors';
	import type { AnchorRect } from './anchors';
	import DemoSettings from './DemoSettings.svelte';
	import GuideControls from './GuideControls.svelte';
	import type { GuideActions, GuideArmState } from './guideApi';

	let { actions, arm }: { actions: GuideActions; arm: GuideArmState } = $props();

	let anchorRect = $state<AnchorRect | null>(null);

	$effect(() => {
		const anchorId = demoTour.step.spotlight;
		if (!anchorId) {
			anchorRect = null;
			return;
		}
		return observeDemoAnchor(anchorId, (rect) => {
			anchorRect = rect;
		});
	});

	// Inflate the ring a little past the control so the emphasis reads as a
	// halo, not a border the control suddenly grew.
	const RING_PAD = 6;
</script>

{#if anchorRect && !demoTour.collapsed}
	<div
		class="spotlight-ring"
		data-testid="demo-spotlight-ring"
		aria-hidden="true"
		style:top="{anchorRect.top - RING_PAD}px"
		style:left="{anchorRect.left - RING_PAD}px"
		style:width="{anchorRect.width + RING_PAD * 2}px"
		style:height="{anchorRect.height + RING_PAD * 2}px"
	></div>
{/if}

<aside
	class="spot-card"
	class:collapsed={demoTour.collapsed}
	data-testid="demo-guide"
	data-guide-style="spotlight"
	data-step-id={demoTour.step.id}
	aria-label="Product walkthrough"
>
	<header class="spot-header">
		<div class="spot-meta">
			<span class="spot-badge">Demo</span>
			<span data-testid="demo-step-position">Step {demoTour.stepNumber} of {demoTour.stepCount}</span>
			<span class="spot-route">{demoRouteLabel(demoTour.step.route)}</span>
		</div>
		<div class="spot-header-actions">
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
		<div class="spot-body">
			<h2 data-testid="demo-step-title">{demoTour.step.title}</h2>
			{#if anchorRect}
				<p class="spot-cue" data-testid="spotlight-cue">
					The highlighted control is your next move.
				</p>
			{/if}
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

		<footer class="spot-footer">
			<GuideControls {actions} {arm} />
		</footer>
	{/if}
</aside>

<style>
	.spotlight-ring {
		position: fixed;
		z-index: 55;
		pointer-events: none;
		border: 2px solid #60a5fa;
		border-radius: 10px;
		box-shadow:
			0 0 0 4px rgba(96, 165, 250, 0.22),
			0 0 18px rgba(96, 165, 250, 0.35);
		animation: spotlight-pulse 1.8s ease-in-out infinite;
	}

	@keyframes spotlight-pulse {
		0%,
		100% {
			box-shadow:
				0 0 0 4px rgba(96, 165, 250, 0.22),
				0 0 18px rgba(96, 165, 250, 0.35);
		}
		50% {
			box-shadow:
				0 0 0 7px rgba(96, 165, 250, 0.12),
				0 0 26px rgba(96, 165, 250, 0.45);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.spotlight-ring {
			animation: none;
		}
	}

	.spot-card {
		position: fixed;
		right: max(1rem, env(safe-area-inset-right));
		bottom: max(1rem, env(safe-area-inset-bottom));
		z-index: 60;
		width: min(21rem, calc(100vw - 2rem));
		max-height: min(28rem, calc(100vh - 6rem));
		display: flex;
		flex-direction: column;
		background-color: #18181b;
		border: 1px solid #3f3f46;
		border-radius: 10px;
		box-shadow: 0 18px 40px rgba(0, 0, 0, 0.55);
		color: #e4e4e7;
		font-size: 0.85rem;
	}

	.spot-card.collapsed {
		max-height: none;
		left: max(1rem, env(safe-area-inset-left));
		right: auto;
		width: fit-content;
	}

	.spot-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		padding: 0.55rem 0.7rem;
		border-bottom: 1px solid #27272a;
	}

	.spot-card.collapsed .spot-header {
		border-bottom: none;
	}

	.spot-meta {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.75rem;
		color: #a1a1aa;
		min-width: 0;
	}

	/* The step counter must never wrap ("Step 5\nof 6" reads terribly in a
	   narrow card); the route label is the one flexible, truncatable part. */
	.spot-meta > span {
		white-space: nowrap;
	}

	.spot-badge {
		background-color: #2563eb;
		color: #ffffff;
		border-radius: 999px;
		padding: 0.1rem 0.5rem;
		font-weight: 700;
		letter-spacing: 0.02em;
	}

	.spot-route {
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.spot-header-actions {
		display: flex;
		gap: 0.25rem;
		flex: 0 0 auto;
		align-items: center;
	}

	.spot-body {
		padding: 0.7rem;
		overflow-y: auto;
	}

	.spot-body h2 {
		margin: 0 0 0.4rem;
		font-size: 0.95rem;
		line-height: 1.3;
		color: #fafafa;
	}

	.spot-cue {
		margin: 0 0 0.5rem;
		padding: 0.35rem 0.5rem;
		border-radius: 6px;
		background-color: rgba(96, 165, 250, 0.12);
		border: 1px solid rgba(96, 165, 250, 0.35);
		color: #bfdbfe;
		font-size: 0.78rem;
	}

	.actions {
		margin: 0 0 0.55rem;
		padding-left: 1.1rem;
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		line-height: 1.4;
		color: #e4e4e7;
	}

	.mechanism summary {
		cursor: pointer;
		color: #a1a1aa;
		font-size: 0.78rem;
	}

	.mechanism p {
		margin: 0.4rem 0 0;
		color: #a1a1aa;
		font-size: 0.78rem;
		line-height: 1.45;
	}

	.spot-footer {
		padding: 0.55rem 0.7rem;
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
		.spot-card {
			left: max(0.75rem, env(safe-area-inset-left));
			right: max(0.75rem, env(safe-area-inset-right));
			width: auto;
			max-height: min(60vh, 26rem);
		}
	}
</style>
