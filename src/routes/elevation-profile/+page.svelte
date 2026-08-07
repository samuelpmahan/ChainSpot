<script lang="ts">
	import { onMount } from 'svelte';
	import { findImageByRole } from '$lib/domain/project';
	import type { AnnotatedHole, AnnotatedRound } from '$lib/domain/annotatedRound';
	import type { ProjectEditor } from '$lib/domain/editor';
	import { peekRetainedEditor } from '$lib/editorSession';
	import { getActiveAnnotatedRound } from '$lib/annotatedRoundSession';
	import { estimateAffine } from '$lib/alignment/affine';
	import { estimateSimilarity } from '$lib/alignment/similarity';
	import type {
		AlignmentModel,
		AlignmentPairInput,
		EstimationResultOrFailure
	} from '$lib/alignment/types';
	import { planHoleGraphic } from '$lib/holeGraphics';
	import {
		buildElevationProfile,
		naipGridGeoReference,
		naipImageGeoReference,
		renderElevationProfile
	} from '$lib/elevationProfile';
	import type { ElevationProfile, GeoRasterReference } from '$lib/elevationProfile';
	import { resolveNaipReferenceForTarget } from '$lib/naipReferenceSession';
	import { downloadBlob } from '$lib/persistence';

	interface ProfilePreview {
		readonly profile: ElevationProfile;
		readonly blob: Blob;
		readonly objectUrl: string;
	}

	let editor = $state.raw<ProjectEditor | null>(null);
	let annotatedRound = $state<AnnotatedRound | null>(null);
	let sessionReady = $state(false);
	let alignmentModel = $state<AlignmentModel>('similarity');
	let busyHoleId = $state<string | null>(null);
	let errorMessage = $state<string | null>(null);
	let previews = $state.raw<Map<string, ProfilePreview>>(new Map());

	onMount(() => {
		// Svelte mounts the destination before destroying Create Graphics. Wait one
		// task so that page has retained its editor, then peek without consuming it;
		// Create Graphics can still take the same editor when the user navigates back.
		const timer = window.setTimeout(() => {
			editor = peekRetainedEditor('create-graphics');
			annotatedRound = getActiveAnnotatedRound();
			sessionReady = true;
		}, 0);
		return () => {
			window.clearTimeout(timer);
			for (const preview of previews.values()) URL.revokeObjectURL(preview.objectUrl);
		};
	});

	function targetImage() {
		return editor ? findImageByRole(editor.state.images, 'target-basemap') ?? null : null;
	}

	function alignmentPairs(): AlignmentPairInput[] {
		if (!editor) return [];
		return editor.state.controlPointPairs.map((pair) => ({
			id: pair.id,
			enabled: pair.enabled,
			source: pair.source,
			target: pair.target
		}));
	}

	let alignmentResult: EstimationResultOrFailure | null = $derived.by(() => {
		const pairs = alignmentPairs();
		if (!pairs.some((pair) => pair.enabled && pair.target !== null)) return null;
		return alignmentModel === 'affine' ? estimateAffine({ pairs }) : estimateSimilarity({ pairs });
	});

	let geoReference: GeoRasterReference | null = $derived.by(() => {
		const target = targetImage();
		if (!target) return null;
		const record = resolveNaipReferenceForTarget(target);
		if (!record) return null;
		return record.kind === 'single'
			? naipImageGeoReference(record.center, record.radiusMeters, record.sizePx)
			: naipGridGeoReference(record.plan, record.tileSizePx);
	});

	let centerlineHoles: readonly AnnotatedHole[] = $derived(
		annotatedRound?.holes.filter((hole) => (hole.centerline?.length ?? 0) >= 2) ?? []
	);

	function replacePreview(holeId: string, next: ProfilePreview): void {
		const previous = previews.get(holeId);
		if (previous) URL.revokeObjectURL(previous.objectUrl);
		const copy = new Map(previews);
		copy.set(holeId, next);
		previews = copy;
	}

	async function buildProfile(hole: AnnotatedHole): Promise<void> {
		if (busyHoleId) return;
		errorMessage = null;
		const target = targetImage();
		const reference = geoReference;
		const result = alignmentResult;
		if (!target || !reference) {
			errorMessage = 'The clean target does not have an in-session NAIP georeference.';
			return;
		}
		if (!result || !('transform' in result)) {
			errorMessage = 'A valid source-to-target alignment is required before sampling elevation.';
			return;
		}
		const plan = planHoleGraphic(hole, result.transform, target.widthPx, target.heightPx);
		if (!plan?.centerline || plan.centerline.length < 2) {
			errorMessage = `Hole ${hole.number} has no usable centerline.`;
			return;
		}

		busyHoleId = hole.id;
		try {
			const profile = await buildElevationProfile(plan.centerline, reference, {
				units: 'Feet',
				sampleSpacingMeters: 8,
				maxSamples: 80,
				concurrency: 6
			});
			const blob = await renderElevationProfile(profile);
			replacePreview(hole.id, { profile, blob, objectUrl: URL.createObjectURL(blob) });
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : `Could not build Hole ${hole.number}'s elevation profile.`;
		} finally {
			busyHoleId = null;
		}
	}

	function downloadProfile(hole: AnnotatedHole): void {
		const preview = previews.get(hole.id);
		if (!preview) return;
		downloadBlob(preview.blob, `hole-${hole.number}-elevation.png`);
	}
</script>

<svelte:head>
	<title>Elevation Profiles — ChainSpot</title>
</svelte:head>

