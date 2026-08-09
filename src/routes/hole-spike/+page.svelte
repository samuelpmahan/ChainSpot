<script lang="ts">
	import { onMount } from 'svelte';
	import { estimateSimilarity } from '$lib/alignment/similarity';
	import { applyTransform } from '$lib/alignment/transform';
	import type { AlignmentPairInput, PointCoordinates } from '$lib/alignment/types';
	import { deriveCorridorBand, deriveCorridorCenterline } from '$lib/corridor';
	import { findImageByRole } from '$lib/domain/project';
	import type { AnnotatedHole, SourcePoint } from '$lib/domain/annotatedRound';
	import { pointInBounds } from '$lib/coords';
	import { readProjectBundle } from '$lib/persistence';

	const FIXTURE_URL = '/resources/hole-spike/one-hole.chainspot.zip';

	type TargetPoint = PointCoordinates;

	interface HoleSpikeScene {
		readonly hole: AnnotatedHole;
		readonly targetWidthPx: number;
		readonly targetHeightPx: number;
		readonly targetImageUrl: string;
		readonly tee: TargetPoint | null;
		readonly basket: TargetPoint | null;
		readonly bends: readonly TargetPoint[];
		readonly centerline: readonly TargetPoint[];
		readonly corridorBand: readonly TargetPoint[] | null;
		readonly shots: readonly TargetPoint[];
		readonly throwRoute: readonly TargetPoint[];
	}

	let loading = $state(true);
	let errorMessage = $state<string | null>(null);
	let scene = $state<HoleSpikeScene | null>(null);
	let targetImageUrl: string | null = null;

	const pointsAttr = (points: readonly PointCoordinates[]): string =>
		points.map((point) => `${point.xPx},${point.yPx}`).join(' ');

	function isFinitePoint(point: PointCoordinates): boolean {
		return Number.isFinite(point.xPx) && Number.isFinite(point.yPx);
	}

	function isTargetPoint(point: SourcePoint, transform: Parameters<typeof applyTransform>[1]): TargetPoint {
		return applyTransform(point, transform);
	}

	function assertTargetGeometry(
		points: readonly TargetPoint[],
		targetWidthPx: number,
		targetHeightPx: number
	): void {
		if (!points.every(isFinitePoint)) {
			throw new Error('The hole alignment produced a non-finite SVG coordinate.');
		}
		if (!points.every((point) => pointInBounds(point, targetWidthPx, targetHeightPx))) {
			throw new Error('The hole alignment placed geometry outside the clean target image.');
		}
	}

	async function loadFixture(): Promise<void> {
		try {
			const response = await fetch(FIXTURE_URL);
			if (!response.ok) {
				throw new Error(`Could not load the real ChainSpot fixture (${response.status}).`);
			}

			const bytes = new Uint8Array(await response.arrayBuffer());
			const file = new File([bytes], 'one-hole.chainspot.zip', { type: 'application/zip' });
			const opened = await readProjectBundle(file);
			if (!opened.ok) {
				if (opened.kind === 'repair') {
					throw new Error('The real ChainSpot fixture requires image repair and cannot be rendered.');
				}
				throw opened.error;
			}

			const target = findImageByRole(opened.state.images, 'target-basemap');
			const hole = opened.state.holes.find((candidate) => candidate.number === 1) ?? opened.state.holes[0];
			if (!target || !hole) {
				throw new Error('The real ChainSpot fixture must contain a target image and one annotated hole.');
			}

			const targetAsset = opened.assets.get(target.id);
			if (!targetAsset) {
				throw new Error('The decoded target image is missing from the real ChainSpot fixture.');
			}

			const pairs: AlignmentPairInput[] = opened.state.controlPointPairs.map((pair) => ({
				id: pair.id,
				enabled: pair.enabled,
				source: pair.source,
				target: pair.target
			}));
			const alignment = estimateSimilarity({ pairs });
			if (!('transform' in alignment)) {
				throw new Error(`The real ChainSpot fixture could not be aligned: ${alignment.reason}.`);
			}

			const transform = alignment.transform;
			const toTarget = (point: SourcePoint): TargetPoint => isTargetPoint(point, transform);
			const tee = hole.tee ? toTarget(hole.tee) : null;
			const basket = hole.basket ? toTarget(hole.basket) : null;
			const bends = hole.corridorBends.map(toTarget);
			const centerline = deriveCorridorCenterline(hole).map(toTarget);
			const corridorBand = deriveCorridorBand(hole)?.map(toTarget) ?? null;
			const shots = hole.shots.map((shot) => toTarget(shot.landing));
			const throwRoute = [...(tee ? [tee] : []), ...shots, ...(basket ? [basket] : [])];
			const geometry = [
				...(tee ? [tee] : []),
				...(basket ? [basket] : []),
				...bends,
				...centerline,
				...shots,
				...(corridorBand ?? [])
			];
			assertTargetGeometry(geometry, target.widthPx, target.heightPx);

			targetImageUrl = URL.createObjectURL(
				new Blob([new Uint8Array(targetAsset.bytes)], { type: target.mimeType })
			);
			scene = {
				hole,
				targetWidthPx: target.widthPx,
				targetHeightPx: target.heightPx,
				targetImageUrl,
				tee,
				basket,
				bends,
				centerline,
				corridorBand,
				shots,
				throwRoute
			};
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : 'Could not load the real ChainSpot fixture.';
		} finally {
			loading = false;
		}
	}

	onMount(() => {
		void loadFixture();
		return () => {
			if (targetImageUrl) URL.revokeObjectURL(targetImageUrl);
		};
	});
