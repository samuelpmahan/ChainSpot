<!--
	The course-correction overlay: one SVG in source px, rendered inside ImageEditorPane's transformed image group
	(so it pans and zooms with the image and needs no per-frame redraw). It only draws. Every gesture reaches the page
	through ImageViewport's claim protocol and `hitTestCourse`; nothing here listens for pointer events. Handles keep
	a constant screen size by dividing by `zoom`.
-->
<script lang="ts">
	import { deriveCorridorBand, deriveCorridorCenterline } from '$lib/corridor';
	import type { AnnotatedHole, SourcePoint } from '$lib/domain/project';
	import type { HoleEvidence } from '$lib/import/courseGeometry';
	import { STATUS_COLOURS, reviewStatus } from '$lib/courseCorrection';
	import type { CorrectionSelection } from '$lib/courseCorrection';

	interface Props {
		holes: readonly AnnotatedHole[];
		evidenceByHole: ReadonlyMap<string, HoleEvidence>;
		selection: CorrectionSelection | null;
		zoom: number;
		widthPx: number;
		heightPx: number;
	}

	let { holes, evidenceByHole, selection, zoom, widthPx, heightPx }: Props = $props();

	const points = (list: readonly SourcePoint[]): string => list.map((p) => `${p.xPx},${p.yPx}`).join(' ');
	let px = $derived(1 / zoom);

	function isSelectedHandle(holeId: string, kind: 'tee' | 'basket' | 'bend', index = -1): boolean {
		if (!selection || selection.holeId !== holeId || !selection.handle) return false;
		if (selection.handle.kind !== kind) return false;
		return kind !== 'bend' || (selection.handle.kind === 'bend' && selection.handle.index === index);
	}
</script>

<svg
	class="course-correction-layer"
	data-testid="course-correction-layer"
	viewBox={`0 0 ${widthPx} ${heightPx}`}
	width={widthPx}
	height={heightPx}
	aria-hidden="true"
>
	<!-- Corridors under handles, the selected hole last so it draws on top. -->
	{#each [...holes].sort((a, b) => Number(a.id === selection?.holeId) - Number(b.id === selection?.holeId)) as hole (hole.id)}
		{@const evidence = evidenceByHole.get(hole.id)}
		{@const status = reviewStatus(evidence)}
		{@const colour = STATUS_COLOURS[status]}
		{@const unconfirmed = evidence ? evidence.confidence.level !== 'confirmed' : false}
		{@const band = deriveCorridorBand(hole)}
		{@const line = deriveCorridorCenterline(hole)}
		{@const selected = hole.id === selection?.holeId}
		<g
			class="hole"
			class:selected
			data-testid={`cc-hole-${hole.number}`}
			data-status={status}
			data-bends={hole.corridorBends.length}
			style={`--hole-colour:${colour}`}
		>
			{#if band}
				<polygon
					class="band"
					points={points(band)}
					stroke-width={(selected ? 2.5 : 1.5) * px}
					stroke-dasharray={unconfirmed ? `${6 * px} ${4 * px}` : undefined}
				/>
			{/if}
			{#if line.length >= 2}
				<polyline class="centerline" points={points(line)} stroke-width={(selected ? 2.5 : 1.5) * px} />
			{/if}
			{#if hole.tee}
				<circle
					class="handle tee"
					class:active={isSelectedHandle(hole.id, 'tee')}
					data-testid={`cc-tee-${hole.number}`}
					data-x-px={hole.tee.xPx}
					data-y-px={hole.tee.yPx}
					cx={hole.tee.xPx}
					cy={hole.tee.yPx}
					r={(isSelectedHandle(hole.id, 'tee') ? 8 : 6.5) * px}
					stroke-width={2 * px}
				/>
				<text class="label" x={hole.tee.xPx + 9 * px} y={hole.tee.yPx - 9 * px} font-size={13 * px} stroke-width={3 * px}>{hole.number}</text>
			{/if}
			{#if hole.basket}
				<circle
					class="handle basket"
					class:active={isSelectedHandle(hole.id, 'basket')}
					data-testid={`cc-basket-${hole.number}`}
					data-x-px={hole.basket.xPx}
					data-y-px={hole.basket.yPx}
					cx={hole.basket.xPx}
					cy={hole.basket.yPx}
					r={(isSelectedHandle(hole.id, 'basket') ? 8 : 6.5) * px}
					stroke-width={3 * px}
				/>
			{/if}
			{#each hole.corridorBends as bend, index (index)}
				<circle
					class="handle bend"
					class:active={isSelectedHandle(hole.id, 'bend', index)}
					data-testid={`cc-bend-${hole.number}-${index}`}
					data-x-px={bend.xPx}
					data-y-px={bend.yPx}
					cx={bend.xPx}
					cy={bend.yPx}
					r={(isSelectedHandle(hole.id, 'bend', index) ? 7 : 5) * px}
					stroke-width={2 * px}
				/>
			{/each}
		</g>
	{/each}
</svg>

<style>
	.course-correction-layer {
		position: absolute;
		inset: 0;
		overflow: visible;
		pointer-events: none;
	}

	.band {
		fill: var(--hole-colour);
		fill-opacity: 0.18;
		stroke: var(--hole-colour);
		stroke-linejoin: round;
	}

	.hole.selected .band {
		fill-opacity: 0.32;
	}

	.centerline {
		fill: none;
		stroke: var(--hole-colour);
		stroke-linejoin: round;
		stroke-linecap: round;
		opacity: 0.9;
	}

	/* Cursor affordance only: the shapes take no listeners; ImageViewport's claim protocol owns the gesture. */
	.band,
	.centerline {
		pointer-events: visiblePainted;
		cursor: copy;
	}

	.handle {
		pointer-events: visiblePainted;
		cursor: grab;
	}

	.tee {
		fill: var(--hole-colour);
		stroke: #fafafa;
	}

	.basket {
		fill: #18181b;
		stroke: var(--hole-colour);
	}

	.bend {
		fill: #fafafa;
		stroke: var(--hole-colour);
	}

	.handle.active {
		stroke: #facc15;
	}

	.label {
		fill: #fafafa;
		stroke: #18181b;
		paint-order: stroke;
		font-weight: 700;
		font-family: system-ui, sans-serif;
	}
</style>
