<script lang="ts">
	import { onMount, tick } from 'svelte';
	import ImagePane from '$lib/components/ImagePane.svelte';
	import { ProjectEditor } from '$lib/domain/editor';
	import type { AssetResource } from '$lib/domain/editor';
	import { findImageByRole } from '$lib/domain/project';
	import type { ImageAsset, ImageRole, ControlPointPair, ProjectState } from '$lib/domain/project';
	import type { DecodeImageFile, HashBytes } from '$lib/imageIntake';
	import { pointInBounds } from '$lib/coords';
	import type { PointSide } from '$lib/domain/editor';
	import { isEditableTarget, nudgeDelta } from '$lib/pointSelection';
	import type { PointSelection } from '$lib/pointSelection';
	import { commitPointCorrection, parseExactCoordinates } from '$lib/pointCorrection';
	import {
		activateCorrespondence,
		cancelCorrespondence,
		completeCorrespondence,
		createCorrespondenceState,
		nextPairOrdinal,
		placeCorrespondence
	} from '$lib/correspondenceState';
	import type { PanePlacement } from '$lib/correspondenceState';
	import { deriveDiagnostics, diagnosticsCopy } from '$lib/diagnostics';
	import PointPairList from '$lib/components/PointPairList.svelte';
	import { historyShortcut, isDeleteKey, reorderShortcut } from '$lib/pointListShortcuts';
	import { dialogKeyboard, isModalOpen } from '$lib/focusManagement';
	import {
		readProjectBundle,
		resolveRepairWithArchivedBytes,
		resolveRepairWithFile,
		saveProject
	} from '$lib/persistence';
	import type { DownloadBlob, RepairCandidate, RepairResolutionResult } from '$lib/persistence';

	interface Props {
		editor?: ProjectEditor;
		decode?: DecodeImageFile;
		hash?: HashBytes;
		download?: DownloadBlob;
	}

	let { editor: initialEditor, decode, hash, download }: Props = $props();
	let editor = $state.raw(resolveInitialEditor());

	function resolveInitialEditor(): ProjectEditor {
		return initialEditor ?? new ProjectEditor();
	}

	let refreshCount = $state(0);
	let correspondence = $state(createCorrespondenceState());
	let correspondenceError = $state<string | null>(null);
	/** Pure, derived, non-mutating pair counts, readiness, and diagnostics copy. */
	let diagnosticsView = $derived(
		diagnosticsCopy(
			deriveDiagnostics(currentPairs(), editor.state.images, correspondence.pendingSource !== null)
		)
	);
	let selection = $state<PointSelection | null>(null);
	let inspectorDraft = $state({ x: '', y: '' });
	let pointError = $state<string | null>(null);
	let xInput = $state<HTMLInputElement | null>(null);
	let yInput = $state<HTMLInputElement | null>(null);
	/** Transient marker-overlay visibility; rendering only, never durable state. */
	let markersVisible = $state(true);
	let pendingDiscard = $state<{
		role: ImageRole;
		count: number;
		resolve: (confirmed: boolean) => void;
	} | null>(null);
	let saving = $state(false);
	let saveError = $state<string | null>(null);
	let pendingSaveDialog = $state(false);
	let openInput = $state<HTMLInputElement | null>(null);
	let openLoading = $state(false);
	let openError = $state<string | null>(null);
	let repairCandidate = $state<RepairCandidate | null>(null);
	let repairLoading = $state(false);
	let repairError = $state<string | null>(null);
	/** A concise, non-error outcome announced once after a completed action. */
	let activityMessage = $state<string | null>(null);
	let focusRestore = $state<HTMLElement | null>(null);
	let addCorrespondenceButton = $state<HTMLButtonElement | null>(null);
	let undoButton = $state<HTMLButtonElement | null>(null);
	let saveProjectButton = $state<HTMLButtonElement | null>(null);
	let openProjectButton = $state<HTMLButtonElement | null>(null);
	let discardCancelButton = $state<HTMLButtonElement | null>(null);
	let pendingSaveCancelButton = $state<HTMLButtonElement | null>(null);
	let repairCancelButton = $state<HTMLButtonElement | null>(null);
	let repairDiscardCancelButton = $state<HTMLButtonElement | null>(null);
	let pendingRepairDiscard = $state<{
		role: ImageRole;
		count: number;
		resolve: (confirmed: boolean) => void;
	} | null>(null);

	function sourceImage(): ImageAsset | null {
		void refreshCount;
		return findImageByRole(editor.state.images, 'source-overview') ?? null;
	}

	function targetImage(): ImageAsset | null {
		void refreshCount;
		return findImageByRole(editor.state.images, 'target-basemap') ?? null;
	}

	function canAddCorrespondence(): boolean {
		void refreshCount;
		return sourceImage() !== null && targetImage() !== null;
	}

	function currentPairs(): readonly ControlPointPair[] {
		void refreshCount;
		return editor.state.controlPointPairs;
	}

	function selectedPair(): ControlPointPair | null {
		if (!selection) return null;
		return currentPairs().find((pair) => pair.id === selection?.pairId) ?? null;
	}

	function selectedPoint(): { xPx: number; yPx: number } | null {
		const pair = selectedPair();
		if (!pair || !selection) return null;
		return selection.side === 'source' ? pair.source : pair.target;
	}

	function inspectorIsEditing(): boolean {
		return document.activeElement === xInput || document.activeElement === yInput;
	}

	function clearPointSelection(): void {
		selection = null;
		inspectorDraft = { x: '', y: '' };
		pointError = null;
	}

	function syncInspectorDraft(force = false): void {
		if (!force && inspectorIsEditing()) return;
		const pair = selectedPair();
		if (!pair || !selection) {
			if (selection) clearPointSelection();
			return;
		}
		const point = selection.side === 'source' ? pair.source : pair.target;
		inspectorDraft = { x: String(point.xPx), y: String(point.yPx) };
	}

	function handlePointSelect(next: PointSelection): void {
		if (correspondence.mode !== 'neutral') return;
		selection = next;
		pointError = null;
		syncInspectorDraft(true);
	}

	function activateAddCorrespondence(): void {
		if (!canAddCorrespondence()) return;
		// Correction and correspondence creation are mutually exclusive transient tools.
		clearPointSelection();
		correspondence = activateCorrespondence(
			correspondence,
			true,
			nextPairOrdinal(currentPairs())
		);
		correspondenceError = null;
		activityMessage = 'Add correspondence started. Select a landmark in the source image.';
	}

	function cancelAddCorrespondence(): void {
		correspondence = cancelCorrespondence(correspondence);
		correspondenceError = null;
		activityMessage = 'Pending correspondence cancelled.';
	}

	function placementGuidance(): string {
		if (correspondence.mode === 'add-source') return 'Click a landmark in the UDisc source image.';
		if (correspondence.mode === 'add-target') {
			return 'Click the same landmark in the clean target image.';
		}
		return 'Select Add correspondence to create a source–target pair.';
	}

	function placementErrorText(error: unknown): string {
		return error instanceof Error ? error.message : 'Could not complete the correspondence.';
	}

	function handlePointMove(request: {
		selection: PointSelection;
		coordinates: { xPx: number; yPx: number };
	}): { ok: true } | { ok: false; message: string } {
		if (correspondence.mode !== 'neutral') return { ok: false, message: 'Finish correspondence creation first.' };
		const pair = currentPairs().find((candidate) => candidate.id === request.selection.pairId);
		if (!pair) {
			clearPointSelection();
			return { ok: false, message: 'That control point no longer exists.' };
		}
		const point = request.selection.side === 'source' ? pair.source : pair.target;
		const image = editor.state.images.find((candidate) => candidate.id === point.imageId);
		if (!image || !pointInBounds(request.coordinates, image.widthPx, image.heightPx)) {
			return { ok: false, message: 'The corrected point must remain inside the original image bounds.' };
		}
		try {
			commitPointCorrection(editor, request.selection, request.coordinates);
			selection = request.selection;
			pointError = null;
			refreshCount += 1;
			syncInspectorDraft(true);
			return { ok: true };
		} catch (error) {
			const message = placementErrorText(error);
			pointError = message;
			return { ok: false, message };
		}
	}

	function handleInspectorInput(side: 'x' | 'y', event: Event): void {
		const value = (event.currentTarget as HTMLInputElement).value;
		inspectorDraft = side === 'x' ? { x: value, y: inspectorDraft.y } : { x: inspectorDraft.x, y: value };
		pointError = null;
	}

	function applyInspectorDraft(): void {
		const pair = selectedPair();
		if (!pair || !selection) return;
		const point = selection.side === 'source' ? pair.source : pair.target;
		const image = editor.state.images.find((candidate) => candidate.id === point.imageId);
		if (!image) {
			pointError = 'The selected image is no longer available.';
			return;
		}
		const parsed = parseExactCoordinates(
			inspectorDraft.x,
			inspectorDraft.y,
			image.widthPx,
			image.heightPx
		);
		if (!parsed.ok) {
			pointError = parsed.message;
			return;
		}
		handlePointMove({ selection, coordinates: parsed.coordinates });
	}

	function handleGlobalKeyDown(event: KeyboardEvent): void {
		// While a modal dialog is open, all global shortcuts (Escape, nudge, delete,
		// undo/redo, reorder) are owned by the dialog; the dialog's own keydown
		// listener handles Escape/Tab and stops propagation.
		if (isModalOpen()) return;
		if (event.key === 'Escape' && correspondence.mode !== 'neutral') {
			event.preventDefault();
			cancelAddCorrespondence();
			return;
		}
		if (isEditableTarget(event.target)) return;

		const history = historyShortcut(event);
		if (history) {
			event.preventDefault();
			if (history === 'undo') handleUndo();
			else handleRedo();
			return;
		}

		if (correspondence.mode === 'neutral' && selection) {
			const reorder = reorderShortcut(event);
			if (reorder) {
				event.preventDefault();
				handleReorderPair(selection.pairId, reorder);
				return;
			}
			if (isDeleteKey(event)) {
				if (selectedPair()) {
					event.preventDefault();
					handleDeletePair(selection.pairId);
				}
				return;
			}
		}

		if (
			correspondence.mode !== 'neutral' ||
			!selection ||
			event.ctrlKey ||
			event.metaKey ||
			event.altKey
		) {
			return;
		}
		const delta = nudgeDelta(event.key, event.shiftKey);
		if (!delta) return;
		event.preventDefault();
		const pair = selectedPair();
		if (!pair) {
			clearPointSelection();
			return;
		}
		const point = selection.side === 'source' ? pair.source : pair.target;
		const image = editor.state.images.find((candidate) => candidate.id === point.imageId);
		const coordinates = { xPx: point.xPx + delta.xPx, yPx: point.yPx + delta.yPx };
		if (!image || !pointInBounds(coordinates, image.widthPx, image.heightPx)) return;
		handlePointMove({ selection, coordinates });
	}

	function canUndo(): boolean {
		void refreshCount;
		return editor.canUndo;
	}

	function canRedo(): boolean {
		void refreshCount;
		return editor.canRedo;
	}

	function handleUndo(): void {
		if (correspondence.mode !== 'neutral') cancelAddCorrespondence();
		if (!editor.canUndo) return;
		editor.undo();
		refresh();
	}

	function handleRedo(): void {
		if (correspondence.mode !== 'neutral') cancelAddCorrespondence();
		if (!editor.canRedo) return;
		editor.redo();
		refresh();
	}

	function handleListSelectSide(pairId: string, side: PointSide): void {
		if (correspondence.mode !== 'neutral') return;
		selection = { pairId, side };
		pointError = null;
		syncInspectorDraft(true);
	}

	function handleLabelCommit(pairId: string, label: string | null): void {
		try {
			editor.setLabel(pairId, label);
		} catch {
			// The commit failed; refreshing below reverts the field to the authoritative label.
		}
		refreshCount += 1;
	}

	function handleReorderPair(pairId: string, direction: -1 | 1): void {
		const pairs = currentPairs();
		const index = pairs.findIndex((pair) => pair.id === pairId);
		const target = index + direction;
		if (index < 0 || target < 0 || target >= pairs.length) return;
		const orderedIds = pairs.map((pair) => pair.id);
		const [moved] = orderedIds.splice(index, 1);
		orderedIds.splice(target, 0, moved);
		try {
			editor.reorderPairs(orderedIds);
		} catch {
			// A rejected reorder refreshes to the authoritative order below.
		}
		refreshCount += 1;
	}

	function handleToggleEnabled(pairId: string): void {
		const pair = currentPairs().find((candidate) => candidate.id === pairId);
		if (!pair) return;
		try {
			editor.setEnabled(pairId, !pair.enabled);
		} catch {
			// A rejected toggle refreshes to the authoritative state below.
		}
		refreshCount += 1;
	}

	function handleDeletePair(pairId: string): void {
		if (correspondence.mode !== 'neutral') return;
		try {
			editor.deletePair(pairId);
		} catch {
			refreshCount += 1;
			return;
		}
		if (selection?.pairId === pairId) clearPointSelection();
		refreshCount += 1;
		activityMessage = 'Control point pair deleted. Use Undo to restore it.';
		// The originating delete control is destroyed with its row; move focus to a
		// stable, visible control that can immediately undo the deletion.
		void tick().then(() => undoButton?.focus());
	}

	function handlePlacement(placement: PanePlacement): void {
		const transition = placeCorrespondence(
			correspondence,
			placement,
			placement.role === 'source-overview'
				? findImageByRole(editor.state.images, 'source-overview')?.id ?? ''
				: '',
			nextPairOrdinal(currentPairs())
		);
		if (!transition.accepted) return;
		correspondenceError = null;
		if (!transition.completion) {
			correspondence = transition.state;
			return;
		}

		try {
			const currentSourceImageId = findImageByRole(editor.state.images, 'source-overview')?.id ?? null;
			if (currentSourceImageId !== transition.completion.source.imageId) {
				correspondence = cancelCorrespondence(transition.state);
				correspondenceError = 'The source image changed. Restart correspondence creation.';
				return;
			}
			editor.addPair({
				sourceCoordinates: transition.completion.source.coordinates,
				targetCoordinates: transition.completion.target
			});
			correspondence = completeCorrespondence(transition.state);
			refreshCount += 1;
			activityMessage = 'Correspondence pair saved.';
		} catch (error) {
			correspondenceError = placementErrorText(error);
		}
	}

	function isDirty(): boolean {
		void refreshCount;
		return editor.isDirty;
	}

	function onDomainChanged(role: ImageRole): void {
		// A successful assignment/replacement invalidates any pending source identity,
		// including same-dimension replacements. Failed/cancelled intake never calls here.
		if (correspondence.mode !== 'neutral') {
			correspondence = cancelCorrespondence(correspondence);
			correspondenceError = null;
		}
		void role;
		refresh();
	}

	function handleSave(): void {
		// A pending half-pair must never be serialized; require an explicit choice first.
		if (correspondence.mode !== 'neutral') {
			rememberFocus();
			pendingSaveDialog = true;
			return;
		}
		void runSave();
	}

	async function runSave(): Promise<void> {
		if (saving) return;
		saving = true;
		saveError = null;
		try {
			const result = await saveProject(editor, { hash, download });
			if (result.ok) {
				// Mark saved only when the current state still exactly matches the snapshot
				// the bundle was built from. Edits that landed while the async save was in
				// flight are never checkpointed: the bundle holds the earlier state, so the
				// project stays dirty and the user is told to save again.
				if (JSON.stringify(editor.state) === JSON.stringify(result.savedState)) {
					editor.markSaved();
				} else {
					saveError =
						'The project changed while saving. The downloaded bundle contains the earlier state — save again to include your latest edits.';
				}
				if (!saveError) activityMessage = 'Project bundle saved.';
				refresh();
			} else {
				saveError = result.error.message;
			}
		} catch (error) {
			saveError = error instanceof Error ? error.message : 'Could not save the project.';
		} finally {
			saving = false;
		}
	}

	function settlePendingSave(proceed: boolean): void {
		pendingSaveDialog = false;
		restoreFocus(saveProjectButton);
		if (proceed) {
			// Explicit transient cancel: no history, then save.
			cancelAddCorrespondence();
			void runSave();
		}
	}

	function handleOpenFile(event: Event): void {
		const input = event.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		input.value = '';
		if (!file) return;
		void openBundle(file);
	}

	async function openBundle(file: File): Promise<void> {
		openLoading = true;
		openError = null;
		try {
			const result = await readProjectBundle(file, { decode, hash });
			if (result.ok) {
				applyOpen(result.state, result.assets);
			} else if (result.kind === 'repair') {
				repairCandidate = result.candidate;
				repairError = null;
			} else {
				openError = result.error.message;
				// Failed import: keep focus on the control that opened the chooser so
				// the keyboard user can retry immediately.
				void tick().then(() => openProjectButton?.focus());
			}
		} catch (error) {
			openError = error instanceof Error ? error.message : 'Could not open the project bundle.';
			void tick().then(() => openProjectButton?.focus());
		} finally {
			openLoading = false;
		}
	}

	/** Atomically replaces the live editor with a freshly opened project (clean checkpoint). */
	function applyOpen(state: ProjectState, assets: ReadonlyMap<string, AssetResource>): void {
		const next = new ProjectEditor({ state, assets });
		next.markSaved();
		editor = next;
		correspondence = createCorrespondenceState();
		correspondenceError = null;
		clearPointSelection();
		markersVisible = true;
		repairCandidate = null;
		repairError = null;
		pendingRepairDiscard = null;
		saveError = null;
		openError = null;
		activityMessage = `Opened project ${state.project.name}.`;
		refresh();
		void tick().then(() => openProjectButton?.focus());
	}

	function roleLabel(role: ImageRole): string {
		return role === 'source-overview' ? 'UDisc source' : 'Clean target';
	}

	async function handleRepairChoose(role: ImageRole, event: Event): Promise<void> {
		const input = event.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		input.value = '';
		const candidate = repairCandidate;
		if (!file || !candidate) return;
		repairLoading = true;
		repairError = null;
		try {
			await runRepairResolution(candidate, (discard) =>
				resolveRepairWithFile(candidate, file, role, { decode, hash, discard })
			);
		} finally {
			repairLoading = false;
		}
	}

	async function handleRepairUseArchived(role: ImageRole): Promise<void> {
		const candidate = repairCandidate;
		if (!candidate) return;
		repairLoading = true;
		repairError = null;
		try {
			await runRepairResolution(candidate, (discard) =>
				resolveRepairWithArchivedBytes(candidate, role, { decode, hash, discard })
			);
		} finally {
			repairLoading = false;
		}
	}

	async function runRepairResolution(
		candidate: RepairCandidate,
		run: (discard: boolean) => Promise<RepairResolutionResult>
	): Promise<void> {
		const result = await run(false);
		if (result.ok) {
			applyOpen(result.state, result.assets);
			return;
		}
		if (result.kind === 'error') {
			repairError = result.error.message;
			return;
		}
		if (result.kind === 'incomplete') {
			repairCandidate = result.candidate;
			repairError = null;
			return;
		}
		const confirmed = await requestRepairDiscard(result.role, result.affectedCount);
		if (!confirmed) return;
		const rerun = await run(true);
		if (rerun.ok) {
			applyOpen(rerun.state, rerun.assets);
		} else if (rerun.kind === 'error') {
			repairError = rerun.error.message;
		} else if (rerun.kind === 'incomplete') {
			repairCandidate = rerun.candidate;
			repairError = null;
		}
	}

	function requestRepairDiscard(role: ImageRole, count: number): Promise<boolean> {
		return new Promise((resolve) => {
			rememberFocus();
			pendingRepairDiscard = { role, count, resolve };
		});
	}

	function settleRepairDiscard(confirmed: boolean): void {
		pendingRepairDiscard?.resolve(confirmed);
		pendingRepairDiscard = null;
		restoreFocus(repairCancelButton);
	}

	function cancelRepair(): void {
		repairCandidate = null;
		repairError = null;
		pendingRepairDiscard = null;
		activityMessage = 'Project repair cancelled.';
		restoreFocus(openProjectButton);
	}

	onMount(() => {
		window.addEventListener('keydown', handleGlobalKeyDown);
		return () => window.removeEventListener('keydown', handleGlobalKeyDown);
	});

	/** Test hook: forces a re-derive after external domain actions such as undo/redo. */
	export function refresh(): void {
		refreshCount += 1;
		if (selection && !currentPairs().some((pair) => pair.id === selection?.pairId)) {
			clearPointSelection();
		}
		syncNameDraft();
		syncInspectorDraft();
	}

	/** Test hook: the currently active editor (may change after a successful open). */
	export function getEditor(): ProjectEditor {
		return editor;
	}

	function requestDiscardConfirmation(role: ImageRole, count: number): Promise<boolean> {
		return new Promise((resolve) => {
			rememberFocus();
			pendingDiscard = { role, count, resolve };
		});
	}

	function settleDiscard(confirmed: boolean): void {
		pendingDiscard?.resolve(confirmed);
		pendingDiscard = null;
		restoreFocus(addCorrespondenceButton);
	}

	function rememberFocus(): void {
		const active = document.activeElement;
		focusRestore = active instanceof HTMLElement ? active : null;
	}

	function restoreFocus(fallback: HTMLElement | null): void {
		const target = focusRestore?.isConnected ? focusRestore : fallback;
		focusRestore = null;
		void tick().then(() => target?.focus());
	}

	$effect(() => {
		const target = pendingRepairDiscard
			? repairDiscardCancelButton
			: pendingDiscard
				? discardCancelButton
				: pendingSaveDialog
					? pendingSaveCancelButton
					: repairCandidate
						? repairCancelButton
						: null;
		if (target) void tick().then(() => target.focus());
	});

	function initialProjectName(): string {
		return editor.state.project.name;
	}

	let nameDraft = $state(initialProjectName());
	let nameInput = $state<HTMLInputElement | null>(null);

	/**
	 * Re-applies the domain project name to the field after external changes
	 * (undo/redo) unless the user is actively editing it, so an in-progress
	 * draft is never clobbered.
	 */
	function syncNameDraft(): void {
		if (document.activeElement !== nameInput) {
			nameDraft = editor.state.project.name;
		}
	}

	function handleNameChange(event: Event): void {
		const input = event.currentTarget as HTMLInputElement;
		const value = input.value.trim();
		if (value === '') {
			nameDraft = editor.state.project.name;
			return;
		}
		if (value === editor.state.project.name) return;
		editor.renameProject(value);
		nameDraft = editor.state.project.name;
		refreshCount += 1;
	}

	function pendingRoleLabel(): string {
		return pendingDiscard?.role === 'source-overview' ? 'UDisc source' : 'Clean target';
	}
