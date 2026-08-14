<script lang="ts">
	/**
	 * Map Round: one played round's throws and walking path, once per round,
	 * overlaid on course geometry recovered from Course Memory (or annotated
	 * fresh, if this round's course has never been saved).
	 *
	 * A thin route wrapper around the shared `AnnotationWorkspace` component
	 * with a fixed `mode="round"` — see `src/routes/annotate-course/+page.svelte`
	 * for the sibling route and the rationale for the split, and
	 * `$lib/components/AnnotationWorkspace.svelte` for the actual annotation
	 * surface, shared by both routes.
	 */
	import AnnotationWorkspace from '$lib/components/AnnotationWorkspace.svelte';
</script>

<AnnotationWorkspace mode="round" sessionKey="map-round" />
