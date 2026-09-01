<script lang="ts">
	import BadgeEvidenceView from './BadgeEvidenceView.svelte';
	import type { BadgeSpecimen } from './badgeSpecimen';

	let { specimen, zoom = 5 }: { specimen: BadgeSpecimen; zoom?: number } = $props();

	const stages = [
		['bw', '1 · B+W baseline'],
		['residue-before', '2 · residue after B+W'],
		['aa', '3 · newly explained AA'],
		['residue-after', '4 · residue after B+W + AA']
	] as const;
</script>

<section class="stack">
	<header>
		<p>COMPOSED EVIDENCE VIEW</p>
		<h2>{specimen.title}: refinement sequence</h2>
		<span>The exact primitive projection is reused four times.</span>
	</header>
	<div class="stages">
		{#each stages as [projection, label]}
			<section>
				<h3>{label}</h3>
				<BadgeEvidenceView {specimen} {projection} {zoom} showReceipt={false} />
			</section>
		{/each}
	</div>
</section>

<style>
	.stack {
		min-height: 100vh;
		padding: 1.25rem;
		background: #f5f5f4;
		color: #171717;
		font-family: ui-sans-serif, system-ui, sans-serif;
	}
	header p {
		margin: 0;
		color: #6d28d9;
		font-size: 0.7rem;
		font-weight: 750;
		letter-spacing: 0.12em;
	}
	header h2 {
		margin: 0.15rem 0;
	}
	header span {
		color: #737373;
	}
	.stages {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(20rem, 1fr));
		gap: 1rem;
		margin-top: 1.25rem;
	}
	.stages > section {
		min-width: 0;
		background: white;
		border: 1px solid #d6d3d1;
	}
	h3 {
		margin: 0;
		padding: 0.75rem 1rem;
		border-bottom: 1px solid #e7e5e4;
		font-size: 0.85rem;
	}
</style>
