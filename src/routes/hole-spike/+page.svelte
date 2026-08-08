<script lang="ts">
	import type { SourcePoint } from '$lib/domain/annotatedRound';
	import { deriveCorridorBand, deriveCorridorCenterline } from '$lib/corridor';
	import { hole, image, widthPx, heightPx } from './sampleHole';

	const pointsAttr = (points: readonly SourcePoint[]): string =>
		points.map((point) => `${point.xPx},${point.yPx}`).join(' ');

	const corridorBand = deriveCorridorBand(hole);
	const centerline = deriveCorridorCenterline(hole);

	const throwRoute: SourcePoint[] = [
		...(hole.tee ? [hole.tee] : []),
		...hole.shots.map((shot) => shot.landing),
		...(hole.basket ? [hole.basket] : [])
	];
</script>

<main class="spike-page">
	<h1>Hole Rendering Spike</h1>

	<svg
		class="hole-svg"
		viewBox="0 0 {widthPx} {heightPx}"
		role="img"
		aria-label="Single disc golf hole rendered over aerial imagery"
	>
		<image
			href={image}
			width="{widthPx}"
			height="{heightPx}"
			preserveAspectRatio="xMidYMid meet"
		/>

		{#if corridorBand}
			<g class="corridor">
				<polygon class="corridor-fill" points={pointsAttr(corridorBand)} />
			</g>
		{/if}

		{#if centerline.length >= 2}
			<polyline class="centerline" points={pointsAttr(centerline)} />
		{/if}

		{#each hole.corridorBends as bend, index (index)}
			<circle class="bend-marker" cx={bend.xPx} cy={bend.yPx} r="6" />
		{/each}

		<g class="throws">
			<polyline class="throw-lines" points={pointsAttr(throwRoute)} />
			{#each hole.shots as shot (shot.id)}
				<circle class="throw-marker" cx={shot.landing.xPx} cy={shot.landing.yPx} r="5.5" />
			{/each}
		</g>

		{#if hole.tee}
			<g class="tee-marker">
				<circle cx={hole.tee.xPx} cy={hole.tee.yPx} r="10" />
			</g>
		{/if}

		{#if hole.basket}
			<g class="basket-marker">
				<circle cx={hole.basket.xPx} cy={hole.basket.yPx} r="10" />
				<circle cx={hole.basket.xPx} cy={hole.basket.yPx} r="3.5" />
			</g>
		{/if}
	</svg>
</main>

<style>
	.spike-page {
		padding: 1rem;
	}

	.hole-svg {
		width: 100%;
		max-width: 960px;
		height: auto;
		display: block;
		background: #000;
	}

	.corridor-fill {
		fill: rgba(34, 197, 94, 0.18);
		stroke: rgba(34, 197, 94, 0.75);
		stroke-width: 1.5;
	}

	.centerline {
		fill: none;
		stroke: rgba(255, 255, 255, 0.85);
		stroke-width: 1.5;
		stroke-dasharray: 6 4;
	}

	.bend-marker {
		fill: #a78bfa;
		stroke: #ffffff;
		stroke-width: 1.5;
	}

	.throw-lines {
		fill: none;
		stroke: rgba(251, 113, 133, 0.9);
		stroke-width: 1.5;
		stroke-dasharray: 5 5;
	}

	.throw-marker {
		fill: #f87171;
		stroke: #ffffff;
		stroke-width: 1.5;
	}

	.tee-marker circle {
		fill: #22d3ee;
		stroke: #ffffff;
		stroke-width: 2;
	}

	.basket-marker circle:first-child {
		fill: #facc15;
		stroke: #ffffff;
		stroke-width: 2;
	}

	.basket-marker circle:last-child {
		fill: #854d0e;
		stroke: #ffffff;
		stroke-width: 1;
	}
</style>
