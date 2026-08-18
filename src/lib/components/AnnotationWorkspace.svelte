<script lang="ts">
	import { onDestroy, onMount, tick, untrack } from 'svelte';
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
	import { downloadBlob } from '$lib/persistence';
	import {
		buildCorrectionEvent,
		correctionEventsToExportBlob,
		deriveProposalFromGrammar,
		getDefaultCorrectionLogStore
	} from '$lib/correctionLog';
	import type { CorrectionEndpoint, CorrectionLogStore, CorrectionUserAction } from '$lib/correctionLog';
	import {
		retainEditor,
		takeRetainedEditor,
		consumePendingHandoff,
		getPendingHandoff,
		subscribePendingHandoff,
		markCourseSourceIntake,
		setPendingAnnotatedRound,
		setPendingCourseBadges
	} from '$lib/session';
	import type { PendingHandoff, LabeledPoint, EditorSessionKey } from '$lib/session';
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
	import type { ViewportController } from '$lib/viewport.svelte';
	import { KEYBOARD_PAN_STEP_PX, KEYBOARD_ZOOM_STEP_FACTOR } from '$lib/navigation';
	import { isEditableTarget } from '$lib/pointSelection';
	import { dialogKeyboard, isModalOpen } from '$lib/focusManagement';
	import { historyShortcut } from '$lib/pointListShortcuts';
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
		setCorridorWidth,
		reassignShot,
		reorderShot
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
	import { runRibbonMassShadowPass } from '$lib/autoAnnotation/ribbonMassShadow';
	import {
		deriveShadowRunExperiments,
		getDefaultRibbonMassShadowRunStore,
		shadowRunsToExportBlob
	} from '$lib/autoAnnotation/ribbonMassShadowRun';
	import type {
		ReviewApprovedHole,
		RibbonMassComponentAnnotation,
		RibbonMassConfuserLabel,
		RibbonMassShadowRun
	} from '$lib/autoAnnotation/ribbonMassShadowRun';
	import {
		RIBBON_MASS_CONFUSER_LABELS,
		withComponentAnnotations
	} from '$lib/autoAnnotation/ribbonMassShadowRun';
	import { renderShadowRunOverlay } from '$lib/autoAnnotation/ribbonMassShadowOverlay';
	import type { ShadowOverlayRender } from '$lib/autoAnnotation/ribbonMassShadowOverlay';
	import { cropSourceRasterAroundHole } from '$lib/autoAnnotation/corridorBendDetection';
	import { detectAndApplyCorridorBendsCapsuleAsync } from '$lib/autoAnnotation/corridorBendDetectionCapsuleWorker';
	import { addWalkPoint, moveWalkPoint, removeWalkPoint } from '$lib/walkingPath';
	import type { SourcePoint } from '$lib/domain/project';
	import {
		registerAnnotationNav,
		unregisterAnnotationNav,
		updateAnnotationNav
	} from '$lib/annotationNav.svelte';

	/**
	 * The two annotation activities ChainSpot separates into their own routes:
	 * course geometry (`/annotate-course`, once per course/layout) vs.
	 * round-specific throws and walk path (`/map-round`, once per round).
	 * `mode` is a fixed prop, set once by whichever thin route mounts this
	 * component — there is no in-page control that changes it.
	 */
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

	const MARKER_HIT_RADIUS_PX = 12;
	/**
	 * A hole-number badge's click target. A fixed, UI-owned screen-space
	 * constant -- deliberately NOT derived from the CV candidate's own
	 * detected `widthPx`/`heightPx`. The previous formula
	 * (`Math.max(MARKER_HIT_RADIUS_PX, (Math.max(candidate.widthPx,
	 * candidate.heightPx) / 2) * view.zoom + 10)`) let CV-side geometry --
	 * tuned for detection accuracy, never for touch-target size -- silently
	 * determine how big an on-canvas interaction target was. CV internals
	 * must never leak into interaction sizing; the two are unrelated
	 * concerns tuned for unrelated goals.
	 * TODO: placeholder pending a real accessibility pass (target size,
	 * keyboard reachability -- see docs/13-inch-pass.md item 3). Do not
	 * re-derive this from CV candidate geometry again.
	 */
	const BADGE_HIT_RADIUS_PX = 18;

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
		/** Fixed for the lifetime of this instance — set once by the mounting route, never changed from inside. */
		mode: AnnotationMode;
		/** This instance's slot in the cross-route retained-editor session (`$lib/session.ts`); distinct per route so Annotate Course and Map Round never share an in-memory editor. */
		sessionKey: Extract<EditorSessionKey, 'annotate-course' | 'map-round'>;
		editor?: ProjectEditor;
		decode?: DecodeImageFile;
		hash?: HashBytes;
		download?: DownloadBlob;
		courseLibraryStore?: CourseLibraryStore;
		correctionLogStore?: CorrectionLogStore;
	}

	let {
		mode: annotationMode,
		sessionKey,
		editor: initialEditor,
		decode,
		hash,
		download,
		courseLibraryStore: initialCourseLibraryStore,
		correctionLogStore: initialCorrectionLogStore
	}: Props = $props();

	// An explicitly injected store (tests) wins; otherwise every page instance
	// shares one real IndexedDB connection via the module-level singleton in
	// courseLibrary.ts, matching how smartStitchWorker is shared elsewhere.
	// svelte-ignore state_referenced_locally
	const courseLibraryStore = initialCourseLibraryStore ?? getDefaultCourseLibraryStore();
	// svelte-ignore state_referenced_locally
	const correctionLogStore = initialCorrectionLogStore ?? getDefaultCorrectionLogStore();
	/** Tracks package.json's version manually -- no build-time version injection exists in this project yet. */
	const APP_VERSION = '0.1.0';

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
		return initialEditor ?? takeRetainedEditor(sessionKey) ?? new ProjectEditor();
	}

	onDestroy(() => {
		stopCourseDetectionProgress();
		if (widthFeedbackTimer !== null) {
			clearTimeout(widthFeedbackTimer);
			widthFeedbackTimer = null;
		}
		if (annotationNavRegistration !== null) {
			unregisterAnnotationNav(annotationNavRegistration);
			annotationNavRegistration = null;
		}
		if (participatesInSession) retainEditor(sessionKey, editor);
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

	/**
	 * Two layers on one entry point: the on-marker delete menu (`hitMarker` set)
	 * is always reachable, mirroring how tee/basket already bypass the radial
	 * menu entirely via the marker chip. Only the empty-space placement menu
	 * (bends in Map mode, shot/walk in Round mode) stays behind the
	 * `radialMenuEnabled` dev-tools toggle.
	 */
	function openRadialMenu(state: RadialMenuState): void {
		if (!radialMenuEnabled && state.hitMarker === null) return;
		radialMenu = state;
	}

	// --- Keyboard-first correction workflow (Map mode) -----------------------
	//
	// The hole-number badge is the anchor: it identifies the hole, it is the
	// trusted navigation target (easier to detect than tee/basket geometry and
	// guaranteed to lie on the hole path), and every camera move in this flow
	// centers a badge — never a predicted tee or basket. Per hole the review
	// order is TEE → BASKET → BENDS → next hole's TEE, driven by Tab. The
	// current step decides what an empty-map click places; X rejects the
	// step's obvious proposal; Ctrl-Z reverses workflow history (annotation +
	// workflow + camera state together); WASD/Q/E drive the camera; 1–6 nudge
	// the course-wide corridor width. Left hand on the keyboard, right hand on
	// the mouse — no trips to sidebar buttons during normal review.

	/** The per-hole review step. `bends` doubles as the completed/revisit state. */
	type ReviewStep = 'tee' | 'basket' | 'bends';

	let reviewStep = $state<ReviewStep>('tee');
	/** The mounted `ImageEditorPane`, for direct camera control (`getViewportController`). */
	let editorPane = $state<{ getViewportController: () => ViewportController } | null>(null);
	/** Once-per-image guard for the session-start "activate Hole 1" setup. */
	let reviewStartedSourceId: string | null = null;
	/**
	 * True between session start and the one automatic camera move this flow
	 * ever makes: centering Hole 1's badge at the initial review zoom, as soon
	 * as detection delivers that badge. Cleared by any explicit hole
	 * navigation so a late-arriving badge never yanks the camera away from
	 * work the user already started. After this, zoom is entirely the user's.
	 */
	let initialBadgeFocusPending = $state(false);
	/** The one automatic zoom of the session (fit-zoom multiplier for Hole 1's badge close-up). */
	const INITIAL_REVIEW_ZOOM_MULTIPLIER = 2.5;

	/** Temporary on-map corridor-width feedback (`WIDTH 60 → 63`), so 1–6 need no sidebar glance. `from` is the width before the current burst of keypresses. */
	let widthFeedback = $state<{ from: number; to: number } | null>(null);
	let widthFeedbackTimer: ReturnType<typeof setTimeout> | null = null;
	const WIDTH_FEEDBACK_MS = 1200;
	/** Keyboard corridor-width deltas: 1/2/3 shrink by 5/3/1, 4/5/6 grow by 1/3/5. */
	const CORRIDOR_WIDTH_KEY_DELTAS: Record<string, number> = {
		'1': -5,
		'2': -3,
		'3': -1,
		'4': 1,
		'5': 3,
		'6': 5
	};

	/**
	 * One workflow-undo step: the full annotation + workflow + camera state a
	 * single user action can touch, captured before that action mutates
	 * anything. Deliberately separate from `ProjectEditor`'s own snapshot
	 * history (which only covers durable `ProjectState`): Ctrl-Z here must
	 * also restore the active hole, the review step, per-piece confirmation,
	 * and the viewport — none of which are (or should be) durable domain
	 * state.
	 */
	interface WorkflowSnapshot {
		readonly holes: AnnotatedHole[];
		readonly activeHoleId: string | null;
		readonly reviewStep: ReviewStep;
		readonly confirmedPieces: Set<string>;
		readonly autoProposedBendHoleIds: Set<string>;
		readonly manualBendHoleId: string | null;
		readonly lastManualBendByHoleId: Map<string, SourcePoint>;
		readonly eagerBendAnchorByHoleId: Map<string, { readonly tee: SourcePoint; readonly basket: SourcePoint }>;
		readonly eagerBendAttemptSignature: Map<string, string>;
		readonly bendPhaseDone: boolean;
		readonly mapGeometryEdited: boolean;
		readonly view: ViewTransformState | null;
	}

	/**
	 * Conventional `past[] <- current -> future[]` workflow history (CHSPT-55).
	 * `captureWorkflowSnapshot()` pushes onto `workflowPast` before every
	 * mutating action and clears `workflowFuture` (a fresh edit invalidates any
	 * pending redo trail, standard undo/redo semantics). Ctrl-Z pops
	 * `workflowPast`, pushes the state it's about to overwrite onto
	 * `workflowFuture`, then restores the popped snapshot; Ctrl-Shift-Z/Ctrl-Y
	 * are the exact inverse. See `performWorkflowUndo`/`performWorkflowRedo`.
	 */
	let workflowPast: WorkflowSnapshot[] = [];
	let workflowFuture: WorkflowSnapshot[] = [];
	const WORKFLOW_UNDO_LIMIT = 100;

	function viewportController(): ViewportController | null {
		return editorPane?.getViewportController() ?? null;
	}

	/**
	 * Last pointer position inside the viewport, in viewport-local CSS px —
	 * lets `X` honor its "hovered current-step object first" priority without
	 * a selection click. Plain (non-reactive) bookkeeping; null whenever the
	 * pointer is outside the viewport.
	 */
	let lastPointerScreen: ScreenSpacePoint | null = null;

	function trackReviewPointer(event: PointerEvent): void {
		const controller = viewportController();
		if (!controller?.container || !controller.containsPoint(event)) {
			lastPointerScreen = null;
			return;
		}
		lastPointerScreen = controller.pointerIn(event);
	}

	// --- Ribbon-mass shadow overlay (see `ribbonMassShadowOverlay.ts` and
	// docs/annotate-round-pipeline-debug-view.md's internal-only ground rules).
	// Renders the stored ShadowRun A — display only, never an input to any
	// annotation behavior.
	let shadowOverlayEnabled = $state(false);
	let shadowOverlayRender = $state<ShadowOverlayRender | null>(null);
	// --- MiddleOut ribbon-recovery diagnostic overlay (see middleOutRibbon.ts).
	// Display-only, never an input to any annotation behavior -- same rule as
	// the shadow overlay above. Data is already synchronously present on
	// `courseDetection.middleOut`, so this toggle needs no async refresh.
	let middleOutOverlayEnabled = $state(false);
	function toggleMiddleOutOverlay(): void {
		middleOutOverlayEnabled = !middleOutOverlayEnabled;
	}
	/** The run behind the current overlay — also the target of confuser annotations. */
	let activeShadowRun = $state<RibbonMassShadowRun | null>(null);
	/** Centroid (source px) of the component a hovered annotation row points at. */
	let shadowHighlightCentroid = $state<{ xPx: number; yPx: number } | null>(null);
	/** The run frozen by this session's own detection pass, so the toggle needs no IndexedDB round-trip. */
	let latestShadowRun: RibbonMassShadowRun | null = null;

	async function refreshShadowOverlay(): Promise<void> {
		let run = latestShadowRun;
		const imageId = sourceImage()?.id;
		if ((!run || run.imageId !== imageId) && imageId) {
			// Fall back to the newest stored run for this image (e.g. the
			// toggle was flipped before this session's own pass finished).
			try {
				const runs = await getDefaultRibbonMassShadowRunStore().getAll();
				run =
					runs
						.filter((candidate) => candidate.imageId === imageId)
						.sort((a, b) => b.timestamp.localeCompare(a.timestamp))[0] ?? null;
			} catch {
				run = null;
			}
		}
		activeShadowRun = run;
		shadowOverlayRender = run ? renderShadowRunOverlay(run) : null;
	}

	function toggleShadowOverlay(): void {
		shadowOverlayEnabled = !shadowOverlayEnabled;
		if (shadowOverlayEnabled) void refreshShadowOverlay();
		else {
			shadowOverlayRender = null;
			activeShadowRun = null;
			shadowHighlightCentroid = null;
		}
	}

	/**
	 * The dev annotation list's rows: components the production experiment's
	 * recommended mask keeps, largest first. Component labels are opaque
	 * internal ids (never hole numbers — see the debug-view doc's naming
	 * rule); the hole context comes from `seedOwners`.
	 */
	function shadowAnnotationRows(run: RibbonMassShadowRun): readonly {
		label: number;
		areaPx: number;
		lStd: number;
		centroid: { xPx: number; yPx: number };
		ownerHoles: readonly number[];
		annotation: RibbonMassComponentAnnotation | undefined;
	}[] {
		const kept = new Set(run.experiments.production?.recommended.keptLabels ?? []);
		const ownersByLabel = new Map<number, Set<number>>();
		for (const seed of run.experiments.production?.seedAssignments ?? []) {
			if (seed.componentLabel === null || seed.holeNumber === null) continue;
			(ownersByLabel.get(seed.componentLabel) ??
				ownersByLabel.set(seed.componentLabel, new Set()).get(seed.componentLabel)!).add(seed.holeNumber);
		}
		return run.components
			.filter((component) => kept.has(component.label))
			.map((component) => ({
				label: component.label,
				areaPx: component.areaPx,
				lStd: component.lStd,
				centroid: component.centroidSrcPx,
				ownerHoles: [...(ownersByLabel.get(component.label) ?? [])].sort((a, b) => a - b),
				annotation: run.componentAnnotations?.[component.label]
			}))
			.sort((a, b) => b.areaPx - a.areaPx);
	}

	/** Persist one component's confuser label through the sanctioned annotation path. */
	function setConfuserLabel(componentLabel: number, value: string): void {
		if (!activeShadowRun) return;
		const annotation =
			value === ''
				? null
				: ({ confuserLabel: value as RibbonMassConfuserLabel } satisfies RibbonMassComponentAnnotation);
		// $state deep-proxies the run; IndexedDB's structured clone rejects
		// proxies, so derive the persisted record from a plain snapshot.
		const plainRun = $state.snapshot(activeShadowRun) as RibbonMassShadowRun;
		const updated = withComponentAnnotations(plainRun, { [componentLabel]: annotation });
		activeShadowRun = updated;
		if (latestShadowRun?.runId === updated.runId) latestShadowRun = updated;
		void getDefaultRibbonMassShadowRunStore()
			.append(updated)
			.catch(() => {
				// Best-effort dev metadata; never surfaces as a blocking error.
			});
	}

	let exportingCorrections = $state(false);
	let exportingShadowRuns = $state(false);
	let exportCorrectionsError = $state<string | null>(null);

	/**
	 * "Export corrections" (design: `docs/annotate-round-correction-log.md`'s
	 * "Export, revised" section): no sync/backend, just this project's
	 * recorded `CorrectionEvent`s serialized to a JSON file the user downloads
	 * and shares however they already share files.
	 */
	async function handleExportCorrections(): Promise<void> {
		if (exportingCorrections) return;
		exportingCorrections = true;
		exportCorrectionsError = null;
		try {
			const projectId = editor.state.project.id;
			const events = (await correctionLogStore.getAll()).filter((event) => event.projectId === projectId);
			const blob = correctionEventsToExportBlob(events);
			(download ?? downloadBlob)(blob, `${editor.state.project.name || 'chainspot'}-corrections.json`);
		} catch (error) {
			exportCorrectionsError =
				error instanceof Error ? error.message : 'Could not export corrections for this project.';
		} finally {
			exportingCorrections = false;
		}
	}

	/**
	 * "Export shadow runs": this project's ribbon-mass ShadowRun A records
	 * with experiments B (ownership-only corrections, joined from the
	 * correction log) and C (review-approved location + ownership, from the
	 * current hole annotations) derived at export time. The stored records
	 * stay pure production reality — derivation never writes back. Exported
	 * alongside, but separately from, correction events; the two files join
	 * on projectId/imageId/holeNumber/seedId.
	 */
	async function handleExportShadowRuns(): Promise<void> {
		if (exportingShadowRuns) return;
		exportingShadowRuns = true;
		exportCorrectionsError = null;
		try {
			const projectId = editor.state.project.id;
			const runs = (await getDefaultRibbonMassShadowRunStore().getAll()).filter(
				(run) => run.projectId === projectId
			);
			const events = (await correctionLogStore.getAll()).filter((event) => event.projectId === projectId);
			// Review-approved geometry = the holes as annotated right now. This
			// is review-APPROVED, not ground truth: the coordinates may have been
			// CV-snapped (`applyLocalSnap`) or simply mis-placed by the reviewer.
			const reviewApproved: ReviewApprovedHole[] = holes
				.filter((hole) => hole.tee !== undefined || hole.basket !== undefined)
				.map((hole) => ({
					holeNumber: hole.number,
					...(hole.tee ? { tee: { xPx: hole.tee.xPx, yPx: hole.tee.yPx } } : {}),
					...(hole.basket ? { basket: { xPx: hole.basket.xPx, yPx: hole.basket.yPx } } : {})
				}));
			const derived = runs.map((run) => deriveShadowRunExperiments(run, events, reviewApproved));
			const blob = shadowRunsToExportBlob(derived);
			(download ?? downloadBlob)(blob, `${editor.state.project.name || 'chainspot'}-ribbon-mass-shadow.json`);
		} catch (error) {
			exportCorrectionsError =
				error instanceof Error ? error.message : 'Could not export shadow runs for this project.';
		} finally {
			exportingShadowRuns = false;
		}
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
	/**
	 * Holes whose CURRENT corridorBends came from eager auto-detection (fired
	 * as soon as tee+basket are both placed, before Approve — see the
	 * `$effect` near `runEagerBendDetection`) and are still cancelable: if
	 * tee/basket subsequently moves more than `EAGER_BEND_CANCEL_DISTANCE_PX`
	 * from `eagerBendAnchorByHoleId`'s recorded position, the bends are
	 * discarded and detection is free to try again at the new position. A
	 * hole leaves this set (bends "promoted" to ordinary/permanent) the
	 * moment the user touches one of its bends directly, or approves the
	 * hole — see `promoteEagerBends`. Never part of `AnnotatedHole`/
	 * `SourcePoint` itself (`annotatedRound.ts`'s provenance rule) — purely
	 * transient page-local UI state, same convention as `confirmedPieces`.
	 */
	let autoProposedBendHoleIds = $state<ReadonlySet<string>>(new Set());
	/**
	 * tee/basket position `autoProposedBendHoleIds`' eager bends were computed
	 * from, for the cancel-on-drag distance check. Plain (non-reactive)
	 * bookkeeping, mirrors `autoDetectedSourceId`'s once-per-image guard
	 * convention. `let`, not `const` (CHSPT-57 review): this must be part of
	 * `WorkflowSnapshot` like `lastManualBendByHoleId` — without it, an undo
	 * that restores `autoProposedBendHoleIds` to include a hole again could
	 * leave this map holding a STALE anchor from a since-cancelled/re-run
	 * attempt, and the cancel-on-drag `$effect` below would compare the
	 * restored tee/basket against that stale anchor and immediately
	 * re-cancel the bends the undo just brought back.
	 */
	let eagerBendAnchorByHoleId = new Map<string, { readonly tee: SourcePoint; readonly basket: SourcePoint }>();
	/** holeId -> tee/basket signature already attempted (or currently scheduled/in-flight) by the eager trigger, so it does not re-fire for a position it has already tried. Plain bookkeeping, not rendered. `let` for the same undo/redo-fidelity reason as `eagerBendAnchorByHoleId` above. */
	let eagerBendAttemptSignature = new Map<string, string>();
	/** Per-hole debounce timer for the eager trigger, so a mid-drag flurry of tee/basket updates schedules one attempt at the settled position, not one per intermediate frame. */
	const eagerBendDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
	const EAGER_BEND_DEBOUNCE_MS = 400;
	/** Source px: a tee/basket nudge within this distance of the anchor keeps the eager bend as-is ("looks like magical bend detection that just needs a little fine tuning"); beyond it, the proposal is stale and gets discarded. */
	const EAGER_BEND_CANCEL_DISTANCE_PX = 6;

	/**
	 * The exact drop point of the most recent MANUAL bend add per hole (CHSPT-55
	 * X-bend fix) — set at the two places a bend is actually created by the
	 * user (the radial menu's "bend" action, and an empty-map click on the
	 * BENDS step; see both call sites' `lastManualBendByHoleId.set`). `corridorBends`
	 * carries no id/source tag and is re-sorted by geometric position on every
	 * add/move (`sortBendsByPosition` in `holeAnnotation.ts`), so array order
	 * alone can't answer "which bend did the user just add" — this is a
	 * position to positionally re-find that bend by (`rejectCurrentStepProposal`'s
	 * priority 2), independent of where it lands in the sorted array. Never
	 * part of `AnnotatedHole`/`SourcePoint` itself, same provenance rule as
	 * `autoProposedBendHoleIds`; purely transient page-local UI state, but
	 * still part of `WorkflowSnapshot` so undo/redo restores it faithfully.
	 */
	let lastManualBendByHoleId = new Map<string, SourcePoint>();
	/** Source px tolerance for re-finding `lastManualBendByHoleId`'s remembered point in a hole's current (possibly re-sorted) `corridorBends` — a manual add's stored coordinates are never transformed, so an exact match is expected; a little slack only guards against float formatting, not a real position change. A miss (nothing within tolerance — e.g. that bend was already removed some other way) means the entry is stale, so callers fall through to the next priority instead of matching the wrong bend. */
	const BEND_MATCH_EPSILON_PX = 0.5;
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

	const SIDEBAR_SECTION_LABELS: Record<1 | 2 | 3 | 4, string> = {
		1: 'Missing tee',
		2: 'Missing basket',
		3: 'Placed — unconfirmed',
		4: 'Confirmed'
	};

	/**
	 * The sidebar hole grid's four sections, derived purely from what data
	 * exists on the hole plus its per-piece confirmed status — no separate
	 * status flag beyond tee/basket presence and `confirmedPieces`:
	 *   1. missing tee (whether or not a basket exists)
	 *   2. has a tee, missing basket
	 *   3. both placed, but not both confirmed
	 *   4. both placed and confirmed
	 * Tees lead deliberately: detection finds baskets far more reliably than
	 * tees, so step 1 of the guided flow is marking whatever tees are missing
	 * or too uncertain for detection to have placed — a hole that already has
	 * its basket still surfaces here first until its tee exists.
	 */
	function sectionOfHole(hole: AnnotatedHole): 1 | 2 | 3 | 4 {
		if (hole.tee === undefined) return 1;
		if (hole.basket === undefined) return 2;
		const confirmed = isPieceConfirmed(hole.id, 'tee') && isPieceConfirmed(hole.id, 'basket');
		return confirmed ? 4 : 3;
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
		// reassignMarker always returns a fresh array, even as a no-op (pure-reducer
		// convention — see holeAnnotation.test.ts), so a reference check can't detect
		// "nothing moved". Check the source point ourselves instead.
		const fromHole = holes.find((hole) => hole.id === fromHoleId);
		const point = kind === 'tee' ? fromHole?.tee : fromHole?.basket;
		if (!point) return;
		holes = reassignMarker(holes, fromHoleId, toHoleId, kind);
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

	/**
	 * Approves both pieces on a hole at once — the sidebar's Approve action
	 * for a section-3 hole. No-op unless both are already placed. Bend
	 * detection normally already ran (and, common case, already landed) the
	 * moment both pieces were placed — see the eager-detection `$effect`
	 * below — so Approve's own job is just to confirm and, if this hole's
	 * bends are still eager-proposed, accept them as final
	 * (`promoteEagerBends`) so a later tee/basket nudge elsewhere never
	 * quietly discards them. `scheduleEagerBendDetection` below is also a
	 * safety net for the rare case Approve is clicked before the debounce
	 * even fires (e.g. both pieces placed and Approve clicked within
	 * `EAGER_BEND_DEBOUNCE_MS`) — it is a no-op if detection already ran.
	 */
	function approveHolePieces(holeId: string): void {
		const hole = holes.find((candidate) => candidate.id === holeId);
		if (!hole?.tee || !hole.basket) return;
		setPieceConfirmed(holeId, 'tee', true);
		setPieceConfirmed(holeId, 'basket', true);
		// The sidebar's Approve is the redesign's explicit "these points are
		// right" gesture — the correction log's 'confirm' for both endpoints.
		logCorrection('tee', hole.number, 'confirm', { xPx: hole.tee.xPx, yPx: hole.tee.yPx });
		logCorrection('basket', hole.number, 'confirm', { xPx: hole.basket.xPx, yPx: hole.basket.yPx });
		promoteEagerBends(holeId);
		if (hole.corridorBends.length === 0) {
			scheduleEagerBendDetection(holeId, corridorBendSignature(hole.tee, hole.basket), { immediate: true });
		}
	}

	/** `tee`/`basket` position signature — a cheap equality/identity check for "has this hole's anchor geometry actually changed" without deep-comparing whole `AnnotatedHole` objects. */
	function corridorBendSignature(tee: SourcePoint, basket: SourcePoint): string {
		return `${tee.xPx.toFixed(1)},${tee.yPx.toFixed(1)}|${basket.xPx.toFixed(1)},${basket.yPx.toFixed(1)}`;
	}

	/** A hole's bends stop being eager-cancelable the moment the user touches them directly (add/move/delete a bend) or approves the hole — from then on a later tee/basket nudge must never silently discard them. */
	function promoteEagerBends(holeId: string): void {
		if (!autoProposedBendHoleIds.has(holeId)) return;
		autoProposedBendHoleIds = new Set([...autoProposedBendHoleIds].filter((id) => id !== holeId));
		eagerBendAnchorByHoleId.delete(holeId);
	}

	/**
	 * `rejectCurrentStepProposal`'s priority-2 lookup: `bends` is re-sorted by
	 * geometric position on every add/move (`sortBendsByPosition` in
	 * `holeAnnotation.ts`), so `lastManualBendByHoleId`'s remembered drop point
	 * has to be re-found by position, not by index. Returns -1 (a stale/miss)
	 * when nothing in `bends` is within `epsilonPx` of `point` — e.g. that bend
	 * was already removed some other way — so the caller falls through to the
	 * next priority instead of matching the wrong bend.
	 */
	function findNearestBendIndex(bends: readonly SourcePoint[], point: SourcePoint, epsilonPx: number): number {
		let bestIndex = -1;
		let bestDistancePx = Infinity;
		for (const [index, bend] of bends.entries()) {
			const distancePx = Math.hypot(bend.xPx - point.xPx, bend.yPx - point.yPx);
			if (distancePx < bestDistancePx) {
				bestDistancePx = distancePx;
				bestIndex = index;
			}
		}
		return bestDistancePx <= epsilonPx ? bestIndex : -1;
	}

	/** The eager proposal is stale (tee/basket moved beyond tolerance since it was computed): discard it and free the hole up for a fresh attempt once it settles at the new position. */
	function cancelEagerBends(holeId: string): void {
		holes = clearBends(holes, holeId);
		autoProposedBendHoleIds = new Set([...autoProposedBendHoleIds].filter((id) => id !== holeId));
		eagerBendAnchorByHoleId.delete(holeId);
		eagerBendAttemptSignature.delete(holeId);
		markMapGeometryEdited();
	}

	/** Debounces `runEagerBendDetection` so a mid-drag flurry of tee/basket updates schedules one attempt at the settled position, not one per frame. `immediate` (Approve's safety-net call) skips the wait — the user has already explicitly signaled "this is done." */
	function scheduleEagerBendDetection(holeId: string, signature: string, options: { immediate?: boolean } = {}): void {
		const existing = eagerBendDebounceTimers.get(holeId);
		if (existing !== undefined) clearTimeout(existing);
		const run = () => {
			eagerBendDebounceTimers.delete(holeId);
			void runEagerBendDetection(holeId, signature);
		};
		if (options.immediate) {
			run();
			return;
		}
		eagerBendDebounceTimers.set(holeId, setTimeout(run, EAGER_BEND_DEBOUNCE_MS));
	}

	/**
	 * Automatic corridor-bend proposal — runs the capsule detector
	 * (`corridorBendDetectionCapsule.ts`'s PRODUCTION STATUS note) in its
	 * dedicated worker (`corridorBendDetectionCapsuleWorker.ts`) so the
	 * up-to-~600ms search cost never blocks the main thread. Anchored to
	 * this hole's own detected number badge when one exists (`numberBadges`),
	 * unanchored otherwise — a missing badge never disables detection.
	 * Skips entirely (or discards its own result) whenever: the hole is
	 * missing a tee/basket, already has bends (manual work is never
	 * clobbered — the detector isn't even invoked), pixel data isn't
	 * available yet, or `signatureAtDispatch` no longer matches the hole's
	 * CURRENT tee/basket (it moved again — before dispatch, or while this
	 * call was in flight — so the result would land on the wrong geometry;
	 * a fresh attempt for the new position is already scheduled by the
	 * `$effect` below). Best-effort and silent on any failure, exactly like
	 * the ribbon-mass shadow pass: a miss here never blocks anything, the
	 * hole just stays straight until reviewed by hand.
	 */
	async function runEagerBendDetection(holeId: string, signatureAtDispatch: string): Promise<void> {
		const hole = holes.find((candidate) => candidate.id === holeId);
		if (!hole?.tee || !hole.basket || hole.corridorBends.length > 0) return;
		if (corridorBendSignature(hole.tee, hole.basket) !== signatureAtDispatch) return;
		const image = sourceImage();
		if (!image) return;
		const decoded = editor.getAssetResource(image.id)?.decoded;
		if (!(decoded instanceof HTMLImageElement)) return;
		const anchorTee = hole.tee;
		const anchorBasket = hole.basket;
		try {
			const raster = cropSourceRasterAroundHole(decoded, image.widthPx, image.heightPx, hole.tee, hole.basket);
			const badge = numberBadges.find((candidate) => candidate.number === hole.number);
			const nextHoles = await detectAndApplyCorridorBendsCapsuleAsync(
				holes,
				holeId,
				raster,
				badge ? { xPx: badge.xPx, yPx: badge.yPx } : undefined
			);
			const proposed = nextHoles.find((candidate) => candidate.id === holeId);
			if (!proposed || proposed.corridorBends.length === 0) return;
			// Re-check against the LATEST state -- tee/basket may have moved
			// again, or gained manual bends, while detection was in flight.
			const latest = holes.find((candidate) => candidate.id === holeId);
			if (!latest?.tee || !latest.basket || latest.corridorBends.length > 0) return;
			if (corridorBendSignature(latest.tee, latest.basket) !== signatureAtDispatch) return;
			holes = nextHoles;
			autoProposedBendHoleIds = new Set([...autoProposedBendHoleIds, holeId]);
			eagerBendAnchorByHoleId.set(holeId, { tee: anchorTee, basket: anchorBasket });
			markMapGeometryEdited();
		} catch {
			// Best-effort eager detection; never blocks anything.
		}
	}

	/**
	 * Eager bend-detection trigger: as soon as a hole has both a tee and a
	 * basket and no bends yet, this schedules a detection attempt — the user
	 * never has to click Approve first to see a proposed bend; by the time
	 * they review the hole it's (best-effort) already there, and Approve just
	 * finalizes it. Also the cancel side of the same contract: a hole whose
	 * CURRENT eager bends were computed from a tee/basket position it has
	 * since moved away from (beyond `EAGER_BEND_CANCEL_DISTANCE_PX`) has them
	 * discarded here, freeing it up for a fresh attempt at the new position.
	 * Runs on every `holes` change (any tee/basket mutation path — CV
	 * auto-accept, manual placement, drag, reassignment — funnels through
	 * here uniformly) but only ever *acts* on a hole whose signature hasn't
	 * already been tried, so this is not an unbounded loop — mirrors the
	 * `autoDetectedSourceId`/`prewarmedSourceId` once-per-change guard
	 * convention used elsewhere on this page.
	 */
	$effect(() => {
		for (const hole of holes) {
			if (!hole.tee || !hole.basket) continue;
			if (autoProposedBendHoleIds.has(hole.id)) {
				const anchor = eagerBendAnchorByHoleId.get(hole.id);
				if (anchor) {
					const teeMovedPx = Math.hypot(hole.tee.xPx - anchor.tee.xPx, hole.tee.yPx - anchor.tee.yPx);
					const basketMovedPx = Math.hypot(hole.basket.xPx - anchor.basket.xPx, hole.basket.yPx - anchor.basket.yPx);
					if (teeMovedPx > EAGER_BEND_CANCEL_DISTANCE_PX || basketMovedPx > EAGER_BEND_CANCEL_DISTANCE_PX) {
						cancelEagerBends(hole.id);
					}
				}
				continue;
			}
			if (hole.corridorBends.length > 0) continue;
			const signature = corridorBendSignature(hole.tee, hole.basket);
			if (eagerBendAttemptSignature.get(hole.id) === signature) continue;
			eagerBendAttemptSignature.set(hole.id, signature);
			scheduleEagerBendDetection(hole.id, signature);
		}
	});

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
	 * requiring both and a `ready` status — the sidebar's four sections are
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
	 * Session start for the keyboard-first review flow: once Hole 1 exists in
	 * the draft (or detection has anchored its badge), it becomes the active
	 * hole with the current step at TEE, so Tab/click review begins
	 * immediately. Once per source image, and deliberately NOT before there
	 * is anything to review — a purely hand-annotated session (no detection)
	 * starts its first hole via the sidebar or a first Tab press instead of
	 * getting a phantom empty Hole 1 written into the draft.
	 */
	$effect(() => {
		void refreshCount;
		if (annotationMode !== 'map') return;
		const image = sourceImage();
		if (!image || reviewStartedSourceId === image.id) return;
		const holeOne = holes.find((hole) => hole.number === 1);
		const badgeOne = numberBadges.find((badge) => badge.number === 1);
		if (!holeOne && !badgeOne) return;
		reviewStartedSourceId = image.id;
		initialBadgeFocusPending = true;
		untrack(() => {
			const hole = activateHoleByNumber(1);
			if (hole) reviewStep = 'tee';
		});
	});

	/**
	 * The one automatic camera setup of a session: when detection delivers
	 * Hole 1's number badge and the user hasn't navigated anywhere yet,
	 * center that badge at a useful review zoom. Every later camera change is
	 * either the user's own (wheel/WASD/Q/E) or a zoom-preserving badge pan.
	 */
	$effect(() => {
		if (annotationMode !== 'map' || !initialBadgeFocusPending) return;
		const badge = numberBadges.find((candidate) => candidate.number === 1);
		if (!badge) return;
		initialBadgeFocusPending = false;
		untrack(() => {
			const active = activeHole();
			if (!active || active.number !== 1) return;
			sidebarFocusTick += 1;
			sidebarFocusRequest = {
				key: `review-start:${sidebarFocusTick}`,
				point: { xPx: badge.xPx, yPx: badge.yPx },
				zoomMultiplier: INITIAL_REVIEW_ZOOM_MULTIPLIER
			};
		});
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

		if ((event.ctrlKey || event.metaKey) && !event.altKey) {
			// Widened to admit Shift (Ctrl-Shift-Z redo) alongside the plain
			// Ctrl-combos below, which stay explicitly shift-guarded so e.g.
			// Ctrl-Shift-S/O still fall through here and get swallowed as before.
			const modifierKey = event.key.toLowerCase();
			if (!event.shiftKey && modifierKey === 's') {
				event.preventDefault();
				if (!saving && !event.repeat) handleSave();
			} else if (!event.shiftKey && modifierKey === 'o') {
				event.preventDefault();
				if (!openLoading && !event.repeat) openDraftInput?.click();
			} else if (annotationMode === 'map') {
				// historyShortcut (see `$lib/pointListShortcuts`) owns the exact
				// Ctrl/Cmd-Z, Ctrl/Cmd-Shift-Z, Ctrl-Y (not Cmd-Y) key detection —
				// reused as-is rather than hand-rolling it a second time here.
				// Repeat allowed: holding the combo steps through workflow history.
				const shortcut = historyShortcut(event);
				if (shortcut === 'undo') {
					event.preventDefault();
					performWorkflowUndo();
				} else if (shortcut === 'redo') {
					event.preventDefault();
					performWorkflowRedo();
				}
			}
			return;
		}
		// Review keys run before the blanket repeat guard so held WASD/Q/E keep
		// panning/zooming; Tab/X gate their own repeats internally.
		if (handleReviewKey(event)) return;
		if (event.ctrlKey || event.metaKey || event.altKey || event.repeat) return;

		const key = event.key.toLowerCase();
		// 'a' belongs to the WASD camera in Map mode (consumed above); it stays
		// an add-hole alias only in Round mode.
		if ((key === 'a' && annotationMode === 'round') || key === 'n') {
			if (nextHoleNumber(holes) === null) return;
			event.preventDefault();
			handleAddHole();
			return;
		}
		if (key === 'enter') {
			// Enter is the browser's native activation key for a focused <button>;
			// without these guards this global handler would hijack Tab+Enter on
			// Cancel/+Add Bend(s), and would fire underneath an open radial
			// menu/marker chip that owns its own keyboard contract.
			if (radialMenu || markerChip) return;
			if (event.target instanceof HTMLButtonElement || event.target instanceof HTMLAnchorElement) return;
			if (sidebarBanner?.kind !== 'approve') return;
			event.preventDefault();
			approveActiveHole();
			return;
		}
	}

	function handleRemoveLastShot(): void {
		if (!activeHoleId) return;
		holes = removeLastShot(holes, activeHoleId);
	}

	function handleReorderShot(shotId: string, delta: -1 | 1): void {
		if (!activeHoleId) return;
		const hole = holes.find((candidate) => candidate.id === activeHoleId);
		if (!hole) return;
		const currentIndex = hole.shots.findIndex((shot) => shot.id === shotId);
		if (currentIndex < 0) return;
		captureWorkflowSnapshot();
		holes = reorderShot(holes, activeHoleId, shotId, currentIndex + delta);
	}

	function handleReassignShot(event: Event, fromHoleId: string, shotId: string): void {
		const toHoleId = (event.currentTarget as HTMLSelectElement).value;
		if (!toHoleId || toHoleId === fromHoleId) return;
		captureWorkflowSnapshot();
		holes = reassignShot(holes, fromHoleId, toHoleId, shotId);
		activeHoleId = toHoleId;
	}

	function handleRemoveLastBend(): void {
		if (!activeHoleId) return;
		captureWorkflowSnapshot();
		promoteEagerBends(activeHoleId);
		holes = removeLastBend(holes, activeHoleId);
		markMapGeometryEdited();
	}

	function handleClearBends(): void {
		if (!activeHoleId) return;
		captureWorkflowSnapshot();
		promoteEagerBends(activeHoleId);
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
		captureWorkflowSnapshot();
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
			if (distance > BADGE_HIT_RADIUS_PX || distance >= closestDistance) continue;
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
		captureWorkflowSnapshot();
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
		captureWorkflowSnapshot();
		deleteHolePiece(markerChip.holeId, markerChip.kind);
		closeMarkerChip();
	}

	/**
	 * The step a hole enters at when activated by a targeted correction
	 * (sidebar click, badge tap, chip reassignment): derived from what's
	 * missing, so those paths behave exactly as they always have — a hole
	 * missing its tee asks for the tee, one missing its basket asks for the
	 * basket, a complete hole is in bends/revisit mode. The guided Tab flow
	 * (`enterHoleForReview`) deliberately overrides this to always start at
	 * TEE, since its job is reviewing every proposed piece in order.
	 */
	function derivedStepFor(hole: AnnotatedHole): ReviewStep {
		if (!hole.tee) return 'tee';
		if (!hole.basket) return 'basket';
		return 'bends';
	}

	/** Activates a numbered hole, creating it in numeric order when the draft does not have it yet. */
	function activateHoleByNumber(number: number): AnnotatedHole | null {
		let target = holes.find((hole) => hole.number === number);
		if (target) {
			activeHoleId = target.id;
			reviewStep = derivedStepFor(target);
			return target;
		}
		const inheritedWidthPx = currentCorridorWidthPx();
		const nextHoles = addHoleWithNumber(holes, number);
		target = nextHoles.find((hole) => hole.number === number);
		if (!target) return null;
		holes = setCorridorWidth(nextHoles, target.id, inheritedWidthPx);
		activeHoleId = target.id;
		reviewStep = derivedStepFor(target);
		return target;
	}

	/** Selects the hole matching a tapped map number, creating it first if it doesn't exist yet. */
	function selectOrCreateHoleByNumber(number: number): void {
		captureWorkflowSnapshot();
		initialBadgeFocusPending = false;
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
	 * The canonical focus point for hole navigation (see `onHoleBoxClick`).
	 * Prioritizes the CV-detected number badge as the primary anchor, ensuring
	 * stable focus independent of tee/basket availability or correctness.
	 *
	 * The badge is the CV-detected hole-number anchor, populated from course
	 * grammar's badge assignment (Stage 1 only — requires badge detection but
	 * never tee/basket, so an "incomplete" hole can still anchor a badge).
	 * It exists before any tee/basket can be placed, making it the only stable
	 * position that can anchor focus from the start. Critically: tee detection
	 * is the hardest/least reliable CV endpoint, so the badge must be primary,
	 * not a fallback. The tee/basket/midpoint are never consulted for focus
	 * decisions — they remain editable markers, just not focus inputs.
	 *
	 * Fallback hierarchy:
	 *   1. Number badge (primary, never changes based on tee/basket edits)
	 *   2. Tee (if badge missing, temporary fallback for existing geometry)
	 *   3. Basket (if badge and tee both missing)
	 *
	 * Returns `null` when none exist: the view deliberately stays put rather
	 * than jumping somewhere ungrounded. This gracefully handles section-1/2
	 * holes during the placing flow or holes with CV failures.
	 */
	function holeFocusPoint(hole: AnnotatedHole): SourcePoint | null {
		// Primary anchor: CV-detected number badge, independent of tee/basket
		const badge = numberBadges.find((candidate) => candidate.number === hole.number);
		if (badge) {
			return { xPx: badge.xPx, yPx: badge.yPx };
		}
		// Fallback: existing tee/basket geometry (only if badge missing)
		if (hole.tee) return hole.tee;
		if (hole.basket) return hole.basket;
		// No usable focus point available
		return null;
	}

	/**
	 * A snapshot taken once, at the moment of a deliberate sidebar click (see
	 * `onHoleBoxClick`) — deliberately NOT a `$derived` over live hole state.
	 * If it re-read `holes` reactively by id, placing a hole's first piece
	 * while it's the current focus target would hand `holeFocusPoint` a fresh
	 * non-null point and silently re-trigger a second, unrequested camera
	 * jump the instant that piece landed, on top of the click's own jump.
	 * `zoomMultiplier` is null for badge-anchor focus (preserve current zoom)
	 * and undefined otherwise (legacy behavior, for backward compatibility).
	 */
	let sidebarFocusRequest = $state<{ key: string; point: SourcePoint; zoomMultiplier?: number | null } | null>(null);

	/**
	 * CHSPT-65: how many holes this course has. The guided sidebar flow was
	 * hard-coded to 18; a 9-hole course could then never reach the completion
	 * state at all. This is deliberately a minimal 9-or-18 choice (the two
	 * standard course lengths), transient UI state like the rest of the
	 * sidebar's flow state — not persisted into `ProjectState`, reset with the
	 * same source-image-replacement lifecycle. Arbitrary hole counts remain
	 * future work.
	 */
	let courseLength = $state<9 | 18>(18);

	/**
	 * The sidebar's per-hole "which section" bucketing for the standard holes
	 * of the configured course length (extra holes past it, if any, aren't
	 * shown in the redesigned grid — same fixed-scope rule the old flat hole
	 * bar's main grid had). A hole with no draft record yet is section 1: it
	 * has neither tee nor basket, exactly like an empty `AnnotatedHole` would
	 * score.
	 */
	let sidebarSections = $derived.by(() => {
		const buckets: Record<1 | 2 | 3 | 4, number[]> = { 1: [], 2: [], 3: [], 4: [] };
		for (let number = 1; number <= courseLength; number += 1) {
			const hole = holes.find((candidate) => candidate.number === number);
			buckets[hole ? sectionOfHole(hole) : 1].push(number);
		}
		return buckets;
	});

	/**
	 * CHSPT-65 guard against a contradictory short-course completion: true when
	 * any standard hole ABOVE `limit` (but within the 1-18 grid scope) carries
	 * a user-confirmed tee or basket. Confirmed pieces only, deliberately:
	 * unconfirmed CV proposals routinely exist for holes 10-18 on a 9-hole
	 * course and are noise, not contradiction. Holes past 18 stay out of scope
	 * exactly as they always were for completion.
	 */
	function confirmedHolesBeyond(limit: number): boolean {
		return holes.some(
			(hole) =>
				hole.number > limit &&
				hole.number <= 18 &&
				(isPieceConfirmed(hole.id, 'tee') || isPieceConfirmed(hole.id, 'basket'))
		);
	}

	/**
	 * Completion additionally requires no confirmed work beyond the configured
	 * length — "All 9 holes confirmed" must never render while a confirmed hole
	 * 10+ exists (the exported artifact carries ALL holes; see `handleDone`).
	 * For an 18-hole course the beyond-range is empty, so this preserves the
	 * pre-CHSPT-65 behavior exactly.
	 */
	let allHolesConfirmed = $derived(
		sidebarSections[4].length === courseLength && !confirmedHolesBeyond(courseLength)
	);

	/**
	 * The guided flow's final step: once all 18 tees/baskets are confirmed the
	 * sidebar walks through corridor-bend annotation before offering the
	 * completion panel. Bends have no detection pass today (nothing in
	 * courseGrammar proposes them — automation is a parallel effort), so this
	 * step is the only place they'd ever get marked; without it the guide
	 * jumped straight from confirmation to "Course complete" and bends were
	 * silently skipped. Sticky once finished ("Finish bends" doubles as skip);
	 * cleared on the same source-image-replacement lifecycle as the rest.
	 */
	let bendPhaseDone = $state(false);

	/**
	 * Set to a hole's id while that hole's own "+ Add Bend(s)" banner action is
	 * active — lets a hole under review (or already approved) get a bend added
	 * right there, without waiting for the all-18-confirmed guided bends phase
	 * and without leaving/re-entering the hole. Compared against `activeHoleId`
	 * rather than cleared on every focus change: switching the active hole
	 * already invalidates it for free (see `sidebarBanner`), so it only needs
	 * an explicit reset on the source-image-replacement lifecycle.
	 */
	let manualBendHoleId = $state<string | null>(null);

	/**
	 * Entry point for clicking a hole in the sidebar grid: activates it
	 * (creating an empty draft hole on demand for a section-1 hole with no
	 * record yet) and engages the camera pan. The placing/approve banner
	 * itself is fully derived from the resulting hole state — see
	 * `sidebarBanner` — no separate mode flag to keep in sync here.
	 *
	 * Focus pans the badge to center without changing zoom: the user's zoom
	 * preference is preserved, and zoom only changes via explicit Fit/Reset.
	 * Re-clicking the same hole recenters its badge (fresh key each time).
	 */
	function onHoleBoxClick(number: number): void {
		captureWorkflowSnapshot();
		initialBadgeFocusPending = false;
		const hole = activateHoleByNumber(number);
		if (!hole) return;
		sidebarFocusTick += 1;
		const point = holeFocusPoint(hole);
		sidebarFocusRequest = point
			? { key: `${hole.id}:${sidebarFocusTick}`, point, zoomMultiplier: null }
			: null;
		markerChip = null;
		radialMenu = null;
	}

	/**
	 * The guided Tab flow's hole entry: activates the hole, forces the review
	 * step back to TEE (the per-hole order is always TEE → BASKET → BENDS,
	 * regardless of what CV already proposed), and smoothly pans the hole's
	 * badge to center — preserving the user's current zoom. Never navigates to
	 * a predicted tee or basket, and never auto-zooms: the only automatic zoom
	 * of a session is the initial Hole 1 close-up.
	 */
	function enterHoleForReview(number: number): void {
		initialBadgeFocusPending = false;
		const hole = activateHoleByNumber(number);
		if (!hole) return;
		reviewStep = 'tee';
		sidebarFocusTick += 1;
		const point = holeFocusPoint(hole);
		sidebarFocusRequest = point
			? { key: `${hole.id}:${sidebarFocusTick}`, point, zoomMultiplier: null }
			: null;
		markerChip = null;
		radialMenu = null;
	}

	/**
	 * The step the map currently acts under. The two bend-focused banner modes
	 * (a manual "+ Add Bend(s)" session, and the guided all-18-confirmed bends
	 * phase) override the per-hole step, exactly as they already override
	 * click placement — so the indicator, empty-map clicks, Tab, and X all
	 * agree on what "the current step" is.
	 */
	let effectiveReviewStep = $derived.by((): ReviewStep => {
		if (annotationMode !== 'map' || !activeHoleId) return reviewStep;
		if (manualBendHoleId === activeHoleId) return 'bends';
		if (allHolesConfirmed && !bendPhaseDone) return 'bends';
		return reviewStep;
	});

	/** Builds a `WorkflowSnapshot` of the state as it stands RIGHT NOW — shared by `captureWorkflowSnapshot` (pushing the pre-action state) and by undo/redo (pushing the state they're about to overwrite onto the other stack). */
	function snapshotCurrentWorkflowState(): WorkflowSnapshot {
		const controller = viewportController();
		return {
			holes: $state.snapshot(holes) as AnnotatedHole[],
			activeHoleId,
			reviewStep,
			confirmedPieces: new Set(confirmedPieces),
			autoProposedBendHoleIds: new Set(autoProposedBendHoleIds),
			manualBendHoleId,
			lastManualBendByHoleId: new Map(lastManualBendByHoleId),
			eagerBendAnchorByHoleId: new Map(eagerBendAnchorByHoleId),
			eagerBendAttemptSignature: new Map(eagerBendAttemptSignature),
			bendPhaseDone,
			mapGeometryEdited,
			view: controller ? { ...controller.view } : null
		};
	}

	/**
	 * Captures one workflow-undo step (see `WorkflowSnapshot`). Called by every
	 * mutating workflow entry point BEFORE it changes anything, so Ctrl-Z
	 * restores the exact pre-action state — including the camera, so undoing a
	 * Tab advancement also returns the view to where it was. Map mode only:
	 * Round mode never exposes this undo surface. A fresh mutation invalidates
	 * any pending redo trail, standard undo/redo semantics.
	 */
	function captureWorkflowSnapshot(): void {
		if (annotationMode !== 'map') return;
		workflowPast.push(snapshotCurrentWorkflowState());
		if (workflowPast.length > WORKFLOW_UNDO_LIMIT) workflowPast.shift();
		workflowFuture.length = 0;
	}

	/** Restores every field a `WorkflowSnapshot` covers, plus the transient UI state (drags, menus, pending focus) that must never survive on top of a restored step — shared by undo and redo. */
	function restoreWorkflowSnapshot(snapshot: WorkflowSnapshot): void {
		holes = snapshot.holes;
		activeHoleId = snapshot.activeHoleId;
		reviewStep = snapshot.reviewStep;
		confirmedPieces = new Set(snapshot.confirmedPieces);
		autoProposedBendHoleIds = new Set(snapshot.autoProposedBendHoleIds);
		manualBendHoleId = snapshot.manualBendHoleId;
		lastManualBendByHoleId = new Map(snapshot.lastManualBendByHoleId);
		eagerBendAnchorByHoleId = new Map(snapshot.eagerBendAnchorByHoleId);
		eagerBendAttemptSignature = new Map(snapshot.eagerBendAttemptSignature);
		bendPhaseDone = snapshot.bendPhaseDone;
		mapGeometryEdited = snapshot.mapGeometryEdited;
		previewHoles = null;
		annotationDrag = null;
		markerChip = null;
		radialMenu = null;
		// A pending focus-request pan must not replay on top of the restored
		// camera, and the one-shot initial badge focus is forfeited by any undo/redo.
		sidebarFocusRequest = null;
		initialBadgeFocusPending = false;
		const controller = viewportController();
		if (snapshot.view && controller) controller.view = { ...snapshot.view };
	}

	/**
	 * Ctrl-Z: reverses the previous user/workflow action — placements, moves,
	 * removals, rejections, corridor-width changes, Tab advancements (incl. an
	 * accidental double-Tab, one press per step), active hole/step changes —
	 * and restores the associated camera position/zoom. Distinct from `X`,
	 * which rejects a proposal and is itself undoable here. The state it
	 * overwrites is pushed onto `workflowFuture` first, so Ctrl-Shift-Z/Ctrl-Y
	 * can redo it.
	 */
	function performWorkflowUndo(): void {
		const snapshot = workflowPast.pop();
		if (!snapshot) return;
		workflowFuture.push(snapshotCurrentWorkflowState());
		if (workflowFuture.length > WORKFLOW_UNDO_LIMIT) workflowFuture.shift();
		restoreWorkflowSnapshot(snapshot);
	}

	/** Ctrl-Shift-Z / Ctrl-Y: the exact inverse of `performWorkflowUndo` — pops `workflowFuture`, pushes the state it's about to overwrite onto `workflowPast`, and restores the popped snapshot. */
	function performWorkflowRedo(): void {
		const snapshot = workflowFuture.pop();
		if (!snapshot) return;
		workflowPast.push(snapshotCurrentWorkflowState());
		if (workflowPast.length > WORKFLOW_UNDO_LIMIT) workflowPast.shift();
		restoreWorkflowSnapshot(snapshot);
	}

	/**
	 * Tab: accept the current step and advance. TEE → BASKET → BENDS within a
	 * hole; on BENDS the hole is completed (both pieces confirmed and logged
	 * via the existing approve path when present) and review moves to the next
	 * hole's TEE, centering that hole's badge at the current zoom.
	 */
	function advanceReviewStep(): void {
		const hole = activeHole();
		if (!hole) {
			captureWorkflowSnapshot();
			const start = nextGuidedHoleNumber(0) ?? 1;
			enterHoleForReview(start);
			return;
		}
		captureWorkflowSnapshot();
		if (effectiveReviewStep === 'tee') {
			// Accepting the proposed tee marks it reviewed; a missing tee is an
			// explicit "this hole's tee isn't visible yet", advanced past freely.
			if (hole.tee) setPieceConfirmed(hole.id, 'tee', true);
			reviewStep = 'basket';
			return;
		}
		if (effectiveReviewStep === 'basket') {
			if (hole.basket) setPieceConfirmed(hole.id, 'basket', true);
			reviewStep = 'bends';
			return;
		}
		// BENDS: Tab completes the hole. approveHolePieces is the existing
		// confirm+log+promote path and no-ops when a piece is still missing.
		if (hole.tee && hole.basket) approveHolePieces(hole.id);
		vibrate(8);
		const next = nextGuidedHoleNumber(hole.number) ?? nextGuidedHoleNumber(0);
		if (next !== null && next !== hole.number) enterHoleForReview(next);
		else exitSidebarFocus();
	}

	/**
	 * X: reject the current step's obvious proposal — not a historical undo.
	 * On the BENDS step, priority is: (1) the hovered bend, so a bad bend
	 * under the cursor needs no selection click; (2) the most recently
	 * manually-added bend (`lastManualBendByHoleId`), so an explicit "I just
	 * added this one" always wins regardless of where it landed after
	 * `sortBendsByPosition` re-sorted the array (CHSPT-55 — `corridorBends`
	 * carries no id/source, so array position alone can't answer "which bend
	 * did the user just touch"); (3) a hole's eager auto-proposed bends as one
	 * unit, but only while that proposal is still untouched
	 * (`autoProposedBendHoleIds`); (4) otherwise the most recent bend.
	 * Rejections are themselves one Ctrl-Z step.
	 */
	function rejectCurrentStepProposal(): void {
		const hole = activeHole();
		if (!hole) return;
		if (effectiveReviewStep === 'tee' || effectiveReviewStep === 'basket') {
			const kind = effectiveReviewStep;
			const point = kind === 'tee' ? hole.tee : hole.basket;
			if (!point) return;
			captureWorkflowSnapshot();
			deleteHolePiece(hole.id, kind);
			// 'skip' is the correction log's reject-with-no-replacement action;
			// a follow-up corrective click logs its own 'place'.
			logCorrection(kind, hole.number, 'skip', null);
			vibrate(8);
			return;
		}
		if (hole.corridorBends.length === 0) return;
		// Priority 1: the hovered bend wins outright, no selection click needed.
		const controller = viewportController();
		if (lastPointerScreen && controller) {
			const hit = pointHitAt(lastPointerScreen, controller.view);
			if (hit && hit.kind === 'bend' && hit.holeId === hole.id && hit.index !== undefined) {
				captureWorkflowSnapshot();
				promoteEagerBends(hole.id);
				holes = removeCorridorBend(holes, hole.id, hit.index);
				markMapGeometryEdited();
				vibrate(8);
				return;
			}
		}
		captureWorkflowSnapshot();
		// Priority 2: the most recently manually-added bend, re-found by
		// position (see `findNearestBendIndex`) since the array's own order is
		// purely geometric, not insertion order.
		const trackedPoint = lastManualBendByHoleId.get(hole.id);
		const trackedIndex = trackedPoint
			? findNearestBendIndex(hole.corridorBends, trackedPoint, BEND_MATCH_EPSILON_PX)
			: -1;
		if (trackedIndex !== -1) {
			promoteEagerBends(hole.id);
			holes = removeCorridorBend(holes, hole.id, trackedIndex);
			lastManualBendByHoleId.delete(hole.id);
		} else if (autoProposedBendHoleIds.has(hole.id)) {
			// Priority 3: the eager auto-detection proposal is one unit, still
			// untouched — reject it whole. promoteEagerBends first keeps the
			// attempt-signature guard intact so the detector doesn't immediately
			// re-propose the same bends.
			promoteEagerBends(hole.id);
			holes = clearBends(holes, hole.id);
		} else {
			// Priority 4: no hover, no tracked manual bend, no untouched auto
			// proposal — fall back to the most recent bend.
			promoteEagerBends(hole.id);
			holes = removeLastBend(holes, hole.id);
		}
		markMapGeometryEdited();
		vibrate(8);
	}

	/**
	 * 1–6: course-level corridor-width calibration from the keyboard, applied
	 * globally via the existing course-wide behavior (`setAllCorridorWidths`,
	 * same as the header input). Feedback renders on the map itself. A burst
	 * of presses coalesces into one Ctrl-Z step (captured only when no
	 * feedback is currently showing) and one `WIDTH before → after` readout.
	 */
	function adjustCorridorWidthBy(delta: number): void {
		if (holes.length === 0) return;
		// Baseline: the active hole's width, else the first hole's — never the
		// bare default, which could misread an already-calibrated course.
		const before = activeHole()?.corridorWidthPx ?? holes[0].corridorWidthPx;
		const after = Math.max(1, Math.round(before + delta));
		if (after === before) return;
		if (!widthFeedback) captureWorkflowSnapshot();
		holes = setAllCorridorWidths(holes, after);
		markMapGeometryEdited();
		widthFeedback = { from: widthFeedback?.from ?? before, to: after };
		if (widthFeedbackTimer !== null) clearTimeout(widthFeedbackTimer);
		widthFeedbackTimer = setTimeout(() => {
			widthFeedback = null;
			widthFeedbackTimer = null;
		}, WIDTH_FEEDBACK_MS);
	}

	/**
	 * Map-mode review keys. Returns true when the key was consumed. Camera
	 * keys (WASD pan, Q/E zoom) honor key repeat for held-key movement; Tab
	 * and X act once per press. Manual zoom persists between holes, geometry
	 * edits never move the camera, and nothing here ever auto-zooms.
	 */
	function handleReviewKey(event: KeyboardEvent): boolean {
		if (annotationMode !== 'map') return false;
		// Until a course map is loaded there is nothing to review — leave the
		// keyboard alone so Tab still reaches "Choose image" and the draft bar.
		if (!sourceImage()) return false;
		if (radialMenu || markerChip) return false;
		if (event.ctrlKey || event.metaKey || event.altKey) return false;
		if (event.key === 'Tab') {
			// The workspace owns keyboard input during review: swallow the
			// browser's focus traversal in both directions, advance on plain Tab.
			event.preventDefault();
			if (!event.repeat && !event.shiftKey) advanceReviewStep();
			return true;
		}
		const key = event.key.toLowerCase();
		const controller = viewportController();
		const panStep = KEYBOARD_PAN_STEP_PX;
		switch (key) {
			case 'w':
				event.preventDefault();
				controller?.panBy(0, panStep);
				return true;
			case 's':
				event.preventDefault();
				controller?.panBy(0, -panStep);
				return true;
			case 'a':
				event.preventDefault();
				controller?.panBy(panStep, 0);
				return true;
			case 'd':
				event.preventDefault();
				controller?.panBy(-panStep, 0);
				return true;
			case 'q':
				event.preventDefault();
				if (controller?.fitTarget) controller.zoomAtCenter(KEYBOARD_ZOOM_STEP_FACTOR);
				return true;
			case 'e':
				event.preventDefault();
				if (controller?.fitTarget) controller.zoomAtCenter(1 / KEYBOARD_ZOOM_STEP_FACTOR);
				return true;
			case 'x':
				event.preventDefault();
				if (!event.repeat) rejectCurrentStepProposal();
				return true;
		}
		if (!event.shiftKey && key in CORRIDOR_WIDTH_KEY_DELTAS) {
			event.preventDefault();
			adjustCorridorWidthBy(CORRIDOR_WIDTH_KEY_DELTAS[key]);
			return true;
		}
		return false;
	}

	/** Clears sidebar focus — the placing/approve banner's Cancel/Close action. Cannot force the camera back out (the pane exposes no such API to the page); the user can still use the pane's own "Fit image" control. */
	function exitSidebarFocus(): void {
		activeHoleId = null;
		markerChip = null;
	}

	type SidebarBanner =
		| { kind: 'placing'; holeNumber: number; piece: 'Tee' | 'Basket' }
		| { kind: 'approve'; holeNumber: number }
		| { kind: 'bends'; holeNumber: number; manual: boolean }
		| { kind: 'confirmed'; holeNumber: number };

	/** Derived from the active hole's current review step (which the sidebar's targeted-correction entry seeds from hole state, so mouse-only flows read exactly as before). Map mode only; Round mode's own hole selection has nothing to do with tee/basket sections. */
	let sidebarBanner = $derived.by((): SidebarBanner | null => {
		if (annotationMode !== 'map' || !activeHoleId) return null;
		const hole = holes.find((candidate) => candidate.id === activeHoleId);
		if (!hole) return null;
		// A manual "+ Add Bend(s)" click wins over the hole's own step — it
		// must be reachable mid-review or after approval alike, not just during
		// the guided all-18 bends phase.
		if (manualBendHoleId === activeHoleId) return { kind: 'bends', holeNumber: hole.number, manual: true };
		if (allHolesConfirmed && !bendPhaseDone) return { kind: 'bends', holeNumber: hole.number, manual: false };
		if (reviewStep === 'tee') return { kind: 'placing', holeNumber: hole.number, piece: 'Tee' };
		if (reviewStep === 'basket') return { kind: 'placing', holeNumber: hole.number, piece: 'Basket' };
		const section = sectionOfHole(hole);
		if (section === 3) return { kind: 'approve', holeNumber: hole.number };
		if (section <= 2) return { kind: 'placing', holeNumber: hole.number, piece: hole.tee ? 'Basket' : 'Tee' };
		return { kind: 'confirmed', holeNumber: hole.number };
	});

	/** Finds the next hole in the guided 1–N pass over the configured course length. Already-confirmed holes are skipped, but incomplete holes are still included so the flow never jumps over work just because it belongs to another sidebar section. */
	function nextGuidedHoleNumber(afterNumber: number): number | null {
		for (let number = Math.max(1, afterNumber + 1); number <= courseLength; number += 1) {
			const hole = holes.find((candidate) => candidate.number === number);
			if (!hole || sectionOfHole(hole) !== 4) return number;
		}
		return null;
	}

	/** The Approve banner's action: confirms both pieces, then auto-advances through holes 1–18 in numeric order, skipping only holes already confirmed. */
	function approveActiveHole(): void {
		if (!activeHoleId) return;
		const approvedHole = holes.find((hole) => hole.id === activeHoleId);
		if (!approvedHole) return;
		captureWorkflowSnapshot();
		approveHolePieces(activeHoleId);
		vibrate(8);
		const nextNumber = nextGuidedHoleNumber(approvedHole.number);
		if (nextNumber !== null) onHoleBoxClick(nextNumber);
		else exitSidebarFocus();
	}

	/** The approve/confirmed banner's "+ Add Bend(s)" action: switches the banner to bend-placing instructions for the active hole without losing focus on it. */
	function startManualBends(): void {
		if (!activeHoleId) return;
		manualBendHoleId = activeHoleId;
	}

	/** The bends banner's Close/Done action: a manual add-bend session returns to reviewing the same hole; the guided all-18 phase still exits focus entirely, matching its previous behavior. */
	function closeBendsBanner(): void {
		if (manualBendHoleId) {
			manualBendHoleId = null;
			return;
		}
		exitSidebarFocus();
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

	/**
	 * The completion panel's second action, gated on the first succeeding —
	 * takes the course just saved to Course Memory to `/map-round`, the real
	 * destination for annotating a played round on it. Map Round starts with
	 * its own empty editor and recovers this course's geometry the same way
	 * any visit does: importing a round screenshot and recognizing it against
	 * the entry `handleSaveCourseToMemory` just wrote.
	 */
	async function handleUploadRoundFromCourse(): Promise<void> {
		if (!savedCourseToMemory) return;
		await goto(`${base}/map-round`);
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

	/** What courseGrammar itself proposed for this hole/endpoint right now, per the correction log's schema (`$lib/correctionLog`). */
	function derivePriorProposal(endpoint: CorrectionEndpoint, holeNumber: number) {
		return deriveProposalFromGrammar(courseDetection?.grammar ?? null, holeNumber, endpoint);
	}

	/**
	 * Appends one `CorrectionEvent` (design: `docs/annotate-round-correction-log.md`)
	 * for a confirm/move/replace/place interaction on a hole's tee or basket.
	 * Best-effort and fire-and-forget: a correction-log write must never block
	 * or visibly fail an annotation action.
	 */
	function logCorrection(
		endpoint: CorrectionEndpoint,
		holeNumber: number,
		userAction: CorrectionUserAction,
		finalValue: { xPx: number; yPx: number } | null,
		options: { dragDistancePx?: number; deferForSnap?: PendingSnapRef } = {}
	): void {
		const image = sourceImage();
		if (!image) return;
		if (options.deferForSnap) {
			// A snap-to-detection pass is in flight for this exact placement: hold
			// the event until the snap outcome is known, so `finalValue` records
			// where the marker actually ended up (post-snap) and `rawDropPx`
			// preserves the user's raw drop separately — a snapped correction is
			// still influenced by existing CV geometry, and the log must be able
			// to tell the two apart.
			const key = options.deferForSnap.key;
			const superseded = pendingCorrectionFlushes.get(key);
			if (superseded) {
				// Another deferred snap on this same marker (place-then-drag before
				// the first snap settled) is about to replace this entry. Flush the
				// superseded interaction now on its raw value rather than losing it —
				// its own in-flight snap reply will find nothing left to flush.
				pendingCorrectionFlushes.delete(key);
				appendCorrectionEvent(
					superseded.endpoint,
					superseded.holeNumber,
					superseded.userAction,
					superseded.rawValue,
					{ dragDistancePx: superseded.dragDistancePx }
				);
			}
			pendingCorrectionFlushes.set(key, {
				requestId: options.deferForSnap.requestId,
				endpoint,
				holeNumber,
				userAction,
				rawValue: finalValue,
				dragDistancePx: options.dragDistancePx
			});
			return;
		}
		appendCorrectionEvent(endpoint, holeNumber, userAction, finalValue, {
			dragDistancePx: options.dragDistancePx
		});
	}

	function appendCorrectionEvent(
		endpoint: CorrectionEndpoint,
		holeNumber: number,
		userAction: CorrectionUserAction,
		finalValue: { xPx: number; yPx: number } | null,
		meta: { dragDistancePx?: number; rawDropPx?: { xPx: number; yPx: number } } = {}
	): void {
		const image = sourceImage();
		if (!image) return;
		const interactionMeta = {
			...(meta.dragDistancePx !== undefined ? { dragDistancePx: meta.dragDistancePx } : {}),
			...(meta.rawDropPx !== undefined ? { rawDropPx: meta.rawDropPx } : {})
		};
		const event = buildCorrectionEvent({
			appVersion: APP_VERSION,
			projectId: editor.state.project.id,
			imageId: image.id,
			imageSha256: image.sha256,
			holeNumber,
			endpoint,
			priorProposal: derivePriorProposal(endpoint, holeNumber),
			userAction,
			finalValue,
			...(Object.keys(interactionMeta).length > 0 ? { interactionMeta } : {})
		});
		void correctionLogStore.append(event).catch(() => {
			// Best-effort: a correction-log write failure must never block annotation.
		});
	}

	interface PendingSnapRef {
		readonly key: string;
		readonly requestId: number;
	}

	interface PendingCorrectionFlush {
		readonly requestId: number;
		readonly endpoint: CorrectionEndpoint;
		readonly holeNumber: number;
		readonly userAction: CorrectionUserAction;
		readonly rawValue: { xPx: number; yPx: number } | null;
		readonly dragDistancePx?: number;
	}

	/** Correction events held back while their placement's snap pass resolves, keyed like `pendingLocalSnaps`. */
	const pendingCorrectionFlushes = new Map<string, PendingCorrectionFlush>();

	/**
	 * Appends a held-back correction event once its snap outcome is known.
	 * `settledPoint` is the post-snap coordinate when the snap actually moved
	 * the marker; null when it didn't (failed, stale, no feature found), in
	 * which case the raw drop stands as the final value with no `rawDropPx`.
	 */
	function flushCorrectionForSnap(
		key: string,
		requestId: number,
		settledPoint: { xPx: number; yPx: number } | null
	): void {
		const pending = pendingCorrectionFlushes.get(key);
		if (!pending || pending.requestId !== requestId) return;
		pendingCorrectionFlushes.delete(key);
		const moved =
			settledPoint !== null &&
			pending.rawValue !== null &&
			(settledPoint.xPx !== pending.rawValue.xPx || settledPoint.yPx !== pending.rawValue.yPx);
		appendCorrectionEvent(
			pending.endpoint,
			pending.holeNumber,
			pending.userAction,
			moved ? settledPoint : pending.rawValue,
			{
				dragDistancePx: pending.dragDistancePx,
				...(moved && pending.rawValue !== null ? { rawDropPx: pending.rawValue } : {})
			}
		);
	}

	/**
	 * Snap-to-detection (design points 1/2/3/5): fires a short local
	 * object-finding pass around a tee/basket point that has *already* been
	 * placed at the raw click coordinates by the caller (`placeReviewPiece`'s
	 * first-time placement of a hole's tee or basket) — this never blocks
	 * that raw placement, it only settles the marker onto a detected feature
	 * later if one is confidently found nearby (optimistic placement: a
	 * course screenshot decode plus a cold worker can plausibly exceed the
	 * ~100ms "feels instant" budget even though the crop-sized detector pass
	 * itself is fast once warm — see `src/lib/cv/localSnap.ts`'s doc comment
	 * for the measurements behind that choice). No calibration yet (course
	 * detection hasn't run), no source image, Alt held, or a failed/empty
	 * pass are all indistinguishable outcomes to the user: the raw point
	 * already placed simply stands. Deliberately never re-fires on a later
	 * manual drag of an already-placed marker — see
	 * `commitAnnotationPointerUp`'s drag-release branch for why.
	 */
	function applyLocalSnap(
		kind: LocalSnapKind,
		holeId: string,
		rawPoint: SourcePoint,
		altKey: boolean
	): PendingSnapRef | null {
		if (altKey) return null;
		const anchor = currentNumberAnchor();
		const image = sourceImage();
		if (!anchor || !image) return null;
		const resource = editor.getAssetResource(image.id);
		if (!resource) return null;

		localSnapRequestSequence += 1;
		const requestId = localSnapRequestSequence;
		const key = localSnapKey(kind, holeId);
		pendingLocalSnaps.set(key, requestId);

		requestLocalSnap(resource.bytes, image.mimeType, { kind, clickPx: rawPoint, numberAnchor: anchor })
			.then((snapped) => {
				if (!snapped) {
					flushCorrectionForSnap(key, requestId, null);
					return;
				}
				// Superseded by a newer snap request on the same marker (another
				// placement/release, or the marker was deleted and re-placed) —
				// this reply is stale and must not clobber whatever's current now.
				if (pendingLocalSnaps.get(key) !== requestId) {
					flushCorrectionForSnap(key, requestId, null);
					return;
				}
				const settled = settleLocalSnap(kind, holeId, rawPoint, snapped);
				flushCorrectionForSnap(key, requestId, settled ? snapped : null);
			})
			.catch(() => {
				// A failed pass must be indistinguishable from no feature: never
				// surface an error for a background convenience snap.
				flushCorrectionForSnap(key, requestId, null);
			});
		return { key, requestId };
	}

	/** ~100ms CSS ease (design point 4) plus a small buffer so `.settling` outlives the transition it drives rather than being pulled off mid-animation. */
	const LOCAL_SNAP_SETTLE_CLASS_MS = 150;

	/**
	 * Applies a resolved snap result, but only if the marker is still exactly
	 * where the optimistic raw placement left it — if the user has since
	 * moved, deleted, or replaced it, this reply is stale and must not
	 * clobber newer state.
	 */
	function settleLocalSnap(
		kind: LocalSnapKind,
		holeId: string,
		rawPoint: SourcePoint,
		snapped: SourcePoint
	): boolean {
		const hole = holes.find((candidate) => candidate.id === holeId);
		if (!hole) return false;
		const current = kind === 'tee' ? hole.tee : hole.basket;
		if (!current || current.xPx !== rawPoint.xPx || current.yPx !== rawPoint.yPx) return false;
		if (snapped.xPx === rawPoint.xPx && snapped.yPx === rawPoint.yPx) return false;

		const key = localSnapKey(kind, holeId);
		if (!prefersReducedMotion()) {
			settlingMarkerKeys = new Set([...settlingMarkerKeys, key]);
			setTimeout(() => {
				settlingMarkerKeys = new Set([...settlingMarkerKeys].filter((existing) => existing !== key));
			}, LOCAL_SNAP_SETTLE_CLASS_MS);
		}
		holes = kind === 'tee' ? moveTee(holes, holeId, snapped) : moveBasket(holes, holeId, snapped);
		return true;
	}

	/**
	 * Wedge actions offered by an open radial menu: Delete alone for a hit
	 * marker (bend/shot/walk only — tee/basket markers never reach this menu,
	 * see `commitAnnotationPointerUp`), otherwise the wedges the current
	 * mode's activity allows. Map mode's empty-space menu offers only `bend`
	 * now — tee/basket creation goes through the sidebar-driven placing flow
	 * (`placeReviewPiece`) before this menu is ever reached, see
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
		captureWorkflowSnapshot();
		if (action === 'delete') {
			const marker = menu.hitMarker;
			if (marker) {
				if (marker.kind === 'walk') {
					if (marker.index !== undefined) walkingPath = removeWalkPoint(walkingPath, marker.index);
				} else {
					if (marker.kind === 'bend' && marker.holeId) promoteEagerBends(marker.holeId);
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
			if (action === 'bend') {
				promoteEagerBends(menu.holeId);
				// CHSPT-55: remember this manual add's exact drop point so X's
				// priority-2 can find it again after the array's geometric re-sort.
				lastManualBendByHoleId.set(menu.holeId, menu.at);
			}
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
			// Annotation owns the entire gesture once an existing point wins hit-testing.
			// Capture this pointer on the viewport so move/up cannot disappear when the
			// drag leaves the pane or crosses another rendered element. This is local to
			// AnnotationWorkspace, so ImageViewport's Konva-compatible generic claim
			// contract remains unchanged for its other consumers.
			try {
				viewportController()?.container?.setPointerCapture(event.pointerId);
			} catch {
				// Best-effort: browsers may reject capture for an already-released pointer.
			}
			annotationDrag = {
				marker,
				start: { ...pointer },
				transform: { ...view },
				dragging: false
			};
			void event;
			return true;
		}
		// The badge hit radius is deliberately generous (see docs/13-inch-pass.md)
		// for SWITCHING between holes from a distance — but claiming it for the
		// hole that's already active is worse than useless: selecting the
		// current hole again is a no-op, and it silently swallows a nearby
		// placement/correction click on that same hole (a badge often sits close
		// to its own tee). Skip the claim in that one case and let the click
		// fall through to placement/background handling instead; every other
		// hole's badge keeps its full generous radius.
		const numberLabel = numberCandidateHitAt(pointer, view);
		if (numberLabel !== null && numberLabel !== activeHole()?.number) {
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
	function commitAnnotationPointerUp(pointer: ScreenSpacePoint): void {
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
		captureWorkflowSnapshot();
		if (drag.marker.kind === 'walk') {
			walkingPath =
				drag.marker.index !== undefined ? moveWalkPoint(walkingPath, drag.marker.index, point) : walkingPath;
		} else {
			// Captured before `holes` is reassigned below -- this is the marker's
			// pre-drag location, needed for the correction log's `move` event.
			const originalPoint = markerPoint(drag.marker);
			const draggedHoleNumber = holes.find((candidate) => candidate.id === drag.marker.holeId)?.number;
			if (drag.marker.kind === 'bend' && drag.marker.holeId) promoteEagerBends(drag.marker.holeId);
			holes = moveMarker(holes, drag.marker, point);
			if (isMapGeometryKind(drag.marker.kind)) markMapGeometryEdited();
			// Snap-to-detection intentionally never re-fires on a drag-release of an
			// already-placed tee/basket: CV isn't perfect, and re-running it on every
			// manual reposition risked silently pulling the marker back to the same
			// wrong detection the user had just corrected away from. It only ever
			// runs once, on a hole's very first raw placement — see `placeReviewPiece`.
			if ((drag.marker.kind === 'tee' || drag.marker.kind === 'basket') && draggedHoleNumber !== undefined) {
				const dragDistancePx = originalPoint
					? Math.hypot(point.xPx - originalPoint.xPx, point.yPx - originalPoint.yPx)
					: undefined;
				logCorrection(
					drag.marker.kind,
					draggedHoleNumber,
					'move',
					{ xPx: point.xPx, yPx: point.yPx },
					{ dragDistancePx }
				);
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
	function placeReviewPiece(kind: 'tee' | 'basket', point: SourcePoint, altKey: boolean): void {
		const hole = activeHole();
		if (!hole) return;
		const existing = kind === 'tee' ? hole.tee : hole.basket;
		if (!existing) {
			holes = placeByMode(holes, hole.id, kind, point);
			markMapGeometryEdited();
			const snapRef = applyLocalSnap(kind, hole.id, point, altKey);
			// A from-scratch manual placement, recorded for the correction log.
			// Deferred while a snap pass is in flight so the event records the
			// post-snap final coordinate with the raw drop preserved separately.
			logCorrection(
				kind,
				hole.number,
				'place',
				{ xPx: point.xPx, yPx: point.yPx },
				snapRef ? { deferForSnap: snapRef } : {}
			);
			vibrate(8);
			// Placement never advances GuidedReview. The user may keep clicking or
			// drag any marker until they explicitly accept this step with Tab.
			return;
		}
		// The step's piece already exists (a CV proposal, or an earlier
		// placement): an empty-map click on this step re-places it at the
		// clicked point. The step does not advance — the user is correcting,
		// and accepts with Tab when satisfied.
		holes = kind === 'tee' ? moveTee(holes, hole.id, point) : moveBasket(holes, hole.id, point);
		setPieceConfirmed(hole.id, kind, false);
		markMapGeometryEdited();
		logCorrection(kind, hole.number, 'replace', { xPx: point.xPx, yPx: point.yPx });
		vibrate(8);
	}

	/**
	 * Opens the empty-space placement menu/flow. In round mode this works even
	 * with no hole active — the menu then offers only `walk`, since the walk
	 * path is round-level rather than per-hole. In map mode a hole must be
	 * active and the CURRENT REVIEW STEP decides what the click places: the
	 * step's tee/basket (placed fresh, or re-placed over a bad proposal), or —
	 * on the BENDS step — a corridor bend, unless the radial menu is enabled.
	 * Round mode opens a shots/walk radial menu.
	 */
	function handleAnnotationPlacement(
		coordinates: { xPx: number; yPx: number },
		options: { altKey?: boolean } = {}
	): void {
		if (annotationMode === 'map') {
			if (!activeHoleId) return;
			const hole = activeHole();
			if (hole && (effectiveReviewStep === 'tee' || effectiveReviewStep === 'basket')) {
				// The current step decides what an empty-map click places: the
				// step's piece, placed fresh or re-placed over a bad proposal.
				captureWorkflowSnapshot();
				placeReviewPiece(effectiveReviewStep, coordinates, options.altKey ?? false);
				return;
			}
			if (hole && !radialMenuEnabled) {
				// BENDS step: any empty-map click adds a corridor bend directly —
				// the natural guided flow, whether the hole is under initial
				// review, already approved, or in a manual/guided bends session.
				// The radial menu, when enabled, still wins so its delete/bend
				// wedges stay reachable.
				captureWorkflowSnapshot();
				promoteEagerBends(activeHoleId);
				// CHSPT-55: remember this manual add's exact drop point so X's
				// priority-2 can find it again after the array's geometric re-sort.
				lastManualBendByHoleId.set(activeHoleId, coordinates);
				holes = placeByMode(holes, activeHoleId, 'bend', coordinates);
				markMapGeometryEdited();
				vibrate(8);
				return;
			}
		}
		openRadialMenu({ at: coordinates, holeId: activeHoleId, hitMarker: null });
	}

	/**
	 * CHSPT-65: announces a course-source intake to the thrown-round lifecycle
	 * (see `markCourseSourceIntake` in `$lib/session.ts` — first intake after a
	 * keep attaches the round to this course; a further intake clears it as
	 * stale). Course workflows only: gated to map mode, and to
	 * session-participating instances so injected-editor unit tests never touch
	 * the module-level slot. Called from all three paths a new course source
	 * can land through: pane replace, stitch handoff import, draft open.
	 */
	function announceCourseSourceIntake(): void {
		if (participatesInSession && annotationMode === 'map') markCourseSourceIntake();
	}

	/**
	 * A replaced source image invalidates every existing hole's coordinates —
	 * they're pixel positions into a specific raster, not portable to a
	 * different one — so annotation state resets along with the domain refresh.
	 */
	function handleSourceDomainChanged(): void {
		announceCourseSourceIntake();
		refresh();
		holes = [];
		walkingPath = [];
		numberBadges = [];
		labeledBaskets = [];
		recognizedMatch = null;
		recognizedSourceId = null;
		activeHoleId = null;
		importedLibraryEntryThisSession = false;
		mapGeometryEdited = false;
		bendPhaseDone = false;
		courseLength = 18;
		manualBendHoleId = null;
		lastManualBendByHoleId = new Map();
		eagerBendAnchorByHoleId = new Map();
		eagerBendAttemptSignature = new Map();
		radialMenu = null;
		markerChip = null;
		sidebarFocusRequest = null;
		savingCourseToMemory = false;
		savedCourseToMemory = false;
		courseDetectionError = null;
		courseDetection = null;
		confirmedPieces = new Set();
		reviewStep = 'tee';
		workflowPast = [];
		workflowFuture = [];
		widthFeedback = null;
		initialBadgeFocusPending = false;
		latestShadowRun = null;
		activeShadowRun = null;
		shadowOverlayRender = null;
		shadowHighlightCentroid = null;
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
			// Ribbon-mass attribution shadow pass: freeze ShadowRun A (the
			// immutable production-reality snapshot) NOW, before any review
			// interaction can exist. Fire-and-forget instrumentation — it
			// persists locally, never touches authoritative geometry, and a
			// failure is silent by design.
			void runRibbonMassShadowPass({
				projectId: editor.state.project.id,
				imageId: image.id,
				imageSha256: image.sha256,
				imageBytes: resource.bytes,
				mimeType: image.mimeType,
				widthPx: image.widthPx,
				heightPx: image.heightPx,
				detection: result
			}).then((run) => {
				if (!run || sourceImage()?.id !== detectedImageId) return;
				latestShadowRun = run;
				if (shadowOverlayEnabled) {
					activeShadowRun = run;
					shadowOverlayRender = renderShadowRunOverlay(run);
				}
			});
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
			// CHSPT-65: detection knows the course length better than the 18
			// default. When every hole it found evidence for (a read number
			// badge or an owned basket) falls in 1..9, this is a 9-hole
			// course — follow it with the sidebar's Holes selector so the
			// guided flow can actually complete at 9/9. One-directional and
			// advisory: an empty/failed pass changes nothing, >9 evidence
			// leaves the 18 default, the user can always switch back, and the
			// same confirmed-work guard as the manual toggle applies.
			const detectedHoleNumbers = [
				...numberBadges.map((badge) => badge.number),
				...labeledBaskets.map((basket) => basket.holeNumber)
			];
			if (
				detectedHoleNumbers.length > 0 &&
				Math.max(...detectedHoleNumbers) <= 9 &&
				!confirmedHolesBeyond(9)
			) {
				courseLength = 9;
			}
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
			// knows; only a subsequent Annotate Course edit makes it worth
			// previewing a library write again at Done.
			importedLibraryEntryThisSession = true;
			mapGeometryEdited = false;
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
			announceCourseSourceIntake();
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
			manualBendHoleId = null;
			lastManualBendByHoleId = new Map();
			eagerBendAnchorByHoleId = new Map();
			eagerBendAttemptSignature = new Map();
			previewHoles = null;
			radialMenu = null;
			markerChip = null;
			sidebarFocusRequest = null;
			savingCourseToMemory = false;
			savedCourseToMemory = false;
			confirmedPieces = new Set();
			reviewStep = 'tee';
			workflowPast = [];
			workflowFuture = [];
			widthFeedback = null;
			initialBadgeFocusPending = false;
			reviewStartedSourceId = null;
			courseDetection = null;
			autoDetectedSourceId = null;
			prewarmedSourceId = null;
			saveError = null;
			activityMessage = `Opened draft "${result.image.fileName}".`;
			announceCourseSourceIntake();
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
		const targeted =
			handoff && handoff.targetRole === 'source-overview' && handoff.destination === sessionKey
				? handoff
				: null;
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
			canFinish: canFinishAnnotation(),
			doneRunning,
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
		// Hover tracking for X's "hovered current-step object first" priority.
		window.addEventListener('pointermove', trackReviewPointer);
		return () => {
			unsubscribe();
			window.removeEventListener('keydown', handleAnnotationKeyDown);
			window.removeEventListener('pointermove', trackReviewPointer);
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
	<title>{annotationMode === 'map' ? 'Annotate Course' : 'Map Round'} | ChainSpot</title>
</svelte:head>

<main
	data-testid="annotation-workspace"
	data-mode={annotationMode}
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
			bind:this={editorPane}
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
							<p class="empty-copy">Empty-map clicks follow the current step (HOLE · TEE/BASKET/BENDS). Tab accepts and advances; X rejects; Ctrl-Z undoes.</p>
						{:else}
							<p class="empty-copy">Click empty map space to place a shot or a walk-path vertex; click an existing point to delete it.</p>
						{/if}
						<div class="edit-actions">
							<button type="button" data-testid="remove-last-shot" disabled={hole.shots.length === 0} onclick={handleRemoveLastShot}>Undo shot</button>
							<button type="button" data-testid="remove-last-bend" disabled={hole.corridorBends.length === 0} onclick={handleRemoveLastBend}>Undo bend</button>
							<button type="button" data-testid="clear-bends" disabled={hole.corridorBends.length === 0} onclick={handleClearBends}>Clear bends</button>
						</div>
						{#if annotationMode === 'round' && hole.shots.length > 0}
							<div class="shot-review" data-testid="shot-review">
								<h3>Review shot order</h3>
								<p class="empty-copy">Drag a landing to edit its position. Use the arrows for explicit order, or move a shot to another hole.</p>
								<ol class="shot-order-list" data-testid="shot-order-list">
									{#each hole.shots as shot, index (shot.id)}
										<li data-testid="shot-row-{shot.id}">
											<span class="shot-order-label">Shot {index + 1}</span>
											<div class="shot-order-actions">
												<button type="button" data-testid="shot-move-up-{shot.id}" disabled={index === 0} aria-label="Move shot up" onclick={() => handleReorderShot(shot.id, -1)}>↑</button>
												<button type="button" data-testid="shot-move-down-{shot.id}" disabled={index === hole.shots.length - 1} aria-label="Move shot down" onclick={() => handleReorderShot(shot.id, 1)}>↓</button>
												{#if holes.length > 1}
													<select data-testid="shot-reassign-{shot.id}" aria-label="Assign shot to hole" value={hole.id} onchange={(event) => handleReassignShot(event, hole.id, shot.id)}>
														<option value={hole.id}>Hole {hole.number}</option>
														{#each holes.filter((candidate) => candidate.id !== hole.id) as targetHole (targetHole.id)}
															<option value={targetHole.id}>Hole {targetHole.number}</option>
														{/each}
													</select>
												{/if}
											</div>
										</li>
									{/each}
								</ol>
							</div>
						{/if}
					</div>
				{/if}

				{#if sourceImage() && annotationMode === 'map'}
					<div class="tool-section hole-sidebar" data-testid="hole-sidebar">
						<!-- CHSPT-65: minimal course-length choice (the two standard
						     lengths) so a 9-hole course can actually reach the guided
						     flow's completion state; arbitrary counts stay future work. -->
						<div class="course-length-row" data-testid="course-length-row" role="group" aria-label="Course length">
							<span class="course-length-label">Holes</span>
							{#each [9, 18] as const as length (length)}
								{@const blocked = length < courseLength && confirmedHolesBeyond(length)}
								<button
									type="button"
									class="course-length-choice"
									class:active={courseLength === length}
									aria-pressed={courseLength === length}
									data-testid="course-length-{length}"
									disabled={blocked}
									title={blocked ? `Holes above ${length} already have confirmed placements` : undefined}
									onclick={() => (courseLength = length)}
								>
									{length}
								</button>
							{/each}
						</div>

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

						{#if allHolesConfirmed && !bendPhaseDone}
							<div class="done-panel bends-panel" data-testid="bend-phase-panel">
								<h3>Mark corridor bends</h3>
								<p>
									All {courseLength} tees and baskets are confirmed. Now walk the doglegs: pick a hole, then
									click the map wherever its fairway turns. Straight holes need nothing.
								</p>
								<div class="hole-grid">
									{#each holes.filter((hole) => hole.number >= 1 && hole.number <= courseLength) as hole (hole.id)}
										<button
											type="button"
											class="hbox"
											class:active={hole.id === activeHoleId}
											data-testid="bend-phase-hole-{hole.number}"
											onclick={() => onHoleBoxClick(hole.number)}
										>
											<span class="num">{hole.number}</span>
											<span class="tb">
												<span class={hole.corridorBends.length > 0 ? 'confirmed' : ''}>↯{hole.corridorBends.length || ''}</span>
											</span>
										</button>
									{/each}
								</div>
								<div class="stack">
									<button
										type="button"
										class="save-course-button"
										data-testid="finish-bends"
										onclick={() => {
											bendPhaseDone = true;
											exitSidebarFocus();
										}}
									>
										Finish bends →
									</button>
								</div>
							</div>
						{:else if allHolesConfirmed}
							<div class="done-panel" data-testid="course-complete-panel">
								<h3>Course complete</h3>
								<p>All {courseLength} holes have confirmed tee and basket placements.</p>
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
										data-testid="map-round-from-course"
										disabled={!savedCourseToMemory || doneRunning}
										title={savedCourseToMemory ? undefined : 'Save the course first'}
										onclick={() => void handleUploadRoundFromCourse()}
									>
										Map a round on this course →
									</button>
									<!-- CHSPT-65: the fresh-course path continues straight to Create
									     Graphics, bypassing (not replacing) Map Round. Reuses the exact
									     header-Done pipeline: build the AnnotatedRound, publish the
									     pending session artifact + course badges, best-effort Course
									     Memory save, then navigate. Not gated on the explicit
									     save-to-memory button above — handleDone performs its own
									     best-effort library write. -->
									<button
										type="button"
										class="upload-round-button"
										data-testid="continue-to-create-graphics"
										disabled={doneRunning}
										onclick={() => void handleDone()}
									>
										Continue to Create Graphics →
									</button>
								</div>
							</div>
						{:else}
							{#each [1, 2, 3, 4] as const as section (section)}
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
						<!-- "What the computer sees": the ribbon-mass shadow overlay,
						     generated fresh from every detection pass — display-only,
						     never an input to any annotation behavior. User-facing copy
						     stays free of internal detector vocabulary (see
						     docs/annotate-round-ask-copy.md's split); the detailed
						     legend and confuser labeling live in the dev-tools footer. -->
						<button
							type="button"
							class="computer-sees-toggle"
							class:active={shadowOverlayEnabled}
							aria-pressed={shadowOverlayEnabled}
							data-testid="computer-sees-toggle"
							onclick={toggleShadowOverlay}
						>
							👁 {shadowOverlayEnabled ? 'Hide' : 'Show'} what the computer sees
						</button>
						{#if shadowOverlayEnabled && shadowOverlayRender}
							<p class="computer-sees-legend">
								<span class="swatch exclusive"></span> one hole's fairway
								<span class="swatch shared"></span> shared between holes
								<span class="swatch texture"></span> looks like fairway
							</p>
						{/if}
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
					{#if shadowOverlayEnabled && shadowOverlayRender}
						<!-- Ribbon-mass shadow overlay: display-only render of the stored ShadowRun A. -->
						<image
							href={shadowOverlayRender.dataUrl}
							x="0"
							y="0"
							width={shadowOverlayRender.widthPx}
							height={shadowOverlayRender.heightPx}
							preserveAspectRatio="none"
							class="shadow-ribbon-mask"
							data-testid="shadow-ribbon-mask"
						/>
						{#if shadowHighlightCentroid}
							<circle
								cx={shadowHighlightCentroid.xPx}
								cy={shadowHighlightCentroid.yPx}
								r={22 / zoom}
								class="shadow-highlight-ring"
							/>
						{/if}
						{#each shadowOverlayRender.splitLines as splitLine (splitLine.holeNumber)}
							<line
								x1={splitLine.badge.xPx}
								y1={splitLine.badge.yPx}
								x2={splitLine.basket.xPx}
								y2={splitLine.basket.yPx}
								class="shadow-split-line"
							/>
							<text
								x={(splitLine.badge.xPx + splitLine.basket.xPx) / 2}
								y={(splitLine.badge.yPx + splitLine.basket.yPx) / 2 - 6 / zoom}
								font-size={13 / zoom}
								class="shadow-split-label"
								text-anchor="middle">H{splitLine.holeNumber} split</text
							>
						{/each}
					{/if}
					{#if middleOutOverlayEnabled && courseDetection?.middleOut}
						<!-- MiddleOut ribbon recovery: thin centerline over the raster, not
						     a filled corridor -- this is CV evidence to inspect, not a
						     finished graphic. Never an input to any annotation behavior. -->
						{#each courseDetection.middleOut.holes as middleOutHole (middleOutHole.holeNumber)}
							<polyline
								points={middleOutHole.dense.map((point) => `${point.xPx},${point.yPx}`).join(' ')}
								class="middleout-path"
								data-testid="middleout-path-{middleOutHole.holeNumber}"
							><title>Hole {middleOutHole.holeNumber} primary</title></polyline>
							{#each middleOutHole.alternates as alternate, index (index)}
								<polyline
									points={alternate.dense.map((point) => `${point.xPx},${point.yPx}`).join(' ')}
									class="middleout-alt"
									class:weak={!alternate.valid}
									data-testid="middleout-alt-{middleOutHole.holeNumber}-{index}"
								><title>Hole {middleOutHole.holeNumber} alt {alternate.endpoint} rank {alternate.rank}</title></polyline>
							{/each}
						{/each}
					{/if}
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
					{#if annotationMode === 'map' && activeHole()}
						{@const activeBadge = numberBadges.find(
							(candidate) => candidate.number === activeHole()!.number
						)}
						{#if activeBadge}
							<!-- Active-hole badge highlight: stays lit through Tee, Basket,
							     and Bends, with a brief activation pulse on hole entry
							     (keyed on the active hole). Purely visual — the SVG overlay
							     is pointer-events: none, and the active hole's badge is
							     already pointer-transparent in `claimAnnotationPointer` so
							     it never blocks clicks on geometry underneath. -->
							{#key activeHoleId}
								<circle
									cx={activeBadge.xPx}
									cy={activeBadge.yPx}
									r={16 / zoom}
									class="active-badge-ring"
									data-testid="active-badge-ring"
								/>
							{/key}
						{/if}
					{/if}
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
				{#if annotationMode === 'map' && activeHole()}
					<!-- Current-step indicator: the keyboard flow's one always-visible
					     state readout. The current step determines what an empty-map
					     click places. -->
					<div class="review-step-indicator" data-testid="review-step-indicator" role="status">
						HOLE {activeHole()!.number} · {effectiveReviewStep === 'tee'
							? 'TEE'
							: effectiveReviewStep === 'basket'
								? 'BASKET'
								: 'BENDS'}
					</div>
				{/if}
				{#if widthFeedback}
					<!-- Temporary on-map corridor-width feedback for the 1–6 keys, so
					     the result is visible without looking at the sidebar input. -->
					<div class="width-feedback" data-testid="corridor-width-feedback" role="status">
						WIDTH {widthFeedback.from} → {widthFeedback.to}
					</div>
				{/if}
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
							<span><strong>Placing Hole {sidebarBanner.holeNumber} — {sidebarBanner.piece}.</strong> Click empty map to place, drag to adjust. Tab accepts · X rejects.</span>
							<button type="button" class="banner-close" data-testid="placement-banner-cancel" onclick={exitSidebarFocus}>Cancel</button>
						{:else if sidebarBanner.kind === 'approve'}
							<span><strong>Reviewing Hole {sidebarBanner.holeNumber}.</strong> Click the map to add bends, or drag either marker to adjust. Tab completes the hole.</span>
							<button type="button" class="banner-action" data-testid="add-bend-button" onclick={startManualBends}>
								+ Add Bend(s)
							</button>
							<button type="button" class="banner-action approve" data-testid="approve-hole-button" onclick={approveActiveHole}>
								✓ Approve Hole {sidebarBanner.holeNumber}
							</button>
							<button type="button" class="banner-close" data-testid="placement-banner-cancel" onclick={exitSidebarFocus}>Cancel</button>
						{:else if sidebarBanner.kind === 'bends'}
							<span>
								<strong>Bends — Hole {sidebarBanner.holeNumber}.</strong> Click the map wherever the fairway turns.
								{sidebarBanner.manual ? 'Click Done when finished.' : 'Straight hole? Pick the next one.'}
							</span>
							<button
								type="button"
								class="banner-close"
								data-testid="placement-banner-close"
								onclick={closeBendsBanner}
							>
								{sidebarBanner.manual ? 'Done' : 'Close'}
							</button>
						{:else}
							<span>Hole {sidebarBanner.holeNumber} confirmed. Add bends anytime if the fairway isn't straight.</span>
							<button type="button" class="banner-action" data-testid="add-bend-button" onclick={startManualBends}>
								+ Add Bend(s)
							</button>
							<button type="button" class="banner-close" data-testid="placement-banner-close" onclick={exitSidebarFocus}>Close</button>
						{/if}
					</div>
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
					Your course edits will replace the stored tee/basket/corridor geometry for “{pendingLibraryUpdateConfirm.entry.name}”.
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
		<button
			type="button"
			class="dev-tools-action"
			disabled={exportingCorrections}
			onclick={() => void handleExportCorrections()}
			data-testid="export-corrections"
		>
			{exportingCorrections ? 'Exporting…' : 'Export corrections'}
		</button>
		<button
			type="button"
			class="dev-tools-action"
			disabled={exportingShadowRuns}
			onclick={() => void handleExportShadowRuns()}
			data-testid="export-shadow-runs"
		>
			{exportingShadowRuns ? 'Exporting…' : 'Export shadow runs'}
		</button>
		<label class="dev-tools-toggle" class:active={shadowOverlayEnabled}>
			<input
				type="checkbox"
				checked={shadowOverlayEnabled}
				onchange={toggleShadowOverlay}
				data-testid="shadow-overlay-toggle"
			/>
			Shadow ribbon overlay
		</label>
		{#if courseDetection?.middleOut}
			<label class="dev-tools-toggle" class:active={middleOutOverlayEnabled}>
				<input
					type="checkbox"
					checked={middleOutOverlayEnabled}
					onchange={toggleMiddleOutOverlay}
					data-testid="middleout-overlay-toggle"
				/>
				MiddleOut ribbons
			</label>
			{#if middleOutOverlayEnabled}
				<span class="middleout-legend" data-testid="middleout-overlay-legend">
					{courseDetection.middleOut.holes.length} of 18 holes recovered ·
					support field {courseDetection.middleOut.supportFieldMs.toFixed(0)}ms ·
					paths {courseDetection.middleOut.pathsMs.toFixed(0)}ms
				</span>
			{/if}
		{/if}
		{#if shadowOverlayEnabled}
			{#if shadowOverlayRender}
				<span class="shadow-overlay-legend" data-testid="shadow-overlay-legend">
					<span class="swatch exclusive"></span>1-hole ({shadowOverlayRender.counts.exclusive})
					<span class="swatch shared"></span>multi-hole ({shadowOverlayRender.counts.shared})
					<span class="swatch texture"></span>texture-only ({shadowOverlayRender.counts.textureOnly})
					· holes: {shadowOverlayRender.topologyCounts.exclusiveSameComponent} exclusive /
					{shadowOverlayRender.topologyCounts.sharedSameComponent} shared /
					{shadowOverlayRender.topologyCounts.split} split /
					{shadowOverlayRender.topologyCounts.noSeedHit} no-seed
				</span>
			{:else}
				<span class="shadow-overlay-legend">no shadow run for this image yet — run course detection first</span>
			{/if}
			{#if activeShadowRun}
				<details class="shadow-annotation-panel" data-testid="shadow-annotation-panel">
					<summary>Label confusers ({Object.keys(activeShadowRun.componentAnnotations ?? {}).length} labeled)</summary>
					<div class="shadow-annotation-list">
						{#each shadowAnnotationRows(activeShadowRun) as row (row.label)}
							<div
								class="shadow-annotation-row"
								role="listitem"
								onmouseenter={() => (shadowHighlightCentroid = row.centroid)}
								onmouseleave={() => (shadowHighlightCentroid = null)}
							>
								<span class="shadow-annotation-id">comp label={row.label}</span>
								<span>{row.areaPx}px · lStd {row.lStd.toFixed(1)}</span>
								<span>{row.ownerHoles.length > 0 ? `holes ${row.ownerHoles.join(', ')}` : 'texture-only'}</span>
								<select
									value={row.annotation?.confuserLabel ?? ''}
									onchange={(event) => setConfuserLabel(row.label, (event.currentTarget as HTMLSelectElement).value)}
								>
									<option value="">—</option>
									{#each RIBBON_MASS_CONFUSER_LABELS as confuserLabel (confuserLabel)}
										<option value={confuserLabel}>{confuserLabel}</option>
									{/each}
								</select>
							</div>
						{/each}
					</div>
				</details>
			{/if}
		{/if}
		{#if exportCorrectionsError}
			<span class="dev-tools-error" role="alert">{exportCorrectionsError}</span>
		{/if}
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

	/* Active hole's badge: a strong steady highlight that draws the eye and
	   persists through the Tee/Basket/Bends steps. */
	.number-candidate-marker.selected-hole rect {
		fill: rgb(251 191 36 / 24%);
		stroke: #fbbf24;
		stroke-width: 3;
		filter: drop-shadow(0 0 5px rgb(251 191 36 / 85%));
	}

	/* Badge-anchor ring for the active hole — the keyboard flow's "you are
	   here". Brief activation pulse on hole entry, then a steady glow. */
	.active-badge-ring {
		fill: none;
		stroke: #fbbf24;
		stroke-width: 3;
		vector-effect: non-scaling-stroke;
		filter: drop-shadow(0 0 6px rgb(251 191 36 / 90%));
		animation: badge-activate 500ms ease-out;
	}

	@keyframes badge-activate {
		from {
			stroke-width: 9;
			opacity: 0.35;
		}
		to {
			stroke-width: 3;
			opacity: 1;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.active-badge-ring {
			animation: none;
		}
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

	.shot-review {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
		padding-top: 0.35rem;
	}

	.shot-review h3 {
		margin: 0;
		font-size: 0.76rem;
		color: #d4d4d8;
	}

	.shot-order-list {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.shot-order-list li {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.35rem;
		padding: 0.25rem 0.35rem;
		border: 1px solid #3f3f46;
		border-radius: 4px;
		font-size: 0.75rem;
	}

	.shot-order-label {
		min-width: 3.4rem;
		color: #e4e4e7;
	}

	.shot-order-actions {
		display: flex;
		align-items: center;
		gap: 0.25rem;
	}

	.shot-order-actions button {
		min-height: 1.9rem;
		padding: 0.15rem 0.45rem;
	}

	.shot-order-actions select {
		min-height: 1.9rem;
		max-width: 7rem;
		border: 1px solid #52525b;
		border-radius: 4px;
		background: #18181b;
		color: #f4f4f5;
		font: inherit;
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

	/* ---- Redesigned Map-mode sidebar: threshold row, four-section hole grid, completion panel ---- */

	.hole-sidebar {
		gap: 0.7rem;
	}

	.course-length-row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.72rem;
		color: #a1a1aa;
	}

	.course-length-choice {
		padding: 0.15rem 0.55rem;
		border: 1px solid #3f3f46;
		border-radius: 4px;
		background: transparent;
		color: #a1a1aa;
		font-size: 0.72rem;
		cursor: pointer;
	}

	.course-length-choice.active {
		border-color: #22c55e;
		background: #14532d;
		color: #dcfce7;
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

	/*
	 * Placing/approve/bends banner, floating over the map (popover layer,
	 * never clipped) but fixed to the top-center of the pane rather than
	 * anchored to any in-image point — so it never sits on top of the
	 * corridor/marker geometry it's reviewing, regardless of hole shape.
	 * All of a hole's review actions (Approve, Add Bend(s), Cancel/Close)
	 * live here now, wrapping onto a second line on narrow panes rather than
	 * spilling a separate floating control over the map.
	 */
	/* Keyboard-review state readouts: the current-step indicator (bottom-left,
	   always visible while a hole is active) and the transient corridor-width
	   feedback (centered). Both are display-only. */
	.review-step-indicator {
		position: absolute;
		left: 0.75rem;
		bottom: 0.75rem;
		z-index: 26;
		padding: 0.4rem 0.7rem;
		border: 1px solid #52525b;
		border-radius: 8px;
		background: #18181bf2;
		box-shadow: 0 6px 16px rgb(0 0 0 / 45%);
		font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
		font-size: 0.85rem;
		font-weight: 700;
		letter-spacing: 0.06em;
		color: #fbbf24;
		pointer-events: none;
	}

	.width-feedback {
		position: absolute;
		left: 50%;
		top: 40%;
		transform: translate(-50%, -50%);
		z-index: 27;
		padding: 0.5rem 0.9rem;
		border: 1px solid #52525b;
		border-radius: 8px;
		background: #18181bf2;
		box-shadow: 0 10px 26px rgb(0 0 0 / 50%);
		font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
		font-size: 1rem;
		font-weight: 700;
		letter-spacing: 0.06em;
		color: #f4f4f5;
		pointer-events: none;
	}

	.placement-banner {
		position: absolute;
		top: 0.85rem;
		left: 50%;
		transform: translateX(-50%);
		z-index: 26;
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem 0.75rem;
		max-width: min(34rem, calc(100% - 1.5rem));
		padding: 0.5rem 0.5rem 0.5rem 0.9rem;
		border: 1px solid #52525b;
		border-radius: 1.4rem;
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

	.banner-close,
	.banner-action {
		flex: none;
		min-height: 1.9rem;
		padding: 0.25rem 0.6rem;
		border: 1px solid #52525b;
		border-radius: 999px;
		background: #27272a;
		color: #f4f4f5;
		font-size: 0.72rem;
		font-weight: 600;
		cursor: pointer;
		white-space: nowrap;
	}

	.banner-action.approve {
		border-color: #4fd1c5;
		background: #4fd1c5;
		color: #04211f;
		font-weight: 650;
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

	.dev-tools-action {
		padding: 0.25rem 0.5rem;
		border-radius: 5px;
		border: 1px solid #3f3f46;
		background: transparent;
		font-size: 0.68rem;
		color: #71717a;
		cursor: pointer;
	}

	.dev-tools-action:hover:not(:disabled) {
		color: #a1a1aa;
		border-color: #52525b;
	}

	.shadow-ribbon-mask {
		image-rendering: pixelated;
	}

	.shadow-split-line {
		stroke: #f87171;
		stroke-width: 2;
		stroke-dasharray: 6 4;
		vector-effect: non-scaling-stroke;
	}

	.shadow-split-label {
		fill: #fca5a5;
		stroke: #18181b;
		stroke-width: 3px;
		paint-order: stroke fill;
		font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
		font-weight: 700;
	}

	.shadow-overlay-legend {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		font-size: 0.68rem;
		color: #a1a1aa;
	}

	.shadow-overlay-legend .swatch {
		display: inline-block;
		width: 0.65rem;
		height: 0.65rem;
		border-radius: 2px;
	}

	.shadow-overlay-legend .swatch.exclusive {
		background: rgb(34 197 94 / 70%);
	}

	.shadow-overlay-legend .swatch.shared {
		background: rgb(245 158 11 / 70%);
	}

	.shadow-overlay-legend .swatch.texture {
		background: rgb(96 165 250 / 70%);
	}

	.computer-sees-toggle {
		width: 100%;
	}

	.computer-sees-toggle.active {
		border-color: #22c55e !important;
		background: #052e16 !important;
		color: #bbf7d0 !important;
	}

	.computer-sees-legend {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.3rem;
		margin: 0;
		font-size: 0.72rem;
		color: #d4d4d8;
	}

	.computer-sees-legend .swatch {
		display: inline-block;
		width: 0.65rem;
		height: 0.65rem;
		border-radius: 2px;
	}

	.computer-sees-legend .swatch.exclusive {
		background: rgb(34 197 94 / 70%);
	}

	.computer-sees-legend .swatch.shared {
		background: rgb(245 158 11 / 70%);
	}

	.computer-sees-legend .swatch.texture {
		background: rgb(96 165 250 / 70%);
	}

	.middleout-legend {
		display: inline-flex;
		align-items: center;
		font-size: 0.68rem;
		color: #a1a1aa;
	}

	/* Thin CV-evidence centerlines, not a filled corridor -- readable enough
	   to still inspect ribbon edges/roads/powerlines/C1-C2 rings underneath. */
	.middleout-path {
		fill: none;
		stroke: #fb923c;
		stroke-width: 3.5;
		stroke-linecap: round;
		stroke-linejoin: round;
		vector-effect: non-scaling-stroke;
		opacity: 0.9;
	}

	.middleout-alt {
		fill: none;
		stroke: #fb923c;
		stroke-width: 2.5;
		stroke-linecap: round;
		stroke-linejoin: round;
		vector-effect: non-scaling-stroke;
		opacity: 0.38;
	}

	/* Alternate the P6 candidate pool could not score (see capIconFalsePositives/lowParScore null). */
	.middleout-alt.weak {
		opacity: 0.2;
	}

	.shadow-highlight-ring {
		fill: none;
		stroke: #f0abfc;
		stroke-width: 3;
		vector-effect: non-scaling-stroke;
	}

	.shadow-annotation-panel {
		font-size: 0.68rem;
		color: #a1a1aa;
	}

	.shadow-annotation-panel summary {
		cursor: pointer;
	}

	.shadow-annotation-list {
		position: absolute;
		right: 0.75rem;
		bottom: 2.6rem;
		z-index: 40;
		display: flex;
		flex-direction: column;
		max-height: 20rem;
		overflow: auto;
		padding: 0.4rem;
		border: 1px solid #3f3f46;
		border-radius: 6px;
		background: #18181bf5;
		box-shadow: 0 6px 16px rgb(0 0 0 / 45%);
	}

	.shadow-annotation-row {
		display: grid;
		grid-template-columns: 7.5rem 8rem 7rem auto;
		gap: 0.4rem;
		align-items: center;
		padding: 0.15rem 0.2rem;
		border-bottom: 1px solid #2b2b30;
		font-variant-numeric: tabular-nums;
	}

	.shadow-annotation-row:hover {
		background: #27272a;
	}

	.shadow-annotation-id {
		font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
	}

	.shadow-annotation-row select {
		background: #27272a;
		color: #e4e4e7;
		border: 1px solid #52525b;
		border-radius: 4px;
		font-size: 0.68rem;
	}

	.dev-tools-error {
		font-size: 0.68rem;
		color: #ef4444;
	}
</style>
