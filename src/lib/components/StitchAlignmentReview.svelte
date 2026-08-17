<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { decodeImageFile } from '$lib/imageIntake';
	import {
		applySourceTransform,
		invertSourceTransform
	} from '$lib/domain/provenance';
	import type { CompositeProvenance, DraftComposite } from '$lib/domain/provenance';
	import type { StitchPipelineSuccess } from '$lib/stitch/pipelineResult';
	import { renderPipelineComposite } from '$lib/stitch/smartImport';
	import { prefersReducedMotion } from '$lib/reducedMotion';
	import {
		clampFloatingRect,
		deriveBadgeAlignmentWitnesses,
		imagePointPercent,
		screenDeltaToImageDelta,
		translateDraftSource
	} from '$lib/stitch/alignmentReview';
	import type {
		BadgeAlignmentWitness,
		FloatingRectPosition,
		SharedBadgeObservation
	} from '$lib/stitch/alignmentReview';

	interface BadgeAnchor {
		readonly holeNumber: number;
		/** Physical badge center in composite/output pixels. */
		readonly xPx: number;
		readonly yPx: number;
		readonly widthPx: number;
		readonly heightPx: number;
		readonly confidence?: number;
	}

	interface AdjustmentResult {
		readonly draft: DraftComposite;
		readonly blob: Blob;
		readonly provenance: CompositeProvenance;
	}

	interface Props {
		success: StitchPipelineSuccess;
		imageUrl: string;
		provenance: CompositeProvenance;
		badgeAnchors: readonly BadgeAnchor[];
		busy?: boolean;
		onAccept: () => void;
		onAdjusted: (result: AdjustmentResult) => void | Promise<void>;
	}

	let { success, imageUrl, provenance, badgeAnchors, busy = false, onAccept, onAdjusted }: Props = $props();

	type ReviewMode = 'review' | 'correction';
	let mode = $state<ReviewMode>('review');
	let currentDraft = $state<DraftComposite>(success.draft);
	let initialDraft = success.draft;
	let selectedSourceId = $state<string | null>(null);
	let sourceImages = $state<ReadonlyMap<string, HTMLImageElement>>(new Map());
	let rendering = $state(false);
	let plane = $state<HTMLDivElement | null>(null);
	let loadGeneration = 0;
	let sourceSignature = success.sources.map((source) => source.sourceId).join('|');

	let hud = $state<HTMLDivElement | null>(null);
	let hudPosition = $state<FloatingRectPosition>({ xPx: 24, yPx: 24 });
	let hudDrag: { pointerId: number; dxPx: number; dyPx: number } | null = null;

	let witnessDock = $state<HTMLDivElement | null>(null);
	let witnessPosition = $state<FloatingRectPosition>({ xPx: 16, yPx: 16 });
	let witnessDrag: { pointerId: number; dxPx: number; dyPx: number } | null = null;

	let sourceDrag: {
		pointerId: number;
		sourceId: string;
		startClientX: number;
		startClientY: number;
		deltaXImagePx: number;
		deltaYImagePx: number;
	} | null = $state(null);

	const correctionSources = $derived(currentDraft.sources);
	const selectedSource = $derived(
		selectedSourceId ? currentDraft.sources.find((source) => source.sourceId === selectedSourceId) ?? null : null
	);

	const sharedBadgeObservations = $derived.by(() => {
		const observations: SharedBadgeObservation[] = [];
		for (const badge of badgeAnchors) {
			for (const source of currentDraft.sources) {
				const inverse = invertSourceTransform(source.transform);
				if (!inverse) continue;
				const sourcePoint = applySourceTransform({ xPx: badge.xPx, yPx: badge.yPx }, inverse);
				const crop = source.crop;
				if (
					sourcePoint.xPx < crop.xPx ||
					sourcePoint.yPx < crop.yPx ||
					sourcePoint.xPx >= crop.xPx + crop.widthPx ||
					sourcePoint.yPx >= crop.yPx + crop.heightPx
				) {
					continue;
				}
				observations.push({
					sourceId: source.sourceId,
					holeNumber: badge.holeNumber,
					xPx: sourcePoint.xPx,
					yPx: sourcePoint.yPx,
					widthPx: badge.widthPx,
					heightPx: badge.heightPx,
					confidence: badge.confidence ?? 0
				});
			}
		}
		return observations;
	});

	const witnesses = $derived(
		deriveBadgeAlignmentWitnesses(currentDraft, sharedBadgeObservations, 6)
	);

	function clampHud(): void {
		if (typeof window === 'undefined' || !hud) return;
		hudPosition = clampFloatingRect(
			hudPosition,
			{ widthPx: hud.offsetWidth, heightPx: hud.offsetHeight },
			{ widthPx: window.innerWidth, heightPx: window.innerHeight }
		);
	}

	function setReviewMode(nextMode: ReviewMode): void {
		mode = nextMode;
		if (typeof window === 'undefined') return;
		// The correction HUD is much wider than the Yes/No HUD. Re-clamp after
		// Svelte has rendered the new mode so its right-hand controls cannot
		// grow beyond the viewport on tall stitched maps.
		requestAnimationFrame(() => clampHud());
	}

	function clampWitnessDock(): void {
		if (typeof window === 'undefined' || !witnessDock) return;
		witnessPosition = clampFloatingRect(
			witnessPosition,
			{ widthPx: witnessDock.offsetWidth, heightPx: witnessDock.offsetHeight },
			{ widthPx: window.innerWidth, heightPx: window.innerHeight }
		);
	}

	async function loadSourceImages(): Promise<void> {
		const generation = ++loadGeneration;
		const entries = await Promise.all(
			success.sources.map(async (source) => {
				const decoded = await decodeImageFile(source.file);
				return [source.sourceId, decoded.image] as const;
			})
		);
		if (generation !== loadGeneration) return;
		sourceImages = new Map(entries);
	}

	$effect(() => {
		const nextSignature = success.sources.map((source) => source.sourceId).join('|');
		if (nextSignature === sourceSignature) return;
		sourceSignature = nextSignature;
		currentDraft = success.draft;
		initialDraft = success.draft;
		selectedSourceId = null;
		mode = 'review';
		void loadSourceImages();
	});

	onMount(() => {
		void loadSourceImages();
		const handleResize = (): void => {
			clampHud();
			clampWitnessDock();
		};
		window.addEventListener('resize', handleResize);
		requestAnimationFrame(() => {
			hudPosition = { xPx: Math.max(16, window.innerWidth - (hud?.offsetWidth ?? 180) - 20), yPx: 20 };
			clampHud();
			witnessPosition = { xPx: 16, yPx: Math.max(16, window.innerHeight - (witnessDock?.offsetHeight ?? 160) - 20) };
			clampWitnessDock();
		});
		return () => window.removeEventListener('resize', handleResize);
	});

	onDestroy(() => {
		loadGeneration += 1;
		removeHudDragListeners();
		removeWitnessDragListeners();
	});

	function beginHudDrag(event: PointerEvent): void {
		if (!hud) return;
		event.preventDefault();
		hudDrag = {
			pointerId: event.pointerId,
			dxPx: event.clientX - hudPosition.xPx,
			dyPx: event.clientY - hudPosition.yPx
		};
		window.addEventListener('pointermove', moveHud);
		window.addEventListener('pointerup', endHudDrag);
		window.addEventListener('pointercancel', endHudDrag);
	}

	function moveHud(event: PointerEvent): void {
		if (!hudDrag || event.pointerId !== hudDrag.pointerId) return;
		hudPosition = { xPx: event.clientX - hudDrag.dxPx, yPx: event.clientY - hudDrag.dyPx };
		clampHud();
	}

	function endHudDrag(event: PointerEvent): void {
		if (!hudDrag || event.pointerId !== hudDrag.pointerId) return;
		hudDrag = null;
		removeHudDragListeners();
	}

	function removeHudDragListeners(): void {
		if (typeof window === 'undefined') return;
		window.removeEventListener('pointermove', moveHud);
		window.removeEventListener('pointerup', endHudDrag);
		window.removeEventListener('pointercancel', endHudDrag);
	}

	function beginWitnessDrag(event: PointerEvent): void {
		if (!witnessDock) return;
		event.preventDefault();
		witnessDrag = {
			pointerId: event.pointerId,
			dxPx: event.clientX - witnessPosition.xPx,
			dyPx: event.clientY - witnessPosition.yPx
		};
		window.addEventListener('pointermove', moveWitnessDock);
		window.addEventListener('pointerup', endWitnessDrag);
		window.addEventListener('pointercancel', endWitnessDrag);
	}

	function moveWitnessDock(event: PointerEvent): void {
		if (!witnessDrag || event.pointerId !== witnessDrag.pointerId) return;
		witnessPosition = {
			xPx: event.clientX - witnessDrag.dxPx,
			yPx: event.clientY - witnessDrag.dyPx
		};
		clampWitnessDock();
	}

	function endWitnessDrag(event: PointerEvent): void {
		if (!witnessDrag || event.pointerId !== witnessDrag.pointerId) return;
		witnessDrag = null;
		removeWitnessDragListeners();
	}

	function removeWitnessDragListeners(): void {
		if (typeof window === 'undefined') return;
		window.removeEventListener('pointermove', moveWitnessDock);
		window.removeEventListener('pointerup', endWitnessDrag);
		window.removeEventListener('pointercancel', endWitnessDrag);
	}

	function drawWitness(canvas: HTMLCanvasElement, witness: BadgeAlignmentWitness): void {
		const cssSize = 132;
		const dpr = typeof window === 'undefined' ? 1 : Math.max(1, window.devicePixelRatio || 1);
		canvas.width = Math.round(cssSize * dpr);
		canvas.height = Math.round(cssSize * dpr);
		canvas.style.width = `${cssSize}px`;
		canvas.style.height = `${cssSize}px`;
		const context = canvas.getContext('2d');
		if (!context) return;
		context.clearRect(0, 0, canvas.width, canvas.height);
		context.fillStyle = '#0a0a0a';
		context.fillRect(0, 0, canvas.width, canvas.height);
		context.imageSmoothingEnabled = false;
		const scale = canvas.width / witness.windowSizePx;

		for (const layer of witness.layers) {
			const image = sourceImages.get(layer.sourceId);
			const source = currentDraft.sources.find((candidate) => candidate.sourceId === layer.sourceId);
			if (!image || !source) continue;
			const [a, b, c, d, e, f] = layer.sourceTransform.coefficients;
			context.save();
			context.setTransform(
				scale * a,
				scale * b,
				scale * c,
				scale * d,
				scale * (e - witness.outputCenter.xPx) + canvas.width / 2,
				scale * (f - witness.outputCenter.yPx) + canvas.height / 2
			);
			context.beginPath();
			context.rect(source.crop.xPx, source.crop.yPx, source.crop.widthPx, source.crop.heightPx);
			context.clip();
			context.globalAlpha = layer.opacity;
			context.drawImage(image, 0, 0, source.widthPx, source.heightPx);
			context.restore();
		}
	}

	function witnessCanvas(node: HTMLCanvasElement, witness: BadgeAlignmentWitness): { update(next: BadgeAlignmentWitness): void } {
		const draw = (next: BadgeAlignmentWitness): void => drawWitness(node, next);
		draw(witness);
		return { update: draw };
	}

	function previewPolygonPoints(sourceId: string): string {
		const source = currentDraft.sources.find((candidate) => candidate.sourceId === sourceId);
		if (!source) return '';
		const dx = sourceDrag?.sourceId === sourceId ? sourceDrag.deltaXImagePx : 0;
		const dy = sourceDrag?.sourceId === sourceId ? sourceDrag.deltaYImagePx : 0;
		return source.coveragePolygon.map((point) => `${point.xPx + dx},${point.yPx + dy}`).join(' ');
	}

	function beginSourceDrag(event: PointerEvent, sourceId: string): void {
		if (mode !== 'correction' || rendering || busy || !plane) return;
		event.preventDefault();
		event.stopPropagation();
		selectedSourceId = sourceId;
		(event.currentTarget as SVGPolygonElement).setPointerCapture(event.pointerId);
		sourceDrag = {
			pointerId: event.pointerId,
			sourceId,
			startClientX: event.clientX,
			startClientY: event.clientY,
			deltaXImagePx: 0,
			deltaYImagePx: 0
		};
	}

	function moveSourceDrag(event: PointerEvent): void {
		if (!sourceDrag || event.pointerId !== sourceDrag.pointerId || !plane) return;
		const rect = plane.getBoundingClientRect();
		const delta = screenDeltaToImageDelta(
			{ xPx: event.clientX - sourceDrag.startClientX, yPx: event.clientY - sourceDrag.startClientY },
			{ widthPx: rect.width, heightPx: rect.height },
			currentDraft.outputWidthPx,
			currentDraft.outputHeightPx
		);
		sourceDrag = { ...sourceDrag, deltaXImagePx: delta.xPx, deltaYImagePx: delta.yPx };
	}

	async function endSourceDrag(event: PointerEvent): Promise<void> {
		if (!sourceDrag || event.pointerId !== sourceDrag.pointerId) return;
		const drag = sourceDrag;
		sourceDrag = null;
		const dx = Math.round(drag.deltaXImagePx);
		const dy = Math.round(drag.deltaYImagePx);
		if (dx === 0 && dy === 0) return;
		await applyTranslation(drag.sourceId, dx, dy);
	}

	function cancelSourceDrag(event: PointerEvent): void {
		if (!sourceDrag || event.pointerId !== sourceDrag.pointerId) return;
		sourceDrag = null;
	}

	async function applyTranslation(sourceId: string, dxPx: number, dyPx: number): Promise<void> {
		if (rendering || busy || sourceImages.size === 0) return;
		const nextDraft = translateDraftSource(currentDraft, sourceId, { xPx: dxPx, yPx: dyPx });
		rendering = true;
		try {
			const rendered = await renderPipelineComposite(nextDraft, sourceImages);
			currentDraft = nextDraft;
			await onAdjusted({ draft: nextDraft, ...rendered });
		} finally {
			rendering = false;
		}
	}

	async function nudgeSelected(dxPx: number, dyPx: number): Promise<void> {
		if (!selectedSourceId) return;
		await applyTranslation(selectedSourceId, dxPx, dyPx);
	}

	async function resetAll(): Promise<void> {
		if (rendering || busy || sourceImages.size === 0) return;
		rendering = true;
		try {
			const rendered = await renderPipelineComposite(initialDraft, sourceImages);
			currentDraft = initialDraft;
			selectedSourceId = null;
			await onAdjusted({ draft: initialDraft, ...rendered });
		} finally {
			rendering = false;
		}
	}

	function handleCorrectionKeydown(event: KeyboardEvent): void {
		if (mode !== 'correction' || !selectedSourceId) return;
		const amount = event.shiftKey ? 10 : 1;
		let dx = 0;
		let dy = 0;
		if (event.key === 'ArrowLeft') dx = -amount;
		else if (event.key === 'ArrowRight') dx = amount;
		else if (event.key === 'ArrowUp') dy = -amount;
		else if (event.key === 'ArrowDown') dy = amount;
		else return;
		event.preventDefault();
		void nudgeSelected(dx, dy);
	}
