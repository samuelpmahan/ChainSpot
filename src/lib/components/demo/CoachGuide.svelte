<script lang="ts">
	/**
	 * Coach card presentation: an active presenter rather than a corner
	 * utility. One dominant "do this now" instruction (the step's first
	 * action), a visible progress bar, and everything else visually
	 * subordinate. Same tour state, same actions, same controls as every
	 * other presentation.
	 *
	 * The card docks bottom-right by default but flips to bottom-left when
	 * the step's spotlight anchor — the very control it is telling the
	 * visitor to use — currently sits in the right half of the viewport, so
	 * the coach never covers its own subject. No anchor, or an unusable one,
	 * simply means the default dock.
	 */
	import { demoRouteLabel } from '$lib/demo/catalog';
	import { demoTour } from '$lib/demo/tour.svelte';
	import { observeDemoAnchor } from './anchors';
	import DemoSettings from './DemoSettings.svelte';
	import GuideControls from './GuideControls.svelte';
	import type { GuideActions, GuideArmState } from './guideApi';

	let { actions, arm }: { actions: GuideActions; arm: GuideArmState } = $props();

	let dockLeft = $state(false);

	$effect(() => {
		const anchorId = demoTour.step.spotlight;
		if (!anchorId) {
			dockLeft = false;
			return;
		}
		return observeDemoAnchor(anchorId, (rect) => {
			if (!rect || typeof window === 'undefined') {
				dockLeft = false;
				return;
			}
			const center = rect.left + rect.width / 2;
			dockLeft = center > window.innerWidth * 0.55;
		});
	});

	const doNow = $derived(demoTour.step.actions[0]);
	const thenActions = $derived(demoTour.step.actions.slice(1));
	const progressPct = $derived((demoTour.stepNumber / demoTour.stepCount) * 100);
</script>

