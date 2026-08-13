<script lang="ts">
	import { onDestroy, onMount, tick } from 'svelte';
	import { goto } from '$app/navigation';
	import { base } from '$app/paths';
	import ImageEditorPane from '$lib/components/ImageEditorPane.svelte';
	import { ProjectEditor } from '$lib/domain/editor';
	import { findImageByRole } from '$lib/domain/project';
	import type { ImageAsset } from '$lib/domain/project';
	import type { DecodeImageFile, HashBytes } from '$lib/imageIntake';
	import { intakeImageFile } from '$lib/imageIntake';
	import { readAnnotationDraft, saveAnnotationDraft } from '$lib/annotationDraft';
	import type { DownloadBlob } from '$lib/persistence';
	import {
		retainEditor,
		takeRetainedEditor,
		consumePendingHandoff,
		getPendingHandoff,
		subscribePendingHandoff,
		setPendingAnnotatedRound,
		setPendingCourseBadges
	} from '$lib/session';
	import type { PendingHandoff, LabeledPoint } from '$lib/session';
	import { importHandoffImage } from '$lib/handoffImport';
	import { annotatedSourceImageFromAsset, createAnnotatedRound } from '$lib/domain/annotatedRound';
	import type { AnnotatedHole } from '$lib/domain/annotatedRound';
	import type { HoleNumberBadgeAnchor } from '$lib/domain/project';
	import {
		applyLibraryEntry,
		badgesToLabeledPoints,
		findFuzzyMatches,
		getDefaultCourseLibraryStore,
		previewUpsertCourse,
		toLibraryHoles,
		upsertCourse
	} from '$lib/courseLibrary';
	import type { CourseLibraryEntry, CourseLibraryStore } from '$lib/courseLibrary';
	import type { SignatureMatchResult } from '$lib/courseSignature';
	import { clampPointToImageBounds, imageToScreen, screenToImage } from '$lib/coords';
	import type { ScreenSpacePoint, ViewTransformState } from '$lib/coords';
	import { clickSlopPx } from '$lib/viewport.svelte';
	import { isEditableTarget } from '$lib/pointSelection';
	import { dialogKeyboard, isModalOpen } from '$lib/focusManagement';
	import {
		addHole,
		addHoleWithNumber,
		assignCandidateToHole,
		clearBends,
		moveBasket,
		moveCorridorBend,
		moveShot,
		moveTee,
		nextHoleNumber,
		placeByMode,
		reassignMarker,
		removeBasket,
		removeCorridorBend,
		removeLastBend,
		removeLastShot,
		removeShot,
		removeTee,
		setAllCorridorWidths,
		setCorridorWidth
	} from '$lib/holeAnnotation';
	import { getHoleBarIndicators, getHoleBarLabel } from '$lib/holeBar';
	import type { HolePlacementMode } from '$lib/holeAnnotation';
	import RadialMenu from '$lib/components/RadialMenu.svelte';
	import type { RadialMenuAction } from '$lib/components/RadialMenu.svelte';
	import {
		deriveCorridorBand,
		deriveCorridorCenterline,
		DEFAULT_CORRIDOR_WIDTH_PX
	} from '$lib/corridor';
	import {
		detectCourseCandidates,
		prewarmBasketDetection,
		requestLocalSnap
	} from '$lib/autoAnnotation/basketDetection';
	import type {
		CourseDetectionProgressStage,
		CourseDetectionResult
	} from '$lib/autoAnnotation/basketDetection';
	import {
		groundTruthMatchesImage,
		IMG_5641_GROUND_TRUTH,
		mergeCourseGroundTruth
	} from '$lib/autoAnnotation/courseGroundTruth';
	import type { LocalSnapKind } from '$lib/cv/localSnap';
	import { acceptCandidate } from '$lib/cv/types';
	import { addWalkPoint, moveWalkPoint, removeWalkPoint } from '$lib/walkingPath';
	import type { SourcePoint } from '$lib/domain/project';
	import {
		registerAnnotationNav,
		unregisterAnnotationNav,
		updateAnnotationNav
	} from '$lib/annotationNav.svelte';

	/** The two annotation activities this route now separates: course geometry (once per course/layout) vs. round-specific throws and walk path (once per round). */
	type AnnotationMode = 'map' | 'round';

	/** A point kind offered by the radial menu, either a hole-scoped placement mode or the round-level walk path. */
	type PointKind = HolePlacementMode | 'walk';

	/** Shared label text for a point kind, reused by both the radial menu's buttons and the hole bar. */
	const POINT_KIND_LABELS: Record<PointKind, string> = {
		tee: 'Tee',
		basket: 'Basket',
		shot: 'Shot landing',
		bend: 'Corridor bend',
		walk: 'Walk path'
	};
	const POINT_KIND_ICONS: Record<PointKind, string> = {
		tee: 'T',
		basket: 'B',
		shot: '+',
		bend: '↯',
		walk: 'W'
	};

	/** A radial-menu action either places a point kind or deletes the marker that opened the menu. */
	type RadialAction = PointKind | 'delete';

	const SIDEBAR_FOCUS_ZOOM_MULTIPLIER = 2.5;
	const MARKER_HIT_RADIUS_PX = 12;

	type AnnotationMarkerKind = PointKind;

	interface AnnotationMarkerHit {
		/** Null for a `walk` marker — the walking path is round-level, not scoped to any hole. */
		holeId: string | null;
		kind: AnnotationMarkerKind;
		index?: number;
		shotId?: string;
	}

	interface AnnotationDragGesture {
		marker: AnnotationMarkerHit;
		start: ScreenSpacePoint;
		transform: ViewTransformState;
		dragging: boolean;
	}

	/**
	 * An open radial menu, anchored at an image-space point. `hitMarker` set
	 * means the menu was opened on an existing point (offers Delete only);
	 * unset means it was opened on empty space (offers the point kinds not yet
	 * placed on `holeId`).
	 */
	interface RadialMenuState {
		at: { xPx: number; yPx: number };
		/** Null in round mode when opened with no hole active — only the `walk` wedge is offered then. */
		holeId: string | null;
		hitMarker: AnnotationMarkerHit | null;
	}

	/**
	 * The correction chip open on a placed tee/basket marker, anchored at its
	 * current point. Opened by a non-dragging click on ANY tee/basket marker
	 * at any time — never proximity-gated to the active hole or to any other
	 * marker, since a mislabeled marker can already be sitting exactly where
	 * it belongs and only needs a different hole number, not a nudge.
	 */
	interface MarkerChipState {
		readonly holeId: string;
		readonly holeNumber: number;
		readonly kind: 'tee' | 'basket';
		readonly point: SourcePoint;
	}

	interface Props {
		editor?: ProjectEditor;
		decode?: DecodeImageFile;
		hash?: HashBytes;
		download?: DownloadBlob;
		courseLibraryStore?: CourseLibraryStore;
	}

	let {
		editor: initialEditor,
		decode,
		hash,
		download,
		courseLibraryStore: initialCourseLibraryStore
	}: Props = $props();

	// An explicitly injected store (tests) wins; otherwise every page instance
	// shares one real IndexedDB connection via the module-level singleton in
	// courseLibrary.ts, matching how smartStitchWorker is shared elsewhere.
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
	let annotationNavRegistration = $state<number | null>(null);

	function resolveInitialEditor(): ProjectEditor {
		// An explicitly injected editor (tests) wins; otherwise reuse the retained
		// in-memory session across SPA navigation, or start a fresh project.
		return initialEditor ?? takeRetainedEditor('annotate-round') ?? new ProjectEditor();
	}

	onDestroy(() => {
		stopCourseDetectionProgress();
		if (annotationNavRegistration !== null) {
			unregisterAnnotationNav(annotationNavRegistration);
			annotationNavRegistration = null;
		}
		if (participatesInSession) retainEditor('annotate-round', editor);
	});

	let refreshCount = $state(0);

	function sourceImage(): ImageAsset | null {
		void refreshCount;
		return findImageByRole(editor.state.images, 'source-overview') ?? null;
	}

	/**
	 * Hole annotation draft. Manual placement and basket CV proposals are both
	 * transient until the user applies them, but every placed point is synced
	 * into the `ProjectEditor` below (`setHoles`) so it survives a Save draft,
	 * an undo/redo, and a retained cross-navigation session. Hydrated from the
	 * editor on init so a retained or explicitly-injected editor's holes are
	 * never dropped. Cleared whenever the source image is replaced, since
	 * existing points are coordinates into a specific raster and make no sense
	 * against a different one.
	 */
	// svelte-ignore state_referenced_locally
	let holes = $state<AnnotatedHole[]>(editor.state.holes);
	/**
	 * Which of the two annotation activities the toolbar and radial menu are
	 * scoped to right now — 'map' (course geometry: tee/basket/bend, once per
	 * course) or 'round' (throws and walk path, once per round). Defaults to
	 * 'map' since a fresh source image needs its geometry established first.
	 */
	let annotationMode = $state<AnnotationMode>('map');
	/**
	 * UDisc's purple walking route as one open polyline spanning the whole
	 * round — round-level, not scoped to any hole. Cleared on the same
	 * source-image-replacement lifecycle as `holes`.
	 */
	let walkingPath = $state<SourcePoint[]>([]);
	/**
	 * Whether "Import saved holes" (Course Memory) has been applied this
	 * session. Together with `mapGeometryEdited` this tells Done whether the
	 * current map geometry is still exactly what the library already knows
	 * (skip the write) or has since been hand-edited (worth previewing/saving).
	 */
	let importedLibraryEntryThisSession = $state(false);
	/**
	 * Set false whenever a library entry is imported, true by any subsequent
	 * Map-mode geometry mutation (tee/basket/bend place-move-delete, corridor
	 * width). Round-mode actions (shots, walk path) never touch this — they
	 * don't change the course geometry Course Memory stores.
	 */
	let mapGeometryEdited = $state(false);
	/**
	 * Hole-number badge and basket positions keyed by resolved hole number,
	 * captured from `handleDetectCourse`'s grammar result for course-shape
	 * signature use (Course Memory) — never authoritative like `holes`, and
	 * cleared on the same source-image-replacement lifecycle. Captured
	 * regardless of a proposal's `status`: badge assignment (courseGrammar's
	 * Stage 1) succeeds independently of tee/basket, so an "incomplete" hole
	 * can still contribute a good badge point to the signature.
	 */
	let numberBadges = $state<HoleNumberBadgeAnchor[]>([]);
	let labeledBaskets = $state<LabeledPoint[]>([]);
	let activeHoleId = $state<string | null>(null);
	/** Bumped on every sidebar hole click so `sidebarFocusRequest` gets a fresh key even when the target point hasn't moved (re-clicking the same hole re-jumps the camera). */
	let sidebarFocusTick = $state(0);
	let markerChip = $state<MarkerChipState | null>(null);
	let markerChipReassignInput = $state('');
	let savingCourseToMemory = $state(false);
	let savedCourseToMemory = $state(false);
	let courseDetectionError = $state<string | null>(null);
	let courseDetection = $state<CourseDetectionResult | null>(null);
	let courseDetectionRunning = $state(false);
	let courseDetectionStatus = $state<string | null>(null);
	let courseDetectionElapsedSeconds = $state(0);
	let courseDetectionStartedAt = 0;
	let courseDetectionTimer: ReturnType<typeof setInterval> | null = null;
	let minAutoSuggestScore = $state(0.6);
	/**
	 * Whether `minAutoSuggestScore` actually filters which detected tee/basket
	 * pieces get auto-applied onto holes (see `applyDetectedPieces`), or is
	 * purely informational. Deliberately NOT stored on `AnnotatedHole` or
	 * `CourseHoleProposal` — this is a session-only review-UI knob, not
	 * detector output.
	 */
	let applyDetectionThreshold = $state(true);
	/**
	 * Session-only per-piece approval, keyed by `${holeId}:${kind}`
	 * (`pieceStatusKey`). This is the sidebar's "confirmed" bit for the
	 * 5-section hole grid (`sectionOfHole`) — deliberately NOT a field on
	 * `AnnotatedHole`: `annotatedRound.ts`'s provenance rule forbids any
	 * provisional/confidence/status flag from ever reaching that artifact, so
	 * this lives entirely outside the domain type. Cleared on the same
	 * source-image-replacement lifecycle as the rest of this section's state
	 * (`handleSourceDomainChanged`).
	 */
	let confirmedPieces = $state<Set<string>>(new Set());
	let prewarmedSourceId: string | null = null;
	let autoDetectedSourceId: string | null = null;
	/**
	 * A course recognized in the local library (Course Memory), surfaced as a
	 * confirm/dismiss banner — never auto-imported. Recognition is attempted
	 * at most once per source image via `recognizedSourceId`, mirroring
	 * `autoDetectedSourceId`'s once-per-image guard.
	 */
	let recognizedMatch = $state<{ entry: CourseLibraryEntry; match: SignatureMatchResult } | null>(null);
	let recognizedSourceId: string | null = null;
	let applyingRecognizedMatch = $state(false);
	let annotationDrag = $state<AnnotationDragGesture | null>(null);
	let numberSelectDrag = $state<{ label: number; start: ScreenSpacePoint; dragging: boolean } | null>(null);
	let radialMenu = $state<RadialMenuState | null>(null);
	let markerChipEl = $state<HTMLDivElement | null>(null);
	/**
	 * Off by default. Tee/basket placement and correction now go through the
	 * sidebar-driven placing flow and the marker chip unconditionally — this
	 * toggle only still gates the RadialMenu's remaining uses (corridor bends
	 * in Map mode, shots/walk path in Round mode), which stay a hand-placement
	 * nicety rather than the primary flow. Toggled via the footer control at
	 * the bottom of the page.
	 */
	let radialMenuEnabled = $state(false);

	/** Single gate for every place the radial menu can open (empty-space placement and the on-marker delete menu) so `radialMenuEnabled` only needs checking here. */
	function openRadialMenu(state: RadialMenuState): void {
		if (!radialMenuEnabled) return;
		radialMenu = state;
	}
	/**
	 * Snap-to-detection (design point 5, optimistic placement): keys of
	 * `${kind}:${holeId}` markers whose most recent placement/release is still
	 * waiting on a local-snap reply. Tracked so a reply that arrives after the
	 * marker has moved on (deleted, moved again, hole gone) is recognized as
	 * stale and dropped instead of clobbering newer state — see
	 * `applyLocalSnap`/`settleLocalSnap`.
	 */
	let pendingLocalSnaps = new Map<string, number>();
	let localSnapRequestSequence = 0;
	/**
	 * Markers currently mid-settle from a raw click to a snapped point (design
	 * point 4): carries the `.settling` class, whose CSS transition is what
	 * actually animates `cx`/`cy`. Never populated under
	 * `prefers-reduced-motion: reduce` — the marker jumps straight to the
	 * snapped point instead, `today's exact behavior` for that preference,
	 * matching every other motion decision on this page.
	 */
	let settlingMarkerKeys = $state<ReadonlySet<string>>(new Set());
	let previewHoles = $state<AnnotatedHole[] | null>(null);
	let visibleHoles = $derived(previewHoles ?? holes);
	let previewWalkingPath = $state<SourcePoint[] | null>(null);
	let visibleWalkingPath = $derived(previewWalkingPath ?? walkingPath);

	/**
	 * An empty-space placement menu is tied to whichever hole was active when
	 * it opened (`handleAnnotationPlacement` stamps `holeId: activeHoleId`) —
	 * if the user switches holes without dismissing it first, choosing an
	 * action would otherwise silently place the point on the stale hole
	 * instead of the one now showing as active. A marker's delete menu has no
	 * such tie (you can click any hole's marker regardless of which hole is
	 * active), so it's deliberately left alone here.
	 */
	$effect(() => {
		if (radialMenu && radialMenu.hitMarker === null && radialMenu.holeId !== activeHoleId) {
			radialMenu = null;
		}
	});

	/**
	 * A pointerdown anywhere outside the open marker chip dismisses it without
	 * acting — the same click-outside contract `RadialMenu.svelte` implements
	 * for itself, reproduced here because this chip is a plain page-owned
	 * popover, not a component with its own lifecycle.
	 */
	$effect(() => {
		if (!markerChip) return;
		function handlePointerDown(event: PointerEvent): void {
			if (markerChipEl && event.target instanceof Node && !markerChipEl.contains(event.target)) {
				markerChip = null;
			}
		}
		window.addEventListener('pointerdown', handlePointerDown);
		return () => window.removeEventListener('pointerdown', handlePointerDown);
	});

	/** Off by default -- "Assign ground truth" only ever does anything for one internal QA fixture (courseGroundTruth.ts), so it stays hidden from the general annotation UI until switched on via the toggle at the bottom of the page. */
	let groundTruthToolsEnabled = $state(false);

	/** The compact status-strip's current stage, mirrored from the worker's real progress messages (never simulated). */
	let courseDetectionStage = $state<CourseDetectionProgressStage | null>(null);

	const DIAGNOSTICS_RAIL_STORAGE_KEY = 'chainspot.diagnosticsRail';

	function readStoredDiagnosticsRailExpanded(): boolean {
		if (typeof localStorage === 'undefined') return true;
		try {
			const stored = localStorage.getItem(DIAGNOSTICS_RAIL_STORAGE_KEY);
			return stored === null ? true : stored === 'expanded';
		} catch {
			return true;
		}
	}
	let diagnosticsRailExpanded = $state(readStoredDiagnosticsRailExpanded());

	function toggleDiagnosticsRail(): void {
		diagnosticsRailExpanded = !diagnosticsRailExpanded;
		try {
			localStorage.setItem(DIAGNOSTICS_RAIL_STORAGE_KEY, diagnosticsRailExpanded ? 'expanded' : 'collapsed');
		} catch {
			// Best-effort persistence only; the toggle still works for this session.
		}
	}

	type DiagnosticFeatureState = 'attention' | 'live' | 'clear' | 'waiting';

	interface DiagnosticFeature {
		readonly id: 'review' | 'numbers' | 'tees' | 'baskets';
		readonly label: string;
		readonly summary: string;
		readonly detail: string;
		readonly state: DiagnosticFeatureState;
		readonly priority: number;
	}

	/**
	 * The diagnostics rail is a live review queue, not a second dump of worker
	 * internals. These rows intentionally derive from detection and draft state
	 * so the future ranked-marking list has one stable surface to update as the
	 * user accepts or corrects individual features.
	 */
	const liveDiagnosticFeatures = $derived.by((): DiagnosticFeature[] => {
		const grammarHoles = courseDetection?.grammar.holes ?? [];
		const targetNumbers =
			grammarHoles.length > 0 ? grammarHoles.map((hole) => hole.number) : holes.map((hole) => hole.number);
		const targetCount = targetNumbers.length;
		const mappedHoles = targetNumbers
			.map((number) => holes.find((hole) => hole.number === number))
			.filter((hole): hole is AnnotatedHole => hole !== undefined);
		const placedTees = mappedHoles.filter((hole) => hole.tee !== undefined).length;
		const placedBaskets = mappedHoles.filter((hole) => hole.basket !== undefined).length;
		const unresolvedReviewCount = grammarHoles.filter((proposal) => {
			if (proposal.status === 'ready') return false;
			const mapped = holes.find((hole) => hole.number === proposal.number);
			return mapped?.tee === undefined || mapped.basket === undefined;
		}).length;
		const assignedNumbers = courseDetection
			? courseDetection.numberDetection.candidates.filter((candidate) => candidate.label !== undefined).length
			: numberBadges.length;
		const numberCandidateCount = courseDetection?.numberDetection.candidates.length ?? numberBadges.length;
		const teeCandidateCount = courseDetection?.tees.length ?? 0;
		const basketCandidateCount = courseDetection?.baskets.length ?? 0;
		const detectionInProgress = courseDetectionRunning;
		const hasDetection = courseDetection !== null;

		const features: DiagnosticFeature[] = [
			{
				id: 'review',
				label: 'Review queue',
				summary: detectionInProgress
					? 'Updating from live detection'
					: hasDetection
						? `${unresolvedReviewCount} holes need review · ${Math.max(grammarHoles.length - unresolvedReviewCount, 0)} ready`
						: 'Waiting for course detection',
				detail:
					unresolvedReviewCount > 0
						? 'Start with the highest-impact unresolved hole.'
						: 'No unresolved hole geometry is queued.',
				state: detectionInProgress
					? 'live'
					: !hasDetection
						? 'waiting'
						: unresolvedReviewCount > 0
							? 'attention'
							: 'clear',
				priority: unresolvedReviewCount > 0 ? 100 + unresolvedReviewCount : 10
			},
			{
				id: 'numbers',
				label: 'Hole numbers',
				summary:
					numberCandidateCount > 0
						? `${assignedNumbers}/${numberCandidateCount} labels assigned`
						: 'Waiting for badge candidates',
				detail:
					numberCandidateCount > assignedNumbers
						? `${numberCandidateCount - assignedNumbers} candidate${numberCandidateCount - assignedNumbers === 1 ? '' : 's'} still need a safe match.`
						: 'All detected badges have a label.',
				state: detectionInProgress
					? 'live'
					: numberCandidateCount === 0
						? 'waiting'
						: assignedNumbers < numberCandidateCount
							? 'attention'
							: 'clear',
				priority: numberCandidateCount > assignedNumbers ? 80 + numberCandidateCount - assignedNumbers : 8
			},
			{
				id: 'tees',
				label: 'Tee pads',
				summary:
					targetCount > 0
						? `${placedTees}/${targetCount} marked`
						: teeCandidateCount > 0
							? `${teeCandidateCount} candidates found`
							: 'Waiting for tee candidates',
				detail:
					targetCount > placedTees
						? `${targetCount - placedTees} tee${targetCount - placedTees === 1 ? '' : 's'} remain to mark.`
						: 'Every detected hole has a tee in the draft.',
				state: detectionInProgress
					? 'live'
					: targetCount === 0
						? 'waiting'
						: placedTees < targetCount
							? 'attention'
							: 'clear',
				priority: targetCount > placedTees ? 60 + targetCount - placedTees : 6
			},
			{
				id: 'baskets',
				label: 'Baskets',
				summary:
					targetCount > 0
						? `${placedBaskets}/${targetCount} marked`
						: basketCandidateCount > 0
							? `${basketCandidateCount} candidates found`
							: 'Waiting for basket candidates',
				detail:
					targetCount > placedBaskets
						? `${targetCount - placedBaskets} basket${targetCount - placedBaskets === 1 ? '' : 's'} remain to mark.`
						: 'Every detected hole has a basket in the draft.',
				state: detectionInProgress
					? 'live'
					: targetCount === 0
						? 'waiting'
						: placedBaskets < targetCount
							? 'attention'
							: 'clear',
				priority: targetCount > placedBaskets ? 50 + targetCount - placedBaskets : 5
			}
		];
		return features.sort((left, right) => right.priority - left.priority);
	});

	function activeHole(): AnnotatedHole | null {
		return holes.find((hole) => hole.id === activeHoleId) ?? null;
	}

	/** Switches the annotation activity; closes any open radial menu since its wedge set is mode-scoped. */
	function setAnnotationMode(mode: AnnotationMode): void {
		if (annotationMode === mode) return;
		annotationMode = mode;
		radialMenu = null;
	}

	/** Marks the map (course-geometry) side of the draft as diverged from whatever library entry was last imported. */
	function markMapGeometryEdited(): void {
		mapGeometryEdited = true;
	}

	/** tee/basket/bend are course geometry (Map mode); shot/walk are round-specific and never mark the draft as geometry-edited. */
	function isMapGeometryKind(kind: PointKind): boolean {
		return kind === 'tee' || kind === 'basket' || kind === 'bend';
	}

	function pieceStatusKey(holeId: string, kind: 'tee' | 'basket'): string {
		return `${holeId}:${kind}`;
	}

	function isPieceConfirmed(holeId: string, kind: 'tee' | 'basket'): boolean {
		return confirmedPieces.has(pieceStatusKey(holeId, kind));
	}

	/** Every mutation replaces the Set so `$state` sees a new reference — matches every other collection-valued state on this page (`activeReviewConfirmedCandidateIds`, `settlingMarkerKeys`). */
	function setPieceConfirmed(holeId: string, kind: 'tee' | 'basket', confirmed: boolean): void {
		const key = pieceStatusKey(holeId, kind);
		if (confirmed === confirmedPieces.has(key)) return;
		const next = new Set(confirmedPieces);
		if (confirmed) next.add(key);
		else next.delete(key);
		confirmedPieces = next;
	}

	const SIDEBAR_SECTION_LABELS: Record<1 | 2 | 3 | 4 | 5, string> = {
		1: 'No tee or basket',
		2: 'Has basket only',
		3: 'Has tee only',
		4: 'Has both — unconfirmed',
		5: 'Has both — confirmed'
	};

	/**
	 * The sidebar hole grid's five sections, derived purely from what data
	 * exists on the hole plus its per-piece confirmed status — no separate
	 * status flag beyond tee/basket presence and `confirmedPieces`:
	 *   1. no tee, no basket
	 *   2. basket only
	 *   3. tee only
	 *   4. both, but not both confirmed
	 *   5. both, confirmed
	 */
	function sectionOfHole(hole: AnnotatedHole): 1 | 2 | 3 | 4 | 5 {
		const hasTee = hole.tee !== undefined;
		const hasBasket = hole.basket !== undefined;
		if (!hasTee && !hasBasket) return 1;
		if (hasBasket && !hasTee) return 2;
		if (hasTee && !hasBasket) return 3;
		const confirmed = isPieceConfirmed(hole.id, 'tee') && isPieceConfirmed(hole.id, 'basket');
		return confirmed ? 5 : 4;
	}

	/**
	 * Moves a tee/basket from `fromHoleId` to `toHoleId` — the marker-chip
	 * "reassign to hole" action. A correction always drops back to pending,
	 * even if the point was confirmed at its old hole (a re-homed marker
	 * hasn't been looked at *in its new place* yet) and even if it silently
	 * overwrote an existing confirmed point on the target (that point is a
	 * different physical marker now).
	 */
	function reassignHolePiece(fromHoleId: string, toHoleId: string, kind: 'tee' | 'basket'): void {
		if (fromHoleId === toHoleId) return;
		const next = reassignMarker(holes, fromHoleId, toHoleId, kind);
		if (next === holes) return;
		holes = next;
		setPieceConfirmed(fromHoleId, kind, false);
		setPieceConfirmed(toHoleId, kind, false);
		markMapGeometryEdited();
	}

	/** Deletes a tee/basket entirely — the marker chip's "not a real tee/basket" action. Clears confirmed status along with the data; nothing is left behind for a future piece at this hole to inherit. */
	function deleteHolePiece(holeId: string, kind: 'tee' | 'basket'): void {
		holes = kind === 'tee' ? removeTee(holes, holeId) : removeBasket(holes, holeId);
		setPieceConfirmed(holeId, kind, false);
		markMapGeometryEdited();
	}

	/** Approves both pieces on a hole at once — the sidebar's Approve action for a section-4 hole. No-op unless both are already placed. */
	function approveHolePieces(holeId: string): void {
		const hole = holes.find((candidate) => candidate.id === holeId);
		if (!hole?.tee || !hole.basket) return;
		setPieceConfirmed(holeId, 'tee', true);
		setPieceConfirmed(holeId, 'basket', true);
	}

	function startCourseDetectionProgress(): void {
		if (courseDetectionTimer !== null) clearInterval(courseDetectionTimer);
		courseDetectionStartedAt = Date.now();
		courseDetectionElapsedSeconds = 0;
		courseDetectionStatus = 'Preparing image for the CV worker…';
		courseDetectionTimer = setInterval(() => {
			courseDetectionElapsedSeconds = Math.floor((Date.now() - courseDetectionStartedAt) / 1000);
		}, 250);
	}

	function stopCourseDetectionProgress(): void {
		if (courseDetectionStartedAt > 0) {
			courseDetectionElapsedSeconds = Math.floor((Date.now() - courseDetectionStartedAt) / 1000);
		}
		if (courseDetectionTimer !== null) {
			clearInterval(courseDetectionTimer);
			courseDetectionTimer = null;
		}
	}

	/**
	 * Compact copy for the status strip near the map (PART A) — a handful of
	 * plain phrases keyed to the worker's real stage boundaries, reported by
	 * `detectCourse` in `basketDetection.worker.ts` in its actual execution
	 * order: numbers, then baskets, then tees, then grammar. `'opencv'` and
	 * `'templates'` are real too (loading the WASM runtime and the template
	 * pack before any detector runs) but have no dedicated phrase of their
	 * own — bucketed under the first, since nothing user-facing distinguishes
	 * "loading" from "about to read numbers" at this level of compactness.
	 * The detailed per-stage message (`courseDetectionStatus`) keeps showing
	 * the fuller text in the diagnostics rail, unchanged.
	 */
	function compactDetectionStageCopy(stage: CourseDetectionProgressStage | null): string {
		switch (stage) {
			case 'opencv':
			case 'templates':
			case 'numbers':
				return 'Reading hole numbers…';
			case 'baskets':
				return 'Locating baskets…';
			case 'tees':
				return 'Finding tee pads…';
			case 'grammar':
				return 'Assembling course…';
			default:
				return 'Preparing image for detection…';
		}
	}

	function prefersReducedMotion(): boolean {
		if (typeof matchMedia !== 'function') return false;
		try {
			return matchMedia('(prefers-reduced-motion: reduce)').matches;
		} catch {
			// A test/harness environment without a real matchMedia implementation
			// behaves like "no preference", i.e. full motion.
			return false;
		}
	}

	/**
	 * Applies every tee/basket the grammar proposed, per piece rather than
	 * requiring both and a `ready` status — the sidebar's five sections are
	 * the review gate now, not the grammar's own confidence bucket. A piece
	 * is skipped when `applyDetectionThreshold` is on and its confidence
	 * falls under `minAutoSuggestScore` (never created at all, so that hole
	 * simply stays in a less-complete section until placed by hand or the
	 * threshold is lowered), and — with `skipExisting: true` — whenever the
	 * hole already has a piece of that kind, so a manual placement or a prior
	 * correction is never silently clobbered by a re-run.
	 */
	function applyDetectedPieces(options: { skipExisting?: boolean } = {}): void {
		if (!courseDetection) return;
		const inheritedWidthPx = currentCorridorWidthPx();
		const existingByNumber = new Map(holes.map((hole) => [hole.number, hole]));
		const meetsThreshold = (confidence: number): boolean =>
			!applyDetectionThreshold || confidence >= minAutoSuggestScore;

		for (const proposal of courseDetection.grammar.holes) {
			const existing = existingByNumber.get(proposal.number);
			const keepTee = options.skipExisting && existing?.tee;
			const keepBasket = options.skipExisting && existing?.basket;
			const applyTee = !keepTee && proposal.tee && meetsThreshold(proposal.tee.confidence);
			const applyBasket = !keepBasket && proposal.basket && meetsThreshold(proposal.basket.confidence);
			if (!applyTee && !applyBasket) continue;

			const base = existing ?? {
				id: crypto.randomUUID(),
				number: proposal.number,
				shots: [],
				corridorBends: [],
				corridorWidthPx: inheritedWidthPx
			};
			const next: AnnotatedHole = {
				...base,
				tee: applyTee ? acceptCandidate(proposal.tee!) : base.tee,
				basket: applyBasket ? acceptCandidate(proposal.basket!) : base.basket
			};
			existingByNumber.set(proposal.number, next);
		}
		holes = [...existingByNumber.values()].sort((a, b) => a.number - b.number);
		activeHoleId = activeHoleId ?? holes[0]?.id ?? null;
	}

	/** The slim sidebar row's slider — re-applies detection with the new floor so raising/lowering it live-updates which sections holes fall into. */
	function handleMinAutoSuggestScoreInput(event: Event): void {
		const input = event.currentTarget;
		if (!(input instanceof HTMLInputElement)) return;
		minAutoSuggestScore = Number(input.value);
		applyDetectedPieces({ skipExisting: true });
	}

	/** The slim sidebar row's "only above threshold" toggle. */
	function handleApplyDetectionThresholdToggle(): void {
		applyDetectionThreshold = !applyDetectionThreshold;
		applyDetectedPieces({ skipExisting: true });
	}

	// OpenCV's embedded WASM payload is large. Start its reusable worker as soon
	// as a source image exists so Detect baskets does not pay the cold-load cost.
	$effect(() => {
		void refreshCount;
		const image = sourceImage();
		if (!image || image.id === prewarmedSourceId || typeof Worker === 'undefined') return;
		prewarmedSourceId = image.id;
		void prewarmBasketDetection().catch(() => {
			// Detection still reports a useful error if the user explicitly runs it.
			// A speculative warm-up failure should not alarm or block manual annotation.
		});
	});

	/**
	 * Every source image gets run through full-course detection automatically
	 * — there is no manual "Detect" button anymore. `handleDetectCourse`
	 * itself applies every resulting tee/basket onto `holes` (as pending) via
	 * `applyDetectedPieces`, with `skipExisting: true` so a hand-placed or
	 * already-corrected piece is never clobbered by a re-run.
	 */
	$effect(() => {
		void refreshCount;
		const image = sourceImage();
		if (!image || image.id === autoDetectedSourceId || typeof Worker === 'undefined') return;
		autoDetectedSourceId = image.id;
		void handleDetectCourse();
	});

	/**
	 * Mirrors the local hole-annotation draft into the `ProjectEditor`'s
	 * durable `ProjectState` on every change, so Save (and the retained
	 * cross-navigation session) always reflect the latest hand-placed
	 * points. `setHoles` no-ops when the snapshot is unchanged, so hydrating
	 * `holes` from `editor.state.holes` above never creates a spurious
	 * history entry or dirty flag on mount. Guarded on `sourceImage()`
	 * because "Add hole" is reachable before an image loads (an empty draft
	 * hole with no points), and `setHoles` rejects a non-empty hole list with
	 * no source image loaded; the sync resumes as soon as the image lands.
	 */
	$effect(() => {
		if (!sourceImage() && holes.length > 0) return;
		editor.setHoles(holes);
	});

	/**
	 * The width a newly created hole should inherit — the active hole's width,
	 * so the new hole matches its siblings instead of always starting at the
	 * bare default. Falls back to the default when there's no active hole yet
	 * (the very first hole on a fresh round).
	 */
	function currentCorridorWidthPx(): number {
		const active = holes.find((hole) => hole.id === activeHoleId);
		return active?.corridorWidthPx ?? DEFAULT_CORRIDOR_WIDTH_PX;
	}

	function handleAddHole(): void {
		const inheritedWidthPx = currentCorridorWidthPx();
		const nextHoles = addHole(holes);
		if (nextHoles.length === holes.length) return;
		const addedHole = nextHoles.find((hole) => !holes.some((existing) => existing.id === hole.id));
		holes = addedHole ? setCorridorWidth(nextHoles, addedHole.id, inheritedWidthPx) : nextHoles;
		activeHoleId = addedHole?.id ?? activeHoleId;
	}

	function isShortcutEditableTarget(target: EventTarget | null): boolean {
		if (target instanceof HTMLInputElement && (target.type === 'radio' || target.type === 'checkbox')) {
			return false;
		}
		return isEditableTarget(target);
	}

	function handleAnnotationKeyDown(event: KeyboardEvent): void {
		// Backstop only: RadialMenu.svelte owns Escape while focus is inside it
		// (closing itself and returning focus to the viewport). Focus is always
		// moved into the menu on open, so this branch is normally never reached
		// — it exists for the case that DOM focus wandered out from under the
		// open menu by some path this file doesn't control.
		if (event.key === 'Escape' && radialMenu) {
			event.preventDefault();
			closeRadialMenu(radialMenu, 'escape');
			return;
		}
		if (event.key === 'Escape' && markerChip) {
			event.preventDefault();
			markerChip = null;
			return;
		}
		if (isModalOpen()) return;
		if (isShortcutEditableTarget(event.target)) return;

		if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey) {
			const modifierKey = event.key.toLowerCase();
			if (modifierKey === 's') {
				event.preventDefault();
				if (!saving && !event.repeat) handleSave();
			} else if (modifierKey === 'o') {
				event.preventDefault();
				if (!openLoading && !event.repeat) openDraftInput?.click();
			}
			return;
		}
		if (event.ctrlKey || event.metaKey || event.altKey || event.repeat) return;

		const key = event.key.toLowerCase();
		if (key === 'a' || key === 'n') {
			if (nextHoleNumber(holes) === null) return;
			event.preventDefault();
			handleAddHole();
			return;
		}
	}

	function handleRemoveLastShot(): void {
		if (!activeHoleId) return;
		holes = removeLastShot(holes, activeHoleId);
	}

	function handleRemoveLastBend(): void {
		if (!activeHoleId) return;
		holes = removeLastBend(holes, activeHoleId);
		markMapGeometryEdited();
	}

	function handleClearBends(): void {
		if (!activeHoleId) return;
		holes = clearBends(holes, activeHoleId);
		markMapGeometryEdited();
	}

	/**
	 * Applies to every hole, not just the active one: UDisc renders a course's
	 * corridor ribbon at one width across the whole map, so that's the default
	 * here too — the domain stays per-hole capable (`setCorridorWidth` is still
	 * exported), this control just drives the bulk operation now. The input
	 * still displays the active hole's width, which is equivalent once every
	 * hole shares one value; holes that arrive with mixed widths (an older
	 * saved project, or an unadjusted Course Memory import) show the active
	 * hole's value until the first adjustment here unifies them, which is the
	 * intended behavior.
	 */
	function handleCorridorWidthChange(event: Event): void {
		if (!activeHoleId) return;
		const input = event.currentTarget as HTMLInputElement;
		const corridorWidthPx = Number(input.value);
		if (!Number.isFinite(corridorWidthPx) || corridorWidthPx <= 0) return;
		holes = setAllCorridorWidths(holes, corridorWidthPx);
		markMapGeometryEdited();
	}

	/**
	 * Only markers interactive in the current mode are hit-tested: map mode
	 * scopes to tee/basket/bend, round mode to shot/walk — matching which
	 * wedges `radialMenuActions` offers. Every marker still renders in both
	 * modes for context; this is what keeps the *other* mode's markers
	 * unclickable so mode switches don't leak drag/delete across activities.
	 */
	function pointHitAt(pointer: ScreenSpacePoint, view: ViewTransformState): AnnotationMarkerHit | null {
		let closestMarker: AnnotationMarkerHit | null = null;
		let closestDistance = Number.POSITIVE_INFINITY;

		function consider(
			holeId: string | null,
			kind: AnnotationMarkerKind,
			point: { xPx: number; yPx: number },
			index?: number,
			shotId?: string
		): void {
			const screen = imageToScreen(point, view);
			const distance = Math.hypot(pointer.x - screen.x, pointer.y - screen.y);
			if (distance > MARKER_HIT_RADIUS_PX || distance >= closestDistance) return;
			closestDistance = distance;
			closestMarker = { holeId, kind, index, shotId };
		}

		if (annotationMode === 'map') {
			for (const hole of holes) {
				if (hole.tee) consider(hole.id, 'tee', hole.tee);
				if (hole.basket) consider(hole.id, 'basket', hole.basket);
				for (const [index, bend] of hole.corridorBends.entries()) {
					consider(hole.id, 'bend', bend, index);
				}
			}
		} else {
			for (const hole of holes) {
				for (const [index, shot] of hole.shots.entries()) {
					consider(hole.id, 'shot', shot.landing, index, shot.id);
				}
			}
			for (const [index, point] of walkingPath.entries()) {
				consider(null, 'walk', point, index);
			}
		}

		return closestMarker;
	}

	/** Nearest detected, confidently-labeled hole-number badge under the pointer, if any. */
	function numberCandidateHitAt(pointer: ScreenSpacePoint, view: ViewTransformState): number | null {
		const candidates = courseDetection?.numberDetection.candidates ?? [];
		let closestLabel: number | null = null;
		let closestDistance = Number.POSITIVE_INFINITY;
		for (const candidate of candidates) {
			if (candidate.label === undefined) continue;
			const screen = imageToScreen({ xPx: candidate.xPx, yPx: candidate.yPx }, view);
			const distance = Math.hypot(pointer.x - screen.x, pointer.y - screen.y);
			const radius = Math.max(
				MARKER_HIT_RADIUS_PX,
				(Math.max(candidate.widthPx, candidate.heightPx) / 2) * view.zoom + 10
			);
			if (distance > radius || distance >= closestDistance) continue;
			closestDistance = distance;
			closestLabel = candidate.label;
		}
		return closestLabel;
	}

	/**
	 * Opens the correction chip for an existing tee/basket marker — the
	 * redesign's core correction affordance (requirement 5): clicking ANY
	 * placed tee/basket, at any time, regardless of what else is active or
	 * how close it is to anything else. There is deliberately no distance
	 * heuristic here at all: a mislabeled marker can already sit exactly
	 * where it belongs, just tagged with the wrong hole, so "how close is it"
	 * was never the right signal — the user identifies the error by looking
	 * at the marker and says which hole it really belongs to.
	 */
	function openMarkerChip(holeId: string, kind: 'tee' | 'basket'): void {
		const hole = holes.find((candidate) => candidate.id === holeId);
		const point = kind === 'tee' ? hole?.tee : hole?.basket;
		if (!hole || !point) return;
		markerChip = { holeId, holeNumber: hole.number, kind, point };
		markerChipReassignInput = '';
	}

	function closeMarkerChip(): void {
		markerChip = null;
	}

	/** The chip's "reassign to hole N" action, and the shortcut to reassign straight to whichever hole the sidebar currently has active. */
	function reassignFromChip(toHoleId: string): void {
		if (!markerChip) return;
		reassignHolePiece(markerChip.holeId, toHoleId, markerChip.kind);
		vibrate(8);
		closeMarkerChip();
	}

	/** Resolves the chip's free-typed hole-number input to a target hole, creating it in numeric order if the draft doesn't have it yet. */
	function reassignFromChipInput(): void {
		if (!markerChip) return;
		const target = Number(markerChipReassignInput);
		if (!Number.isInteger(target) || target < 1 || target > 999 || target === markerChip.holeNumber) {
			activityMessage = 'Enter a different hole number.';
			return;
		}
		const targetHole = activateHoleByNumber(target);
		if (!targetHole) return;
		reassignFromChip(targetHole.id);
	}

	/** The chip's "not a real tee/basket" delete action. */
	function deleteFromChip(): void {
		if (!markerChip) return;
		deleteHolePiece(markerChip.holeId, markerChip.kind);
		closeMarkerChip();
	}

	/** Activates a numbered hole, creating it in numeric order when the draft does not have it yet. */
	function activateHoleByNumber(number: number): AnnotatedHole | null {
		let target = holes.find((hole) => hole.number === number);
		if (target) {
			activeHoleId = target.id;
			return target;
		}
		const inheritedWidthPx = currentCorridorWidthPx();
		const nextHoles = addHoleWithNumber(holes, number);
		target = nextHoles.find((hole) => hole.number === number);
		if (!target) return null;
		holes = setCorridorWidth(nextHoles, target.id, inheritedWidthPx);
		activeHoleId = target.id;
		return target;
	}

	/** Selects the hole matching a tapped map number, creating it first if it doesn't exist yet. */
	function selectOrCreateHoleByNumber(number: number): void {
		if (!activateHoleByNumber(number)) return;
		vibrate(8);
	}

	function vibrate(durationMs: number): void {
		if (typeof navigator === 'undefined' || !('vibrate' in navigator)) return;
		try {
			navigator.vibrate(durationMs);
		} catch {
			// Haptics are a nicety; never let an unsupported/blocked call surface.
		}
	}

	/**
	 * Where to zoom for a sidebar hole click. Real markers win (their
	 * midpoint if both exist); otherwise the hole's detected number-badge
	 * position stands in, since it's the only approximate location that can
	 * exist before any tee/basket has been placed (see `numberBadges`'s
	 * doc comment — populated from CV detection, never invented geometry).
	 * `null` when neither exists: the view deliberately stays put rather than
	 * jumping somewhere ungrounded.
	 */
	function holeFocusPoint(hole: AnnotatedHole): SourcePoint | null {
		if (hole.tee && hole.basket) {
			return { xPx: (hole.tee.xPx + hole.basket.xPx) / 2, yPx: (hole.tee.yPx + hole.basket.yPx) / 2 };
		}
		if (hole.tee) return hole.tee;
		if (hole.basket) return hole.basket;
		const badge = numberBadges.find((candidate) => candidate.number === hole.number);
		return badge ? { xPx: badge.xPx, yPx: badge.yPx } : null;
	}

	/**
	 * A snapshot taken once, at the moment of a deliberate sidebar click (see
	 * `onHoleBoxClick`) — deliberately NOT a `$derived` over live hole state.
	 * If it re-read `holes` reactively by id, placing a hole's first piece
	 * while it's the current focus target would hand `holeFocusPoint` a fresh
	 * non-null point and silently re-trigger a second, unrequested camera
	 * jump the instant that piece landed, on top of the click's own jump.
	 */
	let sidebarFocusRequest = $state<{ key: string; point: SourcePoint; zoomMultiplier: number } | null>(null);

	/**
	 * The sidebar's per-hole "which section" bucketing for all 18 standard
	 * holes (extra holes past 18, if any, aren't shown in the redesigned grid
	 * — same 1-18 scope the old flat hole bar's main grid had). A hole with no
	 * draft record yet is section 1: it has neither tee nor basket, exactly
	 * like an empty `AnnotatedHole` would score.
	 */
	let sidebarSections = $derived.by(() => {
		const buckets: Record<1 | 2 | 3 | 4 | 5, number[]> = { 1: [], 2: [], 3: [], 4: [], 5: [] };
		for (let number = 1; number <= 18; number += 1) {
			const hole = holes.find((candidate) => candidate.number === number);
			buckets[hole ? sectionOfHole(hole) : 1].push(number);
		}
		return buckets;
	});

	let allHolesConfirmed = $derived(sidebarSections[5].length === 18);

	/**
	 * Entry point for clicking a hole in the sidebar grid: activates it
	 * (creating an empty draft hole on demand for a section-1 hole with no
	 * record yet) and engages the camera jump. The placing/approve banner
	 * itself is fully derived from the resulting hole state — see
	 * `sidebarBanner` — no separate mode flag to keep in sync here.
	 */
	function onHoleBoxClick(number: number): void {
		const hole = activateHoleByNumber(number);
		if (!hole) return;
		sidebarFocusTick += 1;
		const point = holeFocusPoint(hole);
		sidebarFocusRequest = point
			? { key: `${hole.id}:${sidebarFocusTick}`, point, zoomMultiplier: SIDEBAR_FOCUS_ZOOM_MULTIPLIER }
			: null;
		markerChip = null;
		radialMenu = null;
	}

	/** Clears sidebar focus — the placing/approve banner's Cancel/Close action. Cannot force the camera back out (the pane exposes no such API to the page); the user can still use the pane's own "Fit image" control. */
	function exitSidebarFocus(): void {
		activeHoleId = null;
		markerChip = null;
	}

	type SidebarBanner =
		| { kind: 'placing'; holeNumber: number; piece: 'Tee' | 'Basket' }
		| { kind: 'approve'; holeNumber: number }
		| { kind: 'confirmed'; holeNumber: number };

	/** Derived purely from the active hole's own section — see requirement 3/4: which piece a placing click will create, or the Approve prompt, follows automatically from hole state. Map mode only; Round mode's own hole selection has nothing to do with tee/basket sections. */
	let sidebarBanner = $derived.by((): SidebarBanner | null => {
		if (annotationMode !== 'map' || !activeHoleId) return null;
		const hole = holes.find((candidate) => candidate.id === activeHoleId);
		if (!hole) return null;
		const section = sectionOfHole(hole);
		if (section <= 3) return { kind: 'placing', holeNumber: hole.number, piece: hole.tee ? 'Basket' : 'Tee' };
		if (section === 4) return { kind: 'approve', holeNumber: hole.number };
		return { kind: 'confirmed', holeNumber: hole.number };
	});

	/** The Approve banner's action: confirms both pieces, then auto-advances to the next section-4 hole if one exists, else exits focus — mirroring the reference flow's `approveHole`. */
	function approveActiveHole(): void {
		if (!activeHoleId) return;
		approveHolePieces(activeHoleId);
		vibrate(8);
		const next = holes.find((hole) => hole.id !== activeHoleId && sectionOfHole(hole) === 4);
		if (next) onHoleBoxClick(next.number);
		else exitSidebarFocus();
	}

	/** The completion panel's first action — reuses the exact best-effort Course Memory write Done already performs, so "saved" here means the same thing it means everywhere else in this file. */
	async function handleSaveCourseToMemory(): Promise<void> {
		if (savingCourseToMemory) return;
		savingCourseToMemory = true;
		try {
			await saveToLibraryBestEffort();
			savedCourseToMemory = true;
		} finally {
			savingCourseToMemory = false;
		}
	}

	/** The completion panel's second action, gated on the first succeeding — hands this course off to Create Graphics exactly like the topbar Done button, since "upload a round from this course" and "finish this annotation" are the same handoff. */
	async function handleUploadRoundFromCourse(): Promise<void> {
		if (!savedCourseToMemory) return;
		await handleDone();
	}

	/** Hole-scoped markers only — a `walk` marker never reaches here, its own kind is handled by the caller before this is invoked. */
	function moveMarker(
		currentHoles: readonly AnnotatedHole[],
		marker: AnnotationMarkerHit,
		point: SourcePoint
	): AnnotatedHole[] {
		if (marker.holeId === null) return currentHoles.slice();
		switch (marker.kind) {
			case 'tee':
				return moveTee(currentHoles, marker.holeId, point);
			case 'basket':
				return moveBasket(currentHoles, marker.holeId, point);
			case 'shot':
				return marker.shotId
					? moveShot(currentHoles, marker.holeId, marker.shotId, point)
					: currentHoles.slice();
			case 'bend':
				return marker.index === undefined
					? currentHoles.slice()
					: moveCorridorBend(currentHoles, marker.holeId, marker.index, point);
			case 'walk':
				return currentHoles.slice();
		}
	}

	/** Hole-scoped markers only — a `walk` marker never reaches here, its own kind is handled by the caller before this is invoked. */
	function deleteMarker(
		currentHoles: readonly AnnotatedHole[],
		marker: AnnotationMarkerHit
	): AnnotatedHole[] {
		if (marker.holeId === null) return currentHoles.slice();
		switch (marker.kind) {
			case 'tee':
				return removeTee(currentHoles, marker.holeId);
			case 'basket':
				return removeBasket(currentHoles, marker.holeId);
			case 'shot':
				return marker.shotId
					? removeShot(currentHoles, marker.holeId, marker.shotId)
					: currentHoles.slice();
			case 'bend':
				return marker.index === undefined
					? currentHoles.slice()
					: removeCorridorBend(currentHoles, marker.holeId, marker.index);
			case 'walk':
				return currentHoles.slice();
		}
	}

	/** The point in image space that a currently-hit hole marker occupies right now; walk markers are read straight from `walkingPath` by the caller instead. */
	function markerPoint(marker: AnnotationMarkerHit): SourcePoint | null {
		const hole = holes.find((candidate) => candidate.id === marker.holeId);
		if (!hole) return null;
		switch (marker.kind) {
			case 'tee':
				return hole.tee ?? null;
			case 'basket':
				return hole.basket ?? null;
			case 'shot':
				return hole.shots.find((shot) => shot.id === marker.shotId)?.landing ?? null;
			case 'bend':
				return marker.index !== undefined ? hole.corridorBends[marker.index] ?? null : null;
			case 'walk':
				return null;
		}
	}

	function localSnapKey(kind: LocalSnapKind, holeId: string): string {
		return `${kind}:${holeId}`;
	}

	/** The number-badge anchor `requestLocalSnap`'s worker request re-derives `UiScalePx`/`BasketTemplateScale` from, raw (unbranded) since only the worker needs to re-brand it. `null` before course detection has ever run: there is no calibration to crop or size a snap window from yet. */
	function currentNumberAnchor(): { scale: number; widthPx: number; heightPx: number } | null {
		const anchor = courseDetection?.numberDetection?.anchor;
		return anchor ? { scale: anchor.scale, widthPx: anchor.widthPx, heightPx: anchor.heightPx } : null;
	}

	/**
	 * Snap-to-detection (design points 1/2/3/5): fires a short local
	 * object-finding pass around a tee/basket point that has *already* been
	 * placed at the raw click/release coordinates by the caller
	 * (`chooseRadialAction`'s placement, `commitAnnotationPointerUp`'s
	 * drag-release) — this never blocks that raw placement, it only settles
	 * the marker onto a detected feature later if one is confidently found
	 * nearby (optimistic placement: a course screenshot decode plus a cold
	 * worker can plausibly exceed the ~100ms "feels instant" budget even
	 * though the crop-sized detector pass itself is fast once warm — see
	 * `src/lib/cv/localSnap.ts`'s doc comment for the measurements behind
	 * that choice). No calibration yet (course detection hasn't run), no
	 * source image, Alt held, or a failed/empty pass are all indistinguishable
	 * outcomes to the user: the raw point already placed simply stands.
	 */
	function applyLocalSnap(kind: LocalSnapKind, holeId: string, rawPoint: SourcePoint, altKey: boolean): void {
		if (altKey) return;
		const anchor = currentNumberAnchor();
		const image = sourceImage();
		if (!anchor || !image) return;
		const resource = editor.getAssetResource(image.id);
		if (!resource) return;

		localSnapRequestSequence += 1;
		const requestId = localSnapRequestSequence;
		const key = localSnapKey(kind, holeId);
		pendingLocalSnaps.set(key, requestId);

		requestLocalSnap(resource.bytes, image.mimeType, { kind, clickPx: rawPoint, numberAnchor: anchor })
			.then((snapped) => {
				if (!snapped) return;
				// Superseded by a newer snap request on the same marker (another
				// placement/release, or the marker was deleted and re-placed) —
				// this reply is stale and must not clobber whatever's current now.
				if (pendingLocalSnaps.get(key) !== requestId) return;
				settleLocalSnap(kind, holeId, rawPoint, snapped);
			})
			.catch(() => {
				// A failed pass must be indistinguishable from no feature: never
				// surface an error for a background convenience snap.
			});
	}

	/** ~100ms CSS ease (design point 4) plus a small buffer so `.settling` outlives the transition it drives rather than being pulled off mid-animation. */
	const LOCAL_SNAP_SETTLE_CLASS_MS = 150;

	/**
	 * Applies a resolved snap result, but only if the marker is still exactly
	 * where the optimistic raw placement left it — if the user has since
	 * moved, deleted, or replaced it, this reply is stale and must not
	 * clobber newer state.
	 */
	function settleLocalSnap(kind: LocalSnapKind, holeId: string, rawPoint: SourcePoint, snapped: SourcePoint): void {
		const hole = holes.find((candidate) => candidate.id === holeId);
		if (!hole) return;
		const current = kind === 'tee' ? hole.tee : hole.basket;
		if (!current || current.xPx !== rawPoint.xPx || current.yPx !== rawPoint.yPx) return;
		if (snapped.xPx === rawPoint.xPx && snapped.yPx === rawPoint.yPx) return;

		const key = localSnapKey(kind, holeId);
		if (!prefersReducedMotion()) {
			settlingMarkerKeys = new Set([...settlingMarkerKeys, key]);
			setTimeout(() => {
				settlingMarkerKeys = new Set([...settlingMarkerKeys].filter((existing) => existing !== key));
			}, LOCAL_SNAP_SETTLE_CLASS_MS);
		}
		holes = kind === 'tee' ? moveTee(holes, holeId, snapped) : moveBasket(holes, holeId, snapped);
	}

	/**
	 * Wedge actions offered by an open radial menu: Delete alone for a hit
	 * marker (bend/shot/walk only — tee/basket markers never reach this menu,
	 * see `commitAnnotationPointerUp`), otherwise the wedges the current
	 * mode's activity allows. Map mode's empty-space menu offers only `bend`
	 * now — tee/basket creation goes through the sidebar-driven placing flow
	 * (`placeNextPiece`) before this menu is ever reached, see
	 * `handleAnnotationPlacement`. Round mode is untouched: shot with a hole
	 * active, walk always (the walk path needs no hole).
	 */
	function radialMenuActions(menu: RadialMenuState): RadialAction[] {
		if (menu.hitMarker) return ['delete'];
		if (annotationMode === 'round') {
			const actions: RadialAction[] = [];
			if (menu.holeId) actions.push('shot');
			actions.push('walk');
			return actions;
		}
		return menu.holeId ? ['bend'] : [];
	}

	/** `radialMenuActions()`, projected into the generic button shape `RadialMenu.svelte` renders. */
	function radialMenuButtons(menu: RadialMenuState): RadialMenuAction[] {
		return radialMenuActions(menu).map((action) => ({
			id: action,
			label:
				action === 'delete'
					? `Delete ${menu.hitMarker ? POINT_KIND_LABELS[menu.hitMarker.kind] : ''}`
					: POINT_KIND_LABELS[action],
			icon: action === 'delete' ? '✕' : POINT_KIND_ICONS[action],
			danger: action === 'delete'
		}));
	}

	/** Whether the given marker is the one an open delete radial menu targets, for the overlay's highlight ring. */
	function isRadialTarget(
		holeId: string | null,
		kind: AnnotationMarkerKind,
		options: { index?: number; shotId?: string } = {}
	): boolean {
		const marker = radialMenu?.hitMarker;
		if (!marker || marker.kind !== kind) return false;
		if (kind === 'walk') return marker.index === options.index;
		if (marker.holeId !== holeId) return false;
		if (kind === 'shot') return marker.shotId === options.shotId;
		if (kind === 'bend') return marker.index === options.index;
		return true;
	}

	/**
	 * Applies the chosen action (place a point kind, or delete the marker that
	 * opened the menu) and closes the menu, then returns focus to the viewport
	 * so a keyboard user stays in the flow instead of losing focus to the page
	 * body when the menu's buttons unmount. `menu` is the specific menu
	 * instance the button belonged to — if `radialMenu` has already moved on to
	 * a different one (e.g. a stray outside-click callback arriving after a
	 * new menu opened), this is a no-op rather than acting on stale state.
	 */
	function chooseRadialAction(menu: RadialMenuState, action: RadialAction): void {
		if (radialMenu !== menu) return;
		radialMenu = null;
		if (action === 'delete') {
			const marker = menu.hitMarker;
			if (marker) {
				if (marker.kind === 'walk') {
					if (marker.index !== undefined) walkingPath = removeWalkPoint(walkingPath, marker.index);
				} else {
					holes = deleteMarker(holes, marker);
					if (isMapGeometryKind(marker.kind)) markMapGeometryEdited();
				}
			}
		} else if (action === 'walk') {
			walkingPath = addWalkPoint(walkingPath, menu.at);
		} else if (menu.holeId) {
			// Only 'bend' (map mode) or 'shot' (round mode) ever reach here now —
			// tee/basket creation is intercepted earlier by `handleAnnotationPlacement`
			// into the sidebar-driven placing flow, see `radialMenuActions`.
			holes = placeByMode(holes, menu.holeId, action, menu.at);
			if (isMapGeometryKind(action)) markMapGeometryEdited();
		}
		focusViewport();
	}

	/** Closes `menu` if it's still the current one (see `chooseRadialAction`'s note on staleness), returning focus to the viewport on Escape. */
	function closeRadialMenu(menu: RadialMenuState, reason: 'escape' | 'outside'): void {
		if (radialMenu !== menu) return;
		radialMenu = null;
		if (reason === 'escape') focusViewport();
	}

	/**
	 * Programmatically focuses the source-overview viewport (`tabindex="-1"`,
	 * never in the tab order) so an accessible popover it renders above can
	 * hand focus back on close. `preventScroll: true` matters here beyond the
	 * usual "don't jar the user" reason: the pane is already fully in view by
	 * construction (the click that opened the menu landed inside it), so an
	 * unguarded `.focus()` call's default scroll-into-view would only ever
	 * move the page, invalidating every screen coordinate a caller (or an e2e
	 * test) computed before the menu closed.
	 */
	function focusViewport(): void {
		void tick().then(() => {
			document
				.querySelector<HTMLElement>('[data-testid="pane-scene-source-overview"]')
				?.focus({ preventScroll: true });
		});
	}

	function claimAnnotationPointer(
		pointer: ScreenSpacePoint,
		event: PointerEvent,
		view: ViewTransformState
	): boolean {
		if (!sourceImage()) return false;
		const marker = pointHitAt(pointer, view);
		if (marker) {
			annotationDrag = {
				marker,
				start: { ...pointer },
				transform: { ...view },
				dragging: false
			};
			void event;
			return true;
		}
		const numberLabel = numberCandidateHitAt(pointer, view);
		if (numberLabel !== null) {
			numberSelectDrag = { label: numberLabel, start: { ...pointer }, dragging: false };
			void event;
			return true;
		}
		return false;
	}

	function previewAnnotationMove(pointer: ScreenSpacePoint, event: PointerEvent): void {
		if (numberSelectDrag) {
			const distance = Math.hypot(pointer.x - numberSelectDrag.start.x, pointer.y - numberSelectDrag.start.y);
			if (distance > clickSlopPx(event.pointerType)) numberSelectDrag.dragging = true;
			return;
		}
		const drag = annotationDrag;
		const image = sourceImage();
		if (!drag || !image) return;
		const distance = Math.hypot(pointer.x - drag.start.x, pointer.y - drag.start.y);
		if (!drag.dragging && distance > clickSlopPx(event.pointerType)) drag.dragging = true;
		if (!drag.dragging) return;
		const point = clampPointToImageBounds(
			screenToImage(pointer, drag.transform),
			image.widthPx,
			image.heightPx
		);
		if (drag.marker.kind === 'walk') {
			previewWalkingPath =
				drag.marker.index !== undefined ? moveWalkPoint(walkingPath, drag.marker.index, point) : walkingPath;
		} else {
			previewHoles = moveMarker(holes, drag.marker, point);
		}
	}

	/**
	 * A non-dragging release on an existing marker opens a correction UI —
	 * which one depends on the marker kind. Tee/basket (map mode) always open
	 * the marker chip (requirement 5: any marker, any time, no gating);
	 * bend/shot/walk keep the pre-existing delete-only radial menu, since
	 * those aren't part of this redesign.
	 */
	function commitAnnotationPointerUp(pointer: ScreenSpacePoint, event?: PointerEvent): void {
		if (numberSelectDrag) {
			const { label, dragging } = numberSelectDrag;
			numberSelectDrag = null;
			if (!dragging) selectOrCreateHoleByNumber(label);
			return;
		}
		const drag = annotationDrag;
		annotationDrag = null;
		const image = sourceImage();
		if (!drag || !image) {
			previewHoles = null;
			previewWalkingPath = null;
			return;
		}
		if (!drag.dragging) {
			previewHoles = null;
			previewWalkingPath = null;
			if ((drag.marker.kind === 'tee' || drag.marker.kind === 'basket') && drag.marker.holeId) {
				openMarkerChip(drag.marker.holeId, drag.marker.kind);
				return;
			}
			const point =
				drag.marker.kind === 'walk'
					? (drag.marker.index !== undefined ? walkingPath[drag.marker.index] ?? null : null)
					: markerPoint(drag.marker);
			if (point) openRadialMenu({ at: point, holeId: drag.marker.holeId, hitMarker: drag.marker });
			return;
		}
		const point = clampPointToImageBounds(
			screenToImage(pointer, drag.transform),
			image.widthPx,
			image.heightPx
		);
		if (drag.marker.kind === 'walk') {
			walkingPath =
				drag.marker.index !== undefined ? moveWalkPoint(walkingPath, drag.marker.index, point) : walkingPath;
		} else {
			holes = moveMarker(holes, drag.marker, point);
			if (isMapGeometryKind(drag.marker.kind)) markMapGeometryEdited();
			// Snap-to-detection applies on a genuine drag-RELEASE only (never
			// mid-drag — `previewAnnotationMove` above never calls this), and only
			// for an existing tee/basket marker being repositioned.
			if ((drag.marker.kind === 'tee' || drag.marker.kind === 'basket') && drag.marker.holeId) {
				applyLocalSnap(drag.marker.kind, drag.marker.holeId, point, event?.altKey ?? false);
			}
		}
		previewHoles = null;
		previewWalkingPath = null;
	}

	function cancelAnnotationPointer(): void {
		annotationDrag = null;
		numberSelectDrag = null;
		previewHoles = null;
		previewWalkingPath = null;
	}

	/**
	 * Places the missing piece for `holeId` (tee first, then basket — matches
	 * the sidebar's own ordering, see `sectionOfHole`) and asks for the second
	 * piece in place if one is still missing, no return trip to the sidebar.
	 * The one entry point for the redesign's "placing" flow, called from
	 * `handleAnnotationPlacement` for an empty-map click and from
	 * `onHoleBoxClick` when a section 1-3 hole is already fully in view.
	 */
	function placeNextPiece(holeId: string, point: SourcePoint, altKey: boolean): void {
		const hole = holes.find((candidate) => candidate.id === holeId);
		if (!hole) return;
		const kind: 'tee' | 'basket' = hole.tee ? 'basket' : 'tee';
		holes = placeByMode(holes, holeId, kind, point);
		markMapGeometryEdited();
		applyLocalSnap(kind, holeId, point, altKey);
		vibrate(8);
	}

	/**
	 * Opens the empty-space placement menu/flow. In round mode this works even
	 * with no hole active — the menu then offers only `walk`, since the walk
	 * path is round-level rather than per-hole. In map mode a hole must be
	 * active; if it's still missing a tee or basket (sections 1-3), the click
	 * places that piece directly through the sidebar's placing flow instead of
	 * opening a menu at all. Otherwise (section 4/5, or Round mode) the
	 * existing empty-space radial menu handles it — bends in Map mode, shots
	 * in Round mode.
	 */
	function handleAnnotationPlacement(
		coordinates: { xPx: number; yPx: number },
		options: { altKey?: boolean } = {}
	): void {
		if (annotationMode === 'map') {
			if (!activeHoleId) return;
			const hole = activeHole();
			if (hole && sectionOfHole(hole) <= 3) {
				placeNextPiece(activeHoleId, coordinates, options.altKey ?? false);
				return;
			}
		}
		openRadialMenu({ at: coordinates, holeId: activeHoleId, hitMarker: null });
	}

	/**
	 * A replaced source image invalidates every existing hole's coordinates —
	 * they're pixel positions into a specific raster, not portable to a
	 * different one — so annotation state resets along with the domain refresh.
	 */
	function handleSourceDomainChanged(): void {
		refresh();
		holes = [];
		walkingPath = [];
		numberBadges = [];
		labeledBaskets = [];
		recognizedMatch = null;
		recognizedSourceId = null;
		activeHoleId = null;
		annotationMode = 'map';
		importedLibraryEntryThisSession = false;
		mapGeometryEdited = false;
		radialMenu = null;
		markerChip = null;
		sidebarFocusRequest = null;
		savingCourseToMemory = false;
		savedCourseToMemory = false;
		courseDetectionError = null;
		courseDetection = null;
		confirmedPieces = new Set();
		courseDetectionStatus = null;
		courseDetectionStage = null;
		courseDetectionElapsedSeconds = 0;
		stopCourseDetectionProgress();
	}

	async function handleDetectCourse(): Promise<void> {
		const image = sourceImage();
		if (!image || courseDetectionRunning) return;
		const resource = editor.getAssetResource(image.id);
		if (!resource) {
			courseDetectionError = 'The source image bytes are no longer available.';
			return;
		}

		const detectedImageId = image.id;
		courseDetectionRunning = true;
		courseDetectionError = null;
		courseDetectionStage = null;
		markerChip = null;
		startCourseDetectionProgress();
		try {
			const result = await detectCourseCandidates(
				resource.bytes,
				image.mimeType,
				image.widthPx,
				image.heightPx,
				(progress) => {
					courseDetectionStatus = progress.message;
					courseDetectionStage = progress.stage;
				}
			);
			// The source image may have been replaced while this awaited: a result
			// keyed to the old raster must never be written onto the new one's state.
			if (sourceImage()?.id !== detectedImageId) return;
			courseDetection = result;
			// Captured regardless of proposal.status: badge/basket ownership
			// (courseGrammar's Stages 1 and 4) each succeed independently of the
			// hole's overall tee/basket-complete status, so an "incomplete" or
			// "review" hole can still contribute a good signature point.
			numberBadges = result.grammar.holes
				.filter((proposal) => proposal.numberBadge !== undefined)
				.map((proposal) => ({
					number: proposal.number,
					xPx: proposal.numberBadge!.xPx,
					yPx: proposal.numberBadge!.yPx,
					confidence: proposal.numberBadge!.confidence
				}));
			labeledBaskets = result.grammar.holes
				.filter((proposal) => proposal.basket !== undefined)
				.map((proposal) => ({
					holeNumber: proposal.number,
					xPx: proposal.basket!.xPx,
					yPx: proposal.basket!.yPx
				}));
			const assignedNumbers = result.numberDetection.candidates.filter(
				(candidate) => candidate.label !== undefined
			).length;
			courseDetectionStatus = `Complete · ${assignedNumbers} numbers · ${result.tees.length} tees · ${result.baskets.length} baskets`;
			applyDetectedPieces({ skipExisting: true });
			await recognizeCourse(detectedImageId, numberBadges, labeledBaskets);
		} catch (error) {
			if (sourceImage()?.id !== detectedImageId) return;
			courseDetection = null;
			courseDetectionStatus = 'Detection failed';
			courseDetectionError = error instanceof Error ? error.message : 'Course detection failed.';
		} finally {
			courseDetectionRunning = false;
			stopCourseDetectionProgress();
		}
	}

	/**
	 * Course Memory recognition: at most once per source image, scan the local
	 * course library for a confident geometric match and surface it as a
	 * confirm/dismiss banner. Never applies anything itself — `recognizedMatch`
	 * only ever renders the banner; `handleCourseRecognizedImport` is the sole
	 * path that calls `applyLibraryEntry`. A lookup failure is swallowed: a
	 * broken or unavailable library must never block manual annotation.
	 */
	async function recognizeCourse(
		sourceId: string,
		badges: readonly HoleNumberBadgeAnchor[],
		baskets: readonly LabeledPoint[]
	): Promise<void> {
		if (recognizedSourceId === sourceId) return;
		recognizedSourceId = sourceId;
		try {
			const results = await findFuzzyMatches(courseLibraryStore, {
				badges: badgesToLabeledPoints(badges),
				baskets
			});
			// The source image may have been replaced while this awaited: a match
			// keyed to the old raster must never surface against the new one.
			if (sourceImage()?.id !== sourceId) return;
			if (results.length > 0) {
				recognizedMatch = { entry: results[0].entry, match: results[0] };
			}
		} catch {
			// Best-effort recognition only; never surfaces as a blocking error.
		}
	}

	function handleCourseRecognizedImport(): void {
		if (!recognizedMatch || applyingRecognizedMatch) return;
		applyingRecognizedMatch = true;
		try {
			holes = applyLibraryEntry(recognizedMatch.entry, recognizedMatch.match, holes, { skipExisting: false });
			activeHoleId = activeHoleId ?? holes[0]?.id ?? null;
			recognizedMatch = null;
			// The imported geometry exactly matches what the library already
			// knows; only a subsequent Map-mode edit makes it worth previewing
			// a library write again at Done.
			importedLibraryEntryThisSession = true;
			mapGeometryEdited = false;
			// The imported course geometry means the remaining work is round
			// annotation — switch the toolbar there so the user isn't stuck on
			// Map mode with nothing left for it to do.
			setAnnotationMode('round');
		} finally {
			applyingRecognizedMatch = false;
		}
	}

	function handleCourseRecognizedDismiss(): void {
		recognizedMatch = null;
	}

	/**
	 * Loads the hand-authored IMG_5641 reference points for course geometry
	 * only. This intentionally does not touch shots, bends, corridor widths,
	 * or the walking path; those are separate annotation work. Every hole's
	 * tee and basket is marked confirmed: this fixture is known-correct QA
	 * data, not something the sidebar should ask a developer to re-review
	 * piece by piece.
	 */
	function handleAssignGroundTruth(): void {
		const image = sourceImage();
		if (!image || !groundTruthMatchesImage(image)) return;
		const groundTruth = IMG_5641_GROUND_TRUTH;
		holes = mergeCourseGroundTruth(
			holes,
			groundTruth,
			() => crypto.randomUUID(),
			currentCorridorWidthPx()
		);
		numberBadges = [...groundTruth.badges];
		labeledBaskets = groundTruth.holes.map((hole) => ({
			holeNumber: hole.number,
			xPx: hole.basket.xPx,
			yPx: hole.basket.yPx
		}));
		activeHoleId = activeHoleId ?? holes[0]?.id ?? null;
		importedLibraryEntryThisSession = false;
		mapGeometryEdited = true;
		courseDetection = null;
		const confirmed = new Set<string>();
		for (const hole of holes) {
			if (hole.tee) confirmed.add(pieceStatusKey(hole.id, 'tee'));
			if (hole.basket) confirmed.add(pieceStatusKey(hole.id, 'basket'));
		}
		confirmedPieces = confirmed;
		courseDetectionStatus = 'Ground truth assigned · 18 pads · 18 baskets · 18 badges';
		courseDetectionElapsedSeconds = 0;
		courseDetectionError = null;
	}

	/** A stitched PNG awaiting import from the Stitch Map page (banner shown only when import isn't safe to do automatically — see `canAutoImportHandoffSafely`). */
	let pendingHandoff = $state<PendingHandoff | null>(null);
	let importingHandoff = $state(false);
	let handoffError = $state<string | null>(null);

	/**
	 * Whether the pending handoff can complete on its own, with no confirmation
	 * click, right now. A handoff replaces the whole source image, and
	 * `handleSourceDomainChanged` already treats any source replacement as
	 * invalidating every existing hole (their coordinates are pixel positions
	 * into a specific raster — see its own doc comment). So auto-import is only
	 * safe when there is nothing to lose: no source image loaded yet and no
	 * holes placed. If either is present, the banner stays and its copy says
	 * plainly that importing replaces the current source.
	 */
	function canAutoImportHandoffSafely(): boolean {
		return sourceImage() === null && holes.length === 0;
	}

	/**
	 * Uses the shared `importHandoffImage` flow (see `$lib/handoffImport.ts`)
	 * with this route's own discard-confirmation: an Annotate Round project
	 * never has correspondence pairs to lose, so confirmDiscard is trivially
	 * true here, unlike create-graphics' dialog-backed confirmation. Shared by
	 * both the automatic (safe arrival) and manual (banner click) paths — the
	 * only difference is who calls it and with which handoff.
	 */
	async function importHandoff(handoff: PendingHandoff): Promise<void> {
		if (importingHandoff) return;
		importingHandoff = true;
		handoffError = null;
		try {
			const result = await importHandoffImage({
				editor,
				handoff,
				role: 'source-overview',
				decode,
				confirmDiscard: () => true
			});
			if (result.status === 'error') {
				// Surface the failure via the normal banner instead of failing
				// silently on the automatic path — the handoff is still pending in
				// the session store (not consumed on error), so falling back to the
				// banner lets the user see the error and retry with the manual
				// Import button, or dismiss.
				pendingHandoff = handoff;
				handoffError = result.message;
				return;
			}
			if (result.status === 'cancelled') return;
			consumePendingHandoff();
			pendingHandoff = null;
			refresh();
		} finally {
			importingHandoff = false;
		}
	}

	function handleHandoffImport(): void {
		if (!pendingHandoff) return;
		void importHandoff(pendingHandoff);
	}

	function handleHandoffDismiss(): void {
		consumePendingHandoff();
		pendingHandoff = null;
		handoffError = null;
	}

	let saving = $state(false);
	let saveError = $state<string | null>(null);
	let activityMessage = $state<string | null>(null);
	let openLoading = $state(false);
	let openError = $state<string | null>(null);
	let openDraftInput = $state<HTMLInputElement | null>(null);

	function isDirty(): boolean {
		void refreshCount;
		void holes;
		return editor.isDirty;
	}

	function handleSave(): void {
		if (saving) return;
		void runSave();
	}

	/**
	 * Saves the source image plus every hand-placed hole as a portable
	 * `.chainspot-round.zip` draft (see `annotationDraft.ts` for why this is
	 * a separate format from Create Graphics' two-image project bundle), so
	 * annotation work here is durable and reopenable without needing to
	 * finish the round first. Snapshots the editor state before the async
	 * hash/zip work starts and only calls `markSaved` if it still matches
	 * afterwards, so an edit that lands mid-save is never silently
	 * checkpointed as saved — it downloads the earlier state and reports
	 * that a re-save is needed.
	 */
	async function runSave(): Promise<void> {
		saving = true;
		saveError = null;
		try {
			const before = editor.state;
			const result = await saveAnnotationDraft(editor, { hash, download });
			if (result.ok) {
				if (JSON.stringify(editor.state) === JSON.stringify(before)) {
					editor.markSaved();
				} else {
					saveError =
						'The annotations changed while saving. The downloaded draft contains the earlier state — save again to include your latest edits.';
				}
				if (!saveError) activityMessage = 'Annotation draft saved.';
				refresh();
			} else {
				saveError = result.error.message;
			}
		} catch (error) {
			saveError = error instanceof Error ? error.message : 'Could not save the draft.';
		} finally {
			saving = false;
		}
	}

	function handleOpenDraftFile(event: Event): void {
		const input = event.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		input.value = '';
		if (!file) return;
		void openDraft(file);
	}

	/**
	 * Replaces the live editor with a freshly opened draft: a clean checkpoint
	 * built from the archived source image (re-run through the normal intake
	 * path, same as any other image load) plus the archived holes. Never
	 * touches the live project on failure.
	 */
	async function openDraft(file: File): Promise<void> {
		openLoading = true;
		openError = null;
		try {
			const result = await readAnnotationDraft(file, { hash });
			if (!result.ok) {
				openError = result.error.message;
				return;
			}
			const imageFile = new File([new Uint8Array(result.image.bytes)], result.image.fileName, {
				type: result.image.mimeType
			});
			const next = new ProjectEditor();
			const intake = await intakeImageFile({
				editor: next,
				role: 'source-overview',
				file: imageFile,
				decode,
				hash,
				confirmDiscard: () => true
			});
			if (!intake.ok) {
				openError = intake.error.message;
				return;
			}
			next.setHoles(result.holes);
			next.markSaved();
			editor = next;
			holes = next.state.holes;
			activeHoleId = null;
			previewHoles = null;
			radialMenu = null;
			markerChip = null;
			sidebarFocusRequest = null;
			savingCourseToMemory = false;
			savedCourseToMemory = false;
			confirmedPieces = new Set();
			courseDetection = null;
			autoDetectedSourceId = null;
			prewarmedSourceId = null;
			saveError = null;
			activityMessage = `Opened draft "${result.image.fileName}".`;
			refresh();
		} catch (error) {
			openError = error instanceof Error ? error.message : 'Could not open the draft.';
		} finally {
			openLoading = false;
		}
	}

	let doneRunning = $state(false);
	let doneError = $state<string | null>(null);
	/**
	 * A pending "this would overwrite a saved course" confirmation, opened by
	 * `saveToLibraryBestEffort` and settled by the dialog's own buttons (or
	 * Escape). `handleDone` awaits `confirmLibraryUpdate` before proceeding, so
	 * the dialog blocks only the library write — never the Create Graphics
	 * handoff, which happens regardless of the user's choice here.
	 */
	let pendingLibraryUpdateConfirm = $state<{ entry: CourseLibraryEntry } | null>(null);
	let libraryUpdateResolve: ((accept: boolean) => void) | null = null;
	let libraryUpdateKeepButton = $state<HTMLButtonElement | null>(null);
	let libraryUpdateFocusRestore: HTMLElement | null = null;

	function canFinishAnnotation(): boolean {
		void refreshCount;
		return sourceImage() !== null;
	}

	$effect(() => {
		const registration = annotationNavRegistration;
		if (registration === null) return;
		updateAnnotationNav(registration, {
			mode: annotationMode,
			canFinish: canFinishAnnotation(),
			doneRunning
		});
	});

	/** Opens the update-confirmation dialog and resolves once the user answers it (accept = "Update saved course"). */
	function confirmLibraryUpdate(entry: CourseLibraryEntry): Promise<boolean> {
		return new Promise((resolve) => {
			libraryUpdateFocusRestore = document.activeElement instanceof HTMLElement ? document.activeElement : null;
			libraryUpdateResolve = resolve;
			pendingLibraryUpdateConfirm = { entry };
		});
	}

	/** Settles the open update-confirmation dialog, restoring focus to whatever triggered it — mirrors Stitch Map's replace-confirmation pattern. */
	function settleLibraryUpdateConfirm(accept: boolean): void {
		const resolve = libraryUpdateResolve;
		libraryUpdateResolve = null;
		pendingLibraryUpdateConfirm = null;
		const target = libraryUpdateFocusRestore?.isConnected ? libraryUpdateFocusRestore : null;
		libraryUpdateFocusRestore = null;
		if (target) void tick().then(() => target.focus());
		resolve?.(accept);
	}

	$effect(() => {
		if (!pendingLibraryUpdateConfirm) return;
		void tick().then(() => libraryUpdateKeepButton?.focus());
	});

	/**
	 * Best-effort Course Memory write, called from `handleDone` before the
	 * Create Graphics handoff. Three cases:
	 *  - The session imported a library entry and nothing in Map mode has
	 *    since edited it: the stored geometry has nothing new to learn, and
	 *    writing it back would churn identical geometry into this image's
	 *    (numerically different) pixel space for no reason — skipped entirely.
	 *  - `previewUpsertCourse` reports `'new'` or `'identical'`: today's silent
	 *    save, unchanged.
	 *  - `'update'`: a saved course's geometry would be overwritten — gated on
	 *    an explicit confirm/keep choice via `confirmLibraryUpdate`.
	 * A preview or write failure always falls back to the pre-existing silent
	 * best-effort upsert attempt; it must never block Done.
	 */
	async function saveToLibraryBestEffort(): Promise<void> {
		if (importedLibraryEntryThisSession && !mapGeometryEdited) return;
		const input = {
			projectName: editor.state.project.name,
			numberBadges: badgesToLabeledPoints(numberBadges),
			baskets: labeledBaskets,
			holes: toLibraryHoles(holes)
		};
		let preview: Awaited<ReturnType<typeof previewUpsertCourse>> | null = null;
		try {
			preview = await previewUpsertCourse(courseLibraryStore, input);
		} catch {
			preview = null;
		}
		if (preview?.kind === 'update') {
			const accept = await confirmLibraryUpdate(preview.entry);
			if (!accept) return;
		}
		try {
			await upsertCourse(courseLibraryStore, input);
		} catch {
			// Best-effort: a course-library write failure must never block Done.
		}
	}

	/**
	 * Builds the AnnotatedRound (source image plus whatever holes have been
	 * placed — annotation is optional and may stop at any hole, same as a real
	 * played round) and hands it to Create Graphics through the pending session
	 * slot. `walkingPath` is included only when at least one vertex was
	 * captured — an empty path is "not annotated", not "annotated as empty",
	 * matching `createAnnotatedRound`'s optional-field contract.
	 */
	async function handleDone(): Promise<void> {
		const asset = sourceImage();
		if (!asset || doneRunning) return;
		doneRunning = true;
		doneError = null;
		try {
			const resource = editor.getAssetResource(asset.id);
			if (!resource) {
				doneError = 'The source image bytes are no longer available.';
				return;
			}
			let round;
			try {
				round = createAnnotatedRound({
					sourceImage: annotatedSourceImageFromAsset(asset, resource.bytes),
					holes,
					...(walkingPath.length > 0 ? { walkingPath } : {})
				});
			} catch (error) {
				// Hole validation failure (for example a non-positive corridor
				// width or an out-of-bounds point) — correct it and try again.
				doneError = error instanceof Error ? error.message : 'The current annotations are invalid.';
				return;
			}
			setPendingAnnotatedRound(round);
			setPendingCourseBadges({ numberBadges, baskets: labeledBaskets });
			await saveToLibraryBestEffort();
			await goto(`${base}/create-graphics`);
		} finally {
			doneRunning = false;
		}
	}

	/**
	 * Gated on participatesInSession so injected-editor unit tests never observe
	 * cross-test session leakage from the module-level handoff store.
	 *
	 * A safe arrival (`canAutoImportHandoffSafely`) imports immediately without
	 * ever setting `pendingHandoff` — the banner never renders, so there's
	 * nothing for the user to press. An unsafe arrival (a source image and/or
	 * holes already present) leaves the banner up for an explicit decision,
	 * exactly as before.
	 */
	function readPendingHandoff(): void {
		const handoff = participatesInSession ? getPendingHandoff() : null;
		const targeted = handoff && handoff.targetRole === 'source-overview' ? handoff : null;
		if (targeted && canAutoImportHandoffSafely()) {
			// No stale banner from a previous (unsafe) handoff should hang around
			// while this one imports itself.
			pendingHandoff = null;
			void importHandoff(targeted);
			return;
		}
		pendingHandoff = targeted;
	}

	onMount(() => {
		annotationNavRegistration = registerAnnotationNav({
			mode: annotationMode,
			canFinish: canFinishAnnotation(),
			doneRunning,
			onModeChange: (mode) => setAnnotationMode(mode),
			onDone: () => void handleDone()
		});
		readPendingHandoff();
		// A handoff published while this page is already mounted — the guided
		// demo arming a step the visitor is standing on — would otherwise never
		// be seen, since the mount-time read above has already happened.
		const unsubscribe = participatesInSession
			? subscribePendingHandoff(readPendingHandoff)
			: () => {};
		window.addEventListener('keydown', handleAnnotationKeyDown);
		return () => {
			unsubscribe();
			window.removeEventListener('keydown', handleAnnotationKeyDown);
		};
	});

	/** Test hook: forces a re-derive after external domain actions. */
	export function refresh(): void {
		refreshCount += 1;
	}

	/** Test hook: the currently active editor. */
	export function getEditor(): ProjectEditor {
		return editor;
	}
