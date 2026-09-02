<script lang="ts">
	import { base } from '$app/paths';
	import PcrInspectionHost from '$lib/evidence-workbench/PcrInspectionHost.svelte';
	import {
		DEFAULT_PCR_INSPECTION_PLAN,
		PCR_MATERIALIZATION_VIEWS
	} from '$lib/evidence-workbench/pcrInspectionPlan';
	import type { BadgeSpecimenLibrary } from '$lib/evidence-workbench/badgeSpecimen';

	let { data }: { data: { library: BadgeSpecimenLibrary } } = $props();
	const defaultPlan = DEFAULT_PCR_INSPECTION_PLAN;
	let pcrId = $state<string>(defaultPlan.pcrId);
	let tickId = $state<string>(defaultPlan.tickId);
	let specimenId = $state<string>(defaultPlan.specimenId);
	let materializationView = $state<string>(defaultPlan.materializationView);
	let zoom = $state(defaultPlan.zoom);
	let showGrid = $state(defaultPlan.showGrid);
	let showReceipt = $state(defaultPlan.showReceipt);

	let selectedPcr = $derived(
		data.library.pcrs.find((candidate) => candidate.id === pcrId) ?? data.library.pcrs[0]
	);

	function selectPcr() {
		tickId = selectedPcr?.ticks[0]?.operation.id ?? '';
	}

	function resetPlan() {
		pcrId = defaultPlan.pcrId;
		tickId = defaultPlan.tickId;
		specimenId = defaultPlan.specimenId;
		materializationView = defaultPlan.materializationView;
		zoom = defaultPlan.zoom;
		showGrid = defaultPlan.showGrid;
		showReceipt = defaultPlan.showReceipt;
	}
</script>

<svelte:head><title>ChainSpot staging · PCR ProofFloor</title></svelte:head>

<nav>
	<a href={`${base}/lab`}>← LAB</a><strong>PCR ProofFloor</strong><button onclick={resetPlan}
		>Default plan</button
	>
</nav>

<section class="plan" aria-label="PCR inspection plan">
	<label
		>PCR<select bind:value={pcrId} onchange={selectPcr}
			>{#each data.library.pcrs as pcr}<option value={pcr.id}>{pcr.title}</option>{/each}</select
		></label
	>
	<label
		>Tick<select bind:value={tickId}
			>{#each selectedPcr?.ticks ?? [] as tick}<option value={tick.operation.id}
					>{tick.operation.id}</option
				>{/each}</select
		></label
	>
	<label
		>Specimen<select bind:value={specimenId}
			>{#each data.library.specimens as specimen}<option value={specimen.id}
					>{specimen.title}</option
				>{/each}</select
		></label
	>
	<label
		>Materialization<select bind:value={materializationView}
			>{#each PCR_MATERIALIZATION_VIEWS as view}<option value={view}>{view}</option>{/each}</select
		></label
	>
	<label>Zoom<input type="range" min="1" max="16" step="1" bind:value={zoom} /></label>
	<label><input type="checkbox" bind:checked={showGrid} /> Grid</label>
	<label><input type="checkbox" bind:checked={showReceipt} /> Receipt</label>
</section>

<PcrInspectionHost
	library={data.library}
	{pcrId}
	{tickId}
	{specimenId}
	{materializationView}
	{zoom}
	{showGrid}
	{showReceipt}
/>

<style>
	:global(body) {
		margin: 0;
		background: #e7e5e4;
		color: #171717;
		font-family: system-ui, sans-serif;
	}
	nav {
		display: flex;
		gap: 1rem;
		align-items: center;
		padding: 0.75rem 1rem;
		background: #171717;
		color: white;
	}
	nav strong {
		margin-right: auto;
	}
	nav a {
		color: #c4b5fd;
	}
	button,
	select,
	input {
		font: inherit;
	}
	.plan {
		display: flex;
		flex-wrap: wrap;
		gap: 0.75rem;
		align-items: end;
		padding: 0.75rem 1rem;
		background: #fafaf9;
		border-bottom: 1px solid #d6d3d1;
	}
	.plan label {
		display: grid;
		gap: 0.2rem;
		font-size: 0.75rem;
		font-weight: 650;
	}
	.plan label:has(input[type='checkbox']) {
		display: flex;
		align-items: center;
	}
</style>
