<script lang="ts">
	import { onDestroy } from 'svelte';
	import ImageViewport from '$lib/components/ImageViewport.svelte';
	import { clampPointToImageBounds, imageToScreen, pointInBounds, screenToImage } from '$lib/coords';
	import type { ScreenSpacePoint, ViewTransformState } from '$lib/coords';
	import { clickSlopPx, ViewportController } from '$lib/viewport.svelte';
	import {
		GOLDEN_HOLE_NUMBERS,
		addRibbonPoint,
		clearRibbonHole,
		clearRibbonSide,
		createEmptyGoldenRibbonHoles,
		createGoldenRibbonSet,
		isRibbonReady,
		moveRibbonPoint,
		parseGoldenRibbonSet,
		removeLastRibbonPoint,
		removeRibbonPoint,
		reverseRibbonSide,
		ribbonPolygon
	} from '$lib/ribbonGolden';
	import type {
		GoldenHoleNumber,
		GoldenRibbonHole,
		GoldenRibbonSource,
		RibbonPoint,
		RibbonSide
	} from '$lib/ribbonGolden';

	const ZOOM_LEVELS = [1, 1.5, 2, 3, 4] as const;
	const POINT_HIT_RADIUS_PX = 14;

	let sourceFile = $state<File | null>(null);
	let sourceUrl = $state<string | null>(null);
	let source = $state<GoldenRibbonSource | null>(null);
	let holes = $state<GoldenRibbonHole[]>(createEmptyGoldenRibbonHoles());
	let activeHoleNumber = $state<GoldenHoleNumber>(1);
	let activeSide = $state<RibbonSide>('left');
	let statusMessage = $state<string | null>(null);
	let errorMessage = $state<string | null>(null);
	let selected = $state<{ side: RibbonSide; index: number } | null>(null);
	let vp = new ViewportController();
	let fittedSourceKey = $state<string | null>(null);
	let pointGesture = $state<{
		side: RibbonSide;
		index: number;
		start: ScreenSpacePoint;
		transform: ViewTransformState;
		dragging: boolean;
		original: RibbonPoint;
	} | null>(null);
	let sourceInput = $state<HTMLInputElement | null>(null);
	let importInput = $state<HTMLInputElement | null>(null);

	let activeHole = $derived(
		holes.find((hole) => hole.number === activeHoleNumber) ?? holes[0]
	);

	let allReady = $derived(holes.every(isRibbonReady));
	let pointCount = $derived(
		holes.reduce((sum, hole) => sum + hole.leftEdge.length + hole.rightEdge.length, 0)
	);

	onDestroy(() => {
		if (sourceUrl) URL.revokeObjectURL(sourceUrl);
	});

	function hasAnyPoints(): boolean {
		return holes.some((hole) => hole.leftEdge.length > 0 || hole.rightEdge.length > 0);
	}

	function resetAnnotations(): void {
		holes = createEmptyGoldenRibbonHoles();
		activeHoleNumber = 1;
		activeSide = 'left';
		selected = null;
		pointGesture = null;
		statusMessage = null;
	}

	function setSourceFile(file: File): void {
		if (sourceUrl) URL.revokeObjectURL(sourceUrl);
		sourceFile = file;
		source = null;
		sourceUrl = URL.createObjectURL(file);
		errorMessage = null;
		statusMessage = `Loaded ${file.name}.`;
	}

	function handleSourceChange(event: Event): void {
		const input = event.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;

		if (hasAnyPoints() && !window.confirm('Replace the source image and clear all ribbon points?')) {
			input.value = '';
			return;
		}

		resetAnnotations();
		setSourceFile(file);
	}

	function handleImageLoad(event: Event): void {
		const image = event.currentTarget as HTMLImageElement;
		if (!sourceFile || image.naturalWidth <= 0 || image.naturalHeight <= 0) return;
		source = {
			fileName: sourceFile.name,
			widthPx: image.naturalWidth,
			heightPx: image.naturalHeight
		};
	}

	$effect(() => {
		const currentSource = source;
		if (!currentSource) {
			fittedSourceKey = null;
			vp.setFitTarget(null);
			return;
		}
		const sourceKey = `${currentSource.fileName}:${currentSource.widthPx}x${currentSource.heightPx}`;
		if (fittedSourceKey === sourceKey) return;
		fittedSourceKey = sourceKey;
		vp.setFitTarget({
			xPx: 0,
			yPx: 0,
			widthPx: currentSource.widthPx,
			heightPx: currentSource.heightPx
		});
		vp.fit();
	});

	function pointHitAt(pointer: ScreenSpacePoint): { side: RibbonSide; index: number } | null {
		let closest: { side: RibbonSide; index: number; distance: number } | null = null;
		for (const side of ['left', 'right'] as const) {
			for (const [index, point] of edgePoints(activeHole, side).entries()) {
				const screen = imageToScreen(point, vp.view);
				const distance = Math.hypot(pointer.x - screen.x, pointer.y - screen.y);
				if (distance <= POINT_HIT_RADIUS_PX && (!closest || distance < closest.distance)) {
					closest = { side, index, distance };
				}
			}
		}
		return closest ? { side: closest.side, index: closest.index } : null;
	}

	function claimPointer(pointer: ScreenSpacePoint, event: PointerEvent): boolean {
		if (!source) return false;
		const hit = pointHitAt(pointer);
		if (!hit) return false;
		const point = edgePoints(activeHole, hit.side)[hit.index];
		if (!point) return false;
		selected = { side: hit.side, index: hit.index };
		activeSide = hit.side;
		pointGesture = {
			side: hit.side,
			index: hit.index,
			start: pointer,
			transform: { ...vp.view },
			dragging: false,
			original: { ...point }
		};
		void event;
		return true;
	}

	function handlePointMove(pointer: ScreenSpacePoint, event: PointerEvent): void {
		const gesture = pointGesture;
		if (!gesture || !source) return;
		const dx = pointer.x - gesture.start.x;
		const dy = pointer.y - gesture.start.y;
		if (!gesture.dragging && Math.hypot(dx, dy) > clickSlopPx(event.pointerType)) gesture.dragging = true;
		if (!gesture.dragging) return;
		const point = clampPointToImageBounds(
			screenToImage(pointer, gesture.transform),
			source.widthPx,
			source.heightPx
		);
		holes = moveRibbonPoint(holes, activeHoleNumber, gesture.side, gesture.index, point);
	}

	function handlePointUp(pointer: ScreenSpacePoint): void {
		const gesture = pointGesture;
		pointGesture = null;
		if (!gesture || !gesture.dragging || !source) return;
		const point = clampPointToImageBounds(
			screenToImage(pointer, gesture.transform),
			source.widthPx,
			source.heightPx
		);
		holes = moveRibbonPoint(holes, activeHoleNumber, gesture.side, gesture.index, point);
	}

	function handlePointCancel(): void {
		const gesture = pointGesture;
		pointGesture = null;
		if (!gesture) return;
		holes = moveRibbonPoint(
			holes,
			activeHoleNumber,
			gesture.side,
			gesture.index,
			gesture.original
		);
	}

	function handleViewportClick(pointer: ScreenSpacePoint, event: PointerEvent): void {
		if (!source || (!event.ctrlKey && !event.metaKey)) return;
		const rawPoint = screenToImage(pointer, vp.view);
		if (!pointInBounds(rawPoint, source.widthPx, source.heightPx)) return;
		const point = clampPointToImageBounds(rawPoint, source.widthPx, source.heightPx);
		holes = addRibbonPoint(holes, activeHoleNumber, activeSide, point);
		const nextHole = holes.find((hole) => hole.number === activeHoleNumber)!;
		const points = activeSide === 'left' ? nextHole.leftEdge : nextHole.rightEdge;
		selected = { side: activeSide, index: points.length - 1 };
		statusMessage = null;
	}

	function setZoom(level: number): void {
		if (!source || !Number.isFinite(level) || level <= 0) return;
		const center = { x: vp.size.width / 2, y: vp.size.height / 2 };
		vp.zoomAtPointer(center, level / vp.view.zoom);
	}

	function handleRemoveLast(): void {
		holes = removeLastRibbonPoint(holes, activeHoleNumber, activeSide);
		selected = null;
		statusMessage = null;
	}

	function handleDeleteSelected(): void {
		if (!selected) return;
		holes = removeRibbonPoint(
			holes,
			activeHoleNumber,
			selected.side,
			selected.index
		);
		selected = null;
		statusMessage = null;
	}

	function handleClearSide(): void {
		holes = clearRibbonSide(holes, activeHoleNumber, activeSide);
		selected = null;
		statusMessage = null;
	}

	function handleClearHole(): void {
		holes = clearRibbonHole(holes, activeHoleNumber);
		selected = null;
		statusMessage = null;
	}

	function handleReverseSide(): void {
		holes = reverseRibbonSide(holes, activeHoleNumber, activeSide);
		selected = null;
		statusMessage = null;
	}

	function selectHole(number: GoldenHoleNumber): void {
		activeHoleNumber = number;
		selected = null;
		pointGesture = null;
	}

	function selectSide(side: RibbonSide): void {
		activeSide = side;
		selected = null;
		pointGesture = null;
	}

	function downloadJson(): void {
		if (!source) return;
		errorMessage = null;
		try {
			const golden = createGoldenRibbonSet(source, holes);
			const blob = new Blob([`${JSON.stringify(golden, null, 2)}\n`], {
				type: 'application/json'
			});
			const url = URL.createObjectURL(blob);
			const anchor = document.createElement('a');
			const base = source.fileName.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_-]+/g, '-');
			anchor.href = url;
			anchor.download = `${base || 'course'}-ribbon-golden.json`;
			anchor.click();
			URL.revokeObjectURL(url);
			statusMessage = allReady
				? 'Exported ribbon goldens for holes 1–3.'
				: 'Exported an incomplete draft. CV consumers should use only holes marked ready.';
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : 'Could not export ribbon golden JSON.';
		}
	}

	function loadImageElement(url: string): Promise<HTMLImageElement> {
		return new Promise((resolve, reject) => {
			const image = new Image();
			image.onload = () => resolve(image);
			image.onerror = () => reject(new Error('Could not decode the source image for PNG export.'));
			image.src = url;
		});
	}

	function drawRibbonOverlay(ctx: CanvasRenderingContext2D): void {
		for (const hole of holes) {
			if (isRibbonReady(hole)) {
				const polygon = ribbonPolygon(hole);
				ctx.beginPath();
				polygon.forEach((point, index) => {
					if (index === 0) ctx.moveTo(point.xPx, point.yPx);
					else ctx.lineTo(point.xPx, point.yPx);
				});
				ctx.closePath();
				ctx.fillStyle = 'rgba(59, 130, 246, 0.22)';
				ctx.fill();
			}

			for (const side of ['left', 'right'] as const) {
				const points = edgePoints(hole, side);
				if (points.length < 2) continue;
				ctx.beginPath();
				points.forEach((point, index) => {
					if (index === 0) ctx.moveTo(point.xPx, point.yPx);
					else ctx.lineTo(point.xPx, point.yPx);
				});
				ctx.strokeStyle = side === 'left' ? '#22d3ee' : '#e879f9';
				ctx.lineWidth = 2;
				ctx.stroke();

				ctx.fillStyle = side === 'left' ? '#22d3ee' : '#e879f9';
				for (const point of points) {
					ctx.beginPath();
					ctx.arc(point.xPx, point.yPx, 5, 0, Math.PI * 2);
					ctx.fill();
				}
			}
		}
	}

	async function downloadPng(): Promise<void> {
		if (!source || !sourceUrl) return;
		errorMessage = null;
		try {
			const image = await loadImageElement(sourceUrl);
			const canvas = document.createElement('canvas');
			canvas.width = source.widthPx;
			canvas.height = source.heightPx;
			const ctx = canvas.getContext('2d');
			if (!ctx) throw new Error('Could not create a canvas context for PNG export.');
			ctx.drawImage(image, 0, 0, source.widthPx, source.heightPx);
			drawRibbonOverlay(ctx);

			const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
			if (!blob) throw new Error('Could not encode the ribbon overlay as PNG.');

			const url = URL.createObjectURL(blob);
			const anchor = document.createElement('a');
			const base = source.fileName.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_-]+/g, '-');
			anchor.href = url;
			anchor.download = `${base || 'course'}-ribbon-golden.png`;
			anchor.click();
			URL.revokeObjectURL(url);
			statusMessage = allReady
				? 'Exported ribbon overlay PNG for holes 1–3.'
				: 'Exported an overlay PNG with a draft — some holes are missing a gutter.';
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : 'Could not export ribbon overlay PNG.';
		}
	}

	function handleImportChange(event: Event): void {
		const input = event.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		void importJson(file);
		input.value = '';
	}

	async function importJson(file: File): Promise<void> {
		errorMessage = null;
		try {
			if (!source) throw new Error('Load the matching course image before importing ribbon JSON.');
			const parsed = parseGoldenRibbonSet(JSON.parse(await file.text()));
			if (
				parsed.source.widthPx !== source.widthPx ||
				parsed.source.heightPx !== source.heightPx
			) {
				throw new Error(
					`Golden JSON is for ${parsed.source.widthPx}×${parsed.source.heightPx}, but the loaded image is ${source.widthPx}×${source.heightPx}.`
				);
			}
			holes = parsed.holes.map((hole) => ({
				number: hole.number,
				leftEdge: hole.leftEdge.map((point) => ({ ...point })),
				rightEdge: hole.rightEdge.map((point) => ({ ...point }))
			}));
			activeHoleNumber = 1;
			activeSide = 'left';
			selected = null;
			statusMessage = `Imported ${file.name}.`;
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : 'Could not import ribbon golden JSON.';
		}
	}

	function edgePoints(hole: GoldenRibbonHole, side: RibbonSide): readonly RibbonPoint[] {
		return side === 'left' ? hole.leftEdge : hole.rightEdge;
	}

	function polylinePoints(points: readonly RibbonPoint[]): string {
		return points.map((point) => `${point.xPx},${point.yPx}`).join(' ');
	}

	function polygonPoints(hole: GoldenRibbonHole): string {
		return polylinePoints(ribbonPolygon(hole));
	}

	function selectedLabel(): string | null {
		if (!selected) return null;
		const points = edgePoints(activeHole, selected.side);
		const point = points[selected.index];
		if (!point) return null;
		return `${selected.side === 'left' ? 'L' : 'R'}${selected.index + 1}: ${point.xPx.toFixed(1)}, ${point.yPx.toFixed(1)} px`;
	}
