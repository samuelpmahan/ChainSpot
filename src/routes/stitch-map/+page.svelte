<script lang="ts">
	import { goto } from '$app/navigation';
	import { base } from '$app/paths';
	import Konva from 'konva';
	import { onDestroy, onMount, untrack } from 'svelte';
	import ImageViewport from '$lib/components/ImageViewport.svelte';
	import StitchTileSlot from '$lib/components/StitchTileSlot.svelte';
	import { clickSlopPx, ViewportController } from '$lib/viewport.svelte';
	import type { ViewportFitTarget } from '$lib/viewport.svelte';
	import { decodeImageFile, isSupportedMimeType, readFileBytes, sha256Hex } from '$lib/imageIntake';
	import { isEditableTarget } from '$lib/pointSelection';
	import { canvas2dAvailable } from '$lib/scene';
	import {
		ZERO_CROP,
		cropSize,
		defaultSlotOrder,
		expectedNeighbors,
		gridNeighbors,
		initialPlacements,
		readiness,
		sessionDimensions,
		tileRect,
		unionBounds
	} from '$lib/stitch/geometry';
	import type {
		CropInsetField,
		CropInsets,
		TileNeighbors,
		TilePlacement,
		TileSlot
	} from '$lib/stitch/geometry';
	import { TileDecodeCoordinator, guardedDecode } from '$lib/stitch/tileIntake';
	import { MAX_AUTO_ARRANGE_TILES } from '$lib/stitch/autoLayout';
	import {
		disposeSmartStitchWorker,
		renderPipelineComposite,
		runStitchPipeline,
		warmSmartStitchWorker
	} from '$lib/stitch/smartImport';
	import { DEFAULT_MAX_ANALYSIS_DIM, toAnalysisRaster } from '$lib/stitch/analysis';
	import type { AnalysisRaster } from '$lib/stitch/analysis';
	import { loadCv, snapAlign, warmMatchTemplate } from '$lib/stitch/cvMatch';
	import type { SnapNeighbor } from '$lib/stitch/cvMatch';
	import { stitchedFileName } from '$lib/stitch/render';
	import type {
		DraftSourceCapture,
		StitchConfidence,
		StitchPipelineSuccess
	} from '$lib/stitch/pipelineResult';
	import { buildManualDraftComposite, badgeFlashPercent } from '$lib/stitch/pipelineUiHelpers';
	import type { CompositeProvenance, Sha256Hex } from '$lib/domain/provenance';
	import { prefersReducedMotion } from '$lib/reducedMotion';
	import { detectCourseCandidates } from '$lib/autoAnnotation/basketDetection';
	import {
		clearThrownRoundSource,
		getPendingHandoff,
		getThrownRoundSource,
		setPendingHandoff,
		setThrownRoundSource,
		subscribePendingStitchCaptures,
		takePendingStitchCaptures
	} from '$lib/session';
	import type { PendingHandoff } from '$lib/session';
	import type { ImageRole } from '$lib/domain/project';
	import type { ImageSpacePoint, ScreenSpacePoint } from '$lib/coords';

	interface StitchTile {
		fileName: string;
		mimeType: string;
		widthPx: number;
		heightPx: number;
		image: HTMLImageElement;
		/** The original capture, retained so the manual-correction surface can rebuild a `DraftComposite` (hash, re-render) without a second file picker round trip. */
		file: File;
	}

	/** A slot's display label is its 1-based position in the current session, not its stable id. */
	function slotLabel(slot: TileSlot): string {
		const index = activeSlots.indexOf(slot);
		return index >= 0 ? `Capture ${index + 1}` : slot;
	}

	const CROP_FIELDS: readonly CropInsetField[] = ['topPx', 'rightPx', 'bottomPx', 'leftPx'];

	const CROP_FIELD_LABELS: Record<CropInsetField, string> = {
		topPx: 'Top',
		rightPx: 'Right',
		bottomPx: 'Bottom',
		leftPx: 'Left'
	};

	/** Reserved coordinator key guarding one whole import batch (auto pipeline, or the manual per-slot grid). */
	const SMART_IMPORT_BATCH = '__stitch-import__';

	/** Session tiles: transient browser resources only, never durable project state. */
	let tiles = $state<Partial<Record<TileSlot, StitchTile>>>({});
	let tileErrors = $state<Partial<Record<TileSlot, string>>>({});
	/** Per-slot decode generations: stale in-flight decodes never publish results. */
	const decodeCoordinator = new TileDecodeCoordinator();

	/** Authoritative committed shared crop for the manual-correction surface; drafts may be invalid without touching it. */
	let crop = $state<CropInsets>({ ...ZERO_CROP });
	let cropDraft = $state<{ topPx: string; rightPx: string; bottomPx: string; leftPx: string }>({
		topPx: '0',
		rightPx: '0',
		bottomPx: '0',
		leftPx: '0'
	});
	let cropInputs = $state<Partial<Record<CropInsetField, HTMLInputElement | null>>>({});

	/**
	 * The session's active slots for the IMPORT grid and the manual-correction
	 * surface alike: four fresh, empty ids by default, or however many sources
	 * the pipeline placed (see `seedManualFromPipeline`), or one more than that
	 * after "+ Add capture". `tileNeighbors` is the placeholder grid adjacency
	 * Snap searches against; the first slot in `activeSlots` is always the
	 * anchor (immovable, at (0, 0)).
	 */
	const INITIAL_SLOTS: readonly TileSlot[] = defaultSlotOrder(4);
	let activeSlots = $state<TileSlot[]>([...INITIAL_SLOTS]);
	let tileNeighbors = $state<TileNeighbors>(gridNeighbors(INITIAL_SLOTS));
	const anchorSlot = $derived(activeSlots[0]);
	const movableSlots = $derived(activeSlots.slice(1));
	/** Every slot id ever active this session, so a reset invalidates stale in-flight decodes from a prior (possibly larger) session too. */
	let everActiveSlots = new Set<TileSlot>(INITIAL_SLOTS);

	let placements = $state<Partial<Record<TileSlot, TilePlacement>>>(
		initialPlacements(INITIAL_SLOTS, 1, 1)
	);
	let placementsInitialized = $state(false);
	let selectedSlot = $state<TileSlot | null>(null);
	let positionDraft = $state({ xPx: '', yPx: '' });
	let xPositionInput = $state<HTMLInputElement | null>(null);
	let yPositionInput = $state<HTMLInputElement | null>(null);
	let previewOpacity = $state(0.6);
	let stageWorkspace = $state<HTMLDivElement | null>(null);

	/** One persistent viewport/stage for the manual-correction surface only (the result screen shows the rendered composite as a plain image, not a live scene). */
	let stageVp = new ViewportController();
	let stage = $state<Konva.Stage | null>(null);
	let layer = $state<Konva.Layer | null>(null);
	/** Live tile groups so a drag preview moves the image and its highlight together, and so a tab switch can tween the existing node instead of rebuilding it. */
	let tileNodes = new Map<TileSlot, Konva.Group>();
	/** Live crop-guide nodes, per tile, for the manual surface's Crop tab. */
	let cropGuideTop = new Map<TileSlot, Konva.Rect>();
	let cropGuideBottom = new Map<TileSlot, Konva.Rect>();
	/** True only between a crop-guide dragstart and dragend (Konva-native drag). */
	let cropDragActive = false;
	/**
	 * Custom alignment tile drag claimed from the shared viewport. The node is
	 * moved only after the shared click threshold is exceeded, and any gesture
	 * that ends without a commit (click, pointercancel, pointer-ID mismatch)
	 * reconciles the live node back to the authoritative placements.
	 */
	let tileDrag: {
		slot: TileSlot;
		pointerId: number;
		startScreen: ScreenSpacePoint;
		startPlacement: { xPx: number; yPx: number };
		moved: boolean;
	} | null = null;

	let statusMessage = $state<string | null>(null);
	let exportError = $state<string | null>(null);
	let rendering = $state(false);

	/** Snap is async (backed by `cvMatch`'s matcher); busy while a call is in flight. */
	let snapBusy = $state(false);

	/** Import/pipeline state: transient, never durable. */
	let pipelineError = $state<string | null>(null);
	/**
	 * Adds a small safety margin to the auto-proposed crop so a borderline
	 * chrome pixel (or per-capture-unique status-bar content, e.g. the device
	 * clock) never survives into the shared crop — on by default, since a
	 * slightly deeper crop is far cheaper than a stitch corrupted by leftover
	 * chrome. Decided before import runs, since it affects the pipeline itself,
	 * not just how a proposal is displayed afterward.
	 */
	let addCropMargin = $state(true);

	// ---------------------------------------------------------------------
	// Phase state machine (CHSPT-56 auto-first redesign)
	//
	// Three phases, not five: `import` (gather one or more captures — the
	// SAME entry point for N=1 AutoCrop-only and N>1 AutoCrop+AutoStitch),
	// `processing` (the pipeline's own async call is actually in flight — no
	// artificial timer), `result` (the assembled composite, shown
	// immediately whether `confidence` is `'auto'` or `'review'`). There is
	// no mandatory approval gate between them: a successful pipeline call
	// always lands on `result` on its own.
	// ---------------------------------------------------------------------

	type Phase = 'import' | 'processing' | 'result';
	let phase = $state<Phase>('import');

	/** The last successful pipeline result — the draft/sources the manual-correction surface is seeded from and the badge flash's coordinate space refers back to. */
	let pipelineSuccess = $state<StitchPipelineSuccess | null>(null);
	let resultBlob = $state<Blob | null>(null);
	let resultImageUrl = $state<string | null>(null);
	let resultProvenance = $state<CompositeProvenance | null>(null);
	let resultConfidence = $state<StitchConfidence | null>(null);
	let resultWarnings = $state<readonly string[]>([]);
	/** `resultProvenance.sources[].sourceId` -> the original File it came from, for the handoff's `sourceCaptures` bytes and for hashing on a manual re-render. Kept in sync with `resultProvenance` (auto result or a manually applied one). */
	let resultSourceFiles = new Map<string, File>();

	/**
	 * Per-property manual-edit tracking for `domain/provenance.ts`'s
	 * `SourceCaptureOrigin` (CHSPT-49/55): the crop is one value shared by
	 * every source, so touching it (numeric fields or the drag guides) marks
	 * `origin.crop` `'manual'` for every source at once; a tile's placement
	 * (drag/nudge/numeric/Snap) is independent per slot. Both reset to
	 * untouched whenever a fresh pipeline result is seeded — see
	 * `seedManualFromPipeline`.
	 */
	let manualCropTouched = $state(false);
	let manualTransformTouchedSlots = $state<Set<TileSlot>>(new Set());

	/**
	 * `Adjust manually` — the one control that exposes the full existing
	 * correction surface (crop guides/numeric crop, tile drag/nudge, tile
	 * selection, opacity, Snap, crop-margin/advanced controls). Always
	 * available once a result exists; auto-opened (never silently skipped)
	 * when `confidence === 'review'` so a weak result visibly flags/opens
	 * correction instead of just sitting there looking fine.
	 */
	let manualOpen = $state(false);
	let manualView = $state<'crop' | 'placement'>('placement');

	interface BadgeAnchor {
		readonly holeNumber: number;
		readonly xPx: number;
		readonly yPx: number;
		readonly widthPx: number;
		readonly heightPx: number;
	}
	/** Best-effort hole-number badge anchors for the result screen's flash, in COMPOSITE pixel space — the same space `resultProvenance.outputWidthPx/heightPx` describes. Never gates `Continue to Annotate Course`. */
	let badgeAnchors = $state<BadgeAnchor[]>([]);
	let badgeFlashKey = $state(0);
	/** Guards a slower detection pass from overwriting a newer composite's (empty, until its own pass lands) badge set. */
	let badgeDetectionGeneration = 0;

	/** Lazy main-thread OpenCV/Snap warm-up: fired once, only when the user actually opens the manual-correction surface (or, transitively, clicks Snap) — never merely because the page mounted or an auto result appeared. */
	let cvWarmed = false;
	function ensureCvWarm(): void {
		if (cvWarmed) return;
		cvWarmed = true;
		void loadCv().then((cv) => warmMatchTemplate(cv));
	}

	const required = $derived(sessionDimensions(tiles, activeSlots));
	const croppedValidation = $derived(
		required ? cropSize(crop, required.widthPx, required.heightPx) : null
	);
	const report = $derived(
		readiness(tiles, crop, placements, required, activeSlots, tileNeighbors)
	);
	const invalidCropFields = $derived(computeInvalidCropFields());
	/** Gates "Apply adjustments" in the manual surface — the arrangement must be internally valid before it can be re-rendered. */
	const manualReady = $derived(report.ready && !rendering && invalidCropFields.length === 0);
	/**
	 * Whether the user has actually changed anything this manual session
	 * (CHSPT-57 review finding #3): without this, "Apply adjustments" was
	 * enabled the instant the panel opened on an already-valid seeded
	 * arrangement, so a stray click could silently re-render — and, for any
	 * rotated/scaled source, FLATTEN — a result the user never touched.
	 */
	const manualDirty = $derived(manualCropTouched || manualTransformTouchedSlots.size > 0);
	/**
	 * `buildManualDraftComposite` (`pipelineUiHelpers.ts`) can only ever
	 * produce translation-only transforms — the legacy drag/nudge/numeric
	 * surface has no rotate handle. Applying manual adjustments to a result
	 * that AutoStitch placed with genuine rotation/scale (see
	 * `domain/provenance.ts`'s translation -> similarity -> affine escalation)
	 * therefore straightens every such capture back to a plain offset. That is
	 * an accepted limitation of this surface, not a bug to silently hide — see
	 * the warning shown alongside "Apply adjustments" below.
	 */
	const manualHasRotatedSource = $derived(
		(pipelineSuccess?.draft.sources ?? []).some((source) => source.transform.model !== 'translation')
	);
	/**
	 * Snap assist availability: a selected, loaded movable tile with a valid
	 * shared crop and at least one loaded expected neighbor to match against,
	 * and no Snap call already in flight.
	 */
	const snapAvailable = $derived.by(() => {
		const slot = selectedSlot;
		if (snapBusy) return false;
		if (!slot || !movableSlots.includes(slot) || !tiles[slot] || !placements[slot]) return false;
		if (!croppedValidation?.ok) return false;
		return expectedNeighbors(slot, tileNeighbors).some((neighbor) => Boolean(tiles[neighbor]));
	});

	/** All currently-active slots hold a decoded, dimension-matching tile — the gate for the per-slot grid's own auto-trigger. */
	const importComplete = $derived(
		activeSlots.length > 0 && activeSlots.every((slot) => tiles[slot] !== undefined)
	);

	function addSlot(): void {
		activeSlots = [...activeSlots, `tile-${activeSlots.length}`];
		tileNeighbors = gridNeighbors(activeSlots);
		everActiveSlots.add(activeSlots[activeSlots.length - 1]);
		placementsInitialized = false;
	}

	function setPhase(next: Phase): void {
		phase = next;
	}

	// ---------------------------------------------------------------------

	/** The union of all loaded cropped tile rectangles; the manual placement tab's fit target. */
	function assembledFitTarget(): ViewportFitTarget | null {
		const validation = croppedValidation;
		if (!validation?.ok) return null;
		const rects = activeSlots
			.filter((slot) => tiles[slot] && placements[slot])
			.map((slot) => tileRect(placements[slot]!, validation.widthPx, validation.heightPx));
		const union = unionBounds(rects);
		if (!union) return null;
		return { xPx: union.xPx, yPx: union.yPx, widthPx: union.widthPx, heightPx: union.heightPx };
	}

	/** Filmstrip layout for the manual surface's Crop tab, in original (uncropped) tile pixels: one row, left to right. */
	function filmstripPlacements(): Partial<Record<TileSlot, TilePlacement>> {
		if (!required) return {};
		const gap = Math.max(8, Math.round(required.widthPx * 0.08));
		const result: Partial<Record<TileSlot, TilePlacement>> = {};
		activeSlots.forEach((slot, i) => {
			if (!tiles[slot]) return;
			result[slot] = { xPx: i * (required!.widthPx + gap), yPx: 0, visible: true };
		});
		return result;
	}

	function filmstripFitTarget(): ViewportFitTarget | null {
		if (!required) return null;
		const rects = activeSlots
			.filter((slot) => tiles[slot])
			.map((slot, i, arr) => {
				const gap = Math.max(8, Math.round(required!.widthPx * 0.08));
				const index = activeSlots.indexOf(slot);
				return tileRect(
					{ xPx: index * (required!.widthPx + gap), yPx: 0, visible: true },
					required!.widthPx,
					required!.heightPx
				);
			});
		const union = unionBounds(rects);
		if (!union) return null;
		return { xPx: union.xPx, yPx: union.yPx, widthPx: union.widthPx, heightPx: union.heightPx };
	}

	function computeInvalidCropFields(): CropInsetField[] {
		const invalid: CropInsetField[] = [];
		const parsed: Partial<Record<CropInsetField, number>> = {};
		for (const field of CROP_FIELDS) {
			const raw = cropDraft[field].trim();
			if (!/^\d+$/.test(raw)) {
				invalid.push(field);
				continue;
			}
			const value = parseInt(raw, 10);
			parsed[field] = value;
			if (value < 0) invalid.push(field);
		}
		if (!required) return invalid;
		if (
			parsed.leftPx !== undefined &&
			parsed.rightPx !== undefined &&
			parsed.leftPx + parsed.rightPx >= required.widthPx
		) {
			if (!invalid.includes('leftPx')) invalid.push('leftPx');
			if (!invalid.includes('rightPx')) invalid.push('rightPx');
		}
		if (
			parsed.topPx !== undefined &&
			parsed.bottomPx !== undefined &&
			parsed.topPx + parsed.bottomPx >= required.heightPx
		) {
			if (!invalid.includes('topPx')) invalid.push('topPx');
			if (!invalid.includes('bottomPx')) invalid.push('bottomPx');
		}
		return invalid;
	}

	function syncCropDraft(force = false): void {
		const active = document.activeElement;
		const focused = CROP_FIELDS.some((field) => active === cropInputs[field]);
		if (force || !focused) {
			cropDraft = {
				topPx: String(crop.topPx),
				rightPx: String(crop.rightPx),
				bottomPx: String(crop.bottomPx),
				leftPx: String(crop.leftPx)
			};
		}
	}

	function syncPositionDraft(force = false): void {
		const slot = selectedSlot;
		const placement = slot ? placements[slot] : undefined;
		if (!slot || slot === anchorSlot || !placement) {
			positionDraft = { xPx: '', yPx: '' };
			return;
		}
		if (
			force ||
			(document.activeElement !== xPositionInput && document.activeElement !== yPositionInput)
		) {
			positionDraft = { xPx: String(placement.xPx), yPx: String(placement.yPx) };
		}
	}

	async function handleSlotFile(slot: TileSlot, file: File): Promise<void> {
		// Every selection invalidates earlier in-flight decodes for this slot —
		// even a selection that turns out to be unsupported.
		const generation = decodeCoordinator.begin(slot);
		exportError = null;
		if (!isSupportedMimeType(file.type)) {
			if (decodeCoordinator.isCurrent(slot, generation)) {
				tileErrors = {
					...tileErrors,
					[slot]: `Unsupported file type "${file.type || 'unknown'}": ChainSpot accepts PNG and JPEG images.`
				};
			}
			return;
		}
		const result = await guardedDecode(decodeCoordinator, slot, generation, file, decodeImageFile);
		if (!result.ok) {
			// A stale success or failure must never publish over the newest tile.
			if ('stale' in result) return;
			tileErrors = { ...tileErrors, [slot]: `Could not decode "${file.name}".` };
			return;
		}
		const { image, widthPx, heightPx } = result.decoded;
		if (!Number.isFinite(widthPx) || !Number.isFinite(heightPx) || widthPx <= 0 || heightPx <= 0) {
			tileErrors = {
				...tileErrors,
				[slot]: `"${file.name}" decoded with invalid dimensions (${widthPx} x ${heightPx}); width and height must be greater than zero.`
			};
			return;
		}
		const other = activeSlots.find((candidate) => candidate !== slot && tiles[candidate]);
		if (other) {
			const otherTile = tiles[other];
			if (otherTile && (widthPx !== otherTile.widthPx || heightPx !== otherTile.heightPx)) {
				tileErrors = {
					...tileErrors,
					[slot]: `"${file.name}" is ${widthPx} x ${heightPx} but the session requires ${otherTile.widthPx} x ${otherTile.heightPx}. Recapture all screenshots at the same device orientation and screenshot size.`
				};
				return;
			}
		}
		tiles = {
			...tiles,
			[slot]: { fileName: file.name, mimeType: file.type, widthPx, heightPx, image, file }
		};
		const cleared = { ...tileErrors };
		delete cleared[slot];
		tileErrors = cleared;
		statusMessage = `${slotLabel(slot)} loaded (${widthPx} x ${heightPx}).`;
		// Filling the last active slot is itself the "done" signal for the grid
		// path, exactly like the bulk picker below — no extra click needed.
		if (activeSlots.every((candidate) => tiles[candidate] !== undefined)) {
			const files = activeSlots.map((candidate) => tiles[candidate]!.file);
			void runImport(files);
		}
	}

	/**
	 * CHSPT-65: files picked through the bulk importer, held BEFORE any
	 * crop/stitch runs while the user answers which (if any) is the thrown
	 * round. Each entry carries an object URL for its thumbnail; URLs are
	 * revoked when the prompt resolves, cancels, or the page unmounts. Only
	 * the user-facing file input routes through this — the demo inbox keeps
	 * its direct `runImport` path (a guided demo must never stall on a
	 * question), and the per-slot grid keeps its per-tile buttons.
	 */
	let pendingImport = $state<{ file: File; url: string }[] | null>(null);

	function clearPendingImport(): void {
		if (pendingImport) for (const item of pendingImport) URL.revokeObjectURL(item.url);
		pendingImport = null;
	}

	function handleSmartImportFiles(event: Event): void {
		const input = event.currentTarget as HTMLInputElement;
		const files = Array.from(input.files ?? []);
		input.value = '';
		if (files.length === 0) return;
		// Ask about the thrown round BEFORE attempting any crop/stitch — a
		// round screenshot mixed into the batch must never be composited into
		// the clean map. The prompt shows a thumbnail of each capture.
		clearPendingImport();
		pendingImport = files.map((file) => ({ file, url: URL.createObjectURL(file) }));
	}

	/**
	 * Resolves the pre-import prompt. `index` picks that capture as the thrown
	 * round (raw file into the session slot, remaining captures stitch the
	 * clean map); `null` means no thrown round in this batch — stitch them all
	 * exactly as the importer always did.
	 */
	function handlePreImportChoice(index: number | null): void {
		const pending = pendingImport;
		if (!pending) return;
		const files = pending.map((item) => item.file);
		clearPendingImport();
		if (index === null) {
			void runImport(files);
			return;
		}
		const chosen = files[index];
		if (!chosen) return;
		const replacing = getThrownRoundSource() !== null;
		setThrownRoundSource({ blob: chosen, fileName: chosen.name });
		heldThrownRound = { fileName: chosen.name };
		const remaining = files.filter((_, candidate) => candidate !== index);
		if (remaining.length === 0) {
			statusMessage = `“${chosen.name}” set aside as the thrown round${replacing ? ', replacing the previous one' : ''}. Import the clean course screenshots next.`;
			return;
		}
		void runImport(remaining);
	}

	function handlePreImportCancel(): void {
		clearPendingImport();
		statusMessage = 'Import cancelled. Nothing was stitched.';
	}

	/**
	 * The ONE unified import entry point (CHSPT-55 item 1): calls
	 * `runStitchPipeline` regardless of count — N=1 gets AutoCrop only, N>1
	 * gets AutoCrop+AutoStitch, same call, same phases from here on. Replaces
	 * the old `files.length < 2` rejection and the mandatory review/assemble
	 * ceremony: a successful call renders immediately and lands on `result`
	 * with no forced approval click. `processing` is real async work (the
	 * pipeline call itself), never a `setTimeout` standing in for it.
	 */
	async function runImport(files: File[]): Promise<void> {
		if (files.length === 0) return;
		const generation = decodeCoordinator.begin(SMART_IMPORT_BATCH);
		pipelineError = null;
		exportError = null;
		setPhase('processing');
		try {
			const outcome = await runStitchPipeline(files, { applyCropMargin: addCropMargin });
			if (!decodeCoordinator.isCurrent(SMART_IMPORT_BATCH, generation)) return;
			if (!outcome.ok) {
				pipelineError = outcome.failure.message;
				setPhase('import');
				return;
			}
			await commitPipelineSuccess(outcome.result);
			if (!decodeCoordinator.isCurrent(SMART_IMPORT_BATCH, generation)) return;
		} catch (error) {
			if (!decodeCoordinator.isCurrent(SMART_IMPORT_BATCH, generation)) return;
			pipelineError =
				error instanceof Error ? error.message : 'Could not process the selected screenshots.';
			setPhase('import');
		}
	}

	/**
	 * Renders a successful pipeline result, publishes it as the assembled
	 * result, seeds the manual-correction surface from the same draft/images
	 * (so `Adjust manually` needs no further decode step), and — only when
	 * `confidence === 'review'` — opens that surface automatically so a weak
	 * result visibly flags itself rather than looking indistinguishable from
	 * a confident one. Badge detection is fired off afterward, fully
	 * fire-and-forget.
	 */
	async function commitPipelineSuccess(success: StitchPipelineSuccess): Promise<void> {
		const images = new Map<string, HTMLImageElement>();
		for (const source of success.sources) {
			const decoded = await decodeImageFile(source.file);
			images.set(source.sourceId, decoded.image);
		}
		const { blob, provenance } = await renderPipelineComposite(success.draft, images);
		pipelineSuccess = success;
		if (resultImageUrl) URL.revokeObjectURL(resultImageUrl);
		resultBlob = blob;
		resultImageUrl = URL.createObjectURL(blob);
		resultProvenance = provenance;
		resultConfidence = success.confidence;
		resultWarnings = success.warnings;
		resultSourceFiles = new Map(success.sources.map((source) => [source.sourceId, source.file]));
		seedManualFromPipeline(success, images);
		manualOpen = success.confidence === 'review';
		badgeAnchors = [];
		setPhase('result');
		const countText = `${success.sources.length} capture${success.sources.length === 1 ? '' : 's'}`;
		statusMessage =
			success.confidence === 'auto'
				? `Stitched from ${countText}.`
				: `Stitched from ${countText}. Review recommended — see Adjust manually.`;
		void runBadgeDetection(blob, provenance.outputWidthPx, provenance.outputHeightPx);
	}

	/**
	 * Seeds the legacy shared-crop/per-tile-placement editing model — the
	 * SAME model `Adjust manually`'s crop guides, drag/nudge, and Snap
	 * already operate on — from a pipeline result's sources, reusing the
	 * exact decoded images `commitPipelineSuccess` already produced (no
	 * second decode). `crop` is read back from the FIRST source's own crop
	 * rect: every source in a pipeline-produced draft shares an identical
	 * crop rect by construction (see `stitchPipeline.ts`), so this is exact,
	 * not an approximation.
	 */
	/**
	 * Builds the legacy `TileNeighbors` adjacency from the pipeline's OWN
	 * discovered overlap graph (`DraftComposite.overlaps`, a `SourceOverlapEdge[]`
	 * keyed by `sourceId`) rather than `gridNeighbors`' assumed-rectangular-grid
	 * placeholder. This matters because `assignN`/`poseGraph.ts` orders slots in
	 * seed-then-tree-growth order, not spatial position — `gridNeighbors` applied
	 * to those slot names produces adjacency that has nothing to do with which
	 * tiles actually overlap, which silently fed Snap the wrong neighbor raster
	 * to align against for any non-trivial (non-`gridNeighbors`-shaped) topology.
	 */
	function neighborsFromOverlaps(
		overlaps: readonly { readonly a: string; readonly b: string }[],
		slotBySourceId: ReadonlyMap<string, TileSlot>,
		slots: readonly TileSlot[]
	): TileNeighbors {
		const neighbors: Record<TileSlot, TileSlot[]> = {};
		for (const slot of slots) neighbors[slot] = [];
		for (const edge of overlaps) {
			const slotA = slotBySourceId.get(edge.a);
			const slotB = slotBySourceId.get(edge.b);
			if (!slotA || !slotB) continue;
			if (!neighbors[slotA].includes(slotB)) neighbors[slotA].push(slotB);
			if (!neighbors[slotB].includes(slotA)) neighbors[slotB].push(slotA);
		}
		return neighbors;
	}

	function seedManualFromPipeline(
		success: StitchPipelineSuccess,
		images: ReadonlyMap<string, HTMLImageElement>
	): void {
		const slots = success.sources.map((_, index) => `tile-${index}`);
		const slotBySourceId = new Map<string, TileSlot>(
			success.sources.map((source, index) => [source.sourceId, slots[index]])
		);
		const nextTiles: Partial<Record<TileSlot, StitchTile>> = {};
		const nextPlacements: Partial<Record<TileSlot, TilePlacement>> = {};
		success.sources.forEach((source: DraftSourceCapture, index) => {
			const slot = slots[index];
			const image = images.get(source.sourceId);
			if (!image) return;
			nextTiles[slot] = {
				fileName: source.fileName,
				mimeType: source.mimeType,
				widthPx: source.widthPx,
				heightPx: source.heightPx,
				image,
				file: source.file
			};
			nextPlacements[slot] = {
				xPx: Math.round(source.transform.coefficients[4]),
				yPx: Math.round(source.transform.coefficients[5]),
				visible: true
			};
		});
		activeSlots = slots;
		tileNeighbors =
			slots.length > 1
				? neighborsFromOverlaps(success.draft.overlaps, slotBySourceId, slots)
				: gridNeighbors(slots);
		everActiveSlots = new Set(slots);
		tiles = nextTiles;
		tileErrors = {};
		placements = nextPlacements;
		placementsInitialized = true;
		selectedSlot = null;
		const first = success.sources[0];
		crop = first
			? {
					topPx: first.crop.yPx,
					leftPx: first.crop.xPx,
					rightPx: Math.max(0, first.widthPx - first.crop.xPx - first.crop.widthPx),
					bottomPx: Math.max(0, first.heightPx - first.crop.yPx - first.crop.heightPx)
				}
			: { ...ZERO_CROP };
		syncCropDraft(true);
		syncPositionDraft(true);
		manualView = 'placement';
		// A fresh pipeline result is entirely automatic until the user actually
		// edits something in this new session.
		manualCropTouched = false;
		manualTransformTouchedSlots = new Set();
	}

	/** Hashes every active slot's original capture bytes, for the manual `DraftComposite`'s required `sha256` field. */
	async function computeHashesBySlot(): Promise<Map<TileSlot, Sha256Hex>> {
		const entries = await Promise.all(
			activeSlots
				.filter((slot) => tiles[slot])
				.map(async (slot) => {
					const bytes = await readFileBytes(tiles[slot]!.file);
					const hash = await sha256Hex(bytes);
					return [slot, hash] as const;
				})
		);
		return new Map(entries);
	}

	/**
	 * Re-renders the manual-correction surface's current shared-crop/
	 * placement state through the SAME `renderPipelineComposite` the
	 * automatic result used — auto and manual share one rendering path, per
	 * `pipelineResult.ts`'s locked contract. Replaces the visible result and
	 * re-fires (fire-and-forget) badge detection against the new composite.
	 * A user-applied manual arrangement is treated as resolved: `confidence`
	 * resets to `'auto'` and every automatic warning is cleared, since a
	 * human just confirmed the placement directly.
	 */
	async function applyManualAdjustments(): Promise<void> {
		if (!manualReady || !manualDirty) return;
		exportError = null;
		rendering = true;
		try {
			const hashesBySlot = await computeHashesBySlot();
			const draft = buildManualDraftComposite({
				slots: activeSlots,
				tiles,
				placements,
				crop,
				hashesBySlot,
				cropTouched: manualCropTouched,
				transformTouchedSlots: manualTransformTouchedSlots
			});
			if (!draft) {
				throw new Error('Could not build a composite from the current arrangement.');
			}
			const sourcesMap = new Map<string, HTMLImageElement>();
			for (const slot of activeSlots) {
				const tile = tiles[slot];
				if (tile) sourcesMap.set(slot, tile.image);
			}
			const { blob, provenance } = await renderPipelineComposite(draft, sourcesMap);
			if (resultImageUrl) URL.revokeObjectURL(resultImageUrl);
			resultBlob = blob;
			resultImageUrl = URL.createObjectURL(blob);
			resultProvenance = provenance;
			resultConfidence = 'auto';
			resultWarnings = [];
			resultSourceFiles = new Map(
				activeSlots.filter((slot) => tiles[slot]).map((slot) => [slot, tiles[slot]!.file])
			);
			manualOpen = false;
			badgeAnchors = [];
			statusMessage = 'Manual adjustments applied to the stitched result.';
			void runBadgeDetection(blob, provenance.outputWidthPx, provenance.outputHeightPx);
		} catch (error) {
			exportError =
				error instanceof Error ? error.message : 'Could not render the adjusted composite.';
		} finally {
			rendering = false;
		}
	}

	/**
	 * Best-effort hole-number-badge detection against the assembled
	 * composite, reusing the existing production worker request
	 * (`basketDetection.worker.ts`'s `'detect-course'` kind, via
	 * `detectCourseCandidates`) — never the CV internals directly. Explicitly
	 * NOT a correctness gate: a missing/empty/failed detection never blocks
	 * or delays anything on the result screen, it just means no flash. Fired
	 * with the composite's own `widthPx`/`heightPx`, so every returned
	 * anchor already lands in composite pixel space — the same space the
	 * assembled result image is displayed in.
	 */
	async function runBadgeDetection(blob: Blob, widthPx: number, heightPx: number): Promise<void> {
		const generation = (badgeDetectionGeneration += 1);
		try {
			const bytes = new Uint8Array(await blob.arrayBuffer());
			const course = await detectCourseCandidates(bytes, blob.type || 'image/png', widthPx, heightPx);
			if (generation !== badgeDetectionGeneration) return; // superseded by a newer composite
			const labeled = course.numberDetection.candidates.filter(
				(candidate): candidate is typeof candidate & { label: number } => candidate.label !== undefined
			);
			badgeAnchors = labeled.map((candidate) => ({
				holeNumber: candidate.label,
				xPx: candidate.xPx,
				yPx: candidate.yPx,
				widthPx: candidate.widthPx,
				heightPx: candidate.heightPx
			}));
			badgeFlashKey += 1;
		} catch {
			// Fire-and-forget: swallow errors, never surface them, never block
			// Continue to Annotate Course.
		}
	}

	function handleRemove(slot: TileSlot): void {
		// Any in-flight decode for this slot must never publish its result.
		decodeCoordinator.invalidate(slot);
		if (!tiles[slot]) return;
		const next = { ...tiles };
		delete next[slot];
		tiles = next;
		const cleared = { ...tileErrors };
		delete cleared[slot];
		tileErrors = cleared;
		if (selectedSlot === slot) {
			selectedSlot = null;
			syncPositionDraft(true);
		}
		if (!activeSlots.some((candidate) => tiles[candidate])) resetToImport();
		statusMessage = `${slotLabel(slot)} removed.`;
	}

	function resetToImport(): void {
		// No in-flight decode or import batch may publish into the cleared
		// session; every slot ever active this session is invalidated, not just
		// the current active set, in case a prior (possibly larger) session left
		// a stale generation behind.
		decodeCoordinator.invalidateAll([...everActiveSlots]);
		decodeCoordinator.invalidate(SMART_IMPORT_BATCH);
		activeSlots = [...defaultSlotOrder(4)];
		tileNeighbors = gridNeighbors(activeSlots);
		everActiveSlots = new Set(activeSlots);
		tiles = {};
		tileErrors = {};
		crop = { ...ZERO_CROP };
		syncCropDraft(true);
		placements = initialPlacements(activeSlots, 1, 1);
		placementsInitialized = false;
		selectedSlot = null;
		positionDraft = { xPx: '', yPx: '' };
		previewOpacity = 0.6;
		exportError = null;
		pipelineError = null;
		pipelineSuccess = null;
		if (resultImageUrl) URL.revokeObjectURL(resultImageUrl);
		resultImageUrl = null;
		resultBlob = null;
		resultProvenance = null;
		resultConfidence = null;
		resultWarnings = [];
		resultSourceFiles = new Map();
		manualCropTouched = false;
		manualTransformTouchedSlots = new Set();
		manualOpen = false;
		manualView = 'placement';
		badgeAnchors = [];
		// A reset is a session boundary exactly like the decode-coordinator
		// invalidation above: any badge detection still in flight for the
		// cleared session must never publish into whatever comes next.
		badgeDetectionGeneration += 1;
		phase = 'import';
		statusMessage = 'All screenshots cleared. Ready for a new import.';
	}

	function handleCropInput(field: CropInsetField, event: Event): void {
		cropDraft = { ...cropDraft, [field]: (event.currentTarget as HTMLInputElement).value };
	}

	function commitCrop(field: CropInsetField): void {
		const raw = cropDraft[field].trim();
		if (!/^\d+$/.test(raw)) {
			syncCropDraft(true);
			return;
		}
		const value = parseInt(raw, 10);
		crop = { ...crop, [field]: value };
		syncCropDraft(true);
		manualCropTouched = true;
	}

	function resetCrop(): void {
		crop = { ...ZERO_CROP };
		syncCropDraft(true);
		manualCropTouched = true;
		statusMessage = 'Shared crop reset.';
	}

	// ---------------------------------------------------------------------
	// Crop-line close-up preview: a small per-tile magnified strip centered on
	// the exact boundary pixel, with a marker line at the cut itself. At the
	// manual surface's normal zoom a 1-2px chrome misread is invisible, and
	// getting that line wrong crops either real map content or leaves a sliver
	// of chrome in the stitched output — this exists so a user can actually
	// see the pixel the crop commits to, on every tile, before trusting it.
	// ---------------------------------------------------------------------

	const CROP_ZOOM_SOURCE_WIDTH_PX = 24;
	const CROP_ZOOM_ROWS_ABOVE = 8;
	const CROP_ZOOM_ROWS_BELOW = 8;
	const CROP_ZOOM_SCALE = 8;

	function drawCropZoomStrip(
		canvas: HTMLCanvasElement,
		image: HTMLImageElement,
		imageWidthPx: number,
		imageHeightPx: number,
		boundaryY: number,
		edge: 'top' | 'bottom'
	): void {
		const ctx = canvas.getContext('2d');
		if (!ctx) return;
		const srcW = Math.min(CROP_ZOOM_SOURCE_WIDTH_PX, imageWidthPx);
		const srcH = Math.min(CROP_ZOOM_ROWS_ABOVE + CROP_ZOOM_ROWS_BELOW, imageHeightPx);
		const width = srcW * CROP_ZOOM_SCALE;
		const height = srcH * CROP_ZOOM_SCALE;
		canvas.width = width;
		canvas.height = height;
		ctx.imageSmoothingEnabled = false;
		const srcX = Math.min(
			Math.max(0, imageWidthPx - srcW),
			Math.max(0, Math.round((imageWidthPx - srcW) / 2))
		);
		const srcY = Math.min(
			Math.max(0, imageHeightPx - srcH),
			Math.max(0, boundaryY - CROP_ZOOM_ROWS_ABOVE)
		);
		ctx.clearRect(0, 0, width, height);
		ctx.drawImage(image, srcX, srcY, srcW, srcH, 0, 0, width, height);

		const boundaryCanvasY = (boundaryY - srcY) * CROP_ZOOM_SCALE;

		ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
		if (edge === 'top') {
			ctx.fillRect(0, 0, width, boundaryCanvasY);
		} else {
			ctx.fillRect(0, boundaryCanvasY, width, height - boundaryCanvasY);
		}

		ctx.strokeStyle = 'rgba(255, 255, 255, 0.22)';
		ctx.lineWidth = 1;
		for (let row = 0; row <= srcH; row += 1) {
			const y = Math.round(row * CROP_ZOOM_SCALE) + 0.5;
			ctx.beginPath();
			ctx.moveTo(0, y);
			ctx.lineTo(width, y);
			ctx.stroke();
		}

		const keptRowY = edge === 'top' ? boundaryCanvasY : boundaryCanvasY - CROP_ZOOM_SCALE;
		ctx.lineWidth = 2;
		ctx.strokeStyle = '#4ade80';
		ctx.strokeRect(1, keptRowY + 1, width - 2, CROP_ZOOM_SCALE - 2);

		ctx.strokeStyle = '#facc15';
		ctx.lineWidth = 1;
		ctx.beginPath();
		ctx.moveTo(0, Math.round(boundaryCanvasY) + 0.5);
		ctx.lineTo(width, Math.round(boundaryCanvasY) + 0.5);
		ctx.stroke();
	}

	interface CropZoomParams {
		readonly image: HTMLImageElement;
		readonly imageWidthPx: number;
		readonly imageHeightPx: number;
		readonly boundaryY: number;
		readonly edge: 'top' | 'bottom';
	}

	/** Svelte action: draws the close-up strip on mount and redraws whenever the boundary/tile changes. */
	function cropZoom(node: HTMLCanvasElement, params: CropZoomParams): { update(next: CropZoomParams): void } {
		const draw = (p: CropZoomParams): void =>
			drawCropZoomStrip(node, p.image, p.imageWidthPx, p.imageHeightPx, p.boundaryY, p.edge);
		draw(params);
		return { update: draw };
	}

	function updateCropDrag(field: CropInsetField, value: number): void {
		crop = { ...crop, [field]: value };
		syncCropDraft(false);
		manualCropTouched = true;
	}

	function endCropDrag(): void {
		syncCropDraft(true);
	}

	function updatePlacement(slot: TileSlot, xPx: number, yPx: number): void {
		const placement = placements[slot];
		if (slot === anchorSlot || !tiles[slot] || !placement) return;
		placements = { ...placements, [slot]: { ...placement, xPx, yPx } };
		syncPositionDraft(true);
		// The one mutation point drag/nudge/numeric input/Snap all share (see
		// their own doc comments) — marking `slot`'s transform manual here
		// covers every one of them without special-casing each caller.
		manualTransformTouchedSlots = new Set(manualTransformTouchedSlots).add(slot);
	}

	function selectSlot(slot: TileSlot | null): void {
		if (slot !== null && (slot === anchorSlot || !tiles[slot])) return;
		selectedSlot = slot;
		syncPositionDraft(true);
		if (slot) stageWorkspace?.focus();
	}

	function handlePositionInput(field: 'xPx' | 'yPx', event: Event): void {
		positionDraft = { ...positionDraft, [field]: (event.currentTarget as HTMLInputElement).value };
	}

	function commitPosition(field: 'xPx' | 'yPx'): void {
		const slot = selectedSlot;
		const placement = slot ? placements[slot] : undefined;
		if (!slot || slot === anchorSlot || !placement) return;
		const raw = positionDraft[field].trim();
		// Signed base-10 integers only: tiles may sit left or above the anchor.
		if (!/^[+-]?\d+$/.test(raw)) {
			syncPositionDraft(true);
			return;
		}
		const value = parseInt(raw, 10);
		updatePlacement(
			slot,
			field === 'xPx' ? value : placement.xPx,
			field === 'yPx' ? value : placement.yPx
		);
	}

	/**
	 * Scoped arrow-key nudge: only fires when the stage workspace itself owns
	 * focus, never from bubbled events on descendant controls or editable fields.
	 */
	function handleStageKeyDown(event: KeyboardEvent): void {
		if (event.target !== event.currentTarget) return;
		if (isEditableTarget(event.target)) return;
		if (manualView !== 'placement') return;
		const slot = selectedSlot;
		const placement = slot ? placements[slot] : undefined;
		if (!slot || slot === anchorSlot || !placement) return;
		const amount = event.shiftKey ? 10 : 1;
		let dx = 0;
		let dy = 0;
		switch (event.key) {
			case 'ArrowLeft':
				dx = -amount;
				break;
			case 'ArrowRight':
				dx = amount;
				break;
			case 'ArrowUp':
				dy = -amount;
				break;
			case 'ArrowDown':
				dy = amount;
				break;
			default:
				return;
		}
		event.preventDefault();
		updatePlacement(slot, placement.xPx + dx, placement.yPx + dy);
	}

	function toggleTileVisible(slot: TileSlot): void {
		const placement = placements[slot];
		if (!placement) return;
		placements = {
			...placements,
			[slot]: { ...placement, visible: !placement.visible }
		};
	}

	function visibilityToggleLabel(): string {
		const slot = selectedSlot;
		const placement = slot ? placements[slot] : undefined;
		if (!slot || !placement) return 'Show/hide tile (preview)';
		return placement.visible
			? `Hide ${slotLabel(slot)} (preview)`
			: `Show ${slotLabel(slot)} (preview)`;
	}

	function resetArrangement(): void {
		const validation = croppedValidation;
		if (!validation?.ok) return;
		placements = initialPlacements(activeSlots, validation.widthPx, validation.heightPx);
		syncPositionDraft(true);
		// Every movable tile's placement just changed away from wherever it was.
		manualTransformTouchedSlots = new Set([...manualTransformTouchedSlots, ...movableSlots]);
		statusMessage = 'Arrangement reset to the 25% overlap layout.';
	}

	/**
	 * Builds one Snap raster from a tile's current crop interior, at the
	 * standard full-resolution matcher raster size. The same shared insets
	 * apply to every tile, so relative geometry is unchanged and Snap matches
	 * what is actually visible, not hidden chrome; a ZERO_CROP session uses
	 * the full frame automatically.
	 */
	function buildSnapRaster(
		tile: StitchTile,
		validation: { widthPx: number; heightPx: number }
	): AnalysisRaster {
		return toAnalysisRaster(tile.image, DEFAULT_MAX_ANALYSIS_DIM, {
			x: crop.leftPx,
			y: crop.topPx,
			width: validation.widthPx,
			height: validation.heightPx
		});
	}

	/**
	 * Manual-correction "Snap" assist: once the selected tile is roughly in
	 * place (drag/nudge, or the automatic result's placement), a bounded
	 * local search locks it to the best nearby offset against its loaded
	 * expected neighbor(s). Backed by `cvMatch.ts`'s `matchTemplate` matcher.
	 * Async because the matcher is; `snapBusy` disables the control for the
	 * duration. Commits through `updatePlacement` — the one mutation point
	 * drag/nudge/numeric input already use.
	 */
	async function snapSelectedTile(): Promise<void> {
		ensureCvWarm();
		const slot = selectedSlot;
		if (!slot || !movableSlots.includes(slot)) return;
		const tile = tiles[slot];
		const placement = placements[slot];
		const validation = croppedValidation;
		if (!tile || !placement || !validation?.ok) return;
		const neighbors: SnapNeighbor[] = [];
		for (const neighborSlot of expectedNeighbors(slot, tileNeighbors)) {
			const neighborTile = tiles[neighborSlot];
			const neighborPlacement = placements[neighborSlot];
			if (!neighborTile || !neighborPlacement) continue;
			neighbors.push({
				raster: buildSnapRaster(neighborTile, validation),
				xPx: neighborPlacement.xPx,
				yPx: neighborPlacement.yPx
			});
		}
		if (neighbors.length === 0) return;
		snapBusy = true;
		statusMessage = `Snapping ${slotLabel(slot)}…`;
		try {
			const result = await snapAlign(
				buildSnapRaster(tile, validation),
				neighbors,
				placement.xPx,
				placement.yPx
			);
			// The selection or its tile may have changed while the match ran;
			// never commit a stale result onto a different tile.
			if (selectedSlot !== slot || !tiles[slot]) return;
			updatePlacement(slot, result.xPx, result.yPx);
			statusMessage = `${slotLabel(slot)} snapped to the best nearby match against ${
				neighbors.length > 1 ? 'its neighbors' : 'its neighbor'
			} (match strength ${Math.round(result.score * 100)}%).`;
		} finally {
			snapBusy = false;
		}
	}

	/**
	 * Alignment gesture arbitration (shared viewport claim): a pointer that begins
	 * inside the currently selected, visible, movable tile claims the gesture for
	 * tile movement — even when other tiles cover the point. Only active in the
	 * manual surface's Position tab.
	 */
	function claimAlignmentPointer(pointer: ScreenSpacePoint, event: PointerEvent): boolean {
		if (manualView !== 'placement') return false;
		const slot = selectedSlot;
		const validation = croppedValidation;
		if (!slot || slot === anchorSlot || !validation?.ok) return false;
		const placement = placements[slot];
		const tile = tiles[slot];
		if (!placement?.visible || !tile) return false;
		const rect = tileRect(placement, validation.widthPx, validation.heightPx);
		const image = stageVp.toImage(pointer);
		if (!pointInTileRect(image, rect)) return false;
		tileDrag = {
			slot,
			pointerId: event.pointerId,
			startScreen: pointer,
			startPlacement: { xPx: placement.xPx, yPx: placement.yPx },
			moved: false
		};
		window.addEventListener('pointermove', handleTileDragMove);
		window.addEventListener('pointerup', handleTileDragEnd);
		window.addEventListener('pointercancel', handleTileDragCancel);
		return true;
	}

	function pointInTileRect(
		point: ImageSpacePoint,
		rect: { xPx: number; yPx: number; widthPx: number; heightPx: number }
	): boolean {
		return (
			point.xPx >= rect.xPx &&
			point.xPx < rect.xPx + rect.widthPx &&
			point.yPx >= rect.yPx &&
			point.yPx < rect.yPx + rect.heightPx
		);
	}

	/**
	 * Live tile drag preview: the node stays at its committed placement until the
	 * shared click threshold is exceeded, then follows the drag delta applied to
	 * the starting placement (never the grab point). Scene state never changes
	 * mid-gesture, so no rebuild interrupts the drag.
	 */
	function handleTileDragMove(event: PointerEvent): void {
		if (!tileDrag) return;
		if (event.pointerId !== tileDrag.pointerId) {
			endTileDrag();
			reconcileTileDrag();
			return;
		}
		const screen = stageVp.pointerIn(event);
		if (
			!tileDrag.moved &&
			Math.hypot(screen.x - tileDrag.startScreen.x, screen.y - tileDrag.startScreen.y) >
				clickSlopPx(event.pointerType)
		) {
			tileDrag.moved = true;
		}
		if (!tileDrag.moved) return;
		const dx = (screen.x - tileDrag.startScreen.x) / stageVp.view.zoom;
		const dy = (screen.y - tileDrag.startScreen.y) / stageVp.view.zoom;
		const node = tileNodes.get(tileDrag.slot);
		if (!node) return;
		const next = stageVp.toScreen({
			xPx: tileDrag.startPlacement.xPx + dx,
			yPx: tileDrag.startPlacement.yPx + dy
		});
		node.position({ x: next.x, y: next.y });
	}

	function handleTileDragEnd(event: PointerEvent): void {
		if (!tileDrag) return;
		const drag = tileDrag;
		endTileDrag();
		if (event.pointerId !== drag.pointerId) {
			reconcileTileDrag();
			return;
		}
		// A click on the selected tile (movement within the shared threshold)
		// selects nothing new and must never move or commit the tile.
		if (!drag.moved) {
			reconcileTileDrag();
			return;
		}
		const screen = stageVp.pointerIn(event);
		const dx = (screen.x - drag.startScreen.x) / stageVp.view.zoom;
		const dy = (screen.y - drag.startScreen.y) / stageVp.view.zoom;
		// The drag delta applies to the tile's committed position; the grab point
		// inside the tile is only the anchor for the preview.
		const placement = placements[drag.slot];
		if (!placement) return;
		// Final placements are committed as integer cropped-image pixels.
		updatePlacement(drag.slot, placement.xPx + Math.round(dx), placement.yPx + Math.round(dy));
	}

	/** pointercancel must never commit; the live node returns to its placement. */
	function handleTileDragCancel(): void {
		if (!tileDrag) return;
		endTileDrag();
		reconcileTileDrag();
	}

	/** Restores the live node from the authoritative placements after a no-commit end. */
	function reconcileTileDrag(): void {
		renderStage();
	}

	function endTileDrag(): void {
		tileDrag = null;
		if (typeof window === 'undefined') return;
		window.removeEventListener('pointermove', handleTileDragMove);
		window.removeEventListener('pointerup', handleTileDragEnd);
		window.removeEventListener('pointercancel', handleTileDragCancel);
	}

	/**
	 * Click selection in the manual surface's Position tab: selects a movable
	 * tile only when the point lies inside exactly one visible tile — the
	 * anchored tile participates in ambiguity even though it can never be
	 * selected. Hidden tiles are never selectable.
	 */
	function onStageClick(pointer: ScreenSpacePoint): void {
		if (manualView !== 'placement') return;
		const validation = croppedValidation;
		if (!validation?.ok) return;
		const image = stageVp.toImage(pointer);
		const hits = activeSlots.filter((slot) => {
			const placement = placements[slot];
			if (!placement?.visible || !tiles[slot]) return false;
			return pointInTileRect(image, tileRect(placement, validation.widthPx, validation.heightPx));
		});
		if (hits.length === 1 && hits[0] !== anchorSlot) selectSlot(hits[0]);
	}

	/** Crop-guide claim (manual surface's Crop tab only): only Konva guide nodes claim; everything else pans. */
	function claimCropGuidePointer(pointer: ScreenSpacePoint): boolean {
		if (manualView !== 'crop') return false;
		const activeStage = stage;
		if (!activeStage) return false;
		const hit = activeStage.getIntersection(pointer);
		if (!hit) return false;
		return [...cropGuideTop.values(), ...cropGuideBottom.values()].includes(hit as Konva.Rect);
	}

	function claimStagePointer(pointer: ScreenSpacePoint, event: PointerEvent): boolean {
		if (manualView === 'crop') return claimCropGuidePointer(pointer);
		if (manualView === 'placement') return claimAlignmentPointer(pointer, event);
		return false;
	}

	function handleDownload(): void {
		if (!resultBlob) return;
		const url = URL.createObjectURL(resultBlob);
		const anchor = document.createElement('a');
		anchor.href = url;
		anchor.download = resultFileName();
		document.body.appendChild(anchor);
		anchor.click();
		anchor.remove();
		URL.revokeObjectURL(url);
		statusMessage = 'Stitched PNG downloaded.';
	}

	function resultFileName(): string {
		return stitchedFileName(pipelineSuccess?.sources ?? []);
	}

	/**
	 * The original, unmodified bytes of every capture `resultProvenance.sources`
	 * references, keyed by `sourceId` — `PendingHandoff.sourceCaptures`'s exact
	 * shape (CHSPT-49: original captures must never be discarded once a
	 * composite replaces them). `resultSourceFiles` is kept in sync with
	 * whichever draft actually produced `resultProvenance` (the automatic
	 * result, or a manually applied one — see `commitPipelineSuccess` /
	 * `applyManualAdjustments`).
	 */
	async function buildSourceCapturesMap(): Promise<ReadonlyMap<string, Uint8Array> | undefined> {
		const provenance = resultProvenance;
		if (!provenance) return undefined;
		const entries = await Promise.all(
			provenance.sources.map(async (source) => {
				const file = resultSourceFiles.get(source.sourceId);
				if (!file) return null;
				return [source.sourceId, await readFileBytes(file)] as const;
			})
		);
		const resolved = entries.filter((entry): entry is readonly [string, Uint8Array] => entry !== null);
		return resolved.length > 0 ? new Map(resolved) : undefined;
	}

	function handoffDestination(role: ImageRole): string {
		return role === 'source-overview' ? `${base}/annotate-course` : `${base}/create-graphics`;
	}

	function handoffDestinationName(role: ImageRole): string {
		return role === 'source-overview' ? 'Annotate Course' : 'Create Graphics';
	}

	function handleUseAs(role: ImageRole): void {
		if (!resultBlob) return;
		const existing = getPendingHandoff();
		if (existing) {
			statusMessage = `A stitched image is already awaiting import in ${handoffDestinationName(existing.targetRole)}. Import or dismiss it before creating another handoff.`;
			return;
		}
		void runHandoff(role);
	}

	/**
	 * CHSPT-55 item 8: reuses the existing `setPendingHandoff` mechanism
	 * (`session.ts`, already used by "Use as UDisc source"/"Use as clean
	 * target"), extended with this result's `CompositeProvenance` and the
	 * original capture bytes it references (`sourceCaptures`) — both fields
	 * Agent A's `PendingHandoff` extension (CHSPT-49/55) already carries.
	 * `provenance`/`sourceCaptures` are only meaningful for a
	 * `source-overview` handoff (Stitch Map never produces a
	 * `target-basemap`), matching that field's own doc comment.
	 */
	async function runHandoff(role: ImageRole): Promise<void> {
		if (!resultBlob) return;
		exportError = null;
		rendering = true;
		try {
			const isSourceOverview = role === 'source-overview';
			const handoff: PendingHandoff = {
				blob: resultBlob,
				fileName: resultFileName(),
				targetRole: role,
				destination: isSourceOverview ? 'annotate-course' : 'create-graphics',
				provenance: isSourceOverview ? (resultProvenance ?? undefined) : undefined,
				sourceCaptures: isSourceOverview ? await buildSourceCapturesMap() : undefined
			};
			setPendingHandoff(handoff);
			statusMessage = `Stitched image handed to ${handoffDestinationName(role)}.`;
			await goto(handoffDestination(role));
		} catch (error) {
			exportError = error instanceof Error ? error.message : 'Could not hand off the stitched image.';
		} finally {
			rendering = false;
		}
	}

	/**
	 * CHSPT-65: page-local mirror of the session's thrown-round slot, kept so
	 * the held-round indicator is reactive (the session module is plain
	 * variables). Synced on mount and by every handler that writes the slot.
	 */
	let heldThrownRound = $state<{ fileName: string } | null>(null);

	/**
	 * CHSPT-65: keeps the current result as the *thrown-round* source — the
	 * played-round screenshot with UDisc's purple throw/walk graphics — in its
	 * own session slot (`setThrownRoundSource`), semantically distinct from the
	 * clean course/map source that travels via `setPendingHandoff`. The slot is
	 * long-lived and never enters any image-intake path, so keeping a thrown
	 * round neither blocks nor replaces a clean-source handoff (and vice
	 * versa). After keeping, the page resets to Import so the user can bring in
	 * the clean course screenshots next; the kept image itself is safe in the
	 * session slot. Which image is "thrown" is the user's explicit choice —
	 * automatic purple-path classification is a separate ticket.
	 */
	function handleKeepAsThrownRound(): void {
		if (!resultBlob) return;
		const replacing = getThrownRoundSource() !== null;
		const fileName = resultFileName();
		setThrownRoundSource({
			blob: resultBlob,
			fileName,
			provenance: resultProvenance ?? undefined
		});
		heldThrownRound = { fileName };
		resetToImport();
		statusMessage = replacing
			? 'Thrown-round image replaced. It will ride along into Create Graphics. Import the clean course screenshots next.'
			: 'Thrown-round image kept. It will ride along into Create Graphics. Import the clean course screenshots next.';
	}

	/**
	 * CHSPT-65: manual per-tile selector for a round screenshot imported
	 * TOGETHER with the clean-map tiles. The tile's ORIGINAL file bytes go
	 * into the thrown-round session slot (no crop, no stitch — nothing has
	 * been derived from it yet) and the tile leaves the stitch layout via the
	 * existing removal path, so the clean composite is built without it. This
	 * and "Keep as thrown round" on the result write the same slot; within
	 * the thrown role the newest choice wins.
	 */
	function handleMarkTileAsThrownRound(slot: TileSlot): void {
		const tile = tiles[slot];
		if (!tile) return;
		const replacing = getThrownRoundSource() !== null;
		setThrownRoundSource({ blob: tile.file, fileName: tile.fileName });
		heldThrownRound = { fileName: tile.fileName };
		handleRemove(slot);
		statusMessage = replacing
			? `“${tile.fileName}” is now the thrown round (replacing the previous one). It will ride along into Create Graphics; the remaining screenshots stitch the clean map.`
			: `“${tile.fileName}” set aside as the thrown round. It will ride along into Create Graphics; the remaining screenshots stitch the clean map.`;
	}

	/** CHSPT-65: the indicator's explicit discard — the only production clear besides the workflow-staleness lifecycle in session.ts. */
	function handleClearThrownRound(): void {
		clearThrownRoundSource();
		heldThrownRound = null;
		statusMessage = 'Thrown-round image discarded.';
	}

	/**
	 * CHSPT-65: manual selector for the bulk Smart Import path. Round + clean
	 * tiles imported in ONE batch land directly on the stitched result with
	 * the round already composited in — the per-tile button in the Import
	 * grid is never seen. This picks one ORIGINAL capture out of the result:
	 * its raw file goes to the thrown-round slot, and the clean map is
	 * re-stitched from the remaining captures through the exact same
	 * `runImport` pipeline (whose completion overwrites `statusMessage`, so
	 * this sets its own message after awaiting it). With no remaining
	 * captures the page returns to Import instead.
	 */
	async function handleMarkResultSourceAsThrownRound(sourceId: string): Promise<void> {
		const source = resultProvenance?.sources.find((candidate) => candidate.sourceId === sourceId);
		const file = resultSourceFiles.get(sourceId);
		if (!source || !file || rendering) return;
		setThrownRoundSource({ blob: file, fileName: source.fileName });
		heldThrownRound = { fileName: source.fileName };
		const remaining = [...resultSourceFiles.entries()]
			.filter(([id]) => id !== sourceId)
			.map(([, remainingFile]) => remainingFile);
		if (remaining.length === 0) {
			resetToImport();
			statusMessage = `“${source.fileName}” set aside as the thrown round. Import the clean course screenshots next.`;
			return;
		}
		await runImport(remaining);
		statusMessage = `“${source.fileName}” set aside as the thrown round. Clean map re-stitched from the remaining ${remaining.length} screenshot${remaining.length === 1 ? '' : 's'}.`;
	}

	function readinessText(): string {
		if (report.ready) {
			return 'All screenshots, the shared crop, and tile overlap are valid.';
		}
		const reasons: string[] = [];
		if (report.missing.length > 0) {
			reasons.push(`Missing: ${report.missing.map((slot) => slotLabel(slot)).join(', ')}`);
		}
		if (report.dimensionMismatch.length > 0) reasons.push('Screenshots must share one size.');
		if (report.invalidCrop) reasons.push('The shared crop is invalid.');
		if (report.disconnected.length > 0) {
			reasons.push(
				`Every movable tile must connect to the ${slotLabel(anchorSlot).toLowerCase()} tile through overlapping neighbors.`
			);
		}
		if (invalidCropFields.length > 0) reasons.push('The crop fields contain invalid values.');
		return `Not ready to apply: ${reasons.join('; ')}.`;
	}

	// ---------------------------------------------------------------------
	// Unified Konva scene for the manual-correction surface only
	// ---------------------------------------------------------------------

	function reviewGuideY(field: 'topPx' | 'bottomPx', tileTopScreenY: number, tileHeightScreenPx: number): number {
		if (!required) return tileTopScreenY;
		const scale = tileHeightScreenPx / required.heightPx;
		return field === 'topPx'
			? tileTopScreenY + crop.topPx * scale
			: tileTopScreenY + tileHeightScreenPx - crop.bottomPx * scale;
	}

	function reviewValueFromGuideY(field: 'topPx' | 'bottomPx', guideScreenY: number): number {
		if (!required) return 0;
		const layout = filmstripPlacements();
		// Every tile shares the same scale/row in the filmstrip, so any one
		// placement's screen transform is representative.
		const anySlot = activeSlots.find((slot) => layout[slot]);
		const placement = anySlot ? layout[anySlot] : undefined;
		if (!placement) return 0;
		const view = stageVp.view;
		const tileTopScreenY = placement.yPx * view.zoom + view.panY;
		const scale = view.zoom;
		const fromTop = (guideScreenY - tileTopScreenY) / scale;
		const value =
			field === 'topPx' ? Math.round(fromTop) : required.heightPx - Math.round(fromTop);
		const maxTop = Math.max(0, required.heightPx - crop.bottomPx - 1);
		const maxBottom = Math.max(0, required.heightPx - crop.topPx - 1);
		return field === 'topPx'
			? Math.min(maxTop, Math.max(0, value))
			: Math.min(maxBottom, Math.max(0, value));
	}

	function buildReviewGuide(field: 'topPx' | 'bottomPx', slot: TileSlot, x: number, y: number, width: number): Konva.Rect {
		const guide = new Konva.Rect({
			x,
			y: y - 1,
			width,
			height: 3,
			fill: '#facc15',
			draggable: true,
			hitStrokeWidth: 12,
			dragBoundFunc: (pos) => ({ x, y: pos.y })
		});
		guide.on('dragstart', () => {
			cropDragActive = true;
		});
		guide.on('dragmove', () => {
			const value = reviewValueFromGuideY(field, guide.y() + 1);
			updateCropDrag(field, value);
			positionReviewGuides();
		});
		guide.on('dragend', () => {
			cropDragActive = false;
			endCropDrag();
			renderStage();
		});
		void slot;
		return guide;
	}

	/** Repositions every tile's crop guides + dim overlay from the current shared `crop`, without a full rebuild (called during an active drag). */
	function positionReviewGuides(): void {
		if (!required) return;
		const layout = filmstripPlacements();
		const view = stageVp.view;
		for (const slot of activeSlots) {
			const placement = layout[slot];
			const group = tileNodes.get(slot);
			if (!placement || !group) continue;
			const topScreenY = placement.yPx * view.zoom + view.panY;
			const heightScreen = required.heightPx * view.zoom;
			const widthScreen = required.widthPx * view.zoom;
			const topGuide = cropGuideTop.get(slot);
			const bottomGuide = cropGuideBottom.get(slot);
			if (topGuide && !topGuide.isDragging()) {
				topGuide.position({ x: 0, y: reviewGuideY('topPx', 0, heightScreen) - 1 });
			}
			if (bottomGuide && !bottomGuide.isDragging()) {
				bottomGuide.position({ x: 0, y: reviewGuideY('bottomPx', 0, heightScreen) - 1 });
			}
			const dimTop = group.findOne<Konva.Rect>('.dim-top');
			const dimBottom = group.findOne<Konva.Rect>('.dim-bottom');
			dimTop?.height(reviewGuideY('topPx', 0, heightScreen));
			dimBottom?.setAttrs({
				y: reviewGuideY('bottomPx', 0, heightScreen),
				height: heightScreen - reviewGuideY('bottomPx', 0, heightScreen)
			});
			void widthScreen;
		}
		layer?.batchDraw();
	}

	/**
	 * Renders the manual surface's current tab into the persistent Konva
	 * scene. Instant (no tween) — tab-to-tab motion is handled separately by
	 * `animateAssembling` so a transition is never interrupted by an
	 * unrelated re-render. A no-op whenever the manual surface isn't open.
	 */
	function renderStage(): void {
		const activeStage = stage;
		const activeLayer = layer;
		if (!activeStage || !activeLayer || !manualOpen) return;
		activeLayer.destroyChildren();
		tileNodes.clear();
		cropGuideTop.clear();
		cropGuideBottom.clear();

		if (manualView === 'crop') {
			if (!required) {
				activeLayer.batchDraw();
				return;
			}
			const view = stageVp.view;
			const layoutMap = filmstripPlacements();
			for (const slot of activeSlots) {
				const tile = tiles[slot];
				const placement = layoutMap[slot];
				if (!tile || !placement) continue;
				const x = placement.xPx * view.zoom + view.panX;
				const y = placement.yPx * view.zoom + view.panY;
				const w = required.widthPx * view.zoom;
				const h = required.heightPx * view.zoom;
				const group = new Konva.Group({ x, y, listening: false });
				group.add(
					new Konva.Image({ image: tile.image, width: w, height: h, listening: false })
				);
				const topDimHeight = reviewGuideY('topPx', 0, h);
				const bottomDimY = reviewGuideY('bottomPx', 0, h);
				group.add(
					new Konva.Rect({
						name: 'dim-top',
						width: w,
						height: topDimHeight,
						fill: 'rgba(0,0,0,0.55)',
						listening: false
					})
				);
				group.add(
					new Konva.Rect({
						name: 'dim-bottom',
						y: bottomDimY,
						width: w,
						height: h - bottomDimY,
						fill: 'rgba(0,0,0,0.55)',
						listening: false
					})
				);
				group.add(
					new Konva.Rect({ width: w, height: h, stroke: '#3f3f46', strokeWidth: 1, listening: false })
				);
				tileNodes.set(slot, group);
				activeLayer.add(group);
				const topGuide = buildReviewGuide('topPx', slot, x, y + topDimHeight, w);
				const bottomGuide = buildReviewGuide('bottomPx', slot, x, y + bottomDimY, w);
				cropGuideTop.set(slot, topGuide);
				cropGuideBottom.set(slot, bottomGuide);
				activeLayer.add(topGuide);
				activeLayer.add(bottomGuide);
			}
			activeLayer.batchDraw();
			return;
		}

		// Position tab: real computed placements, cropped.
		const validation = croppedValidation;
		if (!validation?.ok) {
			activeLayer.batchDraw();
			return;
		}
		const view = stageVp.view;
		for (const slot of activeSlots) {
			const tile = tiles[slot];
			const placement = placements[slot];
			if (!tile || !placement) continue;
			const group = new Konva.Group({
				x: placement.xPx * view.zoom + view.panX,
				y: placement.yPx * view.zoom + view.panY,
				visible: placement.visible,
				listening: false
			});
			group.add(
				new Konva.Image({
					image: tile.image,
					width: validation.widthPx * view.zoom,
					height: validation.heightPx * view.zoom,
					crop: { x: crop.leftPx, y: crop.topPx, width: validation.widthPx, height: validation.heightPx },
					opacity: slot === selectedSlot ? previewOpacity : 1,
					listening: false
				})
			);
			if (slot === selectedSlot) {
				group.add(
					new Konva.Rect({
						width: validation.widthPx * view.zoom,
						height: validation.heightPx * view.zoom,
						stroke: '#facc15',
						strokeWidth: 2,
						listening: false
					})
				);
			}
			tileNodes.set(slot, group);
			activeLayer.add(group);
		}
		activeLayer.batchDraw();
	}

	/**
	 * The Crop-tab -> Position-tab transition's one animated moment: tweens
	 * every tile node from its just-rendered filmstrip position/size to its
	 * real computed placement. Respects `prefers-reduced-motion` (a near-zero
	 * duration, never skipped outright — the end state must still commit).
	 */
	function animateAssembling(): void {
		const activeLayer = layer;
		const validation = croppedValidation;
		if (!activeLayer || !validation?.ok) {
			renderStage();
			return;
		}
		const view = stageVp.view;
		const reduced = prefersReducedMotion();
		const duration = reduced ? 0.05 : 0.85;
		activeSlots.forEach((slot, index) => {
			const group = tileNodes.get(slot);
			const placement = placements[slot];
			const tile = tiles[slot];
			if (!group || !placement || !tile) return;
			const image = group.findOne<Konva.Image>('Image');
			image?.crop({ x: crop.leftPx, y: crop.topPx, width: validation.widthPx, height: validation.heightPx });
			image?.opacity(1);
			group.find('Rect').forEach((node) => node.destroy());
			const targetX = placement.xPx * view.zoom + view.panX;
			const targetY = placement.yPx * view.zoom + view.panY;
			const targetW = validation.widthPx * view.zoom;
			const targetH = validation.heightPx * view.zoom;
			group.to({
				x: targetX,
				y: targetY,
				duration,
				delay: reduced ? 0 : index * 0.06,
				easing: Konva.Easings.EaseInOut
			});
			image?.to({
				width: targetW,
				height: targetH,
				duration,
				delay: reduced ? 0 : index * 0.06,
				easing: Konva.Easings.EaseInOut
			});
		});
	}

	let lastRenderedManualView: 'crop' | 'placement' | null = null;

	$effect(() => {
		if (!manualOpen) {
			lastRenderedManualView = null;
			return;
		}
		const current = manualView;
		if (current === lastRenderedManualView) return;
		const previous = lastRenderedManualView;
		lastRenderedManualView = current;
		untrack(() => {
			if (current === 'placement' && previous === 'crop') {
				renderStage(); // ensure the filmstrip nodes exist as the animation's starting point
				animateAssembling();
			} else {
				renderStage();
			}
		});
	});

	$effect(() => {
		const container = stageVp.container;
		if (!container || !canvas2dAvailable() || stage) return;
		stage = new Konva.Stage({ container, width: stageVp.size.width, height: stageVp.size.height });
		layer = new Konva.Layer();
		stage.add(layer);
	});

	// Tears the scene down when the manual surface closes, so reopening it
	// rebuilds cleanly against a fresh container rather than a stale one.
	$effect(() => {
		if (manualOpen) return;
		untrack(() => {
			if (!stage) return;
			stage.destroy();
			stage = null;
			layer = null;
			tileNodes.clear();
			cropGuideTop.clear();
			cropGuideBottom.clear();
		});
	});

	$effect(() => {
		stage?.size(stageVp.size);
	});

	// The fit target follows whichever tab the manual surface currently shows.
	$effect(() => {
		void tiles;
		void placements;
		void crop;
		void activeSlots;
		const open = manualOpen;
		const view = manualView;
		untrack(() => {
			if (!open) return;
			if (view === 'crop') stageVp.setFitTarget(filmstripFitTarget());
			else if (view === 'placement') stageVp.setFitTarget(assembledFitTarget());
		});
	});

	// Rebuild the scene when the session, crop, or view changes (but never
	// mid-drag).
	$effect(() => {
		void tiles;
		void crop;
		void placements;
		void selectedSlot;
		void previewOpacity;
		void stageVp.view;
		void stageVp.size;
		untrack(() => {
			if (!manualOpen) return;
			if (!tileDrag && !cropDragActive) renderStage();
		});
	});

	$effect(() => {
		const complete = activeSlots.every((slot) => tiles[slot] !== undefined);
		const validation = croppedValidation;
		if (complete && !placementsInitialized && validation?.ok) {
			placements = initialPlacements(activeSlots, validation.widthPx, validation.heightPx);
			placementsInitialized = true;
			syncPositionDraft(true);
		}
	});

	// Lazy main-thread OpenCV/Snap warm-up: only when the manual-correction
	// surface is actually opened (see `ensureCvWarm`) — never merely because
	// the page mounted or an auto result appeared.
	$effect(() => {
		if (manualOpen) ensureCvWarm();
	});

	/**
	 * Eager worker-side warm-up (unchanged by CHSPT-56): fires once on mount,
	 * non-blocking, constructing the smart-stitch worker so its own
	 * module-scope `loadCv()` call starts the WORKER-thread OpenCV WASM load
	 * immediately — the real `runStitchPipeline`/Snap calls later simply await
	 * the by-then-likely-already-resolved cached promise. Deliberately kept
	 * eager (only the MAIN-THREAD OpenCV/Snap path above is lazy) since
	 * worker-side CV staying warm is a requirement, not a bug.
	 */
	$effect(() => {
		warmSmartStitchWorker();
	});

	onMount(() => {
		// CHSPT-65: a thrown round kept earlier this session (e.g. before a
		// round trip to another route) surfaces in the indicator immediately.
		const existingThrownRound = getThrownRoundSource();
		heldThrownRound = existingThrownRound ? { fileName: existingThrownRound.fileName } : null;
		// The guided demo (/demo) drops real UDisc captures into a one-shot inbox
		// and navigates here. They enter through the SAME unified `runImport`
		// entry point the "Import screenshots" file input uses, so the result a
		// visitor watches appear is computed by the product now, never supplied
		// by the demo.
		const claimCaptures = (): void => {
			const captures = takePendingStitchCaptures();
			if (captures && captures.length > 0) void runImport(captures);
		};
		claimCaptures();
		// Captures deposited while this page is already mounted — the rail arming
		// a step the visitor is standing on — would otherwise sit unclaimed until
		// the next navigation, after the rail already reported success.
		return subscribePendingStitchCaptures(claimCaptures);
	});

	onDestroy(() => {
		// An in-flight import batch must never publish after unmount, and the
		// page no longer owns the smart-stitch worker once it is gone.
		decodeCoordinator.invalidate(SMART_IMPORT_BATCH);
		disposeSmartStitchWorker();
		endTileDrag();
		clearPendingImport();
		if (resultImageUrl) URL.revokeObjectURL(resultImageUrl);
		stage?.destroy();
		stage = null;
		layer = null;
	});