{#if demoTour.collapsed}
	<aside
		class="coach-pill"
		data-testid="demo-guide"
		data-guide-style="coach"
		data-step-id={demoTour.step.id}
		aria-label="Product walkthrough"
	>
		<span class="pill-badge">Demo</span>
		<span class="pill-progress" data-testid="demo-step-position"
			>Step {demoTour.stepNumber} of {demoTour.stepCount}</span
		>
		<span class="pill-title">{demoTour.step.title}</span>
		<button
			type="button"
			class="ghost"
			data-testid="demo-collapse"
			aria-expanded="false"
			onclick={() => actions.toggleCollapsed()}
		>
			Expand
		</button>
		<button type="button" class="ghost" data-testid="demo-exit" onclick={() => actions.exit()}>
			Exit demo
		</button>
	</aside>
{:else}
	<aside
		class="coach-card"
		class:dock-left={dockLeft}
		data-testid="demo-guide"
		data-guide-style="coach"
		data-step-id={demoTour.step.id}
		aria-label="Product walkthrough"
	>
		<header class="coach-header">
			<div class="coach-meta">
				<span class="pill-badge">Demo</span>
				<span data-testid="demo-step-position">Step {demoTour.stepNumber} of {demoTour.stepCount}</span>
				<span class="coach-route">{demoRouteLabel(demoTour.step.route)}</span>
			</div>
			<div class="coach-header-actions">
				<DemoSettings />
				<button
					type="button"
					class="ghost"
					data-testid="demo-collapse"
					aria-expanded="true"
					onclick={() => actions.toggleCollapsed()}
				>
					Minimize
				</button>
				<button type="button" class="ghost" data-testid="demo-exit" onclick={() => actions.exit()}>
					Exit demo
				</button>
			</div>
		</header>

		<div class="coach-progress" role="presentation">
			<div class="coach-progress-fill" style:width="{progressPct}%"></div>
		</div>

		<div class="coach-body">
			<h2 data-testid="demo-step-title">{demoTour.step.title}</h2>

			<div class="do-now" data-testid="coach-do-now">
				<span class="do-now-label">Do this now</span>
				<p>{doNow}</p>
			</div>

			{#if thenActions.length > 0}
				<details class="then">
					<summary>Then ({thenActions.length} more)</summary>
					<ol class="actions" data-testid="demo-step-actions">
						{#each thenActions as action (action)}
							<li>{action}</li>
						{/each}
					</ol>
				</details>
			{/if}

			<p class="lede">{demoTour.step.lede}</p>

			<details class="mechanism">
				<summary>What is actually happening</summary>
				<p>{demoTour.step.mechanism}</p>
			</details>
		</div>

		<footer class="coach-footer">
			<GuideControls {actions} {arm} />
		</footer>
	</aside>
{/if}

<style>
	.coach-card {
		position: fixed;
		right: max(1.25rem, env(safe-area-inset-right));
		bottom: max(1.25rem, env(safe-area-inset-bottom));
		z-index: 60;
		width: min(26.5rem, calc(100vw - 2rem));
		max-height: min(36rem, calc(100vh - 5rem));
		display: flex;
		flex-direction: column;
		background-color: #18181b;
		border: 1px solid #3f3f46;
		border-radius: 14px;
		box-shadow: 0 24px 56px rgba(0, 0, 0, 0.6);
		color: #e4e4e7;
		font-size: 0.9rem;
	}

	.coach-card.dock-left {
		right: auto;
		left: max(1.25rem, env(safe-area-inset-left));
	}

	.coach-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		padding: 0.65rem 0.85rem 0.5rem;
	}

	.coach-meta {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.75rem;
		color: #a1a1aa;
		min-width: 0;
	}

	/* Step counter never wraps; the route label truncates instead. */
	.coach-meta > span {
		white-space: nowrap;
	}

	.pill-badge {
		background-color: #2563eb;
		color: #ffffff;
		border-radius: 999px;
		padding: 0.1rem 0.5rem;
		font-weight: 700;
		letter-spacing: 0.02em;
		font-size: 0.75rem;
	}

	.coach-route {
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.coach-header-actions {
		display: flex;
		gap: 0.25rem;
		flex: 0 0 auto;
		align-items: center;
	}

	.coach-progress {
		height: 4px;
		margin: 0 0.85rem;
		border-radius: 999px;
		background-color: #27272a;
		overflow: hidden;
	}

	.coach-progress-fill {
		height: 100%;
		background-color: #3b82f6;
		border-radius: 999px;
		transition: width 200ms ease;
	}

	.coach-body {
		padding: 0.75rem 0.85rem;
		overflow-y: auto;
	}

	.coach-body h2 {
		margin: 0 0 0.65rem;
		font-size: 1.2rem;
		line-height: 1.25;
		color: #fafafa;
	}

	.do-now {
		background-color: rgba(37, 99, 235, 0.14);
		border: 1px solid rgba(59, 130, 246, 0.5);
		border-radius: 10px;
		padding: 0.6rem 0.75rem;
		margin-bottom: 0.65rem;
	}

	.do-now-label {
		display: block;
		font-size: 0.68rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: #93c5fd;
		margin-bottom: 0.25rem;
	}

	.do-now p {
		margin: 0;
		font-size: 1rem;
		font-weight: 600;
		line-height: 1.4;
		color: #fafafa;
	}

	.then {
		margin: 0 0 0.65rem;
	}

	.then summary {
		cursor: pointer;
		color: #d4d4d8;
		font-size: 0.82rem;
	}

	.actions {
		margin: 0.45rem 0 0;
		padding-left: 1.15rem;
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
		line-height: 1.45;
		color: #d4d4d8;
		font-size: 0.85rem;
	}

	.lede {
		margin: 0 0 0.6rem;
		color: #a1a1aa;
		line-height: 1.45;
		font-size: 0.83rem;
	}

	.mechanism summary {
		cursor: pointer;
		color: #71717a;
		font-size: 0.78rem;
	}

	.mechanism p {
		margin: 0.4rem 0 0;
		color: #a1a1aa;
		font-size: 0.78rem;
		line-height: 1.45;
	}

	.coach-footer {
		padding: 0.6rem 0.85rem 0.75rem;
		border-top: 1px solid #27272a;
	}

	.coach-pill {
		position: fixed;
		left: max(1rem, env(safe-area-inset-left));
		bottom: max(1rem, env(safe-area-inset-bottom));
		z-index: 60;
		display: flex;
		align-items: center;
		gap: 0.5rem;
		max-width: min(30rem, calc(100vw - 2rem));
		background-color: #18181b;
		border: 1px solid #3f3f46;
		border-radius: 999px;
		box-shadow: 0 12px 30px rgba(0, 0, 0, 0.5);
		color: #e4e4e7;
		font-size: 0.8rem;
		padding: 0.35rem 0.6rem;
	}

	.pill-progress {
		color: #a1a1aa;
		white-space: nowrap;
	}

	.pill-title {
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		min-width: 0;
		color: #d4d4d8;
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
		.coach-card {
			left: max(0.75rem, env(safe-area-inset-left));
			right: max(0.75rem, env(safe-area-inset-right));
			width: auto;
			max-height: min(62vh, 30rem);
		}
	}
</style>
