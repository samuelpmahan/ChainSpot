<script lang="ts">
	/**
	 * Annotate Course: course geometry (tee/basket/corridor bends, hole
	 * numbers), CV-assisted, once per course layout.
	 *
	 * A thin route wrapper around the shared `AnnotationWorkspace` component
	 * with a fixed `mode="map"` — the two annotation activities ChainSpot
	 * separates (course geometry vs. round-specific throws/walk path) used to
	 * be one route (`/annotate-round`) with an internal, easy-to-miss mode
	 * toggle; they are now two real routes sharing one implementation. See
	 * `$lib/components/AnnotationWorkspace.svelte` for the actual annotation
	 * surface, shared with `/map-round`. Unit tests mount that component
	 * directly (passing `mode`/`sessionKey` explicitly) rather than this
	 * wrapper, so this file carries no test-injection props.
	 */
	import AnnotationWorkspace from '$lib/components/AnnotationWorkspace.svelte';
</script>

<AnnotationWorkspace mode="map" sessionKey="annotate-course" />
