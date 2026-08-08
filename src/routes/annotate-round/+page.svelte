<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import ImageEditorPane from '$lib/components/ImageEditorPane.svelte';
	import { ProjectEditor } from '$lib/domain/editor';
	import { findImageByRole } from '$lib/domain/project';
	import type { ImageAsset } from '$lib/domain/project';
	import type { DecodeImageFile, HashBytes } from '$lib/imageIntake';
	import { intakeImageFile } from '$lib/imageIntake';
	import { retainEditor, takeRetainedEditor } from '$lib/editorSession';
	import { consumePendingHandoff, getPendingHandoff } from '$lib/stitch/handoff';
	import type { PendingHandoff } from '$lib/stitch/handoff';
	import { annotatedSourceImageFromAsset, createAnnotatedRound } from '$lib/domain/annotatedRound';
	import type { AnnotatedHole } from '$lib/domain/annotatedRound';
	import { setPendingAnnotatedRound } from '$lib/annotatedRoundSession';
	import {
		addHole,
		clearBends,
		placeByMode,
		removeHole,
		removeLastBend,
		removeLastShot,
		setCorridorWidth
	} from '$lib/holeAnnotation';
	import type { HolePlacementMode } from '$lib/holeAnnotation';
	import {
		deriveCorridorBand,
		deriveCorridorCenterline,
		DEFAULT_CORRIDOR_WIDTH_PX
	} from '$lib/corridor';
	import {
		detectBasketCandidates,
		detectCourseCandidates,
		prewarmBasketDetection
	} from '$lib/autoAnnotation/basketDetection';
	import type { BasketCandidate, CourseDetectionResult } from '$lib/autoAnnotation/basketDetection';

	const PLACEMENT_MODES: readonly HolePlacementMode[] = ['tee', 'basket', 'shot', 'bend'];
	const PLACEMENT_MODE_LABELS: Record<HolePlacementMode, string> = {
		tee: 'Tee',
		basket: 'Basket',
		shot: 'Shot landing',
		bend: 'Bend point'
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
		stopCourseDetectionProgress();
		if (participatesInSession) retainEditor('annotate-round', editor);
	});

	let refreshCount = $state(0);

	function sourceImage(): ImageAsset | null {
		void refreshCount;
		return findImageByRole(editor.state.images, 'source-overview') ?? null;
	}

	/**
	 * Hole annotation draft. Manual placement and basket CV proposals are both
	 * transient until the user applies them and clicks Done. Cleared whenever the
	 * source image is replaced, since existing points are coordinates into a
	 * specific raster and make no sense against a different one.
	 */
	let holes = $state<AnnotatedHole[]>([]);
	let activeHoleId = $state<string | null>(null);
	let placementMode = $state<HolePlacementMode>('tee');
	let basketCandidates = $state<readonly BasketCandidate[]>([]);
	let selectedBasketCandidate = $state<number | null>(null);
	let basketDetectionRunning = $state(false);
	let basketDetectionError = $state<string | null>(null);
	let courseDetection = $state<CourseDetectionResult | null>(null);
	let courseDetectionRunning = $state(false);
	let courseDetectionStatus = $state<string | null>(null);
	let courseDetectionElapsedSeconds = $state(0);
	let courseDetectionStartedAt = 0;
	let courseDetectionTimer: ReturnType<typeof setInterval> | null = null;
	let prewarmedSourceId: string | null = null;

	function activeHole(): AnnotatedHole | null {
		return holes.find((hole) => hole.id === activeHoleId) ?? null;
	}

	function startCourseDetectionProgress(): void {
		if (courseDetectionTimer !== null) clearInterval(courseDetectionTimer);
		courseDetectionStartedAt = Date.now();
		courseDetectionElapsedSeconds = 0;
		courseDetectionStatus = 'Preparing image for the CV worker…';
		courseDetectionTimer = setInterval(() => {
			courseDetectionElapsedSeconds = Math.floor((Date.now() - courseDetectionStartedAt) / 1000);
		}, 250);
	}

	function stopCourseDetectionProgress(): void {
		if (courseDetectionStartedAt > 0) {
			courseDetectionElapsedSeconds = Math.floor((Date.now() - courseDetectionStartedAt) / 1000);
		}
		if (courseDetectionTimer !== null) {
			clearInterval(courseDetectionTimer);
			courseDetectionTimer = null;
		}
	}

	// OpenCV's embedded WASM payload is large. Start its reusable worker as soon
	// as a source image exists so Detect baskets does not pay the cold-load cost.
	$effect(() => {
		void refreshCount;
		const image = sourceImage();
		if (!image || image.id === prewarmedSourceId || typeof Worker === 'undefined') return;
		prewarmedSourceId = image.id;
		void prewarmBasketDetection().catch(() => {
			// Detection still reports a useful error if the user explicitly runs it.
			// A speculative warm-up failure should not alarm or block manual annotation.
		});
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

	function handleRemoveLastBend(): void {
		if (!activeHoleId) return;
		holes = removeLastBend(holes, activeHoleId);
	}

	function handleClearBends(): void {
		if (!activeHoleId) return;
		holes = clearBends(holes, activeHoleId);
	}

	function handleCorridorWidthChange(event: Event): void {
		if (!activeHoleId) return;
		const input = event.currentTarget as HTMLInputElement;
		const corridorWidthPx = Number(input.value);
		if (!Number.isFinite(corridorWidthPx) || corridorWidthPx <= 0) return;
		holes = setCorridorWidth(holes, activeHoleId, corridorWidthPx);
	}

	function handleAnnotationPlacement(coordinates: { xPx: number; yPx: number }): void {
		if (!activeHoleId) return;
		holes = placeByMode(holes, activeHoleId, placementMode, coordinates);
	}

	/**
	 * A replaced source image invalidates every existing hole's coordinates —
	 * they're pixel positions into a specific raster, not portable to a
	 * different one — so annotation state resets along with the domain refresh.
	 */
	function handleSourceDomainChanged(): void {
		refresh();
		holes = [];
		activeHoleId = null;
		basketCandidates = [];
		selectedBasketCandidate = null;
		basketDetectionError = null;
		courseDetection = null;
		courseDetectionStatus = null;
		courseDetectionElapsedSeconds = 0;
		stopCourseDetectionProgress();
	}

	async function handleDetectCourse(): Promise<void> {
		const image = sourceImage();
		if (!image || courseDetectionRunning || basketDetectionRunning) return;
		const resource = editor.getAssetResource(image.id);
		if (!resource) {
			basketDetectionError = 'The source image bytes are no longer available.';
			return;
		}

		courseDetectionRunning = true;
		basketDetectionError = null;
		selectedBasketCandidate = null;
		startCourseDetectionProgress();
		try {
			const result = await detectCourseCandidates(
				resource.bytes,
				image.mimeType,
				image.widthPx,
				image.heightPx,
				(progress) => {
					courseDetectionStatus = progress.message;
				}
			);
			courseDetection = result;
			basketCandidates = result.baskets;
			const assignedNumbers = result.numberDetection.candidates.filter(
				(candidate) => candidate.label !== undefined
			).length;
			courseDetectionStatus = `Complete · ${assignedNumbers} numbers · ${result.tees.length} tees · ${result.baskets.length} baskets`;
		} catch (error) {
			courseDetection = null;
			courseDetectionStatus = 'Detection failed';
			basketDetectionError = error instanceof Error ? error.message : 'Course detection failed.';
		} finally {
			courseDetectionRunning = false;
			stopCourseDetectionProgress();
		}
	}

	function applyReadyCourseHoles(): void {
		if (!courseDetection) return;
		const ready = courseDetection.grammar.holes.filter(
			(proposal) => proposal.status === 'ready' && proposal.tee && proposal.basket
		);
		if (ready.length === 0) return;

		const existingByNumber = new Map(holes.map((hole) => [hole.number, hole]));
		for (const proposal of ready) {
			const existing = existingByNumber.get(proposal.number);
			const next: AnnotatedHole = {
				...(existing ?? {
					id: crypto.randomUUID(),
					number: proposal.number,
					shots: [],
					corridorBends: [],
					corridorWidthPx: DEFAULT_CORRIDOR_WIDTH_PX
				}),
				tee: { xPx: proposal.tee!.xPx, yPx: proposal.tee!.yPx },
				basket: { xPx: proposal.basket!.xPx, yPx: proposal.basket!.yPx }
			};
			existingByNumber.set(proposal.number, next);
		}
		holes = [...existingByNumber.values()].sort((a, b) => a.number - b.number);
		activeHoleId = holes[0]?.id ?? null;
	}

	async function handleDetectBaskets(): Promise<void> {
		const image = sourceImage();
		if (!image || basketDetectionRunning) return;
		const resource = editor.getAssetResource(image.id);
		if (!resource) {
			basketDetectionError = 'The source image bytes are no longer available.';
			return;
		}

		basketDetectionRunning = true;
		basketDetectionError = null;
		selectedBasketCandidate = null;
		try {
			basketCandidates = await detectBasketCandidates(
				resource.bytes,
				image.mimeType,
				image.widthPx,
				image.heightPx
			);
			if (basketCandidates.length === 0) {
				basketDetectionError =
					'No basket candidates found. Try a full UDisc map screenshot with the basket icons visible.';
			}
		} catch (error) {
			basketCandidates = [];
			basketDetectionError =
				error instanceof Error ? error.message : 'Basket detection failed.';
		} finally {
			basketDetectionRunning = false;
		}
	}

	function applySelectedBasket(): void {
		if (selectedBasketCandidate === null || !activeHoleId) return;
		const candidate = basketCandidates[selectedBasketCandidate];
		if (!candidate) return;
		holes = holes.map((hole) =>
			hole.id === activeHoleId ? { ...hole, basket: { xPx: candidate.xPx, yPx: candidate.yPx } } : hole
		);
		selectedBasketCandidate = null;
	}

	function selectBasketCandidate(index: number): void {
		selectedBasketCandidate = index;
		if (activeHoleId) return;

		// Candidate review needs an active hole to show the preview and enable
		// Apply. Create the first draft hole on demand so the detector is usable
		// immediately after the user clicks a candidate.
		if (holes.length > 0) {
			activeHoleId = holes[holes.length - 1].id;
			return;
		}
		const nextHoles = addHole(holes);
		holes = nextHoles;
		activeHoleId = nextHoles[nextHoles.length - 1].id;
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
				// Hole validation failure (for example a non-positive corridor
				// width or an out-of-bounds point) — correct it and try again.
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
		<div>
			<h1>Annotate Round</h1>
			<p>Review the course map, mark each hole, then continue to graphics.</p>
		</div>
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

	<div data-testid="hole-annotation">
		<ImageEditorPane
			title="UDisc source"
			role="source-overview"
			{editor}
			refresh={refreshCount}
			{decode}
			confirmDiscard={() => true}
			onDomainChanged={handleSourceDomainChanged}
			onPlacement={activeHoleId ? handleAnnotationPlacement : undefined}
		>
			{#snippet tools()}
				<div class="tool-section">
					<div class="section-heading">
						<h2>Holes</h2>
						<button type="button" data-testid="hole-add" onclick={handleAddHole}>+ Add</button>
					</div>
					{#if holes.length > 0}
						<ul class="hole-list" data-testid="hole-list">
							{#each holes as hole (hole.id)}
								<li class:active={hole.id === activeHoleId}>
									<button
										type="button"
										class="hole-select"
										data-testid="hole-select-{hole.number}"
										onclick={() => (activeHoleId = hole.id)}
									>
										<strong>Hole {hole.number}</strong>
										<span>
											{hole.tee ? 'tee' : 'no tee'}{hole.basket ? ' · basket' : ''} · {hole.shots.length} shots{hole.corridorBends.length > 0 ? ` · bends (${hole.corridorBends.length})` : ''}
										</span>
									</button>
									<button
										type="button"
										class="icon-button"
										data-testid="hole-remove-{hole.number}"
										aria-label={`Remove hole ${hole.number}`}
										onclick={() => handleRemoveHole(hole.id)}
									>×</button>
								</li>
							{/each}
						</ul>
					{:else}
						<p class="empty-copy">Add the first hole, then click directly on the map.</p>
					{/if}
				</div>

				{#if activeHole()}
					{@const hole = activeHole()!}
					<div class="tool-section">
						<h2>Place</h2>
						<div class="mode-grid">
							{#each PLACEMENT_MODES as mode (mode)}
								<label class:active={placementMode === mode}>
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
						</div>
						<div class="edit-actions">
							<button type="button" data-testid="remove-last-shot" disabled={hole.shots.length === 0} onclick={handleRemoveLastShot}>Undo shot</button>
							<button type="button" data-testid="remove-last-bend" disabled={hole.corridorBends.length === 0} onclick={handleRemoveLastBend}>Undo bend</button>
							<button type="button" data-testid="clear-bends" disabled={hole.corridorBends.length === 0} onclick={handleClearBends}>Clear bends</button>
						</div>
						<label class="width-control">
							<span>Corridor width (px)</span>
							<input
								type="number"
								min="1"
								step="1"
								value={hole.corridorWidthPx}
								onchange={handleCorridorWidthChange}
								data-testid="corridor-width"
							/>
						</label>
					</div>
				{/if}

				{#if sourceImage()}
					<div class="tool-section detection">
						<div class="section-heading">
							<h2>Course assist</h2>
							{#if basketCandidates.length > 0}<span>{basketCandidates.length} found</span>{/if}
						</div>
						<button
							type="button"
							class="detect-button"
							data-testid="detect-course"
							disabled={courseDetectionRunning || basketDetectionRunning}
							onclick={() => void handleDetectCourse()}
						>
							{courseDetectionRunning ? 'Detecting the course…' : 'Detect full course'}
						</button>
						{#if courseDetectionStatus}
							<p
								class="detection-progress"
								data-testid="course-detection-progress"
								data-running={courseDetectionRunning ? 'true' : 'false'}
								role="status"
							>
								<span class="progress-dot" class:running={courseDetectionRunning} aria-hidden="true"></span>
								<span class="progress-copy">{courseDetectionStatus}</span>
								<span class="progress-time">{courseDetectionElapsedSeconds}s</span>
							</p>
						{/if}
						{#if courseDetection}
							{@const assignedNumbers = courseDetection.numberDetection.candidates.filter((candidate) => candidate.label !== undefined).length}
							{@const readyHoles = courseDetection.grammar.holes.filter((proposal) => proposal.status === 'ready').length}
							<p class="detection-summary" data-testid="course-detection-summary">
								{assignedNumbers} numbers · {courseDetection.tees.length} tees · {courseDetection.baskets.length} baskets · {readyHoles} ready
							</p>
							{#if courseDetection.numberDetection.note}
								<p class="tool-note">{courseDetection.numberDetection.note}</p>
							{/if}
							{#if courseDetection.numberDetection.candidates.some((candidate) => candidate.topGlyphMatches?.length)}
								<details class="number-diagnostics" open>
									<summary>Number classifier diagnostics</summary>
									<p class="diagnostic-help">Raw top 3 are independent glyph scores. Assigned is the forced one-to-one Hungarian result.</p>
									<div class="diagnostic-list">
										{#each courseDetection.numberDetection.candidates as candidate, index (index)}
											{@const candidateId = candidate.diagnosticId ?? index + 1}
											{@const rawMatches = candidate.topGlyphMatches ?? []}
											{@const forcedAssignment = candidate.label !== undefined && rawMatches[0] !== undefined && rawMatches[0].label !== candidate.label}
											<div class="diagnostic-row" class:forced={forcedAssignment}>
												<strong>C{candidateId}</strong>
												<span class="diagnostic-assigned">assigned {candidate.label !== undefined ? `H${candidate.label}` : '—'}</span>
												<span class="diagnostic-raw">
													raw
													{#each rawMatches as match, matchIndex (match.label)}
														{matchIndex > 0 ? ' · ' : ' '}H{match.label} {(match.score * 100).toFixed(0)}%
													{/each}
												</span>
											</div>
										{/each}
									</div>
								</details>
							{/if}
							<button
								type="button"
								class="apply-button"
								data-testid="apply-ready-course-holes"
								disabled={readyHoles === 0}
								onclick={applyReadyCourseHoles}
							>
								Apply {readyHoles} ready holes
							</button>
						{/if}
						<p class="assist-divider">Basket-only fallback</p>
						<button
							type="button"
							class="detect-button"
							data-testid="detect-baskets"
							disabled={basketDetectionRunning || courseDetectionRunning}
							onclick={() => void handleDetectBaskets()}
						>
							{basketDetectionRunning ? 'Loading OpenCV and detecting…' : 'Detect baskets'}
						</button>
						{#if basketDetectionError}
							<p class="tool-error" data-testid="basket-detection-error" role="alert">{basketDetectionError}</p>
						{/if}
						{#if basketCandidates.length > 0}
							<div class="candidate-list" aria-label="Detected basket candidates">
								{#each basketCandidates as candidate, index (index)}
									<button
										type="button"
										class:selected={selectedBasketCandidate === index}
										onclick={() => selectBasketCandidate(index)}
									>
										#{index + 1} <span>{(candidate.score * 100).toFixed(0)}%</span>
									</button>
								{/each}
							</div>
							<button
								type="button"
								class="apply-button"
								data-testid="apply-basket-candidate"
								disabled={selectedBasketCandidate === null || !activeHoleId}
								onclick={applySelectedBasket}
							>
								Apply to Hole {activeHole()?.number ?? ''}
							</button>
						{/if}
					</div>
				{/if}
			{/snippet}

			{#snippet overlay({ image, zoom })}
				<svg class="annotation-overlay" viewBox={`0 0 ${image.widthPx} ${image.heightPx}`} aria-hidden="true">
					{#each holes as overlayHole (overlayHole.id)}
						{@const band = deriveCorridorBand(overlayHole)}
						{#if band}
							<polygon points={band.map((point) => `${point.xPx},${point.yPx}`).join(' ')} class="corridor" class:active={overlayHole.id === activeHoleId} data-testid="corridor-band-{overlayHole.number}" />
						{/if}
						{@const centerline = deriveCorridorCenterline(overlayHole)}
						{#if centerline.length >= 2}
							<polyline points={centerline.map((point) => `${point.xPx},${point.yPx}`).join(' ')} class="corridor-centerline" data-testid="corridor-centerline-{overlayHole.number}" />
						{/if}
						{#each overlayHole.corridorBends as bend, index (index)}
							<circle cx={bend.xPx} cy={bend.yPx} r={5 / zoom} class="bend-marker" data-testid="bend-marker-{overlayHole.number}-{index}" />
						{/each}
						{#if overlayHole.tee && overlayHole.basket}
							<line x1={overlayHole.tee.xPx} y1={overlayHole.tee.yPx} x2={overlayHole.basket.xPx} y2={overlayHole.basket.yPx} class="guide" />
						{/if}
						{#each overlayHole.shots as shot, index (shot.id)}
							{@const from = index === 0 ? overlayHole.tee : overlayHole.shots[index - 1].landing}
							{#if from}<line x1={from.xPx} y1={from.yPx} x2={shot.landing.xPx} y2={shot.landing.yPx} class="guide" />{/if}
						{/each}
						{#if overlayHole.tee}<circle cx={overlayHole.tee.xPx} cy={overlayHole.tee.yPx} r={7 / zoom} class="tee-marker" data-testid="tee-marker-{overlayHole.number}" />{/if}
						{#if overlayHole.basket}<circle cx={overlayHole.basket.xPx} cy={overlayHole.basket.yPx} r={7 / zoom} class="basket-marker" data-testid="basket-marker-{overlayHole.number}" />{/if}
						{#each overlayHole.shots as shot, index (shot.id)}
							<circle cx={shot.landing.xPx} cy={shot.landing.yPx} r={6 / zoom} class="shot-marker" data-testid="shot-marker-{overlayHole.number}-{index}" />
						{/each}
					{/each}
					{#if courseDetection}
						{#each courseDetection.numberDetection.candidates as candidate, index (index)}
							{@const candidateId = candidate.diagnosticId ?? index + 1}
							{@const rawTopMatch = candidate.topGlyphMatches?.[0]}
							{@const forcedAssignment = candidate.label !== undefined && rawTopMatch !== undefined && rawTopMatch.label !== candidate.label}
							<g
								class="number-candidate-marker"
								class:forced-assignment={forcedAssignment}
								data-testid="number-candidate-{candidateId}"
							>
								<rect
									x={candidate.xPx - candidate.widthPx / 2}
									y={candidate.yPx - candidate.heightPx / 2}
									width={candidate.widthPx}
									height={candidate.heightPx}
									rx={2 / zoom}
								/>
								<text
									x={candidate.xPx}
									y={candidate.yPx - candidate.heightPx / 2 - 5 / zoom}
									text-anchor="middle"
									class="number-candidate-label"
									style={`font-size:${11 / zoom}px`}
								>
									{#if candidate.label !== undefined}
										C{candidateId} → H{candidate.label}{rawTopMatch && rawTopMatch.label !== candidate.label ? ` · raw H${rawTopMatch.label} ${(rawTopMatch.score * 100).toFixed(0)}%` : ` · ${(candidate.score * 100).toFixed(0)}%`}
									{:else}
										C{candidateId} · {(candidate.score * 100).toFixed(0)}%
									{/if}
								</text>
							</g>
						{/each}
						{#each courseDetection.tees as candidate, index (index)}
							<rect
								x={candidate.xPx - candidate.widthPx / 2}
								y={candidate.yPx - candidate.heightPx / 2}
								width={candidate.widthPx}
								height={candidate.heightPx}
								transform={`rotate(${candidate.orientationDeg} ${candidate.xPx} ${candidate.yPx})`}
								class="tee-candidate-marker"
								data-testid="tee-candidate-{index + 1}"
							/>
						{/each}
					{/if}
					{#each basketCandidates as candidate, index (index)}
						<circle cx={candidate.xPx} cy={candidate.yPx} r={(selectedBasketCandidate === index ? 11 : 8) / zoom} class="basket-candidate-marker" class:selected={selectedBasketCandidate === index} data-testid="basket-candidate-{index + 1}" />
					{/each}
				</svg>
			{/snippet}
		</ImageEditorPane>
	</div>
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
		justify-content: space-between;
		gap: 1rem;
	}

	h1 {
		font-size: 1.5rem;
		margin: 0;
	}

	.toolbar p {
		margin: 0.15rem 0 0;
		color: #a1a1aa;
		font-size: 0.85rem;
	}

	.toolbar > button {
		padding: 0.5rem 1.1rem;
		border: 1px solid #2563eb;
		border-radius: 6px;
		background: #2563eb;
		color: #fff;
		font-weight: 650;
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

	.hole-list {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
		margin: 0;
		padding: 0;
		list-style: none;
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

	.corridor-centerline {
		fill: none;
		stroke: rgb(255 255 255 / 85%);
		stroke-width: 2;
		stroke-dasharray: 5 4;
	}

	.bend-marker {
		fill: #a78bfa;
		stroke: #2e1065;
		stroke-width: 1;
	}

	.width-control {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		font-size: 0.76rem;
		color: #d4d4d8;
	}

	.width-control input {
		width: 6rem;
		padding: 0.3rem 0.45rem;
		border: 1px solid #52525b;
		border-radius: 5px;
		background: #18181b;
		color: #f4f4f5;
		font: inherit;
		text-align: right;
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

	.number-candidate-marker rect {
		fill: rgb(244 63 94 / 16%);
		stroke: #fb7185;
		stroke-width: 2;
		vector-effect: non-scaling-stroke;
	}

	.number-candidate-marker.forced-assignment rect {
		fill: rgb(245 158 11 / 16%);
		stroke: #f59e0b;
	}

	.number-candidate-marker.forced-assignment .number-candidate-label {
		fill: #fde68a;
	}

	.number-candidate-label {
		fill: #fecdd3;
		stroke: #18181b;
		stroke-width: 3px;
		paint-order: stroke fill;
		font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
		font-weight: 700;
		pointer-events: none;
	}

	.tee-candidate-marker {
		fill: rgb(56 189 248 / 20%);
		stroke: #38bdf8;
		stroke-width: 2;
		vector-effect: non-scaling-stroke;
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

	.basket-candidate-marker {
		fill: #facc15;
		stroke: #713f12;
		stroke-width: 2;
		stroke-dasharray: 3 2;
	}

	.basket-candidate-marker.selected {
		fill: #fb923c;
		stroke: #7c2d12;
		stroke-width: 3;
	}

	.tool-section {
		display: flex;
		flex-direction: column;
		gap: 0.55rem;
		padding-bottom: 0.85rem;
		margin-bottom: 0.85rem;
		border-bottom: 1px solid #3f3f46;
	}

	.tool-section:last-child {
		margin-bottom: 0;
		border-bottom: 0;
	}

	.tool-section h2 {
		margin: 0;
		font-size: 0.82rem;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: #d4d4d8;
	}

	.section-heading {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
	}

	.section-heading > span,
	.empty-copy {
		margin: 0;
		color: #a1a1aa;
		font-size: 0.75rem;
	}

	.tool-section button {
		border: 1px solid #52525b;
		border-radius: 5px;
		background: #27272a;
		color: #f4f4f5;
		padding: 0.4rem 0.55rem;
		cursor: pointer;
	}

	.tool-section button:disabled {
		opacity: 0.4;
	}

	.hole-list {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
	}

	.hole-list li {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		border: 1px solid #3f3f46;
		border-radius: 6px;
		overflow: hidden;
	}

	.hole-list li.active {
		border-color: #3b82f6;
		box-shadow: inset 3px 0 #3b82f6;
	}

	.hole-select {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 0.1rem;
		border: 0 !important;
		border-radius: 0 !important;
		background: transparent !important;
		text-align: left;
	}

	.hole-select span {
		color: #a1a1aa;
		font-size: 0.7rem;
	}

	.icon-button {
		border: 0 !important;
		border-left: 1px solid #3f3f46 !important;
		border-radius: 0 !important;
		background: transparent !important;
		font-size: 1rem;
	}

	.mode-grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 0.35rem;
	}

	.mode-grid label {
		display: flex;
		align-items: center;
		gap: 0.35rem;
		padding: 0.45rem;
		border: 1px solid #3f3f46;
		border-radius: 5px;
		font-size: 0.76rem;
		cursor: pointer;
	}

	.mode-grid label.active {
		border-color: #3b82f6;
		background: rgb(59 130 246 / 15%);
	}

	.mode-grid input {
		margin: 0;
	}

	.edit-actions {
		display: grid;
		gap: 0.35rem;
	}

	.detect-button,
	.apply-button {
		width: 100%;
	}

	.detect-button {
		border-color: #a16207 !important;
		background: #422006 !important;
		color: #fde68a !important;
	}

	.apply-button {
		border-color: #2563eb !important;
		background: #1d4ed8 !important;
	}

	.candidate-list {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: 0.3rem;
	}

	.candidate-list button {
		display: flex;
		justify-content: space-between;
		font-size: 0.72rem;
	}

	.candidate-list button.selected {
		border-color: #f59e0b;
		background: #451a03;
	}

	.candidate-list span {
		color: #fbbf24;
	}

	.tool-error {
		margin: 0;
		color: #fca5a5;
		font-size: 0.75rem;
	}

	.detection-summary,
	.tool-note,
	.assist-divider {
		margin: 0;
		font-size: 0.75rem;
		line-height: 1.35;
	}

	.detection-summary {
		color: #d4d4d8;
	}

	.detection-progress {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr) auto;
		align-items: center;
		gap: 0.45rem;
		margin: 0;
		padding: 0.5rem 0.55rem;
		border: 1px solid #3f3f46;
		border-radius: 5px;
		background: #18181b;
		font-size: 0.72rem;
		line-height: 1.25;
		color: #d4d4d8;
	}

	.progress-dot {
		width: 0.55rem;
		height: 0.55rem;
		border-radius: 999px;
		background: #22c55e;
	}

	.progress-dot.running {
		background: #f59e0b;
		animation: cv-pulse 0.9s ease-in-out infinite alternate;
	}

	.progress-copy {
		min-width: 0;
		white-space: normal;
		overflow-wrap: anywhere;
	}

	.progress-time {
		font-variant-numeric: tabular-nums;
		color: #a1a1aa;
	}

	@keyframes cv-pulse {
		from {
			opacity: 0.35;
			transform: scale(0.8);
		}
		to {
			opacity: 1;
			transform: scale(1.2);
		}
	}

	.tool-note {
		color: #fcd34d;
	}

	.number-diagnostics {
		border: 1px solid #3f3f46;
		border-radius: 5px;
		background: #18181b;
	}

	.number-diagnostics summary {
		padding: 0.5rem 0.55rem;
		cursor: pointer;
		font-size: 0.75rem;
		font-weight: 650;
		color: #e4e4e7;
	}

	.diagnostic-help {
		margin: 0;
		padding: 0 0.55rem 0.45rem;
		font-size: 0.68rem;
		line-height: 1.35;
		color: #a1a1aa;
	}

	.diagnostic-list {
		display: flex;
		flex-direction: column;
		max-height: 22rem;
		overflow: auto;
		border-top: 1px solid #3f3f46;
	}

	.diagnostic-row {
		display: grid;
		grid-template-columns: 2rem 5.6rem minmax(0, 1fr);
		gap: 0.35rem;
		align-items: baseline;
		padding: 0.35rem 0.5rem;
		border-bottom: 1px solid #2b2b30;
		font-size: 0.68rem;
		font-variant-numeric: tabular-nums;
	}

	.diagnostic-row:last-child {
		border-bottom: 0;
	}

	.diagnostic-row.forced {
		background: rgb(245 158 11 / 10%);
	}

	.diagnostic-row.forced > strong,
	.diagnostic-row.forced .diagnostic-assigned {
		color: #fbbf24;
	}

	.diagnostic-assigned {
		color: #fda4af;
	}

	.diagnostic-raw {
		min-width: 0;
		color: #d4d4d8;
		white-space: normal;
	}

	.assist-divider {
		padding-top: 0.35rem;
		border-top: 1px solid #3f3f46;
		color: #a1a1aa;
	}

	.annotation-overlay {
		width: 100%;
		height: 100%;
	}

	/* Course Assist now carries live CV diagnostics, so the generic 18rem tool
	 * rail is too narrow on this route. Keep the wider rail local to Annotate Round. */
	:global(.editor-body.with-tools) {
		grid-template-columns: 24rem minmax(0, 1fr) !important;
	}

	:global(.tools) {
		min-width: 0;
	}

	@media (max-width: 900px) {
		:global(.editor-body.with-tools) {
			grid-template-columns: 1fr !important;
		}

		main {
			padding: 0.75rem;
		}
	}
</style>