</script>

<svelte:head>
	<title>Ribbon Goldens | ChainSpot</title>
</svelte:head>

<main data-testid="ribbon-editor">
	<header class="page-header">
		<div>
			<h1>Ribbon golden editor</h1>
			<p>
				Draw the two fairway gutters for holes 1–3. Define both edges from tee → basket,
				looking down the hole. These are CV ground truth, not guesses.
			</p>
		</div>
		<div class="file-actions">
				<input
					bind:this={sourceInput}
					data-testid="ribbon-source-input"
					class="hidden-input"
				type="file"
				accept="image/*"
				onchange={handleSourceChange}
			/>
			<input
				bind:this={importInput}
				class="hidden-input"
				type="file"
				accept="application/json,.json"
				onchange={handleImportChange}
			/>
			<button type="button" onclick={() => sourceInput?.click()}>
				{source ? 'Replace image' : 'Load course image'}
			</button>
			<button type="button" disabled={!source} onclick={() => importInput?.click()}>Import JSON</button>
			<button type="button" disabled={!source || pointCount === 0} onclick={downloadJson}>
				Export JSON
			</button>
			<button type="button" disabled={!source || pointCount === 0} onclick={() => void downloadPng()}>
				Export PNG
			</button>
		</div>
	</header>

	{#if errorMessage}
		<p class="message error" role="alert">{errorMessage}</p>
	{/if}
	{#if statusMessage}
		<p class="message" role="status">{statusMessage}</p>
	{/if}

	{#if sourceUrl}
		<section class="editor-shell">
			<aside class="controls" aria-label="Ribbon editor controls">
				<div class="control-group">
					<h2>Hole</h2>
					<div class="segmented">
						{#each GOLDEN_HOLE_NUMBERS as holeNumber}
							{@const hole = holes.find((candidate) => candidate.number === holeNumber)!}
							<button
								type="button"
								class:active={activeHoleNumber === holeNumber}
								onclick={() => selectHole(holeNumber)}
							>
								{holeNumber}
								<span class:ready={isRibbonReady(hole)}>
									{isRibbonReady(hole) ? '✓' : '·'}
								</span>
							</button>
						{/each}
					</div>
				</div>

				<div class="control-group">
					<h2>Active gutter</h2>
					<div class="segmented">
						<button
							type="button"
							class="left-side"
							class:active={activeSide === 'left'}
							onclick={() => selectSide('left')}
						>
							Left
						</button>
						<button
							type="button"
							class="right-side"
							class:active={activeSide === 'right'}
							onclick={() => selectSide('right')}
						>
							Right
						</button>
					</div>
					<p class="counts" data-testid="ribbon-counts">
						L {activeHole.leftEdge.length} · R {activeHole.rightEdge.length}
					</p>
				</div>

				<div class="control-group">
					<h2>Zoom</h2>
					<div class="zoom-grid">
						{#each ZOOM_LEVELS as level}
								<button
									type="button"
									class:active={Math.abs(vp.view.zoom - level) < 0.001}
									onclick={() => setZoom(level)}
								>
								{Math.round(level * 100)}%
							</button>
						{/each}
					</div>
				</div>

				<div class="control-group">
					<h2>Edit</h2>
					<div class="button-stack">
						<button
							type="button"
							disabled={edgePoints(activeHole, activeSide).length === 0}
							onclick={handleRemoveLast}
						>
							Remove last point
						</button>
						<button type="button" disabled={!selected} onclick={handleDeleteSelected}>
							Delete selected
						</button>
						<button
							type="button"
							disabled={edgePoints(activeHole, activeSide).length < 2}
							onclick={handleReverseSide}
						>
							Reverse active gutter
						</button>
						<button
							type="button"
							disabled={edgePoints(activeHole, activeSide).length === 0}
							onclick={handleClearSide}
						>
							Clear active gutter
						</button>
						<button
							type="button"
							disabled={activeHole.leftEdge.length + activeHole.rightEdge.length === 0}
							onclick={handleClearHole}
						>
							Clear hole {activeHoleNumber}
						</button>
					</div>
				</div>

				<div class="control-group help">
					<h2>Workflow</h2>
					<ol>
						<li>Select Hole 1 and Left.</li>
						<li>Hold Ctrl/Cmd and click tee → basket along that gutter.</li>
						<li>Switch to Right and do the same.</li>
						<li>Drag any vertex to correct it.</li>
						<li>Repeat for holes 2 and 3, then export JSON.</li>
					</ol>
					<p>
						Left/right are defined while facing from tee toward basket. Point counts do not
						need to match; downstream code resamples each gutter by arc length.
					</p>
				</div>

				{#if selectedLabel()}
						<p class="selected-readout" data-testid="ribbon-selected">{selectedLabel()}</p>
				{/if}
			</aside>

			<section class="canvas-column">
				<div class="canvas-header">
					<div>
						<strong>{source?.fileName ?? 'Loading image…'}</strong>
						{#if source}
							<span>{source.widthPx} × {source.heightPx}px</span>
						{/if}
					</div>
					<div class:ready={allReady}>
						{allReady ? 'Holes 1–3 ready' : 'Draft — finish both gutters on each hole'}
					</div>
				</div>

					<div class="viewport">
						{#if source}
							{@const imageSource = source}
							<ImageViewport
								controller={vp}
								testid="ribbon-viewport"
								role="img"
								ariaLabel="Ribbon edge editor. Hold Ctrl or Command and click empty image space to add a point; drag vertices to move them. Drag empty canvas space to pan and use the mouse wheel to zoom."
								claimPointer={claimPointer}
								onClaimedPointerMove={handlePointMove}
								onClaimedPointerUp={handlePointUp}
								onClaimedPointerCancel={handlePointCancel}
								onViewportClick={handleViewportClick}
							>
								{#snippet content()}
									<div
										class="workspace"
										style={`width:${imageSource.widthPx}px;height:${imageSource.heightPx}px;transform:translate(${vp.view.panX}px,${vp.view.panY}px) scale(${vp.view.zoom})`}
									>
										<img
											src={sourceUrl}
											alt="Course source used to define ribbon ground truth"
											width={imageSource.widthPx}
											height={imageSource.heightPx}
											draggable="false"
										/>
										<svg
											class="overlay"
											viewBox={`0 0 ${imageSource.widthPx} ${imageSource.heightPx}`}
											preserveAspectRatio="none"
											role="application"
											aria-label="Ribbon vertices"
										>
											{#each holes as hole (hole.number)}
												{#if isRibbonReady(hole)}
													<polygon
														points={polygonPoints(hole)}
														class="ribbon-fill"
														class:inactive={hole.number !== activeHoleNumber}
													/>
												{/if}
												{#if hole.leftEdge.length >= 2}
													<polyline
														points={polylinePoints(hole.leftEdge)}
														class="gutter left"
														class:inactive={hole.number !== activeHoleNumber}
													/>
												{/if}
												{#if hole.rightEdge.length >= 2}
													<polyline
														points={polylinePoints(hole.rightEdge)}
														class="gutter right"
														class:inactive={hole.number !== activeHoleNumber}
													/>
												{/if}
											{/each}

											{#each activeHole.leftEdge as point, index}
												<circle
													cx={point.xPx}
													cy={point.yPx}
													r={selected?.side === 'left' && selected.index === index ? 7 / vp.view.zoom : 5 / vp.view.zoom}
													class="vertex left"
													class:selected={selected?.side === 'left' && selected.index === index}
												/>
											{/each}
											{#each activeHole.rightEdge as point, index}
												<circle
													cx={point.xPx}
													cy={point.yPx}
													r={selected?.side === 'right' && selected.index === index ? 7 / vp.view.zoom : 5 / vp.view.zoom}
													class="vertex right"
													class:selected={selected?.side === 'right' && selected.index === index}
												/>
											{/each}
										</svg>
									</div>
								{/snippet}
							</ImageViewport>
						{:else}
							<div class="image-loading">Reading image dimensions…</div>
						{/if}
					</div>
			</section>
		</section>
	{:else}
		<section class="empty-state">
			<h2>Load the course screenshot first</h2>
			<p>
				This tool intentionally starts from the exact source raster that OpenCV sees. The JSON
				records source-image pixel coordinates so the golden edges line up with CV input exactly.
			</p>
			<button type="button" onclick={() => sourceInput?.click()}>Choose image</button>
		</section>
	{/if}

	{#if sourceUrl && !source}
		<img class="dimension-probe" src={sourceUrl} alt="" onload={handleImageLoad} />
	{/if}
</main>

<style>
	main {
		padding: 1rem;
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		min-height: calc(100vh - 64px);
		box-sizing: border-box;
	}

	h1,
	h2,
	p {
		margin-top: 0;
	}

	h1 {
		font-size: 1.45rem;
		margin-bottom: 0.25rem;
	}

	h2 {
		font-size: 0.85rem;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: #a1a1aa;
		margin-bottom: 0.5rem;
	}

	button {
		border: 1px solid #3f3f46;
		background: #27272a;
		color: #f4f4f5;
		border-radius: 5px;
		padding: 0.42rem 0.65rem;
		cursor: pointer;
	}

	button:hover:not(:disabled) {
		background: #3f3f46;
	}

	button:disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}

	button.active {
		border-color: #93c5fd;
		box-shadow: inset 0 0 0 1px #93c5fd;
		background: #1e3a5f;
	}

	.page-header,
	.canvas-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 1rem;
		flex-wrap: wrap;
	}

	.page-header p {
		color: #a1a1aa;
		margin-bottom: 0;
		max-width: 780px;
		font-size: 0.9rem;
	}

	.file-actions,
	.segmented,
	.zoom-grid {
		display: flex;
		gap: 0.4rem;
		flex-wrap: wrap;
	}

	.hidden-input,
	.dimension-probe {
		display: none;
	}

	.message {
		padding: 0.55rem 0.75rem;
		border: 1px solid #3f3f46;
		border-radius: 5px;
		background: #18181b;
		margin: 0;
	}

	.message.error {
		border-color: #b91c1c;
		color: #fecaca;
	}

	.editor-shell {
		display: grid;
		grid-template-columns: 230px minmax(0, 1fr);
		gap: 0.75rem;
		min-height: 0;
	}

	.controls,
	.canvas-column {
		border: 1px solid #27272a;
		border-radius: 6px;
		background: #18181b;
	}

	.controls {
		padding: 0.75rem;
		display: flex;
		flex-direction: column;
		gap: 0.9rem;
		align-self: start;
	}

	.control-group {
		border-bottom: 1px solid #27272a;
		padding-bottom: 0.8rem;
	}

	.control-group:last-child {
		border-bottom: 0;
		padding-bottom: 0;
	}

	.segmented button {
		min-width: 48px;
	}

	.segmented button span {
		margin-left: 0.25rem;
		color: #71717a;
	}

	.segmented button span.ready,
	.ready {
		color: #86efac;
	}

	.left-side {
		color: #67e8f9;
	}

	.right-side {
		color: #f0abfc;
	}

	.counts,
	.selected-readout {
		color: #a1a1aa;
		font-size: 0.8rem;
		margin: 0.5rem 0 0;
	}

	.zoom-grid button {
		font-size: 0.78rem;
		padding: 0.3rem 0.45rem;
	}

	.button-stack {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
	}

	.help {
		color: #a1a1aa;
		font-size: 0.78rem;
		line-height: 1.4;
	}

	.help ol {
		padding-left: 1.15rem;
		margin: 0 0 0.6rem;
	}

	.help p {
		margin-bottom: 0;
	}

	.canvas-column {
		min-width: 0;
		overflow: hidden;
	}

	.canvas-header {
		padding: 0.6rem 0.75rem;
		border-bottom: 1px solid #27272a;
		font-size: 0.82rem;
	}

	.canvas-header span {
		color: #71717a;
		margin-left: 0.6rem;
	}

	.viewport {
		overflow: hidden;
		height: calc(100vh - 205px);
		min-height: 480px;
		background: #09090b;
	}

	.workspace {
		position: absolute;
		inset: 0 auto auto 0;
		transform-origin: top left;
		user-select: none;
		will-change: transform;
	}

	.workspace img,
	.overlay {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
	}

	.workspace img {
		pointer-events: none;
	}

	.overlay {
		touch-action: none;
		cursor: crosshair;
	}

	.ribbon-fill {
		fill: rgba(59, 130, 246, 0.22);
		stroke: none;
		pointer-events: none;
	}

	.ribbon-fill.inactive {
		fill: rgba(113, 113, 122, 0.09);
	}

	.gutter {
		fill: none;
		stroke-width: 2;
		vector-effect: non-scaling-stroke;
		pointer-events: none;
	}

	.gutter.left {
		stroke: #22d3ee;
	}

	.gutter.right {
		stroke: #e879f9;
	}

	.gutter.inactive {
		stroke: #71717a;
		opacity: 0.5;
	}

	.vertex {
		stroke: #09090b;
		stroke-width: 1.5;
		vector-effect: non-scaling-stroke;
		cursor: grab;
	}

	.vertex:active {
		cursor: grabbing;
	}

	.vertex.left {
		fill: #22d3ee;
	}

	.vertex.right {
		fill: #e879f9;
	}

	.vertex.selected {
		stroke: #ffffff;
		stroke-width: 2.5;
	}

	.empty-state,
	.image-loading {
		border: 1px dashed #52525b;
		border-radius: 8px;
		padding: 2rem;
		text-align: center;
		color: #a1a1aa;
	}

	.empty-state h2 {
		color: #f4f4f5;
		text-transform: none;
		letter-spacing: normal;
		font-size: 1rem;
	}

	@media (max-width: 900px) {
		.editor-shell {
			grid-template-columns: 1fr;
		}

		.controls {
			display: grid;
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}

		.viewport {
			height: 70vh;
		}
	}
</style>
