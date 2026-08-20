<script lang="ts">
	import { onMount } from 'svelte';

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

	/**
	 * Ferrari-mode hotfix: MiddleOut is still a display-only diagnostic inside
	 * AnnotationWorkspace, but Annotate Course should expose it immediately
	 * whenever a MiddleOut result arrives. The toggle itself is conditional on
	 * `courseDetection.middleOut`, so watch for that control to appear and
	 * activate it exactly once. If the workspace later defaults it on itself,
	 * this becomes a no-op and can be removed without changing behavior.
	 */
	onMount(() => {
		const enableMiddleOut = (): boolean => {
			const toggle = document.querySelector<HTMLInputElement>('[data-testid="middleout-overlay-toggle"]');
			if (!toggle) return false;
			if (!toggle.checked) toggle.click();
			return true;
		};

		if (enableMiddleOut()) return;
		const observer = new MutationObserver(() => {
			if (!enableMiddleOut()) return;
			observer.disconnect();
		});
		observer.observe(document.body, { childList: true, subtree: true });
		return () => observer.disconnect();
	});
</script>

<AnnotationWorkspace mode="map" sessionKey="annotate-course" />