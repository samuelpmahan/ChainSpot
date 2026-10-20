<!--
	Correct Course: review and fix a course the CV read, on ONE image surface.

	A `chainspot.course-geometry@1` file and the screenshot it was read from load into a ProjectEditor. The holes draw
	as corridors (tee -> bends -> basket, `corridorWidthPx` wide), coloured by the file's evidence. Every edit is one
	gesture through ImageEditorPane -> ImageViewport's claim protocol (no pointer listeners of its own):
	  - drag a bend, tee or basket: moves it;
	  - drag from a corridor leg: adds a bend there and places it (one drag); a click on a leg adds it at the click;
	  - double-click a bend, or click it and press Delete: removes it.
	Each gesture is one ProjectEditor history step (Ctrl/Cmd+Z, Ctrl+Shift+Z / Ctrl+Y). N / P jump to the next /
	previous hole whose evidence asks for a look. Save writes the project through `saveProject` (.chainspot.zip);
	opening that bundle restores the holes (evidence lives only in the geometry file: open it alongside to see colours).
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import ImageEditorPane from '$lib/components/ImageEditorPane.svelte';
	import CourseCorrectionLayer from '$lib/components/CourseCorrectionLayer.svelte';
	import { ProjectEditor } from '$lib/domain/editor';
	import { findImageByRole } from '$lib/domain/project';
	import type { AnnotatedHole } from '$lib/domain/project';
	import { parseCourseGeometry } from '$lib/import/courseGeometry';
	import type { CourseGeometry, HoleEvidence, RouteAlternative } from '$lib/import/courseGeometry';
	import { clampPointToImageBounds, imageToScreen, screenToImage } from '$lib/coords';
	import type { ScreenSpacePoint, ViewTransformState } from '$lib/coords';
	import { clickSlopPx } from '$lib/viewport.svelte';
	import type { ViewportController } from '$lib/viewport.svelte';
	import { decodeImageFile, isSupportedMimeType, readFileBytes, sha256Hex } from '$lib/imageIntake';
	import { readProjectBundle, saveProject } from '$lib/persistence';
	import { setBasket, setTee } from '$lib/holeAnnotation';
	import { historyShortcut, isDeleteKey } from '$lib/pointListShortcuts';
	import { isEditableTarget } from '$lib/pointSelection';
	import { isModalOpen } from '$lib/focusManagement';
	import {
		DOUBLE_CLICK_MS,
		STATUS_COLOURS,
		STATUS_LABELS,
		addBendOnLeg,
		adoptAlternative,
		alternativeCenterline,
		deriveSeparation,
		hitTestAlternative,
		hitTestCourse,
		holeBounds,
		holeEdited,
		moveHandle,
		removeBend,
		reviewOrder,
		reviewQueue,
		reviewReason,
		reviewStatus,
		roundPoint,
		stepReviewQueue
	} from '$lib/courseCorrection';
	import type { CorrectionHit, CorrectionSelection, ReviewStatus } from '$lib/courseCorrection';

	let editor = $state(new ProjectEditor());
	let refreshCount = $state(0);
	let holes = $state<AnnotatedHole[]>([]);
	let draft = $state<AnnotatedHole[] | null>(null);
	let geometry = $state<CourseGeometry | null>(null);
	let selection = $state<CorrectionSelection | null>(null);
	let focusRequest = $state<{ key: string; point: { xPx: number; yPx: number }; zoomMultiplier: number } | null>(null);
	let message = $state<string | null>(null);
	let errorMessage = $state<string | null>(null);
	let busy = $state(false);
	let canUndo = $state(false);
	let canRedo = $state(false);
	let fileInput = $state<HTMLInputElement | null>(null);
	let pane = $state<{ getViewportController: () => ViewportController } | null>(null);
	let focusSeq = 0;

	let shown = $derived(draft ?? holes);
	let sourceImage = $derived.by(() => {
		void refreshCount;
		return findImageByRole(editor.state.images, 'source-overview') ?? null;
	});
	let evidenceByHole = $derived(new Map<string, HoleEvidence>((geometry?.evidence ?? []).map((e) => [e.holeId, e])));
	let originalById = $derived(new Map<string, AnnotatedHole>((geometry?.holes ?? []).map((h) => [h.id, h])));
	let ordered = $derived(reviewOrder(holes, evidenceByHole, originalById));
	let queue = $derived(reviewQueue(holes, evidenceByHole, originalById));
	let selectedHole = $derived(selection ? (shown.find((hole) => hole.id === selection!.holeId) ?? null) : null);
	let selectedAlternatives = $derived<readonly RouteAlternative[]>(selectedHole ? (evidenceByHole.get(selectedHole.id)?.alternatives ?? []) : []);
	const LEGEND: ReviewStatus[] = ['resolved', 'straight', 'partial', 'unresolved', 'none'];

	function refresh(): void {
		holes = editor.state.holes;
		canUndo = editor.canUndo;
		canRedo = editor.canRedo;
		refreshCount += 1;
		// A selection can outlive its target after undo/redo (a removed bend); keep the hole, drop the stale handle.
		if (selection) {
			const hole = holes.find((h) => h.id === selection!.holeId);
			if (!hole) selection = null;
			else if (selection.handle?.kind === 'bend' && selection.handle.index >= hole.corridorBends.length) selection = { holeId: hole.id };
		}
	}

	function commit(next: AnnotatedHole[]): void {
		draft = null;
		try {
			editor.setHoles(next);
			errorMessage = null;
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : String(error);
		}
		refresh();
	}

	// ---------------------------------------------------------------------------
	// Gestures (claim protocol of the one surface)
	// ---------------------------------------------------------------------------

	interface Press {
		hit: CorrectionHit;
		start: ScreenSpacePoint;
		pointerType: string;
		drag: { base: AnnotatedHole[]; holeId: string; handle: NonNullable<CorrectionSelection['handle']> } | null;
	}
	let press: Press | null = null;
	let lastBendClick: { holeId: string; index: number; time: number } | null = null;

	function toSource(pointer: ScreenSpacePoint, view: ViewTransformState) {
		const image = sourceImage!;
		return roundPoint(clampPointToImageBounds(screenToImage(pointer, view), image.widthPx, image.heightPx));
	}

	function claimPointer(pointer: ScreenSpacePoint, event: PointerEvent, view: ViewTransformState): boolean {
		if (!sourceImage || busy) return false;
		const hit = hitTestCourse(holes, pointer, view, selection?.holeId ?? null);
		if (!hit) return false;
		press = { hit, start: pointer, pointerType: event.pointerType, drag: null };
		return true;
	}

	function onClaimedPointerMove(pointer: ScreenSpacePoint, _event: PointerEvent, view: ViewTransformState): void {
		if (!press) return;
		if (!press.drag) {
			if (Math.hypot(pointer.x - press.start.x, pointer.y - press.start.y) <= clickSlopPx(press.pointerType)) return;
			const hit = press.hit;
			if (hit.kind === 'leg') {
				press.drag = { base: addBendOnLeg(holes, hit.holeId, hit.legIndex, roundPoint(hit.point)), holeId: hit.holeId, handle: { kind: 'bend', index: hit.legIndex } };
			} else if (hit.kind === 'bend') {
				press.drag = { base: holes, holeId: hit.holeId, handle: { kind: 'bend', index: hit.index } };
			} else {
				press.drag = { base: holes, holeId: hit.holeId, handle: { kind: hit.kind } };
			}
			selection = { holeId: press.drag.holeId, handle: press.drag.handle };
		}
		draft = moveHandle(press.drag.base, press.drag.holeId, press.drag.handle, toSource(pointer, view));
	}

	function onClaimedPointerUp(pointer: ScreenSpacePoint, event: PointerEvent, view: ViewTransformState): void {
		const active = press;
		press = null;
		if (!active) return;
		if (active.drag) {
			commit(moveHandle(active.drag.base, active.drag.holeId, active.drag.handle, toSource(pointer, view)));
			return;
		}
		const hit = active.hit;
		if (hit.kind === 'leg') {
			commit(addBendOnLeg(holes, hit.holeId, hit.legIndex, toSource(pointer, view)));
			selection = { holeId: hit.holeId, handle: { kind: 'bend', index: hit.legIndex } };
			lastBendClick = null;
			return;
		}
		if (hit.kind === 'bend') {
			const now = event.timeStamp || performance.now();
			const repeat = lastBendClick && lastBendClick.holeId === hit.holeId && lastBendClick.index === hit.index && now - lastBendClick.time <= DOUBLE_CLICK_MS;
			if (repeat) {
				lastBendClick = null;
				selection = { holeId: hit.holeId };
				commit(removeBend(holes, hit.holeId, hit.index));
				return;
			}
			lastBendClick = { holeId: hit.holeId, index: hit.index, time: now };
			selection = { holeId: hit.holeId, handle: { kind: 'bend', index: hit.index } };
			return;
		}
		lastBendClick = null;
		selection = { holeId: hit.holeId, handle: { kind: hit.kind } };
	}

	function onClaimedPointerCancel(): void {
		press = null;
		draft = null;
	}

	function adopt(index: number): void {
		const hole = selectedHole;
		const alternative = selectedAlternatives[index];
		if (!hole || !alternative) return;
		commit(adoptAlternative(holes, hole.id, alternative));
		selection = { holeId: hole.id };
		message = `Hole ${hole.number}: adopted alternative ${index + 1} (${alternative.ruleSets.join(', ') || 'no rule set named'}).`;
	}

	/**
	 * A background click (unclaimed, so a drag here still pans): adopts the selected hole's alternative under the
	 * pointer; else places a missing tee or basket on the selected hole; else clears the selection.
	 */
	function onPlacement(point: { xPx: number; yPx: number }): void {
		lastBendClick = null;
		const hole = selectedHole;
		const vp = pane?.getViewportController();
		if (hole && vp && selectedAlternatives.length > 0) {
			const index = hitTestAlternative(hole, selectedAlternatives, imageToScreen(point, vp.view), vp.view);
			if (index !== null) {
				adopt(index);
				return;
			}
		}
		if (hole && !hole.tee) {
			commit(setTee(holes, hole.id, roundPoint(point)));
			return;
		}
		if (hole && !hole.basket) {
			commit(setBasket(holes, hole.id, roundPoint(point)));
			return;
		}
		selection = null;
	}

	// ---------------------------------------------------------------------------
	// Review walk
	// ---------------------------------------------------------------------------

	function focusHole(holeId: string): void {
		const hole = holes.find((h) => h.id === holeId);
		if (!hole) return;
		selection = { holeId };
		const bounds = holeBounds(hole);
		const vp = pane?.getViewportController();
		if (!bounds || !vp) return;
		const fitZoom = vp.fitView.zoom > 0 ? vp.fitView.zoom : 1;
		const frame = Math.min(vp.size.width / bounds.widthPx, vp.size.height / bounds.heightPx) * 0.6;
		const zoomMultiplier = Math.min(8, Math.max(1, frame / fitZoom));
		focusSeq += 1;
		focusRequest = {
			key: `${holeId}:${focusSeq}`,
			point: { xPx: bounds.xPx + bounds.widthPx / 2, yPx: bounds.yPx + bounds.heightPx / 2 },
			zoomMultiplier
		};
	}

	function stepReview(step: 1 | -1): void {
		const next = stepReviewQueue(queue, selection?.holeId ?? null, step);
		if (next) focusHole(next);
		else message = 'No hole needs review.';
	}

	function undo(): void {
		if (editor.undo()) refresh();
	}

	function redo(): void {
		if (editor.redo()) refresh();
	}

	function onKeyDown(event: KeyboardEvent): void {
		if (isEditableTarget(event.target) || isModalOpen()) return;
		const history = historyShortcut(event);
		if (history) {
			event.preventDefault();
			if (history === 'undo') undo();
			else redo();
			return;
		}
		if (event.ctrlKey || event.metaKey || event.altKey) return;
		if (event.key === 'Escape') {
			if (press?.drag) {
				press = null;
				draft = null;
			} else {
				selection = null;
			}
			return;
		}
		if (isDeleteKey(event) && selection?.handle?.kind === 'bend') {
			event.preventDefault();
			const { holeId } = selection;
			const index = selection.handle.index;
			selection = { holeId };
			commit(removeBend(holes, holeId, index));
			return;
		}
		const key = event.key.toLowerCase();
		if (key === 'n' || key === 'p') {
			event.preventDefault();
			stepReview(key === 'n' ? 1 : -1);
		}
	}

	onMount(() => {
		window.addEventListener('keydown', onKeyDown);
		return () => window.removeEventListener('keydown', onKeyDown);
	});

	// ---------------------------------------------------------------------------
	// Open / save
	// ---------------------------------------------------------------------------

	function replaceEditor(next: ProjectEditor, nextGeometry: CourseGeometry | null, note: string): void {
		editor = next;
		geometry = nextGeometry;
		selection = null;
		draft = null;
		press = null;
		errorMessage = null;
		message = note;
		refresh();
	}

	async function openGeometryWithScreenshot(json: File, image: File): Promise<void> {
		const parsed = parseCourseGeometry(await json.text());
		if (!parsed.ok) {
			errorMessage = `${json.name}: ${parsed.error.message}`;
			return;
		}
		const bytes = await readFileBytes(image);
		const sha = await sha256Hex(bytes);
		if (sha !== parsed.geometry.source.sha256) {
			errorMessage = `${json.name} was read from ${parsed.geometry.source.fileName} (sha256 ${parsed.geometry.source.sha256.slice(0, 12)}), not from ${image.name} (sha256 ${sha.slice(0, 12)}).`;
			return;
		}
		const decoded = await decodeImageFile(image);
		const asset = findImageByRole(parsed.state.images, 'source-overview')!;
		if (decoded.widthPx !== asset.widthPx || decoded.heightPx !== asset.heightPx) {
			errorMessage = `${image.name} decodes as ${decoded.widthPx} x ${decoded.heightPx} px; the geometry frame is ${asset.widthPx} x ${asset.heightPx} px.`;
			return;
		}
		const state = {
			...parsed.state,
			images: parsed.state.images.map((img) => (img.id === asset.id && isSupportedMimeType(image.type) ? { ...img, mimeType: image.type } : img))
		};
		const next = new ProjectEditor({ state, assets: new Map([[asset.id, { bytes, decoded: decoded.image }]]) });
		const flagged = reviewQueue(
			parsed.state.holes,
			new Map(parsed.geometry.evidence.map((e) => [e.holeId, e])),
			new Map(parsed.geometry.holes.map((h) => [h.id, h]))
		).length;
		replaceEditor(next, parsed.geometry, `Loaded ${parsed.state.holes.length} holes from ${json.name}; ${flagged} need review.`);
	}

	async function openBundle(zip: File, json: File | undefined): Promise<void> {
		const opened = await readProjectBundle(zip);
		if (!opened.ok) {
			errorMessage = opened.kind === 'repair' ? `${zip.name} needs its images repaired; open it in Create Graphics.` : opened.error.message;
			return;
		}
		const next = new ProjectEditor({ state: opened.state, assets: opened.assets });
		next.markSaved();
		let evidenceFrom: CourseGeometry | null = null;
		let note = `Opened ${zip.name}: ${opened.state.holes.length} holes.`;
		if (json) {
			// Evidence only: the project's holes are the reviewer's, never overwritten by the file's.
			const parsed = parseCourseGeometry(await json.text(), { project: opened.state });
			if (parsed.ok) evidenceFrom = parsed.geometry;
			else note += ` Evidence not attached: ${parsed.error.message}`;
		}
		replaceEditor(next, evidenceFrom, note);
	}

	async function handleFiles(event: Event): Promise<void> {
		const input = event.currentTarget as HTMLInputElement;
		const files = [...(input.files ?? [])];
		input.value = '';
		if (files.length === 0) return;
		const zip = files.find((f) => f.name.toLowerCase().endsWith('.zip'));
		const json = files.find((f) => f.name.toLowerCase().endsWith('.json'));
		const image = files.find((f) => isSupportedMimeType(f.type) || /\.(png|jpe?g)$/i.test(f.name));
		busy = true;
		errorMessage = null;
		try {
			if (zip) await openBundle(zip, json);
			else if (json && image) await openGeometryWithScreenshot(json, image);
			else errorMessage = 'Choose a .course-geometry.json together with its screenshot, or a .chainspot.zip.';
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : String(error);
		} finally {
			busy = false;
		}
	}

	async function save(): Promise<void> {
		busy = true;
		try {
			const result = await saveProject(editor);
			if (result.ok) {
				if (JSON.stringify(editor.state) === JSON.stringify(result.savedState)) editor.markSaved();
				message = `Saved ${result.fileName}.`;
				errorMessage = null;
			} else {
				errorMessage = result.error.message;
			}
		} finally {
			busy = false;
		}
	}

	function bendSummary(hole: AnnotatedHole): string {
		const n = hole.corridorBends.length;
		return n === 0 ? 'straight' : `${n} bend${n === 1 ? '' : 's'}`;
	}