</script>

	<main
		data-testid="app-shell"
		data-correspondence-mode={correspondence.mode}
		data-complete-pair-count={currentPairs().length}
		data-pending-pair-count={correspondence.pendingSource ? 1 : 0}
		data-pending-source={correspondence.pendingSource ? 'true' : 'false'}
	>
	<header class="toolbar">
		<h1>ChainSpot</h1>
		<label class="project-name-field">
			<span>Project name</span>
			<input
				data-testid="project-name"
				bind:this={nameInput}
				value={nameDraft}
				onchange={handleNameChange}
			/>
		</label>
		{#if isDirty()}
			<span class="dirty" data-testid="dirty-indicator">Unsaved changes</span>
		{/if}
		<button
			type="button"
			class="add-correspondence"
			data-testid="add-correspondence"
			bind:this={addCorrespondenceButton}
			disabled={!canAddCorrespondence() || correspondence.mode !== 'neutral'}
			onclick={activateAddCorrespondence}
			title={canAddCorrespondence()
				? 'Add a correspondence'
				: 'Load both images to add correspondences'}
		>
			Add correspondence
		</button>
		{#if correspondence.mode !== 'neutral'}
			<button
				type="button"
				class="cancel-correspondence"
				data-testid="cancel-correspondence"
				onclick={cancelAddCorrespondence}
			>
				Cancel
			</button>
		{/if}
		<button
			type="button"
			class="history-button"
			data-testid="undo"
			bind:this={undoButton}
			disabled={!canUndo()}
			onclick={handleUndo}
			title="Undo (Ctrl/Cmd+Z)"
			aria-keyshortcuts="Control+Z Meta+Z"
		>
			Undo
		</button>
		<button
			type="button"
			class="history-button"
			data-testid="redo"
			disabled={!canRedo()}
			onclick={handleRedo}
			title="Redo (Ctrl/Cmd+Shift+Z, or Ctrl+Y)"
			aria-keyshortcuts="Control+Shift+Z Meta+Shift+Z Control+Y"
		>
			Redo
		</button>
		<button
			type="button"
			class="marker-toggle"
			data-testid="toggle-markers"
			aria-pressed={markersVisible}
			onclick={() => (markersVisible = !markersVisible)}
			title={markersVisible
				? 'Hide control-point markers (rendering only)'
				: 'Show control-point markers'}
		>
			{markersVisible ? 'Hide markers' : 'Show markers'}
		</button>
		<button
			type="button"
			class="persistence-button"
			data-testid="save-project"
			bind:this={saveProjectButton}
			disabled={saving}
			onclick={handleSave}
			title="Save the project as a portable .chainspot.zip bundle"
		>
			Save project
		</button>
		<button
			type="button"
			class="persistence-button"
			data-testid="open-project"
			bind:this={openProjectButton}
			disabled={openLoading}
			onclick={() => openInput?.click()}
			title="Open a .chainspot.zip project bundle"
		>
			Open project
		</button>
		<input
			class="file-input"
			type="file"
			accept=".chainspot.zip,application/zip,application/x-zip-compressed"
			data-testid="open-project-input"
			bind:this={openInput}
			tabindex="-1"
			aria-hidden="true"
			onchange={handleOpenFile}
		/>
	</header>

	<section
		class="activity-status sr-only"
		aria-live="polite"
		aria-atomic="true"
		data-testid="activity-status"
	>
		{#if activityMessage}
			<p class="status" data-testid="activity-message" role="status">{activityMessage}</p>
		{/if}
		{#if saving}
			<p class="status" data-testid="save-loading" role="status">Saving project…</p>
		{/if}
		{#if openLoading}
			<p class="status" data-testid="open-loading" role="status">Opening project…</p>
		{/if}
	</section>
	{#if saveError}
		<p class="error" data-testid="save-error" role="alert">{saveError}</p>
	{/if}
	{#if openError}
		<p class="error" data-testid="open-error" role="alert">{openError}</p>
	{/if}

	<section class="correspondence-status" aria-live="polite" aria-atomic="true" data-testid="correspondence-status">
		<p data-testid="correspondence-guidance" role="status">{placementGuidance()}</p>
		{#if correspondenceError}
			<p class="error" data-testid="correspondence-error" role="alert">{correspondenceError}</p>
		{/if}
	</section>

	<section class="panes">
		<ImagePane
			title="UDisc source"
			role="source-overview"
			{editor}
			refresh={refreshCount}
			pairs={currentPairs()}
			pendingSource={correspondence.pendingSource}
			placementEnabled={correspondence.mode !== 'neutral'}
			correctionEnabled={correspondence.mode === 'neutral'}
			{selection}
			{markersVisible}
			{decode}
			confirmDiscard={(count) => requestDiscardConfirmation('source-overview', count)}
			onDomainChanged={onDomainChanged}
			onPlacement={handlePlacement}
			onPointSelect={handlePointSelect}
			onPointMove={handlePointMove}
		/>
		<ImagePane
			title="Clean target"
			role="target-basemap"
			{editor}
			refresh={refreshCount}
			pairs={currentPairs()}
			pendingSource={correspondence.pendingSource}
			placementEnabled={correspondence.mode !== 'neutral'}
			correctionEnabled={correspondence.mode === 'neutral'}
			{selection}
			{markersVisible}
			{decode}
			confirmDiscard={(count) => requestDiscardConfirmation('target-basemap', count)}
			onDomainChanged={onDomainChanged}
			onPlacement={handlePlacement}
			onPointSelect={handlePointSelect}
			onPointMove={handlePointMove}
		/>
	</section>

	<!--
		Diagnostics and pair counts live BELOW the panes on purpose: the section grows as
		warnings appear, and any vertical growth here must never shift the image panes
		while the user is aiming a precise click or wheel. The pending completion/cancel
		guidance is placed here for the same reason: appearing mid-creation must not move
		either image under the pointer.
	-->
	<section class="pair-diagnostics" data-testid="pair-diagnostics" aria-live="polite" aria-atomic="true" aria-label="Pair diagnostics">
		<p data-testid="pair-count-text">{diagnosticsView.count}</p>
		<p data-testid="readiness-text">{diagnosticsView.readiness}</p>
		{#if correspondence.mode === 'add-target' && correspondence.pendingSource}
			<p class="pending-guidance" data-testid="pending-guidance">
				This pair is not saved yet. Click the same landmark in the target image to
				complete it, or press Escape / Cancel to discard it.
			</p>
		{/if}
		{#each diagnosticsView.warnings as warning (warning)}
			<p class="diagnostic-warning" data-testid="diagnostic-warning">{warning}</p>
		{/each}
	</section>

	{#if selection && correspondence.mode === 'neutral'}
		<section class="point-inspector" data-testid="point-inspector" aria-label="Selected control point" aria-describedby={pointError ? 'point-error' : undefined}>
			<h2>Pair {selectedPair()?.ordinal} · {selection.side === 'source' ? 'Source' : 'Target'} point</h2>
			<div class="point-fields">
				<label>
					<span>X</span>
					<input
						id="point-x"
						type="text"
						inputmode="decimal"
						autocomplete="off"
						data-testid="point-x"
						bind:this={xInput}
						value={inspectorDraft.x}
						aria-invalid={pointError ? 'true' : undefined}
						aria-describedby={pointError ? 'point-error' : undefined}
						oninput={(event) => handleInspectorInput('x', event)}
					/>
				</label>
				<label>
					<span>Y</span>
					<input
						id="point-y"
						type="text"
						inputmode="decimal"
						autocomplete="off"
						data-testid="point-y"
						bind:this={yInput}
						value={inspectorDraft.y}
						aria-invalid={pointError ? 'true' : undefined}
						aria-describedby={pointError ? 'point-error' : undefined}
						oninput={(event) => handleInspectorInput('y', event)}
					/>
				</label>
				<button type="button" data-testid="point-apply" onclick={applyInspectorDraft}>Apply</button>
			</div>
			{#if pointError}
				<p class="error" data-testid="point-error" role="alert">{pointError}</p>
			{/if}
		</section>
	{/if}

	<PointPairList
		pairs={currentPairs()}
		images={editor.state.images}
		{selection}
		refresh={refreshCount}
		interactive={correspondence.mode === 'neutral'}
		onSelectSide={handleListSelectSide}
		onLabelCommit={handleLabelCommit}
		onReorder={handleReorderPair}
		onToggleEnabled={handleToggleEnabled}
		onDelete={handleDeletePair}
	/>

	{#if pendingDiscard}
		<div class="dialog-backdrop">
			<div
				class="dialog"
				role="dialog"
				aria-modal="true"
				aria-label="Discard correspondence points?"
				data-testid="discard-confirmation"
				use:dialogKeyboard={() => settleDiscard(false)}
			>
				<h2>Discard correspondence points?</h2>
				<p>
					Replacing the {pendingRoleLabel()} image with different dimensions will discard
					{pendingDiscard.count} correspondence point{pendingDiscard.count === 1 ? '' : 's'}
					on this image.
				</p>
				<div class="dialog-actions">
					<button
						type="button"
						data-testid="discard-confirm-cancel"
						bind:this={discardCancelButton}
						onclick={() => settleDiscard(false)}
					>
						Cancel
					</button>
					<button
						type="button"
						data-testid="discard-confirm-accept"
						onclick={() => settleDiscard(true)}
					>
						Discard points and replace
					</button>
				</div>
			</div>
		</div>
	{/if}

	{#if pendingSaveDialog}
		<div class="dialog-backdrop">
			<div
				class="dialog"
				role="dialog"
				aria-modal="true"
				aria-label="Finish or cancel the pending correspondence"
				data-testid="pending-save-dialog"
				use:dialogKeyboard={() => settlePendingSave(false)}
			>
				<h2>Finish or cancel the pending correspondence</h2>
				<p>
					A correspondence is half-created and will not be saved. Finish it, or cancel the
					pending point explicitly to save the project now.
				</p>
				<div class="dialog-actions">
					<button
						type="button"
						data-testid="pending-save-cancel"
						bind:this={pendingSaveCancelButton}
						onclick={() => settlePendingSave(false)}
					>
						Keep pending point
					</button>
					<button
						type="button"
						data-testid="pending-save-proceed"
						onclick={() => settlePendingSave(true)}
					>
						Cancel pending point and save
					</button>
				</div>
			</div>
		</div>
	{/if}

	{#if repairCandidate}
		<div class="dialog-backdrop">
			<div
				class="dialog repair-dialog"
				role="dialog"
				aria-modal="true"
				aria-label="Repair project images"
				data-testid="repair-dialog"
				use:dialogKeyboard={cancelRepair}
			>
				<h2>Repair project images</h2>
				<p>
					The project “{repairCandidate.state.project.name}” has
					{repairCandidate.state.controlPointPairs.length} correspondence pair
					{repairCandidate.state.controlPointPairs.length === 1 ? '' : 's'} but one or more
					original images could not be verified.
				</p>
				{#each repairCandidate.issues as issue (issue.image.id)}
					<div class="repair-issue" data-testid="repair-issue" data-role={issue.image.role}>
						<h3>
							{roleLabel(issue.image.role)} ·
							{issue.reason === 'missing' ? 'Missing image' : 'Image hash mismatch'}
						</h3>
						<dl>
							<div>
								<dt>Bundle path</dt>
								<dd data-testid={`repair-path-${issue.image.role}`}>{issue.path}</dd>
							</div>
							<div>
								<dt>Expected SHA-256</dt>
								<dd data-testid={`repair-hash-${issue.image.role}`}>{issue.expectedHash}</dd>
							</div>
							<div>
								<dt>Reason</dt>
								<dd>
									{issue.reason === 'missing'
										? 'The image is not present in the archive.'
										: 'The archived bytes do not match the expected hash.'}
								</dd>
							</div>
						</dl>
						<div class="repair-actions">
							<label class="choose-label" data-testid={`repair-choose-${issue.image.role}`}>
								Choose local image…
								<input
									class="file-input"
									type="file"
									accept="image/png,image/jpeg"
									data-testid={`repair-input-${issue.image.role}`}
									disabled={repairLoading}
									onchange={(event) => handleRepairChoose(issue.image.role, event)}
								/>
							</label>
							{#if issue.reason === 'hash-mismatch'}
								<button
									type="button"
									data-testid={`repair-archived-${issue.image.role}`}
									disabled={repairLoading}
									onclick={() => handleRepairUseArchived(issue.image.role)}
								>
									Use archived image (explicit)
								</button>
							{/if}
						</div>
					</div>
				{/each}
				{#if repairLoading}
					<p class="status" data-testid="repair-loading">Resolving repair…</p>
				{/if}
				{#if repairError}
					<p class="error" data-testid="repair-error" role="alert">{repairError}</p>
				{/if}
				<div class="dialog-actions">
					<button
						type="button"
						data-testid="repair-cancel"
						bind:this={repairCancelButton}
						disabled={repairLoading}
						onclick={cancelRepair}
					>
						Cancel repair
					</button>
				</div>
			</div>
		</div>
	{/if}

	{#if pendingRepairDiscard}
		<div class="dialog-backdrop">
			<div
				class="dialog"
				role="dialog"
				aria-modal="true"
				aria-label="Discard correspondence points?"
				data-testid="repair-discard-confirmation"
				use:dialogKeyboard={() => settleRepairDiscard(false)}
			>
				<h2>Discard correspondence points?</h2>
				<p>
					Replacing the {roleLabel(pendingRepairDiscard.role)} image with different
					dimensions will discard {pendingRepairDiscard.count} correspondence point
					{pendingRepairDiscard.count === 1 ? '' : 's'} on this image.
				</p>
				<div class="dialog-actions">
					<button
						type="button"
						data-testid="repair-discard-cancel"
						bind:this={repairDiscardCancelButton}
						onclick={() => settleRepairDiscard(false)}
					>
						Cancel
					</button>
					<button
						type="button"
						data-testid="repair-discard-accept"
						onclick={() => settleRepairDiscard(true)}
					>
						Discard points and replace
					</button>
				</div>
			</div>
		</div>
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

	:global(button:focus-visible),
	:global(input:focus-visible),
	:global([role='button']:focus-visible) {
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

	.project-name-field {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.85rem;
		opacity: 0.9;
	}

	.dirty {
		padding: 0.15rem 0.5rem;
		border-radius: 999px;
		background: #fff3cd;
		border: 1px solid #e0c35a;
		color: #6b5300;
		font-size: 0.8rem;
	}

	/* Visually hidden but announced: the activity live region must never shift the
	   image panes (P0-012 invariant) while still being a polite live status region. */
	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0 0 0 0);
		white-space: nowrap;
		border: 0;
	}

	.activity-status {
		min-height: 0;
	}

	.status {
		margin: 0;
		font-size: 0.85rem;
		opacity: 0.85;
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

	.file-input {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip: rect(0 0 0 0);
	}

	.repair-dialog {
		max-width: 34rem;
		max-height: 85vh;
		overflow: auto;
	}

	.repair-issue {
		padding: 0.6rem 0.75rem;
		border: 1px solid #e2e8f0;
		border-radius: 6px;
		background: #f8fafc;
		margin-top: 0.5rem;
	}

	.repair-issue h3 {
		margin: 0 0 0.4rem;
		font-size: 0.95rem;
	}

	.repair-issue dl {
		display: grid;
		grid-template-columns: auto 1fr;
		gap: 0.15rem 0.75rem;
		margin: 0 0 0.6rem;
		font-size: 0.85rem;
	}

	.repair-issue dt {
		font-weight: 600;
		opacity: 0.8;
	}

	.repair-issue dd {
		margin: 0;
		overflow-wrap: anywhere;
	}

	.repair-actions {
		display: flex;
		gap: 0.5rem;
		flex-wrap: wrap;
		align-items: center;
	}

	.choose-label {
		display: inline-flex;
		align-items: center;
		padding: 0.3rem 0.7rem;
		border: 1px solid #cbd5e1;
		border-radius: 4px;
		background: #fff;
		font-size: 0.85rem;
		cursor: pointer;
	}

	.correspondence-status {
		margin: 0;
		min-height: 1.5rem;
		font-size: 0.9rem;
	}

	.correspondence-status p {
		margin: 0;
	}

	.correspondence-status .error {
		margin-top: 0.35rem;
	}

	.pending-guidance {
		margin: 0.35rem 0 0;
		font-size: 0.85rem;
		color: #7c2d12;
	}

	.pair-diagnostics {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		margin: 0;
		padding: 0.6rem 0.7rem;
		border: 1px solid #e2e8f0;
		border-radius: 6px;
		background: #f8fafc;
		font-size: 0.85rem;
	}

	.pair-diagnostics p {
		margin: 0;
	}

	.diagnostic-warning {
		color: #92400e;
	}

	.point-inspector {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		padding: 0.7rem;
		border: 1px solid #cbd5e1;
		border-radius: 6px;
		background: #f8fafc;
	}

	.point-inspector h2 {
		margin: 0;
		font-size: 0.95rem;
	}

	.point-fields {
		display: flex;
		align-items: end;
		gap: 0.5rem;
		flex-wrap: wrap;
	}

	.point-fields label {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		font-size: 0.8rem;
	}

	.point-fields input {
		width: 8rem;
	}

	.panes {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 1rem;
	}

	.dialog-backdrop {
		position: fixed;
		inset: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		background: rgb(0 0 0 / 40%);
	}

	.dialog {
		background: #fff;
		border-radius: 8px;
		padding: 1rem 1.25rem;
		max-width: 26rem;
	}

	.dialog h2 {
		margin: 0 0 0.5rem;
		font-size: 1.1rem;
	}

	.dialog-actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
		margin-top: 1rem;
	}

	@media (max-width: 900px) {
		main {
			padding: 0.75rem;
		}

		.panes {
			grid-template-columns: minmax(0, 1fr);
		}

		.toolbar {
			gap: 0.65rem;
		}

		.project-name-field {
			flex-basis: 100%;
		}

		.project-name-field input {
			min-width: 0;
			flex: 1;
		}
	}
</style>
