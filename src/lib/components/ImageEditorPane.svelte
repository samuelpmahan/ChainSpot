<script lang="ts">
	import { tick } from 'svelte';
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
		intakeImageFile,
		isSupportedMimeType
	} from '$lib/imageIntake';
	import type { DecodeImageFile, DecodedImage } from '$lib/imageIntake';
	import { detectSingleImageCrop, renderCroppedImage } from '$lib/singleImageAutoCrop';
	import { dialogKeyboard } from '$lib/focusManagement';
	import type { CropConfidence } from '$lib/stitch/autoCrop';
	import type { CropInsets } from '$lib/stitch/geometry';

	interface OverlayContext {
		image: ImageAsset;
		zoom: number;
	}

	interface ViewportFocusRequest {
		key: string;
		point: { xPx: number; yPx: number };
		/**
		 * Optional zoom multiplier. If omitted or null, focus pans to the point
		 * while preserving the current zoom level (used for hole badge navigation).
		 * If present, focus applies the multiplier to the fit zoom (legacy behavior
		 * for zoom+pan requests).
		 */
		zoomMultiplier?: number | null;
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

	interface CropReviewState {
		file: File;
		image: HTMLImageElement;
		widthPx: number;
		heightPx: number;
		mimeType: string;
		topPx: number;
		bottomPx: number;
		confidence: CropConfidence;
	}

	/** A pending autocrop proposal, awaiting the user's confirm-or-override decision. */
	let cropReview = $state<CropReviewState | null>(null);
	let cropReviewError = $state<string | null>(null);
	let cropReviewApplying = $state(false);
	let cropReviewPreviewUrl = $state<string | null>(null);
	let cropReviewApplyButton = $state<HTMLButtonElement | null>(null);
	let cropReviewFocusRestore: HTMLElement | null = null;
	let appliedFocusKey: string | null = null;
	/**
	 * True for the brief window a `focusRequest` jump is animating, so
	 * `.workspace` picks up a transition on its transform ONLY for that
	 * programmatic jump — ordinary wheel-zoom/drag-pan stay perfectly instant,
	 * matching every other pane using this component. Cleared the moment the
	 * user starts their own gesture (`clearFocusing` on pointerdown/wheel) so
	 * an in-flight jump animation never fights live input.
	 */
	let focusing = $state(false);
	let focusingTimer: ReturnType<typeof setTimeout> | null = null;
	/** Matches the CSS transition duration below plus a small buffer. */
	const FOCUS_TRANSITION_MS = 650;

	function clearFocusing(): void {
		focusing = false;
		if (focusingTimer !== null) {
			clearTimeout(focusingTimer);
			focusingTimer = null;
		}
	}

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
		focusing = true;
		if (focusingTimer !== null) clearTimeout(focusingTimer);
		focusingTimer = setTimeout(() => { focusing = false; focusingTimer = null; }, FOCUS_TRANSITION_MS);
		// If zoomMultiplier is null/undefined, pan to point while preserving zoom
		// (for hole badge navigation). Otherwise, apply the zoom multiplier.
		if (request.zoomMultiplier === null || request.zoomMultiplier === undefined) {
			vp.panToPoint(request.point);
		} else {
			vp.focusOnPoint(request.point, request.zoomMultiplier);
		}
		appliedFocusKey = requestKey;
	});

	function handleViewportClick(pointer: { x: number; y: number }, event: PointerEvent): void {
		const image = currentImage();
		if (!image || !onPlacement) return;
		const coordinates = screenToImage(pointer, vp.view);
		if (!pointInBounds(coordinates, image.widthPx, image.heightPx)) return;
		onPlacement(coordinates, { altKey: event.altKey });
	}

	$effect(() => {
		if (!cropReview) {
			cropReviewPreviewUrl = null;
			return;
		}
		const url = URL.createObjectURL(cropReview.file);
		cropReviewPreviewUrl = url;
		return () => URL.revokeObjectURL(url);
	});

	$effect(() => {
		if (!cropReview) return;
		void tick().then(() => cropReviewApplyButton?.focus());
	});

	/**
	 * `preDecoded` lets a caller that has already decoded `file` (crop
	 * detection, or the original image reused by "Upload without cropping")
	 * skip paying for a second browser decode of the exact same bytes.
	 */
	async function runIntake(file: File, preDecoded?: DecodedImage): Promise<void> {
		loading = true;
		error = null;
		try {
			const result = await intakeImageFile({
				editor,
				role,
				file,
				decode: preDecoded ? async () => preDecoded : decode,
				confirmDiscard
			});
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

	/** Rounds and bounds a manually-edited crop field to a sane pixel range. */
	function clampCropField(value: number, heightPx: number): number {
		if (!Number.isFinite(value)) return 0;
		return Math.max(0, Math.min(Math.round(value), Math.max(0, heightPx - 1)));
	}

	function handleCropTopInput(event: Event): void {
		if (!cropReview) return;
		const value = (event.currentTarget as HTMLInputElement).valueAsNumber;
		cropReview.topPx = clampCropField(value, cropReview.heightPx);
	}

	function handleCropBottomInput(event: Event): void {
		if (!cropReview) return;
		const value = (event.currentTarget as HTMLInputElement).valueAsNumber;
		cropReview.bottomPx = clampCropField(value, cropReview.heightPx);
	}

	async function applyCropReview(): Promise<void> {
		if (!cropReview) return;
		const review = cropReview;
		cropReviewApplying = true;
		cropReviewError = null;
		try {
			const insets: CropInsets = {
				topPx: review.topPx,
				rightPx: 0,
				bottomPx: review.bottomPx,
				leftPx: 0
			};
			const blob = await renderCroppedImage(
				review.image,
				review.widthPx,
				review.heightPx,
				insets,
				review.mimeType
			);
			const croppedFile = new File([blob], review.file.name, { type: review.mimeType });
			closeCropReview();
			await runIntake(croppedFile);
		} catch (err) {
			cropReviewApplying = false;
			cropReviewError = err instanceof Error ? err.message : 'Could not crop the image.';
		}
	}

	async function skipCropReview(): Promise<void> {
		// Guards against Escape (routed here by `dialogKeyboard`, which bypasses
		// the "Upload without cropping" button's own `disabled`) racing an
		// in-flight "Apply crop": both paths end in `runIntake`, and running them
		// concurrently would leave the pane's final image nondeterministic.
		if (!cropReview || cropReviewApplying) return;
		const review = cropReview;
		closeCropReview();
		await runIntake(review.file, { image: review.image, widthPx: review.widthPx, heightPx: review.heightPx });
	}

	/** Clears the review state and restores focus to whatever triggered it, mirroring the app's other confirmation dialogs. */
	function closeCropReview(): void {
		cropReview = null;
		cropReviewError = null;
		cropReviewApplying = false;
		const target = cropReviewFocusRestore?.isConnected ? cropReviewFocusRestore : null;
		cropReviewFocusRestore = null;
		if (target) void tick().then(() => target.focus());
	}

	/**
	 * Hands the pane's own `ViewportController` to the mounting page. Added for
	 * Annotate Course's keyboard-first review flow, which needs to drive the
	 * camera directly (WASD pan, Q/E zoom, undo-restored view) rather than only
	 * through one-shot `focusRequest`s. The controller is created once per pane
	 * instance and never replaced, so callers may hold the reference.
	 */
	export function getViewportController(): ViewportController {
		return vp;
	}

	async function handleFileChange(event: Event): Promise<void> {
		const input = event.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		input.value = '';
		if (!file) return;

		let decoded: DecodedImage | null = null;
		if (isSupportedMimeType(file.type)) {
			loading = true;
			error = null;
			try {
				decoded = await decode(file);
			} catch {
				decoded = null;
			}
			if (decoded) {
				// Detection is a best-effort convenience on top of the ordinary upload,
				// never a gate on it: a canvas/analysis failure here (unavailable 2D
				// context, an oversized raster) must fall through to the normal,
				// uncropped intake below rather than breaking the upload outright.
				let proposal: ReturnType<typeof detectSingleImageCrop> | null = null;
				try {
					proposal = detectSingleImageCrop(decoded.image);
				} catch {
					proposal = null;
				}
				if (proposal?.insets && (proposal.insets.topPx > 0 || proposal.insets.bottomPx > 0)) {
					cropReviewFocusRestore =
						document.activeElement instanceof HTMLElement ? document.activeElement : null;
					cropReview = {
						file,
						image: decoded.image,
						widthPx: decoded.widthPx,
						heightPx: decoded.heightPx,
						mimeType: file.type,
						topPx: proposal.insets.topPx,
						bottomPx: proposal.insets.bottomPx,
						confidence: proposal.confidence
					};
					loading = false;
					return;
				}
			}
			loading = false;
		}
		// `decoded` (when present) is this exact `file`'s already-decoded image,
		// reused so the ordinary no-crop-proposed path never decodes it twice.
		await runIntake(file, decoded ?? undefined);
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

		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="canvas-shell"
			class:placing={Boolean(onPlacement)}
			onpointerdown={clearFocusing}
			onwheel={clearFocusing}
		>
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
							class:focusing
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

{#if cropReview}
	<div class="dialog-backdrop">
		<div
			class="dialog crop-dialog"
			role="dialog"
			aria-modal="true"
			aria-label="Crop screenshot chrome?"
			data-testid="crop-review-dialog"
			use:dialogKeyboard={() => skipCropReview()}
		>
			<h2>Crop screenshot chrome?</h2>
			<p>
				ChainSpot detected a status bar and/or navigation bar at the top and bottom of this image.
				{#if cropReview.confidence === 'low'}
					Confidence is low, so check the preview before applying.
				{/if}
				Adjust the amounts below, or upload the image as-is.
			</p>
			{#if cropReviewPreviewUrl}
				<div class="crop-preview" data-testid="crop-review-preview">
					<img src={cropReviewPreviewUrl} alt="" />
					<div
						class="crop-band crop-band-top"
						style={`height:${Math.min(100, (cropReview.topPx / cropReview.heightPx) * 100)}%`}
					></div>
					<div
						class="crop-band crop-band-bottom"
						style={`height:${Math.min(100, (cropReview.bottomPx / cropReview.heightPx) * 100)}%`}
					></div>
				</div>
			{/if}
			<div class="crop-fields">
				<label>
					<span>Top (px)</span>
					<input
						type="number"
						min="0"
						max={cropReview.heightPx - 1}
						step="1"
						data-testid="crop-review-top"
						value={cropReview.topPx}
						oninput={handleCropTopInput}
					/>
				</label>
				<label>
					<span>Bottom (px)</span>
					<input
						type="number"
						min="0"
						max={cropReview.heightPx - 1}
						step="1"
						data-testid="crop-review-bottom"
						value={cropReview.bottomPx}
						oninput={handleCropBottomInput}
					/>
				</label>
			</div>
			{#if cropReviewError}
				<p class="error" role="alert">{cropReviewError}</p>
			{/if}
			<div class="dialog-actions">
				<button
					type="button"
					data-testid="crop-review-skip"
					disabled={cropReviewApplying}
					onclick={skipCropReview}
				>
					Upload without cropping
				</button>
				<button
					type="button"
					class="primary"
					data-testid="crop-review-apply"
					bind:this={cropReviewApplyButton}
					disabled={cropReviewApplying}
					onclick={applyCropReview}
				>
					{cropReviewApplying ? 'Cropping…' : 'Apply crop'}
				</button>
			</div>
		</div>
	</div>
{/if}

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

	/** Only a programmatic focus jump (`focusRequest`) transitions; interactive wheel-zoom/drag-pan write `vp.view` every frame and must stay instant. */
	.workspace.focusing {
		transition: transform 0.6s cubic-bezier(0.4, 0.7, 0.25, 1);
	}

	@media (prefers-reduced-motion: reduce) {
		.workspace.focusing {
			transition: none;
		}
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

	.dialog-backdrop {
		position: fixed;
		inset: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		background: rgba(0, 0, 0, 0.6);
		z-index: 50;
	}

	.dialog {
		max-width: 28rem;
		padding: 1rem;
		border: 1px solid #3f3f46;
		border-radius: 8px;
		background: #1e1e24;
		color: #e4e4e7;
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
		max-height: 90vh;
		overflow-y: auto;
	}

	.dialog h2 {
		margin: 0;
		font-size: 1rem;
	}

	.dialog p {
		margin: 0;
		font-size: 0.85rem;
		color: #a1a1aa;
		line-height: 1.5;
	}

	.crop-dialog {
		max-width: 24rem;
	}

	.crop-preview {
		position: relative;
		align-self: center;
		display: inline-block;
		max-width: 100%;
		border: 1px solid #34343a;
		border-radius: 6px;
		overflow: hidden;
		line-height: 0;
	}

	.crop-preview img {
		display: block;
		width: auto;
		height: auto;
		max-width: 100%;
		max-height: 40vh;
	}

	.crop-band {
		position: absolute;
		left: 0;
		right: 0;
		background: repeating-linear-gradient(
			135deg,
			rgba(0, 0, 0, 0.65),
			rgba(0, 0, 0, 0.65) 6px,
			rgba(0, 0, 0, 0.45) 6px,
			rgba(0, 0, 0, 0.45) 12px
		);
		pointer-events: none;
	}

	.crop-band-top {
		top: 0;
	}

	.crop-band-bottom {
		bottom: 0;
	}

	.crop-fields {
		display: flex;
		gap: 0.75rem;
	}

	.crop-fields label {
		flex: 1 1 0;
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		font-size: 0.8rem;
		color: #d4d4d8;
	}

	.crop-fields input {
		min-height: 2.25rem;
		border: 1px solid #52525b;
		border-radius: 5px;
		background: #27272a;
		color: #f4f4f5;
		padding: 0.3rem 0.5rem;
	}

	.dialog-actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.6rem;
	}

	.dialog-actions button.primary {
		border-color: #2563eb;
		background: #2563eb;
		color: #fff;
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
