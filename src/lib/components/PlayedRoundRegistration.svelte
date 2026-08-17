<script lang="ts">
	import { untrack } from 'svelte';
	import ImagePane from '$lib/components/ImagePane.svelte';
	import PointPairList from '$lib/components/PointPairList.svelte';
	import { ProjectEditor } from '$lib/domain/editor';
	import type { AssetResource } from '$lib/domain/editor';
	import {
		createImageAsset,
		createProjectState
	} from '$lib/domain/project';
	import type { ControlPointPair, ImageAsset, PointCoordinates } from '$lib/domain/project';
	import type { DecodeImageFile } from '$lib/imageIntake';
	import { decodeImageFile } from '$lib/imageIntake';
	import {
		activateCorrespondence,
		cancelCorrespondence,
		completeCorrespondence,
		createCorrespondenceState,
		nextPairOrdinal,
		placeCorrespondence
	} from '$lib/correspondenceState';
	import type { PanePlacement } from '$lib/correspondenceState';
	import { commitPointCorrection, parseExactCoordinates } from '$lib/pointCorrection';
	import type { PointSelection } from '$lib/pointSelection';
	import { composedProofPoints } from '$lib/playedRoundRegistration';
	import { estimateAffine } from '$lib/alignment/affine';
	import { estimateSimilarity } from '$lib/alignment/similarity';
	import { validateTransform } from '$lib/alignment/validation';
	import { AlignmentFailureReason } from '$lib/alignment/types';
	import type { AlignmentModel, EstimationResultOrFailure, SerializableTransform } from '$lib/alignment/types';
	import type { ThrownRoundSource } from '$lib/session';
	import type { UsablePlayedRoundRegistration } from '$lib/playedRoundContract';
	import { pointInBounds } from '$lib/coords';

	interface Props {
		playedRound: ThrownRoundSource;
		cleanSource: ImageAsset;
		cleanSourceResource: AssetResource;
		cleanToTarget: SerializableTransform | null;
		decode?: DecodeImageFile;
		onConfirm?: (registration: UsablePlayedRoundRegistration) => boolean | void;
		onInvalidate?: () => void;
		onClose?: () => void;
		onProofPoints?: (points: readonly { id: string; xPx: number; yPx: number }[]) => void;
		confirmationBlockedReason?: string | null;
	}

	let {
		playedRound,
		cleanSource,
		cleanSourceResource,
		cleanToTarget,
		decode = decodeImageFile,
		onConfirm,
		onInvalidate,
		onClose,
		onProofPoints,
		confirmationBlockedReason = null
	}: Props = $props();

	const PLAYED_ROLE = 'source-overview' as const;
	const CLEAN_ROLE = 'target-basemap' as const;
	const MAX_RESIDUAL_PX = 32;

	let registrationEditor = $state.raw<ProjectEditor | null>(null);
	let registrationImages = $state<readonly ImageAsset[]>([]);
	let refresh = $state(0);
	let loading = $state(true);
	let error = $state<string | null>(null);
	let model = $state<AlignmentModel>('similarity');
	let correspondence = $state(createCorrespondenceState());
	let correspondenceError = $state<string | null>(null);
	let selection = $state<PointSelection | null>(null);
	let inspectorDraft = $state({ x: '', y: '' });
	let pointError = $state<string | null>(null);
	let confirmed = $state(false);
	let initializationGeneration = 0;

	function invalidateConfirmation(): void {
		if (!confirmed) return;
		confirmed = false;
		onInvalidate?.();
	}

	function selectModel(nextModel: AlignmentModel): void {
		if (model === nextModel) return;
		model = nextModel;
		invalidateConfirmation();
	}

	function currentPairs(): readonly ControlPointPair[] {
		void refresh;
		return registrationEditor?.state.controlPointPairs ?? [];
	}

	function cleanImage(): ImageAsset | null {
		return registrationImages.find((image) => image.role === CLEAN_ROLE) ?? null;
	}

	function alignmentResult(): EstimationResultOrFailure | null {
		const pairs = currentPairs().map((pair) => ({
			id: pair.id,
			enabled: pair.enabled,
			source: pair.source,
			target: pair.target
		}));
		if (!pairs.some((pair) => pair.enabled)) return null;
		return model === 'affine' ? estimateAffine({ pairs }) : estimateSimilarity({ pairs });
	}

	let result = $derived.by(alignmentResult);
	let warnings = $derived.by(() =>
		result && 'transform' in result
			? validateTransform({
				transform: result.transform,
				pairs: currentPairs().map((pair) => ({
					id: pair.id,
					enabled: pair.enabled,
					source: pair.source,
					target: pair.target
				}))
			})
			: []
	);

	let status = $derived.by(() => {
		if (loading) return 'Loading played-round image…';
		if (error) return error;
		if (!result) return 'Add two spread stationary landmarks to estimate a similarity transform.';
		if (!('transform' in result)) {
			switch (result.reason) {
				case AlignmentFailureReason.COLLINEAR_GEOMETRY:
					return 'Affine needs non-collinear landmarks; spread the points out or use similarity.';
				case AlignmentFailureReason.ZERO_SPREAD:
					return 'Landmarks have no spread; choose distinct stationary features.';
				case AlignmentFailureReason.REFLECTION_REQUIRED:
					return 'Similarity would require a reflection; check landmark order or use affine.';
				default:
					return 'Not enough valid enabled landmarks yet.';
			}
		}
		if (warnings.some((warning) => warning.severity === 'high')) return 'Not ready: resolve the high-severity registration warning.';
		if (result.metrics.maxDistance > MAX_RESIDUAL_PX)
			return `Review needed: worst landmark residual is ${result.metrics.maxDistance.toFixed(1)}px.`;
		if (confirmationBlockedReason) return confirmationBlockedReason;
		return confirmed ? 'Registration confirmed; corrections remain available.' : 'Ready to review and confirm.';
	});

	function selectedPair(): ControlPointPair | null {
		return selection ? currentPairs().find((pair) => pair.id === selection!.pairId) ?? null : null;
	}

	function syncInspector(): void {
		const pair = selectedPair();
		if (!pair || !selection) {
			inspectorDraft = { x: '', y: '' };
			return;
		}
		const point = selection.side === 'source' ? pair.source : pair.target;
		inspectorDraft = { x: String(point.xPx), y: String(point.yPx) };
	}

	function handlePointSelect(next: PointSelection): void {
		if (correspondence.mode !== 'neutral') return;
		selection = next;
		pointError = null;
		syncInspector();
	}

	function startAdd(): void {
		if (!registrationEditor || correspondence.mode !== 'neutral') return;
		selection = null;
		correspondence = activateCorrespondence(correspondence, true, nextPairOrdinal(currentPairs()));
		correspondenceError = null;
	}

	function cancelAdd(): void {
		correspondence = cancelCorrespondence(correspondence);
		correspondenceError = null;
	}

	function handlePlacement(placement: PanePlacement): void {
		if (!registrationEditor) return;
		const imageId = registrationImages.find((image) => image.role === placement.role)?.id ?? '';
		const transition = placeCorrespondence(
			correspondence,
			placement,
			imageId,
			nextPairOrdinal(currentPairs())
		);
		if (!transition.accepted) return;
		if (!transition.completion) {
			correspondence = transition.state;
			return;
		}
		try {
			registrationEditor.addPair({
				sourceCoordinates: transition.completion.source.coordinates,
				targetCoordinates: transition.completion.target.coordinates
			});
			invalidateConfirmation();
			correspondence = completeCorrespondence(transition.state);
			refresh += 1;
		} catch (caught) {
			correspondenceError = caught instanceof Error ? caught.message : 'Could not save landmark pair.';
		}
	}

	function handlePointMove(request: { selection: PointSelection; coordinates: PointCoordinates }): { ok: true } | { ok: false; message: string } {
		if (!registrationEditor || correspondence.mode !== 'neutral') return { ok: false, message: 'Finish landmark placement first.' };
		const pair = currentPairs().find((candidate) => candidate.id === request.selection.pairId);
		if (!pair) return { ok: false, message: 'That landmark pair no longer exists.' };
		const point = request.selection.side === 'source' ? pair.source : pair.target;
		const image = registrationImages.find((candidate) => candidate.id === point.imageId);
		if (!image || !pointInBounds(request.coordinates, image.widthPx, image.heightPx)) {
			return { ok: false, message: 'The corrected landmark must stay inside the original image bounds.' };
		}
		try {
			commitPointCorrection(registrationEditor, request.selection, request.coordinates);
			invalidateConfirmation();
			selection = request.selection;
			pointError = null;
			refresh += 1;
			syncInspector();
			return { ok: true };
		} catch (caught) {
			const message = caught instanceof Error ? caught.message : 'Could not correct landmark.';
			pointError = message;
			return { ok: false, message };
		}
	}

	function applyInspector(): void {
		if (!selection) return;
		const pair = selectedPair();
		const point = pair ? (selection.side === 'source' ? pair.source : pair.target) : null;
		const image = point ? registrationImages.find((candidate) => candidate.id === point.imageId) : null;
		if (!image) return;
		const parsed = parseExactCoordinates(inspectorDraft.x, inspectorDraft.y, image.widthPx, image.heightPx);
		if (!parsed.ok) {
			pointError = parsed.message;
			return;
		}
		handlePointMove({ selection, coordinates: parsed.coordinates });
	}

	function togglePair(pairId: string): void {
		registrationEditor?.setEnabled(pairId, !currentPairs().find((pair) => pair.id === pairId)?.enabled);
		invalidateConfirmation();
		refresh += 1;
	}

	function deletePair(pairId: string): void {
		registrationEditor?.deletePair(pairId);
		invalidateConfirmation();
		if (selection?.pairId === pairId) selection = null;
		refresh += 1;
	}

	function reorderPair(pairId: string, direction: -1 | 1): void {
		const pairs = currentPairs();
		const index = pairs.findIndex((pair) => pair.id === pairId);
		const target = index + direction;
		if (index < 0 || target < 0 || target >= pairs.length) return;
		const ids = pairs.map((pair) => pair.id);
		const [moved] = ids.splice(index, 1);
		ids.splice(target, 0, moved);
		registrationEditor?.reorderPairs(ids);
		refresh += 1;
	}

	function labelCommit(pairId: string, label: string | null): void {
		registrationEditor?.setLabel(pairId, label);
		refresh += 1;
	}

	let proofPoints = $derived.by(() => {
		if (!result || !('transform' in result) || !cleanToTarget) return [];
		return composedProofPoints(currentPairs(), result.transform, cleanToTarget);
	});

	$effect(() => {
		void proofPoints;
		onProofPoints?.(proofPoints);
	});

	function confirm(): void {
		if (!registrationEditor || !result || !('transform' in result) || warnings.some((warning) => warning.severity === 'high') || confirmationBlockedReason) return;
		const source = playedRound;
		const clean = cleanImage();
		if (!clean) return;
		const accepted = onConfirm?.({ source, cleanImageId: clean.id, playedToClean: result.transform });
		if (accepted === false) return;
		confirmed = true;
	}

	$effect(() => {
		// Track only the two image identities. Closing and reopening the hidden
		// registration surface keeps the same editor, while replacing either image
		// rebuilds it. A target-preview transform only updates proof points.
		const round = playedRound;
		const cleanImageId = cleanSource.id;
		const cleanAsset = untrack(() => cleanSource);
		const cleanResource = untrack(() => cleanSourceResource);
		const decodeInput = untrack(() => decode);
		const generation = ++initializationGeneration;
		let cancelled = false;
		const isCurrent = (): boolean => !cancelled && generation === initializationGeneration;
		untrack(() => {
			if (confirmed) onInvalidate?.();
			registrationEditor = null;
			registrationImages = [];
			refresh = 0;
			loading = true;
			error = null;
			model = 'similarity';
			correspondence = createCorrespondenceState();
			correspondenceError = null;
			selection = null;
			inspectorDraft = { x: '', y: '' };
			pointError = null;
			confirmed = false;
		});
		void (async () => {
			try {
				const playedFile = new File([round.blob], round.fileName, {
					type: round.blob.type || 'image/png'
				});
				const [playedDecoded] = await Promise.all([
					decodeInput(playedFile),
					Promise.resolve(cleanResource.decoded)
				]);
				if (!isCurrent()) return;
				if (!(cleanResource.decoded instanceof HTMLImageElement)) {
					throw new Error('The clean course image is not decoded yet.');
				}
				const state = createProjectState({ name: 'Played round registration' });
				const editor = new ProjectEditor({ state });
				const played = createImageAsset({
					role: PLAYED_ROLE,
					fileName: round.fileName,
					mimeType: round.blob.type || 'image/png',
					widthPx: playedDecoded.widthPx,
					heightPx: playedDecoded.heightPx,
					bundlePath: null
				});
				const clean = createImageAsset({
					role: CLEAN_ROLE,
					id: cleanImageId,
					fileName: cleanAsset.fileName,
					mimeType: cleanAsset.mimeType,
					widthPx: cleanAsset.widthPx,
					heightPx: cleanAsset.heightPx,
					bundlePath: null
				});
				const playedBytes = new Uint8Array(await round.blob.arrayBuffer());
				if (!isCurrent()) return;
				editor.assignImage({ role: PLAYED_ROLE, asset: played, bytes: playedBytes });
				editor.assignImage({ role: CLEAN_ROLE, asset: clean, bytes: cleanResource.bytes });
				editor.setDecodedResource(played.id, playedDecoded.image);
				editor.setDecodedResource(clean.id, cleanResource.decoded);
				if (isCurrent()) {
					registrationEditor = editor;
					registrationImages = editor.state.images;
					loading = false;
				}
			} catch (caught) {
				if (isCurrent()) {
					loading = false;
					error = caught instanceof Error ? caught.message : 'Could not load the played-round image.';
				}
			}
		})();
		return () => {
			cancelled = true;
		};
	});
