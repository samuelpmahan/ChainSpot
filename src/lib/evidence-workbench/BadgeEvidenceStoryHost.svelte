<script lang="ts">
	import { badgeSpecimenLibrary } from 'virtual:e-badge-specimens';
	import BadgeEvidenceView from './BadgeEvidenceView.svelte';
	import BadgeRefinementStack from './BadgeRefinementStack.svelte';
	import type { BadgeProjection } from './badgeProjection';

	let {
		specimenId,
		projection = 'raw',
		zoom = 8,
		showGrid = false,
		showReceipt = true,
		layout = 'single'
	}: {
		specimenId: string;
		projection?: BadgeProjection;
		zoom?: number;
		showGrid?: boolean;
		showReceipt?: boolean;
		layout?: 'single' | 'stack';
	} = $props();

	let specimen = $derived(
		badgeSpecimenLibrary.specimens.find((candidate) => candidate.id === specimenId) ??
			badgeSpecimenLibrary.specimens[0]
	);
</script>

{#if layout === 'stack'}
	<BadgeRefinementStack {specimen} {zoom} />
{:else}
	<BadgeEvidenceView {specimen} {projection} {zoom} {showGrid} {showReceipt} />
{/if}
