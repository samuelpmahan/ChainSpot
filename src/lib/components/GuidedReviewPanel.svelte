<script lang="ts">
	import { currentHole, type Anchor, type ReviewState } from '$lib/guidedReview';

	let {
		review,
		replaceArming,
		onAccept,
		onArmReplace,
		onCancelReplace,
		onConfirmAll
	}: {
		review: ReviewState;
		replaceArming: { holeN: number; anchor: Anchor } | null;
		onAccept: (holeN: number) => void;
		onArmReplace: (holeN: number, anchor: Anchor) => void;
		onCancelReplace: () => void;
		onConfirmAll: () => void;
	} = $props();

	let hole = $derived(currentHole(review));
	let total = $derived(review.holes.length);
	let acceptedCount = $derived(review.holes.filter((h) => h.status === 'accepted').length);
	let arming = $derived(replaceArming !== null);
</script>

<div style="background: white; border: 1px solid black; padding: 0.5rem; font-size: 0.85rem;">
	{#if review.done}
		<div>All {total} holes reviewed</div>
		<button style="width: 100%; margin-top: 0.5rem;" onclick={onConfirmAll}
			><strong>Confirm Annotation</strong></button
		>
	{:else if hole}
		<div><strong>Reviewing hole {hole.n} of {total}</strong></div>
		<div>tee: {hole.tee ? 'placed' : 'missing'}</div>
		<div>basket: {hole.basket ? 'placed' : 'missing'}</div>
		<div>bend: {hole.bends.length > 0 ? 'placed' : 'missing'}</div>
		{#if replaceArming}
			<div style="margin-top: 0.5rem;">
				Click the map to place the {replaceArming.anchor} for hole {replaceArming.holeN}
			</div>
			<button style="width: 100%; margin-top: 0.25rem;" onclick={onCancelReplace}>Cancel</button>
		{/if}
		<button
			style="width: 100%; margin-top: 0.5rem;"
			disabled={arming}
			onclick={() => onAccept(hole.n)}><strong>Accept hole</strong></button
		>
		<button
			style="width: 100%; margin-top: 0.25rem;"
			disabled={arming}
			onclick={() => onArmReplace(hole.n, 'tee')}>Place tee</button
		>
		<button
			style="width: 100%; margin-top: 0.25rem;"
			disabled={arming}
			onclick={() => onArmReplace(hole.n, 'basket')}>Place basket</button
		>
		<button
			style="width: 100%; margin-top: 0.25rem;"
			disabled={arming}
			onclick={() => onArmReplace(hole.n, 'bend')}>Place bend</button
		>
	{/if}
	<div style="margin-top: 0.5rem;"><small>{acceptedCount} of {total} accepted</small></div>
</div>
