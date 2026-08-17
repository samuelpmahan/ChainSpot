<script lang="ts">
	/**
	 * The one set of walkthrough controls, shared verbatim by all four guide
	 * presentations: Load the real inputs (only when the step has arming, and
	 * only ever on an explicit click), Back, and Next / Reload the page /
	 * Finish. Sharing the markup keeps the test ids and the behavior contract
	 * identical across styles — a presentation styles *around* these controls,
	 * it never reimplements them.
	 */
	import { base } from '$app/paths';
	import { stepHasArming } from '$lib/demo/arming';
	import { demoTour } from '$lib/demo/tour.svelte';
	import type { GuideActions, GuideArmState } from './guideApi';

	let { actions, arm }: { actions: GuideActions; arm: GuideArmState } = $props();
</script>

{#if arm.message}
	<p
		class="arm-message"
		class:error={arm.failed}
		data-testid="demo-arm-message"
		role={arm.failed ? 'alert' : 'status'}
	>
		{arm.message}
	</p>
{/if}

<div class="guide-controls">
	{#if stepHasArming(demoTour.step)}
		<button
			type="button"
			class="primary"
			data-testid="demo-load-inputs"
			disabled={arm.busy}
			onclick={() => void actions.loadStepInputs()}
		>
			{arm.busy ? 'Loading real inputs…' : 'Load the real inputs'}
		</button>
	{/if}
	<button
		type="button"
		data-testid="demo-previous"
		disabled={demoTour.isFirst || arm.busy}
		onclick={() => void actions.goToStep(demoTour.stepIndex - 1)}
	>
		Back
	</button>
	{#if demoTour.step.kind === 'reload'}
		<button
			type="button"
			class="primary"
			data-testid="demo-reload"
			disabled={arm.busy}
			onclick={() => actions.reloadAndAdvance()}
		>
			Reload the page
		</button>
	{:else if demoTour.isLast}
		<a class="finish-link" href="{base}/demo" data-testid="demo-finish">Finish</a>
	{:else}
		<button
			type="button"
			data-testid="demo-next"
			disabled={arm.busy}
			onclick={() => void actions.goToStep(demoTour.stepIndex + 1)}
		>
			Next
		</button>
	{/if}
</div>

<style>
	.arm-message {
		margin: 0 0 0.5rem;
		padding: 0.5rem 0.6rem;
		border-radius: 6px;
		background-color: #14532d;
		color: #dcfce7;
		line-height: 1.4;
		font-size: 0.85rem;
	}

	.arm-message.error {
		background-color: #7f1d1d;
		color: #fee2e2;
	}

	.guide-controls {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
	}

	button,
	.finish-link {
		font: inherit;
		font-size: 0.875rem;
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

	@media (max-width: 640px) {
		button,
		.finish-link {
			min-height: 2.5rem;
		}
	}
</style>
