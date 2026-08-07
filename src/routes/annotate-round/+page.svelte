<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import ImagePane from '$lib/components/ImagePane.svelte';
	import { ProjectEditor } from '$lib/domain/editor';
	import { findImageByRole } from '$lib/domain/project';
	import type { ImageAsset } from '$lib/domain/project';
	import type { DecodeImageFile, HashBytes } from '$lib/imageIntake';
	import { intakeImageFile } from '$lib/imageIntake';
	import { retainEditor, takeRetainedEditor } from '$lib/editorSession';
	import { consumePendingHandoff, getPendingHandoff } from '$lib/stitch/handoff';
	import type { PendingHandoff } from '$lib/stitch/handoff';
	import { annotatedSourceImageFromAsset, createAnnotatedRound } from '$lib/domain/annotatedRound';
	import type { AnnotatedHole, SourcePoint } from '$lib/domain/annotatedRound';
	import { setPendingAnnotatedRound } from '$lib/annotatedRoundSession';
	import {
		addHole,
		clearCorridor,
		placeByMode,
		removeHole,
		removeLastCorridorPoint,
		removeLastShot
	} from '$lib/holeAnnotation';
	import type { HolePlacementMode } from '$lib/holeAnnotation';
	import { pointInBounds } from '$lib/coords';

	const PLACEMENT_MODES: readonly HolePlacementMode[] = ['tee', 'basket', 'shot', 'corridor'];
	const PLACEMENT_MODE_LABELS: Record<HolePlacementMode, string> = {
		tee: 'Tee',
		basket: 'Basket',
		shot: 'Shot landing',
		corridor: 'Corridor point'
	};

	interface Props {
		editor?: ProjectEditor;
		decode?: DecodeImageFile;
		hash?: HashBytes;
	}

	let { editor: initialEditor, decode, hash }: Props = $props();
	// svelte-ignore state_referenced_locally
	void hash; // Test-seam parity with create-graphics; this page never saves/opens a bundle.

	/**
	 * Only production-created or session-retrieved editors participate in route
	 * retention; explicitly injected editors (tests/harnesses) never touch the
	 * module-level application session. Deliberately captured once at mount: the
	 * injection decision never changes for a given page instance.
	 */
	// svelte-ignore state_referenced_locally
	const participatesInSession = initialEditor === undefined;
	let editor = $state.raw(resolveInitialEditor());

	function resolveInitialEditor(): ProjectEditor {
		// An explicitly injected editor (tests) wins; otherwise reuse the retained
		// in-memory session across SPA navigation, or start a fresh project.
		return initialEditor ?? takeRetainedEditor('annotate-round') ?? new ProjectEditor();
	}

	onDestroy(() => {
		if (participatesInSession) retainEditor('annotate-round', editor);
	});

	let refreshCount = $state(0);

	function sourceImage(): ImageAsset | null {
		void refreshCount;
		return findImageByRole(editor.state.images, 'source-overview') ?? null;
	}

	/**
	 * Hole annotation draft — manual placement only for now (no CV proposals, no
	 * undo/redo, no pan/zoom precision). Cleared whenever the source image is
	 * replaced, since existing points are coordinates into a specific raster and
	 * make no sense against a different one.
	 */
	let holes = $state<AnnotatedHole[]>([]);
	let activeHoleId = $state<string | null>(null);
	let placementMode = $state<HolePlacementMode>('tee');
	/** Set once the annotation `<img>` loads, from its own natural/rendered size. */
	let annotationDisplayScale = $state(1);
	let annotationDisplayWidth = $state(0);
	let annotationDisplayHeight = $state(0);

	function activeHole(): AnnotatedHole | null {
		return holes.find((hole) => hole.id === activeHoleId) ?? null;
	}

	/**
	 * A dedicated object URL for the annotation `<img>`, built from the asset's
	 * raw bytes — NOT `editor.getAssetResource(id)?.decoded.src`. That element's
	 * own object URL is deliberately revoked by `decodeImageFileWith` right
	 * after its original decode settles (see that function's own comment); a
	 * second `<img>` pointed at the same, by-then-revoked URL string loads
	 * nothing (`complete: true, naturalWidth: 0`, no error event). Revoked
	 * whenever the source image changes or the page unmounts.
	 */
	let annotationObjectUrl = $state<string | null>(null);

	$effect(() => {
		void refreshCount;
		const image = sourceImage();
		const resource = image ? editor.getAssetResource(image.id) : null;
		if (!image || !resource) {
			annotationObjectUrl = null;
			return;
		}
		const url = URL.createObjectURL(new Blob([resource.bytes as BufferSource], { type: image.mimeType }));
		annotationObjectUrl = url;
		return () => URL.revokeObjectURL(url);
	});

	function handleAddHole(): void {
		holes = addHole(holes);
		activeHoleId = holes[holes.length - 1].id;
	}

	function handleRemoveHole(holeId: string): void {
		holes = removeHole(holes, holeId);
		if (activeHoleId === holeId) activeHoleId = holes[0]?.id ?? null;
	}

	function handleRemoveLastShot(): void {
		if (!activeHoleId) return;
		holes = removeLastShot(holes, activeHoleId);
	}

	function handleRemoveLastCorridorPoint(): void {
		if (!activeHoleId) return;
		holes = removeLastCorridorPoint(holes, activeHoleId);
	}

	function handleClearCorridor(): void {
		if (!activeHoleId) return;
		holes = clearCorridor(holes, activeHoleId);
	}

	function handleAnnotationImageLoad(imgEl: HTMLImageElement): void {
		annotationDisplayScale = imgEl.naturalWidth > 0 ? imgEl.clientWidth / imgEl.naturalWidth : 1;
		annotationDisplayWidth = imgEl.clientWidth;
		annotationDisplayHeight = imgEl.clientHeight;
	}

	/**
	 * Wired imperatively via `addEventListener` in the effect below, not a
	 * template `onclick` — the same convention `ImageViewport` uses for its own
	 * pointer-only interactions, since a template `onclick` on a non-interactive
	 * element trips the a11y linter for a keyboard equivalent that (per the
	 * comment on the annotation frame markup) doesn't meaningfully exist yet.
	 */
	function handleAnnotationClick(event: MouseEvent, container: HTMLElement): void {
		const image = sourceImage();
		if (!image || !activeHoleId || annotationDisplayScale <= 0) return;
		const rect = container.getBoundingClientRect();
		const point: SourcePoint = {
			xPx: (event.clientX - rect.left) / annotationDisplayScale,
			yPx: (event.clientY - rect.top) / annotationDisplayScale
		};
		if (!pointInBounds(point, image.widthPx, image.heightPx)) return;
		holes = placeByMode(holes, activeHoleId, placementMode, point);
	}

	let annotationFrameEl = $state<HTMLDivElement | null>(null);

	$effect(() => {
		const container = annotationFrameEl;
		if (!container) return;
		const listener = (event: MouseEvent) => handleAnnotationClick(event, container);
		container.addEventListener('click', listener);
		return () => container.removeEventListener('click', listener);
	});

	/**
	 * A replaced source image invalidates every existing hole's coordinates —
	 * they're pixel positions into a specific raster, not portable to a
	 * different one — so annotation state resets along with the domain refresh.
	 */
	function handleSourceDomainChanged(): void {
		refresh();
		holes = [];
		activeHoleId = null;
	}

	/** A stitched PNG awaiting explicit import from the Stitch Map page. */
	let pendingHandoff = $state<PendingHandoff | null>(null);
	let importingHandoff = $state(false);
	let handoffError = $state<string | null>(null);

	/**
	 * Duplicated from create-graphics/+page.svelte's handleHandoffImport rather
	 * than shared: same intake path, minus discard-dialog machinery, because an
	 * Annotate Round project never has correspondence pairs to lose —
	 * confirmDiscard is trivially true here.
	 */
	async function handleHandoffImport(): Promise<void> {
		const handoff = pendingHandoff;
		if (!handoff || importingHandoff) return;
		importingHandoff = true;
		handoffError = null;
		try {
			const file = new File([handoff.blob], handoff.fileName, { type: 'image/png' });
			const result = await intakeImageFile({
				editor,
				role: 'source-overview',
				file,
				decode,
				confirmDiscard: () => true
			});
			if (!result.ok) {
				handoffError = result.error.message;
				return;
			}
			consumePendingHandoff();
			pendingHandoff = null;
			refresh();
		} catch (error) {
			handoffError =
				error instanceof Error ? error.message : 'Could not import the stitched image.';
		} finally {
			importingHandoff = false;
		}
	}

	function handleHandoffDismiss(): void {
		consumePendingHandoff();
		pendingHandoff = null;
		handoffError = null;
	}

	let doneRunning = $state(false);
	let doneError = $state<string | null>(null);

	function canFinishAnnotation(): boolean {
		void refreshCount;
		return sourceImage() !== null;
	}

	/**
	 * Builds the AnnotatedRound (source image plus whatever holes have been
	 * placed — annotation is optional and may stop at any hole, same as a real
	 * played round) and hands it to Create Graphics through the pending session
	 * slot. Walking-path capture is still a future ticket.
	 */
	async function handleDone(): Promise<void> {
		const asset = sourceImage();
		if (!asset || doneRunning) return;
		doneRunning = true;
		doneError = null;
		try {
			const resource = editor.getAssetResource(asset.id);
			if (!resource) {
				doneError = 'The source image bytes are no longer available.';
				return;
			}
			let round;
			try {
				round = createAnnotatedRound({
					sourceImage: annotatedSourceImageFromAsset(asset, resource.bytes),
					holes
				});
			} catch (error) {
				// Most likely an in-progress corridor with fewer than
				// MIN_CORRIDOR_POINTS vertices — finish it or clear it first.
				doneError = error instanceof Error ? error.message : 'The current annotations are invalid.';
				return;
			}
			setPendingAnnotatedRound(round);
			await goto('/create-graphics');
		} finally {
			doneRunning = false;
		}
	}

	onMount(() => {
		// Gated on participatesInSession so injected-editor unit tests never
		// observe cross-test session leakage from the module-level handoff store.
		const handoff = participatesInSession ? getPendingHandoff() : null;
		pendingHandoff = handoff && handoff.targetRole === 'source-overview' ? handoff : null;
	});

	/** Test hook: forces a re-derive after external domain actions. */
	export function refresh(): void {
		refreshCount += 1;
	}

	/** Test hook: the currently active editor. */
	export function getEditor(): ProjectEditor {
		return editor;
	}
