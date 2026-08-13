<script lang="ts">
	import { goto } from '$app/navigation';
	import { base } from '$app/paths';
	import Konva from 'konva';
	import { onDestroy, onMount, tick, untrack } from 'svelte';
	import ImageViewport from '$lib/components/ImageViewport.svelte';
	import StitchTileSlot from '$lib/components/StitchTileSlot.svelte';
	import { dialogKeyboard } from '$lib/focusManagement';
	import { clickSlopPx, ViewportController } from '$lib/viewport.svelte';
	import type { ViewportFitTarget } from '$lib/viewport.svelte';
	import { decodeImageFile, isSupportedMimeType } from '$lib/imageIntake';
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
	import { smartImportFiles } from '$lib/stitch/smartImport';
	import { MAX_AUTO_ARRANGE_TILES } from '$lib/stitch/autoLayout';
	import { categoryLabel } from '$lib/stitch/diagnostics';
	import type { LayoutDiagnostic } from '$lib/stitch/diagnostics';
	import { requiresReplaceDecision } from '$lib/stitch/rerunGuard';
	import { demoTour } from '$lib/demo/tour.svelte';
	import {
		smartImportViaWorker,
		disposeSmartStitchWorker,
		warmSmartStitchWorker
	} from '$lib/stitch/smartImport';
	import { DEFAULT_MAX_ANALYSIS_DIM, toAnalysisRaster } from '$lib/stitch/analysis';
	import type { AnalysisRaster } from '$lib/stitch/analysis';
	import { loadCv, snapAlign, warmMatchTemplate } from '$lib/stitch/cvMatch';
	import type { SnapNeighbor } from '$lib/stitch/cvMatch';
	import { renderStitchedPng, stitchedFileName } from '$lib/stitch/render';
	import {
		getPendingHandoff,
		setPendingHandoff,
		subscribePendingStitchCaptures,
		takePendingStitchCaptures
	} from '$lib/session';
	import type { ImageRole } from '$lib/domain/project';
	import type { ImageSpacePoint, ScreenSpacePoint } from '$lib/coords';

	interface StitchTile {
		fileName: string;
		mimeType: string;
		widthPx: number;
		heightPx: number;
		image: HTMLImageElement;
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

	/** Reserved coordinator key guarding one whole smart-import batch (P1-001). */
	const SMART_IMPORT_BATCH = '__smart-import__';

	/** Session tiles: transient browser resources only, never durable project state. */
	let tiles = $state<Partial<Record<TileSlot, StitchTile>>>({});
	let tileErrors = $state<Partial<Record<TileSlot, string>>>({});
	/** Per-slot decode generations: stale in-flight decodes never publish results. */
	const decodeCoordinator = new TileDecodeCoordinator();

	/** Authoritative committed crop; drafts may be invalid without touching it. Shared by every tile — see the design note on the review-phase guides below. */
	let crop = $state<CropInsets>({ ...ZERO_CROP });
	let cropDraft = $state<{ topPx: string; rightPx: string; bottomPx: string; leftPx: string }>({
		topPx: '0',
		rightPx: '0',
		bottomPx: '0',
		leftPx: '0'
	});
	let cropInputs = $state<Partial<Record<CropInsetField, HTMLInputElement | null>>>({});

	/**
	 * The session's active slots: four fresh, empty ids by default, or however
	 * many tiles a successful smart import inferred (see `runSmartImport`), or
	 * one more than that after "+ Add capture". `tileNeighbors` is the
	 * expected-overlap adjacency for those slots — a placeholder grid before any
	 * arrangement has run, or the real inferred topology afterward. The first
	 * slot in `activeSlots` is always the anchor (immovable, at (0, 0)).
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

	/**
	 * One persistent viewport/stage shared by every non-import phase (P2:
	 * single-viewport redesign) — the review filmstrip, the assembling
	 * transition, the assembled mosaic, and export all render into the same
	 * Konva scene; tiles are repositioned/resized/cropped in place, never
	 * unmounted and rebuilt as a different component. Import stays plain HTML
	 * (see the template) since it is fundamentally a file-picker grid, not a
	 * scene with real geometry to preserve continuity for.
	 */
	let stageVp = new ViewportController();
	let stage = $state<Konva.Stage | null>(null);
	let layer = $state<Konva.Layer | null>(null);
	/** Live tile groups so a drag preview moves the image and its highlight together, and so a phase transition can tween the existing node instead of rebuilding it. */
	let tileNodes = new Map<TileSlot, Konva.Group>();
	/** Live review-phase crop guide nodes, per tile, so a drag moves them without a full rebuild. */
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

	/** P1-002 1b: Snap is now async (backed by `cvMatch`'s matcher); busy while a call is in flight. */
	let snapBusy = $state(false);

	/** P1-001 smart-import state: transient, never durable. */
	let smartImportBusy = $state(false);
	let smartImportError = $state<string | null>(null);
	let smartImportSummary = $state<Partial<Record<TileSlot, string>> | null>(null);
	let cropProposal = $state<CropInsets | null>(null);
	/**
	 * Adds a small safety margin to the auto-proposed crop so a borderline
	 * chrome pixel (or per-capture-unique status-bar content, e.g. the device
	 * clock) never survives into the shared crop — on by default, since a
	 * slightly deeper crop is far cheaper than a stitch corrupted by leftover
	 * chrome. Decided before import runs, since it affects the analysis itself,
	 * not just how the proposal is displayed afterward.
	 */
	let addCropMargin = $state(true);

	/** P1-002 hardening state: transient diagnostic/confirmation state only. */
	let smartImportDiagnostic = $state<LayoutDiagnostic | null>(null);
	let cropProposalConfidence = $state<'high' | 'low' | 'absent' | null>(null);
	/** The automatic result's committed placements; a re-run over manual edits must confirm. */
	let lastAutoPlacements: Partial<Record<TileSlot, TilePlacement>> | null = null;
	let pendingReplaceConfirm = $state(false);
	let pendingSmartImportFiles: File[] | null = null;
	/** Replace-dialog focus management follows the established P0 pattern. */
	let replaceCancelButton = $state<HTMLButtonElement | null>(null);
	let replaceFocusRestore: HTMLElement | null = null;

	const CROP_CONFIDENCE_LABELS: Record<'high' | 'low' | 'absent', string> = {
		high: 'high — every screenshot agrees on the shared edge bands',
		low: 'low — edge evidence is partial or conflicts; inspect before applying',
		absent: 'none — no shared outer band could be confirmed'
	};

	/** The guided demo gives visitors time to notice the proposal before continuing. */
	const DEMO_CROP_AUTO_APPLY_DELAY_MS = 20_000;

	$effect(() => {
		const proposal = cropProposal;
		const isDemoCropStep = demoTour.active && demoTour.step.id === 'stitch';
		if (!proposal || !isDemoCropStep || phase !== 'review') return;

		const timer = setTimeout(() => {
			if (cropProposal !== proposal || !demoTour.active || demoTour.step.id !== 'stitch') return;
			applyCropProposal();
			statusMessage = 'Suggested crop applied automatically after 20 seconds.';
		}, DEMO_CROP_AUTO_APPLY_DELAY_MS);

		return () => clearTimeout(timer);
	});

	const required = $derived(sessionDimensions(tiles, activeSlots));
	const croppedValidation = $derived(
		required ? cropSize(crop, required.widthPx, required.heightPx) : null
	);
	const report = $derived(
		readiness(tiles, crop, placements, required, activeSlots, tileNeighbors)
	);
	const invalidCropFields = $derived(computeInvalidCropFields());
	const canExport = $derived(report.ready && !rendering && invalidCropFields.length === 0);
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

	// ---------------------------------------------------------------------
	// Phase state machine (P2 single-viewport redesign)
	// ---------------------------------------------------------------------

	type Phase = 'import' | 'review' | 'assembling' | 'assembled' | 'export';
	let phase = $state<Phase>('import');
	let finetuneOpen = $state(false);
	let assemblingTimer: ReturnType<typeof setTimeout> | null = null;

	const PROGRESS_LABELS = ['Import', 'Review', 'Assemble', 'Export'] as const;
	const PROGRESS_INDEX: Record<Phase, number> = {
		import: 0,
		review: 1,
		assembling: 2,
		assembled: 2,
		export: 3
	};

	function prefersReducedMotion(): boolean {
		return (
			typeof window !== 'undefined' &&
			typeof window.matchMedia === 'function' &&
			window.matchMedia('(prefers-reduced-motion: reduce)').matches
		);
	}

	/** All currently-active slots hold a decoded, dimension-matching tile — the gate for leaving Import. */
	const importComplete = $derived(
		activeSlots.length >= 2 && activeSlots.every((slot) => tiles[slot] !== undefined)
	);

	function addSlot(): void {
		activeSlots = [...activeSlots, `tile-${activeSlots.length}`];
		tileNeighbors = gridNeighbors(activeSlots);
		everActiveSlots.add(activeSlots[activeSlots.length - 1]);
		placementsInitialized = false;
	}

	function setPhase(next: Phase): void {
		phase = next;
		if (next === 'export') {
			finetuneOpen = false;
		}
		if (next === 'assembled') {
			statusMessage = `Stitched from ${activeSlots.length} capture${activeSlots.length === 1 ? '' : 's'}.`;
		}
		if (next === 'assembling') {
			finetuneOpen = false;
			if (assemblingTimer) clearTimeout(assemblingTimer);
			const durationMs = prefersReducedMotion()
				? 60
				: Math.min(2400, 90 * activeSlots.length + 900);
			assemblingTimer = setTimeout(() => {
				assemblingTimer = null;
				if (phase === 'assembling') setPhase('assembled');
			}, durationMs);
		}
	}

	function advance(): void {
		if (phase === 'import') {
			if (!importComplete) return;
			setPhase('review');
		} else if (phase === 'review') {
			if (!croppedValidation?.ok) return;
			setPhase('assembling');
		} else if (phase === 'assembled') {
			setPhase('export');
		}
	}

	function goBack(): void {
		if (assemblingTimer) {
			clearTimeout(assemblingTimer);
			assemblingTimer = null;
		}
		if (phase === 'review') setPhase('import');
		else if (phase === 'assembling' || phase === 'assembled') setPhase('review');
		else if (phase === 'export') setPhase('assembled');
	}

	function primaryButtonLabel(): string {
		switch (phase) {
			case 'import':
				return 'Review crop →';
			case 'review':
				return 'Approve crop & assemble →';
			case 'assembling':
				return 'Assembling…';
			case 'assembled':
				return 'Continue to export →';
			case 'export':
				return '';
		}
	}

	function primaryButtonDisabled(): boolean {
		if (phase === 'import') return !importComplete;
		if (phase === 'review') return !croppedValidation?.ok;
		if (phase === 'assembling') return true;
		return false;
	}

	// ---------------------------------------------------------------------

	/** The union of all loaded cropped tile rectangles; the assembled/export fit target. */
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

	/** Filmstrip layout for the review phase, in original (uncropped) tile pixels: one row, left to right. */
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
			[slot]: { fileName: file.name, mimeType: file.type, widthPx, heightPx, image }
		};
		const cleared = { ...tileErrors };
		delete cleared[slot];
		tileErrors = cleared;
		statusMessage = `${slotLabel(slot)} loaded (${widthPx} x ${heightPx}).`;
	}

	function handleSmartImportFiles(event: Event): void {
		const input = event.currentTarget as HTMLInputElement;
		const files = Array.from(input.files ?? []);
		input.value = '';
		requestSmartImport(files);
	}

	/**
	 * Requests a bulk import (P1-001), gated by P1-002's re-run protection: when
	 * the current placements were manually refined away from the last automatic
	 * result, the user must explicitly confirm replacing the arrangement before
	 * anything is recomputed or overwritten.
	 */
	function requestSmartImport(files: File[]): void {
		if (files.length < 2) {
			statusMessage = `Import screenshots requires at least two files; received ${files.length}. The current session is unchanged.`;
			return;
		}
		if (requiresReplaceDecision(placements, lastAutoPlacements)) {
			pendingSmartImportFiles = files;
			replaceFocusRestore = document.activeElement instanceof HTMLElement ? document.activeElement : null;
			pendingReplaceConfirm = true;
			return;
		}
		void runSmartImport(files);
	}

	function settleReplaceConfirm(accept: boolean): void {
		const files = pendingSmartImportFiles;
		pendingSmartImportFiles = null;
		pendingReplaceConfirm = false;
		const target = replaceFocusRestore?.isConnected ? replaceFocusRestore : null;
		replaceFocusRestore = null;
		if (target) void tick().then(() => target.focus());
		if (!accept || !files) return;
		void runSmartImport(files);
	}

	$effect(() => {
		if (!pendingReplaceConfirm) return;
		void tick().then(() => replaceCancelButton?.focus());
	});

	/**
	 * One local-only bulk import (P1-001, hardened in P1-002; generalized to
	 * any N >= 2 screenshots). Decodes and analyzes N screenshots in any order,
	 * then commits the inferred arrangement, tiles, placements, confidence, and
	 * the summary as one coherent session replacement so a failure never
	 * damages the current valid session. A newer selection/reset/unmount
	 * invalidates the batch; a stale result publishes nothing. The computed
	 * placements always commit, even when the diagnostic flags a `review`
	 * warning: the automatic arrangement is the best evidence available and is
	 * never discarded in favor of a neutral manual layout, so a warning is
	 * guidance for review, not a reason to withhold correct output.
	 */
	async function runSmartImport(files: File[]): Promise<void> {
		const generation = decodeCoordinator.begin(SMART_IMPORT_BATCH);
		if (files.length < 2) {
			statusMessage = `Import screenshots requires at least two files; received ${files.length}. The current session is unchanged.`;
			return;
		}
		smartImportError = null;
		smartImportBusy = true;
		statusMessage = `Analyzing ${files.length} screenshots…`;
		try {
			const result = await smartImportViaWorker(files, {
				isCurrent: () => decodeCoordinator.isCurrent(SMART_IMPORT_BATCH, generation),
				applyCropMargin: addCropMargin
			});
			if (!result.ok) {
				if ('stale' in result) return;
				if (result.kind === 'wrong-count') {
					statusMessage = `Import screenshots supports two to ${MAX_AUTO_ARRANGE_TILES} files; received ${result.count}. The current session is unchanged.`;
					return;
				}
				smartImportError = result.message;
				statusMessage = `Smart import rejected "${result.fileName}"; the current session is unchanged.`;
				return;
			}
			const slots = result.order;
			const nextTiles: Partial<Record<TileSlot, StitchTile>> = {};
			const nextSummary: Partial<Record<TileSlot, string>> = {};
			for (const slot of slots) {
				const fileIndex = result.assignment[slot];
				if (fileIndex === undefined) continue;
				const tile = result.tiles[fileIndex];
				nextTiles[slot] = {
					fileName: tile.fileName,
					mimeType: tile.mimeType,
					widthPx: tile.widthPx,
					heightPx: tile.heightPx,
					image: tile.image
				};
				nextSummary[slot] = tile.fileName;
			}
			// The computed placements always commit — the automatic arrangement is
			// the best evidence available and is never discarded in favor of a
			// neutral manual layout, even when the diagnostic flags a warning.
			const nextPlacements = result.placements;
			// One coherent session replacement, not staggered slot mutations.
			activeSlots = [...slots];
			tileNeighbors = result.neighbors;
			for (const slot of slots) everActiveSlots.add(slot);
			tiles = nextTiles;
			tileErrors = {};
			placements = nextPlacements;
			placementsInitialized = true;
			lastAutoPlacements = snapshotPlacements(nextPlacements);
			selectedSlot = null;
			positionDraft = { xPx: '', yPx: '' };
			exportError = null;
			smartImportSummary = nextSummary;
			smartImportDiagnostic = result.diagnostic;
			cropProposal = result.cropProposal;
			cropProposalConfidence = result.crop.confidence;
			const order = slots.map((slot) => `${slotLabel(slot)}: ${nextSummary[slot]}`).join(', ');
			const label = categoryLabel(result.diagnostic.category);
			const warnings = result.diagnostic.warnings;
			statusMessage = `Smart import complete. Inferred order — ${order}. Confidence: ${label}.${
				warnings.length > 0 ? ` ${warnings.join(' ')}` : ''
			} Manual correction remains available.`;
			// A successful import is itself the "done" signal — advance straight to
			// Review instead of making the user click through a step that only
			// ever leads one place. Guarded to the import phase so a demo-capture
			// handoff arriving late can never yank a user back out of Review/Export.
			if (phase === 'import') setPhase('review');
		} finally {
			smartImportBusy = false;
		}
	}

	/** Copies a placement map so later manual edits can never alias the snapshot. */
	function snapshotPlacements(
		source: Partial<Record<TileSlot, TilePlacement>>
	): Partial<Record<TileSlot, TilePlacement>> {
		return Object.fromEntries(
			(Object.keys(source) as TileSlot[]).map((slot) => [slot, { ...source[slot] }])
		) as Partial<Record<TileSlot, TilePlacement>>;
	}

	function applyCropProposal(): void {
		if (!cropProposal) return;
		crop = { ...cropProposal };
		syncCropDraft(true);
		cropProposal = null;
		statusMessage = 'Suggested crop applied. Edit or reset it with the existing crop controls.';
	}

	function rejectCropProposal(): void {
		cropProposal = null;
		statusMessage = 'Suggested crop declined; the full images are kept.';
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
		if (!activeSlots.some((candidate) => tiles[candidate])) resetSession();
		statusMessage = `${slotLabel(slot)} removed.`;
	}

	function resetSession(): void {
		// No in-flight decode or smart-import batch may publish into the cleared
		// session; every slot ever active this session is invalidated, not just
		// the current active set, in case a prior (possibly larger) session left
		// a stale generation behind.
		decodeCoordinator.invalidateAll([...everActiveSlots]);
		decodeCoordinator.invalidate(SMART_IMPORT_BATCH);
		activeSlots = [...defaultSlotOrder(4)];
		tileNeighbors = gridNeighbors(activeSlots);
		everActiveSlots = new Set(activeSlots);
		crop = { ...ZERO_CROP };
		syncCropDraft(true);
		placements = initialPlacements(activeSlots, 1, 1);
		placementsInitialized = false;
		selectedSlot = null;
		positionDraft = { xPx: '', yPx: '' };
		previewOpacity = 0.6;
		exportError = null;
		smartImportBusy = false;
		smartImportError = null;
		smartImportSummary = null;
		cropProposal = null;
		smartImportDiagnostic = null;
		cropProposalConfidence = null;
		lastAutoPlacements = null;
		pendingReplaceConfirm = false;
		pendingSmartImportFiles = null;
		replaceFocusRestore = null;
		finetuneOpen = false;
		if (assemblingTimer) {
			clearTimeout(assemblingTimer);
			assemblingTimer = null;
		}
		phase = 'import';
		statusMessage = 'All screenshots cleared. The session and its crop and arrangement were reset.';
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
	}

	function resetCrop(): void {
		crop = { ...ZERO_CROP };
		syncCropDraft(true);
		statusMessage = 'Shared crop reset.';
	}

	// ---------------------------------------------------------------------
	// Crop-line close-up preview: a small per-tile magnified strip centered on
	// the exact boundary pixel, with a marker line at the cut itself. At the
	// review filmstrip's normal zoom a 1-2px chrome misread is invisible, and
	// getting that line wrong crops either real map content or leaves a sliver
	// of chrome in the stitched output — this exists so a user can actually
	// see the pixel the crop commits to, on every tile, before trusting it.
	// ---------------------------------------------------------------------

	/**
	 * Original-pixel size of the magnified region drawn into each strip: a
	 * small, fixed number of individual pixel ROWS above and below the cut,
	 * each rendered as its own large, gridlined block — not a continuously
	 * scaled image, where a multi-pixel-wide marker line can itself obscure
	 * the exact row it's supposed to indicate. Narrow on purpose (horizontal
	 * content doesn't help judge a horizontal crop line) and tall on purpose
	 * (more rows of real context), so all four captures' strips for both
	 * edges fit on screen at once without scrolling. The one row that's kept
	 * is outlined in green — the only unambiguous answer to "which row does
	 * this commit to."
	 */
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

		// `boundaryY` is the row index where state changes going downward: for
		// the top edge, everything before it is cropped and it is itself the
		// first kept row; for the bottom edge, everything before it is kept and
		// it is itself the first cropped row.
		const boundaryCanvasY = (boundaryY - srcY) * CROP_ZOOM_SCALE;

		// Shade the side that actually gets cut away — "kept vs. discarded" reads
		// at a glance; a bare line does not, especially on real chrome that
		// doesn't have a hard color edge (translucent status bars, gradients).
		ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
		if (edge === 'top') {
			ctx.fillRect(0, 0, width, boundaryCanvasY);
		} else {
			ctx.fillRect(0, boundaryCanvasY, width, height - boundaryCanvasY);
		}

		// A gridline between every individual source pixel row, so rows can be
		// counted rather than estimated.
		ctx.strokeStyle = 'rgba(255, 255, 255, 0.22)';
		ctx.lineWidth = 1;
		for (let row = 0; row <= srcH; row += 1) {
			const y = Math.round(row * CROP_ZOOM_SCALE) + 0.5;
			ctx.beginPath();
			ctx.moveTo(0, y);
			ctx.lineTo(width, y);
			ctx.stroke();
		}

		// The one row that's kept, outlined in green — the single unambiguous
		// answer to "which row does this commit to." Whichever side `edge`
		// puts it on flips which canvas position gets the outline.
		const keptRowY = edge === 'top' ? boundaryCanvasY : boundaryCanvasY - CROP_ZOOM_SCALE;
		ctx.lineWidth = 2;
		ctx.strokeStyle = '#4ade80';
		ctx.strokeRect(1, keptRowY + 1, width - 2, CROP_ZOOM_SCALE - 2);

		// The cut itself: a crisp 1px line exactly on the row boundary — never
		// more than 1 canvas pixel, so it can never read as covering a row of
		// real content.
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
	}

	function endCropDrag(): void {
		syncCropDraft(true);
	}

	function updatePlacement(slot: TileSlot, xPx: number, yPx: number): void {
		const placement = placements[slot];
		if (slot === anchorSlot || !tiles[slot] || !placement) return;
		placements = { ...placements, [slot]: { ...placement, xPx, yPx } };
		syncPositionDraft(true);
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
		if (phase !== 'assembled') return;
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
		statusMessage = 'Arrangement reset to the 25% overlap layout.';
	}

	/**
	 * Builds one Snap raster from a tile's current crop interior, at the
	 * standard full-resolution matcher raster size (P1-002 1b): Snap's old
	 * 512px-capped raster was the root of a real quantization/directional
	 * tie-break bug (see `cvMatch.ts`'s module doc comment). The same shared
	 * insets apply to every tile, so relative geometry is unchanged and Snap
	 * matches what is actually visible, not hidden chrome; a ZERO_CROP session
	 * uses the full frame automatically.
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
	 * Manual-correction "Snap" assist (P1-002 1b): once the selected tile is
	 * roughly in place (drag/nudge, or the automatic reconciled placement), a
	 * bounded local search locks it to the best nearby offset against its
	 * loaded expected neighbor(s) — a tile with two neighbors is snapped to the
	 * single position that best satisfies both at once. Backed by `cvMatch.ts`'s
	 * proven `matchTemplate` matcher (`snapAlign`/`matchTranslationNear`), the
	 * same one that does the automatic layout assignment — no separate scoring
	 * function. Async because the matcher is; `snapBusy` disables the
	 * control for the duration so a click gets feedback instead of an apparent
	 * no-op. Commits through `updatePlacement` — the one mutation point
	 * drag/nudge/numeric input already use — so position-draft sync and the
	 * re-run guard's replace-confirmation diff pick it up with no
	 * special-casing.
	 */
	async function snapSelectedTile(): Promise<void> {
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
	 * tile movement — even when other tiles cover the point. Everything else is
	 * left to the viewport (background pan) or click selection. Only active in
	 * the assembled phase — review's crop guides and import's plain HTML have
	 * their own claim paths.
	 */
	function claimAlignmentPointer(pointer: ScreenSpacePoint, event: PointerEvent): boolean {
		if (phase !== 'assembled') return false;
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
	 * Click selection in the assembled view: selects a movable tile only when
	 * the point lies inside exactly one visible tile — the anchored tile
	 * participates in ambiguity even though it can never be selected. Hidden
	 * tiles are never selectable.
	 */
	function onStageClick(pointer: ScreenSpacePoint): void {
		if (phase !== 'assembled') return;
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

	/** Crop-guide claim (review phase only): only Konva guide nodes claim; everything else pans. */
	function claimCropGuidePointer(pointer: ScreenSpacePoint): boolean {
		if (phase !== 'review') return false;
		const activeStage = stage;
		if (!activeStage) return false;
		const hit = activeStage.getIntersection(pointer);
		if (!hit) return false;
		return [...cropGuideTop.values(), ...cropGuideBottom.values()].includes(hit as Konva.Rect);
	}

	function claimStagePointer(pointer: ScreenSpacePoint, event: PointerEvent): boolean {
		if (phase === 'review') return claimCropGuidePointer(pointer);
		if (phase === 'assembled') return claimAlignmentPointer(pointer, event);
		return false;
	}

	function handleDownload(): void {
		if (!canExport) return;
		void runDownload();
	}

	async function runDownload(): Promise<void> {
		exportError = null;
		rendering = true;
		let url: string | null = null;
		try {
			const blob = await renderStitchedPng(exportTiles(), crop);
			url = URL.createObjectURL(blob);
			const anchor = document.createElement('a');
			anchor.href = url;
			anchor.download = stitchedFileName(exportTiles());
			document.body.appendChild(anchor);
			anchor.click();
			anchor.remove();
			statusMessage = 'Stitched PNG downloaded.';
		} catch (error) {
			exportError = error instanceof Error ? error.message : 'Could not export the stitched PNG.';
		} finally {
			if (url) URL.revokeObjectURL(url);
			rendering = false;
		}
	}

	function handoffDestination(role: ImageRole): string {
		return role === 'source-overview' ? `${base}/annotate-round` : `${base}/create-graphics`;
	}

	function handoffDestinationName(role: ImageRole): string {
		return role === 'source-overview' ? 'Annotate Round' : 'Create Graphics';
	}

	function handleUseAs(role: ImageRole): void {
		if (!canExport) return;
		const existing = getPendingHandoff();
		if (existing) {
			statusMessage = `A stitched image is already awaiting import in ${handoffDestinationName(existing.targetRole)}. Import or dismiss it before creating another handoff.`;
			return;
		}
		void runHandoff(role);
	}

	async function runHandoff(role: ImageRole): Promise<void> {
		exportError = null;
		rendering = true;
		try {
			const blob = await renderStitchedPng(exportTiles(), crop);
			setPendingHandoff({ blob, fileName: stitchedFileName(exportTiles()), targetRole: role });
			statusMessage = `Stitched image handed to ${handoffDestinationName(role)}.`;
			await goto(handoffDestination(role));
		} catch (error) {
			exportError = error instanceof Error ? error.message : 'Could not render the stitched image.';
		} finally {
			rendering = false;
		}
	}

	function exportTiles(): Array<{
		slot: TileSlot;
		fileName: string;
		image: HTMLImageElement;
		widthPx: number;
		heightPx: number;
		placement: TilePlacement;
	}> {
		const tilesForExport: Array<{
			slot: TileSlot;
			fileName: string;
			image: HTMLImageElement;
			widthPx: number;
			heightPx: number;
			placement: TilePlacement;
		}> = [];
		for (const slot of activeSlots) {
			const tile = tiles[slot];
			const placement = placements[slot];
			if (!tile || !placement) continue;
			tilesForExport.push({
				slot,
				fileName: tile.fileName,
				image: tile.image,
				widthPx: tile.widthPx,
				heightPx: tile.heightPx,
				placement
			});
		}
		return tilesForExport;
	}

	function readinessText(): string {
		if (report.ready) {
			return 'All screenshots, the shared crop, and tile overlap are valid. Export is ready.';
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
		return `Not ready to export: ${reasons.join('; ')}.`;
	}

	// ---------------------------------------------------------------------
	// Unified Konva scene (P2 single-viewport redesign)
	// ---------------------------------------------------------------------

	/** Per-tile crop-guide geometry in stage px, for the review phase (top/bottom only — see the template note). */
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
	 * Renders the current phase's static layout into the persistent Konva
	 * scene. Instant (no tween) — phase-to-phase motion is handled separately
	 * by `animateAssembling` so a transition is never interrupted by an
	 * unrelated re-render.
	 */
	function renderStage(): void {
		const activeStage = stage;
		const activeLayer = layer;
		if (!activeStage || !activeLayer || phase === 'import') return;
		activeLayer.destroyChildren();
		tileNodes.clear();
		cropGuideTop.clear();
		cropGuideBottom.clear();

		if (phase === 'review') {
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

		// assembling / assembled / export: real computed placements, cropped.
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
					opacity: phase === 'export' ? 0.85 : slot === selectedSlot ? previewOpacity : 1,
					listening: false
				})
			);
			if (slot === selectedSlot && phase === 'assembled') {
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
	 * The pile → filmstrip → assemble choreography's one real animated moment:
	 * tweens every tile node from its just-rendered review (filmstrip)
	 * position/size to its real computed placement. The crop itself swaps
	 * instantly at the start (not itself tweened — see the module note above
	 * `renderStage`) while position and size animate, which is what actually
	 * reads as "the mosaic assembling."
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

	let lastRenderedPhase: Phase | null = null;

	$effect(() => {
		const current = phase;
		if (current === lastRenderedPhase) return;
		const previous = lastRenderedPhase;
		lastRenderedPhase = current;
		if (current === 'import') return;
		untrack(() => {
			if (current === 'assembling' && previous === 'review') {
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

	$effect(() => {
		stage?.size(stageVp.size);
	});

	// The fit target follows whichever layout the current phase actually shows.
	$effect(() => {
		void tiles;
		void placements;
		void crop;
		void activeSlots;
		const current = phase;
		untrack(() => {
			if (current === 'review') stageVp.setFitTarget(filmstripFitTarget());
			else if (current === 'assembled' || current === 'export' || current === 'assembling') {
				stageVp.setFitTarget(assembledFitTarget());
			}
		});
	});

	// Rebuild the scene when the session, crop, or view changes (but never
	// mid-drag, and never for the phase's own entry animation — that already
	// rendered the correct end state via the phase-change effect above).
	$effect(() => {
		void tiles;
		void crop;
		void placements;
		void selectedSlot;
		void previewOpacity;
		void stageVp.view;
		void stageVp.size;
		untrack(() => {
			if (phase === 'import' || phase === 'assembling') return;
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
			statusMessage = 'All screenshots loaded. Initial 25% overlap layout created.';
		}
	});

	/**
	 * Eager OpenCV warm-up (P1-002 1b, extended 1c), deliberately simple: fire
	 * off both loads on mount, non-blocking, and let each cache its own promise
	 * for later real use (`loadCv()` on the main thread for Snap;
	 * `warmSmartStitchWorker()` constructs the worker so its own module-scope
	 * `loadCv()` call fires there too). Two independent ~15MB loads, one per
	 * thread — not sharing one instance between realms is intentional (see
	 * `cvMatch.ts`'s module doc comment and the roadmap's P1-002 1b notes), not
	 * an oversight. Neither call is awaited: nothing here blocks rendering, and
	 * a real Snap or smart-import call later simply awaits the by-then-likely-
	 * already-resolved cached promise instead of paying the cold-load cost
	 * itself.
	 */
	$effect(() => {
		void loadCv().then((cv) => warmMatchTemplate(cv));
		warmSmartStitchWorker();
	});

	onMount(() => {
		// The guided demo (/demo) drops real UDisc captures into a one-shot inbox
		// and navigates here. They enter through requestSmartImport — the exact
		// entry point the "Import screenshots" file input uses — so the
		// arrangement a visitor watches appear is computed by the product now,
		// never supplied by the demo. Re-run protection still applies: a session
		// already refined by hand asks before it is replaced.
		const claimCaptures = (): void => {
			const captures = takePendingStitchCaptures();
			if (captures) requestSmartImport(captures);
		};
		claimCaptures();
		// Captures deposited while this page is already mounted — the rail arming
		// a step the visitor is standing on — would otherwise sit unclaimed until
		// the next navigation, after the rail already reported success.
		return subscribePendingStitchCaptures(claimCaptures);
	});

	onDestroy(() => {
		// An in-flight smart-import batch must never publish after unmount, and
		// the page no longer owns the smart-stitch worker once it is gone.
		decodeCoordinator.invalidate(SMART_IMPORT_BATCH);
		disposeSmartStitchWorker();
		endTileDrag();
		if (assemblingTimer) clearTimeout(assemblingTimer);
		stage?.destroy();
		stage = null;
		layer = null;
	});
</script>

<svelte:head>
	<title>Stitch Map | ChainSpot</title>
</svelte:head>

<main>
	{#if exportError}
		<p class="error" data-testid="stitch-error" role="alert">{exportError}</p>
	{/if}

	<h2>Stitch Map</h2>

	<div class="stage-card">
		<div class="stage-progress">
			{#each PROGRESS_LABELS as label, i (label)}
				{#if i > 0}
					<div class="prog-line" class:done={i <= PROGRESS_INDEX[phase]}></div>
				{/if}
				<div
					class="prog-step"
					class:done={i < PROGRESS_INDEX[phase]}
					class:current={i === PROGRESS_INDEX[phase]}
				>
					<span class="prog-dot">{i < PROGRESS_INDEX[phase] ? '✓' : i + 1}</span>{label}
				</div>
			{/each}
		</div>

		<div class="stage-context">
			{#if phase === 'import'}
				<span
					>Add two or more overlapping screenshots. ChainSpot infers their arrangement, places
					them, and may suggest a shared crop.</span
				>
				<span class="badge">{activeSlots.filter((slot) => tiles[slot]).length} added</span>
			{:else if phase === 'review'}
				<span>Drag a line to nudge the shared crop, or use the numeric fields below.</span>
				{#if smartImportDiagnostic}
					<span class="badge" class:strong={smartImportDiagnostic.category === 'ok'}
						>{categoryLabel(smartImportDiagnostic.category)}</span
					>
				{/if}
			{:else if phase === 'assembling'}
				<span>Cropping and stitching…</span>
				<span class="badge strong">● working</span>
			{:else if phase === 'assembled'}
				<span>Stitched from {activeSlots.length} capture{activeSlots.length === 1 ? '' : 's'}.</span>
				{#if smartImportDiagnostic}
					<span class="badge" class:strong={smartImportDiagnostic.category === 'ok'}
						>{categoryLabel(smartImportDiagnostic.category)}</span
					>
				{/if}
			{:else if phase === 'export'}
				<span>Choose where the stitched map goes next.</span>
			{/if}
		</div>

		{#if phase === 'import'}
			<div class="import-panel">
				<section class="smart-import-section" aria-labelledby="smart-import-heading">
					<h3 id="smart-import-heading">Import screenshots</h3>
					<p class="section-note">
						Select two or more overlapping screenshots in any order. The existing controls remain
						available for correction.
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
								disabled={smartImportBusy}
								onchange={handleSmartImportFiles}
							/>
						</label>
						{#if smartImportBusy}
							<span class="status" role="status">Analyzing…</span>
						{/if}
					</div>
					<label
						class="crop-margin-toggle"
						title="AutoStitch may be unreliable without Add margin. If you have it disabled and your stitch doesn't align, try enabling Add margin."
					>
						<input type="checkbox" bind:checked={addCropMargin} data-testid="crop-margin-toggle" />
						Add margin — trim a couple extra pixels of the suggested crop for safety
					</label>
					{#if smartImportError}
						<p class="error" data-testid="smart-import-error" role="alert">{smartImportError}</p>
					{/if}
					{#if smartImportSummary}
						<ul
							class="smart-assignment"
							data-testid="smart-import-assignment"
							aria-label="Inferred screenshot order"
						>
							{#each activeSlots as slot (slot)}
								<li>
									<span class="assignment-label">{slotLabel(slot)}:</span>
									<span data-testid={`smart-import-slot-${slot}`}>{smartImportSummary[slot]}</span>
								</li>
							{/each}
						</ul>
					{/if}
					{#if smartImportDiagnostic}
						<p class="smart-confidence" data-testid="smart-import-confidence" role="status">
							Automatic arrangement confidence: {categoryLabel(smartImportDiagnostic.category)}.
						</p>
						{#if smartImportDiagnostic.warnings.length > 0}
							<ul
								class="smart-warnings"
								data-testid="smart-import-warnings"
								aria-label="Automatic arrangement warnings"
							>
								{#each smartImportDiagnostic.warnings as warning, index (warning)}
									<li data-testid={`smart-import-warning-${index}`}>{warning}</li>
								{/each}
							</ul>
						{/if}
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
							/>
						{/each}
						<button type="button" class="add-tile" data-testid="add-capture" onclick={addSlot}>
							+ Add capture
						</button>
					</div>
				</section>
			</div>
		{:else}
			<div class="stage-canvas" data-phase={phase}>
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

				{#if phase === 'review'}
					{#if !cropProposal}
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
								Close-up at the exact crop line, per screenshot — check every one before advancing.
							</p>
							{@render cropZoomRow(crop.topPx, crop.bottomPx)}
						</div>
					{/if}
					{#if cropProposal}
						<div class="crop-proposal" data-testid="crop-proposal" role="status">
							<h4>Apply suggested crop?</h4>
							<p>
								Suggested shared crop:
								<span data-testid="crop-proposal-insets">
									top {cropProposal.topPx}px, right {cropProposal.rightPx}px, bottom
									{cropProposal.bottomPx}px, left {cropProposal.leftPx}px
								</span>
								{#if addCropMargin}
									<span class="crop-margin-note">(includes the safety margin)</span>
								{/if}
							</p>
							<p class="crop-zoom-hint">
								Verify the line lands on chrome, not map content, on every screenshot — a 1-2px
								miss here is invisible at normal zoom but ruins the stitch.
							</p>
							{@render cropZoomRow(cropProposal.topPx, cropProposal.bottomPx)}
							{#if cropProposalConfidence}
								<p class="crop-confidence" data-testid="crop-confidence">
									Crop suggestion confidence: {CROP_CONFIDENCE_LABELS[cropProposalConfidence]}.
								</p>
							{/if}
							<div class="proposal-actions">
								<button
									type="button"
									class="apply-crop-button"
									data-testid="apply-suggested-crop"
									onclick={applyCropProposal}
								>
									Apply Crop
								</button>
								<button type="button" data-testid="keep-full-images" onclick={rejectCropProposal}>
									Keep full images
								</button>
							</div>
						</div>
					{/if}
				{/if}

				<div class="finetune-drawer" class:open={finetuneOpen}>
					<button
						type="button"
						class="drawer-close"
						onclick={() => (finetuneOpen = false)}
						aria-label="Close fine-tune drawer"
					>
						Close ✕
					</button>
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
				</div>

				{#if phase === 'export'}
					<div class="export-panel open">
						<h3>Export</h3>
						<p class="sub">
							All {activeSlots.length} capture{activeSlots.length === 1 ? '' : 's'}, the shared
							crop, and tile overlap are valid.
						</p>
						<div class="export-card primary">
							<h4>Download stitched PNG</h4>
							<p>Full-resolution stitched map, no annotations.</p>
							<button
								type="button"
								class="btn primary small"
								data-testid="download-stitched"
								disabled={!canExport}
								onclick={handleDownload}
							>
								Download PNG
							</button>
						</div>
						<div class="export-card">
							<h4>Use as UDisc source</h4>
							<p>Carry it into Annotate Round as the UDisc reference image.</p>
							<button
								type="button"
								class="btn small"
								data-testid="use-as-source"
								disabled={!canExport}
								onclick={() => handleUseAs('source-overview')}
							>
								Send to Annotate Round
							</button>
						</div>
						<div class="export-card">
							<h4>Use as clean target</h4>
							<p>Carry it into Create Graphics as an unmarked base.</p>
							<button
								type="button"
								class="btn small"
								data-testid="use-as-target"
								disabled={!canExport}
								onclick={() => handleUseAs('target-basemap')}
							>
								Send to Create Graphics
							</button>
						</div>
						{#if rendering}
							<span class="status" role="status">Rendering…</span>
						{/if}
						<button type="button" class="btn ghost small" style="margin-top:auto;" onclick={resetSession}>
							↻ Start a new map
						</button>
					</div>
				{/if}

			</div>
			<p class="preview-note">
				Preview-only: hiding a tile, changing opacity, zooming, or panning never changes the
				exported PNG.
			</p>
			<p class="stage-readiness" data-testid="stitch-readiness" role="status">{readinessText()}</p>
		{/if}

		<div class="stage-actions">
			<button
				type="button"
				class="btn ghost"
				data-testid="back-button"
				style:visibility={phase === 'import' ? 'hidden' : 'visible'}
				onclick={goBack}
			>
				← Back
			</button>
			<button
				type="button"
				class="finetune-link"
				style:visibility={phase === 'assembled' ? 'visible' : 'hidden'}
				onclick={() => (finetuneOpen = !finetuneOpen)}
			>
				Looks a little off? Fine-tune manually
			</button>
			{#if phase !== 'export'}
				<button
					type="button"
					class="btn primary"
					data-testid="primary-advance"
					disabled={primaryButtonDisabled()}
					onclick={advance}
				>
					{primaryButtonLabel()}
				</button>
			{/if}
		</div>
	</div>

	{#if statusMessage}
		<p role="status">{statusMessage}</p>
	{/if}

	{#if pendingReplaceConfirm}
		<div class="modal-backdrop" role="presentation">
			<div
				class="modal"
				role="dialog"
				aria-modal="true"
				aria-labelledby="replace-confirm-title"
				use:dialogKeyboard={() => settleReplaceConfirm(false)}
			>
				<h3 id="replace-confirm-title">Replace current arrangement?</h3>
				<p>
					You've manually adjusted the current arrangement. Importing new screenshots will
					recompute the arrangement from scratch and discard your manual changes.
				</p>
				<div class="modal-actions">
					<button
						type="button"
						bind:this={replaceCancelButton}
						onclick={() => settleReplaceConfirm(false)}
					>
						Cancel
					</button>
					<button type="button" onclick={() => settleReplaceConfirm(true)}>
						Replace arrangement
					</button>
				</div>
			</div>
		</div>
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

	.section-note,
	.preview-note {
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

	.crop-margin-note {
		color: #71717a;
		font-size: 0.75rem;
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

	.smart-confidence {
		margin: 0;
		font-size: 0.85rem;
		color: #a1a1aa;
	}

	.smart-warnings {
		margin: 0;
		padding-left: 1.1rem;
		font-size: 0.8rem;
		color: #fbbf24;
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

	/* ---- persistent canvas (review / assembling / assembled / export) ---- */
	.stage-canvas {
		position: relative;
		width: 100%;
		aspect-ratio: 16 / 9;
		min-height: 320px;
		max-height: 70vh;
		background: #0e0e10;
		overflow: hidden;
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

	.crop-proposal {
		position: absolute;
		top: 12px;
		left: 12px;
		right: 12px;
		z-index: 6;
		max-height: calc(100% - 24px);
		overflow-y: auto;
		padding: 0.85rem 1rem;
		border-radius: 8px;
		background: #0f2320;
		border: 1px solid #2e5c48;
		font-size: 0.8rem;
	}

	.crop-proposal h4 {
		margin: 0 0 0.4rem;
		font-size: 0.9rem;
	}

	.crop-proposal p {
		margin: 0 0 0.4rem;
		color: #a1a1aa;
	}

	.crop-proposal .crop-zoom-block {
		margin-bottom: 0.5rem;
	}

	.proposal-actions {
		display: flex;
		gap: 0.5rem;
		margin-top: 0.5rem;
	}

	.apply-crop-button {
		background: #2dd4bf;
		color: #04211f;
		border: none;
		font-weight: 600;
	}

	.proposal-actions button {
		font-size: 0.75rem;
		padding: 0.4rem 0.7rem;
		border-radius: 6px;
		border: 1px solid #3f3f46;
		background: #27272a;
		color: #e4e4e7;
		cursor: pointer;
	}

	/* ---- fine-tune drawer (bottom sheet) ---- */
	.finetune-drawer {
		position: absolute;
		left: 0;
		right: 0;
		bottom: 0;
		background: #18181b;
		border-top: 1px solid #3f3f46;
		transform: translateY(100%);
		transition: transform 0.4s cubic-bezier(0.4, 0.7, 0.25, 1);
		padding: 1rem 1.25rem;
		display: flex;
		flex-wrap: wrap;
		gap: 1.5rem;
		z-index: 7;
	}

	@media (prefers-reduced-motion: reduce) {
		.finetune-drawer,
		.export-panel {
			transition-duration: 0.01ms;
		}
	}

	.finetune-drawer.open {
		transform: translateY(0);
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

	.drawer-close {
		position: absolute;
		top: 0.5rem;
		right: 0.75rem;
		background: none;
		border: none;
		color: #71717a;
		cursor: pointer;
		font-size: 0.75rem;
	}

	.btn {
		font-size: 0.75rem;
		padding: 0.4rem 0.7rem;
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

	/* ---- export drawer (right slide-in) ---- */
	.export-panel {
		position: absolute;
		top: 0;
		right: 0;
		bottom: 0;
		width: min(100%, 320px);
		background: #18181b;
		border-left: 1px solid #3f3f46;
		transform: translateX(100%);
		transition: transform 0.5s cubic-bezier(0.4, 0.7, 0.25, 1);
		padding: 1.1rem;
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		z-index: 8;
		overflow-y: auto;
	}

	.export-panel.open {
		transform: translateX(0);
	}

	.export-panel .sub {
		margin: 0 0 0.4rem;
		font-size: 0.75rem;
		color: #a1a1aa;
	}

	.export-card {
		border: 1px solid #3f3f46;
		border-radius: 8px;
		padding: 0.75rem;
		background: #0e0e10;
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
	}

	.export-card.primary {
		border-color: #fbbf24;
		background: #1b1608;
	}

	.export-card h4 {
		margin: 0;
		font-size: 0.8rem;
	}

	.export-card p {
		margin: 0;
		font-size: 0.7rem;
		color: #a1a1aa;
		line-height: 1.4;
	}

	.preview-note {
		margin: 0.75rem 1.25rem 0;
		font-size: 0.7rem;
	}

	.stage-readiness {
		margin: 0.35rem 1.25rem 0;
		font-size: 0.7rem;
		color: #a1a1aa;
	}

	/* ---- bottom action bar ---- */
	.stage-actions {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		padding: 0.9rem 1.25rem;
		border-top: 1px solid #27272a;
	}

	.finetune-link {
		font-size: 0.8rem;
		color: #a1a1aa;
		background: none;
		border: none;
		cursor: pointer;
		text-decoration: underline;
		text-underline-offset: 3px;
	}

	.finetune-link:hover {
		color: #e4e4e7;
	}

	/* ---- replace-confirmation modal ---- */
	.modal-backdrop {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.6);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 20;
	}

	.modal {
		background: #18181b;
		border: 1px solid #3f3f46;
		border-radius: 10px;
		padding: 1.25rem;
		max-width: 26rem;
	}

	.modal h3 {
		margin: 0 0 0.6rem;
	}

	.modal p {
		margin: 0 0 1rem;
		font-size: 0.85rem;
		color: #a1a1aa;
	}

	.modal-actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
	}

	.modal-actions button {
		font-size: 0.8rem;
		padding: 0.4rem 0.8rem;
		border-radius: 6px;
		border: 1px solid #3f3f46;
		background: #27272a;
		color: #e4e4e7;
		cursor: pointer;
	}
</style>