<main class="page-shell" data-testid="elevation-profile-page">
	<section class="intro">
		<div>
			<h1>Elevation Profiles</h1>
			<p>
				Walk each transformed tee-to-basket centerline through the exact NAIP request grid,
				sample USGS 3DEP elevation, and render the clean broadcast profile.
			</p>
		</div>
		<label class="model-control">
			<span>Alignment</span>
			<select bind:value={alignmentModel} data-testid="elevation-alignment-model">
				<option value="similarity">Similarity</option>
				<option value="affine">Affine</option>
			</select>
		</label>
	</section>

	{#if !sessionReady}
		<p class="notice">Loading the Create Graphics session…</p>
	{:else if !editor}
		<p class="notice error">
			Open Create Graphics first and keep this in the same browser session; there is no active aligned project to sample.
		</p>
	{:else if !annotatedRound}
		<p class="notice error">Import an annotated round in Create Graphics first.</p>
	{:else if !targetImage()}
		<p class="notice error">Load a clean target image in Create Graphics first.</p>
	{:else if !geoReference}
		<p class="notice error">
			Elevation needs a NAIP target fetched in this browser session. A manual basemap (or a project reopened after reload)
			does not have geographic request metadata to guess from.
		</p>
	{:else if !alignmentResult || !('transform' in alignmentResult)}
		<p class="notice error">
			The selected alignment model cannot produce a transform from the current enabled correspondence pairs.
		</p>
	{:else if centerlineHoles.length === 0}
		<p class="notice error">
			No holes contain a tee-to-basket centerline yet. Elevation intentionally does not infer a route from shot positions or a corridor polygon.
		</p>
	{:else}
		<p class="notice">
			{centerlineHoles.length} hole{centerlineHoles.length === 1 ? '' : 's'} ready. Profiles sample roughly every 8m,
			capped at 80 USGS lookups per hole.
		</p>

		{#if errorMessage}
			<p class="notice error" role="alert" data-testid="elevation-error">{errorMessage}</p>
		{/if}

		<section class="profile-grid" aria-label="Hole elevation profiles">
			{#each centerlineHoles as hole (hole.id)}
				{@const preview = previews.get(hole.id)}
				<article class="profile-card" data-testid={`elevation-hole-${hole.number}`}>
					<header>
						<h2>Hole {hole.number}</h2>
						<div class="actions">
							<button
								type="button"
								disabled={busyHoleId !== null}
								onclick={() => buildProfile(hole)}
							>
								{busyHoleId === hole.id ? 'Sampling…' : preview ? 'Rebuild' : 'Build profile'}
							</button>
							{#if preview}
								<button type="button" onclick={() => downloadProfile(hole)}>Download PNG</button>
							{/if}
						</div>
					</header>
					{#if preview}
						<img src={preview.objectUrl} alt={`Elevation profile for Hole ${hole.number}`} />
						<div class="stats">
							<span>{Math.round(preview.profile.totalDistanceMeters * 3.28084)} ft route</span>
							<span>{Math.round(preview.profile.minElevation)}–{Math.round(preview.profile.maxElevation)} ft elevation</span>
							<span>+{Math.round(preview.profile.totalClimb)} / −{Math.round(preview.profile.totalDescent)} ft</span>
						</div>
					{:else}
						<div class="placeholder">No elevation sampled yet.</div>
					{/if}
				</article>
			{/each}
		</section>
	{/if}
</main>

<style>
	.page-shell {
		max-width: 1400px;
		margin: 0 auto;
		padding: 1.5rem;
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	.intro {
		display: flex;
		justify-content: space-between;
		gap: 1rem;
		align-items: flex-end;
	}

	h1,
	h2,
	p {
		margin: 0;
	}

	.intro p {
		max-width: 58rem;
		margin-top: 0.4rem;
		color: #a1a1aa;
	}

	.model-control {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		font-size: 0.8rem;
		color: #a1a1aa;
	}

	select,
	button {
		border: 1px solid #3f3f46;
		border-radius: 5px;
		background: #27272a;
		color: #f4f4f5;
		padding: 0.45rem 0.75rem;
		font: inherit;
	}

	button {
		cursor: pointer;
	}

	button:disabled {
		opacity: 0.55;
		cursor: default;
	}

	.notice {
		padding: 0.75rem 1rem;
		border: 1px solid #3f3f46;
		border-radius: 6px;
		background: #18181b;
		color: #d4d4d8;
	}

	.notice.error {
		border-color: #7f1d1d;
		background: #2b1717;
		color: #fecaca;
	}

	.profile-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(360px, 1fr));
		gap: 1rem;
	}

	.profile-card {
		border: 1px solid #27272a;
		border-radius: 8px;
		background: #18181b;
		padding: 0.8rem;
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	.profile-card header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
	}

	.profile-card h2 {
		font-size: 1rem;
	}

	.actions {
		display: flex;
		gap: 0.5rem;
	}

	.profile-card img,
	.placeholder {
		width: 100%;
		aspect-ratio: 16 / 9;
		border-radius: 5px;
		background: #000;
	}

	.profile-card img {
		display: block;
	}

	.placeholder {
		display: grid;
		place-items: center;
		color: #71717a;
	}

	.stats {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem 0.9rem;
		font-size: 0.8rem;
		color: #a1a1aa;
	}

	@media (max-width: 720px) {
		.page-shell {
			padding: 1rem;
		}

		.intro,
		.profile-card header {
			align-items: stretch;
			flex-direction: column;
		}

		.profile-grid {
			grid-template-columns: 1fr;
		}
	}
</style>