</script>

<section class="registration" data-testid="played-round-registration" aria-labelledby="played-round-registration-heading">
	<header class="registration-header">
		<div>
			<h2 id="played-round-registration-heading">Register played round</h2>
			<p>Match stationary tees, baskets, or hole badges on the played screenshot to the clean UDisc course.</p>
		</div>
		<button type="button" data-testid="played-round-registration-close" onclick={() => onClose?.()}>Close</button>
	</header>

	{#if loading}
		<p class="status" data-testid="played-round-registration-loading">Loading played-round image…</p>
	{:else if error}
		<p class="error" data-testid="played-round-registration-error" role="alert">{error}</p>
	{:else if registrationEditor}
		<div class="toolbar">
			<button type="button" data-testid="played-round-add-pair" disabled={correspondence.mode !== 'neutral'} onclick={startAdd}>Add landmark pair</button>
			{#if correspondence.mode !== 'neutral'}
				<button type="button" data-testid="played-round-cancel-pair" onclick={cancelAdd}>Cancel placement</button>
			{/if}
			<fieldset>
				<legend>Transform</legend>
				<label><input type="radio" name="played-model" checked={model === 'similarity'} onchange={() => selectModel('similarity')} data-testid="played-model-similarity" /> Similarity (2+)</label>
				<label><input type="radio" name="played-model" checked={model === 'affine'} onchange={() => selectModel('affine')} data-testid="played-model-affine" /> Affine (3+ non-collinear)</label>
			</fieldset>
		</div>

		<p class="guidance" data-testid="played-round-guidance">
			{#if correspondence.mode === 'add-source'}Click a stationary landmark in either surface.{:else if correspondence.pendingPlacement}Click the same landmark in the clean course surface.{:else}Select Add landmark pair to begin.{/if}
		</p>
		{#if correspondenceError}<p class="error" role="alert">{correspondenceError}</p>{/if}

		<div class="panes">
			<ImagePane title="Played round" role="source-overview" editor={registrationEditor} refresh={refresh} pairs={currentPairs()} pendingPlacement={correspondence.pendingPlacement} placementEnabled={correspondence.mode !== 'neutral'} correctionEnabled={correspondence.mode === 'neutral'} {selection} onPlacement={handlePlacement} onPointSelect={handlePointSelect} onPointMove={handlePointMove} />
		<ImagePane title="Clean course" role="target-basemap" editor={registrationEditor} refresh={refresh} pairs={currentPairs()} pendingPlacement={correspondence.pendingPlacement} placementEnabled={correspondence.mode !== 'neutral'} correctionEnabled={correspondence.mode === 'neutral'} showRotationControls={false} {selection} onPlacement={handlePlacement} onPointSelect={handlePointSelect} onPointMove={handlePointMove} />
		</div>

		<section class="status-panel" data-testid="played-round-status" aria-live="polite">
			<strong>{status}</strong>
			{#if result && 'transform' in result}
				<span data-testid="played-round-residuals">{result.usedPairIds.length} enabled pair{result.usedPairIds.length === 1 ? '' : 's'} · mean residual {result.metrics.meanDistance.toFixed(1)}px · max {result.metrics.maxDistance.toFixed(1)}px</span>
			{/if}
			{#each warnings as warning (warning.type)}<span class:high={warning.severity === 'high'}>{warning.message}</span>{/each}
			{#if cleanToTarget}<span class="proof">Target proof is composed through the existing clean-course → target alignment.</span>{:else}<span>Target proof will appear after the clean-course → target alignment is usable.</span>{/if}
		</section>

		<PointPairList pairs={currentPairs()} images={registrationImages} {selection} {refresh} interactive={correspondence.mode === 'neutral'} onSelectSide={(pairId, side) => handlePointSelect({ pairId, side })} onLabelCommit={labelCommit} onReorder={reorderPair} onToggleEnabled={togglePair} onDelete={deletePair} />

		{#if selection}
			<section class="inspector" data-testid="played-round-point-inspector" aria-label="Selected played-round landmark">
				<label>X <input data-testid="played-point-x" value={inspectorDraft.x} oninput={(event) => (inspectorDraft = { x: (event.currentTarget as HTMLInputElement).value, y: inspectorDraft.y })} /></label>
				<label>Y <input data-testid="played-point-y" value={inspectorDraft.y} oninput={(event) => (inspectorDraft = { x: inspectorDraft.x, y: (event.currentTarget as HTMLInputElement).value })} /></label>
				<button type="button" data-testid="played-point-apply" onclick={applyInspector}>Apply correction</button>
				{#if pointError}<p class="error" role="alert">{pointError}</p>{/if}
			</section>
		{/if}

		<div class="actions">
			<button type="button" class="confirm" data-testid="played-round-confirm" disabled={!result || !('transform' in result) || warnings.some((warning) => warning.severity === 'high') || (result && 'transform' in result && result.metrics.maxDistance > MAX_RESIDUAL_PX) || Boolean(confirmationBlockedReason)} onclick={confirm}>{confirmed ? 'Registration confirmed' : 'Confirm registration'}</button>
			{#if confirmed}<span data-testid="played-round-confirmed">Confirmed handoff is ready for extraction; corrections remain available.</span>{/if}
		</div>
	{/if}
</section>

<style>
	.registration { display: flex; flex-direction: column; gap: 0.7rem; padding: 0.8rem; border: 1px solid #6d28d9; border-radius: 8px; background: #18181b; }
	.registration-header, .toolbar, .actions { display: flex; align-items: center; gap: 0.7rem; flex-wrap: wrap; }
	.registration-header { justify-content: space-between; }
	h2 { margin: 0; font-size: 1.05rem; }
	p { margin: 0; font-size: 0.85rem; color: #c4b5fd; }
	.panes { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0.8rem; }
	.toolbar fieldset { display: flex; gap: 0.7rem; border: 0; padding: 0; margin: 0; }
	.toolbar legend { font-size: 0.75rem; opacity: 0.75; }
	.guidance { color: #fbbf24; }
	.status-panel, .inspector { display: flex; flex-direction: column; gap: 0.3rem; padding: 0.65rem; border: 1px solid #3f3f46; border-radius: 6px; background: #111113; font-size: 0.82rem; }
	.status-panel span { color: #a1a1aa; }
	.status-panel .high, .error { color: #fca5a5; }
	.status-panel .proof { color: #d8b4fe; }
	.inspector { flex-direction: row; align-items: center; flex-wrap: wrap; }
	.inspector input { width: 6rem; }
	.confirm { border-color: #a78bfa; background: #7c3aed; color: white; font-weight: 650; }
	.confirm:disabled { opacity: 0.5; }
	@media (max-width: 900px) { .panes { grid-template-columns: 1fr; } }
</style>
