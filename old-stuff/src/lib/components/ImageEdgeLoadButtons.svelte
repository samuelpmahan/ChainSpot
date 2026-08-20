<script lang="ts">
	import type { EdgeDirection } from '$lib/edgeLoadZones';

	interface Props {
		directions: readonly EdgeDirection[];
		queuedDirection?: EdgeDirection | null;
		queuedDelayMs?: number;
		busy?: boolean;
		onLoad: (direction: EdgeDirection) => void;
	}

	let {
		directions,
		queuedDirection = null,
		queuedDelayMs = 2000,
		busy = false,
		onLoad
	}: Props = $props();

	const ARROWS: Record<EdgeDirection, string> = {
		north: '↑',
		east: '→',
		south: '↓',
		west: '←'
	};

	function queuedSeconds(direction: EdgeDirection): number | null {
		return queuedDirection === direction ? Math.max(1, Math.ceil(queuedDelayMs / 1000)) : null;
	}
</script>

<div class="edge-load-layer" aria-label="Load more aerial imagery">
	{#each directions as direction (direction)}
		{@const seconds = queuedSeconds(direction)}
		<button
			type="button"
			class="edge-load-button edge-load-{direction}"
			class:queued={seconds !== null}
			data-testid={`pane-load-more-${direction}`}
			disabled={busy}
			onclick={() => onLoad(direction)}
			aria-label={seconds === null
				? `Load more aerial imagery ${direction}`
				: `Load more aerial imagery ${direction}; queued with a ${seconds} second debounce`}
			title={seconds === null
				? `Load imagery ${direction}`
				: `Queued — ${seconds}s debounce`}
		>
			<span class="arrow" aria-hidden="true">{ARROWS[direction]}</span>
			{#if seconds !== null}
				<span class="delay" aria-hidden="true">{seconds}s</span>
			{/if}
		</button>
	{/each}
</div>

<style>
	.edge-load-layer {
		position: absolute;
		inset: 0;
		z-index: 4;
		pointer-events: none;
	}

	/*
	 * The control reads as the neighboring aerial tile itself, not a tiny button:
	 * a large, mostly-empty dashed square in the unloaded checkerboard with the
	 * requested direction centered inside. It sits very close to the pane edge so
	 * it visually feels almost attached to the currently loaded raster.
	 */
	.edge-load-button {
		position: absolute;
		width: clamp(8rem, 32%, 14rem);
		aspect-ratio: 1;
		padding: 0;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 0.3rem;
		border: 2px dashed rgb(125 211 252 / 88%);
		border-radius: 10px;
		background: rgb(8 47 73 / 18%);
		color: #e0f2fe;
		box-shadow:
			inset 0 0 36px rgb(56 189 248 / 10%),
			0 0 0 1px rgb(56 189 248 / 12%);
		font: inherit;
		cursor: pointer;
		pointer-events: auto;
		transition:
			background-color 120ms ease,
			box-shadow 120ms ease,
			border-color 120ms ease,
			transform 120ms ease;
	}

	.edge-load-button:hover:not(:disabled),
	.edge-load-button:focus-visible {
		border-color: rgb(186 230 253 / 100%);
		background: rgb(12 74 110 / 34%);
		box-shadow:
			inset 0 0 48px rgb(56 189 248 / 16%),
			0 0 24px rgb(56 189 248 / 34%);
	}

	.edge-load-button.queued {
		border-style: solid;
		background: rgb(7 89 133 / 40%);
	}

	.edge-load-button:disabled {
		cursor: wait;
		opacity: 0.58;
	}

	.arrow {
		font-size: clamp(2.5rem, 8vw, 4rem);
		line-height: 1;
		font-weight: 650;
		text-shadow: 0 0 18px rgb(56 189 248 / 65%);
	}

	.delay {
		font-size: 0.72rem;
		line-height: 1;
		font-variant-numeric: tabular-nums;
		opacity: 0.9;
	}

	.edge-load-north {
		top: 0.35rem;
		left: 50%;
		transform: translateX(-50%);
	}

	.edge-load-east {
		right: 0.35rem;
		top: 50%;
		transform: translateY(-50%);
	}

	.edge-load-south {
		bottom: 0.35rem;
		left: 50%;
		transform: translateX(-50%);
	}

	.edge-load-west {
		left: 0.35rem;
		top: 50%;
		transform: translateY(-50%);
	}

	.edge-load-button:focus-visible {
		outline: 3px solid #38bdf8;
		outline-offset: 3px;
	}
</style>