</script>

<svelte:head>
	<title>Stitch Map | ChainSpot</title>
</svelte:head>

<main data-testid="stitch-map">
	{#if exportError}
		<p class="error" data-testid="stitch-error" role="alert">{exportError}</p>
	{/if}

	<h2>Stitch Map</h2>

	<div class="stage-card">
		<div class="stage-progress" data-testid="stage-progress">
			<span class="prog-step" class:current={phase === 'import'} class:done={phase !== 'import'}>
				<span class="prog-dot">{phase === 'import' ? '1' : '✓'}</span>Import
			</span>
			<div class="prog-line" class:done={phase !== 'import'}></div>
			<span class="prog-step" class:current={phase === 'result'}>
				<span class="prog-dot">2</span>Result
			</span>
		</div>

		{#if heldThrownRound}
			<!-- CHSPT-65: visible confirmation of which image is set aside as the
			     thrown round (kept from a result, or marked per-tile), with the
			     one explicit discard the workflow offers. -->
			<div class="thrown-round-held" data-testid="thrown-round-held" role="status">
				<span>Thrown round: <strong>{heldThrownRound.fileName}</strong> — rides along into Create Graphics.</span>
				<button type="button" data-testid="thrown-round-discard" onclick={handleClearThrownRound}>
					Discard
				</button>
			</div>
		{/if}

		<div class="stage-context">
			{#if phase === 'import'}
				<span
					>Add one or more overlapping screenshots. ChainSpot crops (and, with more than one,
					stitches) them automatically — no approval click needed.</span
				>
				<span class="badge">{activeSlots.filter((slot) => tiles[slot]).length} added</span>
			{:else if phase === 'processing'}
				<span>Cropping and stitching…</span>
				<span class="badge strong">● working</span>
			{:else if phase === 'result'}
				<span
					>Stitched from {pipelineSuccess?.sources.length ?? 0} capture{(pipelineSuccess?.sources
						.length ?? 0) === 1
						? ''
						: 's'}.</span
				>
				{#if resultConfidence}
					<span class="badge" class:strong={resultConfidence === 'auto'}>
						{resultConfidence === 'auto' ? 'high confidence' : 'review recommended'}
					</span>
				{/if}
			{/if}
		</div>

		{#if phase === 'import'}
			{#if pendingImport}
				<!-- CHSPT-65: asked BEFORE any crop/stitch — a thrown-round
				     screenshot mixed into the batch must never reach the clean
				     composite. One thumbnail per selected capture. -->
				<div class="pre-import-prompt" data-testid="pre-import-prompt">
					<h3>Before stitching — is one of these the thrown round?</h3>
					<p class="section-note">
						The thrown round (the screenshot with the purple round path) is set aside for Create
						Graphics and kept out of the clean map. Pick it here, or stitch everything as clean.
					</p>
					<ul class="pre-import-grid">
						{#each pendingImport as item, index (item.url)}
							<li class="pre-import-item">
								<img class="pre-import-thumb" src={item.url} alt={item.file.name} />
								<span class="pre-import-name">{item.file.name}</span>
								<button
									type="button"
									class="thrown-round-pick"
									data-testid="pre-import-thrown-{index}"
									onclick={() => handlePreImportChoice(index)}
								>
									Thrown round
								</button>
							</li>
						{/each}
					</ul>
					<div class="pre-import-actions">
						<button
							type="button"
							class="btn primary"
							data-testid="pre-import-none"
							onclick={() => handlePreImportChoice(null)}
						>
							{pendingImport.length === 1
								? 'No thrown round — crop it as the clean map'
								: `No thrown round — stitch all ${pendingImport.length}`}
						</button>
						<button type="button" class="btn ghost" data-testid="pre-import-cancel" onclick={handlePreImportCancel}>
							Cancel import
						</button>
					</div>
				</div>
			{:else}
			<div class="import-panel">
				<section class="smart-import-section" aria-labelledby="smart-import-heading">
					<h3 id="smart-import-heading">Import screenshots</h3>
					<p class="section-note">
						Select one or more overlapping screenshots, in any order — up to {MAX_AUTO_ARRANGE_TILES}
						at once. A single screenshot is cropped automatically; two or more are also stitched
						together. The existing controls below remain available for a manual capture-by-capture
						session too.
					</p>
					<div class="smart-import-row">
						<label class="file-label">
							Import screenshots
							<input
								class="file-input"
								type="file"
								accept="image/png,image/jpeg"
								multiple
								data-testid="smart-import-input"
								onchange={handleSmartImportFiles}
							/>
						</label>
					</div>
					<label
						class="crop-margin-toggle"
						title="AutoStitch may be unreliable without Add margin. If you have it disabled and your stitch doesn't align, try enabling Add margin."
					>
						<input type="checkbox" bind:checked={addCropMargin} data-testid="crop-margin-toggle" />
						Add margin — trim a couple extra pixels of the automatic crop for safety
					</label>
					{#if pipelineError}
						<p class="error" data-testid="smart-import-error" role="alert">{pipelineError}</p>
					{/if}
				</section>

				<section class="tile-section" aria-labelledby="tiles-heading">
					<h3 id="tiles-heading">Screenshots</h3>
					<div class="tile-grid">
						{#each activeSlots as slot (slot)}
							<StitchTileSlot
								slot={slot}
								label={slotLabel(slot)}
								fileName={tiles[slot]?.fileName ?? null}
								dimensions={tiles[slot] ? `${tiles[slot].widthPx} x ${tiles[slot].heightPx}` : null}
								error={tileErrors[slot] ?? null}
								onFile={(file) => handleSlotFile(slot, file)}
								onRemove={() => handleRemove(slot)}
								onMarkThrownRound={() => handleMarkTileAsThrownRound(slot)}
							/>
						{/each}
						<button type="button" class="add-tile" data-testid="add-capture" onclick={addSlot}>
							+ Add capture
						</button>
					</div>
				</section>
			</div>
			{/if}
		{:else if phase === 'processing'}
			<div class="processing-panel" data-testid="stitch-processing">
				<div class="spinner" aria-hidden="true"></div>
				<p role="status">Cropping and stitching your screenshots…</p>
			</div>
		{:else if phase === 'result'}
			<div class="result-panel">
				{#if resultConfidence === 'review'}
					<div class="confidence-banner" data-testid="confidence-review" role="status">
						<strong>Review recommended.</strong>
						{#if resultWarnings.length > 0}
							<span>{resultWarnings.join(' ')}</span>
						{:else}
							<span>The automatic result may need a closer look.</span>
						{/if}
						{#if !manualOpen}
							<button type="button" onclick={() => (manualOpen = true)}>Adjust manually</button>
						{/if}
					</div>
				{/if}

				{#if resultImageUrl && resultProvenance}
					<div
						class="composite-wrapper"
						style:aspect-ratio={`${resultProvenance.outputWidthPx} / ${resultProvenance.outputHeightPx}`}
						data-testid="composite-wrapper"
					>
						<img class="composite-image" src={resultImageUrl} alt="Assembled stitched map" data-testid="composite-image" />
						{#key badgeFlashKey}
							{#each badgeAnchors as anchor, index (anchor.holeNumber + '-' + index)}
								{@const pos = badgeFlashPercent(anchor, resultProvenance.outputWidthPx, resultProvenance.outputHeightPx)}
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
						{/key}
					</div>
				{/if}

				{#if resultProvenance && resultProvenance.sources.length > 1}
					<!-- CHSPT-65: bulk-import escape hatch — when the thrown-round
					     screenshot was imported together with the clean tiles, pick it
					     out here; the clean map re-stitches without it. (A
					     single-capture result uses "Keep as thrown round" below.) -->
					<div class="result-sources" data-testid="result-sources">
						<span class="result-sources-hint">Is one of these the thrown round? Pick it out and the clean map re-stitches without it:</span>
						<ul>
							{#each resultProvenance.sources as source (source.sourceId)}
								<li>
									<span class="result-source-name">{source.fileName}</span>
									<button
										type="button"
										class="thrown-round-pick"
										data-testid="result-source-thrown-{source.sourceId}"
										disabled={rendering}
										onclick={() => void handleMarkResultSourceAsThrownRound(source.sourceId)}
									>
										Thrown round
									</button>
								</li>
							{/each}
						</ul>
					</div>
				{/if}

				<div class="result-actions">
					<button
						type="button"
						class="btn primary"
						data-testid="continue-to-annotate"
						disabled={!resultBlob || rendering}
						onclick={() => handleUseAs('source-overview')}
					>
						Continue to Annotate Course →
					</button>
					<button
						type="button"
						class="btn"
						data-testid="use-as-target"
						disabled={!resultBlob || rendering}
						onclick={() => handleUseAs('target-basemap')}
					>
						Send to Create Graphics
					</button>
					<button
						type="button"
						class="btn"
						data-testid="keep-as-thrown-round"
						disabled={!resultBlob || rendering}
						onclick={handleKeepAsThrownRound}
					>
						Keep as thrown round
					</button>
					<button
						type="button"
						class="btn ghost"
						data-testid="download-stitched"
						disabled={!resultBlob || rendering}
						onclick={handleDownload}
					>
						Download PNG
					</button>
					<button
						type="button"
						class="btn ghost"
						data-testid="adjust-manually"
						aria-pressed={manualOpen}
						onclick={() => (manualOpen = !manualOpen)}
					>
						{manualOpen ? 'Hide manual adjustment' : 'Adjust manually'}
					</button>
					<button type="button" class="btn ghost" data-testid="start-new-map" onclick={resetToImport}>
						↻ Start a new map
					</button>
					{#if rendering}
						<span class="status" role="status">Rendering…</span>
					{/if}
				</div>

				{#if manualOpen}
					<div class="manual-surface" data-testid="manual-surface">
						<div class="manual-tabs">
							<button
								type="button"
								class="manual-tab"
								class:active={manualView === 'crop'}
								data-testid="manual-tab-crop"
								onclick={() => (manualView = 'crop')}
							>
								Crop
							</button>
							<button
								type="button"
								class="manual-tab"
								class:active={manualView === 'placement'}
								data-testid="manual-tab-placement"
								onclick={() => (manualView = 'placement')}
							>
								Position
							</button>
						</div>

						<div class="stage-canvas" data-manual-view={manualView}>
							<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
							<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
							<div
								class="stage-workspace"
								data-testid="stage-workspace"
								bind:this={stageWorkspace}
								tabindex="0"
								role="group"
								aria-label="Stitch stage"
								data-stitch-nudge-scope
								onkeydown={handleStageKeyDown}
							>
								<ImageViewport
									controller={stageVp}
									testid="stage-viewport"
									claimPointer={claimStagePointer}
									onViewportClick={onStageClick}
									onClaimedPointerCancel={handleTileDragCancel}
								>
									{#snippet content()}{/snippet}
								</ImageViewport>
							</div>

							{#snippet cropZoomRow(topPx: number, bottomPx: number)}
								<div class="crop-zoom-block">
									<p class="crop-zoom-legend">
										Each row is one real pixel. <span class="crop-zoom-swatch kept"></span> first row kept.
									</p>
									<div class="crop-zoom-edge">
										<span class="crop-zoom-label">Top edge — {topPx}px</span>
										<div class="crop-zoom-strip">
											{#each activeSlots as slot (slot)}
												{@const tile = tiles[slot]}
												{#if tile}
													<div class="crop-zoom-tile">
														<canvas
															use:cropZoom={{
																image: tile.image,
																imageWidthPx: tile.widthPx,
																imageHeightPx: tile.heightPx,
																boundaryY: topPx,
																edge: 'top'
															}}
														></canvas>
														<span>{slotLabel(slot)}</span>
													</div>
												{/if}
											{/each}
										</div>
									</div>
									<div class="crop-zoom-edge">
										<span class="crop-zoom-label">Bottom edge — {bottomPx}px</span>
										<div class="crop-zoom-strip">
											{#each activeSlots as slot (slot)}
												{@const tile = tiles[slot]}
												{#if tile}
													<div class="crop-zoom-tile">
														<canvas
															use:cropZoom={{
																image: tile.image,
																imageWidthPx: tile.widthPx,
																imageHeightPx: tile.heightPx,
																boundaryY: tile.heightPx - bottomPx,
																edge: 'bottom'
															}}
														></canvas>
														<span>{slotLabel(slot)}</span>
													</div>
												{/if}
											{/each}
										</div>
									</div>
								</div>
							{/snippet}

							{#if manualView === 'crop'}
								<div class="crop-fields-overlay">
									<div class="crop-fields-row">
										{#each CROP_FIELDS as field (field)}
											<label class="crop-field">
												<span>{CROP_FIELD_LABELS[field]}</span>
												<input
													type="text"
													inputmode="numeric"
													autocomplete="off"
													data-testid={`crop-${field}`}
													bind:this={cropInputs[field]}
													value={cropDraft[field]}
													aria-invalid={invalidCropFields.includes(field) ? 'true' : undefined}
													oninput={(event) => handleCropInput(field, event)}
													onchange={() => commitCrop(field)}
												/>
											</label>
										{/each}
										<button type="button" data-testid="crop-reset" onclick={resetCrop}>Reset crop</button>
										<button type="button" data-testid="crop-fit" onclick={() => stageVp.fit()}>Fit</button>
									</div>
									<p class="crop-zoom-hint">
										Close-up at the exact crop line, per screenshot — check every one before applying.
									</p>
									{@render cropZoomRow(crop.topPx, crop.bottomPx)}
								</div>
							{/if}
						</div>

						{#if manualView === 'placement'}
							<div class="tool-block">
								<h3>Selected tile</h3>
								<div class="segmented">
									{#each movableSlots as slot (slot)}
										<button
											type="button"
											class="tile-select"
											class:sel={selectedSlot === slot}
											data-testid={`tile-select-${slot}`}
											aria-pressed={selectedSlot === slot}
											disabled={!tiles[slot]}
											onclick={() => selectSlot(slot)}
										>
											{slotLabel(slot)}
										</button>
									{/each}
								</div>
							</div>
							<div class="tool-block">
								<h3>Position</h3>
								<div class="field-row">
									<label class="field">
										<span>X</span>
										<input
											type="text"
											inputmode="numeric"
											autocomplete="off"
											data-testid="tile-position-x"
											bind:this={xPositionInput}
											value={positionDraft.xPx}
											disabled={!selectedSlot}
											oninput={(event) => handlePositionInput('xPx', event)}
											onchange={() => commitPosition('xPx')}
										/>
									</label>
									<label class="field">
										<span>Y</span>
										<input
											type="text"
											inputmode="numeric"
											autocomplete="off"
											data-testid="tile-position-y"
											bind:this={yPositionInput}
											value={positionDraft.yPx}
											disabled={!selectedSlot}
											oninput={(event) => handlePositionInput('yPx', event)}
											onchange={() => commitPosition('yPx')}
										/>
									</label>
								</div>
								<label class="opacity-field">
									<span>Selected tile opacity (preview)</span>
									<input
										type="range"
										min="0.15"
										max="1"
										step="0.05"
										data-testid="tile-opacity"
										bind:value={previewOpacity}
										disabled={!selectedSlot}
									/>
								</label>
							</div>
							<div class="tool-block">
								<h3>Actions</h3>
								<div class="field-row">
									<button
										type="button"
										class="btn primary small"
										data-testid="snap-tile"
										disabled={!snapAvailable}
										onclick={() => void snapSelectedTile()}
									>
										Snap
									</button>
									<button
										type="button"
										class="btn ghost small"
										data-testid="reset-arrangement"
										disabled={!activeSlots.some((slot) => tiles[slot])}
										onclick={resetArrangement}
									>
										Reset
									</button>
									<button
										type="button"
										class="btn ghost small"
										disabled={!selectedSlot}
										onclick={() => selectedSlot && toggleTileVisible(selectedSlot)}
									>
										{visibilityToggleLabel()}
									</button>
									{#if snapBusy}
										<span class="status" role="status" data-testid="snap-busy">Snapping…</span>
									{/if}
								</div>
							</div>
						{/if}

						<div class="tool-block">
							<h3>Automatic result summary</h3>
							<p class="section-note" data-testid="manual-summary">
								{pipelineSuccess?.sources.length ?? 0} capture{(pipelineSuccess?.sources.length ?? 0) === 1
									? ''
									: 's'}, confidence: {resultConfidence === 'auto' ? 'high' : 'review recommended'}.
								{#if pipelineSuccess && pipelineSuccess.warnings.length > 0}
									{pipelineSuccess.warnings.join(' ')}
								{/if}
							</p>
							<ul class="smart-assignment" data-testid="manual-capture-list" aria-label="Capture order">
								{#each activeSlots as slot (slot)}
									{#if tiles[slot]}
										<li>
											<span class="assignment-label">{slotLabel(slot)}:</span>
											<span data-testid={`manual-capture-${slot}`}>{tiles[slot]?.fileName}</span>
										</li>
									{/if}
								{/each}
							</ul>
						</div>

						<p class="stage-readiness" data-testid="stitch-readiness" role="status">{readinessText()}</p>

						{#if manualHasRotatedSource}
							<p class="manual-rotation-warning" data-testid="manual-rotation-warning" role="status">
								One or more of these captures was auto-aligned with rotation. Manual adjustments can
								only reposition tiles, so applying them will straighten that rotation out. Only apply
								if you want to replace the automatic alignment.
							</p>
						{/if}

						<div class="manual-actions">
							<button type="button" class="btn ghost" data-testid="close-manual-adjustments" onclick={() => (manualOpen = false)}>
								Close
							</button>
							<button
								type="button"
								class="btn primary"
								data-testid="apply-manual-adjustments"
								disabled={!manualReady || !manualDirty}
								onclick={() => void applyManualAdjustments()}
							>
								Apply adjustments
							</button>
						</div>
					</div>
				{/if}
			</div>
		{/if}
	</div>

	{#if statusMessage}
		<p role="status" data-testid="stitch-status">{statusMessage}</p>
	{/if}
</main>

<style>
	main {
		font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
		background-color: #121214;
		color: #e4e4e7;
		padding: 1rem;
		display: flex;
		flex-direction: column;
		gap: 1.25rem;
		max-width: 1100px;
		margin: 0 auto;
	}

	h2 {
		margin: 0;
		font-size: 1.35rem;
		color: #f4f4f5;
	}

	h3 {
		margin: 0 0 0.5rem;
		font-size: 1rem;
		color: #f4f4f5;
	}

	.section-note {
		margin: 0;
		font-size: 0.9rem;
		color: #a1a1aa;
		line-height: 1.5;
	}

	.error {
		margin: 0;
		padding: 0.6rem 0.8rem;
		border-radius: 6px;
		background: #3f1d1d;
		border: 1px solid #7f1d1d;
		color: #fca5a5;
	}

	/* ---- persistent stage card ---- */
	.stage-card {
		width: min(100%, 960px);
		border: 1px solid #27272a;
		border-radius: 14px;
		background: #18181b;
		overflow: hidden;
		margin: 0 auto;
	}

	.pre-import-prompt {
		display: flex;
		flex-direction: column;
		gap: 0.7rem;
		padding: 0.9rem 1rem;
		border: 1px solid #4c1d95;
		border-radius: 8px;
		background-color: #1e1e24;
	}

	.pre-import-prompt h3 {
		margin: 0;
		font-size: 1rem;
		color: #f4f4f5;
	}

	.pre-import-grid {
		display: flex;
		flex-wrap: wrap;
		gap: 0.8rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.pre-import-item {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.35rem;
		width: 160px;
	}

	.pre-import-thumb {
		width: 160px;
		height: 120px;
		object-fit: cover;
		border: 1px solid #3f3f46;
		border-radius: 6px;
		background: #101014;
	}

	.pre-import-name {
		max-width: 160px;
		font-size: 0.75rem;
		color: #a1a1aa;
		overflow-wrap: anywhere;
		text-align: center;
	}

	.pre-import-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.6rem;
		align-items: center;
	}

	.result-sources {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
		padding: 0.55rem 0.8rem;
		border: 1px solid #3f3f46;
		border-radius: 6px;
		background-color: #1e1e24;
		font-size: 0.82rem;
		color: #a1a1aa;
	}

	.result-sources ul {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem 1rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.result-sources li {
		display: flex;
		align-items: center;
		gap: 0.45rem;
	}

	.result-source-name {
		color: #e4e4e7;
		overflow-wrap: anywhere;
	}

	.thrown-round-pick {
		padding: 0.2rem 0.55rem;
		border: 1px solid #4c1d95;
		border-radius: 4px;
		background-color: #2e1065;
		color: #ddd6fe;
		font-size: 0.78rem;
		cursor: pointer;
	}

	.thrown-round-held {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		margin-top: 0.6rem;
		padding: 0.45rem 0.8rem;
		border: 1px solid #4c1d95;
		border-radius: 6px;
		background-color: #2e1065;
		color: #ddd6fe;
		font-size: 0.85rem;
	}

	.thrown-round-held button {
		padding: 0.2rem 0.6rem;
		border: 1px solid #6d28d9;
		border-radius: 4px;
		background: transparent;
		color: #ddd6fe;
		cursor: pointer;
	}

	.stage-progress {
		display: flex;
		align-items: center;
		padding: 1rem 1.25rem 0.85rem;
		border-bottom: 1px solid #27272a;
	}

	.prog-step {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.8rem;
		color: #71717a;
		white-space: nowrap;
	}

	.prog-dot {
		width: 18px;
		height: 18px;
		border-radius: 50%;
		border: 1px solid #3f3f46;
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 0.6rem;
		flex: none;
	}

	.prog-step.done .prog-dot {
		background: #2dd4bf;
		border-color: #2dd4bf;
		color: #04211f;
	}

	.prog-step.current .prog-dot {
		border-color: #fbbf24;
		color: #fbbf24;
	}

	.prog-step.current {
		color: #f4f4f5;
		font-weight: 600;
	}

	.prog-line {
		flex: 1;
		height: 1px;
		background: #3f3f46;
		margin: 0 0.75rem;
		max-width: 3rem;
	}

	.prog-line.done {
		background: #2dd4bf;
	}

	.stage-context {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		padding: 0.75rem 1.25rem;
		font-size: 0.8rem;
		color: #a1a1aa;
		flex-wrap: wrap;
	}

	.badge {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		font-size: 0.7rem;
		padding: 0.2rem 0.6rem;
		border-radius: 100px;
		border: 1px solid #3f3f46;
		color: #a1a1aa;
		white-space: nowrap;
	}

	.badge.strong {
		border-color: #2e5c48;
		color: #2dd4bf;
		background: #0f2320;
	}

	/* ---- import phase (plain HTML — no arranged geometry to preserve yet) ---- */
	.import-panel {
		display: flex;
		flex-direction: column;
		gap: 1.25rem;
		padding: 1.25rem;
	}

	.smart-import-section {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.smart-import-row {
		display: flex;
		align-items: center;
		gap: 0.75rem;
	}

	.crop-margin-toggle {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		font-size: 0.8rem;
		color: #a1a1aa;
		cursor: help;
		width: fit-content;
	}

	.crop-margin-toggle input {
		accent-color: #fbbf24;
	}

	.file-label {
		display: inline-flex;
		align-items: center;
		padding: 0.5rem 0.9rem;
		border: 1px solid #3f3f46;
		border-radius: 6px;
		background-color: #27272a;
		color: #e4e4e7;
		font-size: 0.85rem;
		cursor: pointer;
	}

	.file-input {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip: rect(0 0 0 0);
	}

	.status {
		font-size: 0.85rem;
		color: #a1a1aa;
	}

	.smart-assignment {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		font-size: 0.85rem;
	}

	.assignment-label {
		color: #a1a1aa;
		margin-right: 0.35rem;
	}

	.tile-section h3 {
		margin-bottom: 0.75rem;
	}

	.tile-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
		gap: 0.75rem;
	}

	.add-tile {
		display: flex;
		align-items: center;
		justify-content: center;
		min-height: 100px;
		border: 1.5px dashed #3f3f46;
		border-radius: 8px;
		background: transparent;
		color: #71717a;
		font-size: 0.8rem;
		cursor: pointer;
	}

	.add-tile:hover {
		color: #e4e4e7;
		border-color: #52525b;
	}

	/* ---- processing phase ---- */
	.processing-panel {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 1rem;
		padding: 3rem 1.25rem;
		min-height: 220px;
	}

	.spinner {
		width: 2.25rem;
		height: 2.25rem;
		border-radius: 50%;
		border: 3px solid #3f3f46;
		border-top-color: #fbbf24;
		animation: stitch-spin 0.9s linear infinite;
	}

	@media (prefers-reduced-motion: reduce) {
		.spinner {
			animation-duration: 2.4s;
		}
	}

	@keyframes stitch-spin {
		to {
			transform: rotate(360deg);
		}
	}

	/* ---- result phase ---- */
	.result-panel {
		display: flex;
		flex-direction: column;
		gap: 1rem;
		padding: 1.25rem;
	}

	.confidence-banner {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		flex-wrap: wrap;
		padding: 0.7rem 0.9rem;
		border-radius: 8px;
		background: #2a2008;
		border: 1px solid #7c5e0f;
		color: #fde68a;
		font-size: 0.85rem;
	}

	.confidence-banner button {
		margin-left: auto;
		font-size: 0.75rem;
		padding: 0.35rem 0.6rem;
		border-radius: 6px;
		border: 1px solid #7c5e0f;
		background: #3a2c0b;
		color: #fde68a;
		cursor: pointer;
	}

	.composite-wrapper {
		position: relative;
		width: 100%;
		max-height: 65vh;
		overflow: hidden;
		border-radius: 10px;
		border: 1px solid #27272a;
		background: #0e0e10;
	}

	.composite-image {
		display: block;
		width: 100%;
		height: auto;
	}

	.badge-flash {
		position: absolute;
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
		30% {
			opacity: 1;
		}
		100% {
			transform: scale(1);
			opacity: 0.9;
			box-shadow: 0 0 0 10px rgba(74, 222, 128, 0);
		}
	}

	.result-actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.6rem;
	}

	.btn {
		font-size: 0.8rem;
		padding: 0.5rem 0.85rem;
		border-radius: 6px;
		border: 1px solid #3f3f46;
		background: #27272a;
		color: #e4e4e7;
		cursor: pointer;
	}

	.btn.ghost {
		background: transparent;
		color: #a1a1aa;
	}

	.btn.primary {
		background: #fbbf24;
		border-color: #fbbf24;
		color: #241804;
		font-weight: 650;
	}

	.btn:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}

	.btn.small {
		font-size: 0.7rem;
		padding: 0.3rem 0.55rem;
	}

	/* ---- manual-correction surface ---- */
	.manual-surface {
		display: flex;
		flex-direction: column;
		gap: 1rem;
		border: 1px solid #3f3f46;
		border-radius: 10px;
		padding: 1rem;
		background: #18181b;
	}

	.manual-tabs {
		display: flex;
		gap: 0.5rem;
	}

	.manual-tab {
		font-size: 0.8rem;
		padding: 0.4rem 0.8rem;
		border-radius: 6px;
		border: 1px solid #3f3f46;
		background: #27272a;
		color: #a1a1aa;
		cursor: pointer;
	}

	.manual-tab.active {
		border-color: #fbbf24;
		color: #f4f4f5;
	}

	.stage-canvas {
		position: relative;
		width: 100%;
		aspect-ratio: 16 / 9;
		min-height: 280px;
		max-height: 70vh;
		background: #0e0e10;
		overflow: hidden;
		border-radius: 8px;
	}

	.stage-workspace {
		position: absolute;
		inset: 0;
	}

	.stage-workspace:focus-visible {
		outline: none;
	}

	.crop-fields-overlay {
		position: absolute;
		left: 12px;
		right: 12px;
		bottom: 12px;
		z-index: 6;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		padding: 0.6rem;
		border-radius: 8px;
		background: rgba(24, 24, 27, 0.94);
		border: 1px solid #3f3f46;
		max-height: 78%;
		overflow-y: auto;
	}

	.crop-fields-row {
		display: flex;
		align-items: flex-end;
		gap: 0.5rem;
	}

	.crop-field {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		font-size: 0.65rem;
		color: #a1a1aa;
	}

	.crop-field input {
		width: 3.5rem;
		background: #0e0e10;
		border: 1px solid #3f3f46;
		border-radius: 5px;
		padding: 0.3rem 0.4rem;
		color: #e4e4e7;
		font-family: ui-monospace, monospace;
		font-size: 0.75rem;
	}

	.crop-fields-overlay button {
		font-size: 0.7rem;
		padding: 0.35rem 0.5rem;
		border-radius: 5px;
		border: 1px solid #3f3f46;
		background: #27272a;
		color: #e4e4e7;
		cursor: pointer;
	}

	.crop-zoom-hint {
		margin: 0;
		font-size: 0.65rem;
		color: #71717a;
	}

	.crop-zoom-legend {
		margin: 0;
		font-size: 0.65rem;
		color: #a1a1aa;
		display: flex;
		align-items: center;
		gap: 0.3rem;
		flex-wrap: wrap;
	}

	.crop-zoom-swatch {
		display: inline-block;
		width: 0.7rem;
		height: 0.7rem;
		border-radius: 2px;
		border: 2px solid;
	}

	.crop-zoom-swatch.kept {
		border-color: #4ade80;
	}

	.crop-zoom-block {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.crop-zoom-edge {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
	}

	.crop-zoom-label {
		font-size: 0.65rem;
		color: #a1a1aa;
		font-family: ui-monospace, monospace;
	}

	.crop-zoom-strip {
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 1fr));
		gap: 0.5rem;
	}

	.crop-zoom-tile {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.25rem;
	}

	.crop-zoom-tile canvas {
		display: block;
		border: 1px solid #3f3f46;
		border-radius: 4px;
		background: #000;
		image-rendering: pixelated;
	}

	.crop-zoom-tile span {
		font-size: 0.65rem;
		color: #a1a1aa;
	}

	.tool-block h3 {
		margin: 0 0 0.5rem;
		font-size: 0.7rem;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: #71717a;
	}

	.segmented {
		display: flex;
		flex-wrap: wrap;
		gap: 0.35rem;
		max-width: 20rem;
	}

	.tile-select {
		font-size: 0.75rem;
		padding: 0.35rem 0.6rem;
		border-radius: 6px;
		border: 1px solid #3f3f46;
		background: #27272a;
		color: #a1a1aa;
		cursor: pointer;
	}

	.tile-select.sel {
		border-color: #fbbf24;
		color: #f4f4f5;
	}

	.tile-select:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}

	.field-row {
		display: flex;
		gap: 0.5rem;
		align-items: center;
	}

	.field {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		font-size: 0.65rem;
		color: #71717a;
	}

	.field input {
		width: 4.5rem;
		background: #0e0e10;
		border: 1px solid #3f3f46;
		border-radius: 5px;
		padding: 0.35rem 0.4rem;
		color: #e4e4e7;
		font-family: ui-monospace, monospace;
	}

	.opacity-field {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		font-size: 0.65rem;
		color: #71717a;
		margin-top: 0.6rem;
	}

	.stage-readiness {
		margin: 0;
		font-size: 0.7rem;
		color: #a1a1aa;
	}

	.manual-rotation-warning {
		margin: 0;
		font-size: 0.7rem;
		color: #fbbf24;
	}

	.manual-actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
	}
</style>
