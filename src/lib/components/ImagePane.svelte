<script lang="ts">
	import { onDestroy } from 'svelte';
	import ImageViewport from './ImageViewport.svelte';
	import { ViewportController, CLICK_SLOP_PX } from '$lib/viewport.svelte';
	import type { ScreenSpacePoint, ViewTransformState } from '$lib/coords';
	import { findImageByRole } from '$lib/domain/project';
	import type { ImageRole } from '$lib/domain/project';
	import type { ImageAsset } from '$lib/domain/project';
	import type { ControlPointPair } from '$lib/domain/project';
	import type { ProjectEditor } from '$lib/domain/editor';
	import { clampPointToImageBounds, imageToScreen, pointInBounds, screenToImage } from '$lib/coords';
	import type { PendingSourcePlacement } from '$lib/correspondenceState';
	import {
		MAGNIFIER_SIZE,
		drawMagnifier,
		magnifierBoxPosition,
		magnifierSampling
	} from '$lib/magnifier';
	import type { MagnifierSampling } from '$lib/magnifier';
	import {
		IntakeError,
		ORIENTATION_LABELS,
		decodeImageFile,
		deriveOrientation,
		intakeImageFile
	} from '$lib/imageIntake';
	import type { DecodeImageFile } from '$lib/imageIntake';
	import { canvas2dAvailable, createPaneScene } from '$lib/scene';
	import type { MarkerHitResult, MarkerSceneData } from '$lib/scene';
	import type { PaneScene } from '$lib/scene';
	import type { PointSelection } from '$lib/pointSelection';
	import { selectionMatches } from '$lib/pointSelection';

	type PointMoveRequest = {
		selection: PointSelection;
		coordinates: { xPx: number; yPx: number };
	};
	type PointMoveResult = { ok: true } | { ok: false; message: string };

	interface Props {
		title: string;
		role: ImageRole;
		editor: ProjectEditor;
		/** Bumped by the parent whenever domain state may have changed. */
		refresh: number;
		pairs: readonly ControlPointPair[];
		pendingSource?: PendingSourcePlacement | null;
		placementEnabled?: boolean;
		correctionEnabled?: boolean;
		selection?: PointSelection | null;
		/** Transient marker-overlay visibility; rendering only, never domain state. */
		markersVisible?: boolean;
		decode?: DecodeImageFile;
		confirmDiscard?: (affectedPairCount: number) => boolean | Promise<boolean>;
		onDomainChanged?: (role: ImageRole) => void;
		onPlacement?: (placement: { role: ImageRole; coordinates: { xPx: number; yPx: number } }) => void;
		onPointSelect?: (selection: PointSelection) => void;
		onPointMove?: (request: PointMoveRequest) => PointMoveResult;
	}

	let {
		title,
		role,
		editor,
		refresh,
		pairs,
		pendingSource = null,
		placementEnabled = false,
		correctionEnabled = false,
		selection = null,
		markersVisible = true,
		decode = decodeImageFile,
		confirmDiscard,
		onDomainChanged,
		onPlacement,
		onPointSelect,
		onPointMove
	}: Props = $props();

	let vp = new ViewportController();

	let loading = $state(false);
	let error = $state<IntakeError | null>(null);
	let fileInput = $state<HTMLInputElement | null>(null);
	let scene: PaneScene | null = null;
	let canvasSupport: boolean | null = null;
	/** Image asset whose decoded raster is currently rendered, so unrelated refreshes never reset navigation. */
	let lastImageId: string | null = null;
	/**
	 * Serialized marker data from the last scene update. Marker scene objects are
	 * rebuilt ONLY when their plain image-space data actually changes, so an
	 * unrelated parent re-render (for example a mode change that passes a fresh
	 * `pairs` reference) never churns the Konva hit canvas and never leaves it one
	 * frame stale while a click is in flight.
	 */
	let lastMarkersJson: string | null = null;
	/** Guards one-time hover-listener setup inside the refresh-reactive effect. */
	let setupDone = false;
	let interactionError = $state<string | null>(null);
	let dragPreview = $state<{ pairId: string; side: 'source' | 'target'; coordinates: { xPx: number; yPx: number } } | null>(null);

	/** Marker-drag gesture only; background pan and clicks live in the viewport. */
	let gesture: {
		pointerId: number;
		start: ScreenSpacePoint;
		transform: ViewTransformState;
		markerHit: MarkerHitResult;
		draggingMarker: boolean;
	} | null = null;

	interface MagnifierAnchorState {
		xPx: number;
		yPx: number;
		screenX: number;
		screenY: number;
	}
	/** Transient magnifier anchor while creating a pair (follows the pointer). */
	let hoverMagnifier = $state<MagnifierAnchorState | null>(null);
	/** Transient magnifier anchor for the selected marker or an in-progress drag. */
	let selectionMagnifier = $state<MagnifierAnchorState | null>(null);
	/** Combined transient anchor: pointer in placement mode, otherwise selection/drag. */
	let magnifier = $derived(hoverMagnifier ?? selectionMagnifier);
	let magnifierCanvas = $state<HTMLCanvasElement | null>(null);

	function canvasAvailable(): boolean {
		if (canvasSupport === null) canvasSupport = canvas2dAvailable();
		return canvasSupport;
	}

	function currentImage(): ImageAsset | null {
		void refresh;
		return findImageByRole(editor.state.images, role) ?? null;
	}

	function currentDecoded(): HTMLImageElement | null {
		void refresh;
		const image = currentImage();
		if (!image) return null;
		const decoded = editor.getAssetResource(image.id)?.decoded;
		return decoded instanceof HTMLImageElement ? decoded : null;
	}

	function errorText(): string | null {
		if (!error) return null;
		switch (error.kind) {
			case 'unsupported-type':
				return 'Unsupported file type: ChainSpot accepts PNG and JPEG images.';
			case 'decode-failure':
			case 'invalid-dimension':
			case 'read-failure':
				return error.message;
			default:
				return null;
		}
	}

	function statusText(): string {
		void refresh;
		if (loading) return 'Loading image…';
		return currentImage() ? 'Image loaded' : 'No image loaded';
	}

	function orientationLabel(): string {
		const image = currentImage();
		if (!image) return '';
		return ORIENTATION_LABELS[deriveOrientation(image.widthPx, image.heightPx)];
	}

	function markerData(): MarkerSceneData[] {
		void refresh;
		void pairs;
		void pendingSource;
		void selection;
		void dragPreview;
		void markersVisible;
		const markers: MarkerSceneData[] = [];
		for (const pair of pairs) {
			const side = role === 'source-overview' ? 'source' : 'target';
			const durablePoint = side === 'source' ? pair.source : pair.target;
			const point =
				dragPreview?.pairId === pair.id && dragPreview.side === side
					? dragPreview.coordinates
					: durablePoint;
			markers.push({
				id: `marker-${pair.id}-${side}`,
				pairId: pair.id,
				side,
				ordinal: pair.ordinal,
				xPx: point.xPx,
				yPx: point.yPx,
				kind: 'complete',
				selected: selectionMatches(selection, pair.id, side),
				enabled: pair.enabled
			});
		}
		if (role === 'source-overview' && pendingSource) {
			markers.push({
				id: 'pending-source-marker',
				pairId: null,
				side: 'source',
				ordinal: pendingSource.ordinal,
				xPx: pendingSource.coordinates.xPx,
				yPx: pendingSource.coordinates.yPx,
				kind: 'pending',
				selected: false,
				enabled: true
			});
		}
		return markers;
	}

	/**
	 * Claims a primary-pointer gesture for marker handling: selects a complete
	 * marker immediately and tracks its drag. Background gestures are left to the
	 * shared viewport (pan or click), and an empty pane claims everything so
	 * nothing happens, exactly as before.
	 */
	function claimPointer(pointer: ScreenSpacePoint, event: PointerEvent): boolean {
		if (!currentImage()) return true;
		const markerHit = scene?.markerHitAt(pointer) ?? null;
		if (markerHit?.kind === 'complete' && markerHit.pairId && correctionEnabled) {
			onPointSelect?.({ pairId: markerHit.pairId, side: markerHit.side });
		}
		if (!markerHit) return false;
		gesture = {
			pointerId: event.pointerId,
			start: pointer,
			transform: { ...vp.view },
			markerHit,
			draggingMarker: false
		};
		window.addEventListener('pointermove', onMarkerMove);
		window.addEventListener('pointerup', onMarkerUp);
		window.addEventListener('pointercancel', onMarkerCancel);
		return true;
	}

	function onMarkerMove(event: PointerEvent): void {
		if (!gesture) return;
		if (event.pointerId !== gesture.pointerId) {
			endMarkerGesture();
			clearDragPreview();
			return;
		}
		if (
			gesture.markerHit.kind !== 'complete' ||
			!gesture.markerHit.pairId ||
			!correctionEnabled
		) {
			return;
		}
		const pointer = vp.pointerIn(event);
		const dx = pointer.x - gesture.start.x;
		const dy = pointer.y - gesture.start.y;
		if (!gesture.draggingMarker && Math.hypot(dx, dy) > CLICK_SLOP_PX) {
			gesture.draggingMarker = true;
		}
		if (!gesture.draggingMarker) return;
		const image = currentImage();
		if (!image) return;
		dragPreview = {
			pairId: gesture.markerHit.pairId,
			side: gesture.markerHit.side,
			coordinates: clampPointToImageBounds(
				screenToImage(pointer, gesture.transform),
				image.widthPx,
				image.heightPx
			)
		};
	}

	function onMarkerUp(event: PointerEvent): void {
		if (!gesture) return;
		if (event.pointerId !== gesture.pointerId) {
			endMarkerGesture();
			clearDragPreview();
			return;
		}
		const activeGesture = gesture;
		const pointer = vp.pointerIn(event);
		const preview = dragPreview;
		const inside = vp.containsPoint(event);
		const image = currentImage();
		const releaseCoordinates =
			image && activeGesture.markerHit.kind === 'complete'
				? clampPointToImageBounds(
						screenToImage(pointer, activeGesture.transform),
						image.widthPx,
						image.heightPx
					)
				: null;
		endMarkerGesture();
		clearDragPreview();
		if (
			!inside ||
			!activeGesture.draggingMarker ||
			activeGesture.markerHit.kind !== 'complete' ||
			!activeGesture.markerHit.pairId ||
			(!preview && !releaseCoordinates) ||
			!correctionEnabled ||
			!onPointMove
		) {
			return;
		}
		const result = onPointMove({
			selection: { pairId: activeGesture.markerHit.pairId, side: activeGesture.markerHit.side },
			coordinates: releaseCoordinates ?? preview!.coordinates
		});
		if (!result.ok) interactionError = result.message;
		else interactionError = null;
	}

	function onMarkerCancel(): void {
		endMarkerGesture();
		clearDragPreview();
	}

	function endMarkerGesture(): void {
		gesture = null;
		if (typeof window === 'undefined') return;
		window.removeEventListener('pointermove', onMarkerMove);
		window.removeEventListener('pointerup', onMarkerUp);
		window.removeEventListener('pointercancel', onMarkerCancel);
	}

	function clearDragPreview(): void {
		dragPreview = null;
	}

	/** Placement clicks land here from the shared viewport's click handling. */
	function onViewportClick(pointer: ScreenSpacePoint): void {
		if (!placementEnabled || !onPlacement) return;
		const image = currentImage();
		if (!image) return;
		const coordinates = screenToImage(pointer, vp.view);
		if (!pointInBounds(coordinates, image.widthPx, image.heightPx)) {
			interactionError = 'Click inside the original image bounds.';
			return;
		}
		interactionError = null;
		onPlacement({ role, coordinates });
	}

	/**
	 * Transient hover magnifier for placement mode: follows the pointer while it is
	 * over the original image. Pure display state — never domain, history, or dirty.
	 */
	function handleHoverMove(event: PointerEvent): void {
		const image = currentImage();
		if (!image || !placementEnabled) {
			hoverMagnifier = null;
			return;
		}
		const pointer = vp.pointerIn(event);
		const coordinates = screenToImage(pointer, vp.view);
		if (!pointInBounds(coordinates, image.widthPx, image.heightPx)) {
			hoverMagnifier = null;
			return;
		}
		hoverMagnifier = { xPx: coordinates.xPx, yPx: coordinates.yPx, screenX: pointer.x, screenY: pointer.y };
	}

	function handleHoverLeave(): void {
		hoverMagnifier = null;
	}

	$effect(() => {
		if (!correctionEnabled) clearDragPreview();
	});

	$effect(() => {
		if (!placementEnabled) hoverMagnifier = null;
	});

	/** Anchors the magnifier on the selected marker (or its drag preview) in correction mode. */
	$effect(() => {
		void refresh;
		void pairs;
		void selection;
		void dragPreview;
		const image = currentImage();
		if (!image || placementEnabled || !correctionEnabled) {
			selectionMagnifier = null;
			return;
		}
		let anchor: { xPx: number; yPx: number } | null = null;
		if (dragPreview) {
			anchor = { xPx: dragPreview.coordinates.xPx, yPx: dragPreview.coordinates.yPx };
		} else if (selection) {
			const side = role === 'source-overview' ? 'source' : 'target';
			const pair = pairs.find((candidate) => candidate.id === selection.pairId);
			if (pair && selection.side === side) {
				const point = pair[side];
				anchor = { xPx: point.xPx, yPx: point.yPx };
			}
		}
		if (!anchor) {
			selectionMagnifier = null;
			return;
		}
		const screen = imageToScreen(anchor, vp.view);
		selectionMagnifier = {
			xPx: anchor.xPx,
			yPx: anchor.yPx,
			screenX: screen.x,
			screenY: screen.y
		};
	});

	/** Renders the transient magnifier canvas from the decoded original pixels. */
	$effect(() => {
		void refresh;
		void vp.view;
		void vp.size;
		const anchor = magnifier;
		const canvas = magnifierCanvas;
		const image = currentImage();
		if (!anchor || !canvas || !image) {
			if (canvas) canvas.style.display = 'none';
			return;
		}
		const sampling = magnifierSampling(
			{ xPx: anchor.xPx, yPx: anchor.yPx },
			image.widthPx,
			image.heightPx,
			MAGNIFIER_SIZE,
			vp.view.zoom
		);
		const box = magnifierBoxPosition({ x: anchor.screenX, y: anchor.screenY }, vp.size, MAGNIFIER_SIZE);
		canvas.style.display = 'block';
		canvas.style.left = `${box.x}px`;
		canvas.style.top = `${box.y}px`;
		canvas.dataset.magnifierAnchorX = String(anchor.xPx);
		canvas.dataset.magnifierAnchorY = String(anchor.yPx);
		canvas.dataset.magnifierSourceX = sampling.sourceX.toFixed(4);
		canvas.dataset.magnifierSourceY = sampling.sourceY.toFixed(4);
		canvas.dataset.magnifierSourceWidth = sampling.sourceWidth.toFixed(4);
		canvas.dataset.magnifierSourceHeight = sampling.sourceHeight.toFixed(4);
		drawMagnifierCanvas(canvas, sampling);
	});

	/**
	 * Samples the DECODED ORIGINAL pixels into the magnifier canvas (never the
	 * already-downscaled screen). Device pixel ratio sizes the backing store; all
	 * drawing happens in CSS-pixel space.
	 */
	function drawMagnifierCanvas(canvas: HTMLCanvasElement, sampling: MagnifierSampling): void {
		const decoded = currentDecoded();
		if (!(decoded instanceof HTMLImageElement)) return;
		if (!(decoded.naturalWidth > 0) || !(decoded.naturalHeight > 0)) return;
		const context = canvas.getContext('2d');
		if (!context) return;
		const deviceScale = globalThis.devicePixelRatio || 1;
		canvas.width = Math.round(MAGNIFIER_SIZE * deviceScale);
		canvas.height = Math.round(MAGNIFIER_SIZE * deviceScale);
		context.setTransform(deviceScale, 0, 0, deviceScale, 0, 0);
		context.imageSmoothingEnabled = false;
		drawMagnifier(context, decoded, sampling, MAGNIFIER_SIZE);
	}

	/** Creates the Konva scene and attaches the pane-local hover listeners once. */
	$effect(() => {
		const container = vp.container;
		if (!container) return;
		if (canvasAvailable() && !scene) {
			scene = createPaneScene(container);
			scene.setStageSize(vp.size.width, vp.size.height);
		}
		if (!setupDone) {
			setupDone = true;
			container.addEventListener('pointermove', handleHoverMove);
			container.addEventListener('pointerleave', handleHoverLeave);
		}
	});

	/** Applies the authoritative viewport transform to the Konva scene. */
	$effect(() => {
		scene?.applyTransform(vp.view);
	});

	/** Keeps the Konva stage sized to the viewport content box. */
	$effect(() => {
		scene?.setStageSize(vp.size.width, vp.size.height);
	});

	/** Renders markers and the raster; establishes the fit only on asset changes. */
	$effect(() => {
		scene?.setMarkersVisible(markersVisible);
		const markers = markerData();
		const markersJson = JSON.stringify(markers);
		if (markersJson !== lastMarkersJson) {
			lastMarkersJson = markersJson;
			scene?.setMarkers(markers);
		}
		const image = currentImage();
		const decoded = currentDecoded();
		if (image && decoded) {
			// Establish the default fit only when the rendered asset changes, so
			// unrelated domain refreshes (rename, future undo/redo) keep the view.
			if (lastImageId !== image.id) {
				lastImageId = image.id;
				lastMarkersJson = null;
				scene?.setImage(decoded, image.widthPx, image.heightPx);
				vp.setFitTarget({ xPx: 0, yPx: 0, widthPx: image.widthPx, heightPx: image.heightPx });
				vp.fit();
			}
		} else if (!image) {
			lastImageId = null;
			lastMarkersJson = null;
			scene?.clearImage();
			vp.setFitTarget(null);
		}
	});

	function resetToFit(): void {
		vp.fit();
	}

	onDestroy(() => {
		endMarkerGesture();
		clearDragPreview();
		sceneContainerRemoveHover();
		scene?.destroy();
		scene = null;
	});

	function sceneContainerRemoveHover(): void {
		const container = vp.container;
		if (!container) return;
		container.removeEventListener('pointermove', handleHoverMove);
		container.removeEventListener('pointerleave', handleHoverLeave);
	}

	async function handleFileChange(event: Event): Promise<void> {
		const input = event.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		input.value = '';
		if (!file) return;
		loading = true;
		error = null;
		try {
			const result = await intakeImageFile({ editor, role, file, decode, confirmDiscard });
			if (result.ok) {
				if (result.status !== 'cancelled') onDomainChanged?.(role);
			} else {
				error = result.error;
			}
		} catch {
			error = new IntakeError('decode-failure', `Could not load "${file.name}".`);
		} finally {
			loading = false;
		}
	}
