<script lang="ts">
	import { badgeSpecimenLibrary } from 'virtual:e-badge-specimens';
	import M1EvidenceView from './M1EvidenceView.svelte';
	import type { M1Projection } from './m1Projection';

	let {
		subjectId,
		projection = 'components',
		zoom = 6,
		showReceipt = true
	}: {
		subjectId: string;
		projection?: M1Projection;
		zoom?: number;
		showReceipt?: boolean;
	} = $props();
	let library = $derived(badgeSpecimenLibrary.m1);
</script>

{#if library}
	<M1EvidenceView {library} {subjectId} {projection} {zoom} {showReceipt} />
{:else}
	<p>M1 evidence unavailable: {badgeSpecimenLibrary.note}</p>
{/if}
