<script lang="ts">
	import { pcrRenderId } from '@chainspot/alg/exec';
	import { badgeSpecimenLibrary } from 'virtual:e-badge-specimens';
	import BadgeEvidenceView from './BadgeEvidenceView.svelte';
	import M1EvidenceView from './M1EvidenceView.svelte';
	import TickInspection from './TickInspection.svelte';
	import { BADGE_STORY_PROJECTIONS, type BadgeProjection } from './badgeProjection';
	import { M1_PROJECTIONS, type M1Projection } from './m1Projection';

	let {
		pcrId,
		tickId,
		specimenId,
		materializationView = 'composed',
		zoom = 6,
		showGrid = false,
		showReceipt = true
	}: {
		pcrId: string;
		tickId: string;
		specimenId: string;
		materializationView?: string;
		zoom?: number;
		showGrid?: boolean;
		showReceipt?: boolean;
	} = $props();

	let pcr = $derived(
		badgeSpecimenLibrary.pcrs.find((candidate) => candidate.id === pcrId) ??
			badgeSpecimenLibrary.pcrs[0]
	);
	let specimen = $derived(
		badgeSpecimenLibrary.specimens.find((candidate) => candidate.id === specimenId) ??
			badgeSpecimenLibrary.specimens[0]
	);
	let basket = $derived(badgeSpecimenLibrary.m1?.objects.find((object) => object.kind === 'basket'));
	let badgeProjection = $derived(
		BADGE_STORY_PROJECTIONS.includes(materializationView as BadgeProjection)
			? (materializationView as BadgeProjection)
			: 'composed'
	);
	let m1Projection = $derived(
		M1_PROJECTIONS.includes(materializationView as M1Projection)
			? (materializationView as M1Projection)
			: 'unexplained'
	);
	let residue = $derived.by(() => {
		if (pcr?.id === 'badge-pcr' && specimen) {
			return [{ label: 'BadgePixelResidue', count: specimen.metrics.residueAfter, note: 'exact already-computed crop pixels remaining after owned B+W and additive AA' }];
		}
		if (pcr?.id === 'basket-pcr' && basket) {
			return basket.accounting.status === 'known'
				? [{ label: 'BasketPixelResidue', count: basket.accounting.unexplainedPixels.length, note: 'exact M1 pixels not explained by the current Basket assembly' }]
				: [{ label: 'BasketPixelResidue', count: null, note: basket.accounting.reason }];
		}
		if (pcr?.id === 'intake-pcr') {
			return [{ label: 'MoleculePixelResidue', count: null, note: 'UNKNOWN — canonical intake establishes pixels, not detector ownership' }];
		}
		return [];
	});
	let renderId = $derived(
		pcr
			? pcrRenderId(pcr, { materializationView, zoom, showGrid, showReceipt, specimenId })
			: 'UNKNOWN'
	);
</script>

{#if pcr}
	<main>
		<TickInspection {pcr} {tickId} {residue} />
		<section class="projection-only">
			<header>
				<div><strong>Projection-only MaterializationView</strong><span>View Args never cross the production gateway</span></div>
				<code>renderId {renderId}</code>
			</header>
			{#if pcr.id === 'badge-pcr' && specimen}
				<BadgeEvidenceView {specimen} projection={badgeProjection} {zoom} {showGrid} {showReceipt} />
			{:else if pcr.id === 'basket-pcr' && basket && badgeSpecimenLibrary.m1}
				<M1EvidenceView library={badgeSpecimenLibrary.m1} subjectId={basket.id} projection={m1Projection} {zoom} {showReceipt} />
			{:else if pcr.id === 'intake-pcr'}
				<p>The canonical RGBA Materialization is frozen in the selected Tick testimony above. This projection performs no decode, normalization, or detector work.</p>
			{:else}
				<p>Materialization UNKNOWN: {badgeSpecimenLibrary.note}</p>
			{/if}
		</section>
	</main>
{:else}
	<p>No PCR ran: {badgeSpecimenLibrary.note}</p>
{/if}

<style>
	main { display: grid; gap: 1rem; padding: 1rem; background: #fff; }
	.projection-only { border-top: 4px solid #6d28d9; background: #f5f3ff; padding: .75rem; }
	header { display: flex; justify-content: space-between; gap: 1rem; align-items: end; }
	header div { display: grid; }
	header span { color: #6d28d9; font-size: .75rem; }
	header code { color: #737373; font-size: .68rem; overflow-wrap: anywhere; }
</style>
