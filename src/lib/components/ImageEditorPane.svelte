<script lang="ts">
	import type { Snippet } from 'svelte';
	import ImageViewport from './ImageViewport.svelte';
	import { ViewportController } from '$lib/viewport.svelte';
	import { pointInBounds, screenToImage } from '$lib/coords';
	import type { ScreenSpacePoint, ViewTransformState } from '$lib/coords';
	import { findImageByRole } from '$lib/domain/project';
	import type { ImageAsset, ImageRole } from '$lib/domain/project';
	import type { ProjectEditor } from '$lib/domain/editor';
	import {
		IntakeError,
		decodeImageFile,
		intakeImageFile
	} from '$lib/imageIntake';
	import type { DecodeImageFile } from '$lib/imageIntake';

	interface OverlayContext {
		image: ImageAsset;
		zoom: number;
	}

	interface ViewportFocusRequest {
		key: string;
		point: { xPx: number; yPx: number };
		zoomMultiplier?: number;
	}

	/**
	 * Context for the `popover` snippet — deliberately richer than
	 * `OverlayContext`: a popover needs the full view transform (not just
	 * zoom) to convert an image-space anchor into pane-local screen space, and
	 * the pane's own CSS-px size to clamp itself fully on-screen.
	 */
	interface PopoverContext {
		view: ViewTransformState;
		paneSize: { width: number; height: number };
	}

	interface Props {
		title: string;
		role: ImageRole;
		editor: ProjectEditor;
		refresh: number;
		decode?: DecodeImageFile;
		confirmDiscard?: (affectedPairCount: number) => boolean | Promise<boolean>;
		onDomainChanged?: (role: ImageRole) => void;
		onPlacement?: (
			coordinates: { xPx: number; yPx: number },
			options?: { altKey?: boolean }
		) => void;
		claimPointer?: (
			pointer: ScreenSpacePoint,
			event: PointerEvent,
			view: ViewTransformState
		) => boolean;
		onClaimedPointerMove?: (
			pointer: ScreenSpacePoint,
			event: PointerEvent,
			view: ViewTransformState
		) => void;
		onClaimedPointerUp?: (
			pointer: ScreenSpacePoint,
			event: PointerEvent,
			view: ViewTransformState
		) => void;
		onClaimedPointerCancel?: (
			pointer: ScreenSpacePoint,
			event: PointerEvent,
			view: ViewTransformState
		) => void;
		tools?: Snippet;
		/** Optional controls rendered beside Fit image and the file action. */
		headerActions?: Snippet;
		/** Override the tools landmark label; null removes it for intentionally self-explanatory rails. */
		toolsAriaLabel?: string | null;
		/** One-shot camera focus request, keyed so manual panning is never overwritten on every render. */
		focusRequest?: ViewportFocusRequest | null;
		diagnostics?: Snippet;
		overlay?: Snippet<[OverlayContext]>;
		/**
		 * Rendered as a sibling of `ImageViewport`, inside `.canvas-shell` but
		 * OUTSIDE `.image-viewport`'s `overflow: hidden` — unlike `overlay`,
		 * content here is never clipped at the pane's edges and its pointerdown
		 * events never reach the viewport's own gesture handling at all (they
		 * bubble through `.canvas-shell`, not through `.image-viewport`). Meant
		 * for popovers anchored at a point inside the image (e.g. a placement
		 * menu) that must stay fully visible even when that point is near an
		 * edge or corner of the visible pane.
		 */
		popover?: Snippet<[PopoverContext]>;
	}

	let {
		title,
		role,
		editor,
		refresh,
		decode = decodeImageFile,
		confirmDiscard,
		onDomainChanged,
		onPlacement,
		claimPointer,
		onClaimedPointerMove,
		onClaimedPointerUp,
		onClaimedPointerCancel,
		tools,
		headerActions,
		toolsAriaLabel,
		focusRequest,
		diagnostics,
		overlay,
		popover
	}: Props = $props();

	let vp = new ViewportController();
	let fileInput = $state<HTMLInputElement | null>(null);
	let loading = $state(false);
	let error = $state<IntakeError | null>(null);
	let objectUrl = $state<string | null>(null);
	let fittedImageId: string | null = null;
	let appliedFocusKey: string | null = null;

	function currentImage(): ImageAsset | null {
		void refresh;
		return findImageByRole(editor.state.images, role) ?? null;
	}

	$effect(() => {
		void refresh;
		const image = currentImage();
		const resource = image ? editor.getAssetResource(image.id) : null;
		if (!image || !resource) {
			objectUrl = null;
			fittedImageId = null;
			vp.setFitTarget(null);
			return;
		}
		const url = URL.createObjectURL(
			new Blob([resource.bytes as BufferSource], { type: image.mimeType })
		);
		objectUrl = url;
		if (fittedImageId !== image.id) {
			fittedImageId = image.id;
			vp.setFitTarget({ xPx: 0, yPx: 0, widthPx: image.widthPx, heightPx: image.heightPx });
			vp.fit();
		}
		return () => URL.revokeObjectURL(url);
	});

	$effect(() => {
		const request = focusRequest;
		const image = currentImage();
		if (!request) {
			appliedFocusKey = null;
			return;
		}
		if (!image || !vp.fitTarget || vp.size.width <= 1 || vp.size.height <= 1) return;
		const requestKey = `${image.id}:${request.key}`;
		if (requestKey === appliedFocusKey) return;
		vp.focusOnPoint(request.point, request.zoomMultiplier);
		appliedFocusKey = requestKey;
	});

	function handleViewportClick(pointer: { x: number; y: number }, event: PointerEvent): void {
		const image = currentImage();
		if (!image || !onPlacement) return;
		const coordinates = screenToImage(pointer, vp.view);
		if (!pointInBounds(coordinates, image.widthPx, image.heightPx)) return;
		onPlacement(coordinates, { altKey: event.altKey });
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

<section class="editor-pane" data-testid={`pane-${role}`}>
	<header class="editor-header">
		<div>
			<h2>{title}</h2>
			{#if currentImage()}
				<p data-testid={`pane-filename-${role}`}>
					{currentImage()!.fileName} · {currentImage()!.widthPx} × {currentImage()!.heightPx}
				</p>
			{:else}
				<p>No image loaded</p>
			{/if}
			<span class="sr-only" role="status" data-testid={`pane-status-${role}`}>
				{loading ? 'Loading image…' : currentImage() ? 'Image loaded' : 'No image loaded'}
			</span>
		</div>
		<div class="header-actions">
			{#if headerActions}
				{@render headerActions()}
			{/if}
			<button type="button" data-testid={`pane-fit-${role}`} disabled={!currentImage()} onclick={() => vp.fit()}>Fit image</button>
			<button
				type="button"
				data-testid={`pane-choose-${role}`}
				aria-label={currentImage() ? `Replace the ${title} image` : `Choose a ${title} image`}
				onclick={() => fileInput?.click()}
			>
				{currentImage() ? 'Replace image' : 'Choose image'}
			</button>
		</div>
	</header>

	{#if error}
		<p class="error" role="alert">{error.message}</p>
	{/if}

	<div class="editor-body" class:with-tools={Boolean(tools)}>
		{#if tools}
			<aside class="tools" aria-label={toolsAriaLabel === null ? undefined : toolsAriaLabel ?? `${title} tools`}>
				{@render tools()}
			</aside>
		{/if}

		<div class="canvas-shell" class:placing={Boolean(onPlacement)}>
			<ImageViewport
				controller={vp}
				testid={`pane-scene-${role}`}
				role="img"
				ariaLabel={`${title} editor. Drag to pan, use the wheel to zoom, and click the image to place the selected annotation.`}
				claimPointer={claimPointer ? (pointer, event) => claimPointer(pointer, event, vp.view) : undefined}
				onClaimedPointerMove={
					onClaimedPointerMove
						? (pointer, event) => onClaimedPointerMove(pointer, event, vp.view)
						: undefined
				}
				onClaimedPointerUp={
					onClaimedPointerUp
						? (pointer, event) => onClaimedPointerUp(pointer, event, vp.view)
						: undefined
				}
				onClaimedPointerCancel={
					onClaimedPointerCancel
						? (pointer, event) => onClaimedPointerCancel(pointer, event, vp.view)
						: undefined
				}
				onViewportClick={handleViewportClick}
			>
				{#snippet content()}
					{#if currentImage() && objectUrl}
						{@const image = currentImage()!}
						<div
							class="workspace"
							data-testid="annotation-frame"
							style={`width:${image.widthPx}px;height:${image.heightPx}px;transform:translate(${vp.view.panX}px,${vp.view.panY}px) scale(${vp.view.zoom})`}
						>
							<img
								class="source-image annotation-image"
								src={objectUrl}
								alt=""
								width={image.widthPx}
								height={image.heightPx}
								draggable="false"
							/>
							{#if overlay}
								{@render overlay({ image, zoom: vp.view.zoom })}
							{/if}
						</div>
					{:else}
						<div class="empty-state">
							<strong>{loading ? 'Loading image…' : 'Choose a course map to begin'}</strong>
							{#if !loading}
								<button
									type="button"
									data-testid={`pane-choose-inline-${role}`}
									onclick={() => fileInput?.click()}
								>
									Choose image
								</button>
							{/if}
						</div>
					{/if}
				{/snippet}
			</ImageViewport>
			{#if popover}
				{@render popover({ view: vp.view, paneSize: { width: vp.size.width, height: vp.size.height } })}
			{/if}
		</div>
		{#if diagnostics}
			<aside class="diagnostics" aria-label={`${title} diagnostics`}>
				{@render diagnostics()}
			</aside>
		{/if}
	</div>

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
	.editor-pane {
		display: flex;
		flex-direction: column;
		min-height: 0;
		border: 1px solid #34343a;
		border-radius: 10px;
		background: #18181b;
		overflow: hidden;
	}

	.editor-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		padding: 0.75rem 0.9rem;
		border-bottom: 1px solid #34343a;
	}

	h2,
	p {
		margin: 0;
	}

	h2 {
		font-size: 1rem;
	}

	.editor-header p {
		margin-top: 0.15rem;
		color: #a1a1aa;
		font-size: 0.75rem;
	}

	.header-actions {
		display: flex;
		gap: 0.5rem;
	}

	button {
		min-height: 2.5rem;
		border: 1px solid #52525b;
		border-radius: 5px;
		background: #27272a;
		color: #f4f4f5;
		padding: 0.4rem 0.65rem;
		cursor: pointer;
		touch-action: manipulation;
	}

	button:disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}

	.editor-body {
		display: grid;
		grid-template-columns: 1fr;
		min-height: 640px;
	}

	.editor-body.with-tools {
		grid-template-columns: 18rem minmax(0, 1fr) 20rem;
	}

	.tools {
		padding: 0.8rem;
		border-right: 1px solid #34343a;
		background: #202024;
		overflow: auto;
	}

	.diagnostics {
		min-width: 0;
		padding: 0.8rem;
		border-left: 1px solid #34343a;
		background: #202024;
		overflow: auto;
	}

	.canvas-shell {
		position: relative;
		min-width: 0;
		min-height: 640px;
		background: #0d0d0f;
	}

	.canvas-shell.placing :global(.image-viewport) {
		cursor: crosshair;
	}

	.workspace {
		position: absolute;
		transform-origin: 0 0;
	}

	.source-image {
		display: block;
		width: 100%;
		height: 100%;
		user-select: none;
	}

	.empty-state {
		position: absolute;
		inset: 0;
		display: grid;
		place-content: center;
		justify-items: center;
		gap: 0.75rem;
		color: #a1a1aa;
	}

	.error {
		padding: 0.55rem 0.8rem;
		background: #450a0a;
		color: #fecaca;
		font-size: 0.85rem;
	}

	.file-input {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip: rect(0 0 0 0);
	}

	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		border: 0;
	}

	@media (max-width: 900px) {
		.editor-body.with-tools {
			grid-template-columns: 1fr;
		}

		.tools {
			border-right: 0;
			border-bottom: 1px solid #34343a;
		}

		.diagnostics {
			border-left: 0;
			border-top: 1px solid #34343a;
			max-height: 45vh;
		}

		.editor-body,
		.canvas-shell {
			min-height: 55vh;
		}
	}

	@media (max-width: 640px) {
		.editor-header {
			flex-wrap: wrap;
		}

		.header-actions {
			flex-wrap: wrap;
			width: 100%;
		}

		.header-actions button {
			flex: 1 1 auto;
		}

		.editor-body,
		.canvas-shell {
			min-height: 45vh;
		}
	}
</style>
