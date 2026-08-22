<script lang="ts">
	import type { CorrespondencePair, WorldTransform } from '$lib/geo';

	let {
		pairs,
		arming,
		transform,
		sampleDistanceFt,
		onStartPair,
		onCancelPair,
		onRemovePair,
		onDone
	}: {
		pairs: readonly CorrespondencePair[];
		arming: 'blank' | 'satellite' | null;
		transform: WorldTransform | null;
		sampleDistanceFt: number | null;
		onStartPair: () => void;
		onCancelPair: () => void;
		onRemovePair: (index: number) => void;
		onDone: () => void;
	} = $props();
</script>

<div class="pair-panel">
	{#if pairs.length > 0}
		<ul class="pair-list">
			{#each pairs as _, i (i)}
				<li>
					P{i + 1}
					<button class="remove" title="Remove pair" onclick={() => onRemovePair(i)}>×</button>
				</li>
			{/each}
		</ul>
	{/if}

	{#if arming === 'blank'}
		<p>Click the point on the course blank</p>
		<button onclick={onCancelPair}>Cancel</button>
	{:else if arming === 'satellite'}
		<p>Now click the same point on the satellite</p>
		<button onclick={onCancelPair}>Cancel</button>
	{:else}
		<button onclick={onStartPair}><strong>Add correspondence pair</strong></button>
	{/if}

	{#if transform}
		<p>Transform locked.</p>
		{#if sampleDistanceFt != null}
			<p>Sample distance: {sampleDistanceFt.toFixed(0)} ft (computed, not guessed)</p>
		{/if}
		<button onclick={onDone}><strong>Continue</strong></button>
	{:else if pairs.length < 2}
		<p>Need {2 - pairs.length} more pair(s)</p>
	{/if}
</div>

<style>
	.pair-panel {
		background: rgba(255, 255, 255, 0.92);
		border: 1px solid black;
		padding: 0.4rem 0.5rem;
		font-size: 0.85rem;
		max-width: 16rem;
	}

	.pair-panel p {
		margin: 0.3rem 0;
	}

	.pair-list {
		list-style: none;
		margin: 0 0 0.3rem;
		padding: 0;
		display: flex;
		gap: 0.5rem;
		flex-wrap: wrap;
	}

	.pair-list li {
		display: inline-flex;
		align-items: center;
		gap: 0.2rem;
		border: 1px solid #999;
		padding: 0.05rem 0.3rem;
	}

	.remove {
		padding: 0 0.3rem;
		line-height: 1.1;
	}
</style>
