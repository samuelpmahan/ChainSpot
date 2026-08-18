<script lang="ts">
	/**
	 * Pan/zoomable display of a fetched-but-not-yet-committed aerial image
	 * (CHSPT-68). Reuses the exact viewport machinery the committed panes use
	 * (`ViewportController` + `ImageViewport` + `createPaneScene`) so panning
	 * the preview against the UDisc source next door feels identical to the
	 * real panes — but none of `ImagePane`'s editor/marker/intake coupling:
	 * the input is just an object URL, decoded locally, never entering domain
	 * state. Same `canvas2dAvailable()` guard as `ImagePane`, so jsdom mounts
	 * cleanly while raster behavior stays a browser-verified claim.
	 */
	import { onDestroy } from 'svelte';
	import ImageViewport from './ImageViewport.svelte';
	import ImageEdgeLoadButtons from './ImageEdgeLoadButtons.svelte';
	import { ViewportController } from '$lib/viewport.svelte';
	import { canvas2dAvailable, createPaneScene } from '$lib/scene';
	import type { PaneScene } from '$lib/scene';
	import { exposedLoadEdges } from '$lib/edgeLoadZones';
	import type { EdgeDirection } from '$lib/edgeLoadZones';

	interface Props {
		/** Object URL of the preview image blob; owned (and revoked) by the caller. */
		objectUrl: string;
		alt: string;
		testid?: string;
		/** Fires when the URL fails to decode — the caller clears the preview. */
		onDecodeError?: () => void;
		/** Enables load-more affordances once the user pans beyond a preview edge. */
		edgeLoadEnabled?: boolean;
		edgeLoadBusy?: boolean;
		onEdgeLoad?: (direction: EdgeDirection) => void;
	}

	let {
		objectUrl,
		alt,
		testid = 'aerial-preview',
		onDecodeError,
		edgeLoadEnabled = false,
		edgeLoadBusy = false,
		onEdgeLoad
	}: Props = $props();

	let vp = new ViewportController();
	let scene: PaneScene | null = null;
	let canvasSupport: boolean | null = null;
	/** URL currently rendered into the scene, so effect re-runs never re-decode the same image. */
	let renderedUrl: string | null = null;

	function canvasAvailable(): boolean {
		if (canvasSupport === null) canvasSupport = canvas2dAvailable();
		return canvasSupport;
	}

	/**
	 * Same edge-exposure rule as the committed ImagePane, but available while
	 * the aerial is still only a preview. This is the important lifecycle seam:
	 * users can move/expand the candidate BEFORE accepting it as the clean target.
	 */
	let edgeLoadDirections = $derived.by(() => {
		const target = vp.fitTarget;
		if (!edgeLoadEnabled || !onEdgeLoad || !target) return [];
		return exposedLoadEdges({
			view: vp.view,
			fitView: vp.fitView,
			viewportWidthPx: vp.size.width,
			viewportHeightPx: vp.size.height,
			imageWidthPx: target.widthPx,
			imageHeightPx: target.heightPx
		});
	});

	/** Creates the Konva scene once the viewport container exists. */
	$effect(() => {
		const container = vp.container;
		if (!container || !canvasAvailable() || scene) return;
		scene = createPaneScene(container);
		scene.setStageSize(vp.size.width, vp.size.height);
	});

	$effect(() => {
		scene?.applyTransform(vp.view, 0);
	});

	$effect(() => {
		scene?.setStageSize(vp.size.width, vp.size.height);
	});

	/** Decodes the object URL and renders it, establishing the fit once per URL. */
	$effect(() => {
		const url = objectUrl;
		const activeScene = scene;
		if (!activeScene || renderedUrl === url) return;
		renderedUrl = url;
		const image = new Image();
		image.onload = () => {
			// The preview may have been discarded/replaced while decoding.
			if (renderedUrl !== url || !scene) return;
			scene.setImage(image, image.naturalWidth, image.naturalHeight);
			vp.setFitTarget({ xPx: 0, yPx: 0, widthPx: image.naturalWidth, heightPx: image.naturalHeight });
			vp.fit();
		};
		image.onerror = () => {
			if (renderedUrl !== url) return;
			onDecodeError?.();
		};
		image.src = url;
	});

	onDestroy(() => {
		scene?.destroy();
		scene = null;
	});
</script>

<div class="aerial-preview" data-testid={testid}>
	<ImageViewport
		controller={vp}
		testid={`${testid}-viewport`}
		ariaLabel={alt}
	>
		{#snippet content()}{/snippet}
	</ImageViewport>
	{#if edgeLoadDirections.length > 0}
		<ImageEdgeLoadButtons
			directions={edgeLoadDirections}
			busy={edgeLoadBusy}
			onLoad={(direction) => onEdgeLoad?.(direction)}
		/>
	{/if}
	<button
		type="button"
		class="fit-button"
		data-testid={`${testid}-fit`}
		onclick={() => vp.fit()}
		aria-label="Fit the aerial preview to the pane"
	>
		Fit
	</button>
</div>

<style>
	.aerial-preview {
		position: relative;
		width: 100%;
		height: 100%;
		overflow: hidden;
	}

	.fit-button {
		position: absolute;
		right: 0.5rem;
		bottom: 0.5rem;
		z-index: 2;
		min-height: 2.25rem;
		padding: 0.4rem 0.8rem;
		border: 1px solid #3f3f46;
		border-radius: 4px;
		background-color: #27272acc;
		color: #e4e4e7;
		font-size: 0.85rem;
		cursor: pointer;
	}
</style>
