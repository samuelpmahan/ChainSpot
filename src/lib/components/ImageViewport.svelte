<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { ViewportLayer, ViewportMarker } from '$lib/viewport';
	import type { CropInsets } from '$lib/raster';

	import { untrack } from 'svelte';

	let {
		layers,
		selectedIndex,
		onLayerMove,
		cropPreview,
		children,
		height = '70vh',
		fitKey = 0,
		markers = []
	}: {
		layers: ViewportLayer[];
		selectedIndex: number;
		onLayerMove: (index: number, deltaX: number, deltaY: number) => void;
		cropPreview: CropInsets | null;
		children?: Snippet;
		height?: string;
		fitKey?: number; // bump to re-frame the content (new stitch result etc.)
		/** per-layer detection markers, in that layer's local (display) pixels */
		markers?: ViewportMarker[][];
	} = $props();

	// Only the OVERLAP goes translucent (55% visible), not the whole tile.
	// Translation-only placement means overlaps are axis-aligned rects; a CSS
	// mask (full-alpha base, subtract layers over each intersect, in the
	// layer's local pixels) fades exactly those regions of THIS image.
	function overlapMask(index: number): string {
		const me = layers[index];
		const rects: { x: number; y: number; w: number; h: number }[] = [];
		for (const [i, other] of layers.entries()) {
			if (i === index) continue;
			const x0 = Math.max(me.x, other.x);
			const y0 = Math.max(me.y, other.y);
			const x1 = Math.min(me.x + me.widthPx, other.x + other.widthPx);
			const y1 = Math.min(me.y + me.heightPx, other.y + other.heightPx);
			if (x1 > x0 && y1 > y0) rects.push({ x: x0 - me.x, y: y0 - me.y, w: x1 - x0, h: y1 - y0 });
		}
		if (rects.length === 0) return '';
		// layer order matters: the FIRST layer is on top and its composite op is
		// "top OP accumulated-below" — so the full-alpha base goes first with
		// subtract, and the 45%-alpha overlap rects accumulate below it via add.
		const images = ['linear-gradient(#000 0 0)'].concat(
			rects.map(() => 'linear-gradient(rgba(0,0,0,0.45) 0 0)')
		);
		const sizes = ['100% 100%'].concat(rects.map((r) => `${r.w}px ${r.h}px`));
		const positions = ['0 0'].concat(rects.map((r) => `${r.x}px ${r.y}px`));
		const composites = ['subtract'].concat(rects.map(() => 'add'));
		return (
			`mask-image: ${images.join(', ')}; mask-size: ${sizes.join(', ')}; ` +
			`mask-position: ${positions.join(', ')}; mask-repeat: no-repeat; ` +
			`mask-composite: ${composites.join(', ')};`
		);
	}

	let scale = $state(0.2);
	let offsetX = $state(0);
	let offsetY = $state(0);

	// one capture target (the container) for both pan and layer-drag, so
	// pointermove routing never depends on which child started the gesture
	let container: HTMLElement;

	// fit-to-content: frame the layers' bounding box with a margin. Runs when
	// fitKey changes (new stitch/spread), never on drags or nudges.
	function fitToContent() {
		const current = untrack(() => layers);
		if (!container || current.length === 0) return;
		let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
		for (const l of current) {
			x0 = Math.min(x0, l.x);
			y0 = Math.min(y0, l.y);
			x1 = Math.max(x1, l.x + l.widthPx);
			y1 = Math.max(y1, l.y + l.heightPx);
		}
		const margin = 24;
		const cw = container.clientWidth - margin * 2;
		const ch = container.clientHeight - margin * 2;
		if (cw <= 0 || ch <= 0) return;
		scale = Math.min(cw / (x1 - x0), ch / (y1 - y0));
		offsetX = margin + (cw - (x1 - x0) * scale) / 2 - x0 * scale;
		offsetY = margin + (ch - (y1 - y0) * scale) / 2 - y0 * scale;
	}

	$effect(() => {
		void fitKey;
		fitToContent();
	});

	let panning = false;
	let movingLayerIndex = -1;
	let lastX = 0;
	let lastY = 0;

	function onWheel(event: WheelEvent) {
		event.preventDefault();
		const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();

		const cx = event.clientX - rect.left;
		const cy = event.clientY - rect.top;
		const factor = event.deltaY < 0 ? 1.1 : 1 / 1.1;
		offsetX = cx - (cx - offsetX) * factor;
		offsetY = cy - (cy - offsetY) * factor;
		scale *= factor;
	}

	function onPointerDown(event: PointerEvent) {
		container.setPointerCapture(event.pointerId);
		panning = true;
		lastX = event.clientX;
		lastY = event.clientY;
	}

	function onPointerMove(event: PointerEvent) {
		if (movingLayerIndex >= 0) {
			const deltaX = (event.clientX - lastX) / scale;
			const deltaY = (event.clientY - lastY) / scale;
			onLayerMove(movingLayerIndex, deltaX, deltaY);
			lastX = event.clientX;
			lastY = event.clientY;
			return;
		}

		if (!panning) return;
		offsetX += event.clientX - lastX;
		offsetY += event.clientY - lastY;
		lastX = event.clientX;
		lastY = event.clientY;
	}

	function onPointerUp(event: PointerEvent) {
		panning = false;
		movingLayerIndex = -1;
	}

	function onLayerPointerDown(event: PointerEvent, index: number) {
		event.stopPropagation();
		container.setPointerCapture(event.pointerId);
		movingLayerIndex = index;
		lastX = event.clientX;
		lastY = event.clientY;
	}
