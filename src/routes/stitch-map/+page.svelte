<script lang="ts">
	import { goto } from '$app/navigation';
	import Konva from 'konva';
	import { onDestroy, tick, untrack } from 'svelte';
	import ImageViewport from '$lib/components/ImageViewport.svelte';
	import StitchTileSlot from '$lib/components/StitchTileSlot.svelte';
	import { dialogKeyboard } from '$lib/focusManagement';
	import { CLICK_SLOP_PX, ViewportController } from '$lib/viewport.svelte';
	import type { ViewportFitTarget } from '$lib/viewport.svelte';
	import { decodeImageFile, isSupportedMimeType } from '$lib/imageIntake';
	import { isEditableTarget } from '$lib/pointSelection';
	import { canvas2dAvailable } from '$lib/scene';
	import {
		TILE_SLOTS,
		ZERO_CROP,
		cropSize,
		initialPlacements,
		readiness,
		sessionDimensions,
		tileRect,
		unionBounds
	} from '$lib/stitch/geometry';
	import type { CropInsetField, CropInsets, TilePlacement, TileSlot } from '$lib/stitch/geometry';
	import { TileDecodeCoordinator, guardedDecode } from '$lib/stitch/tileIntake';
	import { smartImportFiles } from '$lib/stitch/smartImport';
	import { diagnosticText, categoryLabel } from '$lib/stitch/diagnostics';
	import type { LayoutDiagnostic } from '$lib/stitch/diagnostics';
	import { requiresReplaceDecision } from '$lib/stitch/rerunGuard';
	import { renderStitchedPng, stitchedFileName } from '$lib/stitch/render';
	import { getPendingHandoff, setPendingHandoff } from '$lib/stitch/handoff';
	import type { ImageRole } from '$lib/domain/project';
	import type { ImageSpacePoint, ScreenSpacePoint } from '$lib/coords';

	interface StitchTile {
		fileName: string;
		mimeType: string;
		widthPx: number;
		heightPx: number;
		image: HTMLImageElement;
	}

	const SLOT_LABELS: Record<TileSlot, string> = {
		'upper-left': 'Upper left',
		'upper-right': 'Upper right',
		'lower-left': 'Lower left',
		'lower-right': 'Lower right'
	};

	const CROP_FIELDS: readonly CropInsetField[] = ['topPx', 'rightPx', 'bottomPx', 'leftPx'];

	const CROP_FIELD_LABELS: Record<CropInsetField, string> = {
		topPx: 'Top',
		rightPx: 'Right',
		bottomPx: 'Bottom',
		leftPx: 'Left'
	};

	const MOVABLE_SLOTS: readonly TileSlot[] = ['upper-right', 'lower-left', 'lower-right'];

	const CROP_HANDLE_SIZE = 10;

	/** Reserved coordinator key guarding one whole smart-import batch (P1-001). */
	const SMART_IMPORT_BATCH = '__smart-import__';

	/** Session tiles: transient browser resources only, never durable project state. */
	let tiles = $state<Partial<Record<TileSlot, StitchTile>>>({});
	let tileErrors = $state<Partial<Record<TileSlot, string>>>({});
	/** Per-slot decode generations: stale in-flight decodes never publish results. */
	const decodeCoordinator = new TileDecodeCoordinator();

	/** Authoritative committed crop; drafts may be invalid without touching it. */
	let crop = $state<CropInsets>({ ...ZERO_CROP });
	let cropDraft = $state<{ topPx: string; rightPx: string; bottomPx: string; leftPx: string }>({
		topPx: '0',
		rightPx: '0',
		bottomPx: '0',
		leftPx: '0'
	});
	let cropInputs = $state<Partial<Record<CropInsetField, HTMLInputElement | null>>>({});

	let placements = $state<Record<TileSlot, TilePlacement>>(initialPlacements(1, 1));
	let placementsInitialized = $state(false);
	let selectedSlot = $state<TileSlot | null>(null);
	let positionDraft = $state({ xPx: '', yPx: '' });
	let xPositionInput = $state<HTMLInputElement | null>(null);
	let yPositionInput = $state<HTMLInputElement | null>(null);
	let previewOpacity = $state(0.6);
	let alignmentWorkspace = $state<HTMLDivElement | null>(null);

	let alignmentVp = new ViewportController();
	let cropVp = new ViewportController();

	let alignmentStage = $state<Konva.Stage | null>(null);
	let cropStage = $state<Konva.Stage | null>(null);
	let alignmentLayer = $state<Konva.Layer | null>(null);
	let cropLayer = $state<Konva.Layer | null>(null);
	/** Live tile groups so a drag preview moves the image and its highlight together. */
	let tileNodes = new Map<TileSlot, Konva.Group>();
	/** Live nodes of the crop scene so drags can move them without rebuilding. */
	let cropRectNode = $state<Konva.Rect | null>(null);
	let cropHandles = $state<Partial<Record<CropInsetField, Konva.Rect>>>({});
	/** True only between a crop-handle dragstart and dragend (Konva-native drag). */
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

	/** P1-001 smart-import state: transient, never durable. */
	let smartImportBusy = $state(false);
	let smartImportError = $state<string | null>(null);
	let smartImportSummary = $state<Partial<Record<TileSlot, string>> | null>(null);
	let cropProposal = $state<CropInsets | null>(null);

	/** P1-002 hardening state: transient diagnostic/confirmation state only. */
	let smartImportDiagnostic = $state<LayoutDiagnostic | null>(null);
	let cropProposalConfidence = $state<'high' | 'low' | 'absent' | null>(null);
	/** The automatic result's committed placements; a re-run over manual edits must confirm. */
	let lastAutoPlacements: Record<TileSlot, TilePlacement> | null = null;
	let pendingReplaceConfirm = $state(false);
	let pendingSmartImportFiles: File[] | null = null;
	/** Replace-dialog focus management follows the established P0 pattern. */
	let replaceCancelButton = $state<HTMLButtonElement | null>(null);
	let replaceFocusRestore: HTMLElement | null = null;

	const CROP_CONFIDENCE_LABELS: Record<'high' | 'low' | 'absent', string> = {
		high: 'high — all four screenshots agree on the shared edge bands',
		low: 'low — edge evidence is partial or conflicts; inspect before applying',
		absent: 'none — no shared outer band could be confirmed'
	};

	const required = $derived(sessionDimensions(tiles));
	const croppedValidation = $derived(
		required ? cropSize(crop, required.widthPx, required.heightPx) : null
	);
	const report = $derived(readiness(tiles, crop, placements, required));
	const invalidCropFields = $derived(computeInvalidCropFields());
	const canExport = $derived(
		report.ready && !rendering && invalidCropFields.length === 0
	);

	/** The union of all loaded cropped tile rectangles; the alignment fit target. */
	function alignmentFitTarget(): ViewportFitTarget | null {
		const validation = croppedValidation;
		if (!validation?.ok) return null;
		const rects = TILE_SLOTS.filter((slot) => tiles[slot]).map((slot) =>
			tileRect(placements[slot], validation.widthPx, validation.heightPx)
		);
		const union = unionBounds(rects);
		if (!union) return null;
		return { xPx: union.xPx, yPx: union.yPx, widthPx: union.widthPx, heightPx: union.heightPx };
	}

	function cropGeometry():
		| { rectX: number; rectY: number; rectWidth: number; rectHeight: number }
		| null {
		const tile = tiles['upper-left'];
		if (!tile) return null;
		const view = cropVp.view;
		const rectX = view.panX + crop.leftPx * view.zoom;
		const rectY = view.panY + crop.topPx * view.zoom;
		const rectWidth = Math.max(0, (tile.widthPx - crop.leftPx - crop.rightPx) * view.zoom);
		const rectHeight = Math.max(0, (tile.heightPx - crop.topPx - crop.bottomPx) * view.zoom);
		return { rectX, rectY, rectWidth, rectHeight };
	}

	function cropHandleAnchor(
		field: CropInsetField,
		g: { rectX: number; rectY: number; rectWidth: number; rectHeight: number }
	): { x: number; y: number } {
		switch (field) {
			case 'topPx':
				return { x: g.rectX + g.rectWidth / 2, y: g.rectY };
			case 'rightPx':
				return { x: g.rectX + g.rectWidth, y: g.rectY + g.rectHeight / 2 };
			case 'bottomPx':
				return { x: g.rectX + g.rectWidth / 2, y: g.rectY + g.rectHeight };
			case 'leftPx':
				return { x: g.rectX, y: g.rectY + g.rectHeight / 2 };
		}
	}

	/** Per-handle clamp keeps the crop box at least 1 px so it can never collapse. */
	function maxInset(field: CropInsetField, tile: StitchTile): number {
		switch (field) {
			case 'leftPx':
				return Math.max(0, tile.widthPx - crop.rightPx - 1);
			case 'rightPx':
				return Math.max(0, tile.widthPx - crop.leftPx - 1);
			case 'topPx':
				return Math.max(0, tile.heightPx - crop.bottomPx - 1);
			case 'bottomPx':
				return Math.max(0, tile.heightPx - crop.topPx - 1);
		}
	}

	/**
	 * Moves the existing crop rect and non-dragged handles to the current crop
	 * values without rebuilding the layer, so a handle drag slides smoothly and
	 * the dragged node is never destroyed mid-drag.
	 */
	function updateCropSceneGeometry(): void {
		const g = cropGeometry();
		if (!g) return;
		cropRectNode?.position({ x: g.rectX, y: g.rectY });
		cropRectNode?.size({ width: g.rectWidth, height: g.rectHeight });
		for (const field of CROP_FIELDS) {
			const handle = cropHandles[field];
			if (!handle || handle.isDragging()) continue;
			const anchor = cropHandleAnchor(field, g);
			handle.position({
				x: anchor.x - CROP_HANDLE_SIZE / 2,
				y: anchor.y - CROP_HANDLE_SIZE / 2
			});
		}
		cropLayer?.batchDraw();
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
		if (!slot || slot === 'upper-left' || !placements[slot]) {
			positionDraft = { xPx: '', yPx: '' };
			return;
		}
		if (
			force ||
			(document.activeElement !== xPositionInput && document.activeElement !== yPositionInput)
		) {
			positionDraft = { xPx: String(placements[slot].xPx), yPx: String(placements[slot].yPx) };
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
		const other = TILE_SLOTS.find((candidate) => candidate !== slot && tiles[candidate]);
		if (other) {
			const otherTile = tiles[other];
			if (otherTile && (widthPx !== otherTile.widthPx || heightPx !== otherTile.heightPx)) {
				tileErrors = {
					...tileErrors,
					[slot]: `"${file.name}" is ${widthPx} x ${heightPx} but the session requires ${otherTile.widthPx} x ${otherTile.heightPx}. Recapture all four screenshots at the same device orientation and screenshot size.`
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
		statusMessage = `${SLOT_LABELS[slot]} loaded (${widthPx} x ${heightPx}).`;
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
		if (files.length !== 4) {
			statusMessage = `Import four screenshots requires exactly four files; received ${files.length}. The current session is unchanged.`;
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
	 * One local-only bulk import (P1-001, hardened in P1-002). Decodes and
	 * analyzes exactly four screenshots in any order, then commits tiles,
	 * placements, confidence, and the summary as one coherent session
	 * replacement so a failure never damages the current valid session. A newer
	 * selection/reset/unmount invalidates the batch; a stale result publishes
	 * nothing. An `uncertain` diagnostic still loads every decoded file into the
	 * manual starting layout rather than discarding or blocking.
	 */
	async function runSmartImport(files: File[]): Promise<void> {
		const generation = decodeCoordinator.begin(SMART_IMPORT_BATCH);
		if (files.length !== 4) {
			statusMessage = `Import four screenshots requires exactly four files; received ${files.length}. The current session is unchanged.`;
			return;
		}
		smartImportError = null;
		smartImportBusy = true;
		statusMessage = `Analyzing ${files.length} screenshots…`;
		try {
			const result = await smartImportFiles(files, {
				isCurrent: () => decodeCoordinator.isCurrent(SMART_IMPORT_BATCH, generation)
			});
			if (!result.ok) {
				if ('stale' in result) return;
				if (result.kind === 'wrong-count') {
					statusMessage = `Import four screenshots requires exactly four files; received ${result.count}. The current session is unchanged.`;
					return;
				}
				smartImportError = result.message;
				statusMessage = `Smart import rejected "${result.fileName}"; the current session is unchanged.`;
				return;
			}
			const nextTiles: Partial<Record<TileSlot, StitchTile>> = {};
			const nextSummary: Partial<Record<TileSlot, string>> = {};
			for (const slot of TILE_SLOTS) {
				const fileIndex = result.assignment[slot];
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
			const firstTile = result.tiles[0];
			// A coherent best attempt loads with its inferred placements; an
			// uncertain result loads every file into the neutral manual starting
			// layout so the user corrects it instead of being blocked.
			const nextPlacements =
				result.diagnostic.category === 'uncertain'
					? initialPlacements(firstTile.widthPx, firstTile.heightPx)
					: result.placements;
			// One coherent session replacement, not staggered slot mutations.
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
			alignmentVp.fit();
			const order = TILE_SLOTS.map((slot) => `${SLOT_LABELS[slot]}: ${nextSummary[slot]}`).join(', ');
			const { label, warnings } = diagnosticText(result.diagnostic);
			if (result.diagnostic.category === 'uncertain') {
				statusMessage = `Automatic arrangement was uncertain — manual correction required. All four screenshots were loaded into the manual starting layout.${
					warnings.length > 0 ? ` ${warnings.join(' ')}` : ''
				}`;
			} else {
				statusMessage = `Smart import complete. Inferred order — ${order}. Confidence: ${label}.${
					warnings.length > 0 ? ` ${warnings.join(' ')}` : ''
				} Manual correction remains available.`;
			}
		} finally {
			smartImportBusy = false;
		}
	}

	/** Copies a placement map so later manual edits can never alias the snapshot. */
	function snapshotPlacements(
		source: Record<TileSlot, TilePlacement>
	): Record<TileSlot, TilePlacement> {
		return Object.fromEntries(
			TILE_SLOTS.map((slot) => [slot, { ...source[slot] }])
		) as Record<TileSlot, TilePlacement>;
	}

	function applyCropProposal(): void {
		if (!cropProposal) return;
		crop = { ...cropProposal };
		syncCropDraft(true);
		renderCropScene();
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
		if (!TILE_SLOTS.some((candidate) => tiles[candidate])) resetSession();
		statusMessage = `${SLOT_LABELS[slot]} removed.`;
	}

	function resetSession(): void {
		// No in-flight decode or smart-import batch may publish into the cleared session.
		decodeCoordinator.invalidateAll(TILE_SLOTS);
		decodeCoordinator.invalidate(SMART_IMPORT_BATCH);
		crop = { ...ZERO_CROP };
		syncCropDraft(true);
		placements = initialPlacements(1, 1);
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
		renderCropScene();
	}

	function resetCrop(): void {
		crop = { ...ZERO_CROP };
		syncCropDraft(true);
		renderCropScene();
		statusMessage = 'Shared crop reset.';
	}

	function updateCropDrag(field: CropInsetField, value: number): void {
		crop = { ...crop, [field]: value };
		syncCropDraft(false);
	}

	function endCropDrag(): void {
		syncCropDraft(true);
		renderCropScene();
	}

	function updatePlacement(slot: TileSlot, xPx: number, yPx: number): void {
		if (slot === 'upper-left' || !tiles[slot] || !placements[slot]) return;
		placements = { ...placements, [slot]: { ...placements[slot], xPx, yPx } };
		syncPositionDraft(true);
	}

	function selectSlot(slot: TileSlot | null): void {
		if (slot !== null && (slot === 'upper-left' || !tiles[slot])) return;
		selectedSlot = slot;
		syncPositionDraft(true);
		if (slot) alignmentWorkspace?.focus();
	}

	function handlePositionInput(field: 'xPx' | 'yPx', event: Event): void {
		positionDraft = { ...positionDraft, [field]: (event.currentTarget as HTMLInputElement).value };
	}

	function commitPosition(field: 'xPx' | 'yPx'): void {
		const slot = selectedSlot;
		if (!slot || slot === 'upper-left') return;
		const raw = positionDraft[field].trim();
		// Signed base-10 integers only: tiles may sit left or above the anchor.
		if (!/^[+-]?\d+$/.test(raw)) {
			syncPositionDraft(true);
			return;
		}
		const value = parseInt(raw, 10);
		updatePlacement(
			slot,
			field === 'xPx' ? value : placements[slot].xPx,
			field === 'yPx' ? value : placements[slot].yPx
		);
	}

	/**
	 * Scoped arrow-key nudge: only fires when the alignment group itself owns
	 * focus, never from bubbled events on descendant controls or editable fields.
	 */
	function handleAlignmentKeyDown(event: KeyboardEvent): void {
		if (event.target !== event.currentTarget) return;
		if (isEditableTarget(event.target)) return;
		const slot = selectedSlot;
		if (!slot || slot === 'upper-left') return;
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
		updatePlacement(slot, placements[slot].xPx + dx, placements[slot].yPx + dy);
	}

	function toggleTileVisible(slot: TileSlot): void {
		if (!placements[slot]) return;
		placements = {
			...placements,
			[slot]: { ...placements[slot], visible: !placements[slot].visible }
		};
	}

	function resetArrangement(): void {
		const validation = croppedValidation;
		if (!validation?.ok) return;
		placements = initialPlacements(validation.widthPx, validation.heightPx);
		syncPositionDraft(true);
		statusMessage = 'Arrangement reset to the 25% overlap layout.';
	}

	/**
	 * Alignment gesture arbitration (shared viewport claim): a pointer that begins
	 * inside the currently selected, visible, movable tile claims the gesture for
	 * tile movement — even when other tiles cover the point. Everything else is
	 * left to the viewport (background pan) or click selection.
	 */
	function claimAlignmentPointer(pointer: ScreenSpacePoint, event: PointerEvent): boolean {
		const slot = selectedSlot;
		const validation = croppedValidation;
		if (!slot || slot === 'upper-left' || !validation?.ok) return false;
		const placement = placements[slot];
		const tile = tiles[slot];
		if (!placement?.visible || !tile) return false;
		const rect = tileRect(placement, validation.widthPx, validation.heightPx);
		const image = alignmentVp.toImage(pointer);
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
		const screen = alignmentVp.pointerIn(event);
		if (
			!tileDrag.moved &&
			Math.hypot(screen.x - tileDrag.startScreen.x, screen.y - tileDrag.startScreen.y) >
				CLICK_SLOP_PX
		) {
			tileDrag.moved = true;
		}
		if (!tileDrag.moved) return;
		const dx = (screen.x - tileDrag.startScreen.x) / alignmentVp.view.zoom;
		const dy = (screen.y - tileDrag.startScreen.y) / alignmentVp.view.zoom;
		const node = tileNodes.get(tileDrag.slot);
		if (!node) return;
		const next = alignmentVp.toScreen({
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
		const screen = alignmentVp.pointerIn(event);
		const dx = (screen.x - drag.startScreen.x) / alignmentVp.view.zoom;
		const dy = (screen.y - drag.startScreen.y) / alignmentVp.view.zoom;
		// The drag delta applies to the tile's committed position; the grab point
		// inside the tile is only the anchor for the preview.
		const placement = placements[drag.slot];
		if (!placement) return;
		// Final placements are committed as integer cropped-image pixels.
		updatePlacement(
			drag.slot,
			placement.xPx + Math.round(dx),
			placement.yPx + Math.round(dy)
		);
	}

	/** pointercancel must never commit; the live node returns to its placement. */
	function handleTileDragCancel(): void {
		if (!tileDrag) return;
		endTileDrag();
		reconcileTileDrag();
	}

	/** Restores the live node from the authoritative placements after a no-commit end. */
	function reconcileTileDrag(): void {
		renderAlignmentScene();
	}

	function endTileDrag(): void {
		tileDrag = null;
		if (typeof window === 'undefined') return;
		window.removeEventListener('pointermove', handleTileDragMove);
		window.removeEventListener('pointerup', handleTileDragEnd);
		window.removeEventListener('pointercancel', handleTileDragCancel);
	}

	/**
	 * Click selection in the alignment view: selects a movable tile only when the
	 * point lies inside exactly one visible tile — the anchored upper-left tile
	 * participates in ambiguity even though it can never be selected. Hidden tiles
	 * are never selectable.
	 */
	function onAlignmentClick(pointer: ScreenSpacePoint): void {
		const validation = croppedValidation;
		if (!validation?.ok) return;
		const image = alignmentVp.toImage(pointer);
		const hits = TILE_SLOTS.filter((slot) => {
			const placement = placements[slot];
			if (!placement?.visible || !tiles[slot]) return false;
			return pointInTileRect(image, tileRect(placement, validation.widthPx, validation.heightPx));
		});
		if (hits.length === 1 && hits[0] !== 'upper-left') selectSlot(hits[0]);
	}

	/** Crop-handle claim: only Konva handle nodes claim; everything else pans. */
	function claimCropPointer(pointer: ScreenSpacePoint): boolean {
		const stage = cropStage;
		if (!stage) return false;
		const hit = stage.getIntersection(pointer);
		if (!hit) return false;
		return CROP_FIELDS.some((field) => cropHandles[field] === hit);
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

	function handleUseAs(role: ImageRole): void {
		if (!canExport) return;
		if (getPendingHandoff()) {
			statusMessage =
				'A stitched image is already awaiting import in Spot Round. Import or dismiss it before creating another handoff.';
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
			statusMessage = 'Stitched image handed to Spot Round.';
			await goto('/spot-round');
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
		for (const slot of TILE_SLOTS) {
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
			return 'All four screenshots, the shared crop, and tile overlap are valid. Export is ready.';
		}
		const reasons: string[] = [];
		if (report.missing.length > 0) {
			reasons.push(`Missing: ${report.missing.map((slot) => SLOT_LABELS[slot]).join(', ')}`);
		}
		if (report.dimensionMismatch.length > 0) reasons.push('Screenshots must share one size.');
		if (report.invalidCrop) reasons.push('The shared crop is invalid.');
		if (report.disconnected.length > 0) {
			reasons.push(
				'Every movable tile must connect to the upper-left tile through overlapping neighbors.'
			);
		}
		if (invalidCropFields.length > 0) reasons.push('The crop fields contain invalid values.');
		return `Not ready to export: ${reasons.join('; ')}.`;
	}

	function renderCropScene(): void {
		const stage = cropStage;
		const layer = cropLayer;
		if (!stage || !layer) return;
		layer.destroyChildren();
		cropRectNode = null;
		cropHandles = {};
		const tile = tiles['upper-left'];
		if (!tile) {
			layer.batchDraw();
			return;
		}
		const view = cropVp.view;
		const g = cropGeometry();
		if (!g) return;
		layer.add(
			new Konva.Image({
				image: tile.image,
				x: view.panX,
				y: view.panY,
				width: tile.widthPx * view.zoom,
				height: tile.heightPx * view.zoom,
				listening: false
			})
		);
		const validation = cropSize(crop, tile.widthPx, tile.heightPx);
		if (validation.ok && g.rectWidth > 0 && g.rectHeight > 0) {
			cropRectNode = new Konva.Rect({
				x: g.rectX,
				y: g.rectY,
				width: g.rectWidth,
				height: g.rectHeight,
				stroke: '#3b82f6',
				strokeWidth: 2,
				fill: 'rgba(59, 130, 246, 0.08)',
				listening: false
			});
			layer.add(cropRectNode);
			for (const field of CROP_FIELDS) {
				const anchor = cropHandleAnchor(field, g);
				const axis: 'x' | 'y' = field === 'leftPx' || field === 'rightPx' ? 'x' : 'y';
				const handle = cropHandle(field, anchor.x, anchor.y, axis, tile);
				cropHandles[field] = handle;
				layer.add(handle);
			}
		}
		layer.batchDraw();
	}

	function cropHandle(
		field: CropInsetField,
		anchorX: number,
		anchorY: number,
		axis: 'x' | 'y',
		tile: StitchTile
	): Konva.Rect {
		const size = CROP_HANDLE_SIZE;
		const handle = new Konva.Rect({
			x: anchorX - size / 2,
			y: anchorY - size / 2,
			width: size,
			height: size,
			fill: '#3b82f6',
			stroke: '#ffffff',
			strokeWidth: 1,
			draggable: true,
			dragBoundFunc:
				axis === 'x' ? (pos) => ({ x: pos.x, y: anchorY }) : (pos) => ({ x: anchorX, y: pos.y })
		});
		const valueFromDrag = (): number => {
			// Konva positions the rect by its top-left corner; the handle center
			// is the edge coordinate. Map the edge back to an inset in image
			// pixels: top/left measure from the image origin, bottom/right from
			// the opposite edge, so the handle's rest position exactly matches
			// the committed value and never jumps on the first drag move.
			const pixels = (axis === 'x' ? handle.x() : handle.y()) + size / 2;
			const offset = axis === 'x' ? cropVp.view.panX : cropVp.view.panY;
			const dimension = axis === 'x' ? tile.widthPx : tile.heightPx;
			const fromOrigin = (pixels - offset) / cropVp.view.zoom;
			const value =
				field === 'topPx' || field === 'leftPx'
					? Math.round(fromOrigin)
					: dimension - Math.round(fromOrigin);
			return Math.min(maxInset(field, tile), Math.max(0, value));
		};
		handle.on('dragstart', () => {
			cropDragActive = true;
		});
		handle.on('dragmove', () => {
			updateCropDrag(field, valueFromDrag());
			updateCropSceneGeometry();
		});
		handle.on('dragend', () => {
			cropDragActive = false;
			updateCropDrag(field, valueFromDrag());
			updateCropSceneGeometry();
			endCropDrag();
		});
		return handle;
	}

	function renderAlignmentScene(): void {
		const stage = alignmentStage;
		const layer = alignmentLayer;
		if (!stage || !layer) return;
		layer.destroyChildren();
		tileNodes.clear();
		const validation = croppedValidation;
		if (!validation?.ok) {
			layer.batchDraw();
			return;
		}
		const view = alignmentVp.view;
		for (const slot of TILE_SLOTS) {
			const tile = tiles[slot];
			const placement = placements[slot];
			if (!tile || !placement) continue;
			// One group per tile so the drag preview moves the image and its
			// selected highlight together without rebuilding the scene.
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
					crop: {
						x: crop.leftPx,
						y: crop.topPx,
						width: validation.widthPx,
						height: validation.heightPx
					},
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
			layer.add(group);
		}
		layer.batchDraw();
	}

	$effect(() => {
		const container = alignmentVp.container;
		if (!container || !canvas2dAvailable() || alignmentStage) return;
		alignmentStage = new Konva.Stage({
			container,
			width: alignmentVp.size.width,
			height: alignmentVp.size.height
		});
		alignmentLayer = new Konva.Layer();
		alignmentStage.add(alignmentLayer);
	});

	$effect(() => {
		const container = cropVp.container;
		if (!container || !canvas2dAvailable() || cropStage) return;
		cropStage = new Konva.Stage({
			container,
			width: cropVp.size.width,
			height: cropVp.size.height
		});
		cropLayer = new Konva.Layer();
		cropStage.add(cropLayer);
	});

	$effect(() => {
		alignmentStage?.size(alignmentVp.size);
		cropStage?.size(cropVp.size);
	});

	// The alignment fit follows the union of loaded cropped tile rectangles.
	$effect(() => {
		void tiles;
		void placements;
		void crop;
		untrack(() => alignmentVp.setFitTarget(alignmentFitTarget()));
	});

	// The crop view fits the complete original upper-left image.
	$effect(() => {
		void tiles;
		untrack(() => {
			const tile = tiles['upper-left'];
			cropVp.setFitTarget(
				tile ? { xPx: 0, yPx: 0, widthPx: tile.widthPx, heightPx: tile.heightPx } : null
			);
		});
	});

	// Rebuild the alignment scene when the session, crop, or view changes. Tile
	// drags update only the live Konva node, and committed placements land after
	// the gesture ends, so a rebuild never interrupts an active drag.
	$effect(() => {
		void tiles;
		void crop;
		void placements;
		void selectedSlot;
		void previewOpacity;
		void alignmentVp.view;
		void alignmentVp.size;
		untrack(() => {
			if (!tileDrag) renderAlignmentScene();
		});
	});

	// The crop preview rebuilds on tile, crop, or view changes. Crop values never
	// trigger a rebuild during a handle drag (cropDragActive), so the dragged
	// handle node is never destroyed mid-drag; handle drags re-render explicitly.
	$effect(() => {
		void tiles;
		void crop;
		void cropVp.view;
		void cropVp.size;
		untrack(() => {
			if (!cropDragActive) renderCropScene();
		});
	});

	$effect(() => {
		const complete = TILE_SLOTS.every((slot) => tiles[slot] !== undefined);
		const validation = croppedValidation;
		if (complete && !placementsInitialized && validation?.ok) {
			placements = initialPlacements(validation.widthPx, validation.heightPx);
			placementsInitialized = true;
			syncPositionDraft(true);
			alignmentVp.fit();
			statusMessage = 'All four screenshots loaded. Initial 25% overlap layout created.';
		}
	});

	onDestroy(() => {
		// An in-flight smart-import batch must never publish after unmount.
		decodeCoordinator.invalidate(SMART_IMPORT_BATCH);
		endTileDrag();
		alignmentStage?.destroy();
		alignmentStage = null;
		alignmentLayer = null;
		cropStage?.destroy();
		cropStage = null;
		cropLayer = null;
	});
</script>

<svelte:head>
	<title>Stitch Map | ChainSpot</title>
</svelte:head>

<main class="stitch-map" data-testid="stitch-map">
	<section
		class="stitch-status sr-only"
		aria-live="polite"
		aria-atomic="true"
		data-testid="stitch-status"
	>
		{#if statusMessage}
			<p role="status">{statusMessage}</p>
		{/if}
	</section>
	{#if exportError}
		<p class="error" data-testid="stitch-error" role="alert">{exportError}</p>
	{/if}

	<h2>Stitch Map</h2>
	<p class="protocol">
		Capture four screenshots of the same map at one zoom and orientation, then load them in
		this order: upper-left, upper-right, lower-left, lower-right, with about 20–30% overlap
		between neighbors. This session lives only in this tab; reloading the page clears it.
	</p>

	<section class="smart-import-section" aria-labelledby="smart-import-heading">
		<h3 id="smart-import-heading">Import four screenshots</h3>
		<p class="section-note">
			Select exactly four overlapping screenshots in any order. ChainSpot infers their
			upper-left, upper-right, lower-left, and lower-right roles, places them, and may
			suggest a shared crop. The existing controls remain available for correction.
		</p>
		<div class="smart-import-row">
			<label class="file-label">
				Import four screenshots
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
		{#if smartImportError}
			<p class="error" data-testid="smart-import-error" role="alert">{smartImportError}</p>
		{/if}
		{#if smartImportSummary}
			<ul class="smart-assignment" data-testid="smart-import-assignment" aria-label="Inferred screenshot order">
				{#each TILE_SLOTS as slot (slot)}
					<li>
						<span class="assignment-label">{SLOT_LABELS[slot]}:</span>
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
					{#each smartImportDiagnostic.warnings as warning (warning.kind)}
						<li data-testid={`smart-import-warning-${warning.kind}`}>{warning.message}</li>
					{/each}
				</ul>
			{/if}
		{/if}
		{#if cropProposal}
			<div class="crop-proposal" data-testid="crop-proposal" role="status">
				<p>
					Suggested shared crop:
					<span data-testid="crop-proposal-insets">
						top {cropProposal.topPx}px, right {cropProposal.rightPx}px, bottom
						{cropProposal.bottomPx}px, left {cropProposal.leftPx}px
					</span>
					. This is a proposal; it is not applied automatically.
				</p>
				{#if cropProposalConfidence}
					<p class="crop-confidence" data-testid="crop-confidence">
						Crop suggestion confidence: {CROP_CONFIDENCE_LABELS[cropProposalConfidence]}.
					</p>
				{/if}
				<div class="proposal-actions">
					<button type="button" data-testid="apply-suggested-crop" onclick={applyCropProposal}>
						Apply suggested crop
					</button>
					<button type="button" data-testid="keep-full-images" onclick={rejectCropProposal}>
						Keep full images
					</button>
				</div>
			</div>
		{/if}
	</section>

	<section class="tile-section" aria-labelledby="tiles-heading">
		<h3 id="tiles-heading">Screenshots</h3>
		<div class="tile-grid">
			{#each TILE_SLOTS as slot (slot)}
				<StitchTileSlot
					slot={slot}
					label={SLOT_LABELS[slot]}
					fileName={tiles[slot]?.fileName ?? null}
					dimensions={tiles[slot] ? `${tiles[slot].widthPx} x ${tiles[slot].heightPx}` : null}
					error={tileErrors[slot] ?? null}
					onFile={(file) => handleSlotFile(slot, file)}
					onRemove={() => handleRemove(slot)}
				/>
			{/each}
		</div>
	</section>

	<section class="crop-section" aria-labelledby="crop-heading">
		<h3 id="crop-heading">Shared crop</h3>
		<p class="section-note">
			One crop applies to all four screenshots. Adjust it on the upper-left preview or with
			the numeric fields. Scroll over the preview to zoom; drag its background to pan.
		</p>
		<div class="crop-layout">
			<div class="crop-preview">
				<ImageViewport controller={cropVp} testid="crop-viewport" claimPointer={claimCropPointer}>
					{#snippet content()}{/snippet}
				</ImageViewport>
			</div>
			<div class="crop-fields">
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
				<button type="button" data-testid="crop-reset" onclick={resetCrop}>
					Reset crop
				</button>
				<button type="button" data-testid="crop-fit" onclick={() => cropVp.fit()}>
					Fit
				</button>
			</div>
		</div>
	</section>

	<section class="alignment-section" aria-labelledby="alignment-heading">
		<h3 id="alignment-heading">Align tiles</h3>
		<p id="alignment-help" class="alignment-help">
			Select a movable tile, then use the arrow keys to adjust it. Hold Shift to move 10
			pixels. Click an exposed tile region to select it; drag the selected tile to move it.
			Drag the background to pan and scroll to zoom; Fit restores the full view.
		</p>
		<div class="alignment-controls">
			{#each MOVABLE_SLOTS as slot (slot)}
				<button
					type="button"
					class="tile-select"
					data-testid={`tile-select-${slot}`}
					aria-pressed={selectedSlot === slot}
					disabled={!tiles[slot]}
					onclick={() => selectSlot(slot)}
				>
					{SLOT_LABELS[slot]}
				</button>
			{/each}
			<button
				type="button"
				class="visibility-toggle"
				data-testid={`tile-visible-${selectedSlot ?? ''}`}
				disabled={!selectedSlot}
				onclick={() => selectedSlot && toggleTileVisible(selectedSlot)}
			>
				{selectedSlot && placements[selectedSlot]
					? placements[selectedSlot].visible
						? `Hide ${SLOT_LABELS[selectedSlot]} (preview)`
						: `Show ${SLOT_LABELS[selectedSlot]} (preview)`
					: 'Show/hide tile (preview)'}
			</button>
			<label class="position-field">
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
			<label class="position-field">
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
			<button type="button" data-testid="fit-preview" onclick={() => alignmentVp.fit()}>
				Fit preview
			</button>
			<button
				type="button"
				data-testid="reset-arrangement"
				disabled={!TILE_SLOTS.some((slot) => tiles[slot])}
				onclick={resetArrangement}
			>
				Reset arrangement
			</button>
		</div>
		<!-- The alignment workspace is a deliberate keyboard-operable region (P05-002):
			role="group", a real focus target for the scoped Arrow-key nudge handler,
			and help text via aria-describedby. -->
		<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
		<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
		<div
			class="alignment-workspace"
			data-testid="alignment-workspace"
			bind:this={alignmentWorkspace}
			tabindex="0"
			role="group"
			aria-label="Stitch alignment workspace"
			aria-describedby="alignment-help"
			data-stitch-nudge-scope
			onkeydown={handleAlignmentKeyDown}
		>
			<ImageViewport
				controller={alignmentVp}
				testid="alignment-viewport"
				claimPointer={claimAlignmentPointer}
				onViewportClick={onAlignmentClick}
			>
				{#snippet content()}{/snippet}
			</ImageViewport>
		</div>
		<p class="preview-note">
			Preview-only: hiding a tile, changing opacity, zooming, or panning never changes the
			exported PNG.
		</p>
		<p data-testid="stitch-readiness" role="status">{readinessText()}</p>
	</section>

	<section class="export-section" aria-labelledby="export-heading">
		<h3 id="export-heading">Export</h3>
		<div class="export-actions">
			<button
				type="button"
				data-testid="download-stitched"
				disabled={!canExport}
				onclick={handleDownload}
			>
				Download stitched PNG
			</button>
			<button
				type="button"
				data-testid="use-as-source"
				disabled={!canExport}
				onclick={() => handleUseAs('source-overview')}
			>
				Use as UDisc source
			</button>
			<button
				type="button"
				data-testid="use-as-target"
				disabled={!canExport}
				onclick={() => handleUseAs('target-basemap')}
			>
				Use as clean target
			</button>
			{#if rendering}
				<span class="status" role="status">Rendering…</span>
			{/if}
		</div>
	</section>

	{#if pendingReplaceConfirm}
		<div class="dialog-backdrop">
			<div
				class="dialog"
				role="dialog"
				aria-modal="true"
				aria-label="Replace current arrangement?"
				data-testid="replace-arrangement-confirmation"
				use:dialogKeyboard={() => settleReplaceConfirm(false)}
			>
				<h2>Replace current arrangement?</h2>
				<p>
					The current tile placements differ from the last automatic result. Running automatic
					arrangement again will replace them. Cancel keeps the current crop, placements,
					selection, visibility, opacity, and export state.
				</p>
				<div class="dialog-actions">
					<button
						type="button"
						data-testid="replace-confirm-cancel"
						bind:this={replaceCancelButton}
						onclick={() => settleReplaceConfirm(false)}
					>
						Cancel
					</button>
					<button
						type="button"
						data-testid="replace-confirm-accept"
						onclick={() => settleReplaceConfirm(true)}
					>
						Replace current arrangement
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

	.protocol,
	.section-note,
	.alignment-help,
	.preview-note {
		margin: 0;
		font-size: 0.9rem;
		color: #a1a1aa;
		line-height: 1.5;
		max-width: 60rem;
	}

	.smart-import-section {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.smart-import-row {
		display: flex;
		align-items: center;
		gap: 0.6rem;
	}

	.file-label {
		display: inline-flex;
		align-items: center;
		padding: 0.4rem 0.8rem;
		border: 1px solid #3f3f46;
		border-radius: 4px;
		background-color: #27272a;
		color: #e4e4e7;
		font-size: 0.85rem;
		cursor: pointer;
	}

	.file-label:has(input:focus-visible) {
		outline: 3px solid #075985;
		outline-offset: 2px;
	}

	.file-input {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip: rect(0 0 0 0);
	}

	.file-label:has(input:disabled) {
		cursor: not-allowed;
		opacity: 0.5;
	}

	.smart-assignment {
		margin: 0;
		padding: 0;
		list-style: none;
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		font-size: 0.85rem;
		color: #a1a1aa;
	}

	.smart-confidence {
		margin: 0;
		font-size: 0.85rem;
		color: #f4f4f5;
	}

	.smart-warnings {
		margin: 0;
		padding: 0 0 0 1rem;
		font-size: 0.85rem;
		color: #a1a1aa;
	}

	.crop-confidence {
		margin: 0;
		font-size: 0.8rem;
		color: #a1a1aa;
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

	.dialog-actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.6rem;
	}

	.assignment-label {
		color: #f4f4f5;
	}

	.crop-proposal {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		padding: 0.6rem 0.8rem;
		border: 1px solid #3b82f6;
		border-radius: 6px;
		background-color: #16233b;
	}

	.crop-proposal p {
		margin: 0;
		font-size: 0.85rem;
		color: #dbeafe;
	}

	.proposal-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.6rem;
	}

	.tile-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
		gap: 0.75rem;
	}

	.crop-layout {
		display: flex;
		gap: 1rem;
		flex-wrap: wrap;
		align-items: flex-start;
	}

	.crop-preview {
		flex: 1 1 320px;
		min-width: 280px;
		height: 280px;
		background-color: #1e1e24;
		border: 1px solid #27272a;
		border-radius: 8px;
		overflow: hidden;
	}

	.crop-fields {
		display: flex;
		flex-wrap: wrap;
		gap: 0.6rem;
		align-items: end;
		flex: 0 0 200px;
	}

	.crop-field {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		font-size: 0.8rem;
		color: #a1a1aa;
	}

	.crop-field input {
		width: 5rem;
		padding: 0.3rem 0.5rem;
		background-color: #1e1e24;
		border: 1px solid #3f3f46;
		border-radius: 4px;
		color: #e4e4e7;
	}

	.crop-field input[aria-invalid='true'] {
		border-color: #f87171;
	}

	.alignment-controls {
		display: flex;
		flex-wrap: wrap;
		gap: 0.6rem;
		align-items: end;
		margin-bottom: 0.75rem;
	}

	.tile-select {
		padding: 0.4rem 0.8rem;
		border: 1px solid #3f3f46;
		border-radius: 4px;
		background-color: #27272a;
		color: #e4e4e7;
		font-size: 0.85rem;
		cursor: pointer;
	}

	.tile-select[aria-pressed='true'] {
		border-color: #facc15;
		color: #ffffff;
	}

	.position-field,
	.opacity-field {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		font-size: 0.8rem;
		color: #a1a1aa;
	}

	.position-field input {
		width: 5.5rem;
		padding: 0.3rem 0.5rem;
		background-color: #1e1e24;
		border: 1px solid #3f3f46;
		border-radius: 4px;
		color: #e4e4e7;
	}

	.alignment-workspace {
		height: 440px;
		background-color: #1e1e24;
		border: 1px solid #27272a;
		border-radius: 8px;
	}

	.alignment-workspace:focus-visible {
		outline: 3px solid #075985;
		outline-offset: 2px;
	}

	.export-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.6rem;
		align-items: center;
	}

	button {
		padding: 0.4rem 0.8rem;
		border: 1px solid #3f3f46;
		border-radius: 4px;
		background-color: #27272a;
		color: #e4e4e7;
		font-size: 0.85rem;
		cursor: pointer;
	}

	button:focus-visible,
	input:focus-visible,
	input[type='range']:focus-visible {
		outline: 3px solid #075985;
		outline-offset: 2px;
	}

	button:disabled,
	input:disabled {
		cursor: not-allowed;
		opacity: 0.5;
	}

	.status {
		font-size: 0.85rem;
		color: #a1a1aa;
	}

	.error {
		margin: 0;
		padding: 0.4rem 0.6rem;
		border-radius: 4px;
		background: #3f1d1d;
		border: 1px solid #7f1d1d;
		color: #fca5a5;
		font-size: 0.85rem;
	}

	.stitch-status {
		min-height: 0;
	}

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
</style>
