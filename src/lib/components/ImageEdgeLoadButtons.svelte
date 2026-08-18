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

	.edge-load-button {
		position: absolute;
		width: 3.25rem;
		height: 3.25rem;
		padding: 0;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 0;
		border: 1px dashed rgb(125 211 252 / 90%);
		border-radius: 8px;
		background: rgb(8 47 73 / 72%);
		color: #e0f2fe;
		box-shadow: 0 0 0 1px rgb(56 189 248 / 18%), 0 0 18px rgb(56 189 248 / 48%);
		font: inherit;
		cursor: pointer;
		pointer-events: auto;
	}

	.edge-load-button:hover:not(:disabled),
	.edge-load-button:focus-visible {
		background: rgb(12 74 110 / 86%);
		box-shadow: 0 0 0 2px rgb(56 189 248 / 30%), 0 0 24px rgb(56 189 248 / 72%);
	}

	.edge-load-button.queued {
		border-style: solid;
		background: rgb(7 89 133 / 86%);
	}

	.edge-load-button:disabled {
		cursor: wait;
		opacity: 0.62;
	}

	.arrow {
		font-size: 1.55rem;
		line-height: 1;
		font-weight: 700;
	}

	.delay {
		font-size: 0.65rem;
		line-height: 1;
		font-variant-numeric: tabular-nums;
		opacity: 0.9;
	}

	.edge-load-north {
		top: 0.6rem;
		left: 50%;
		transform: translateX(-50%);
	}

	.edge-load-east {
		right: 0.6rem;
		top: 50%;
		transform: translateY(-50%);
	}

	.edge-load-south {
		bottom: 0.6rem;
		left: 50%;
		transform: translateX(-50%);
	}

	.edge-load-west {
		left: 0.6rem;
		top: 50%;
		transform: translateY(-50%);
	}

	.edge-load-button:focus-visible {
		outline: 3px solid #38bdf8;
		outline-offset: 2px;
	}
</style>