</script>

<svelte:head>
	<title>Annotate Round | ChainSpot</title>
</svelte:head>

<main
	data-testid="annotate-round"
	data-source-loaded={sourceImage() ? 'true' : 'false'}
	data-hole-count={holes.length}
>
	{#if pendingHandoff}
		<section
			class="handoff-banner"
			data-testid="pending-handoff"
			aria-label="Pending stitched image"
		>
			<p>Stitched image “{pendingHandoff.fileName}” is ready to import as the UDisc source.</p>
			<div class="handoff-actions">
				<button
					type="button"
					data-testid="handoff-import"
					disabled={importingHandoff}
					onclick={handleHandoffImport}
				>
					Import
				</button>
				<button
					type="button"
					data-testid="handoff-dismiss"
					disabled={importingHandoff}
					onclick={handleHandoffDismiss}
				>
					Dismiss
				</button>
			</div>
			{#if handoffError}
				<p class="error" data-testid="handoff-error" role="alert">{handoffError}</p>
			{/if}
		</section>
	{/if}

	<header class="toolbar">
		<h1>ChainSpot</h1>
		<button
			type="button"
			data-testid="annotate-done"
			disabled={!canFinishAnnotation() || doneRunning}
			onclick={handleDone}
			title="Finish annotating and move to Create Graphics"
		>
			Done
		</button>
	</header>

	{#if doneError}
		<p class="error" data-testid="annotate-done-error" role="alert">{doneError}</p>
	{/if}

	<section class="panes">
		<ImagePane
			title="UDisc source"
			role="source-overview"
			{editor}
			refresh={refreshCount}
			pairs={[]}
			pendingSource={null}
			placementEnabled={false}
			correctionEnabled={false}
			markersVisible={false}
			{decode}
			confirmDiscard={() => true}
			onDomainChanged={handleSourceDomainChanged}
		/>
	</section>

	{#if sourceImage()}
		<section class="hole-annotation" data-testid="hole-annotation" aria-labelledby="hole-annotation-heading">
			<h2 id="hole-annotation-heading">Hole annotation</h2>
			<p class="future-note">
				Manual placement for now: click the image below to place tee, basket,
				ordered shot landings, or corridor vertices for the selected hole. Zoom
				for precision and CV-assisted point proposals are planned but not built
				yet — every point placed here is authoritative once you click Done.
			</p>

			<div class="hole-list-row">
				<ul class="hole-list" data-testid="hole-list">
					{#each holes as hole (hole.id)}
						<li class="hole-item">
							<button
								type="button"
								class="hole-chip"
								class:active={hole.id === activeHoleId}
								data-testid="hole-select-{hole.number}"
								onclick={() => (activeHoleId = hole.id)}
							>
								Hole {hole.number}
								{#if hole.tee}· tee{/if}
								{#if hole.basket}· basket{/if}
								{#if hole.shots.length > 0}· {hole.shots.length} shot{hole.shots.length === 1 ? '' : 's'}{/if}
								{#if hole.corridor}· corridor ({hole.corridor.length}){/if}
							</button>
							<button
								type="button"
								class="hole-remove"
								data-testid="hole-remove-{hole.number}"
								aria-label={`Remove hole ${hole.number}`}
								onclick={() => handleRemoveHole(hole.id)}
							>
								✕
							</button>
						</li>
					{/each}
				</ul>
				<button type="button" data-testid="hole-add" onclick={handleAddHole}>Add hole</button>
			</div>

			{#if activeHole()}
				{@const hole = activeHole()!}
				<div class="placement-controls">
					<fieldset>
						<legend>Placement mode</legend>
						{#each PLACEMENT_MODES as mode (mode)}
							<label>
								<input
									type="radio"
									name="placement-mode"
									value={mode}
									checked={placementMode === mode}
									onchange={() => (placementMode = mode)}
									data-testid="placement-mode-{mode}"
								/>
								{PLACEMENT_MODE_LABELS[mode]}
							</label>
						{/each}
					</fieldset>
					<div class="correction-buttons">
						<button
							type="button"
							data-testid="remove-last-shot"
							disabled={hole.shots.length === 0}
							onclick={handleRemoveLastShot}
						>
							Remove last shot
						</button>
						<button
							type="button"
							data-testid="remove-last-corridor-point"
							disabled={!hole.corridor || hole.corridor.length === 0}
							onclick={handleRemoveLastCorridorPoint}
						>
							Remove last corridor point
						</button>
						<button
							type="button"
							data-testid="clear-corridor"
							disabled={!hole.corridor}
							onclick={handleClearCorridor}
						>
							Clear corridor
						</button>
					</div>
				</div>

				<!--
					Semantics live on this wrapping div, not the <img>: pointer placement
					has no meaningful keyboard equivalent yet (there's nowhere for
					"Enter" to place a point without a cursor position), the same reason
					ImagePane's own workspace is a role="img" region with keyboard
					operability delegated to a separate control set. No such alternate
					control set exists for hole annotation yet — this interim workflow
					is pointer-only, and that's a real gap to close, not a false claim.
				-->
				<div
					class="annotation-frame"
					data-testid="annotation-frame"
					role="img"
					aria-label="UDisc source — click to place points for the selected hole. Pointer-only for now; no keyboard equivalent exists yet."
					bind:this={annotationFrameEl}
				>
					<img
						class="annotation-image"
						src={annotationObjectUrl}
						alt=""
						onload={(event) => handleAnnotationImageLoad(event.currentTarget as HTMLImageElement)}
					/>
					<svg
						class="annotation-overlay"
						width={annotationDisplayWidth}
						height={annotationDisplayHeight}
						aria-hidden="true"
					>
						{#each holes as overlayHole (overlayHole.id)}
							{#if overlayHole.corridor && overlayHole.corridor.length >= 3}
								<polygon
									points={overlayHole.corridor
										.map((point) => `${point.xPx * annotationDisplayScale},${point.yPx * annotationDisplayScale}`)
										.join(' ')}
									class="corridor"
									class:active={overlayHole.id === activeHoleId}
								/>
							{/if}
							{#if overlayHole.tee && overlayHole.basket}
								<line
									x1={overlayHole.tee.xPx * annotationDisplayScale}
									y1={overlayHole.tee.yPx * annotationDisplayScale}
									x2={overlayHole.basket.xPx * annotationDisplayScale}
									y2={overlayHole.basket.yPx * annotationDisplayScale}
									class="guide"
								/>
							{/if}
							{#each overlayHole.shots as shot, index (shot.id)}
								{@const from = index === 0 ? overlayHole.tee : overlayHole.shots[index - 1].landing}
								{#if from}
									<line
										x1={from.xPx * annotationDisplayScale}
										y1={from.yPx * annotationDisplayScale}
										x2={shot.landing.xPx * annotationDisplayScale}
										y2={shot.landing.yPx * annotationDisplayScale}
										class="guide"
									/>
								{/if}
							{/each}
							{#if overlayHole.tee}
								<circle
									cx={overlayHole.tee.xPx * annotationDisplayScale}
									cy={overlayHole.tee.yPx * annotationDisplayScale}
									r="5"
									class="tee-marker"
									data-testid="tee-marker-{overlayHole.number}"
								/>
							{/if}
							{#if overlayHole.basket}
								<circle
									cx={overlayHole.basket.xPx * annotationDisplayScale}
									cy={overlayHole.basket.yPx * annotationDisplayScale}
									r="5"
									class="basket-marker"
									data-testid="basket-marker-{overlayHole.number}"
								/>
							{/if}
							{#each overlayHole.shots as shot, index (shot.id)}
								<circle
									cx={shot.landing.xPx * annotationDisplayScale}
									cy={shot.landing.yPx * annotationDisplayScale}
									r="4"
									class="shot-marker"
									data-testid="shot-marker-{overlayHole.number}-{index}"
								/>
							{/each}
						{/each}
					</svg>
				</div>
			{:else}
				<p class="future-note">Add a hole to start placing points.</p>
			{/if}
		</section>
	{/if}
</main>

<style>
	main {
		font-family: system-ui, sans-serif;
		padding: 1rem;
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	:global(button:focus-visible) {
		outline: 3px solid #075985;
		outline-offset: 2px;
	}

	:global(button:disabled) {
		cursor: not-allowed;
	}

	.toolbar {
		display: flex;
		align-items: center;
		gap: 1rem;
		flex-wrap: wrap;
	}

	h1 {
		font-size: 1.5rem;
		margin: 0;
	}

	.handoff-banner {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.75rem;
		padding: 0.6rem 0.8rem;
		border: 1px solid #166534;
		border-radius: 6px;
		background-color: #052e16;
		color: #bbf7d0;
		font-size: 0.9rem;
	}

	.handoff-banner p {
		margin: 0;
	}

	.handoff-actions {
		display: flex;
		gap: 0.5rem;
		margin-left: auto;
	}

	.handoff-banner .error {
		flex-basis: 100%;
	}

	.error {
		margin: 0;
		padding: 0.4rem 0.6rem;
		border-radius: 4px;
		background: #fdecea;
		border: 1px solid #f5c6cb;
		color: #8a1f11;
		font-size: 0.85rem;
	}

	.panes {
		display: grid;
		grid-template-columns: 1fr;
		gap: 1rem;
		max-width: 32rem;
	}

	.future-note {
		margin: 0;
		font-size: 0.85rem;
		opacity: 0.75;
		max-width: 40rem;
	}

	.hole-annotation {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		max-width: 48rem;
	}

	.hole-annotation h2 {
		font-size: 1.1rem;
		margin: 0;
	}

	.hole-list-row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem;
	}

	.hole-list {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.hole-item {
		display: flex;
		align-items: stretch;
	}

	.hole-chip {
		font-size: 0.8rem;
		padding: 0.3rem 0.6rem;
		border: 1px solid #ccc;
		border-radius: 4px 0 0 4px;
		background: none;
		cursor: pointer;
	}

	.hole-chip.active {
		border-color: #2a6df4;
		background: rgb(42 109 244 / 10%);
	}

	.hole-remove {
		font-size: 0.75rem;
		padding: 0.3rem 0.4rem;
		border: 1px solid #ccc;
		border-left: none;
		border-radius: 0 4px 4px 0;
		background: none;
		cursor: pointer;
	}

	.placement-controls {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 1rem;
	}

	.placement-controls fieldset {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.6rem;
		border: 1px solid #ccc;
		border-radius: 4px;
		padding: 0.4rem 0.6rem;
		margin: 0;
	}

	.placement-controls legend {
		font-size: 0.75rem;
		opacity: 0.8;
		padding: 0 0.3rem;
	}

	.placement-controls label {
		display: flex;
		align-items: center;
		gap: 0.3rem;
		font-size: 0.85rem;
	}

	.correction-buttons {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}

	.correction-buttons button {
		font-size: 0.8rem;
	}

	.annotation-frame {
		position: relative;
		display: inline-block;
	}

	.annotation-image {
		display: block;
		max-width: 48rem;
		max-height: 32rem;
		width: auto;
		height: auto;
		border: 1px solid #ccc;
		border-radius: 4px;
		cursor: crosshair;
	}

	.annotation-overlay {
		position: absolute;
		top: 0;
		left: 0;
		pointer-events: none;
	}

	.corridor {
		fill: rgb(42 109 244 / 15%);
		stroke: rgb(42 109 244 / 60%);
		stroke-width: 1.5;
	}

	.corridor.active {
		fill: rgb(42 109 244 / 28%);
		stroke: #2a6df4;
		stroke-width: 2;
	}

	.guide {
		stroke: rgb(255 255 255 / 70%);
		stroke-width: 1.5;
		stroke-dasharray: 4 3;
	}

	.tee-marker {
		fill: #22c55e;
		stroke: #063d1e;
		stroke-width: 1;
	}

	.basket-marker {
		fill: #ef4444;
		stroke: #450a0a;
		stroke-width: 1;
	}

	.shot-marker {
		fill: #f59e0b;
		stroke: #451a03;
		stroke-width: 1;
	}

	@media (max-width: 900px) {
		main {
			padding: 0.75rem;
		}
	}
</style>
