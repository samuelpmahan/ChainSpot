<script lang="ts">
	import type { ComponentProps } from 'svelte';
	import DiscCard from './DiscCard.svelte';
	// Storybook supplies an explicit specimen width, not a product placement assumption.
	let { width = 280, ...card }: ComponentProps<typeof DiscCard> & { width?: number } = $props();
</script>

<div style:width={`${width}px`}><DiscCard {...card} /></div>