</script>

<svelte:head>
	<title>Correct Course · ChainSpot</title>
</svelte:head>

<main class="correct-course">
	<input
		class="file-input"
		type="file"
		multiple
		accept=".json,.zip,application/json,application/zip,image/png,image/jpeg"
		data-testid="cc-open-input"
		bind:this={fileInput}
		onchange={handleFiles}
		tabindex="-1"
		aria-hidden="true"
	/>

	<ImageEditorPane
		bind:this={pane}
		title="Correct Course"
		role="source-overview"
		{editor}
		refresh={refreshCount}
		imageActions={false}
		emptyMessage="Open a screenshot with its .course-geometry.json, or a .chainspot.zip"
		toolsAriaLabel="Holes to review"
		{focusRequest}
		{claimPointer}
		{onClaimedPointerMove}
		{onClaimedPointerUp}
		{onClaimedPointerCancel}
		{onPlacement}
	>
		{#snippet headerActions()}
			<button type="button" data-testid="cc-open" disabled={busy} onclick={() => fileInput?.click()}>Open…</button>
			<button type="button" data-testid="cc-save" disabled={busy || !sourceImage} onclick={save}>Save project</button>
			<button type="button" data-testid="cc-undo" disabled={!canUndo} onclick={undo} title="Undo (Ctrl+Z)">Undo</button>
			<button type="button" data-testid="cc-redo" disabled={!canRedo} onclick={redo} title="Redo (Ctrl+Shift+Z)">Redo</button>
		{/snippet}

		{#snippet tools()}
			<div class="review-nav">
				<button type="button" data-testid="cc-prev" disabled={queue.length === 0} onclick={() => stepReview(-1)} title="Previous hole to review (P)">◀ P</button>
				<span data-testid="cc-queue-count"><strong>{queue.length}</strong> of {holes.length} need review</span>
				<button type="button" data-testid="cc-next" disabled={queue.length === 0} onclick={() => stepReview(1)} title="Next hole to review (N)">N ▶</button>
			</div>
			<ol class="hole-list" data-testid="cc-hole-list">
				{#each ordered as hole (hole.id)}
					{@const evidence = evidenceByHole.get(hole.id)}
					{@const status = reviewStatus(evidence)}
					{@const reason = reviewReason(hole, evidence, originalById.get(hole.id))}
					{@const flagged = reason !== null}
					<li>
						<button
							type="button"
							class="hole-row"
							class:flagged
							aria-current={selection?.holeId === hole.id ? 'true' : undefined}
							data-testid={`cc-hole-row-${hole.number}`}
							data-status={status}
							onclick={() => focusHole(hole.id)}
						>
							<span class="swatch" style={`background:${STATUS_COLOURS[status]}`}></span>
							<span class="num">Hole {hole.number}</span>
							<span class="status">{STATUS_LABELS[status]}{evidence && evidence.confidence.level !== 'confirmed' ? ` · ${evidence.confidence.level}` : ''}{reason === 'alternatives' ? ' · alternatives disagree' : ''}</span>
							<span class="bends">{bendSummary(hole)}</span>
							{#if geometry && holeEdited(hole, originalById.get(hole.id))}
								<span class="edited" data-testid={`cc-edited-${hole.number}`}>edited</span>
							{/if}
						</button>
					</li>
				{/each}
			</ol>
			<ul class="legend" aria-label="Corridor colours">
				{#each LEGEND as status (status)}
					<li><span class="swatch" style={`background:${STATUS_COLOURS[status]}`}></span>{STATUS_LABELS[status]}</li>
				{/each}
				<li><span class="swatch dashed"></span>route not confirmed</li>
			</ul>
		{/snippet}

		{#snippet diagnostics()}
			<div class="detail" data-testid="cc-detail">
				{#if message}<p class="message" role="status" data-testid="cc-message">{message}</p>{/if}
				{#if errorMessage}<p class="error" role="alert" data-testid="cc-error">{errorMessage}</p>{/if}
				{#if selectedHole}
					{@const evidence = evidenceByHole.get(selectedHole.id)}
					<h3>Hole {selectedHole.number}</h3>
					<dl>
						<dt>Evidence</dt>
						<dd>{STATUS_LABELS[reviewStatus(evidence)]}{evidence ? ` (route ${evidence.confidence.level})` : ''}</dd>
						<dt>Route</dt>
						<dd>{bendSummary(selectedHole)}, corridor {selectedHole.corridorWidthPx} px wide (source px)</dd>
						{#if evidence?.reasons.length}
							<dt>Reasons</dt>
							<dd>{evidence.reasons.join('; ')}</dd>
						{/if}
					</dl>
					{#if selectedAlternatives.length > 0}
						<h3>Alternative routes</h3>
						<p class="hint">Faint dashed corridors on the map. Click one (or Adopt) to make it this hole's route.</p>
						<ol class="alternatives" data-testid="cc-alternatives">
							{#each selectedAlternatives as alternative, index (index)}
								<li>
									<span>
										<strong>Alt {index + 1}</strong>
										{alternative.ruleSets.join(', ') || 'no rule set named'}
										<br />
										<small>
											{alternative.verts.length - 2} bend{alternative.verts.length === 3 ? '' : 's'};
											{deriveSeparation(selectedHole, alternativeCenterline(alternative)).toFixed(1)} px from the current route (source px);
											sensor {alternative.sensor?.passFrac ?? 'n/a'} of {alternative.sensor?.stations ?? 'n/a'} stations;
											contrast {alternative.contrastLum ?? 'n/a'} lum
										</small>
									</span>
									<button type="button" data-testid={`cc-adopt-${index}`} onclick={() => adopt(index)}>Adopt</button>
								</li>
							{/each}
						</ol>
					{/if}
				{/if}
				<h3>Gestures</h3>
				<ul class="help">
					<li><strong>Drag</strong> a bend, tee or basket to move it.</li>
					<li><strong>Drag from a corridor</strong> to add a bend and place it; <strong>click</strong> one to add a bend at the click.</li>
					<li><strong>Double-click</strong> a bend, or click it and press <kbd>Delete</kbd>, to remove it.</li>
					<li><strong>Click a ghost</strong> (a selected hole's alternative route) to adopt it.</li>
					<li><kbd>N</kbd> / <kbd>P</kbd>: next / previous hole to review. <kbd>Ctrl</kbd>+<kbd>Z</kbd> undo.</li>
				</ul>
			</div>
		{/snippet}

		{#snippet overlay({ image, zoom })}
			<CourseCorrectionLayer holes={shown} {evidenceByHole} {selection} alternatives={selectedAlternatives} {zoom} widthPx={image.widthPx} heightPx={image.heightPx} />
		{/snippet}
	</ImageEditorPane>
</main>

<style>
	.correct-course {
		padding: 0.75rem;
		color: #e4e4e7;
	}

	.correct-course :global(.editor-body) {
		min-height: calc(100vh - 9rem);
	}

	.correct-course :global(.canvas-shell) {
		min-height: calc(100vh - 9rem);
	}

	.correct-course button {
		min-height: 2.25rem;
		border: 1px solid #52525b;
		border-radius: 5px;
		background: #27272a;
		color: #f4f4f5;
		padding: 0.3rem 0.6rem;
		cursor: pointer;
		touch-action: manipulation;
	}

	.correct-course button:disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}

	.file-input {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip: rect(0 0 0 0);
	}

	.review-nav {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.4rem;
		margin-bottom: 0.6rem;
		font-size: 0.8rem;
	}

	.hole-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}

	.hole-row {
		width: 100%;
		display: grid;
		grid-template-columns: 0.8rem 4rem 1fr auto;
		align-items: center;
		gap: 0.4rem;
		min-height: 2rem;
		padding: 0.25rem 0.45rem;
		font-size: 0.78rem;
		text-align: left;
	}

	.hole-row.flagged {
		border-color: #f59e0b;
	}

	.hole-row[aria-current='true'] {
		background: #3f3f46;
		border-color: #facc15;
	}

	.hole-row .status {
		color: #a1a1aa;
	}

	.hole-row .bends {
		color: #a1a1aa;
		font-size: 0.72rem;
	}

	.hole-row .edited {
		grid-column: 2 / -1;
		color: #facc15;
		font-size: 0.7rem;
	}

	.swatch {
		display: inline-block;
		width: 0.75rem;
		height: 0.75rem;
		border-radius: 2px;
	}

	.swatch.dashed {
		background: transparent;
		border: 2px dashed #a1a1aa;
	}

	.legend {
		list-style: none;
		margin: 0.8rem 0 0;
		padding: 0.5rem 0 0;
		border-top: 1px solid #34343a;
		display: grid;
		gap: 0.25rem;
		font-size: 0.75rem;
		color: #d4d4d8;
	}

	.legend li {
		display: flex;
		align-items: center;
		gap: 0.4rem;
	}

	.detail {
		font-size: 0.82rem;
	}

	.detail h3 {
		margin: 0.6rem 0 0.3rem;
		font-size: 0.9rem;
	}

	.detail dl {
		margin: 0;
		display: grid;
		grid-template-columns: auto 1fr;
		gap: 0.2rem 0.6rem;
	}

	.detail dt {
		color: #a1a1aa;
	}

	.detail dd {
		margin: 0;
	}

	.help {
		margin: 0;
		padding-left: 1rem;
		display: grid;
		gap: 0.3rem;
		color: #d4d4d8;
	}

	.hint {
		margin: 0 0 0.3rem;
		color: #a1a1aa;
	}

	.alternatives {
		margin: 0;
		padding: 0;
		list-style: none;
		display: grid;
		gap: 0.4rem;
	}

	.alternatives li {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 0.5rem;
		padding: 0.35rem 0.45rem;
		border: 1px dashed #c4b5fd;
		border-radius: 4px;
	}

	.alternatives small {
		color: #a1a1aa;
	}

	.message {
		margin: 0 0 0.4rem;
		color: #86efac;
	}

	.error {
		margin: 0 0 0.4rem;
		color: #fecaca;
		background: #450a0a;
		padding: 0.4rem 0.5rem;
		border-radius: 4px;
	}

	kbd {
		border: 1px solid #52525b;
		border-radius: 3px;
		padding: 0 0.25rem;
		font-size: 0.75rem;
	}
</style>