</script>

<section
	class="pane"
	data-testid={`pane-${role}`}
	aria-labelledby={`pane-heading-${role}`}
	aria-describedby={error || interactionError ? `${error ? `pane-error-${role}` : ''} ${interactionError ? `pane-interaction-error-${role}` : ''}`.trim() : undefined}
>
	<header class="pane-header">
		<h2 id={`pane-heading-${role}`}>{title}</h2>
		<span class="status" role="status" data-testid={`pane-status-${role}`}>{statusText()}</span>
	</header>

	<!-- The viewport is the Konva stage container: Konva clears its contents on
	     mount, so the loading/empty placeholders live in the scene wrapper instead. -->
	<div class="scene">
		<ImageViewport
			controller={vp}
			testid={`pane-scene-${role}`}
			role="img"
			ariaLabel={`${title} image workspace. Use the point list for keyboard selection and management.`}
			ariaDescribedby={`pane-status-${role}`}
			claimPointer={claimPointer}
			onViewportClick={onViewportClick}
		>
			{#snippet content()}{/snippet}
		</ImageViewport>
		<canvas
			class="magnifier"
			data-testid={`pane-magnifier-${role}`}
			aria-hidden="true"
			bind:this={magnifierCanvas}
			style="display: none; width: {MAGNIFIER_SIZE}px; height: {MAGNIFIER_SIZE}px"
		></canvas>
		{#if loading}
			<p class="placeholder" data-testid={`pane-loading-${role}`} role="status">Loading image…</p>
		{:else if !currentImage()}
			<p class="placeholder" data-testid={`pane-empty-${role}`}>No image loaded.</p>
		{/if}
	</div>

	<div class="nav-controls">
		<button
			type="button"
			class="nav-button"
			data-testid={`pane-fit-${role}`}
			disabled={!currentImage()}
			onclick={resetToFit}
			aria-label={`Fit the ${title} image to the pane`}
		>
			Fit
		</button>
		<button
			type="button"
			class="nav-button"
			data-testid={`pane-reset-${role}`}
			disabled={!currentImage()}
			onclick={resetToFit}
			aria-label={`Reset the ${title} image view`}
		>
			Reset
		</button>
	</div>

	{#if error && errorText()}
		<p class="error" data-testid={`pane-error-${role}`} role="alert">{errorText()}</p>
	{/if}
	{#if interactionError}
		<p class="error" data-testid={`pane-interaction-error-${role}`} role="alert">{interactionError}</p>
	{/if}

	{#if currentImage()}
		<dl class="meta">
			<div>
				<dt>File</dt>
				<dd data-testid={`pane-filename-${role}`}>{currentImage()!.fileName}</dd>
			</div>
			<div>
				<dt>Dimensions</dt>
				<dd data-testid={`pane-dimensions-${role}`}>
					{currentImage()!.widthPx} × {currentImage()!.heightPx} px
				</dd>
			</div>
			<div>
				<dt>Orientation</dt>
				<dd data-testid={`pane-orientation-${role}`}>{orientationLabel()}</dd>
			</div>
		</dl>
	{/if}

	<button
		type="button"
		class="choose"
		data-testid={`pane-choose-${role}`}
		onclick={() => fileInput?.click()}
		aria-label={currentImage() ? `Replace the ${title} image` : `Choose a ${title} image`}
	>
		{currentImage() ? 'Replace image' : 'Choose image'}
	</button>
	<input
		class="file-input"
		type="file"
		accept="image/png,image/jpeg"
		data-testid={`pane-input-${role}`}
		bind:this={fileInput}
		onchange={handleFileChange}
		tabindex="-1"
		aria-hidden="true"
	/>
</section>

<style>
	.pane {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		min-width: 0;
	}

	.pane-header {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 0.5rem;
	}

	h2 {
		font-size: 1rem;
		margin: 0;
	}

	.status {
		font-size: 0.8rem;
		opacity: 0.7;
	}

	.scene {
		position: relative;
		height: 420px;
		border: 1px solid #ccc;
		border-radius: 4px;
		background: repeating-conic-gradient(#f2f2f2 0% 25%, #ffffff 0% 50%) 50% / 16px 16px;
		overflow: hidden;
	}

	.magnifier {
		position: absolute;
		border: 1px solid rgb(255 255 255 / 80%);
		box-shadow: 0 2px 8px rgb(0 0 0 / 45%);
		border-radius: 4px;
		pointer-events: none;
		z-index: 5;
	}

	.nav-controls {
		display: flex;
		gap: 0.5rem;
	}

	.nav-button {
		font-size: 0.85rem;
	}

	.placeholder {
		position: absolute;
		margin: 1rem;
		color: #666;
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

	.meta {
		display: grid;
		grid-template-columns: auto 1fr;
		gap: 0.15rem 0.75rem;
		margin: 0;
		font-size: 0.85rem;
	}

	.meta dt {
		font-weight: 600;
		opacity: 0.8;
	}

	.meta dd {
		margin: 0;
	}

	.choose {
		align-self: flex-start;
	}

	.file-input {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip: rect(0 0 0 0);
	}

	:global(button:focus-visible) {
		outline: 3px solid #075985;
		outline-offset: 2px;
	}

	@media (max-width: 900px) {
		.scene {
			height: min(420px, 58vh);
		}
	}
</style>
