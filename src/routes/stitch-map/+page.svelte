<script lang="ts">
	import { goto } from '$app/navigation';
	import Konva from 'konva';
	import { onDestroy, onMount, untrack } from 'svelte';
	import StitchTileSlot from '$lib/components/StitchTileSlot.svelte';
	import { decodeImageFile, isSupportedMimeType } from '$lib/imageIntake';
	import { isEditableTarget } from '$lib/pointSelection';
	import { wheelZoomFactor, zoomAtPointer } from '$lib/navigation';
	import { canvas2dAvailable } from '$lib/scene';
	import {
		TILE_SLOTS,
		ZERO_CROP,
		cropSize,
		expectedNeighbors,
		initialPlacements,
		overlapArea,
		readiness,
		sessionDimensions,
		tileRect,
		translatedOrigin,
		unionBounds
	} from '$lib/stitch/geometry';
	import type { CropInsetField, CropInsets, TilePlacement, TileSlot } from '$lib/stitch/geometry';
	import { renderStitchedPng, stitchedFileName } from '$lib/stitch/render';
	import { getPendingHandoff, setPendingHandoff } from '$lib/stitch/handoff';
	import type { ImageRole } from '$lib/domain/project';

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

	/** Session tiles: transient browser resources only, never durable project state. */
	let tiles = $state<Partial<Record<TileSlot, StitchTile>>>({});
	let tileErrors = $state<Partial<Record<TileSlot, string>>>({});

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

	let fitScale = $state(1);
	let renderOffset = $state({ x: 0, y: 0 });
	let alignmentScope = $state<HTMLDivElement | null>(null);
	let cropScope = $state<HTMLDivElement | null>(null);
	let alignmentStageSize = $state({ width: 1, height: 1 });
	let cropStageSize = $state({ width: 1, height: 1 });
	let alignmentStage = $state<Konva.Stage | null>(null);
	let cropStage = $state<Konva.Stage | null>(null);
	let alignmentLayer = $state<Konva.Layer | null>(null);
	let cropLayer = $state<Konva.Layer | null>(null);
	let resizeObserver: ResizeObserver | null = null;
	/** User-adjustable crop-preview view (wheel zoom); fit is the default. */
	let cropViewScale = $state(1);
	let cropViewOffset = $state({ x: 0, y: 0 });
	/** Live nodes of the crop scene so drags can move them without rebuilding. */
	let cropRectNode = $state<Konva.Rect | null>(null);
	let cropHandles = $state<Partial<Record<CropInsetField, Konva.Rect>>>({});

	let statusMessage = $state<string | null>(null);
	let exportError = $state<string | null>(null);
	let rendering = $state(false);

	const required = $derived(sessionDimensions(tiles));
	const croppedValidation = $derived(
		required ? cropSize(crop, required.widthPx, required.heightPx) : null
	);
	const report = $derived(readiness(tiles, crop, placements, required));
	const invalidCropFields = $derived(computeInvalidCropFields());
	const canExport = $derived(
		report.ready && !rendering && invalidCropFields.length === 0
	);

	/** Centers the upper-left tile at the largest scale that fits the preview. */
	function fitCropPreview(): void {
		const tile = tiles['upper-left'];
		if (!tile) return;
		const pad = 12;
		const availableWidth = Math.max(cropStageSize.width - pad * 2, 1);
		const availableHeight = Math.max(cropStageSize.height - pad * 2, 1);
		const scale = Math.max(
			0.05,
			Math.min(4, Math.min(availableWidth / tile.widthPx, availableHeight / tile.heightPx))
		);
		cropViewScale = scale;
		cropViewOffset = {
			x: (cropStageSize.width - tile.widthPx * scale) / 2,
			y: (cropStageSize.height - tile.heightPx * scale) / 2
		};
	}

	function cropGeometry():
		| {
				scale: number;
				rectX: number;
				rectY: number;
				rectWidth: number;
				rectHeight: number;
		  }
		| null {
		const tile = tiles['upper-left'];
		if (!tile) return null;
		const scale = cropViewScale;
		const rectX = cropViewOffset.x + crop.leftPx * scale;
		const rectY = cropViewOffset.y + crop.topPx * scale;
		const rectWidth = Math.max(0, (tile.widthPx - crop.leftPx - crop.rightPx) * scale);
		const rectHeight = Math.max(0, (tile.heightPx - crop.topPx - crop.bottomPx) * scale);
		return { scale, rectX, rectY, rectWidth, rectHeight };
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
		exportError = null;
		if (!isSupportedMimeType(file.type)) {
			tileErrors = {
				...tileErrors,
				[slot]: `Unsupported file type "${file.type || 'unknown'}": ChainSpot accepts PNG and JPEG images.`
			};
			return;
		}
		let decoded: { image: HTMLImageElement; widthPx: number; heightPx: number };
		try {
			decoded = await decodeImageFile(file);
		} catch {
			tileErrors = { ...tileErrors, [slot]: `Could not decode "${file.name}".` };
			return;
		}
		const { image, widthPx, heightPx } = decoded;
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
		fitPreview();
		fitCropPreview();
	}

	function handleRemove(slot: TileSlot): void {
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
		fitPreview();
		fitCropPreview();
	}

	function resetSession(): void {
		crop = { ...ZERO_CROP };
		syncCropDraft(true);
		placements = initialPlacements(1, 1);
		placementsInitialized = false;
		selectedSlot = null;
		positionDraft = { xPx: '', yPx: '' };
		previewOpacity = 0.6;
		exportError = null;
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
		fitPreview();
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
		if (slot) alignmentScope?.focus();
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

	function fitPreview(): void {
		const validation = croppedValidation;
		if (!validation?.ok) return;
		const rects = TILE_SLOTS.filter((slot) => tiles[slot]).map((slot) =>
			tileRect(placements[slot], validation.widthPx, validation.heightPx)
		);
		const union = unionBounds(rects);
		if (!union) return;
		const pad = 16;
		const availableWidth = Math.max(alignmentStageSize.width - pad * 2, 1);
		const availableHeight = Math.max(alignmentStageSize.height - pad * 2, 1);
		const scale = Math.max(
			0.01,
			Math.min(8, Math.min(availableWidth / union.widthPx, availableHeight / union.heightPx))
		);
		fitScale = scale;
		renderOffset = {
			x: (alignmentStageSize.width - union.widthPx * scale) / 2 - union.xPx * scale,
			y: (alignmentStageSize.height - union.heightPx * scale) / 2 - union.yPx * scale
		};
	}

	function resetArrangement(): void {
		const validation = croppedValidation;
		if (!validation?.ok) return;
		placements = initialPlacements(validation.widthPx, validation.heightPx);
		syncPositionDraft(true);
		statusMessage = 'Arrangement reset to the 25% overlap layout.';
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
		if (report.noOverlap.length > 0) {
			reasons.push('Every movable tile must overlap a neighbor.');
		}
		if (invalidCropFields.length > 0) reasons.push('The crop fields contain invalid values.');
		return `Not ready to export: ${reasons.join('; ')}.`;
	}

	function measureStages(): void {
		if (alignmentScope) {
			alignmentStageSize = {
				width: alignmentScope.clientWidth || 1,
				height: alignmentScope.clientHeight || 1
			};
			alignmentStage?.size(alignmentStageSize);
		}
		if (cropScope) {
			cropStageSize = {
				width: cropScope.clientWidth || 1,
				height: cropScope.clientHeight || 1
			};
			cropStage?.size(cropStageSize);
		}
		fitPreview();
		fitCropPreview();
	}

	/**
	 * ImagePane-style pointer-centered wheel zoom for the alignment preview. The
	 * listener is attached non-passively so the page never scrolls while zooming.
	 */
	function handleAlignmentWheel(event: WheelEvent): void {
		if (!TILE_SLOTS.some((slot) => tiles[slot])) return;
		if (!Number.isFinite(event.deltaY) || event.deltaY === 0) return;
		event.preventDefault();
		const rect = alignmentScope?.getBoundingClientRect();
		if (!rect) return;
		const next = zoomAtPointer(
			{ zoom: fitScale, panX: renderOffset.x, panY: renderOffset.y },
			{ x: event.clientX - rect.left, y: event.clientY - rect.top },
			wheelZoomFactor(event.deltaY)
		);
		fitScale = next.zoom;
		renderOffset = { x: next.panX, y: next.panY };
	}

	/** Pointer-centered wheel zoom for the crop preview. */
	function handleCropWheel(event: WheelEvent): void {
		const tile = tiles['upper-left'];
		if (!tile) return;
		if (!Number.isFinite(event.deltaY) || event.deltaY === 0) return;
		event.preventDefault();
		const rect = cropScope?.getBoundingClientRect();
		if (!rect) return;
		const pointer = { x: event.clientX - rect.left, y: event.clientY - rect.top };
		const nextScale = Math.max(
			0.05,
			Math.min(16, cropViewScale * wheelZoomFactor(event.deltaY))
		);
		const px = (pointer.x - cropViewOffset.x) / cropViewScale;
		const py = (pointer.y - cropViewOffset.y) / cropViewScale;
		cropViewScale = nextScale;
		cropViewOffset = { x: pointer.x - px * nextScale, y: pointer.y - py * nextScale };
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
		const g = cropGeometry();
		if (!g) return;
		layer.add(
			new Konva.Image({
				image: tile.image,
				x: cropViewOffset.x,
				y: cropViewOffset.y,
				width: tile.widthPx * g.scale,
				height: tile.heightPx * g.scale,
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
			const offset = axis === 'x' ? cropViewOffset.x : cropViewOffset.y;
			const dimension = axis === 'x' ? tile.widthPx : tile.heightPx;
			const fromOrigin = (pixels - offset) / cropViewScale;
			const value =
				field === 'topPx' || field === 'leftPx'
					? Math.round(fromOrigin)
					: dimension - Math.round(fromOrigin);
			return Math.min(maxInset(field, tile), Math.max(0, value));
		};
		handle.on('dragmove', () => {
			updateCropDrag(field, valueFromDrag());
			updateCropSceneGeometry();
		});
		handle.on('dragend', () => {
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
		const validation = croppedValidation;
		if (!validation?.ok) {
			layer.batchDraw();
			return;
		}
		const scale = fitScale;
		const ox = renderOffset.x;
		const oy = renderOffset.y;
		for (const slot of TILE_SLOTS) {
			const tile = tiles[slot];
			const placement = placements[slot];
			if (!tile || !placement) continue;
			const node = new Konva.Image({
				image: tile.image,
				x: placement.xPx * scale + ox,
				y: placement.yPx * scale + oy,
				width: validation.widthPx * scale,
				height: validation.heightPx * scale,
				crop: {
					x: crop.leftPx,
					y: crop.topPx,
					width: validation.widthPx,
					height: validation.heightPx
				},
				opacity: slot === selectedSlot ? previewOpacity : 1,
				visible: placement.visible,
				draggable: slot !== 'upper-left',
				listening: slot !== 'upper-left'
			});
			if (slot !== 'upper-left') {
				node.on('dragstart', () => {
					if (selectedSlot !== slot) selectSlot(slot);
					else alignmentScope?.focus();
				});
				node.on('dragend', () => {
					const xPx = Math.round((node.x() - ox) / scale);
					const yPx = Math.round((node.y() - oy) / scale);
					updatePlacement(slot, xPx, yPx);
				});
			}
			layer.add(node);
		}
		const selected = selectedSlot;
		if (selected && selected !== 'upper-left' && tiles[selected] && placements[selected]) {
			const placement = placements[selected];
			layer.add(
				new Konva.Rect({
					x: placement.xPx * scale + ox,
					y: placement.yPx * scale + oy,
					width: validation.widthPx * scale,
					height: validation.heightPx * scale,
					stroke: '#facc15',
					strokeWidth: 2,
					listening: false
				})
			);
		}
		layer.batchDraw();
	}

	$effect(() => {
		if (!alignmentScope) return;
		if (canvas2dAvailable() && !alignmentStage) {
			alignmentStage = new Konva.Stage({
				container: alignmentScope,
				width: alignmentStageSize.width,
				height: alignmentStageSize.height
			});
			alignmentLayer = new Konva.Layer();
			alignmentStage.add(alignmentLayer);
		}
	});

	$effect(() => {
		if (!cropScope) return;
		if (canvas2dAvailable() && !cropStage) {
			cropStage = new Konva.Stage({
				container: cropScope,
				width: cropStageSize.width,
				height: cropStageSize.height
			});
			cropLayer = new Konva.Layer();
			cropStage.add(cropLayer);
		}
	});

	// Rebuild the alignment scene whenever the session, crop, or view changes.
	// Placement updates always land outside an in-flight Konva drag, so a rebuild
	// here never destroys a node mid-drag.
	$effect(() => {
		void tiles;
		void crop;
		void placements;
		void selectedSlot;
		void previewOpacity;
		void fitScale;
		void renderOffset;
		void alignmentStageSize;
		untrack(() => renderAlignmentScene());
	});

	// The crop preview rebuilds on tile, stage-size, or view-zoom changes. Crop
	// values never trigger a rebuild here: numeric commits and handle-drag ends
	// render explicitly so a dragged handle node is never destroyed mid-drag.
	$effect(() => {
		void tiles;
		void cropStageSize;
		void cropViewScale;
		void cropViewOffset;
		untrack(() => renderCropScene());
	});

	// Re-fit the alignment view only when the tile set or stage size changes;
	// crop edits and placement tweaks preserve the user's current zoom.
	$effect(() => {
		void tiles;
		void alignmentStageSize;
		untrack(() => fitPreview());
	});

	// Re-center the crop preview when the tile or stage size changes.
	$effect(() => {
		void tiles;
		void cropStageSize;
		untrack(() => fitCropPreview());
	});

	$effect(() => {
		const complete = TILE_SLOTS.every((slot) => tiles[slot] !== undefined);
		const validation = croppedValidation;
		if (complete && !placementsInitialized && validation?.ok) {
			placements = initialPlacements(validation.widthPx, validation.heightPx);
			placementsInitialized = true;
			syncPositionDraft(true);
			fitPreview();
			statusMessage = 'All four screenshots loaded. Initial 25% overlap layout created.';
		}
	});

	onMount(() => {
		syncCropDraft(true);
		if (typeof ResizeObserver !== 'undefined') {
			resizeObserver = new ResizeObserver(() => measureStages());
			if (alignmentScope) resizeObserver.observe(alignmentScope);
			if (cropScope) resizeObserver.observe(cropScope);
		}
		// Non-passive wheel listeners so the page never scrolls while zooming.
		alignmentScope?.addEventListener('wheel', handleAlignmentWheel, { passive: false });
		cropScope?.addEventListener('wheel', handleCropWheel, { passive: false });
		measureStages();
	});

	onDestroy(() => {
		resizeObserver?.disconnect();
		resizeObserver = null;
		alignmentScope?.removeEventListener('wheel', handleAlignmentWheel);
		cropScope?.removeEventListener('wheel', handleCropWheel);
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
			the numeric fields. Scroll over the preview to zoom in and out.
		</p>
		<div class="crop-layout">
			<div
				class="crop-preview"
				data-testid="crop-preview"
				bind:this={cropScope}
				aria-label="Crop preview on the upper-left screenshot"
				data-crop-scale={cropViewScale}
				data-crop-offset-x={cropViewOffset.x}
				data-crop-offset-y={cropViewOffset.y}
			></div>
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
			</div>
		</div>
	</section>

	<section class="alignment-section" aria-labelledby="alignment-heading">
		<h3 id="alignment-heading">Align tiles</h3>
		<p id="alignment-help" class="alignment-help">
			Select a movable tile, then use the arrow keys to adjust it. Hold Shift to move 10
			pixels. Scroll over the preview to zoom in and out; Fit restores the full view.
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
			<button type="button" data-testid="fit-preview" onclick={fitPreview}>
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
			class="alignment-scope"
			data-testid="alignment-workspace"
			bind:this={alignmentScope}
			tabindex="0"
			role="group"
			aria-label="Stitch alignment workspace"
			aria-describedby="alignment-help"
			data-stitch-nudge-scope
			data-stitch-scale={fitScale}
			data-stitch-offset-x={renderOffset.x}
			data-stitch-offset-y={renderOffset.y}
			onkeydown={handleAlignmentKeyDown}
		></div>
		<p class="preview-note">
			Preview-only: hiding a tile or changing opacity never changes the exported PNG.
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

	.alignment-scope {
		height: 440px;
		background-color: #1e1e24;
		border: 1px solid #27272a;
		border-radius: 8px;
	}

	.alignment-scope:focus-visible {
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
