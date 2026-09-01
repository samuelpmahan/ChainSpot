<script lang="ts">
	import M2EvidenceView from './M2EvidenceView.svelte';
	import type { M2AppearanceVariant, M2BadgeProjectionSubject, M2Projection } from './m2Projection';

	let {
		subject,
		projection = 'transition',
		zoom = 8,
		showGrid = false,
		showReceipt = true,
		supportThreshold = 0,
		appearanceVariant = 'exact-baseline'
	}: {
		subject: M2BadgeProjectionSubject;
		projection?: M2Projection;
		zoom?: number;
		showGrid?: boolean;
		showReceipt?: boolean;
		/** Projection-only cutoff for the overlap gradient. */
		supportThreshold?: number;
		appearanceVariant?: M2AppearanceVariant;
	} = $props();
</script>

<M2EvidenceView {subject} {projection} {zoom} {showGrid} {showReceipt} {supportThreshold} {appearanceVariant} />
