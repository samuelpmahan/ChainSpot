<script lang="ts">
	/**
	 * Client-only marker set after hydration and event delegation are in place.
	 * The e2e suite waits for it before simulating user interaction, because
	 * events dispatched before hydration completes are not delegated.
	 */
	$effect(() => {
		document.documentElement.dataset.appReady = 'true';
	});

	let { children }: { children: import('svelte').Snippet } = $props();
</script>

{@render children()}