</script>

<div
	bind:this={container}
	role="application"
	aria-label="Stitch inspection viewport"
	style={`position: relative; overflow: hidden; height: ${height}; border: 1px solid black; touch-action: none; cursor: grab;`}
	onwheel={onWheel}
	onpointerdown={onPointerDown}
	onpointermove={onPointerMove}
	onpointerup={onPointerUp}
>
	{#each layers as layer, index (layer.objectUrl)}
		<div
			style={`position: absolute; left: 0; top: 0; transform-origin: 0 0; transform: translate(${offsetX + layer.x * scale}px, ${offsetY + layer.y * scale}px) scale(${scale}); opacity: ${layer.opacity}; outline: ${index === selectedIndex ? 5 : 3}px solid ${layer.borderColor}; cursor: move;`}
		>
			<img
				src={layer.objectUrl}
				alt=""
				draggable="false"
				onpointerdown={(event) => onLayerPointerDown(event, index)}
				style={`display: block; ${overlapMask(index)}`}
			/>
			{#each markers[index] ?? [] as marker (marker.xPx + ':' + marker.yPx + ':' + marker.label)}
				<div
					title={marker.title}
					style={`position: absolute; left: ${marker.xPx}px; top: ${marker.yPx}px; transform: translate(-50%, -50%); width: 44px; height: 44px; border-radius: 50%; background: ${marker.color}; color: white; display: flex; align-items: center; justify-content: center; font: bold 24px sans-serif; opacity: 0.85; pointer-events: none;`}
				>
					{marker.label}
				</div>
			{/each}
			{#if cropPreview}
				<div
					aria-label="Proposed crop preview"
					style="position: absolute; inset: 0; pointer-events: none;"
				>
					<div
						style={`position: absolute; left: 0; top: 0; width: 100%; height: ${cropPreview.top}px; background: rgba(0, 0, 0, 0.45);`}
					></div>
					<div
						style={`position: absolute; right: 0; top: ${cropPreview.top}px; width: ${cropPreview.right}px; height: ${layer.heightPx - cropPreview.top - cropPreview.bottom}px; background: rgba(0, 0, 0, 0.45);`}
					></div>
					<div
						style={`position: absolute; left: 0; bottom: 0; width: 100%; height: ${cropPreview.bottom}px; background: rgba(0, 0, 0, 0.45);`}
					></div>
					<div
						style={`position: absolute; left: 0; top: ${cropPreview.top}px; width: ${cropPreview.left}px; height: ${layer.heightPx - cropPreview.top - cropPreview.bottom}px; background: rgba(0, 0, 0, 0.45);`}
					></div>
					<div
						style={`position: absolute; box-sizing: border-box; left: ${cropPreview.left}px; top: ${cropPreview.top}px; width: ${layer.widthPx - cropPreview.left - cropPreview.right}px; height: ${layer.heightPx - cropPreview.top - cropPreview.bottom}px; border: 5px solid lime;`}
					></div>
				</div>
			{/if}
		</div>
	{/each}
	{#if children}
		<!-- stop pointerdown here: if it reaches the container, setPointerCapture
		     retargets the gesture and the buttons' click events never fire -->
		<div
			role="toolbar"
			tabindex="-1"
			aria-label="Viewport controls"
			onpointerdown={(event) => event.stopPropagation()}
			style="position: absolute; top: 0.5rem; right: 0.5rem; display: flex; flex-direction: row; align-items: center; gap: 0.5rem; max-width: min(95%, 60rem);"
		>
			{@render children()}
		</div>
	{/if}
</div>