</script>

<svelte:head>
	<title>Annotate Round | ChainSpot</title>
</svelte:head>

<main
	data-testid="annotate-round"
	data-source-loaded={sourceImage() ? 'true' : 'false'}
	data-hole-count={holes.length}
>
	<div class="draft-actions">
		{#if isDirty()}
			<span class="dirty" data-testid="dirty-indicator">Unsaved changes</span>
		{/if}
		<button
			type="button"
			data-testid="save-project"
			disabled={saving || !sourceImage()}
			onclick={handleSave}
			title="Save the annotation draft as a portable .chainspot-round.zip file (⌘/Ctrl+S)"
			aria-keyshortcuts="Control+S Meta+S"
		>
			Save draft (⌘/Ctrl+S)
		</button>
		<button
			type="button"
			data-testid="open-draft"
			disabled={openLoading}
			onclick={() => openDraftInput?.click()}
			title="Open a saved .chainspot-round.zip annotation draft (⌘/Ctrl+O)"
			aria-keyshortcuts="Control+O Meta+O"
		>
			Open draft (⌘/Ctrl+O)
		</button>
		<input
			class="file-input"
			type="file"
			accept=".chainspot-round.zip,application/zip,application/x-zip-compressed"
			data-testid="open-draft-input"
			bind:this={openDraftInput}
			tabindex="-1"
			aria-hidden="true"
			onchange={handleOpenDraftFile}
		/>
	</div>
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
			<p class="status" data-testid="save-loading" role="status">Saving draft…</p>
		{/if}
		{#if openLoading}
			<p class="status" data-testid="open-loading" role="status">Opening draft…</p>
		{/if}
	</section>
	{#if saveError}
		<p class="error" data-testid="save-error" role="alert">{saveError}</p>
	{/if}
	{#if openError}
		<p class="error" data-testid="open-error" role="alert">{openError}</p>
	{/if}
	{#if pendingHandoff}
		<section
			class="handoff-banner"
			data-testid="pending-handoff"
			aria-label="Pending stitched image"
		>
			<p>
				Stitched image “{pendingHandoff.fileName}” is ready to import as the UDisc source.
				{#if sourceImage() || holes.length > 0}
					Importing will replace the current source image and discard any annotations placed
					against it.
				{/if}
			</p>
			<div class="handoff-actions">
				<button
					type="button"
					data-testid="handoff-import"
					disabled={importingHandoff}
					onclick={handleHandoffImport}
				>
					Import stitched image
				</button>
				<button
					type="button"
					data-testid="handoff-dismiss"
					disabled={importingHandoff}
					onclick={handleHandoffDismiss}
				>
					Dismiss stitched image
				</button>
			</div>
			{#if handoffError}
				<p class="error" data-testid="handoff-error" role="alert">{handoffError}</p>
			{/if}
		</section>
	{/if}

	{#if recognizedMatch}
		<section
			class="handoff-banner"
			data-testid="course-recognized"
			aria-label="Recognized course"
		>
			<p>
				Recognized course “{recognizedMatch.entry.name}” ({Math.round(recognizedMatch.match.confidence * 100)}%
				match). Import its saved holes?
			</p>
			<div class="handoff-actions">
				<button
					type="button"
					data-testid="course-recognized-import"
					disabled={applyingRecognizedMatch}
					onclick={handleCourseRecognizedImport}
				>
					Import saved holes
				</button>
				<button
					type="button"
					data-testid="course-recognized-dismiss"
					disabled={applyingRecognizedMatch}
					onclick={handleCourseRecognizedDismiss}
				>
					Dismiss
				</button>
			</div>
		</section>
	{/if}

	{#if doneError}
		<p class="error" data-testid="annotate-done-error" role="alert">{doneError}</p>
	{/if}

	<!--
		Map mode's hole navigation moved into the sidebar (ImageEditorPane's
		`tools` snippet below) as part of the redesign. Round mode's own hole
		selection (for shots/walk path) is untouched — same flat 1-18 bar as
		before, just no longer shown in Map mode now that the sidebar covers it.
	-->
	{#if annotationMode === 'round'}
	<nav class="hole-bar" data-testid="hole-bar">
		<div class="hole-bar-grid">
			{#each Array.from({ length: 18 }, (_, index) => index + 1) as holeNumber}
				{@const hole = holes.find((candidate) => candidate.number === holeNumber)}
				<button
					type="button"
					class="hole-tab"
					class:populated={Boolean(hole)}
					class:selected={hole?.id === activeHoleId}
					data-testid="hole-select-{holeNumber}"
					disabled={!hole}
					aria-current={hole?.id === activeHoleId ? 'true' : undefined}
					aria-label={hole ? getHoleBarLabel(hole, hole.id === activeHoleId) : `Hole ${holeNumber}: empty`}
					onclick={() => hole && (activeHoleId = hole.id)}
				>
					<strong>{holeNumber}</strong>
					{#if hole}
						{@const indicators = getHoleBarIndicators(hole)}
						<span class="hole-indicators" aria-hidden="true">
							<span class:present={indicators.number}>N</span>
							<span class:present={indicators.tee}>T</span>
							<span class:present={indicators.basket}>B</span>
							<span class:present={indicators.bends > 0}>↯{indicators.bends || ''}</span>
							<span class:present={indicators.throws > 0}>↗{indicators.throws || ''}</span>
						</span>
						<span class="sr-only">{hole.tee ? 'tee' : 'no tee'}{hole.basket ? ' · basket' : ''} · {hole.shots.length} shots{hole.corridorBends.length > 0 ? ` · bends (${hole.corridorBends.length})` : ''}</span>
					{/if}
				</button>
			{/each}
		</div>
		{#if holes.some((hole) => hole.number > 18)}
			<div class="extra-hole-tabs" aria-label="Additional holes">
				{#each holes.filter((hole) => hole.number > 18) as hole (hole.id)}
					<button
						type="button"
						class="hole-tab extra"
						class:selected={hole.id === activeHoleId}
						data-testid="hole-select-{hole.number}"
						aria-current={hole.id === activeHoleId ? 'true' : undefined}
						aria-label={getHoleBarLabel(hole, hole.id === activeHoleId)}
						onclick={() => (activeHoleId = hole.id)}
					>
						Hole {hole.number}
					</button>
				{/each}
			</div>
		{/if}
	</nav>
	{/if}

	<div class="hole-annotation" class:diagnostics-collapsed={!diagnosticsRailExpanded} data-testid="hole-annotation">
		<ImageEditorPane
			title="UDisc source"
			role="source-overview"
			{editor}
			refresh={refreshCount}
			{decode}
			confirmDiscard={() => true}
			onDomainChanged={handleSourceDomainChanged}
			onPlacement={annotationMode === 'round' || activeHoleId ? handleAnnotationPlacement : undefined}
			claimPointer={claimAnnotationPointer}
			onClaimedPointerMove={previewAnnotationMove}
			onClaimedPointerUp={commitAnnotationPointerUp}
			onClaimedPointerCancel={cancelAnnotationPointer}
			toolsAriaLabel={null}
			focusRequest={sidebarFocusRequest}
		>
			{#snippet headerActions()}
				{#if activeHole()}
					{@const hole = activeHole()!}
					<label class="header-width-control">
						<span>Corridor width</span>
						<input
							type="number"
							min="1"
							step="1"
							value={hole.corridorWidthPx}
							onchange={handleCorridorWidthChange}
							data-testid="corridor-width"
						/>
					</label>
				{/if}
			{/snippet}
			{#snippet tools()}
				{#if activeHole()}
					{@const hole = activeHole()!}
					<div class="tool-section">
						<h2>Edit hole {hole.number}</h2>
						{#if annotationMode === 'map'}
							<p class="empty-copy">Click the map to open the point menu — place a tee, basket, or bend, or delete an existing one.</p>
						{:else}
							<p class="empty-copy">Click the map to open the point menu — place a shot or a walk-path vertex, or delete an existing one.</p>
						{/if}
						<div class="edit-actions">
							<button type="button" data-testid="remove-last-shot" disabled={hole.shots.length === 0} onclick={handleRemoveLastShot}>Undo shot</button>
							<button type="button" data-testid="remove-last-bend" disabled={hole.corridorBends.length === 0} onclick={handleRemoveLastBend}>Undo bend</button>
							<button type="button" data-testid="clear-bends" disabled={hole.corridorBends.length === 0} onclick={handleClearBends}>Clear bends</button>
						</div>
					</div>
				{/if}

				{#if sourceImage() && annotationMode === 'map'}
					<div class="tool-section hole-sidebar" data-testid="hole-sidebar">
						<div class="thresh-row">
							<label for="min-usefulness-input">Min usefulness</label>
							<input
								type="range"
								id="min-usefulness-input"
								min="0"
								max="0.95"
								step="0.05"
								value={minAutoSuggestScore}
								disabled={!applyDetectionThreshold}
								aria-label="Minimum usefulness for auto-applying detected tee/basket pieces"
								data-testid="min-usefulness-input"
								oninput={handleMinAutoSuggestScoreInput}
							/>
							<span class="thresh-val">{Math.round(minAutoSuggestScore * 100)}%</span>
							<label class="thresh-toggle" class:active={applyDetectionThreshold}>
								<input
									type="checkbox"
									checked={applyDetectionThreshold}
									onchange={handleApplyDetectionThresholdToggle}
									data-testid="apply-detection-threshold-toggle"
								/>
								Filter
							</label>
						</div>

						{#if courseDetectionStatus}
							<p
								class="detection-progress"
								data-testid="course-detection-controls-progress"
								data-running={courseDetectionRunning ? 'true' : 'false'}
								role="status"
							>
								<span class="progress-dot" class:running={courseDetectionRunning} aria-hidden="true"></span>
								<span class="progress-copy">{courseDetectionStatus}</span>
								{#if courseDetectionRunning}<span class="progress-time">{courseDetectionElapsedSeconds}s</span>{/if}
							</p>
						{/if}
						{#if courseDetectionError}
							<p class="tool-error" data-testid="course-detection-error" role="alert">{courseDetectionError}</p>
						{/if}
						{#if groundTruthToolsEnabled}
							<button
								type="button"
								class="apply-button"
								data-testid="assign-ground-truth"
								disabled={courseDetectionRunning || !sourceImage() || !groundTruthMatchesImage(sourceImage()!)}
								onclick={handleAssignGroundTruth}
							>
								Assign ground truth · 18 pads · 18 baskets · 18 badges
							</button>
						{/if}

						{#if allHolesConfirmed}
							<div class="done-panel" data-testid="course-complete-panel">
								<h3>Course complete</h3>
								<p>All 18 holes have confirmed tee and basket placements.</p>
								<div class="stack">
									<button
										type="button"
										class="save-course-button"
										data-testid="save-course-to-memory"
										disabled={savingCourseToMemory}
										onclick={() => void handleSaveCourseToMemory()}
									>
										{savingCourseToMemory ? 'Saving…' : savedCourseToMemory ? 'Saved to memory ✓' : 'Save course to memory'}
									</button>
									<button
										type="button"
										class="upload-round-button"
										data-testid="upload-round-from-course"
										disabled={!savedCourseToMemory || doneRunning}
										title={savedCourseToMemory ? undefined : 'Save the course first'}
										onclick={() => void handleUploadRoundFromCourse()}
									>
										Upload a round from this course →
									</button>
								</div>
							</div>
						{:else}
							{#each [1, 2, 3, 4, 5] as const as section (section)}
								<div class="grid-section sec{section}" data-testid="sidebar-section-{section}">
									<div class="grid-head">
										<h3>{SIDEBAR_SECTION_LABELS[section]}</h3>
										<span class="count">{sidebarSections[section].length}</span>
									</div>
									{#if sidebarSections[section].length === 0}
										<p class="empty-note">none</p>
									{:else}
										<div class="hole-grid">
											{#each sidebarSections[section] as number (number)}
												{@const hole = holes.find((candidate) => candidate.number === number)}
												<button
													type="button"
													class="hbox"
													class:active={hole?.id === activeHoleId}
													data-testid="sidebar-hole-{number}"
													onclick={() => onHoleBoxClick(number)}
												>
													<span class="num">{number}</span>
													<span class="tb">
														<span class={hole?.tee ? (isPieceConfirmed(hole.id, 'tee') ? 'confirmed' : 'pending') : ''}>T</span>
														<span class={hole?.basket ? (isPieceConfirmed(hole.id, 'basket') ? 'confirmed' : 'pending') : ''}>B</span>
													</span>
												</button>
											{/each}
										</div>
									{/if}
								</div>
							{/each}
						{/if}
					</div>
				{/if}
			{/snippet}

			{#snippet diagnostics()}
				<div class="diagnostics-panel" data-testid="annotation-diagnostics">
					<div class="diagnostics-panel-header">
						<h2>Diagnostics</h2>
						<button
							type="button"
							class="diagnostics-rail-toggle"
							data-testid="diagnostics-rail-toggle"
							aria-expanded={diagnosticsRailExpanded}
							aria-controls="diagnostics-rail-body"
							aria-label={diagnosticsRailExpanded ? 'Collapse diagnostics panel' : 'Expand diagnostics panel'}
							onclick={toggleDiagnosticsRail}
						>
							<span aria-hidden="true">{diagnosticsRailExpanded ? '»' : '«'}</span>
						</button>
					</div>
					{#if diagnosticsRailExpanded}
					<div id="diagnostics-rail-body" class="diagnostics-panel-body">
						<div class="diagnostics-live-heading">
							<span>Ranked review queue</span>
							<span class="diagnostics-live-indicator" class:running={courseDetectionRunning} role="status">
								<span class="diagnostics-live-dot" aria-hidden="true"></span>
								{courseDetectionRunning ? 'Updating' : 'Live'}
							</span>
						</div>
						{#if courseDetectionStatus}
							<p class="diagnostics-live-status" data-testid="course-detection-progress" role="status">
								{courseDetectionStatus} · {courseDetectionElapsedSeconds}s
							</p>
						{/if}
						<ol
							class="diagnostic-feature-list"
							data-testid="diagnostics-live-list"
							aria-label="Ranked features for review"
							aria-live="polite"
						>
							{#each liveDiagnosticFeatures as feature, index (feature.id)}
								<li
									class="diagnostic-feature"
									class:attention={feature.state === 'attention'}
									class:clear={feature.state === 'clear'}
									class:live={feature.state === 'live'}
									class:waiting={feature.state === 'waiting'}
									data-testid="diagnostic-feature-{feature.id}"
								>
									<span class="diagnostic-feature-rank" aria-hidden="true">{index + 1}</span>
									<span class="diagnostic-feature-copy">
										<strong>{feature.label}</strong>
										<span>{feature.summary}</span>
										<small>{feature.detail}</small>
									</span>
									<span class="diagnostic-feature-state">{feature.state === 'attention' ? 'Mark next' : feature.state === 'live' ? 'Updating' : feature.state === 'clear' ? 'Clear' : 'Waiting'}</span>
								</li>
							{/each}
						</ol>
						<div class="diagnostics-legacy" aria-hidden="true">
					{#if courseDetectionStatus}
						<p class="detection-progress" data-testid="course-detection-progress" role="status">
							<span class="progress-dot" class:running={courseDetectionRunning} aria-hidden="true"></span>
							<span class="progress-copy">{courseDetectionStatus}</span>
							<span class="progress-time">{courseDetectionElapsedSeconds}s</span>
						</p>
					{/if}
					{#if courseDetection}
						{@const assignedNumbers = courseDetection.numberDetection.candidates.filter((candidate) => candidate.label !== undefined).length}
						{@const readyHoles = courseDetection.grammar.holes.filter((proposal) => proposal.status === 'ready').length}
						<p class="detection-summary" data-testid="course-detection-summary">
							{assignedNumbers} numbers · {courseDetection.tees.length} tees · {courseDetection.baskets.length} baskets · {readyHoles} ready
						</p>
						{#if courseDetection.numberDetection.note}
							<p class="tool-note">{courseDetection.numberDetection.note}</p>
						{/if}
						{#if courseDetection.numberDetection.candidates.some((candidate) => candidate.topGlyphMatches?.length)}
							<details class="number-diagnostics">
								<summary>Number classifier diagnostics</summary>
								<p class="diagnostic-help">Raw top 3 are independent glyph scores. Assigned is the forced one-to-one Hungarian result.</p>
								<div class="diagnostic-list">
									{#each courseDetection.numberDetection.candidates as candidate, index (index)}
										{@const candidateId = candidate.diagnosticId ?? index + 1}
										{@const rawMatches = candidate.topGlyphMatches ?? []}
										{@const forcedAssignment = candidate.label !== undefined && rawMatches[0] !== undefined && rawMatches[0].label !== candidate.label}
										<div class="diagnostic-row" class:forced={forcedAssignment}>
											<strong>C{candidateId}</strong>
											<span class="diagnostic-assigned">assigned {candidate.label !== undefined ? `H${candidate.label}` : '—'}</span>
											<span class="diagnostic-raw">raw {#each rawMatches as match, matchIndex (match.label)}{matchIndex > 0 ? ' · ' : ' '}H{match.label} {(match.score * 100).toFixed(0)}%{/each}</span>
										</div>
									{/each}
								</div>
							</details>
						{/if}
					{/if}
					</div>
					</div>
					{/if}
				</div>
			{/snippet}

			{#snippet overlay({ image, zoom })}
				<svg class="annotation-overlay" viewBox={`0 0 ${image.widthPx} ${image.heightPx}`} aria-hidden="true">
					{#each visibleHoles as overlayHole (overlayHole.id)}
						{@const band = deriveCorridorBand(overlayHole)}
						{#if band}
							<polygon points={band.map((point) => `${point.xPx},${point.yPx}`).join(' ')} class="corridor" class:active={overlayHole.id === activeHoleId} data-testid="corridor-band-{overlayHole.number}" />
						{/if}
						{@const centerline = deriveCorridorCenterline(overlayHole)}
						{#if centerline.length >= 2}
							<polyline points={centerline.map((point) => `${point.xPx},${point.yPx}`).join(' ')} class="corridor-centerline" data-testid="corridor-centerline-{overlayHole.number}" />
						{/if}
						{#each overlayHole.corridorBends as bend, index (index)}
							<circle
								cx={bend.xPx}
								cy={bend.yPx}
								r={5 / zoom}
								class="bend-marker"
								class:dimmed={annotationMode === 'round'}
								class:radial-target={isRadialTarget(overlayHole.id, 'bend', { index })}
								data-testid="bend-marker-{overlayHole.number}-{index}"
							/>
						{/each}
						{#if overlayHole.tee && overlayHole.basket}
							<line x1={overlayHole.tee.xPx} y1={overlayHole.tee.yPx} x2={overlayHole.basket.xPx} y2={overlayHole.basket.yPx} class="guide" />
						{/if}
						{#each overlayHole.shots as shot, index (shot.id)}
							{@const from = index === 0 ? overlayHole.tee : overlayHole.shots[index - 1].landing}
							{#if from}<line x1={from.xPx} y1={from.yPx} x2={shot.landing.xPx} y2={shot.landing.yPx} class="guide" />{/if}
						{/each}
						{#if overlayHole.tee}
							<circle
								cx={overlayHole.tee.xPx}
								cy={overlayHole.tee.yPx}
								r={7 / zoom}
								class="tee-marker"
								class:dimmed={annotationMode === 'round'}
								class:radial-target={isRadialTarget(overlayHole.id, 'tee')}
								class:settling={settlingMarkerKeys.has(localSnapKey('tee', overlayHole.id))}
								data-testid="tee-marker-{overlayHole.number}"
							/>
							<text
								x={overlayHole.tee.xPx}
								y={overlayHole.tee.yPx - 12 / zoom}
								text-anchor="middle"
								class="point-hole-label"
								style={`font-size:${10 / zoom}px`}
							>{overlayHole.number}</text>
						{/if}
						{#if overlayHole.basket}
							<circle
								cx={overlayHole.basket.xPx}
								cy={overlayHole.basket.yPx}
								r={7 / zoom}
								class="basket-marker"
								class:dimmed={annotationMode === 'round'}
								class:radial-target={isRadialTarget(overlayHole.id, 'basket')}
								class:settling={settlingMarkerKeys.has(localSnapKey('basket', overlayHole.id))}
								data-testid="basket-marker-{overlayHole.number}"
							/>
							<text
								x={overlayHole.basket.xPx}
								y={overlayHole.basket.yPx - 12 / zoom}
								text-anchor="middle"
								class="point-hole-label"
								style={`font-size:${10 / zoom}px`}
							>{overlayHole.number}</text>
						{/if}
						{#each overlayHole.shots as shot, index (shot.id)}
							<circle
								cx={shot.landing.xPx}
								cy={shot.landing.yPx}
								r={6 / zoom}
								class="shot-marker"
								class:dimmed={annotationMode === 'map'}
								class:radial-target={isRadialTarget(overlayHole.id, 'shot', { shotId: shot.id })}
								data-testid="shot-marker-{overlayHole.number}-{index}"
							/>
						{/each}
					{/each}
					{#if visibleWalkingPath.length >= 2}
						<polyline
							points={visibleWalkingPath.map((point) => `${point.xPx},${point.yPx}`).join(' ')}
							class="walk-path"
							class:dimmed={annotationMode === 'map'}
							stroke-width={4 / zoom}
							data-testid="walk-path"
						/>
					{/if}
					{#each visibleWalkingPath as point, index (index)}
						<circle
							cx={point.xPx}
							cy={point.yPx}
							r={5 / zoom}
							class="walk-vertex"
							class:dimmed={annotationMode === 'map'}
							class:radial-target={isRadialTarget(null, 'walk', { index })}
							data-testid="walk-vertex-{index}"
						/>
					{/each}
					{#if courseDetection}
						{#each courseDetection.grammar.holes as proposal (proposal.number)}
							{#if proposal.numberBadge && proposal.tee}
								<line
									x1={proposal.numberBadge.xPx}
									y1={proposal.numberBadge.yPx}
									x2={proposal.tee.xPx}
									y2={proposal.tee.yPx}
									class="grammar-link-candidate revealed"
									data-testid="grammar-link-{proposal.number}-badge-tee"
								/>
							{/if}
							{#if proposal.tee && proposal.basket}
								<line
									x1={proposal.tee.xPx}
									y1={proposal.tee.yPx}
									x2={proposal.basket.xPx}
									y2={proposal.basket.yPx}
									class="grammar-link-candidate revealed"
									data-testid="grammar-link-{proposal.number}-tee-basket"
								/>
							{/if}
						{/each}
						{#each courseDetection.numberDetection.candidates as candidate, index (index)}
							{@const candidateId = candidate.diagnosticId ?? index + 1}
							{@const rawTopMatch = candidate.topGlyphMatches?.[0]}
							{@const forcedAssignment = candidate.label !== undefined && rawTopMatch !== undefined && rawTopMatch.label !== candidate.label}
							<g
								class="number-candidate-marker revealed"
								class:forced-assignment={forcedAssignment}
								class:selected-hole={candidate.label !== undefined && candidate.label === activeHole()?.number}
								class:tappable={candidate.label !== undefined}
								data-testid="number-candidate-{candidateId}"
							>
								<rect
									x={candidate.xPx - candidate.widthPx / 2}
									y={candidate.yPx - candidate.heightPx / 2}
									width={candidate.widthPx}
									height={candidate.heightPx}
									rx={2 / zoom}
								/>
								<text
									x={candidate.xPx}
									y={candidate.yPx - candidate.heightPx / 2 - 5 / zoom}
									text-anchor="middle"
									class="number-candidate-label"
									style={`font-size:${11 / zoom}px`}
								>
									{#if candidate.label !== undefined}
										H{candidate.label}
									{:else}
										C{candidateId} · {(candidate.score * 100).toFixed(0)}%
									{/if}
								</text>
							</g>
						{/each}
					{/if}
				</svg>
			{/snippet}

			{#snippet popover({ view, paneSize })}
				<div class="course-detection-overlay">
					{#if courseDetectionRunning}
						<p
							class="course-detection-strip"
							data-testid="course-detection-status-strip"
							role="status"
							aria-live="polite"
						>
							<span class="progress-dot running" aria-hidden="true"></span>
							{compactDetectionStageCopy(courseDetectionStage)}
						</p>
					{/if}
				</div>

				{#if sidebarBanner}
					<div class="placement-banner" class:approve={sidebarBanner.kind === 'approve'} data-testid="placement-banner" role="status">
						{#if sidebarBanner.kind === 'placing'}
							<span><strong>Placing Hole {sidebarBanner.holeNumber} — {sidebarBanner.piece}.</strong> Click empty map to place. Click any existing marker to fix it.</span>
							<button type="button" class="banner-close" data-testid="placement-banner-cancel" onclick={exitSidebarFocus}>Cancel</button>
						{:else if sidebarBanner.kind === 'approve'}
							<span><strong>Reviewing Hole {sidebarBanner.holeNumber}.</strong> Drag either marker to adjust, then Approve.</span>
							<button type="button" class="banner-close" data-testid="placement-banner-cancel" onclick={exitSidebarFocus}>Cancel</button>
						{:else}
							<span>Hole {sidebarBanner.holeNumber} is confirmed.</span>
							<button type="button" class="banner-close" data-testid="placement-banner-close" onclick={exitSidebarFocus}>Close</button>
						{/if}
					</div>
				{/if}

				{#if sidebarBanner?.kind === 'approve'}
					{@const hole = holes.find((candidate) => candidate.id === activeHoleId)}
					{#if hole?.tee && hole.basket}
						{@const midpoint = { xPx: (hole.tee.xPx + hole.basket.xPx) / 2, yPx: (hole.tee.yPx + hole.basket.yPx) / 2 }}
						{@const anchor = imageToScreen(midpoint, view)}
						<button
							type="button"
							class="approve-hole-button"
							data-testid="approve-hole-button"
							style={`left:${anchor.x}px; top:${anchor.y}px;`}
							onclick={approveActiveHole}
						>
							✓ Approve Hole {hole.number}
						</button>
					{/if}
				{/if}

				{#if markerChip}
					{@const anchor = imageToScreen(markerChip.point, view)}
					{@const activeNumber = holes.find((candidate) => candidate.id === activeHoleId)?.number}
					<div
						bind:this={markerChipEl}
						class="marker-chip"
						data-testid="marker-chip"
						style={`left:${anchor.x}px; top:${anchor.y}px;`}
					>
						<div class="chip-head">Hole {markerChip.holeNumber} · {markerChip.kind === 'tee' ? 'Tee' : 'Basket'}</div>
						<div class="chip-sub">{isPieceConfirmed(markerChip.holeId, markerChip.kind) ? 'confirmed' : 'pending'}</div>
						<div class="chip-stack">
							{#if activeHoleId && activeHoleId !== markerChip.holeId && activeNumber !== undefined}
								{@const quickTargetHoleId = activeHoleId}
								<button
									type="button"
									class="chip-quick-reassign"
									data-testid="marker-chip-quick-reassign"
									onclick={() => reassignFromChip(quickTargetHoleId)}
								>
									Reassign to Hole {activeNumber} (active)
								</button>
							{/if}
							<div class="chip-reassign-row">
								<span>Reassign to hole</span>
								<input
									type="number"
									min="1"
									max="999"
									bind:value={markerChipReassignInput}
									aria-label="Reassign to hole number"
									data-testid="marker-chip-reassign-input"
								/>
								<button type="button" data-testid="marker-chip-reassign-go" onclick={reassignFromChipInput}>Go</button>
							</div>
							<div class="chip-divider"></div>
							<button type="button" class="chip-delete" data-testid="marker-chip-delete" onclick={deleteFromChip}>
								Delete — not a real {markerChip.kind}
							</button>
							<button type="button" class="chip-dismiss" data-testid="marker-chip-dismiss" onclick={closeMarkerChip}>Dismiss</button>
						</div>
					</div>
				{/if}

				{#if radialMenu}
					{@const menu = radialMenu}
					{@const anchor = imageToScreen(menu.at, view)}
					{#key `${menu.holeId}|${menu.hitMarker?.kind ?? ''}|${menu.hitMarker?.index ?? ''}|${menu.hitMarker?.shotId ?? ''}|${menu.at.xPx}|${menu.at.yPx}`}
						<RadialMenu
							{anchor}
							bounds={paneSize}
							actions={radialMenuButtons(menu)}
							onSelect={(id) => chooseRadialAction(menu, id as RadialAction)}
							onClose={(reason) => closeRadialMenu(menu, reason)}
						/>
					{/key}
				{/if}
			{/snippet}
		</ImageEditorPane>
	</div>

	{#if pendingLibraryUpdateConfirm}
		<div class="dialog-backdrop">
			<div
				class="dialog"
				role="dialog"
				aria-modal="true"
				aria-label="Update saved course?"
				data-testid="library-update-dialog"
				use:dialogKeyboard={() => settleLibraryUpdateConfirm(false)}
			>
				<h2>Update saved course?</h2>
				<p>
					Your Map-mode edits will replace the stored tee/basket/corridor geometry for “{pendingLibraryUpdateConfirm.entry.name}”.
					Either choice continues on to Create Graphics.
				</p>
				<div class="dialog-actions">
					<button
						type="button"
						data-testid="library-update-keep"
						bind:this={libraryUpdateKeepButton}
						onclick={() => settleLibraryUpdateConfirm(false)}
					>
						Keep saved version
					</button>
					<button
						type="button"
						class="primary"
						data-testid="library-update-confirm"
						onclick={() => settleLibraryUpdateConfirm(true)}
					>
						Update saved course
					</button>
				</div>
			</div>
		</div>
	{/if}

	<footer class="dev-tools-footer">
		<label class="dev-tools-toggle" class:active={radialMenuEnabled}>
			<input
				type="checkbox"
				checked={radialMenuEnabled}
				onchange={() => (radialMenuEnabled = !radialMenuEnabled)}
				data-testid="radial-menu-toggle"
			/>
			Manual placement (radial menu)
		</label>
		<label class="dev-tools-toggle" class:active={groundTruthToolsEnabled}>
			<input
				type="checkbox"
				checked={groundTruthToolsEnabled}
				onchange={() => (groundTruthToolsEnabled = !groundTruthToolsEnabled)}
				data-testid="ground-truth-tools-toggle"
			/>
			Ground truth tools
		</label>
	</footer>
</main>

<style>
	main {
		font-family: system-ui, sans-serif;
		padding: 1rem;
		padding-bottom: max(1rem, env(safe-area-inset-bottom));
		padding-left: max(1rem, env(safe-area-inset-left));
		padding-right: max(1rem, env(safe-area-inset-right));
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
		min-height: 100vh;
	}

	:global(button:focus-visible),
	:global(input:focus-visible) {
		outline: 3px solid #38bdf8;
		outline-offset: 2px;
	}

	:global(button) {
		touch-action: manipulation;
	}

	:global(button:disabled) {
		cursor: not-allowed;
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

	.draft-actions {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-wrap: wrap;
	}

	.dirty {
		padding: 0.15rem 0.5rem;
		border-radius: 999px;
		background: #fff3cd;
		border: 1px solid #e0c35a;
		color: #6b5300;
		font-size: 0.8rem;
	}

	.activity-status {
		min-height: 0;
	}

	.status {
		margin: 0;
		font-size: 0.85rem;
		opacity: 0.85;
	}

	.file-input {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip: rect(0 0 0 0);
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

	.dialog-actions button.primary {
		border-color: #2563eb;
		background: #2563eb;
		color: #fff;
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

	.error {
		margin: 0;
		padding: 0.4rem 0.6rem;
		border-radius: 4px;
		background: #fdecea;
		border: 1px solid #f5c6cb;
		color: #8a1f11;
		font-size: 0.85rem;
	}

	.hole-list {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.annotation-overlay {
		position: absolute;
		top: 0;
		left: 0;
		pointer-events: none;
	}

	.corridor {
		fill: rgb(42 109 244 / 15%);
		stroke: rgb(42 109 244 / 60%);
		stroke-width: 1.5;
	}

	.corridor.active {
		fill: rgb(42 109 244 / 28%);
		stroke: #2a6df4;
		stroke-width: 2;
	}

	.corridor-centerline {
		fill: none;
		stroke: rgb(255 255 255 / 85%);
		stroke-width: 2;
		stroke-dasharray: 5 4;
	}

	.bend-marker {
		fill: #a78bfa;
		stroke: #2e1065;
		stroke-width: 1;
	}

	.header-width-control {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.25rem 0.45rem;
		border: 1px solid #52525b;
		border-radius: 5px;
		background: #202024;
		font-size: 0.72rem;
		color: #d4d4d8;
		white-space: nowrap;
	}

	.header-width-control input {
		width: 4.5rem;
		min-height: 2rem;
		padding: 0.3rem 0.45rem;
		border: 1px solid #71717a;
		border-radius: 5px;
		background: #18181b;
		color: #f4f4f5;
		font: inherit;
		font-size: 1rem;
		text-align: right;
	}

	.guide {
		stroke: rgb(255 255 255 / 70%);
		stroke-width: 1.5;
		stroke-dasharray: 4 3;
	}

	.tee-marker {
		fill: #22c55e;
		stroke: #063d1e;
		stroke-width: 1;
	}

	/*
	 * Snap-to-detection (design point 4): while `.settling`, cx/cy transitions
	 * smoothly from the raw click to the snapped point instead of jumping.
	 * Scoped to the class (not the bare marker) so an ordinary drag-move never
	 * animates — only this deliberate raw-to-snapped settle does. Reduced
	 * motion never applies this class at all (see `settleLocalSnap`), so no
	 * `@media (prefers-reduced-motion: reduce)` override is needed here.
	 */
	.tee-marker.settling,
	.basket-marker.settling {
		transition:
			cx 100ms ease,
			cy 100ms ease;
	}

	.number-candidate-marker rect {
		fill: rgb(244 63 94 / 16%);
		stroke: #fb7185;
		stroke-width: 2;
		vector-effect: non-scaling-stroke;
	}

	.number-candidate-marker.forced-assignment rect {
		fill: rgb(245 158 11 / 16%);
		stroke: #f59e0b;
	}

	.number-candidate-marker.forced-assignment .number-candidate-label {
		fill: #fde68a;
	}

	.number-candidate-marker.tappable rect {
		cursor: pointer;
	}

	.number-candidate-marker.selected-hole rect {
		fill: rgb(59 130 246 / 22%);
		stroke: #60a5fa;
		stroke-width: 3;
	}

	.number-candidate-label {
		fill: #fecdd3;
		stroke: #18181b;
		stroke-width: 3px;
		paint-order: stroke fill;
		font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
		font-weight: 700;
		pointer-events: none;
	}

	.basket-marker {
		fill: #ef4444;
		stroke: #450a0a;
		stroke-width: 1;
	}

	.shot-marker {
		fill: #f59e0b;
		stroke: #451a03;
		stroke-width: 1;
	}

	/* Matches the reserved walkingPathColor default theme in $lib/graphics/style.ts. */
	.walk-path {
		fill: none;
		stroke: rgba(147, 51, 234, 0.8);
	}

	.walk-vertex {
		fill: rgba(147, 51, 234, 0.9);
		stroke: #2e1065;
		stroke-width: 1;
	}

	.dimmed {
		opacity: 0.45;
	}

	.tool-section {
		display: flex;
		flex-direction: column;
		gap: 0.55rem;
		padding-bottom: 0.85rem;
		margin-bottom: 0.85rem;
		border-bottom: 1px solid #3f3f46;
	}

	.tool-section:last-child {
		margin-bottom: 0;
		border-bottom: 0;
	}

	.tool-section h2 {
		margin: 0;
		font-size: 0.82rem;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: #d4d4d8;
	}

	.empty-copy {
		margin: 0;
		color: #a1a1aa;
		font-size: 0.75rem;
	}

	.tool-section button {
		min-height: 2.5rem;
		border: 1px solid #52525b;
		border-radius: 5px;
		background: #27272a;
		color: #f4f4f5;
		padding: 0.4rem 0.55rem;
		cursor: pointer;
	}

	.tool-section button:disabled {
		opacity: 0.4;
	}

	.edit-actions {
		display: grid;
		gap: 0.35rem;
	}

	.apply-button {
		width: 100%;
		border-color: #2563eb !important;
		background: #1d4ed8 !important;
	}

	.tool-error {
		margin: 0;
		color: #fca5a5;
		font-size: 0.75rem;
	}

	.detection-summary,
	.tool-note {
		margin: 0;
		font-size: 0.75rem;
		line-height: 1.35;
	}

	.detection-summary {
		color: #d4d4d8;
	}

	.detection-progress {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr) auto;
		align-items: center;
		gap: 0.45rem;
		margin: 0;
		padding: 0.5rem 0.55rem;
		border: 1px solid #3f3f46;
		border-radius: 5px;
		background: #18181b;
		font-size: 0.72rem;
		line-height: 1.25;
		color: #d4d4d8;
	}

	.progress-dot {
		width: 0.55rem;
		height: 0.55rem;
		border-radius: 999px;
		background: #22c55e;
	}

	.progress-dot.running {
		background: #f59e0b;
		animation: cv-pulse 0.9s ease-in-out infinite alternate;
	}

	.progress-copy {
		min-width: 0;
		white-space: normal;
		overflow-wrap: anywhere;
	}

	.progress-time {
		font-variant-numeric: tabular-nums;
		color: #a1a1aa;
	}

	@keyframes cv-pulse {
		from {
			opacity: 0.35;
			transform: scale(0.8);
		}
		to {
			opacity: 1;
			transform: scale(1.2);
		}
	}

	.hole-bar {
		display: flex;
		align-items: stretch;
		flex-wrap: wrap;
		gap: 0.35rem;
		padding: 0.35rem;
		border: 1px solid #34343a;
		border-radius: 8px;
		background: #18181b;
	}

	.hole-bar-grid {
		flex: 1 1 100%;
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(2.5rem, 1fr));
		gap: 0.35rem;
		min-width: 0;
	}

	.hole-tab {
		position: relative;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 0.1rem;
		min-height: 2.15rem;
		padding: 0.18rem 0.25rem;
		border: 1px solid #3f3f46;
		border-radius: 5px;
		background: #27272a;
		color: #a1a1aa;
		font-variant-numeric: tabular-nums;
		touch-action: manipulation;
	}

	.hole-tab:disabled {
		opacity: 0.5;
	}

	.hole-tab.populated {
		border-color: #52525b;
		color: #f4f4f5;
	}

	.hole-tab.selected {
		border-color: #60a5fa;
		background: rgb(37 99 235 / 25%);
		box-shadow: inset 0 0 0 1px #2563eb;
	}

	.hole-indicators {
		display: inline-flex;
		align-items: center;
		gap: 0.12rem;
		font-size: 0.62rem;
		font-weight: 700;
	}

	.hole-indicators span {
		color: #71717a;
	}

	.hole-indicators span.present {
		color: #4ade80;
	}

	.extra-hole-tabs {
		display: flex;
		align-items: center;
		gap: 0.35rem;
	}

	.extra-hole-tabs {
		flex-basis: 100%;
		justify-content: flex-start;
		padding-top: 0.35rem;
		border-top: 1px solid #34343a;
	}

	.extra-hole-tabs .hole-tab {
		min-width: 4.5rem;
	}

	.tool-note {
		color: #fcd34d;
	}

	.number-diagnostics {
		border: 1px solid #3f3f46;
		border-radius: 5px;
		background: #18181b;
	}

	.number-diagnostics summary {
		padding: 0.5rem 0.55rem;
		cursor: pointer;
		font-size: 0.75rem;
		font-weight: 650;
		color: #e4e4e7;
	}

	.diagnostic-help {
		margin: 0;
		padding: 0 0.55rem 0.45rem;
		font-size: 0.68rem;
		line-height: 1.35;
		color: #a1a1aa;
	}

	.diagnostic-list {
		display: flex;
		flex-direction: column;
		max-height: 22rem;
		overflow: auto;
		border-top: 1px solid #3f3f46;
	}

	.diagnostic-row {
		display: grid;
		grid-template-columns: 2rem 5.6rem minmax(0, 1fr);
		gap: 0.35rem;
		align-items: baseline;
		padding: 0.35rem 0.5rem;
		border-bottom: 1px solid #2b2b30;
		font-size: 0.68rem;
		font-variant-numeric: tabular-nums;
	}

	.diagnostic-row:last-child {
		border-bottom: 0;
	}

	.diagnostic-row.forced {
		background: rgb(245 158 11 / 10%);
	}

	.diagnostic-row.forced > strong,
	.diagnostic-row.forced .diagnostic-assigned {
		color: #fbbf24;
	}

	.diagnostic-assigned {
		color: #fda4af;
	}

	.diagnostic-raw {
		min-width: 0;
		color: #d4d4d8;
		white-space: normal;
	}

	.annotation-overlay {
		width: 100%;
		height: 100%;
	}

	/* Keep side regions bounded so diagnostic/control content cannot resize the image region. */
	:global(.editor-body.with-tools) {
		grid-template-columns: minmax(15rem, 18rem) minmax(0, 1fr) minmax(18rem, 20rem) !important;
		min-height: min(78vh, 900px);
	}

	:global(.tools) {
		min-width: 0;
	}

	:global(.tools .number-diagnostics),
	:global(.tools [data-testid='course-detection-controls-summary']),
	:global(.tools [data-testid='course-detection-controls-progress']),
	:global(.tools .tool-note) {
		display: none;
	}

	.diagnostics-panel {
		display: flex;
		flex-direction: column;
		gap: 0.55rem;
		min-width: 0;
	}

	.diagnostics-panel h2 {
		margin: 0;
		font-size: 1rem;
	}

	.diagnostics-live-heading {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		font-size: 0.78rem;
		font-weight: 700;
		color: #f4f4f5;
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}

	.diagnostics-live-indicator {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		font-size: 0.68rem;
		font-weight: 650;
		letter-spacing: 0;
		text-transform: none;
		color: #86efac;
	}

	.diagnostics-live-indicator.running {
		color: #fde68a;
	}

	.diagnostics-live-dot {
		width: 0.45rem;
		height: 0.45rem;
		border-radius: 50%;
		background: #22c55e;
		box-shadow: 0 0 0 3px rgb(34 197 94 / 14%);
	}

	.diagnostics-live-indicator.running .diagnostics-live-dot {
		background: #f59e0b;
		box-shadow: 0 0 0 3px rgb(245 158 11 / 14%);
	}

	.diagnostics-live-status {
		margin: 0;
		padding: 0.45rem 0.55rem;
		border: 1px solid #3f3f46;
		border-radius: 5px;
		background: #18181b;
		color: #a1a1aa;
		font-size: 0.72rem;
		line-height: 1.35;
	}

	.diagnostic-feature-list {
		display: flex;
		flex-direction: column;
		gap: 0.45rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.diagnostic-feature {
		display: grid;
		grid-template-columns: 1.55rem minmax(0, 1fr) auto;
		gap: 0.45rem;
		align-items: start;
		padding: 0.55rem;
		border: 1px solid #3f3f46;
		border-radius: 6px;
		background: #18181b;
	}

	.diagnostic-feature.attention {
		border-color: #a16207;
		background: rgb(120 53 15 / 16%);
	}

	.diagnostic-feature.live {
		border-color: #2563eb;
		background: rgb(30 64 175 / 14%);
	}

	.diagnostic-feature.clear {
		border-color: #166534;
		background: rgb(20 83 45 / 14%);
	}

	.diagnostic-feature-rank {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 1.35rem;
		height: 1.35rem;
		border-radius: 50%;
		background: #27272a;
		color: #d4d4d8;
		font-size: 0.7rem;
		font-weight: 750;
	}

	.diagnostic-feature-copy {
		display: flex;
		min-width: 0;
		flex-direction: column;
		gap: 0.12rem;
	}

	.diagnostic-feature-copy strong {
		font-size: 0.76rem;
		color: #f4f4f5;
	}

	.diagnostic-feature-copy > span {
		font-size: 0.73rem;
		font-weight: 650;
		color: #e4e4e7;
	}

	.diagnostic-feature-copy small {
		font-size: 0.67rem;
		line-height: 1.3;
		color: #a1a1aa;
	}

	.diagnostic-feature-state {
		align-self: center;
		font-size: 0.64rem;
		font-weight: 750;
		color: #a1a1aa;
		white-space: nowrap;
	}

	.diagnostic-feature.attention .diagnostic-feature-state {
		color: #fbbf24;
	}

	.diagnostic-feature.live .diagnostic-feature-state {
		color: #93c5fd;
	}

	.diagnostic-feature.clear .diagnostic-feature-state {
		color: #86efac;
	}

	.diagnostics-legacy {
		display: none;
	}

	.dev-tools-footer {
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
		padding: 0.5rem 0.75rem;
	}

	.dev-tools-toggle {
		display: flex;
		align-items: center;
		gap: 0.35rem;
		padding: 0.25rem 0.5rem;
		border-radius: 5px;
		font-size: 0.68rem;
		color: #71717a;
		cursor: pointer;
	}

	.dev-tools-toggle:hover {
		color: #a1a1aa;
	}

	.dev-tools-toggle.active {
		color: #3b82f6;
	}

	.dev-tools-toggle input {
		margin: 0;
	}

	.point-hole-label {
		fill: #fff;
		stroke: #18181b;
		stroke-width: 3px;
		paint-order: stroke fill;
		font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
		font-weight: 700;
		pointer-events: none;
	}

	.tee-marker.radial-target,
	.basket-marker.radial-target,
	.shot-marker.radial-target,
	.bend-marker.radial-target,
	.walk-vertex.radial-target {
		stroke: #f87171;
		stroke-width: 3;
	}

	/* Detection status and the compact information-directed landmark prompt. */
	.course-detection-overlay {
		position: absolute;
		top: 0.75rem;
		left: 0.75rem;
		z-index: 20;
		max-width: min(22rem, calc(100% - 1.5rem));
	}

	.course-detection-strip {
		display: flex;
		align-items: center;
		gap: 0.45rem;
		margin: 0;
		padding: 0.5rem 0.7rem;
		border: 1px solid #3f3f46;
		border-radius: 999px;
		background: #18181bf2;
		box-shadow: 0 6px 16px rgb(0 0 0 / 45%);
		font-size: 0.78rem;
		color: #f4f4f5;
	}

	/* Fade-in for number badges and grammar links once course detection completes. */
	.number-candidate-marker,
	.grammar-link-candidate {
		opacity: 0;
		transition: opacity 220ms ease;
	}

	.number-candidate-marker.revealed,
	.grammar-link-candidate.revealed {
		opacity: 1;
	}

	.grammar-link-candidate {
		stroke: #38bdf8;
		stroke-width: 1.5;
		stroke-dasharray: 2 3;
		pointer-events: none;
	}

	@media (prefers-reduced-motion: reduce) {
		.number-candidate-marker,
		.grammar-link-candidate {
			transition: none;
		}
	}

	/* Small, same-file diagnostics-rail collapse toggle. */
	.diagnostics-panel-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
	}

	.diagnostics-rail-toggle {
		display: flex;
		align-items: center;
		justify-content: center;
		min-width: 1.9rem;
		min-height: 1.9rem;
		border: 1px solid #52525b;
		border-radius: 5px;
		background: #27272a;
		color: #f4f4f5;
		font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
		cursor: pointer;
	}

	.diagnostics-panel-body {
		display: flex;
		flex-direction: column;
		gap: 0.55rem;
		min-width: 0;
	}

	@media (min-width: 1181px) {
		:global(.hole-annotation.diagnostics-collapsed .editor-body.with-tools) {
			grid-template-columns: minmax(15rem, 18rem) minmax(0, 1fr) 2.75rem !important;
		}

		:global(.hole-annotation.diagnostics-collapsed .diagnostics) {
			width: 2.75rem;
			min-width: 2.75rem;
			padding: 0.6rem 0.4rem;
			overflow: hidden;
		}
	}

	@media (max-width: 1180px) {
		:global(.editor-body.with-tools) {
			grid-template-columns: 1fr !important;
		}

		main {
			padding: 0.75rem;
			padding-bottom: max(0.75rem, env(safe-area-inset-bottom));
			padding-left: max(0.75rem, env(safe-area-inset-left));
			padding-right: max(0.75rem, env(safe-area-inset-right));
			gap: 0.75rem;
		}
	}

	/* ---- Redesigned Map-mode sidebar: threshold row, five-section hole grid, completion panel ---- */

	.hole-sidebar {
		gap: 0.7rem;
	}

	.thresh-row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.72rem;
		color: #a1a1aa;
	}

	.thresh-row label {
		white-space: nowrap;
	}

	.thresh-row input[type='range'] {
		flex: 1;
		min-width: 0;
		accent-color: #f59e0b;
	}

	.thresh-val {
		font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
		min-width: 2.4rem;
		text-align: right;
		color: #d4d4d8;
	}

	.thresh-toggle {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		white-space: nowrap;
		cursor: pointer;
	}

	.thresh-toggle.active {
		color: #3b82f6;
	}

	.thresh-toggle input {
		margin: 0;
	}

	.grid-section {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
	}

	.grid-head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 0.5rem;
	}

	.grid-head h3 {
		margin: 0;
		font-size: 0.68rem;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: #a1a1aa;
		font-weight: 700;
	}

	.grid-head .count {
		font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
		font-size: 0.68rem;
		color: #71717a;
	}

	.hole-grid {
		display: grid;
		grid-template-columns: repeat(4, 1fr);
		gap: 0.35rem;
	}

	.hbox {
		aspect-ratio: 1;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 0.15rem;
		border: 1px solid #3f3f46;
		border-radius: 6px;
		background: #27272a;
		color: #f4f4f5;
		cursor: pointer;
		min-height: 0;
		padding: 0;
	}

	.hbox:hover {
		background: #313136;
	}

	.hbox.active {
		outline: 2px solid #f59e0b;
		outline-offset: 1px;
	}

	.hbox .num {
		font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
		font-size: 0.75rem;
	}

	.hbox .tb {
		display: flex;
		gap: 0.2rem;
	}

	.hbox .tb span {
		width: 0.85rem;
		height: 0.85rem;
		border-radius: 2px;
		font-size: 0.5rem;
		font-weight: 700;
		line-height: 0.85rem;
		text-align: center;
		background: #1f1f23;
		color: #71717a;
	}

	.hbox .tb span.pending {
		background: #f59e0b;
		color: #241804;
	}

	.hbox .tb span.confirmed {
		background: #4fd1c5;
		color: #04211f;
	}

	.empty-note {
		margin: 0;
		padding: 0.15rem 0.1rem;
		color: #71717a;
		font-size: 0.7rem;
		font-style: italic;
	}

	.done-panel {
		text-align: center;
		padding: 1rem 0.8rem;
		border: 1px solid #2e5c48;
		border-radius: 8px;
		background: #0f2320;
	}

	.done-panel h3 {
		margin: 0 0 0.35rem;
		font-size: 0.9rem;
		color: #4fd1c5;
	}

	.done-panel p {
		margin: 0 0 0.85rem;
		font-size: 0.75rem;
		color: #a1a1aa;
	}

	.done-panel .stack {
		display: flex;
		flex-direction: column;
		gap: 0.45rem;
	}

	.save-course-button {
		background: #4fd1c5 !important;
		border-color: #4fd1c5 !important;
		color: #04211f !important;
		font-weight: 650;
	}

	.upload-round-button {
		background: transparent !important;
	}

	/* Placing/approve banner, floating over the map (popover layer, never clipped). */
	.placement-banner {
		position: absolute;
		top: 0.85rem;
		left: 50%;
		transform: translateX(-50%);
		z-index: 26;
		display: flex;
		align-items: center;
		gap: 0.75rem;
		max-width: min(30rem, calc(100% - 1.5rem));
		padding: 0.5rem 0.5rem 0.5rem 0.9rem;
		border: 1px solid #52525b;
		border-radius: 999px;
		background: #18181bf2;
		box-shadow: 0 10px 26px rgb(0 0 0 / 50%);
		font-size: 0.78rem;
		color: #f4f4f5;
		pointer-events: auto;
	}

	.placement-banner strong {
		color: #f59e0b;
	}

	.placement-banner.approve strong {
		color: #4fd1c5;
	}

	.banner-close {
		flex: none;
		min-height: 1.9rem;
		padding: 0.25rem 0.6rem;
		border: 1px solid #52525b;
		border-radius: 999px;
		background: #27272a;
		color: #f4f4f5;
		font-size: 0.72rem;
		cursor: pointer;
	}

	.approve-hole-button {
		position: absolute;
		z-index: 24;
		transform: translate(-50%, -50%);
		min-height: 2.2rem;
		padding: 0.35rem 0.75rem;
		border: 1px solid #4fd1c5;
		border-radius: 999px;
		background: #4fd1c5;
		color: #04211f;
		font-weight: 650;
		font-size: 0.78rem;
		cursor: pointer;
		pointer-events: auto;
		white-space: nowrap;
	}

	/* Marker correction chip — reassign to any hole or delete, opened on any tee/basket marker at any time. */
	.marker-chip {
		position: absolute;
		z-index: 28;
		width: 15rem;
		transform: translate(-50%, calc(-100% - 0.6rem));
		padding: 0.7rem;
		border: 1px solid #f59e0b;
		border-radius: 10px;
		background: #18181b;
		box-shadow: 0 14px 34px rgb(0 0 0 / 55%);
		pointer-events: auto;
	}

	.chip-head {
		font-size: 0.78rem;
		font-weight: 650;
		color: #f4f4f5;
		margin-bottom: 0.1rem;
	}

	.chip-sub {
		font-size: 0.68rem;
		color: #71717a;
		font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
		margin-bottom: 0.6rem;
	}

	.chip-stack {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
	}

	.chip-stack button {
		width: 100%;
		min-height: 2.1rem;
		border: 1px solid #52525b;
		border-radius: 6px;
		background: #27272a;
		color: #f4f4f5;
		font-size: 0.72rem;
		cursor: pointer;
	}

	.chip-quick-reassign {
		border-color: #4fd1c5 !important;
		color: #4fd1c5 !important;
	}

	.chip-reassign-row {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		font-size: 0.7rem;
		color: #a1a1aa;
	}

	.chip-reassign-row input {
		width: 3.4rem;
		min-height: 2rem;
		padding: 0.3rem;
		border: 1px solid #52525b;
		border-radius: 6px;
		background: #0b0d10;
		color: #f4f4f5;
		font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
		text-align: center;
	}

	.chip-divider {
		height: 1px;
		background: #3f3f46;
		margin: 0.1rem 0;
	}

	.chip-delete {
		border-color: #7f1d1d !important;
		color: #f87171 !important;
	}

	.chip-dismiss {
		background: transparent !important;
		color: #a1a1aa;
	}
</style>
