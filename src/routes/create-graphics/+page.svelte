<script lang="ts">
	import { onDestroy, onMount, tick } from 'svelte';
	import ImagePane from '$lib/components/ImagePane.svelte';
	import { ProjectEditor } from '$lib/domain/editor';
	import type { AssetResource } from '$lib/domain/editor';
	import { findImageByRole } from '$lib/domain/project';
	import type { ImageAsset, ImageRole, ControlPointPair, ProjectState } from '$lib/domain/project';
	import type { DecodeImageFile, HashBytes } from '$lib/imageIntake';
	import { decodeImageFile, intakeImageFile } from '$lib/imageIntake';
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
	import {
		consumePendingHandoff,
		getPendingHandoff,
		retainEditor,
		takeRetainedEditor,
		consumePendingAnnotatedRound,
		getActiveAnnotatedRound,
		getPendingAnnotatedRound,
		setActiveAnnotatedRound,
		consumePendingCourseBadges,
		getPendingCourseBadges
	} from '$lib/session';
	import type { PendingHandoff } from '$lib/session';
	import { importHandoffImage } from '$lib/handoffImport';
	import {
		bboxFromCenter,
		fetchNaipBoundingBoxImage,
		fetchNaipImage,
		naipMetersPerPixel,
		NAIP_EXPORT_SIZE_PX
	} from '$lib/naip';
	import type { GeoBoundingBox, GeoPoint } from '$lib/naip';
	import { metersToFeet } from '$lib/units';
	import { searchPlace } from '$lib/geocode';
	import type { GeoSearchMatch, GeocodeSearchResult } from '$lib/geocode';
	import { parseCoordinateInput, searchPlacesText } from '$lib/placesSearch';
	import { googleMapsApiKey } from '$lib/googleMapsConfig';
	import MapConfirm from '$lib/components/MapConfirm.svelte';
	import { geoBoxCenterAndSize, pixelRectToGeoBox, planTileGrid } from '$lib/naipGrid';
	import type { PixelRect } from '$lib/naipGrid';
	import { composeMosaic, fetchTileGrid } from '$lib/naipMosaic';
	import { estimateAffine } from '$lib/alignment/affine';
	import { estimateSimilarity } from '$lib/alignment/similarity';
	import { validateTransform } from '$lib/alignment/validation';
	import { AlignmentFailureReason } from '$lib/alignment/types';
	import type { AlignmentModel, AlignmentPairInput, EstimationResultOrFailure } from '$lib/alignment/types';
	import {
		attachCourseLocation,
		badgesToLabeledPoints,
		basketsFromHoles,
		findMatchingLibraryEntry,
		getDefaultCourseLibraryStore,
		toLibraryHoles,
		upsertCourse
	} from '$lib/courseLibrary';
	import type { CourseLibraryStore } from '$lib/courseLibrary';
	import type { AnnotatedHole, AnnotatedRound, SourcePoint } from '$lib/domain/annotatedRound';
	import { buildHoleGraphicMarkup } from '$lib/holeGraphics';
	import { GRAPHIC_STYLE_PRESETS } from '$lib/graphics/style';
	import { GraphicsMode } from '$lib/graphics/graphicsMode.svelte';
	import { naipImageGeoReference } from '$lib/elevationProfile';
	import type { GeoRasterReference } from '$lib/elevationProfile';

	interface Props {
		editor?: ProjectEditor;
		decode?: DecodeImageFile;
		hash?: HashBytes;
		download?: DownloadBlob;
		courseLibraryStore?: CourseLibraryStore;
	}

	let { editor: initialEditor, decode, hash, download, courseLibraryStore: initialCourseLibraryStore }: Props =
		$props();
	// An explicitly injected store (tests) wins; otherwise every page instance
	// shares one real IndexedDB connection via the module-level singleton in
	// courseLibrary.ts.
	// svelte-ignore state_referenced_locally
	const courseLibraryStore = initialCourseLibraryStore ?? getDefaultCourseLibraryStore();
	/**
	 * Only production-created or session-retrieved editors participate in route
	 * retention; explicitly injected editors (tests/harnesses) never touch the
	 * module-level application session. Deliberately captured once at mount: the
	 * injection decision never changes for a given page instance.
	 */
	// svelte-ignore state_referenced_locally
	const participatesInSession = initialEditor === undefined;
	let editor = $state.raw(resolveInitialEditor());

	function resolveInitialEditor(): ProjectEditor {
		// An explicitly injected editor (tests) wins; otherwise reuse the retained
		// in-memory session across SPA navigation, or start a fresh project.
		return initialEditor ?? takeRetainedEditor('create-graphics') ?? new ProjectEditor();
	}

	onDestroy(() => {
		if (participatesInSession) retainEditor('create-graphics', editor);
		clearNaipPreview();
		handleBoxHandleUp();
	});

	let refreshCount = $state(0);
	let correspondence = $state(createCorrespondenceState());
	let correspondenceError = $state<string | null>(null);
	/** Pure, derived, non-mutating pair counts, readiness, and diagnostics copy. */
	let diagnosticsView = $derived(
		diagnosticsCopy(
			deriveDiagnostics(currentPairs(), editor.state.images, correspondence.pendingPlacement !== null)
		)
	);

	/**
	 * Phase 1 alignment: `src/lib/alignment` estimates a source-to-target
	 * transform from the correspondence pairs above. Pure, derived, and
	 * recomputed automatically as pairs are added/edited — nothing here mutates
	 * domain state, matching diagnosticsView's own pattern.
	 */
	let alignmentModel = $state<AlignmentModel>('similarity');

	function alignmentPairs(): AlignmentPairInput[] {
		return currentPairs().map((pair) => ({
			id: pair.id,
			enabled: pair.enabled,
			source: pair.source,
			target: pair.target
		}));
	}

	/** Null before any enabled, complete pair exists — nothing to estimate yet. */
	let alignmentResult: EstimationResultOrFailure | null = $derived.by(() => {
		const pairs = alignmentPairs();
		if (!pairs.some((pair) => pair.enabled && pair.target !== null)) return null;
		return alignmentModel === 'affine' ? estimateAffine({ pairs }) : estimateSimilarity({ pairs });
	});

	let alignmentWarnings = $derived.by(() => {
		if (!alignmentResult || !('transform' in alignmentResult)) return [];
		return validateTransform({ transform: alignmentResult.transform, pairs: alignmentPairs() });
	});

	const ALIGNMENT_FAILURE_MESSAGES: Record<AlignmentFailureReason, string> = {
		[AlignmentFailureReason.INSUFFICIENT_PAIRS]: 'Not enough enabled, complete pairs yet.',
		[AlignmentFailureReason.ZERO_SPREAD]: 'The enabled pairs are all at the same point — spread them out.',
		[AlignmentFailureReason.COLLINEAR_GEOMETRY]:
			'The enabled pairs are collinear — affine needs a non-collinear spread (try similarity, or add a pair off that line).',
		[AlignmentFailureReason.NON_INVERTIBLE]: 'The estimated transform is not invertible.',
		[AlignmentFailureReason.NON_FINITE_COORDINATES]: 'Some pair coordinates are not finite numbers.',
		[AlignmentFailureReason.REFLECTION_REQUIRED]:
			'This pair geometry requires a reflection, which similarity does not model — try affine.',
		[AlignmentFailureReason.NUMERICAL_SOLVE_FAILURE]: 'The numerical solve failed. Try adjusting the pairs.'
	};

	/**
	 * Clean hole construction: applies the estimated transform above to every
	 * annotated hole's source-space points, producing target-space plans ready to
	 * render. Purely derived, so the SVG preview below is always live — it
	 * updates as annotations or the alignment change, with no separate "build"
	 * step. Rendering to a downloadable PNG (or a batch zip) is the only thing
	 * that stays an explicit action, since that's genuinely expensive work
	 * (canvas rasterization per hole), not just pointer input.
	 *
	 * Reads holes from durable project state, NOT from the `annotatedRound`
	 * session artifact: a project reopened from a saved bundle has holes but no
	 * session artifact at all, and reading the artifact would leave those holes
	 * unbuildable.
	 */
	function currentHoles(): readonly AnnotatedHole[] {
		void refreshCount;
		return editor.state.holes;
	}

	/**
	 * The walking path, same "durable project state, not the session artifact"
	 * rule as `currentHoles` — a project reopened from a saved bundle has a
	 * walking path but no session artifact at all.
	 */
	function currentWalkingPath(): readonly SourcePoint[] | undefined {
		void refreshCount;
		return editor.state.walkingPath;
	}

	/** The clean target image's own blob URL, reused directly as the SVG `<image href>` — no re-encoding. */
	function targetImageHref(): string | null {
		const target = targetImage();
		if (!target) return null;
		const decoded = editor.getAssetResource(target.id)?.decoded;
		return decoded instanceof HTMLImageElement ? decoded.src : null;
	}

	/** Feet-per-pixel for the current target image, only when it has a known (never estimated) ground scale. */
	function holeGraphicFeetPerPixel(): number | undefined {
		return targetGroundScaleMetersPerPixel === null
			? undefined
			: metersToFeet(targetGroundScaleMetersPerPixel);
	}

	/**
	 * WGS84 georeference for the current target image, built fresh from the retained
	 * center/radius -- null under the same condition `holeGraphicFeetPerPixel` returns
	 * `undefined`, since both derive from the same NAIP-fetch-only retained geometry.
	 */
	function targetGeoReference(): GeoRasterReference | null {
		if (targetGeoCenter === null || targetGeoRadiusMeters === null) return null;
		return naipImageGeoReference(targetGeoCenter, targetGeoRadiusMeters);
	}

	/**
	 * The graphics/export mode (style selection, per-hole plans, PNG/zip
	 * export state) lives behind this module boundary — see
	 * `graphicsMode.svelte.ts` for why. It reads alignment/annotation/NAIP
	 * state through these getters only; it never reaches into the route
	 * directly.
	 */
	const graphicsMode = new GraphicsMode({
		holes: () => currentHoles(),
		transform: () => (alignmentResult && 'transform' in alignmentResult ? alignmentResult.transform : null),
		targetSize: () => targetImage(),
		targetImageHref,
		feetPerPixel: holeGraphicFeetPerPixel,
		walkingPath: () => currentWalkingPath(),
		geoReference: () => targetGeoReference()
	});

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
	/** A stitched PNG awaiting explicit import from the Stitch Map page. */
	let pendingHandoff = $state<PendingHandoff | null>(null);
	let importingHandoff = $state(false);
	let handoffError = $state<string | null>(null);

	/**
	 * The AnnotatedRound artifact received from Annotate Round, once imported —
	 * either auto-intaked on mount (no source image loaded yet) or through the
	 * banner below (a source image is already loaded). Soft boundary: this page
	 * still accepts a direct image upload with no AnnotatedRound present at all;
	 * a hard gate is out of scope for this ticket.
	 */
	let annotatedRound = $state<AnnotatedRound | null>(null);
	/** A pending AnnotatedRound awaiting explicit import because a source image is already loaded. */
	let pendingAnnotatedRoundBanner = $state<AnnotatedRound | null>(null);
	let importingAnnotatedRound = $state(false);
	let annotatedRoundError = $state<string | null>(null);

	/**
	 * Default *preview/reference* radius for the USGS NAIP aerial pull: 900m — three
	 * times the fixed per-tile radius below — gives enough framing margin around a
	 * course for the coverage-box picker to be drawn and resized inside it. This is
	 * deliberately wider than a single hole; it is a reference frame, not itself the
	 * final clean target (though "Use this preview as-is" still commits it directly
	 * for a course small enough not to need tiling).
	 */
	const DEFAULT_NAIP_RADIUS_METERS = 900;
	/**
	 * Fixed radius for every tile in the full-resolution grid: 300m frames one or two
	 * disc-golf holes (typical hole lengths run roughly 60-250m) with margin on every
	 * side, so each tile stays sharp instead of stretching thin over a huge area.
	 */
	const TILE_RADIUS_METERS = 300;
	/** Default coverage box: most of the preview frame, leaving a visible margin to grow into. */
	const DEFAULT_BOX_FRACTION = 0.9;
	const MIN_BOX_SIZE_PX = 128;
	const BOX_HANDLES = ['nw', 'ne', 'sw', 'se'] as const;

	// MVP default: Dash's Track, Frisco TX. UDisc course-directory coordinate.
	// These remain ordinary editable inputs; the default just lets the common
	// development course skip geocoding entirely and go straight to NAIP.
	let naipLatInput = $state('33.12551979622626');
	let naipLonInput = $state('-96.86103869229555');
	let naipRadiusInput = $state(String(DEFAULT_NAIP_RADIUS_METERS));
	let naipLoading = $state(false);
	let naipCommitting = $state(false);
	let naipError = $state<string | null>(null);
	/** Fetched-but-not-yet-committed aerial preview, awaiting explicit user confirmation. */
	let naipPreview = $state<{ blob: Blob; objectUrl: string } | null>(null);
	/** Center/radius actually used for the current `naipPreview`, kept to derive its bbox. */
	let naipPreviewCenter = $state<GeoPoint | null>(null);
	let naipPreviewRadiusUsed = $state<number | null>(null);

	/**
	 * Exact ground resolution of the committed target-basemap image, when it came
	 * from the radius-based NAIP center fetch (see `naipMetersPerPixel`'s own
	 * docstring for why only that fetch shape has a known, non-estimated scale).
	 * Never guessed or defaulted -- null whenever the current target image did not
	 * come from that exact path, so hole-graphic distance display simply omits
	 * distances rather than showing a wrong number.
	 */
	let targetGroundScaleMetersPerPixel = $state<number | null>(null);
	/**
	 * Center/radius of the committed target-basemap image, retained under the exact
	 * same rule as `targetGroundScaleMetersPerPixel` above (only the radius-based NAIP
	 * center fetch keeps its own geometry) -- powers the elevation-profile action's
	 * WGS84 georeference. Null for an uploaded image, the exact-selection fetch, or the
	 * tile-grid mosaic; the elevation-profile button simply doesn't render for those,
	 * the same degrade real-distance display already uses.
	 */
	let targetGeoCenter = $state<GeoPoint | null>(null);
	let targetGeoRadiusMeters = $state<number | null>(null);

	/** Course-name + city/state search, the primary path to a NAIP center coordinate. */
	let geocodeParkNameInput = $state('');
	let geocodeCityStateInput = $state('');
	let geocodeLoading = $state(false);
	let geocodeError = $state<string | null>(null);
	let geocodeMatches = $state<GeoSearchMatch[] | null>(null);
	let geocodeSelectedIndex = $state<number | null>(null);
	/** Which provider produced `geocodeMatches`, so the correct attribution renders (ODbL for Nominatim, Google's for Places). */
	let geocodeResultSource = $state<'nominatim' | 'places' | null>(null);
	/**
	 * Set only when a key is configured AND the user has picked a result (or
	 * pasted a recognized coordinate) — this is the sole gate that mounts
	 * `MapConfirm`, which is itself the sole thing that ever injects the Google
	 * Dynamic Maps script tag. Carries the key alongside the match so the
	 * template never needs to re-derive/narrow a possibly-null key.
	 */
	let mapConfirmState = $state<{ match: GeoSearchMatch; apiKey: string } | null>(null);
	/** Saved-location prefill note (Course Library location cache read path), dismissible without affecting the prefilled inputs. */
	let savedLocationNote = $state<string | null>(null);

	/** CSS-displayed-pixels-per-natural-pixel for the rendered preview `<img>`, set once it loads. */
	let displayScale = $state(1);
	/** User-adjustable coverage box drawn over the preview, in the preview's own pixel space. */
	let boxRect = $state<PixelRect | null>(null);
	let boxDragHandle = $state<'nw' | 'ne' | 'sw' | 'se' | null>(null);
	let boxDragStart = $state<{ clientX: number; clientY: number; rect: PixelRect } | null>(null);

	/** The assembled full-resolution tile grid, fetched for the area inside `boxRect`. */
	let gridLoading = $state(false);
	let gridError = $state<string | null>(null);
	let gridCommitting = $state(false);
	let gridPreview = $state<{ blob: Blob; objectUrl: string } | null>(null);
	/** Exact geographic selection fetched at a fit-to-box raster size, awaiting import. */
	let exactSelectionLoading = $state(false);
	let exactSelectionError = $state<string | null>(null);
	let exactSelectionCommitting = $state(false);
	let exactSelectionPreview = $state<{ blob: Blob; objectUrl: string } | null>(null);

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
		activityMessage =
			'Add correspondence started. Select a landmark in either the UDisc source or clean target image.';
	}

	function cancelAddCorrespondence(): void {
		correspondence = cancelCorrespondence(correspondence);
		correspondenceError = null;
		activityMessage = 'Pending correspondence cancelled.';
	}

	function placementGuidance(): string {
		if (correspondence.mode === 'add-source') {
			return 'Click a landmark in either the UDisc source or clean target image.';
		}
		if (correspondence.mode === 'add-target' && correspondence.pendingPlacement) {
			return correspondence.pendingPlacement.role === 'source-overview'
				? 'Click the same landmark in the clean target image.'
				: 'Click the same landmark in the UDisc source image.';
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

		// Shortcuts are ignored while focused in an editable text field (e.g. project name).
		if (isEditableTarget(event.target)) return;

		if (event.key === 'Escape' && correspondence.mode !== 'neutral') {
			event.preventDefault();
			cancelAddCorrespondence();
			return;
		}

		const primaryModifier = event.ctrlKey || event.metaKey;
		if (primaryModifier && !event.altKey && !event.shiftKey) {
			const key = event.key.toLowerCase();
			if (key === 's') {
				event.preventDefault();
				if (!saving && !event.repeat) handleSave();
				return;
			}
			if (key === 'o') {
				event.preventDefault();
				if (!openLoading && !event.repeat) openInput?.click();
				return;
			}
		}

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

		if (!primaryModifier && !event.altKey && !event.repeat) {
			const key = event.key.toLowerCase();
			if (key === 'a') {
				if (canAddCorrespondence() && correspondence.mode === 'neutral') {
					event.preventDefault();
					activateAddCorrespondence();
				}
				return;
			}
			if (key === 'm') {
				event.preventDefault();
				markersVisible = !markersVisible;
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
		const imageId = findImageByRole(editor.state.images, placement.role)?.id ?? '';
		const transition = placeCorrespondence(
			correspondence,
			placement,
			imageId,
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
			const currentTargetImageId = findImageByRole(editor.state.images, 'target-basemap')?.id ?? null;
			if (
				currentSourceImageId !== transition.completion.source.imageId ||
				currentTargetImageId !== transition.completion.target.imageId
			) {
				correspondence = cancelCorrespondence(transition.state);
				correspondenceError = 'An image changed. Restart correspondence creation.';
				return;
			}
			editor.addPair({
				sourceCoordinates: transition.completion.source.coordinates,
				targetCoordinates: transition.completion.target.coordinates
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
		// A successful assignment/replacement invalidates any pending placement identity,
		// including same-dimension replacements. Failed/cancelled intake never calls here.
		if (correspondence.mode !== 'neutral') {
			correspondence = cancelCorrespondence(correspondence);
			correspondenceError = null;
		}
		// A replaced target-basemap invalidates any known ground scale and geo-reference
		// -- only the radius-based NAIP confirm path (handleNaipConfirm) sets them back.
		if (role === 'target-basemap') {
			targetGroundScaleMetersPerPixel = null;
			targetGeoCenter = null;
			targetGeoRadiusMeters = null;
		}
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
				// Keeps the local course library in sync for a project reopened and
				// resaved here, a path Annotate Round's Done hook never sees. Best
				// effort: a library write failure must never affect a successful save.
				try {
					await upsertCourse(courseLibraryStore, {
						projectName: result.savedState.project.name,
						numberBadges: badgesToLabeledPoints(result.savedState.numberBadges),
						baskets: basketsFromHoles(result.savedState.holes),
						holes: toLibraryHoles(result.savedState.holes)
					});
				} catch {
					// Ignored — see comment above.
				}
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
		// An opened project's target-basemap has no known fetch geometry -- ground
		// scale and geo-reference belong to the session that fetched the imagery,
		// and carrying them across projects would place elevation profiles (and
		// distance labels) at the previous project's coordinates.
		targetGroundScaleMetersPerPixel = null;
		targetGeoCenter = null;
		targetGeoRadiusMeters = null;
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

	/**
	 * Uses the shared `importHandoffImage` flow (see `$lib/handoffImport.ts`)
	 * with this route's own dialog-backed discard confirmation. The handoff is
	 * consumed only on a successful import; a declined replacement keeps it
	 * available.
	 */
	async function handleHandoffImport(): Promise<void> {
		const handoff = pendingHandoff;
		if (!handoff || importingHandoff) return;
		importingHandoff = true;
		handoffError = null;
		try {
			const result = await importHandoffImage({
				editor,
				handoff,
				role: handoff.targetRole,
				decode,
				confirmDiscard: (count) => requestDiscardConfirmation(handoff.targetRole, count)
			});
			if (result.status === 'error') {
				handoffError = result.message;
				return;
			}
			if (result.status === 'cancelled') {
				activityMessage = 'Replacement cancelled. The stitched image is still pending.';
				return;
			}
			consumePendingHandoff();
			pendingHandoff = null;
			onDomainChanged(handoff.targetRole);
			activityMessage =
				handoff.targetRole === 'source-overview'
					? 'Stitched image imported as the UDisc source.'
					: 'Stitched image imported as the clean target.';
		} finally {
			importingHandoff = false;
		}
	}

	function handleHandoffDismiss(): void {
		consumePendingHandoff();
		pendingHandoff = null;
		handoffError = null;
		activityMessage = 'Pending stitched image dismissed.';
	}

	/**
	 * Routes an AnnotatedRound's source image through the exact same
	 * intake/replacement path as a pane file upload (`intakeImageFile`), so
	 * point-discard confirmation, asset manifest creation, undo/redo, and dirty
	 * state all apply. Used both for the silent auto-intake (no source image
	 * loaded yet, on mount) and for the explicit banner import (a source image
	 * is already loaded). The pending slot is consumed, and the active slot set,
	 * only on a successful (non-cancelled) import.
	 */
	async function importAnnotatedRound(round: AnnotatedRound): Promise<void> {
		if (importingAnnotatedRound) return;
		importingAnnotatedRound = true;
		annotatedRoundError = null;
		try {
			const file = new File([round.sourceImage.blob], round.sourceImage.fileName, {
				type: round.sourceImage.mimeType
			});
			const result = await intakeImageFile({
				editor,
				role: 'source-overview',
				file,
				decode,
				confirmDiscard: (count) => requestDiscardConfirmation('source-overview', count)
			});
			if (!result.ok) {
				annotatedRoundError = result.error.message;
				return;
			}
			if (result.status === 'cancelled') {
				activityMessage = 'Replacement cancelled. The annotated round is still pending.';
				return;
			}
			// Holes cross into durable project state here, so they are saved with the
			// project and restored on reopen. The session artifact is only the transport;
			// `editor.state.holes` is the single source of truth from this point on.
			editor.setHoles(round.holes);
			// Same crossing for the walking path. Passed through as-is (including
			// undefined): `setWalkingPath` normalizes both "absent" and "empty" to the
			// same undefined state, so re-importing a path-less round always clears any
			// stale path left over from a previous import.
			editor.setWalkingPath(round.walkingPath);
			// Badge/basket anchors ride a separate session slot (session.ts's pending
			// course badges) since AnnotatedRound can never carry them (Done-boundary
			// purity rule);
			// this is the only place they cross into durable ProjectState.numberBadges.
			const pendingBadges = getPendingCourseBadges();
			if (pendingBadges) {
				editor.setNumberBadges(pendingBadges.numberBadges);
				// TODO(course-memory): pendingBadges.baskets is discarded here — it can
				// include CV-detected basket points for holes that were never fully
				// confirmed in Annotate Round (see labeledBaskets capture at
				// annotate-round/+page.svelte), so it isn't always redundant with
				// basketsFromHoles(holes) at save time. Rather than silently apply or
				// silently drop it, surface it as an export/import option dialog: let
				// the user decide per basket whether it's a real extra marker to keep
				// (e.g. a second basket on the hole) or stray/leftover CV noise to
				// discard.
				consumePendingCourseBadges();
				// Course Library location cache read path: best-effort, prefill only —
				// never auto-fetches imagery. `round.holes` (not the discarded
				// `pendingBadges.baskets` above) is the same basket source
				// `basketsFromHoles` already uses at save time, so this lookup can only
				// ever match what `attachCourseLocation` could have written.
				if (pendingBadges.numberBadges.length > 0) {
					try {
						const matchedEntry = await findMatchingLibraryEntry(
							courseLibraryStore,
							badgesToLabeledPoints(pendingBadges.numberBadges),
							basketsFromHoles(round.holes)
						);
						if (matchedEntry?.location) {
							naipLatInput = String(matchedEntry.location.lat);
							naipLonInput = String(matchedEntry.location.lon);
							if (matchedEntry.location.radiusMeters !== undefined) {
								naipRadiusInput = String(matchedEntry.location.radiusMeters);
							}
							savedLocationNote = `Using saved location for '${matchedEntry.name}'.`;
						}
					} catch {
						// Ignored — best-effort prefill only, never blocks the import.
					}
				}
			}
			consumePendingAnnotatedRound();
			setActiveAnnotatedRound(round);
			annotatedRound = round;
			pendingAnnotatedRoundBanner = null;
			onDomainChanged('source-overview');
			activityMessage = 'Annotated round imported as the UDisc source.';
		} catch (error) {
			annotatedRoundError =
				error instanceof Error ? error.message : 'Could not import the annotated round.';
		} finally {
			importingAnnotatedRound = false;
		}
	}

	function handleAnnotatedRoundImport(): void {
		if (pendingAnnotatedRoundBanner) void importAnnotatedRound(pendingAnnotatedRoundBanner);
	}

	/** Dismiss only clears the banner; the pending slot survives for a later visit. */
	function handleAnnotatedRoundDismiss(): void {
		pendingAnnotatedRoundBanner = null;
		annotatedRoundError = null;
		activityMessage = 'Pending annotated round dismissed.';
	}

	function clearNaipPreview(): void {
		if (naipPreview) URL.revokeObjectURL(naipPreview.objectUrl);
		naipPreview = null;
		naipPreviewCenter = null;
		naipPreviewRadiusUsed = null;
		boxRect = null;
		displayScale = 1;
		clearGridPreview();
		clearExactSelectionPreview();
	}

	function clearGridPreview(): void {
		if (gridPreview) URL.revokeObjectURL(gridPreview.objectUrl);
		gridPreview = null;
		gridError = null;
	}

	function clearExactSelectionPreview(): void {
		if (exactSelectionPreview) URL.revokeObjectURL(exactSelectionPreview.objectUrl);
		exactSelectionPreview = null;
		exactSelectionError = null;
	}

	function parseNaipCenter(): GeoPoint | null {
		const lat = Number(naipLatInput);
		const lon = Number(naipLonInput);
		if (naipLatInput.trim() === '' || naipLonInput.trim() === '' || !Number.isFinite(lat) || !Number.isFinite(lon)) {
			naipError = 'Enter a valid latitude and longitude.';
			return null;
		}
		if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
			naipError = 'Latitude must be between -90 and 90; longitude between -180 and 180.';
			return null;
		}
		return { lat, lon };
	}

	function parseNaipRadius(): number | null {
		const radius = Number(naipRadiusInput);
		if (naipRadiusInput.trim() === '' || !Number.isFinite(radius) || radius <= 0) {
			naipError = 'Enter a radius greater than 0 meters.';
			return null;
		}
		return radius;
	}

	/**
	 * Nominatim-only lookup, run either as the entire keyless search path or as
	 * the post-Places fallback (`handleGeocodeSearch`'s "OSM occasionally has
	 * what Google lacks" case) — same narrower-retry behavior either way: a
	 * course may be named in OSM but not indexed under the user's metro
	 * spelling/state abbreviation, so a `no-results` combined query retries
	 * with just the stable course name before reporting failure. Transport/HTTP
	 * errors are never retried.
	 */
	async function searchNominatim(parkName: string, combinedQuery: string | null): Promise<GeocodeSearchResult> {
		const initialResult = await searchPlace(combinedQuery ?? parkName);
		return !initialResult.ok && initialResult.error.kind === 'no-results' && combinedQuery
			? await searchPlace(parkName)
			: initialResult;
	}

	/**
	 * Looks up the course by name (city/state optional, to help when the course sits in
	 * some small town near a metro area the user can't name off-hand) and lists matches
	 * for the user to pick from — never fetches NAIP imagery itself. A vague region name
	 * in the city/state field wouldn't narrow the search so much as risk matching some
	 * other named entity entirely (an airport, a neighborhood). The safety net either way
	 * is the same: nothing is used until the user recognizes and picks a specific result
	 * by its full display name below (`selectLocation`).
	 *
	 * One search flow, provider chosen by whether a Google Maps Platform key is
	 * configured (`googleMapsApiKey`): keyed, this calls Google Places Text
	 * Search (course POI data Nominatim/OSM mostly doesn't have — the reason
	 * this provider exists); keyless, this is exactly today's Nominatim-only
	 * behavior, with zero Google contact. A keyed `no-results` from Places
	 * falls back to one Nominatim attempt (OSM occasionally has what Google
	 * lacks) before reporting failure — deliberately not the reverse: a keyless
	 * search never calls Google under any circumstance.
	 *
	 * Also detects a pasted coordinate (or Google Maps URL) in the course-name
	 * field first (`parseCoordinateInput`) and, when found, skips geocoding
	 * entirely — no Nominatim or Places request fires at all.
	 */
	async function handleGeocodeSearch(): Promise<void> {
		if (geocodeLoading) return;
		geocodeError = null;
		geocodeMatches = null;
		geocodeSelectedIndex = null;
		geocodeResultSource = null;
		// A fresh search abandons any pending confirm from a previous pick.
		mapConfirmState = null;
		const parkName = geocodeParkNameInput.trim();
		const cityState = geocodeCityStateInput.trim();
		if (!parkName) {
			geocodeError = 'Enter a course name to search for.';
			return;
		}

		const pastedCoordinate = parseCoordinateInput(parkName);
		if (pastedCoordinate) {
			selectLocation({
				displayName: `${pastedCoordinate.lat}, ${pastedCoordinate.lon}`,
				lat: pastedCoordinate.lat,
				lon: pastedCoordinate.lon
			});
			return;
		}

		geocodeLoading = true;
		try {
			const combinedQuery = cityState ? `${parkName}, ${cityState}` : null;
			const apiKey = googleMapsApiKey();
			if (apiKey) {
				const placesResult = await searchPlacesText(combinedQuery ?? parkName, apiKey);
				if (placesResult.ok) {
					geocodeMatches = placesResult.matches;
					geocodeResultSource = 'places';
					return;
				}
				if (placesResult.error.kind !== 'no-results') {
					geocodeError = placesResult.error.message;
					return;
				}
				const fallback = await searchNominatim(parkName, combinedQuery);
				if (!fallback.ok) {
					geocodeError = fallback.error.message;
					return;
				}
				geocodeMatches = fallback.matches;
				geocodeResultSource = 'nominatim';
				return;
			}

			const result = await searchNominatim(parkName, combinedQuery);
			if (!result.ok) {
				geocodeError = result.error.message;
				return;
			}
			geocodeMatches = result.matches;
			geocodeResultSource = 'nominatim';
		} finally {
			geocodeLoading = false;
		}
	}

	/**
	 * The one place a search result (or a parsed coordinate paste) becomes a
	 * "selected location": keyless, it writes straight into the lat/lon inputs
	 * exactly as before; keyed, it instead arms `mapConfirmState`, which is the
	 * sole gate that mounts `MapConfirm` — the only place the Google Dynamic
	 * Maps script tag is ever injected. An abandoned search therefore costs at
	 * most one Places call and zero map loads.
	 */
	function selectLocation(match: GeoSearchMatch): void {
		naipError = null;
		const apiKey = googleMapsApiKey();
		if (apiKey) {
			mapConfirmState = { match, apiKey };
		} else {
			naipLatInput = String(match.lat);
			naipLonInput = String(match.lon);
		}
	}

	function handleGeocodeSelect(index: number): void {
		const match = geocodeMatches?.[index];
		if (!match) return;
		geocodeSelectedIndex = index;
		selectLocation(match);
	}

	/** "Use this location" on the map confirm step: same lat/lon inputs a picked Nominatim result writes directly. */
	function handleMapConfirmUse(point: GeoPoint): void {
		naipLatInput = String(point.lat);
		naipLonInput = String(point.lon);
		naipError = null;
		mapConfirmState = null;
	}

	/** Cancel closes the confirm step without touching the lat/lon inputs. */
	function handleMapConfirmCancel(): void {
		mapConfirmState = null;
	}

	/**
	 * Fetches a NAIP aerial preview only — never commits into the project. The user
	 * reviews the preview and either confirms (`handleNaipConfirm`) or discards it to
	 * adjust the radius and refetch.
	 */
	async function handleNaipFetch(): Promise<void> {
		if (naipLoading) return;
		naipError = null;
		clearNaipPreview();
		const center = parseNaipCenter();
		if (!center) return;
		const radius = parseNaipRadius();
		if (radius === null) return;
		naipLoading = true;
		try {
			const result = await fetchNaipImage(center, radius);
			if (!result.ok) {
				naipError = result.error.message;
				return;
			}
			naipPreview = { blob: result.blob, objectUrl: URL.createObjectURL(result.blob) };
			naipPreviewCenter = center;
			naipPreviewRadiusUsed = radius;
			// The coverage box itself is initialized once the preview `<img>` fires
			// `onload` (see the template), since that's when its display size is known.
		} finally {
			naipLoading = false;
		}
	}

	/**
	 * Routes the confirmed NAIP preview through the exact same intake/replacement
	 * path as a pane file upload (`intakeImageFile`), so point-discard confirmation,
	 * asset manifest creation, undo/redo, and dirty state all apply identically to a
	 * manual upload.
	 */
	async function handleNaipConfirm(): Promise<void> {
		if (!naipPreview || naipCommitting) return;
		naipCommitting = true;
		naipError = null;
		try {
			const file = new File([naipPreview.blob], 'naip-aerial.png', { type: 'image/png' });
			const result = await intakeImageFile({
				editor,
				role: 'target-basemap',
				file,
				decode,
				confirmDiscard: (count) => requestDiscardConfirmation('target-basemap', count)
			});
			if (!result.ok) {
				naipError = result.error.message;
				return;
			}
			if (result.status === 'cancelled') {
				activityMessage = 'Replacement cancelled. The fetched aerial image is still pending.';
				return;
			}
			const radiusUsed = naipPreviewRadiusUsed;
			const centerUsed = naipPreviewCenter;
			clearNaipPreview();
			onDomainChanged('target-basemap');
			if (radiusUsed !== null) {
				targetGroundScaleMetersPerPixel = naipMetersPerPixel(radiusUsed, NAIP_EXPORT_SIZE_PX);
				if (centerUsed) {
					targetGeoCenter = centerUsed;
					targetGeoRadiusMeters = radiusUsed;
				}
			}
			// Course Library location cache write: only when this fetch's center is
			// known and the current project actually carries Course Memory signature
			// input (badges) to match it against. Best-effort and silently ignored on
			// failure -- see runSave's identical upsertCourse try/catch above; a
			// convenience cache write must never affect a successful commit.
			if (centerUsed && editor.state.numberBadges.length > 0) {
				try {
					await attachCourseLocation(
						courseLibraryStore,
						badgesToLabeledPoints(editor.state.numberBadges),
						basketsFromHoles(editor.state.holes),
						radiusUsed !== null
							? { lat: centerUsed.lat, lon: centerUsed.lon, radiusMeters: radiusUsed }
							: { lat: centerUsed.lat, lon: centerUsed.lon }
					);
				} catch {
					// Ignored — see comment above.
				}
			}
			activityMessage = 'Fetched NAIP aerial image imported as the clean target.';
		} catch (error) {
			naipError = error instanceof Error ? error.message : 'Could not import the fetched aerial image.';
		} finally {
			naipCommitting = false;
		}
	}

	function handleNaipDiscardPreview(): void {
		clearNaipPreview();
	}

	function handleNaipPreviewError(): void {
		clearNaipPreview();
		naipError = 'The aerial preview could not be displayed. Try another US location or radius.';
	}

	function handleGridPreviewError(): void {
		clearGridPreview();
		gridError = 'The assembled aerial preview could not be displayed.';
	}

	function handleExactSelectionPreviewError(): void {
		clearExactSelectionPreview();
		exactSelectionError = 'The exact selected-area preview could not be displayed.';
	}

	function clamp(value: number, min: number, max: number): number {
		return Math.min(Math.max(value, min), Math.max(min, max));
	}

	/**
	 * Centers a default coverage box inside the freshly-fetched preview and records its
	 * display scale from the `load` event's own element — reading a separately-`bind:this`-
	 * bound element here would race a same-tick (e.g. cached-blob) `load` event.
	 */
	function initBoxRect(imgEl: HTMLImageElement): void {
		const size = NAIP_EXPORT_SIZE_PX;
		const boxSize = Math.round(size * DEFAULT_BOX_FRACTION);
		const offset = Math.round((size - boxSize) / 2);
		boxRect = { x: offset, y: offset, width: boxSize, height: boxSize };
		displayScale = imgEl.naturalWidth > 0 ? imgEl.clientWidth / imgEl.naturalWidth : 1;
	}

	/**
	 * Bbox of the current preview, derived from the center/radius actually used to
	 * fetch it (not the possibly-since-edited lat/lon/radius inputs).
	 */
	let naipPreviewBbox: GeoBoundingBox | null = $derived(
		naipPreviewCenter && naipPreviewRadiusUsed !== null
			? bboxFromCenter(naipPreviewCenter, naipPreviewRadiusUsed)
			: null
	);

	/**
	 * Live plan for the area inside `boxRect`, recomputed as the user drags a handle —
	 * pure geometry, no network call, so this can safely run on every drag frame.
	 */
	let gridPlanPreview = $derived.by(() => {
		if (!naipPreviewBbox || !boxRect) return null;
		const geoBox = pixelRectToGeoBox(naipPreviewBbox, NAIP_EXPORT_SIZE_PX, boxRect);
		const { center, widthMeters, heightMeters } = geoBoxCenterAndSize(geoBox);
		const plan = planTileGrid(center, widthMeters, heightMeters, TILE_RADIUS_METERS);
		return { widthMeters, heightMeters, plan };
	});

	function handleBoxHandleDown(handle: 'nw' | 'ne' | 'sw' | 'se', event: PointerEvent): void {
		if (!boxRect) return;
		event.preventDefault();
		boxDragHandle = handle;
		boxDragStart = { clientX: event.clientX, clientY: event.clientY, rect: { ...boxRect } };
		window.addEventListener('pointermove', handleBoxHandleMove);
		window.addEventListener('pointerup', handleBoxHandleUp);
		window.addEventListener('pointercancel', handleBoxHandleUp);
	}

	function handleBoxHandleMove(event: PointerEvent): void {
		if (!boxDragHandle || !boxDragStart) return;
		const scale = displayScale;
		if (scale <= 0) return;
		const dxNatural = (event.clientX - boxDragStart.clientX) / scale;
		const dyNatural = (event.clientY - boxDragStart.clientY) / scale;
		const { rect } = boxDragStart;
		const size = NAIP_EXPORT_SIZE_PX;

		let { x, y, width, height } = rect;
		if (boxDragHandle === 'nw' || boxDragHandle === 'sw') {
			const newX = clamp(rect.x + dxNatural, 0, rect.x + rect.width - MIN_BOX_SIZE_PX);
			width = rect.x + rect.width - newX;
			x = newX;
		} else {
			width = clamp(rect.width + dxNatural, MIN_BOX_SIZE_PX, size - rect.x);
		}
		if (boxDragHandle === 'nw' || boxDragHandle === 'ne') {
			const newY = clamp(rect.y + dyNatural, 0, rect.y + rect.height - MIN_BOX_SIZE_PX);
			height = rect.y + rect.height - newY;
			y = newY;
		} else {
			height = clamp(rect.height + dyNatural, MIN_BOX_SIZE_PX, size - rect.y);
		}
		boxRect = { x, y, width, height };
	}

	function handleBoxHandleUp(): void {
		boxDragHandle = null;
		boxDragStart = null;
		if (typeof window === 'undefined') return;
		window.removeEventListener('pointermove', handleBoxHandleMove);
		window.removeEventListener('pointerup', handleBoxHandleUp);
		window.removeEventListener('pointercancel', handleBoxHandleUp);
	}

	/**
	 * Fetches exactly the geographic area inside the blue selection box. The output
	 * uses the full 2048-pixel budget on its longer side and preserves the box's
	 * aspect ratio, so a 201m x 319m selection is fetched as that rectangle rather
	 * than padded to a 300m-radius square tile.
	 */
	async function handleExactSelectionFetch(): Promise<void> {
		const bbox = naipPreviewBbox;
		const rect = boxRect;
		if (!bbox || !rect || exactSelectionLoading) return;
		clearExactSelectionPreview();
		exactSelectionLoading = true;
		try {
			const selectionBbox = pixelRectToGeoBox(bbox, NAIP_EXPORT_SIZE_PX, rect);
			const { widthMeters, heightMeters } = geoBoxCenterAndSize(selectionBbox);
			const longestSideMeters = Math.max(widthMeters, heightMeters);
			const pixelsPerMeter = NAIP_EXPORT_SIZE_PX / longestSideMeters;
			const result = await fetchNaipBoundingBoxImage(selectionBbox, {
				widthPx: Math.max(1, Math.round(widthMeters * pixelsPerMeter)),
				heightPx: Math.max(1, Math.round(heightMeters * pixelsPerMeter))
			});
			if (!result.ok) {
				exactSelectionError = result.error.message;
				return;
			}
			exactSelectionPreview = {
				blob: result.blob,
				objectUrl: URL.createObjectURL(result.blob)
			};
		} catch (error) {
			exactSelectionError =
				error instanceof Error ? error.message : 'Could not fetch the exact selected area.';
		} finally {
			exactSelectionLoading = false;
		}
	}

	async function handleExactSelectionConfirm(): Promise<void> {
		if (!exactSelectionPreview || exactSelectionCommitting) return;
		exactSelectionCommitting = true;
		exactSelectionError = null;
		try {
			const file = new File([exactSelectionPreview.blob], 'naip-selected-area.png', { type: 'image/png' });
			const result = await intakeImageFile({
				editor,
				role: 'target-basemap',
				file,
				decode,
				confirmDiscard: (count) => requestDiscardConfirmation('target-basemap', count)
			});
			if (!result.ok) {
				exactSelectionError = result.error.message;
				return;
			}
			if (result.status === 'cancelled') {
				activityMessage = 'Replacement cancelled. The exact selected-area image is still pending.';
				return;
			}
			clearNaipPreview();
			onDomainChanged('target-basemap');
			activityMessage = 'Exact selected area imported as the clean target.';
		} catch (error) {
			exactSelectionError =
				error instanceof Error ? error.message : 'Could not import the exact selected area.';
		} finally {
			exactSelectionCommitting = false;
		}
	}

	function handleExactSelectionDiscard(): void {
		clearExactSelectionPreview();
	}

	/**
	 * Fetches every tile the current box requires and composes them into one mosaic
	 * preview — never commits into the project. Deterministic placement (see
	 * `naipGrid.ts`/`naipMosaic.ts`): each tile's geographic extent was chosen before
	 * any request was made, so composing them is arithmetic, not image matching.
	 */
	async function handleGridFetch(): Promise<void> {
		const planned = gridPlanPreview;
		if (!planned || gridLoading) return;
		clearGridPreview();
		gridLoading = true;
		try {
			const fetchResult = await fetchTileGrid(planned.plan);
			if (!fetchResult.ok) {
				gridError = `Tile ${fetchResult.error.tileIndex + 1} of ${planned.plan.rows * planned.plan.cols}: ${fetchResult.error.message}`;
				return;
			}
			const decodeFn = decode ?? decodeImageFile;
			const images = await Promise.all(
				fetchResult.tiles.map(async (blob, index) => {
					const file = new File([blob], `naip-tile-${index}.png`, { type: 'image/png' });
					const decoded = await decodeFn(file);
					return decoded.image;
				})
			);
			const mosaicBlob = await composeMosaic(images, planned.plan.rows, planned.plan.cols);
			gridPreview = { blob: mosaicBlob, objectUrl: URL.createObjectURL(mosaicBlob) };
		} catch (error) {
			gridError = error instanceof Error ? error.message : 'Could not assemble the tile grid.';
		} finally {
			gridLoading = false;
		}
	}

	/** Same intake path as `handleNaipConfirm` — the mosaic is just another PNG file. */
	async function handleGridConfirm(): Promise<void> {
		if (!gridPreview || gridCommitting) return;
		gridCommitting = true;
		gridError = null;
		try {
			const file = new File([gridPreview.blob], 'naip-tile-grid.png', { type: 'image/png' });
			const result = await intakeImageFile({
				editor,
				role: 'target-basemap',
				file,
				decode,
				confirmDiscard: (count) => requestDiscardConfirmation('target-basemap', count)
			});
			if (!result.ok) {
				gridError = result.error.message;
				return;
			}
			if (result.status === 'cancelled') {
				activityMessage = 'Replacement cancelled. The assembled tile grid is still pending.';
				return;
			}
			clearNaipPreview();
			onDomainChanged('target-basemap');
			activityMessage = 'Assembled NAIP tile grid imported as the clean target.';
		} catch (error) {
			gridError = error instanceof Error ? error.message : 'Could not import the assembled tile grid.';
		} finally {
			gridCommitting = false;
		}
	}

	function handleGridDiscardPreview(): void {
		clearGridPreview();
	}

	onMount(() => {
		// Only the target-basemap handoff belongs here now; the source-role case
		// is entirely Annotate Round's since P1 Ticket 1.
		const handoff = getPendingHandoff();
		pendingHandoff = handoff && handoff.targetRole === 'target-basemap' ? handoff : null;

		// Every new session-module read here is gated on participatesInSession:
		// only production-created or session-retrieved editors participate, so
		// injected-editor unit tests never observe cross-test session leakage.
		const pendingRound = participatesInSession ? getPendingAnnotatedRound() : null;
		if (pendingRound) {
			if (!sourceImage()) {
				// No source loaded yet: auto-intake, no extra click required.
				void importAnnotatedRound(pendingRound);
			} else {
				// A source image is already loaded: never silently replace it.
				pendingAnnotatedRoundBanner = pendingRound;
			}
		} else {
			const activeRound = participatesInSession ? getActiveAnnotatedRound() : null;
			if (activeRound) annotatedRound = activeRound;
		}

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

<svelte:head>
	<title>Create Graphics | ChainSpot</title>
</svelte:head>

	<main
		data-testid="app-shell"
		data-correspondence-mode={correspondence.mode}
		data-complete-pair-count={currentPairs().length}
		data-pending-pair-count={correspondence.pendingPlacement ? 1 : 0}
		data-pending-source={correspondence.pendingPlacement?.role === 'source-overview' ? 'true' : 'false'}
		data-pending-placement-role={correspondence.pendingPlacement?.role ?? ''}
		data-annotated-round={annotatedRound ? 'present' : 'absent'}
		data-hole-count={currentHoles().length}
	>
	{#if pendingHandoff}
		<section
			class="handoff-banner"
			data-testid="pending-handoff"
			aria-label="Pending stitched image"
		>
			<p>
				Stitched image “{pendingHandoff.fileName}” is ready to import as the
				{pendingHandoff.targetRole === 'source-overview' ? 'UDisc source' : 'clean target'}.
			</p>
			<div class="handoff-actions">
				<button
					type="button"
					data-testid="handoff-import"
					disabled={importingHandoff}
					onclick={handleHandoffImport}
				>
					Import
				</button>
				<button
					type="button"
					data-testid="handoff-dismiss"
					disabled={importingHandoff}
					onclick={handleHandoffDismiss}
				>
					Dismiss
				</button>
			</div>
			{#if handoffError}
				<p class="error" data-testid="handoff-error" role="alert">{handoffError}</p>
			{/if}
		</section>
	{/if}
	{#if pendingAnnotatedRoundBanner}
		<section
			class="handoff-banner"
			data-testid="annotated-round-banner"
			aria-label="Pending annotated round"
		>
			<p>
				An annotated round with source image “{pendingAnnotatedRoundBanner.sourceImage.fileName}”
				is ready to import as the UDisc source.
			</p>
			<div class="handoff-actions">
				<button
					type="button"
					data-testid="annotated-round-import"
					disabled={importingAnnotatedRound}
					onclick={handleAnnotatedRoundImport}
				>
					Import
				</button>
				<button
					type="button"
					data-testid="annotated-round-dismiss"
					disabled={importingAnnotatedRound}
					onclick={handleAnnotatedRoundDismiss}
				>
					Dismiss
				</button>
			</div>
			{#if annotatedRoundError}
				<p class="error" data-testid="annotated-round-error" role="alert">{annotatedRoundError}</p>
			{/if}
		</section>
	{/if}
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
				? 'Add a correspondence (A)'
				: 'Load both images to add correspondences'}
			aria-keyshortcuts="A"
		>
			Add correspondence (A)
		</button>
		{#if correspondence.mode !== 'neutral'}
			<button
				type="button"
				class="cancel-correspondence"
				data-testid="cancel-correspondence"
				onclick={cancelAddCorrespondence}
				title="Cancel (Esc)"
				aria-keyshortcuts="Escape"
			>
				Cancel (Esc)
			</button>
		{/if}
		<button
			type="button"
			class="history-button"
			data-testid="undo"
			bind:this={undoButton}
			disabled={!canUndo()}
			onclick={handleUndo}
			title="Undo (⌘/Ctrl+Z)"
			aria-keyshortcuts="Control+Z Meta+Z"
		>
			Undo (⌘/Ctrl+Z)
		</button>
		<button
			type="button"
			class="history-button"
			data-testid="redo"
			disabled={!canRedo()}
			onclick={handleRedo}
			title="Redo (⌘/Ctrl+Shift+Z, or Ctrl+Y)"
			aria-keyshortcuts="Control+Shift+Z Meta+Shift+Z Control+Y"
		>
			Redo (⌘/Ctrl+Shift+Z)
		</button>
		<button
			type="button"
			class="marker-toggle"
			data-testid="toggle-markers"
			aria-pressed={markersVisible}
			onclick={() => (markersVisible = !markersVisible)}
			title={markersVisible
				? 'Hide control-point markers (M)'
				: 'Show control-point markers (M)'}
			aria-keyshortcuts="M"
		>
			{markersVisible ? 'Hide markers (M)' : 'Show markers (M)'}
		</button>
		<button
			type="button"
			class="persistence-button"
			data-testid="save-project"
			bind:this={saveProjectButton}
			disabled={saving}
			onclick={handleSave}
			title="Save the project as a portable .chainspot.zip bundle (⌘/Ctrl+S)"
			aria-keyshortcuts="Control+S Meta+S"
		>
			Save project (⌘/Ctrl+S)
		</button>
		<button
			type="button"
			class="persistence-button"
			data-testid="open-project"
			bind:this={openProjectButton}
			disabled={openLoading}
			onclick={() => openInput?.click()}
			title="Open a .chainspot.zip project bundle (⌘/Ctrl+O)"
			aria-keyshortcuts="Control+O Meta+O"
		>
			Open project (⌘/Ctrl+O)
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
			pendingPlacement={correspondence.pendingPlacement}
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
			pendingPlacement={correspondence.pendingPlacement}
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

	<section
		class="naip-fetch"
		data-testid="naip-fetch"
		aria-labelledby="naip-fetch-heading"
	>
		<h2 id="naip-fetch-heading">Fetch clean target from USGS NAIP</h2>
		<p class="naip-hint">
			Alternative to uploading a target image above: search for the course by
			name, pick the matching location, then fetch a clean aerial map from the
			public USGS NAIP imagery service. US coverage only — manual upload above
			still works for other courses. City/state is optional — leave it blank if
			you're not sure which nearby town the course is actually in; check each
			result's full location below before picking one.
		</p>

		<div class="geocode-search">
			<label>
				<span>Course name</span>
				<input
					type="text"
					data-testid="geocode-park-name"
					bind:value={geocodeParkNameInput}
					placeholder="e.g. Dash's Track"
				/>
			</label>
			<label>
				<span>City, State (optional)</span>
				<input
					type="text"
					data-testid="geocode-city-state"
					bind:value={geocodeCityStateInput}
					placeholder="e.g. Frisco, TX"
				/>
			</label>
			<button
				type="button"
				data-testid="geocode-search-button"
				disabled={geocodeLoading}
				onclick={handleGeocodeSearch}
			>
				{geocodeLoading ? 'Searching…' : 'Search'}
			</button>
		</div>
		{#if geocodeError}
			<p class="error" data-testid="geocode-error" role="alert">{geocodeError}</p>
		{/if}
		{#if geocodeMatches && geocodeMatches.length > 0}
			<ul class="geocode-results" data-testid="geocode-results">
				{#each geocodeMatches as match, index (match.displayName + index)}
					<li>
						<button
							type="button"
							class="geocode-result"
							class:selected={geocodeSelectedIndex === index}
							data-testid="geocode-result-{index}"
							onclick={() => handleGeocodeSelect(index)}
						>
							{match.displayName}
						</button>
					</li>
				{/each}
			</ul>
			{#if geocodeResultSource === 'places'}
				<p class="geocode-attribution" data-testid="geocode-attribution">Powered by Google</p>
			{:else}
				<p class="geocode-attribution" data-testid="geocode-attribution">
					Location search © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer"
						>OpenStreetMap</a
					> contributors
				</p>
			{/if}
		{/if}
		{#if mapConfirmState}
			<MapConfirm
				apiKey={mapConfirmState.apiKey}
				center={{ lat: mapConfirmState.match.lat, lon: mapConfirmState.match.lon }}
				label={mapConfirmState.match.displayName}
				onUse={handleMapConfirmUse}
				onCancel={handleMapConfirmCancel}
			/>
		{/if}
		{#if geocodeSelectedIndex !== null && !mapConfirmState}
			<p class="naip-selected-coords" data-testid="naip-selected-coords">
				Selected: {naipLatInput}, {naipLonInput}
			</p>
		{/if}
		{#if savedLocationNote}
			<p class="saved-location-note" data-testid="saved-location-note">
				{savedLocationNote}
				<button type="button" data-testid="saved-location-dismiss" onclick={() => (savedLocationNote = null)}>
					Dismiss
				</button>
			</p>
		{/if}

		<div class="naip-inputs">
			<label>
				<span>Radius (meters)</span>
				<input type="text" inputmode="decimal" data-testid="naip-radius" bind:value={naipRadiusInput} />
			</label>
			<button
				type="button"
				data-testid="naip-fetch-button"
				disabled={naipLoading}
				onclick={handleNaipFetch}
			>
				{naipLoading ? 'Fetching…' : 'Fetch aerial map'}
			</button>
		</div>

		<details class="naip-manual-entry" data-testid="naip-manual-entry" open>
			<summary>Coordinates (editable)</summary>
			<div class="naip-inputs">
				<label>
					<span>Latitude</span>
					<input
						type="text"
						inputmode="decimal"
						data-testid="naip-lat"
						bind:value={naipLatInput}
						placeholder="e.g. 44.9778"
					/>
				</label>
				<label>
					<span>Longitude</span>
					<input
						type="text"
						inputmode="decimal"
						data-testid="naip-lon"
						bind:value={naipLonInput}
						placeholder="e.g. -93.2650"
					/>
				</label>
			</div>
		</details>

		{#if naipError}
			<p class="error" data-testid="naip-error" role="alert">{naipError}</p>
		{/if}
		{#if naipPreview}
			<div class="naip-preview" data-testid="naip-preview">
				<p class="naip-hint">
					Drag a corner to size the area you want at full resolution, then fetch the
					exact selected area or a larger tile grid for it below. "Use this preview
					as-is" skips both options and commits this single reference image instead.
				</p>
				<div class="naip-overview-frame" data-testid="naip-overview-frame">
					<img
						class="naip-overview-image"
						src={naipPreview.objectUrl}
						alt="Fetched NAIP aerial preview, not yet used"
						onload={(event) => initBoxRect(event.currentTarget as HTMLImageElement)}
						onerror={handleNaipPreviewError}
					/>
					{#if boxRect}
						<div
							class="naip-box"
							data-testid="naip-box"
							style="left:{boxRect.x * displayScale}px; top:{boxRect.y *
								displayScale}px; width:{boxRect.width * displayScale}px; height:{boxRect.height *
								displayScale}px;"
						>
							{#each BOX_HANDLES as handle (handle)}
								<button
									type="button"
									class="naip-box-handle naip-box-handle-{handle}"
									data-testid="naip-box-handle-{handle}"
									aria-label="Resize selected area ({handle})"
									onpointerdown={(event) => handleBoxHandleDown(handle, event)}
								></button>
							{/each}
						</div>
					{/if}
				</div>
				<div class="naip-preview-actions">
					<button
						type="button"
						data-testid="naip-use"
						disabled={naipCommitting}
						onclick={handleNaipConfirm}
					>
						{naipCommitting ? 'Using…' : 'Use this preview as-is'}
					</button>
					<button
						type="button"
						data-testid="naip-discard"
						disabled={naipCommitting}
						onclick={handleNaipDiscardPreview}
					>
						Discard, adjust radius
					</button>
				</div>
			</div>

			{#if gridPlanPreview}
				<div class="naip-grid-plan" data-testid="naip-grid-plan">
					<p>
						Selected area: {Math.round(gridPlanPreview.widthMeters)}m x {Math.round(
							gridPlanPreview.heightMeters
						)}m &rarr; {gridPlanPreview.plan.rows} x {gridPlanPreview.plan.cols} tiles at {TILE_RADIUS_METERS}m
						radius each ({gridPlanPreview.plan.rows * gridPlanPreview.plan.cols} images).
					</p>
					<button
						type="button"
						data-testid="naip-grid-fetch-button"
						disabled={gridLoading}
						onclick={handleGridFetch}
					>
						{gridLoading
							? 'Fetching tiles…'
							: `Fetch ${gridPlanPreview.plan.rows * gridPlanPreview.plan.cols} full-resolution tiles`}
					</button>
					<button
						type="button"
						data-testid="naip-exact-fetch-button"
						disabled={exactSelectionLoading}
						onclick={handleExactSelectionFetch}
					>
						{exactSelectionLoading ? 'Fetching exact area…' : 'Fetch exact selected area'}
					</button>
				</div>
			{/if}
			{#if gridError}
				<p class="error" data-testid="naip-grid-error" role="alert">{gridError}</p>
			{/if}
			{#if exactSelectionError}
				<p class="error" data-testid="naip-exact-error" role="alert">{exactSelectionError}</p>
			{/if}
			{#if exactSelectionPreview}
				<div class="naip-preview" data-testid="naip-exact-preview">
					<div>
						<p class="naip-hint">Exact blue-box area, fetched without the 300 m tile-radius padding.</p>
						<img
							class="naip-preview-image"
							src={exactSelectionPreview.objectUrl}
							alt="Exact selected NAIP area, not yet used"
							onerror={handleExactSelectionPreviewError}
						/>
					</div>
					<div class="naip-preview-actions">
						<button
							type="button"
							data-testid="naip-exact-use"
							disabled={exactSelectionCommitting}
							onclick={handleExactSelectionConfirm}
						>
							{exactSelectionCommitting ? 'Using…' : 'Use exact area as clean target'}
						</button>
						<button
							type="button"
							data-testid="naip-exact-discard"
							disabled={exactSelectionCommitting}
							onclick={handleExactSelectionDiscard}
						>
							Discard
						</button>
					</div>
				</div>
			{/if}
			{#if gridPreview}
				<div class="naip-preview" data-testid="naip-grid-preview">
					<img
						class="naip-preview-image"
						src={gridPreview.objectUrl}
						alt="Assembled full-resolution NAIP tile grid, not yet used"
						onerror={handleGridPreviewError}
					/>
					<div class="naip-preview-actions">
						<button
							type="button"
							data-testid="naip-grid-use"
							disabled={gridCommitting}
							onclick={handleGridConfirm}
						>
							{gridCommitting ? 'Using…' : 'Use this image'}
						</button>
						<button
							type="button"
							data-testid="naip-grid-discard"
							disabled={gridCommitting}
							onclick={handleGridDiscardPreview}
						>
							Discard
						</button>
					</div>
				</div>
			{/if}
		{/if}
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
		{#if correspondence.mode === 'add-target' && correspondence.pendingPlacement}
			<p class="pending-guidance" data-testid="pending-guidance">
				This pair is not saved yet. Click the same landmark in the
				{correspondence.pendingPlacement.role === 'source-overview' ? 'target' : 'source'} image to
				complete it, or press Escape / Cancel to discard it.
			</p>
		{/if}
		{#each diagnosticsView.warnings as warning (warning)}
			<p class="diagnostic-warning" data-testid="diagnostic-warning">{warning}</p>
		{/each}
	</section>

	<section class="alignment-panel" data-testid="alignment-panel" aria-labelledby="alignment-heading">
		<h2 id="alignment-heading">Alignment</h2>
		<fieldset class="alignment-model">
			<legend>Transform model</legend>
			<label>
				<input
					type="radio"
					name="alignment-model"
					value="similarity"
					checked={alignmentModel === 'similarity'}
					onchange={() => (alignmentModel = 'similarity')}
					data-testid="alignment-model-similarity"
				/>
				Similarity (2+ pairs)
			</label>
			<label>
				<input
					type="radio"
					name="alignment-model"
					value="affine"
					checked={alignmentModel === 'affine'}
					onchange={() => (alignmentModel = 'affine')}
					data-testid="alignment-model-affine"
				/>
				Affine (3+ non-collinear pairs)
			</label>
		</fieldset>

		{#if !alignmentResult}
			<p class="alignment-empty" data-testid="alignment-empty">
				Add at least one enabled, completed pair to estimate an alignment.
			</p>
		{:else if 'transform' in alignmentResult}
			<div class="alignment-result" data-testid="alignment-result">
				<p data-testid="alignment-summary">
					{alignmentResult.model} transform from {alignmentResult.usedPairIds.length} pair{alignmentResult
						.usedPairIds.length === 1
						? ''
						: 's'}
					&mdash; mean residual {alignmentResult.metrics.meanDistance.toFixed(2)}px, max {alignmentResult.metrics.maxDistance.toFixed(
						2
					)}px
				</p>
				{#each alignmentWarnings as warning (warning.type)}
					<p class="alignment-warning" data-testid="alignment-warning" data-severity={warning.severity}>
						{warning.message}
					</p>
				{/each}
			</div>
		{:else}
			<p class="alignment-failure" data-testid="alignment-failure" role="alert">
				{ALIGNMENT_FAILURE_MESSAGES[alignmentResult.reason]}
			</p>
		{/if}
	</section>

	{#if currentHoles().length > 0 && targetImage()}
		<section class="hole-graphics" data-testid="hole-graphics" aria-labelledby="hole-graphics-heading">
			<h2 id="hole-graphics-heading">Hole graphics</h2>
			<p class="alignment-empty">
				Applies the alignment above to every annotated hole's tee, basket, shot,
				bend, and corridor points, live — previews below update as annotations or
				the alignment change. Holes with no placed points yet are skipped.
			</p>
			{#if graphicsMode.plans.length === 0}
				<p class="alignment-empty" data-testid="hole-graphics-empty">
					No hole has both a placed point and a usable alignment yet.
				</p>
			{:else}
				<label class="hole-graphic-style">
					Color theme
					<select data-testid="hole-graphic-style" bind:value={graphicsMode.styleId}>
						{#each GRAPHIC_STYLE_PRESETS as preset (preset.id)}
							<option value={preset.id}>{preset.name}</option>
						{/each}
					</select>
				</label>
				{#if targetGroundScaleMetersPerPixel !== null}
					<p class="alignment-empty" data-testid="hole-graphics-ground-scale">
						Real hole distances shown (ground scale from the NAIP fetch).
					</p>
				{/if}
				<button
					type="button"
					data-testid="download-all-hole-graphics"
					disabled={graphicsMode.zipping}
					onclick={() => graphicsMode.downloadAll()}
				>
					{graphicsMode.zipping ? 'Zipping…' : `Download all ${graphicsMode.plans.length} as .zip`}
				</button>
			{/if}
			{#if graphicsMode.error}
				<p class="error" data-testid="hole-graphics-error" role="alert">{graphicsMode.error}</p>
			{/if}
			{#if graphicsMode.plans.length > 0}
				{@const href = targetImageHref()}
				<ul class="hole-graphic-list" data-testid="hole-graphic-list">
					{#each graphicsMode.plans as plan (plan.holeId)}
						<li class="hole-graphic-item">
							{#if href}
								<div class="hole-graphic-preview" data-testid="hole-graphic-preview-{plan.number}">
									{@html buildHoleGraphicMarkup(plan, href, graphicsMode.style, holeGraphicFeetPerPixel())}
								</div>
							{/if}
							<button
								type="button"
								data-testid="hole-graphic-download-{plan.number}"
								disabled={!href || graphicsMode.downloading.has(plan.holeId)}
								onclick={() => graphicsMode.downloadOne(plan)}
							>
								{graphicsMode.downloading.has(plan.holeId) ? 'Rendering…' : `Download hole ${plan.number}`}
							</button>
							{#if graphicsMode.elevationEligible(plan)}
								<button
									type="button"
									data-testid="elevation-profile-{plan.number}"
									disabled={graphicsMode.elevationBuilding.has(plan.holeId)}
									onclick={() => graphicsMode.buildAndDownloadElevation(plan)}
								>
									{graphicsMode.elevationBuilding.has(plan.holeId)
										? 'Building elevation profile…'
										: 'Elevation profile'}
								</button>
								{@const stats = graphicsMode.elevationStats.get(plan.holeId)}
								{#if stats}
									<span class="elevation-stats" data-testid="elevation-profile-stats-{plan.number}">
										&uarr;{Math.round(stats.totalClimb)} ft &darr;{Math.round(stats.totalDescent)} ft
									</span>
								{/if}
								{@const elevationError = graphicsMode.elevationErrors.get(plan.holeId)}
								{#if elevationError}
									<p class="error" data-testid="elevation-profile-error-{plan.number}" role="alert">
										{elevationError}
									</p>
								{/if}
							{/if}
						</li>
					{/each}
				</ul>
			{/if}
		</section>
	{/if}

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
					Replacing the {pendingRoleLabel()} image will discard
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
					Replacing the {roleLabel(pendingRepairDiscard.role)} image will discard
					{pendingRepairDiscard.count} correspondence point
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
		outline: 3px solid #38bdf8;
		outline-offset: 2px;
	}

	:global(button:disabled) {
		cursor: not-allowed;
	}

	/* Base dark styling for this route's plain buttons/inputs/selects that don't
	   opt into the sized rule below — otherwise they fall back to unstyled
	   browser-default (light) chrome, which reads as broken against the dark
	   panels. */
	button {
		padding: 0.4rem 0.8rem;
		border: 1px solid #3f3f46;
		border-radius: 4px;
		background-color: #27272a;
		color: #e4e4e7;
		font-size: 0.85rem;
		cursor: pointer;
	}

	button:disabled {
		opacity: 0.5;
	}

	input:not([type='file']):not([type='radio']):not([type='checkbox']) {
		padding: 0.3rem 0.5rem;
		border: 1px solid #3f3f46;
		border-radius: 4px;
		background-color: #1e1e24;
		color: #e4e4e7;
		font: inherit;
	}

	select {
		padding: 0.3rem 0.5rem;
		border: 1px solid #3f3f46;
		border-radius: 4px;
		background-color: #27272a;
		color: #e4e4e7;
		font: inherit;
		cursor: pointer;
	}

	/* Shared sizing for the route's plain action buttons (add correspondence,
	   undo/redo, save/open, marker toggle, geocode search) — these previously
	   rendered as unstyled ~21px browser-default buttons, well below the
	   ~40-44px targets used elsewhere in the app. */
	.add-correspondence,
	.cancel-correspondence,
	.history-button,
	.persistence-button,
	.marker-toggle,
	[data-testid='geocode-search-button'] {
		min-height: 2.25rem;
		padding: 0.4rem 0.8rem;
		border: 1px solid #3f3f46;
		border-radius: 4px;
		background-color: #27272a;
		color: #e4e4e7;
		font-size: 0.85rem;
		cursor: pointer;
	}

	.toolbar {
		display: flex;
		align-items: center;
		gap: 1rem;
		flex-wrap: wrap;
	}

	.handoff-banner {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.75rem;
		padding: 0.6rem 0.8rem;
		border: 1px solid #166534;
		border-radius: 6px;
		background-color: #052e16;
		color: #bbf7d0;
		font-size: 0.9rem;
	}

	.handoff-banner p {
		margin: 0;
	}

	.handoff-actions {
		display: flex;
		gap: 0.5rem;
		margin-left: auto;
	}

	.handoff-banner .error {
		flex-basis: 100%;
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
		background: #422006;
		border: 1px solid #a16207;
		color: #fde68a;
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
		background: #3f1d1d;
		border: 1px solid #7f1d1d;
		color: #fca5a5;
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
		border: 1px solid #3f3f46;
		border-radius: 6px;
		background: #18181b;
		color: #e4e4e7;
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
		border: 1px solid #3f3f46;
		border-radius: 4px;
		background: #27272a;
		color: #e4e4e7;
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
		color: #fbbf24;
	}

	.pair-diagnostics {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		margin: 0;
		padding: 0.6rem 0.7rem;
		border: 1px solid #3f3f46;
		border-radius: 6px;
		background: #18181b;
		color: #e4e4e7;
		font-size: 0.85rem;
	}

	.pair-diagnostics p {
		margin: 0;
	}

	.diagnostic-warning {
		color: #fbbf24;
	}

	.alignment-panel {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		padding: 0.6rem 0.7rem;
		border: 1px solid #3f3f46;
		border-radius: 6px;
		background: #18181b;
		color: #e4e4e7;
		font-size: 0.85rem;
	}

	.alignment-panel h2 {
		margin: 0;
		font-size: 0.95rem;
	}

	.alignment-model {
		display: flex;
		flex-wrap: wrap;
		gap: 1rem;
		border: none;
		padding: 0;
		margin: 0;
	}

	.alignment-model legend {
		font-size: 0.75rem;
		opacity: 0.8;
		padding: 0;
	}

	.alignment-model label {
		display: flex;
		align-items: center;
		gap: 0.3rem;
	}

	.alignment-empty {
		margin: 0;
		opacity: 0.75;
	}

	.alignment-result {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}

	.alignment-result p {
		margin: 0;
	}

	.alignment-warning {
		color: #fbbf24;
	}

	.alignment-warning[data-severity='high'] {
		color: #fca5a5;
	}

	.alignment-failure {
		margin: 0;
		color: #fca5a5;
	}

	.hole-graphics {
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
		max-width: 48rem;
	}

	.hole-graphics h2 {
		margin: 0;
		font-size: 1rem;
	}

	.hole-graphic-list {
		display: flex;
		flex-wrap: wrap;
		gap: 1rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.hole-graphic-item {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		align-items: flex-start;
	}

	.hole-graphic-preview {
		max-width: 14rem;
		max-height: 10rem;
		overflow: hidden;
		border: 1px solid #3f3f46;
		border-radius: 4px;
	}

	.hole-graphic-preview :global(svg) {
		display: block;
		max-width: 100%;
		max-height: 100%;
	}

	.hole-graphic-item button {
		font-size: 0.8rem;
	}

	.elevation-stats {
		font-size: 0.75rem;
		opacity: 0.75;
	}

	.hole-graphic-style {
		display: flex;
		align-items: center;
		gap: 0.4rem;
	}

	.point-inspector {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		padding: 0.7rem;
		border: 1px solid #3f3f46;
		border-radius: 6px;
		background: #18181b;
		color: #e4e4e7;
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

	.naip-fetch {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		padding: 0.75rem 1rem;
		border: 1px solid #3f3f46;
		border-radius: 6px;
		background: #18181b;
	}

	.naip-fetch h2 {
		font-size: 1rem;
		margin: 0;
	}

	.naip-hint {
		margin: 0;
		font-size: 0.85rem;
		opacity: 0.8;
	}

	.naip-inputs {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		gap: 0.75rem;
	}

	.naip-inputs label {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		font-size: 0.85rem;
	}

	.naip-inputs input {
		width: 10rem;
	}

	.naip-preview {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-start;
		gap: 0.75rem;
	}

	.naip-preview-image {
		max-width: 20rem;
		max-height: 15rem;
		width: auto;
		height: auto;
		border: 1px solid #3f3f46;
		border-radius: 4px;
	}

	.naip-preview-actions {
		display: flex;
		gap: 0.5rem;
	}

	.naip-overview-frame {
		position: relative;
		display: inline-block;
	}

	.naip-overview-image {
		display: block;
		max-width: 28rem;
		max-height: 28rem;
		width: auto;
		height: auto;
		border: 1px solid #3f3f46;
		border-radius: 4px;
		background: #27272a;
		user-select: none;
	}

	.naip-box {
		position: absolute;
		border: 2px solid #2a6df4;
		background: rgb(42 109 244 / 10%);
		box-sizing: border-box;
	}

	.naip-box-handle {
		position: absolute;
		width: 0.9rem;
		height: 0.9rem;
		margin: -0.45rem;
		padding: 0;
		border: 1px solid #fff;
		border-radius: 50%;
		background: #2a6df4;
		touch-action: none;
	}

	.naip-box-handle-nw {
		top: 0;
		left: 0;
		cursor: nwse-resize;
	}

	.naip-box-handle-ne {
		top: 0;
		right: 0;
		margin-right: -0.45rem;
		cursor: nesw-resize;
	}

	.naip-box-handle-sw {
		bottom: 0;
		left: 0;
		margin-bottom: -0.45rem;
		cursor: nesw-resize;
	}

	.naip-box-handle-se {
		bottom: 0;
		right: 0;
		margin-bottom: -0.45rem;
		margin-right: -0.45rem;
		cursor: nwse-resize;
	}

	.naip-grid-plan {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.75rem;
	}

	.naip-grid-plan p {
		margin: 0;
		font-size: 0.85rem;
	}

	.geocode-search {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		gap: 0.75rem;
	}

	.geocode-search label {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		font-size: 0.85rem;
	}

	.geocode-search input {
		width: 12rem;
	}

	.geocode-results {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.geocode-result {
		text-align: left;
		padding: 0.4rem 0.6rem;
		border: 1px solid #3f3f46;
		border-radius: 4px;
		background: #27272a;
		color: #f4f4f5;
		cursor: pointer;
		width: 100%;
	}

	.geocode-result.selected {
		border-color: #2a6df4;
		background: #172554;
		color: #eff6ff;
	}

	.geocode-attribution {
		margin: 0;
		font-size: 0.75rem;
		opacity: 0.7;
	}

	.naip-selected-coords {
		margin: 0;
		font-size: 0.85rem;
	}

	.saved-location-note {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin: 0;
		padding: 0.4rem 0.6rem;
		border: 1px solid #2a6df4;
		border-radius: 4px;
		background: rgb(42 109 244 / 10%);
		font-size: 0.85rem;
	}

	.saved-location-note button {
		margin-left: auto;
	}

	.naip-manual-entry summary {
		cursor: pointer;
		font-size: 0.85rem;
	}

	.naip-manual-entry .naip-inputs {
		margin-top: 0.5rem;
	}

	.dialog-backdrop {
		position: fixed;
		inset: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		background: rgb(0 0 0 / 60%);
		z-index: 50;
	}

	.dialog {
		background: #1e1e24;
		border: 1px solid #3f3f46;
		border-radius: 8px;
		padding: 1rem 1.25rem;
		max-width: 26rem;
		color: #e4e4e7;
	}

	.dialog h2 {
		margin: 0 0 0.5rem;
		font-size: 1.1rem;
		color: #f4f4f5;
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