</script>

<main class="spike-page" data-testid="hole-spike-page">
	<h1>Hole Rendering Spike</h1>

	{#if loading}
		<p data-testid="hole-spike-loading">Loading the real ChainSpot project…</p>
	{:else if errorMessage}
		<p class="error" data-testid="hole-spike-error" role="alert">{errorMessage}</p>
	{:else if scene}
		<p data-testid="hole-spike-ready">Hole {scene.hole.number} loaded from the real ChainSpot project.</p>

		<svg
			class="hole-svg"
			data-testid="hole-spike-svg"
			data-target-width={scene.targetWidthPx}
			data-target-height={scene.targetHeightPx}
			viewBox="0 0 {scene.targetWidthPx} {scene.targetHeightPx}"
			role="img"
			aria-label="Hole {scene.hole.number} rendered over the real clean target basemap"
		>
			<image
				data-testid="hole-spike-target-image"
				href={scene.targetImageUrl}
				width={scene.targetWidthPx}
				height={scene.targetHeightPx}
				preserveAspectRatio="xMidYMid meet"
			/>

			{#if scene.corridorBand}
				<polygon
					class="corridor-fill"
					data-testid="hole-spike-corridor"
					points={pointsAttr(scene.corridorBand)}
				/>
			{/if}

			{#if scene.centerline.length >= 2}
				<polyline
					class="centerline"
					data-testid="hole-spike-centerline"
					points={pointsAttr(scene.centerline)}
				/>
			{/if}

			{#each scene.bends as bend, index (index)}
				<circle
					class="bend-marker"
					data-testid={'hole-spike-bend-' + index}
					cx={bend.xPx}
					cy={bend.yPx}
					r="6"
				/>
			{/each}

			{#if scene.shots.length > 0 && scene.throwRoute.length >= 2}
				<polyline class="throw-lines" points={pointsAttr(scene.throwRoute)} />
			{/if}

			{#each scene.shots as shot (shot.xPx + ',' + shot.yPx)}
				<circle class="throw-marker" cx={shot.xPx} cy={shot.yPx} r="5.5" />
			{/each}

			{#if scene.tee}
				<circle
					class="tee-marker"
					data-testid="hole-spike-tee"
					cx={scene.tee.xPx}
					cy={scene.tee.yPx}
					r="10"
				/>
			{/if}

			{#if scene.basket}
				<g class="basket-marker" data-testid="hole-spike-basket">
					<circle cx={scene.basket.xPx} cy={scene.basket.yPx} r="10" />
					<circle cx={scene.basket.xPx} cy={scene.basket.yPx} r="3.5" />
				</g>
			{/if}
		</svg>
	{/if}
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

	.error {
		color: #b91c1c;
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

	.tee-marker {
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
