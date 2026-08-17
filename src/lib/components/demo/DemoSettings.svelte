<script lang="ts">
	/**
	 * Demo Settings: the small affordance every guide presentation carries.
	 *
	 * Opening it, closing it, and changing any preference in it are pure
	 * presentation acts — no navigation, no tour-cursor movement, no arming,
	 * no product state. It reads and writes `demoGuidePreferences` only.
	 *
	 * Structured as sections so future demo-only preferences (say, narration
	 * density) become a new fieldset here plus a field on the preferences
	 * store, without touching any guide presentation.
	 */
	import { demoGuidePreferences, GUIDE_STYLE_OPTIONS } from '$lib/demo/guidePreferences.svelte';
	import type { DemoGuideStyle } from '$lib/demo/guidePreferences.svelte';
	import { demoSettingsUi } from './settingsState.svelte';

	let { direction = 'up' }: { direction?: 'up' | 'down' } = $props();

	let root: HTMLElement | undefined = $state();

	function choose(style: DemoGuideStyle): void {
		demoGuidePreferences.setGuideStyle(style);
	}

	// Light-dismiss: any pointer press outside the popover closes it, and so
	// does Escape. Listeners exist only while open.
	$effect(() => {
		if (!demoSettingsUi.open) return;
		const onPointerDown = (event: PointerEvent): void => {
			if (root && event.target instanceof Node && !root.contains(event.target))
				demoSettingsUi.open = false;
		};
		const onKeyDown = (event: KeyboardEvent): void => {
			if (event.key === 'Escape') demoSettingsUi.open = false;
		};
		document.addEventListener('pointerdown', onPointerDown, true);
		document.addEventListener('keydown', onKeyDown, true);
		return () => {
			document.removeEventListener('pointerdown', onPointerDown, true);
			document.removeEventListener('keydown', onKeyDown, true);
		};
	});
</script>

<div class="demo-settings" bind:this={root}>
	<button
		type="button"
		class="settings-toggle"
		data-testid="demo-settings-toggle"
		aria-expanded={demoSettingsUi.open}
		aria-haspopup="dialog"
		title="Demo settings"
		onclick={() => (demoSettingsUi.open = !demoSettingsUi.open)}
	>
		<span aria-hidden="true">⚙</span>
		<span class="sr-only">Demo settings</span>
	</button>

	{#if demoSettingsUi.open}
		<div
			class="settings-popover"
			class:drop-down={direction === 'down'}
			data-testid="demo-settings-popover"
			role="dialog"
			aria-label="Demo settings"
		>
			<fieldset>
				<legend>Guide style</legend>
				{#each GUIDE_STYLE_OPTIONS as option (option.id)}
					<label class="style-option">
						<input
							type="radio"
							name="demo-guide-style"
							value={option.id}
							data-testid="demo-guide-style-{option.id}"
							checked={demoGuidePreferences.guideStyle === option.id}
							onchange={() => choose(option.id)}
						/>
						<span class="style-copy">
							<span class="style-label">{option.label}</span>
							<span class="style-blurb">{option.blurb}</span>
						</span>
					</label>
				{/each}
			</fieldset>
		</div>
	{/if}
</div>

<style>
	.demo-settings {
		position: relative;
		display: inline-flex;
	}

	.settings-toggle {
		font: inherit;
		background-color: transparent;
		border: 1px solid transparent;
		border-radius: 6px;
		color: #a1a1aa;
		padding: 0.25rem 0.45rem;
		font-size: 0.8rem;
		cursor: pointer;
		line-height: 1;
	}

	.settings-toggle:hover,
	.settings-toggle[aria-expanded='true'] {
		background-color: #27272a;
		color: #f4f4f5;
	}

	.settings-toggle:focus-visible {
		outline: 2px solid #3b82f6;
		outline-offset: 1px;
	}

	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		border: 0;
	}

	.settings-popover {
		position: absolute;
		right: 0;
		bottom: calc(100% + 0.4rem);
		z-index: 70;
		width: 17rem;
		background-color: #18181b;
		border: 1px solid #3f3f46;
		border-radius: 8px;
		box-shadow: 0 14px 34px rgba(0, 0, 0, 0.55);
		padding: 0.65rem 0.75rem;
	}

	.settings-popover.drop-down {
		bottom: auto;
		top: calc(100% + 0.4rem);
	}

	fieldset {
		border: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
	}

	legend {
		padding: 0;
		margin: 0 0 0.35rem;
		font-size: 0.7rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: #a1a1aa;
	}

	.style-option {
		display: flex;
		gap: 0.5rem;
		align-items: flex-start;
		padding: 0.35rem 0.4rem;
		border-radius: 6px;
		cursor: pointer;
	}

	.style-option:hover {
		background-color: #27272a;
	}

	.style-option input {
		margin-top: 0.2rem;
		accent-color: #2563eb;
	}

	.style-copy {
		display: flex;
		flex-direction: column;
		gap: 0.1rem;
	}

	.style-label {
		font-size: 0.85rem;
		font-weight: 600;
		color: #f4f4f5;
	}

	.style-blurb {
		font-size: 0.75rem;
		color: #a1a1aa;
		line-height: 1.35;
	}
</style>