</script>

<section class="alignment-review" data-testid="alignment-review" onkeydown={handleCorrectionKeydown}>
	<div class="alignment-viewport" data-testid="alignment-viewport">
		<div
			class="alignment-plane"
			bind:this={plane}
			style:aspect-ratio={`${provenance.outputWidthPx} / ${provenance.outputHeightPx}`}
			data-testid="alignment-plane"
			data-output-width={provenance.outputWidthPx}
			data-output-height={provenance.outputHeightPx}
		>

<img class="alignment-image" src={imageUrl} alt="Assembled stitched map" data-testid="composite-image" />
{#each badgeAnchors as anchor, index (anchor.holeNumber + '-' + index)}
	{@const pos = imagePointPercent(anchor, provenance.outputWidthPx, provenance.outputHeightPx)}
	<div
		class="badge-flash"
		class:reduced-motion={prefersReducedMotion()}
		style:left={`${pos.leftPct}%`}
		style:top={`${pos.topPct}%`}
		style:animation-delay={prefersReducedMotion() ? '0ms' : `${Math.min(index, 8) * 70}ms`}
		data-testid="badge-flash"
		data-hole-number={anchor.holeNumber}
	></div>
{/each}
			{#if mode === 'correction'}
				<svg
					class="source-outlines"
					viewBox={`0 0 ${currentDraft.outputWidthPx} ${currentDraft.outputHeightPx}`}
					preserveAspectRatio="none"
					aria-label="Contributing source boundaries"
					data-testid="source-outlines"
				>
					{#each correctionSources as source, index (source.sourceId)}
						<polygon
							class:selected={selectedSourceId === source.sourceId}
							points={previewPolygonPoints(source.sourceId)}
							data-testid={`source-outline-${index}`}
							data-source-id={source.sourceId}
							data-selected={selectedSourceId === source.sourceId}
							onpointerdown={(event) => beginSourceDrag(event, source.sourceId)}
							onpointermove={moveSourceDrag}
							onpointerup={(event) => void endSourceDrag(event)}
							onpointercancel={cancelSourceDrag}
						></polygon>
					{/each}
				</svg>
			{/if}
		</div>
	</div>

	<div
		class="review-hud"
		bind:this={hud}
		style:left={`${hudPosition.xPx}px`}
		style:top={`${hudPosition.yPx}px`}
		data-testid="alignment-hud"
		data-demo-anchor="stitch-alignment-review"
	>
		<button type="button" class="drag-handle" aria-label="Move alignment controls" onpointerdown={beginHudDrag}>⋮⋮</button>
		{#if mode === 'review'}
			<strong>Aligned?</strong>
			<button type="button" class="yes" data-testid="alignment-yes" disabled={busy || rendering} onclick={onAccept}>Yes</button>
			<button type="button" class="no" data-testid="alignment-no" disabled={busy || rendering} onclick={() => setReviewMode('correction')}>No</button>
		{:else}
			<div class="correction-summary">
				<strong>{selectedSource ? selectedSource.fileName : 'Select a capture'}</strong>
				<span>{selectedSource ? 'Drag the yellow outline' : 'All source boundaries are white'}</span>
			</div>
			<div class="nudge-row" aria-label="Selected capture nudge controls">
				<button type="button" disabled={!selectedSourceId || rendering} onclick={() => void nudgeSelected(-1, 0)}>←</button>
				<button type="button" disabled={!selectedSourceId || rendering} onclick={() => void nudgeSelected(0, -1)}>↑</button>
				<button type="button" disabled={!selectedSourceId || rendering} onclick={() => void nudgeSelected(0, 1)}>↓</button>
				<button type="button" disabled={!selectedSourceId || rendering} onclick={() => void nudgeSelected(1, 0)}>→</button>
			</div>
			<button type="button" class="compact" data-testid="alignment-reset-all" disabled={rendering} onclick={() => void resetAll()}>Reset all</button>
			<button type="button" class="apply" data-testid="alignment-apply" disabled={rendering} onclick={() => setReviewMode('review')}>Apply adjustments</button>
		{/if}
		{#if rendering}<span class="rendering" role="status">Rendering…</span>{/if}
	</div>

	{#if witnesses.length > 0}
		<div
			class="witness-dock"
			bind:this={witnessDock}
			style:left={`${witnessPosition.xPx}px`}
			style:top={`${witnessPosition.yPx}px`}
			data-testid="badge-witness-dock"
		>
			<button type="button" class="witness-handle" aria-label="Move badge witnesses" onpointerdown={beginWitnessDrag}>Alignment witnesses ⋮⋮</button>
			<div class="witness-list">
				{#each witnesses as witness (witness.holeNumber)}
					<figure class="witness" data-testid="badge-witness" data-hole-number={witness.holeNumber}>
						<canvas use:witnessCanvas={witness} aria-label={`Hole ${witness.holeNumber} alignment overlay`}></canvas>
						<figcaption>Hole {witness.holeNumber}</figcaption>
					</figure>
				{/each}
			</div>
		</div>
	{/if}
</section>

<style>
	.alignment-review {
		position: relative;
		width: 100%;
		min-width: 0;
	}

	.alignment-viewport {
		position: relative;
		width: 100%;
		height: calc(100dvh - 5.5rem);
		min-height: 24rem;
		overflow: auto;
		overscroll-behavior: contain;
		background: #09090b;
		border: 1px solid #27272a;
		border-radius: 10px;
	}

	.alignment-plane {
		position: relative;
		width: 100%;
		min-width: 100%;
		/* Never clip here: every image-space overlay resolves against this exact raster plane. */
		overflow: visible;
	}

	.alignment-image {
		position: absolute;
		inset: 0;
		display: block;
		width: 100%;
		height: 100%;
		object-fit: fill;
		user-select: none;
		-webkit-user-drag: none;
	}


.badge-flash {
	position: absolute;
	z-index: 3;
	width: 22px;
	height: 22px;
	margin-left: -11px;
	margin-top: -11px;
	border-radius: 50%;
	border: 2px solid #4ade80;
	box-shadow: 0 0 0 0 rgba(74, 222, 128, 0.6);
	pointer-events: none;
	animation: badge-pulse 1.1s ease-out 1;
}

.badge-flash.reduced-motion {
	animation: none;
	box-shadow: 0 0 0 4px rgba(74, 222, 128, 0.35);
}

@keyframes badge-pulse {
	0% {
		transform: scale(0.6);
		opacity: 0;
		box-shadow: 0 0 0 0 rgba(74, 222, 128, 0.6);
	}
	30% { opacity: 1; }
	100% {
		transform: scale(1);
		opacity: 0.9;
		box-shadow: 0 0 0 10px rgba(74, 222, 128, 0);
	}
}

	.source-outlines {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		overflow: visible;
	}

	.source-outlines polygon {
		fill: rgba(255, 255, 255, 0.001);
		stroke: white;
		stroke-width: 2.5;
		vector-effect: non-scaling-stroke;
		pointer-events: all;
		cursor: grab;
		touch-action: none;
	}

	.source-outlines polygon:hover {
		stroke-width: 4;
	}

	.source-outlines polygon.selected {
		stroke: #facc15;
		stroke-width: 4;
		cursor: grabbing;
	}

	.review-hud,
	.witness-dock {
		position: fixed;
		z-index: 80;
		background: rgba(9, 9, 11, 0.93);
		border: 1px solid rgba(255, 255, 255, 0.16);
		box-shadow: 0 10px 32px rgba(0, 0, 0, 0.42);
		backdrop-filter: blur(10px);
	}

	.review-hud {
		display: flex;
		align-items: center;
		gap: 0.45rem;
		max-width: min(92vw, 34rem);
		padding: 0.5rem;
		border-radius: 999px;
	}

	.review-hud strong {
		margin: 0 0.2rem;
		white-space: nowrap;
	}

	.review-hud button {
		border: 1px solid #52525b;
		border-radius: 999px;
		padding: 0.42rem 0.72rem;
		background: #27272a;
		color: #fafafa;
		font: inherit;
		font-weight: 650;
		cursor: pointer;
	}

	.review-hud button:disabled {
		opacity: 0.5;
		cursor: default;
	}

	.review-hud .yes,
	.review-hud .apply {
		background: #166534;
		border-color: #22c55e;
	}

	.review-hud .no {
		background: #7f1d1d;
		border-color: #ef4444;
	}

	.drag-handle,
	.witness-handle {
		cursor: move !important;
		touch-action: none;
		user-select: none;
	}

	.drag-handle {
		padding-inline: 0.45rem !important;
		background: transparent !important;
		border-color: transparent !important;
		color: #a1a1aa !important;
	}

	.correction-summary {
		display: flex;
		flex-direction: column;
		min-width: 8rem;
		max-width: 13rem;
	}

	.correction-summary strong,
	.correction-summary span {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.correction-summary span,
	.rendering {
		font-size: 0.72rem;
		color: #a1a1aa;
	}

	.nudge-row {
		display: flex;
		gap: 0.2rem;
	}

	.nudge-row button {
		padding-inline: 0.48rem;
	}

	.witness-dock {
		max-width: min(90vw, 46rem);
		padding: 0.4rem;
		border-radius: 10px;
	}

	.witness-handle {
		display: block;
		width: 100%;
		padding: 0.15rem 0.25rem 0.35rem;
		border: 0;
		background: transparent;
		color: #d4d4d8;
		font: inherit;
		font-size: 0.72rem;
		text-align: left;
	}

	.witness-list {
		display: flex;
		gap: 0.4rem;
		max-width: 100%;
		overflow-x: auto;
	}

	.witness {
		position: relative;
		flex: 0 0 auto;
		margin: 0;
		border: 1px solid #52525b;
		border-radius: 8px;
		overflow: hidden;
		background: #000;
	}

	.witness canvas {
		display: block;
	}

	.witness figcaption {
		position: absolute;
		left: 0.35rem;
		bottom: 0.3rem;
		padding: 0.15rem 0.35rem;
		border-radius: 999px;
		background: rgba(0, 0, 0, 0.72);
		color: white;
		font-size: 0.75rem;
		font-weight: 700;
	}

	@media (max-width: 700px) {
		.alignment-viewport {
			height: calc(100dvh - 4rem);
			border-radius: 0;
		}
		.review-hud {
			max-width: calc(100vw - 16px);
			border-radius: 12px;
			flex-wrap: wrap;
		}
		.witness canvas {
			width: 108px !important;
			height: 108px !important;
		}
	}
</style>
