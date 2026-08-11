<script lang="ts">
	import { onDestroy, onMount, tick } from 'svelte';
	import { goto } from '$app/navigation';
	import { base } from '$app/paths';
	import ImageEditorPane from '$lib/components/ImageEditorPane.svelte';
	import { ProjectEditor } from '$lib/domain/editor';
	import { findImageByRole } from '$lib/domain/project';
	import type { ImageAsset } from '$lib/domain/project';
	import type { DecodeImageFile, HashBytes } from '$lib/imageIntake';
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
		addHoleBeyondStandardCourse,
		addHoleWithNumber,
		assignCandidateToHole,
		clearBends,
		moveBasket,
		moveCorridorBend,
		moveShot,
		moveTee,
		nextHoleNumber,
		placeByMode,
		removeBasket,
		removeCorridorBend,
		removeHole,
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
		detectBasketCandidates,
		detectCourseCandidates,
		detectTees,
		prewarmBasketDetection,
		requestLocalSnap
	} from '$lib/autoAnnotation/basketDetection';
	import type {
		BasketCandidate,
		CourseDetectionProgressStage,
		CourseDetectionResult,
		DetectTeesResult,
		TeePadVariant
	} from '$lib/autoAnnotation/basketDetection';
	import { deriveUDiscCalibration } from '$lib/autoAnnotation/cvCalibration';
	import type { LocalSnapKind } from '$lib/cv/localSnap';
	import { acceptCandidate } from '$lib/cv/types';
	import { addWalkPoint, moveWalkPoint, removeWalkPoint } from '$lib/walkingPath';
	import type { SourcePoint } from '$lib/domain/project';

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

	const TEE_VARIANTS: readonly TeePadVariant[] = ['gray-center', 'edge-loop', 'fused'];
	const TEE_VARIANT_LABELS: Record<TeePadVariant, string> = {
		'gray-center': 'Gray center',
		'edge-loop': 'Edge loop',
		fused: 'Fused'
	};
	const TEE_VARIANT_SHORT_LABELS: Record<TeePadVariant, string> = {
		'gray-center': 'GC',
		'edge-loop': 'EL',
		fused: 'F'
	};
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
		/**
		 * Whether Alt was held on the empty-space click that opened this menu
		 * (irrelevant, always `false`, for a `hitMarker` delete menu — deleting
		 * never places a point). Snap-to-detection's escape hatch: threaded
		 * through to `chooseRadialAction`'s tee/basket placement so a user who
		 * deliberately wants the raw click, not the nearest detected feature,
		 * can suppress the snap.
		 */
		altKey: boolean;
	}

	interface Props {
		editor?: ProjectEditor;
		decode?: DecodeImageFile;
		hash?: HashBytes;
		courseLibraryStore?: CourseLibraryStore;
	}

	let { editor: initialEditor, decode, hash, courseLibraryStore: initialCourseLibraryStore }: Props = $props();
	// svelte-ignore state_referenced_locally
	void hash; // Test-seam parity with create-graphics; this page never saves/opens a bundle.

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

	function resolveInitialEditor(): ProjectEditor {
		// An explicitly injected editor (tests) wins; otherwise reuse the retained
		// in-memory session across SPA navigation, or start a fresh project.
		return initialEditor ?? takeRetainedEditor('annotate-round') ?? new ProjectEditor();
	}

	onDestroy(() => {
		stopCourseDetectionProgress();
		clearRevealTimers();
		if (participatesInSession) retainEditor('annotate-round', editor);
	});

	let refreshCount = $state(0);

	function sourceImage(): ImageAsset | null {
		void refreshCount;
		return findImageByRole(editor.state.images, 'source-overview') ?? null;
	}

	/**
	 * Hole annotation draft. Manual placement and basket CV proposals are both
	 * transient until the user applies them and clicks Done. Cleared whenever the
	 * source image is replaced, since existing points are coordinates into a
	 * specific raster and make no sense against a different one.
	 */
	let holes = $state<AnnotatedHole[]>([]);
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
	let basketCandidates = $state<readonly BasketCandidate[]>([]);
	/**
	 * Which flow last populated `basketCandidates` — the full course-detection
	 * pipeline, or the standalone "Detect baskets" fallback below it. Needed
	 * because `$state` deep-proxies arrays/objects: `basketCandidates` and
	 * `courseDetection.baskets` are assigned from the exact same array at the
	 * same statement, but each becomes its own reactive proxy, so `===`
	 * between them is unreliable. This flag is what candidate reveal/
	 * interactivity gates on instead.
	 */
	let basketCandidatesSource = $state<'course-detection' | 'standalone' | null>(null);
	let selectedBasketCandidate = $state<number | null>(null);
	let basketDetectionRunning = $state(false);
	let basketDetectionError = $state<string | null>(null);
	let courseDetection = $state<CourseDetectionResult | null>(null);
	let courseDetectionRunning = $state(false);
	let courseDetectionStatus = $state<string | null>(null);
	let courseDetectionElapsedSeconds = $state(0);
	let courseDetectionStartedAt = 0;
	let courseDetectionTimer: ReturnType<typeof setInterval> | null = null;
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
	 * A pointerdown anywhere outside the open candidate-assign confirmation
	 * chip dismisses it without acting — the same click-outside contract
	 * `RadialMenu.svelte` implements for itself, reproduced here because this
	 * chip is a plain page-owned popover, not a component with its own
	 * lifecycle.
	 */
	$effect(() => {
		if (!candidateAssignConfirm) return;
		function handlePointerDown(event: PointerEvent): void {
			if (candidateConfirmEl && event.target instanceof Node && !candidateConfirmEl.contains(event.target)) {
				candidateAssignConfirm = null;
			}
		}
		window.addEventListener('pointerdown', handlePointerDown);
		return () => window.removeEventListener('pointerdown', handlePointerDown);
	});

	let teeExperimentEnabled = $state<Record<TeePadVariant, boolean>>({
		'gray-center': true,
		'edge-loop': true,
		fused: true
	});
	let teeExperimentFullResolution = $state(false);
	let teeExperimentRunning = $state(false);
	let teeExperimentError = $state<string | null>(null);
	let teeExperimentResult = $state<DetectTeesResult | null>(null);
	let selectedTeeCandidateKey = $state<string | null>(null);

	/** The compact status-strip's current stage, mirrored from the worker's real progress messages (never simulated). */
	let courseDetectionStage = $state<CourseDetectionProgressStage | null>(null);

	/**
	 * Staged reveal of a completed course-detection result (PART B): once
	 * `'done'`, every candidate overlay is fully visible — the initial value
	 * and the reduced-motion outcome, both of which are "today's behavior",
	 * everything at once. `startCandidateReveal` steps this through the
	 * intermediate stages with a short stagger when motion is allowed.
	 */
	type RevealStage = 'numbers' | 'tees' | 'baskets' | 'grammar' | 'done';
	const REVEAL_STAGE_ORDER: readonly RevealStage[] = ['numbers', 'tees', 'baskets', 'grammar'];
	const REVEAL_STAGGER_MS = 250;
	let revealStage = $state<RevealStage>('done');
	let revealTimers: ReturnType<typeof setTimeout>[] = [];

	/** A candidate assignment awaiting one-click confirmation (PART C), anchored at the clicked marker. */
	interface CandidateAssignConfirm {
		readonly kind: 'tee' | 'basket';
		readonly point: SourcePoint;
		readonly holeId: string;
		readonly holeNumber: number;
		readonly mode: 'replace' | 'move' | 'delete';
	}
	let candidateAssignConfirm = $state<CandidateAssignConfirm | null>(null);
	let candidateConfirmEl = $state<HTMLDivElement | null>(null);

	/** Pointer-claim state for a tee/basket candidate marker, mirroring `numberSelectDrag` below. */
	interface CourseCandidateDrag {
		readonly kind: 'tee' | 'basket';
		readonly point: SourcePoint;
		readonly start: ScreenSpacePoint;
		dragging: boolean;
	}
	let courseCandidateDrag = $state<CourseCandidateDrag | null>(null);

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

	function clearRevealTimers(): void {
		for (const timer of revealTimers) clearTimeout(timer);
		revealTimers = [];
	}

	/**
	 * Steps `revealStage` through `REVEAL_STAGE_ORDER` with a short stagger
	 * (PART B) once a course-detection result exists — presentation only, the
	 * single already-computed result is never re-run or re-ordered. Under
	 * `prefers-reduced-motion: reduce`, every stage lands at once: today's
	 * exact behavior, and also this function's starting state, so no timers
	 * are ever created in that case.
	 */
	function startCandidateReveal(): void {
		clearRevealTimers();
		if (prefersReducedMotion()) {
			revealStage = 'done';
			return;
		}
		revealStage = REVEAL_STAGE_ORDER[0];
		for (let index = 1; index < REVEAL_STAGE_ORDER.length; index += 1) {
			const stage = REVEAL_STAGE_ORDER[index];
			revealTimers.push(setTimeout(() => { revealStage = stage; }, REVEAL_STAGGER_MS * index));
		}
		revealTimers.push(
			setTimeout(() => { revealStage = 'done'; }, REVEAL_STAGGER_MS * REVEAL_STAGE_ORDER.length)
		);
	}

	/** Whether a candidate overlay stage has been revealed yet (or motion is reduced, in which case everything has). */
	function revealedUpTo(stage: 'numbers' | 'tees' | 'baskets' | 'grammar'): boolean {
		if (revealStage === 'done') return true;
		return REVEAL_STAGE_ORDER.indexOf(revealStage) >= REVEAL_STAGE_ORDER.indexOf(stage);
	}

	/** Moves to (creating if necessary) the first hole-number proposal that still needs review, for the summary chip's jump action. */
	function jumpToFirstNeedsReview(): void {
		if (!courseDetection) return;
		const target = courseDetection.grammar.holes.find((hole) => hole.status !== 'ready');
		if (!target) return;
		selectOrCreateHoleByNumber(target.number);
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
	 * Early-dev default: every source image gets run through full-course
	 * detection automatically, so tap-to-select-by-number and ready-hole tee/
	 * basket placement both work without a manual "Detect full course" click.
	 * Re-running the button manually still skips auto-apply so a user's own
	 * corrections are never silently overwritten.
	 */
	$effect(() => {
		void refreshCount;
		const image = sourceImage();
		if (!image || image.id === autoDetectedSourceId || typeof Worker === 'undefined') return;
		autoDetectedSourceId = image.id;
		void handleDetectCourse({ autoApply: true });
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

	function handleAddHoleBeyondStandardCourse(): void {
		const inheritedWidthPx = currentCorridorWidthPx();
		const nextHoles = addHoleBeyondStandardCourse(holes);
		const addedHole = nextHoles.find((hole) => !holes.some((existing) => existing.id === hole.id));
		if (!addedHole) return;
		holes = setCorridorWidth(nextHoles, addedHole.id, inheritedWidthPx);
		activeHoleId = addedHole.id;
	}

	function handleRemoveHole(holeId: string): void {
		const removedIndex = holes.findIndex((hole) => hole.id === holeId);
		const removedHole = holes[removedIndex];
		if (!removedHole) return;
		const removeButton = document.querySelector<HTMLButtonElement>(
			`[data-testid="hole-remove-${removedHole.number}"]`
		);
		const shouldRestoreFocus = document.activeElement === removeButton;
		const remainingHoles = removeHole(holes, holeId);
		const nextActiveHoleId =
			activeHoleId === holeId ? remainingHoles[0]?.id ?? null : activeHoleId;
		if (radialMenu?.holeId === holeId) radialMenu = null;
		holes = remainingHoles;
		activeHoleId = nextActiveHoleId;

		if (shouldRestoreFocus) {
			const focusHole =
				remainingHoles.find((hole) => hole.id === nextActiveHoleId) ??
				remainingHoles[removedIndex] ??
				remainingHoles[removedIndex - 1];
			void tick().then(() => {
				const selector = focusHole
					? `[data-testid="hole-select-${focusHole.number}"]`
					: '[data-testid="hole-add"]';
				document.querySelector<HTMLButtonElement>(selector)?.focus({ preventScroll: true });
			});
		}
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
		if (event.key === 'Escape' && candidateAssignConfirm) {
			event.preventDefault();
			candidateAssignConfirm = null;
			return;
		}
		if (isModalOpen()) return;
		if (isShortcutEditableTarget(event.target)) return;
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

	/** Moves `activeHoleId` to the previous/next existing hole, wrapping around. */
	function cycleHole(direction: 1 | -1): void {
		if (holes.length === 0) return;
		const sorted = [...holes].sort((left, right) => left.number - right.number);
		const currentIndex = sorted.findIndex((hole) => hole.id === activeHoleId);
		const nextIndex =
			currentIndex === -1
				? direction === 1
					? 0
					: sorted.length - 1
				: (currentIndex + direction + sorted.length) % sorted.length;
		activeHoleId = sorted[nextIndex].id;
		vibrate(6);
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
	 * Nearest revealed tee/basket CV candidate under the pointer, if any — the
	 * hit-test `claimAnnotationPointer` uses so a candidate-marker click is
	 * claimed before it ever reaches `onPlacement`, exactly like
	 * `numberCandidateHitAt` above (the same precedence mechanism keeps the
	 * radial menu from opening on either kind of candidate click). Only
	 * markers the staged reveal has actually shown are hit-testable, so a
	 * candidate can't be clicked a moment before its overlay fades in.
	 */
	function courseCandidateHitAt(
		pointer: ScreenSpacePoint,
		view: ViewTransformState
	): { kind: 'tee' | 'basket'; point: SourcePoint } | null {
		if (!courseDetection) return null;
		let closest: { kind: 'tee' | 'basket'; point: SourcePoint } | null = null;
		let closestDistance = Number.POSITIVE_INFINITY;

		function consider(kind: 'tee' | 'basket', point: SourcePoint, radiusPx: number): void {
			const screen = imageToScreen(point, view);
			const distance = Math.hypot(pointer.x - screen.x, pointer.y - screen.y);
			const radius = Math.max(MARKER_HIT_RADIUS_PX, radiusPx * view.zoom);
			if (distance > radius || distance >= closestDistance) return;
			closestDistance = distance;
			closest = { kind, point: { xPx: point.xPx, yPx: point.yPx } };
		}

		if (revealedUpTo('tees')) {
			for (const candidate of courseDetection.tees) {
				consider('tee', candidate, Math.max(candidate.widthPx, candidate.heightPx) / 2 + 6);
			}
		}
		// `basketCandidates` is shared with the standalone "Detect baskets"
		// fallback (`handleDetectBaskets`), which can overwrite it with an
		// unrelated result after a full course detection already ran. Only hit
		// -test baskets that are still the course-detection set the visible
		// markers are actually drawn from.
		if (revealedUpTo('baskets') && basketCandidatesSource === 'course-detection') {
			for (const candidate of courseDetection.baskets) {
				consider('basket', candidate, 12);
			}
		}
		return closest;
	}

	/** The draft hole (if any) whose current tee/basket is exactly this candidate point — i.e. the point's current "home". */
	function holeHoldingPoint(kind: 'tee' | 'basket', point: SourcePoint): AnnotatedHole | undefined {
		return holes.find((hole) => {
			const existing = kind === 'tee' ? hole.tee : hole.basket;
			return existing !== undefined && existing.xPx === point.xPx && existing.yPx === point.yPx;
		});
	}

	/** Accessible name for a candidate marker, describing exactly what a click on it right now would do. */
	function candidateAriaLabel(kind: 'tee' | 'basket', point: SourcePoint): string {
		const label = kind === 'tee' ? 'tee' : 'basket';
		const active = activeHole();
		if (!active) return `Detected ${label}`;
		const sourceHole = holeHoldingPoint(kind, point);
		if (sourceHole?.id === active.id) return `Detected ${label} — hole ${active.number}'s own ${label}, click to remove`;
		const activeHasFeature = kind === 'tee' ? active.tee !== undefined : active.basket !== undefined;
		if (activeHasFeature) return `Detected ${label} — hole ${active.number} already has a ${label}, click to replace`;
		if (sourceHole) return `Detected ${label} — move to hole ${active.number}`;
		return `Detected ${label} — assign to hole ${active.number}`;
	}

	/**
	 * The frictionless-correction interaction (PART C): clicking a detected
	 * tee/basket candidate assigns its `{xPx, yPx}` — coordinates only, via
	 * `assignCandidateToHole` — to the active hole instantly when nothing
	 * would be overwritten or moved from elsewhere; otherwise it opens a
	 * one-click confirmation chip anchored at the marker instead of acting
	 * immediately.
	 */
	function handleCandidateMarkerClick(kind: 'tee' | 'basket', point: SourcePoint): void {
		const active = activeHole();
		if (!active) return;
		const sourceHole = holeHoldingPoint(kind, point);
		if (sourceHole?.id === active.id) {
			// Already exactly this hole's point: clicking it again offers to remove it.
			candidateAssignConfirm = {
				kind,
				point,
				holeId: active.id,
				holeNumber: active.number,
				mode: 'delete'
			};
			return;
		}
		const activeHasFeature = kind === 'tee' ? active.tee !== undefined : active.basket !== undefined;
		if (!activeHasFeature && !sourceHole) {
			holes = assignCandidateToHole(holes, active.id, kind, point);
			vibrate(8);
			return;
		}
		candidateAssignConfirm = {
			kind,
			point,
			holeId: active.id,
			holeNumber: active.number,
			mode: activeHasFeature ? 'replace' : 'move'
		};
	}

	/** Executes the pending confirmation — replace and move are the same coordinates-only assignment underneath; delete clears the hole's feature instead. */
	function confirmCandidateAssign(): void {
		if (!candidateAssignConfirm) return;
		const { holeId, kind, point, mode } = candidateAssignConfirm;
		if (mode === 'delete') {
			holes = kind === 'tee' ? removeTee(holes, holeId) : removeBasket(holes, holeId);
		} else {
			holes = assignCandidateToHole(holes, holeId, kind, point);
		}
		candidateAssignConfirm = null;
		vibrate(8);
	}

	function dismissCandidateAssign(): void {
		candidateAssignConfirm = null;
	}

	/** Selects the hole matching a tapped map number, creating it first if it doesn't exist yet. */
	function selectOrCreateHoleByNumber(number: number): void {
		const existing = holes.find((hole) => hole.number === number);
		if (existing) {
			activeHoleId = existing.id;
			vibrate(8);
			return;
		}
		const inheritedWidthPx = currentCorridorWidthPx();
		const nextHoles = addHoleWithNumber(holes, number);
		const added = nextHoles.find((hole) => !holes.some((existingHole) => existingHole.id === hole.id));
		if (!added) return;
		holes = setCorridorWidth(nextHoles, added.id, inheritedWidthPx);
		activeHoleId = added.id;
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

	/** The number-badge anchor `requestLocalSnap`'s worker request re-derives `UiScalePx`/`BasketTemplateScale` from — the same one `handleDetectTees` already reads out of `courseDetection`, raw (unbranded) since only the worker needs to re-brand it. `null` before "Detect course" has ever run: there is no calibration to crop or size a snap window from yet. */
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
	 * marker, otherwise the wedges the current mode's activity allows. Map
	 * mode places course geometry (tee/basket if absent, bend always); round
	 * mode places round-specific points (shot only with a hole active, walk
	 * always — the walk path needs no hole).
	 */
	function radialMenuActions(menu: RadialMenuState): RadialAction[] {
		if (menu.hitMarker) return ['delete'];
		if (annotationMode === 'round') {
			const actions: RadialAction[] = [];
			if (menu.holeId) actions.push('shot');
			actions.push('walk');
			return actions;
		}
		const hole = holes.find((candidate) => candidate.id === menu.holeId);
		if (!hole) return [];
		const actions: RadialAction[] = [];
		if (!hole.tee) actions.push('tee');
		if (!hole.basket) actions.push('basket');
		actions.push('bend');
		return actions;
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
			holes = placeByMode(holes, menu.holeId, action, menu.at);
			if (isMapGeometryKind(action)) markMapGeometryEdited();
			if (action === 'tee' || action === 'basket') {
				applyLocalSnap(action, menu.holeId, menu.at, menu.altKey);
			}
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

	/**
	 * A real tee/basket marker belonging to a hole OTHER than the active one
	 * can exactly coincide with a revealed CV candidate — the ordinary case
	 * right after accepting a ready hole, whose point is the candidate's
	 * coordinates verbatim. In exactly that case the candidate interpretation
	 * wins, so PART C's move-to-the-active-hole interaction stays reachable
	 * instead of being permanently shadowed by the foreign hole's delete
	 * menu. The active hole's OWN marker is untouched by this — clicking it
	 * still opens its delete menu exactly as before, since a candidate that
	 * exactly matches the active hole's own point is already a no-op in
	 * `handleCandidateMarkerClick`.
	 */
	function shouldPreferCandidateOverMarker(marker: AnnotationMarkerHit): boolean {
		if (marker.kind !== 'tee' && marker.kind !== 'basket') return false;
		if (marker.holeId === activeHoleId) return false;
		if (!courseDetection) return false;
		const point = markerPoint(marker);
		if (!point) return false;
		if (marker.kind === 'tee') {
			if (!revealedUpTo('tees')) return false;
			return courseDetection.tees.some((candidate) => candidate.xPx === point.xPx && candidate.yPx === point.yPx);
		}
		if (!revealedUpTo('baskets') || basketCandidatesSource !== 'course-detection') return false;
		return courseDetection.baskets.some((candidate) => candidate.xPx === point.xPx && candidate.yPx === point.yPx);
	}

	function claimAnnotationPointer(
		pointer: ScreenSpacePoint,
		event: PointerEvent,
		view: ViewTransformState
	): boolean {
		if (!sourceImage()) return false;
		const marker = pointHitAt(pointer, view);
		if (marker && !shouldPreferCandidateOverMarker(marker)) {
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
		const courseCandidate = courseCandidateHitAt(pointer, view);
		if (courseCandidate) {
			courseCandidateDrag = { ...courseCandidate, start: { ...pointer }, dragging: false };
			void event;
			return true;
		}
		return false;
	}

	function previewAnnotationMove(pointer: ScreenSpacePoint, event: PointerEvent): void {
		if (courseCandidateDrag) {
			const distance = Math.hypot(pointer.x - courseCandidateDrag.start.x, pointer.y - courseCandidateDrag.start.y);
			if (distance > clickSlopPx(event.pointerType)) courseCandidateDrag.dragging = true;
			return;
		}
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

	function commitAnnotationPointerUp(pointer: ScreenSpacePoint, event?: PointerEvent): void {
		if (courseCandidateDrag) {
			const { kind, point, dragging } = courseCandidateDrag;
			courseCandidateDrag = null;
			if (!dragging) handleCandidateMarkerClick(kind, point);
			return;
		}
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
			const point =
				drag.marker.kind === 'walk'
					? (drag.marker.index !== undefined ? walkingPath[drag.marker.index] ?? null : null)
					: markerPoint(drag.marker);
			if (point) radialMenu = { at: point, holeId: drag.marker.holeId, hitMarker: drag.marker, altKey: false };
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
		courseCandidateDrag = null;
		previewHoles = null;
		previewWalkingPath = null;
	}

	/**
	 * Opens the empty-space placement menu. In round mode this works even with
	 * no hole active — the menu then offers only `walk`, since the walk path
	 * is round-level rather than per-hole. In map mode a hole must be active,
	 * matching the pre-mode-split behavior. `altKey` carries snap-to-detection's
	 * escape hatch (see `RadialMenuState.altKey`'s doc comment) from the click
	 * that opened this menu through to the eventual placement.
	 */
	function handleAnnotationPlacement(
		coordinates: { xPx: number; yPx: number },
		options: { altKey?: boolean } = {}
	): void {
		if (annotationMode === 'map' && !activeHoleId) return;
		radialMenu = { at: coordinates, holeId: activeHoleId, hitMarker: null, altKey: options.altKey ?? false };
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
		basketCandidates = [];
		basketCandidatesSource = null;
		selectedBasketCandidate = null;
		basketDetectionError = null;
		courseDetection = null;
		courseDetectionStatus = null;
		courseDetectionStage = null;
		courseDetectionElapsedSeconds = 0;
		stopCourseDetectionProgress();
		clearRevealTimers();
		revealStage = 'done';
		candidateAssignConfirm = null;
		courseCandidateDrag = null;
		teeExperimentEnabled = { 'gray-center': true, 'edge-loop': true, fused: true };
		teeExperimentFullResolution = false;
		teeExperimentResult = null;
		teeExperimentError = null;
		selectedTeeCandidateKey = null;
	}

	function deriveMapBoundsFromNumbers(
		candidates: readonly { readonly label?: number; readonly yPx: number }[] | undefined,
		imageHeightPx: number
	): { topPx: number; bottomPx: number } | undefined {
		const labeled = candidates?.filter((candidate) => candidate.label !== undefined) ?? [];
		if (labeled.length < 3) return undefined;
		const ys = labeled.map((candidate) => candidate.yPx);
		const minY = Math.min(...ys);
		const maxY = Math.max(...ys);
		const spread = maxY - minY;
		const margin = Math.max(80, Math.min(300, spread * 0.3));
		return {
			topPx: Math.max(0, minY - margin),
			bottomPx: Math.min(imageHeightPx, maxY + margin)
		};
	}

	async function handleDetectTees(): Promise<void> {
		const image = sourceImage();
		if (!image || teeExperimentRunning) return;
		const resource = editor.getAssetResource(image.id);
		if (!resource) {
			teeExperimentError = 'The source image bytes are no longer available.';
			return;
		}

		const variants = TEE_VARIANTS.filter((variant) => teeExperimentEnabled[variant]);
		if (variants.length === 0) return;

		teeExperimentRunning = true;
		teeExperimentError = null;
		teeExperimentResult = null;
		selectedTeeCandidateKey = null;
		try {
			const numberAnchor = courseDetection?.numberDetection?.anchor;
			const cachedScale = numberAnchor
				? deriveUDiscCalibration({
						scale: numberAnchor.scale,
						widthPx: numberAnchor.widthPx,
						heightPx: numberAnchor.heightPx
				  }).uiScalePx
				: undefined;
			const mapBoundsPx = deriveMapBoundsFromNumbers(
				courseDetection?.numberDetection?.candidates,
				image.heightPx
			);
			teeExperimentResult = await detectTees(
				resource.bytes,
				image.mimeType,
				image.widthPx,
				image.heightPx,
				{
					variants,
					uiScalePx: cachedScale,
					mapBoundsPx,
					fullResolution: teeExperimentFullResolution
				}
			);
		} catch (error) {
			teeExperimentResult = null;
			teeExperimentError = error instanceof Error ? error.message : 'Tee detection failed.';
		} finally {
			teeExperimentRunning = false;
		}
	}

	async function handleDetectCourse(options: { autoApply?: boolean } = {}): Promise<void> {
		const image = sourceImage();
		if (!image || courseDetectionRunning || basketDetectionRunning) return;
		const resource = editor.getAssetResource(image.id);
		if (!resource) {
			basketDetectionError = 'The source image bytes are no longer available.';
			return;
		}

		const detectedImageId = image.id;
		courseDetectionRunning = true;
		basketDetectionError = null;
		selectedBasketCandidate = null;
		courseDetectionStage = null;
		candidateAssignConfirm = null;
		courseCandidateDrag = null;
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
			basketCandidates = result.baskets;
			basketCandidatesSource = 'course-detection';
			startCandidateReveal();
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
			if (options.autoApply) applyReadyCourseHoles({ skipExisting: true });
			await recognizeCourse(detectedImageId, numberBadges, labeledBaskets);
		} catch (error) {
			if (sourceImage()?.id !== detectedImageId) return;
			courseDetection = null;
			courseDetectionStatus = 'Detection failed';
			clearRevealTimers();
			revealStage = 'done';
			basketDetectionError = error instanceof Error ? error.message : 'Course detection failed.';
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
	 * `skipExisting` protects a manually-placed tee or basket from being
	 * silently clobbered by a re-run of detection — used by the auto-detect
	 * effect, which can fire against a hole the user is already correcting
	 * (checked per field: a hole with a manual tee but no basket yet still
	 * gets the detector's basket, without touching the tee). The explicit
	 * "Apply N ready holes" button leaves it off: a user pressing that button
	 * is deliberately asking to reapply both.
	 */
	function applyReadyCourseHoles(options: { skipExisting?: boolean } = {}): void {
		if (!courseDetection) return;
		const ready = courseDetection.grammar.holes.filter(
			(proposal) => proposal.status === 'ready' && proposal.tee && proposal.basket
		);
		if (ready.length === 0) return;

		const inheritedWidthPx = currentCorridorWidthPx();
		const existingByNumber = new Map(holes.map((hole) => [hole.number, hole]));
		for (const proposal of ready) {
			const existing = existingByNumber.get(proposal.number);
			const keepTee = options.skipExisting && existing?.tee;
			const keepBasket = options.skipExisting && existing?.basket;
			if (keepTee && keepBasket) continue;
			const next: AnnotatedHole = {
				...(existing ?? {
					id: crypto.randomUUID(),
					number: proposal.number,
					shots: [],
					corridorBends: [],
					corridorWidthPx: inheritedWidthPx
				}),
				tee: keepTee ? existing!.tee! : acceptCandidate(proposal.tee!),
				basket: keepBasket ? existing!.basket! : acceptCandidate(proposal.basket!)
			};
			existingByNumber.set(proposal.number, next);
		}
		holes = [...existingByNumber.values()].sort((a, b) => a.number - b.number);
		activeHoleId = activeHoleId ?? holes[0]?.id ?? null;
	}

	async function handleDetectBaskets(): Promise<void> {
		const image = sourceImage();
		if (!image || basketDetectionRunning) return;
		const resource = editor.getAssetResource(image.id);
		if (!resource) {
			basketDetectionError = 'The source image bytes are no longer available.';
			return;
		}

		basketDetectionRunning = true;
		basketDetectionError = null;
		selectedBasketCandidate = null;
		try {
			basketCandidates = await detectBasketCandidates(
				resource.bytes,
				image.mimeType,
				image.widthPx,
				image.heightPx
			);
			basketCandidatesSource = 'standalone';
			if (basketCandidates.length === 0) {
				basketDetectionError =
					'No basket candidates found. Try a full UDisc map screenshot with the basket icons visible.';
			}
		} catch (error) {
			basketCandidates = [];
			basketCandidatesSource = null;
			basketDetectionError =
				error instanceof Error ? error.message : 'Basket detection failed.';
		} finally {
			basketDetectionRunning = false;
		}
	}

	function applySelectedBasket(): void {
		if (selectedBasketCandidate === null || !activeHoleId) return;
		const candidate = basketCandidates[selectedBasketCandidate];
		if (!candidate) return;
		holes = holes.map((hole) =>
			hole.id === activeHoleId ? { ...hole, basket: acceptCandidate(candidate) } : hole
		);
		selectedBasketCandidate = null;
	}

	function selectBasketCandidate(index: number): void {
		selectedBasketCandidate = index;
		if (activeHoleId) return;

		// Candidate review needs an active hole to show the preview and enable
		// Apply. Create the first draft hole on demand so the detector is usable
		// immediately after the user clicks a candidate.
		if (holes.length > 0) {
			activeHoleId = holes[holes.length - 1].id;
			return;
		}
		const inheritedWidthPx = currentCorridorWidthPx();
		const nextHoles = addHole(holes);
		const addedHole = nextHoles[nextHoles.length - 1];
		holes = setCorridorWidth(nextHoles, addedHole.id, inheritedWidthPx);
		activeHoleId = addedHole.id;
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

	<header class="toolbar">
		<div>
			<h1>Annotate Round</h1>
			<p>Mark up the course map in Map mode, then switch to Round mode for throws and the walk path.</p>
			<p>
				Placing or dragging a tee or basket snaps to the nearest detected feature — hold Alt to place it exactly
				where you click.
			</p>
		</div>
		<button
			type="button"
			data-testid="annotate-done"
			disabled={!canFinishAnnotation() || doneRunning}
			onclick={handleDone}
			title="Finish annotating and move to Create Graphics"
		>
			Done
		</button>
	</header>

	{#if doneError}
		<p class="error" data-testid="annotate-done-error" role="alert">{doneError}</p>
	{/if}

	<div class="mode-toggle" role="group" aria-label="Annotation mode" data-testid="annotation-mode-toggle">
		<button
			type="button"
			class="mode-toggle-button"
			class:active={annotationMode === 'map'}
			aria-pressed={annotationMode === 'map'}
			data-testid="annotation-mode-map"
			onclick={() => setAnnotationMode('map')}
		>
			<span class="mode-toggle-label">Map</span>
			<span class="mode-toggle-hint">Course geometry</span>
		</button>
		<button
			type="button"
			class="mode-toggle-button"
			class:active={annotationMode === 'round'}
			aria-pressed={annotationMode === 'round'}
			data-testid="annotation-mode-round"
			onclick={() => setAnnotationMode('round')}
		>
			<span class="mode-toggle-label">Round</span>
			<span class="mode-toggle-hint">Throws &amp; walk path</span>
		</button>
	</div>

	<nav class="hole-bar" aria-label="Course holes" data-testid="hole-bar">
		<div class="hole-bar-compact">
			<button
				type="button"
				class="hole-bar-compact-nav"
				aria-label="Previous hole"
				disabled={holes.length === 0}
				onclick={() => cycleHole(-1)}
			>‹</button>
			<span class="hole-bar-compact-label" data-testid="hole-bar-current-label">
				{activeHole() ? `Hole ${activeHole()!.number}` : 'No hole selected'}
			</span>
			<button
				type="button"
				class="hole-bar-compact-nav"
				aria-label="Next hole"
				disabled={holes.length === 0}
				onclick={() => cycleHole(1)}
			>›</button>
		</div>
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
		<div class="hole-bar-actions">
			<button
				type="button"
				data-testid="hole-add"
				aria-keyshortcuts="A N"
				disabled={nextHoleNumber(holes) === null}
				onclick={handleAddHole}
			>
				Add hole <kbd>A</kbd> / <kbd>N</kbd>
			</button>
			<button
				type="button"
				class="hole-add-beyond"
				data-testid="hole-add-beyond"
				aria-label="Add hole beyond 18"
				onclick={handleAddHoleBeyondStandardCourse}
			>
				+ <span class="sr-only">Add hole beyond 18</span>
			</button>
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
		>
			{#snippet tools()}
				<div class="tool-section hole-management">
					<div class="section-heading">
						<h2>Hole controls</h2>
						<span>{holes.length} active</span>
					</div>
					{#if holes.length > 0}
						<ul class="hole-remove-list" data-testid="hole-list">
							{#each holes as hole (hole.id)}
								<li class:active={hole.id === activeHoleId}>
									<span>Hole {hole.number}</span>
									<button
										type="button"
										class="remove-hole-button"
										data-testid="hole-remove-{hole.number}"
										aria-label={`Remove hole ${hole.number}`}
										onclick={() => handleRemoveHole(hole.id)}
									>Remove hole {hole.number}</button>
								</li>
							{/each}
						</ul>
					{:else}
						<p class="empty-copy">Add a hole from the bar, then click directly on the map.</p>
					{/if}
				</div>

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
						<label class="width-control">
							<span>Corridor width — all holes (px)</span>
							<input
								type="number"
								min="1"
								step="1"
								value={hole.corridorWidthPx}
								onchange={handleCorridorWidthChange}
								data-testid="corridor-width"
							/>
						</label>
					</div>
				{/if}

				{#if sourceImage()}
					<div class="tool-section detection">
						<div class="section-heading">
							<h2>Course assist</h2>
							{#if basketCandidates.length > 0}<span>{basketCandidates.length} found</span>{/if}
						</div>
						<button
							type="button"
							class="detect-button"
							data-testid="detect-course"
							disabled={courseDetectionRunning || basketDetectionRunning}
							onclick={() => void handleDetectCourse()}
						>
							{courseDetectionRunning ? 'Detecting the course…' : 'Detect full course'}
						</button>
						{#if courseDetectionStatus}
							<p
								class="detection-progress"
								data-testid="course-detection-controls-progress"
								data-running={courseDetectionRunning ? 'true' : 'false'}
								role="status"
							>
								<span class="progress-dot" class:running={courseDetectionRunning} aria-hidden="true"></span>
								<span class="progress-copy">{courseDetectionStatus}</span>
								<span class="progress-time">{courseDetectionElapsedSeconds}s</span>
							</p>
						{/if}
						{#if courseDetection}
							{@const assignedNumbers = courseDetection.numberDetection.candidates.filter((candidate) => candidate.label !== undefined).length}
							{@const readyHoles = courseDetection.grammar.holes.filter((proposal) => proposal.status === 'ready').length}
							<p class="detection-summary" data-testid="course-detection-controls-summary">
								{assignedNumbers} numbers · {courseDetection.tees.length} tees · {courseDetection.baskets.length} baskets · {readyHoles} ready
							</p>
							{#if courseDetection.numberDetection.note}
								<p class="tool-note">{courseDetection.numberDetection.note}</p>
							{/if}
							{#if courseDetection.numberDetection.candidates.some((candidate) => candidate.topGlyphMatches?.length)}
								<details class="number-diagnostics" open>
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
												<span class="diagnostic-raw">
													raw
													{#each rawMatches as match, matchIndex (match.label)}
														{matchIndex > 0 ? ' · ' : ' '}H{match.label} {(match.score * 100).toFixed(0)}%
													{/each}
												</span>
											</div>
										{/each}
									</div>
								</details>
							{/if}
							<button
								type="button"
								class="apply-button"
								data-testid="apply-ready-course-holes"
								disabled={readyHoles === 0}
								onclick={() => applyReadyCourseHoles()}
							>
								Apply {readyHoles} ready holes
							</button>
						{/if}
						<p class="assist-divider">Tee experiments</p>
						<div class="tee-experiment-controls">
							<div class="tee-variant-toggles">
								{#each TEE_VARIANTS as variant (variant)}
									<label class:active={teeExperimentEnabled[variant]}>
										<input
											type="checkbox"
											checked={teeExperimentEnabled[variant]}
											onchange={() =>
												(teeExperimentEnabled = {
													...teeExperimentEnabled,
													[variant]: !teeExperimentEnabled[variant]
												})}
											data-testid="tee-variant-{variant}"
										/>
										{TEE_VARIANT_LABELS[variant]}
									</label>
								{/each}
							</div>
							<label class="tee-full-res-toggle" class:active={teeExperimentFullResolution}>
								<input
									type="checkbox"
									checked={teeExperimentFullResolution}
									onchange={() => (teeExperimentFullResolution = !teeExperimentFullResolution)}
									data-testid="tee-full-resolution"
								/>
								Full resolution
							</label>
							<button
								type="button"
								class="detect-button"
								data-testid="detect-tees"
								disabled={teeExperimentRunning || courseDetectionRunning || basketDetectionRunning}
								onclick={() => void handleDetectTees()}
							>
								{teeExperimentRunning ? 'Detecting tees…' : 'Detect tees'}
							</button>
							{#if teeExperimentError}
								<p class="tool-error" data-testid="tee-detection-error" role="alert">
									{teeExperimentError}
								</p>
							{/if}
							{#if teeExperimentResult}
								{@const total = teeExperimentResult.results.reduce(
									(sum, result) => sum + result.candidates.length,
									0
								)}
								<p class="detection-summary" data-testid="tee-detection-controls-summary">
									scale {teeExperimentResult.uiScalePx.toFixed(1)} px · {total} candidates
								</p>
								{#each teeExperimentResult.results as result (result.variant)}
									<details class="tee-diagnostics" open>
										<summary>
											{TEE_VARIANT_LABELS[result.variant]} · {result.candidates.length} found
										</summary>
										<div class="tee-stage-counts">
											{#each Object.entries(result.stageCounts) as [stage, count]}
												<span>{stage}: {count}</span>
											{/each}
										</div>
										<div class="tee-candidate-list">
											{#each result.candidates as candidate, index (index)}
												{@const key = `${result.variant}-${index}`}
												<button
													type="button"
													class:selected={selectedTeeCandidateKey === key}
													aria-pressed={selectedTeeCandidateKey === key}
													onclick={() => (selectedTeeCandidateKey = key)}
												>
													<span class="tee-candidate-tag">
														{TEE_VARIANT_LABELS[result.variant]} tee
													</span>
													<span class="tee-candidate-score">
														{(candidate.score * 100).toFixed(0)}%
													</span>
													<span class="tee-candidate-dims">
														{candidate.widthPx.toFixed(0)}×{candidate.heightPx.toFixed(0)}
													</span>
													<span class="tee-candidate-orient">
														{candidate.orientationDeg.toFixed(0)}°
													</span>
													<span class="tee-candidate-support">
														{candidate.support.join('+')}
													</span>
												</button>
											{/each}
										</div>
									</details>
								{/each}
							{/if}
						</div>
						<p class="assist-divider">Basket-only fallback</p>
						<button
							type="button"
							class="detect-button"
							data-testid="detect-baskets"
							disabled={basketDetectionRunning || courseDetectionRunning}
							onclick={() => void handleDetectBaskets()}
						>
							{basketDetectionRunning ? 'Loading OpenCV and detecting…' : 'Detect baskets'}
						</button>
						{#if basketDetectionError}
							<p class="tool-error" data-testid="basket-detection-error" role="alert">{basketDetectionError}</p>
						{/if}
						{#if basketCandidates.length > 0}
							<div class="candidate-list" aria-label="Detected basket candidates">
								{#each basketCandidates as candidate, index (index)}
									<button
										type="button"
										class:selected={selectedBasketCandidate === index}
										aria-pressed={selectedBasketCandidate === index}
										onclick={() => selectBasketCandidate(index)}
									>
										Basket candidate {index + 1} <span>{(candidate.score * 100).toFixed(0)}%</span>
									</button>
								{/each}
							</div>
							<button
								type="button"
								class="apply-button"
								data-testid="apply-basket-candidate-controls"
								disabled={selectedBasketCandidate === null || !activeHoleId}
								onclick={applySelectedBasket}
							>
								Apply to Hole {activeHole()?.number ?? ''}
							</button>
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
					{#if teeExperimentResult}
						{@const total = teeExperimentResult.results.reduce((sum, result) => sum + result.candidates.length, 0)}
						<p class="detection-summary" data-testid="tee-detection-summary">scale {teeExperimentResult.uiScalePx.toFixed(1)} px · {total} candidates</p>
						{#each teeExperimentResult.results as result (result.variant)}
							<details class="tee-diagnostics">
								<summary>{TEE_VARIANT_LABELS[result.variant]} · {result.candidates.length} found</summary>
								<div class="tee-stage-counts">
									{#each Object.entries(result.stageCounts) as [stage, count]}<span>{stage}: {count}</span>{/each}
								</div>
								<div class="tee-candidate-list">
									{#each result.candidates as candidate, index (index)}
										{@const key = `${result.variant}-${index}`}
										<button type="button" class:selected={selectedTeeCandidateKey === key} aria-pressed={selectedTeeCandidateKey === key} onclick={() => (selectedTeeCandidateKey = key)}>
											<span class="tee-candidate-tag">{TEE_VARIANT_LABELS[result.variant]} tee</span>
											<span class="tee-candidate-score">{(candidate.score * 100).toFixed(0)}%</span>
											<span class="tee-candidate-dims">{candidate.widthPx.toFixed(0)}×{candidate.heightPx.toFixed(0)}</span>
										</button>
									{/each}
								</div>
							</details>
						{/each}
					{/if}
					{#if basketCandidates.length > 0}
						<div class="candidate-list" aria-label="Detected basket candidates">
							{#each basketCandidates as candidate, index (index)}
								<button type="button" class:selected={selectedBasketCandidate === index} aria-pressed={selectedBasketCandidate === index} onclick={() => selectBasketCandidate(index)}>
									Basket candidate {index + 1} <span>{(candidate.score * 100).toFixed(0)}%</span>
								</button>
							{/each}
						</div>
						<button type="button" class="apply-button" data-testid="apply-basket-candidate" disabled={selectedBasketCandidate === null || !activeHoleId} onclick={applySelectedBasket}>
							Apply to Hole {activeHole()?.number ?? ''}
						</button>
					{/if}
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
									class="grammar-link-candidate"
									class:revealed={revealedUpTo('grammar')}
									data-testid="grammar-link-{proposal.number}-badge-tee"
								/>
							{/if}
							{#if proposal.tee && proposal.basket}
								<line
									x1={proposal.tee.xPx}
									y1={proposal.tee.yPx}
									x2={proposal.basket.xPx}
									y2={proposal.basket.yPx}
									class="grammar-link-candidate"
									class:revealed={revealedUpTo('grammar')}
									data-testid="grammar-link-{proposal.number}-tee-basket"
								/>
							{/if}
						{/each}
						{#each courseDetection.numberDetection.candidates as candidate, index (index)}
							{@const candidateId = candidate.diagnosticId ?? index + 1}
							{@const rawTopMatch = candidate.topGlyphMatches?.[0]}
							{@const forcedAssignment = candidate.label !== undefined && rawTopMatch !== undefined && rawTopMatch.label !== candidate.label}
							<g
								class="number-candidate-marker"
								class:forced-assignment={forcedAssignment}
								class:selected-hole={candidate.label !== undefined && candidate.label === activeHole()?.number}
								class:tappable={candidate.label !== undefined}
								class:revealed={revealedUpTo('numbers')}
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
						{#each courseDetection.tees as candidate, index (index)}
							{@const point = { xPx: candidate.xPx, yPx: candidate.yPx }}
							{@const label = candidateAriaLabel('tee', point)}
							<g
								class="course-candidate-group"
								class:revealed={revealedUpTo('tees')}
								class:interactive={Boolean(activeHoleId)}
								role="button"
								aria-label={label}
								data-testid="tee-candidate-{index + 1}"
							>
								<title>{label}</title>
								<rect
									x={candidate.xPx - candidate.widthPx / 2}
									y={candidate.yPx - candidate.heightPx / 2}
									width={candidate.widthPx}
									height={candidate.heightPx}
									transform={`rotate(${candidate.orientationDeg} ${candidate.xPx} ${candidate.yPx})`}
									class="tee-candidate-marker"
								/>
							</g>
						{/each}
					{/if}
					{#if teeExperimentResult}
						{#each teeExperimentResult.results as result (result.variant)}
							{@const colorClass = `tee-candidate-${result.variant}`}
							{@const short = TEE_VARIANT_SHORT_LABELS[result.variant]}
							{#each result.candidates as candidate, index (index)}
								{@const key = `${result.variant}-${index}`}
								<g class="tee-experiment-candidate">
									<rect
										x={candidate.xPx - candidate.widthPx / 2}
										y={candidate.yPx - candidate.heightPx / 2}
										width={candidate.widthPx}
										height={candidate.heightPx}
										transform={`rotate(${candidate.orientationDeg} ${candidate.xPx} ${candidate.yPx})`}
										class="tee-candidate-marker {colorClass}"
										class:selected={selectedTeeCandidateKey === key}
									/>
									<text
										x={candidate.xPx}
										y={candidate.yPx - candidate.heightPx / 2 - 5 / zoom}
										text-anchor="middle"
										class="tee-experiment-label"
										style={`font-size:${10 / zoom}px`}
									>
										{short} {candidate.score.toFixed(2)}
									</text>
								</g>
							{/each}
						{/each}
					{/if}
					{#each basketCandidates as candidate, index (index)}
						{@const fromCourseDetection = basketCandidatesSource === 'course-detection'}
						{@const point = { xPx: candidate.xPx, yPx: candidate.yPx }}
						{@const label = fromCourseDetection ? candidateAriaLabel('basket', point) : undefined}
						<g
							class="course-candidate-group"
							class:revealed={!fromCourseDetection || revealedUpTo('baskets')}
							class:interactive={fromCourseDetection && Boolean(activeHoleId)}
							role={fromCourseDetection ? 'button' : undefined}
							aria-label={label}
						>
							{#if label}<title>{label}</title>{/if}
							<circle
								cx={candidate.xPx}
								cy={candidate.yPx}
								r={(selectedBasketCandidate === index ? 11 : 8) / zoom}
								class="basket-candidate-marker"
								class:selected={selectedBasketCandidate === index}
								data-testid="basket-candidate-{index + 1}"
							/>
						</g>
					{/each}
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
					{:else if courseDetection && revealStage === 'done'}
						{@const grammarHoles = courseDetection.grammar.holes}
						{@const readyCount = grammarHoles.filter((hole) => hole.status === 'ready').length}
						{@const reviewCount = grammarHoles.length - readyCount}
						{@const firstNeedsReview = grammarHoles.find((hole) => hole.status !== 'ready')}
						<div class="course-summary-chip" data-testid="course-summary-chip" role="status">
							<p class="course-summary-line">
								Found {grammarHoles.length} holes — {readyCount} ready, {reviewCount} need review
							</p>
							<p class="course-summary-honesty">
								Detection is limited where holes overlap or crowd each other — an area of active research — which is why the review step exists.
							</p>
							<div class="course-summary-actions">
								<button
									type="button"
									data-testid="course-summary-jump-review"
									disabled={!firstNeedsReview}
									onclick={jumpToFirstNeedsReview}
								>
									{firstNeedsReview ? `Review hole ${firstNeedsReview.number}` : 'All holes ready'}
								</button>
								<button
									type="button"
									data-testid="course-summary-apply-ready"
									disabled={readyCount === 0}
									onclick={() => applyReadyCourseHoles()}
								>
									Accept {readyCount} ready holes
								</button>
							</div>
						</div>
					{/if}
				</div>

				{#if candidateAssignConfirm}
					{@const anchor = imageToScreen(candidateAssignConfirm.point, view)}
					<div
						bind:this={candidateConfirmEl}
						class="candidate-assign-confirm"
						data-testid="candidate-assign-confirm"
						style={`left:${anchor.x}px; top:${anchor.y}px;`}
					>
						<button
							type="button"
							class="candidate-assign-confirm-accept"
							data-testid="candidate-assign-confirm-accept"
							onclick={confirmCandidateAssign}
						>
							{candidateAssignConfirm.mode === 'replace'
								? `Replace ${candidateAssignConfirm.kind} on hole ${candidateAssignConfirm.holeNumber}?`
								: candidateAssignConfirm.mode === 'delete'
									? `Delete ${candidateAssignConfirm.kind} on hole ${candidateAssignConfirm.holeNumber}?`
									: `Move to hole ${candidateAssignConfirm.holeNumber}?`}
						</button>
						<button
							type="button"
							class="candidate-assign-confirm-cancel"
							data-testid="candidate-assign-confirm-cancel"
							aria-label="Cancel"
							onclick={dismissCandidateAssign}
						>✕</button>
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
		gap: 1rem;
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

	.toolbar {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		justify-content: space-between;
		gap: 0.75rem;
	}

	h1 {
		font-size: 1.5rem;
		margin: 0;
	}

	.toolbar p {
		margin: 0.15rem 0 0;
		color: #a1a1aa;
		font-size: 0.85rem;
	}

	.toolbar > button {
		min-height: 2.75rem;
		padding: 0.5rem 1.1rem;
		border: 1px solid #2563eb;
		border-radius: 6px;
		background: #2563eb;
		color: #fff;
		font-weight: 650;
	}

	.mode-toggle {
		display: flex;
		gap: 0.4rem;
		padding: 0.3rem;
		border: 1px solid #3f3f46;
		border-radius: 8px;
		background: #18181b;
		align-self: flex-start;
	}

	.mode-toggle-button {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 0.05rem;
		min-height: 2.75rem;
		padding: 0.35rem 0.85rem;
		border: 1px solid transparent;
		border-radius: 6px;
		background: transparent;
		color: #d4d4d8;
		text-align: left;
	}

	.mode-toggle-button.active {
		border-color: #2563eb;
		background: #2563eb;
		color: #fff;
	}

	.mode-toggle-label {
		font-weight: 650;
		font-size: 0.9rem;
	}

	.mode-toggle-hint {
		font-size: 0.72rem;
		color: inherit;
		opacity: 0.75;
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

	.width-control {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		font-size: 0.76rem;
		color: #d4d4d8;
	}

	.width-control input {
		width: 6rem;
		min-height: 2.5rem;
		padding: 0.3rem 0.45rem;
		border: 1px solid #52525b;
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

	.tee-candidate-marker {
		fill: rgb(56 189 248 / 20%);
		stroke: #38bdf8;
		stroke-width: 2;
		vector-effect: non-scaling-stroke;
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

	.basket-candidate-marker {
		fill: #facc15;
		stroke: #713f12;
		stroke-width: 2;
		stroke-dasharray: 3 2;
	}

	.basket-candidate-marker.selected {
		fill: #fb923c;
		stroke: #7c2d12;
		stroke-width: 3;
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

	.section-heading {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
	}

	.section-heading > span,
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

	.hole-remove-list {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
	}

	.hole-remove-list li {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		align-items: center;
		gap: 0.35rem;
		padding-left: 0.45rem;
		border: 1px solid #3f3f46;
		border-radius: 6px;
		overflow: hidden;
	}

	.hole-remove-list li.active {
		border-color: #3b82f6;
		box-shadow: inset 3px 0 #3b82f6;
	}

	.remove-hole-button {
		border: 0 !important;
		border-left: 1px solid #3f3f46 !important;
		border-radius: 0 !important;
		background: transparent !important;
		padding: 0.4rem 0.7rem;
		font-size: 0.78rem;
		white-space: nowrap;
	}

	.edit-actions {
		display: grid;
		gap: 0.35rem;
	}

	.detect-button,
	.apply-button {
		width: 100%;
	}

	.detect-button {
		border-color: #a16207 !important;
		background: #422006 !important;
		color: #fde68a !important;
	}

	.apply-button {
		border-color: #2563eb !important;
		background: #1d4ed8 !important;
	}

	.candidate-list {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: 0.3rem;
	}

	.candidate-list button {
		display: flex;
		justify-content: space-between;
		font-size: 0.72rem;
	}

	.candidate-list button.selected {
		border-color: #f59e0b;
		background: #451a03;
	}

	.candidate-list span {
		color: #fbbf24;
	}

	.tool-error {
		margin: 0;
		color: #fca5a5;
		font-size: 0.75rem;
	}

	.detection-summary,
	.tool-note,
	.assist-divider {
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
		gap: 0.5rem;
		padding: 0.5rem;
		border: 1px solid #34343a;
		border-radius: 8px;
		background: #18181b;
	}

	.hole-bar-compact {
		display: flex;
		align-items: stretch;
		gap: 0.4rem;
		flex: 1 1 auto;
	}

	.hole-bar-compact-nav,
	.hole-bar-compact-label {
		min-height: 2.75rem;
		border: 1px solid #3f3f46;
		border-radius: 6px;
		background: #27272a;
		color: #f4f4f5;
		touch-action: manipulation;
	}

	.hole-bar-compact-nav {
		min-width: 2.75rem;
		font-size: 1.15rem;
		font-weight: 700;
		color: #a1a1aa;
		cursor: pointer;
	}

	.hole-bar-compact-nav:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}

	.hole-bar-compact-label {
		flex: 1 1 auto;
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.4rem;
		font-size: 0.95rem;
		font-weight: 650;
	}

	.hole-bar-grid {
		flex-basis: 100%;
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(2.5rem, 1fr));
		gap: 0.35rem;
		min-width: 0;
		margin-top: 0.5rem;
	}

	.hole-tab {
		position: relative;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 0.2rem;
		min-height: 2.75rem;
		padding: 0.3rem 0.3rem;
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

	.hole-bar-actions,
	.extra-hole-tabs {
		display: flex;
		align-items: center;
		gap: 0.35rem;
	}

	.hole-bar-actions {
		flex: 0 0 auto;
	}

	.hole-bar-actions button {
		min-height: 2.75rem;
		padding: 0.4rem 0.65rem;
		border: 1px solid #52525b;
		border-radius: 5px;
		background: #27272a;
		color: #f4f4f5;
		cursor: pointer;
		touch-action: manipulation;
	}

	.hole-add-beyond {
		min-width: 2.75rem;
		min-height: 2.75rem;
		font-size: 1.25rem;
		font-weight: 700;
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

	.assist-divider {
		padding-top: 0.35rem;
		border-top: 1px solid #3f3f46;
		color: #a1a1aa;
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
		:global(.tools .tee-diagnostics),
	:global(.tools [data-testid='course-detection-controls-summary']),
	:global(.tools [data-testid='course-detection-controls-progress']),
	:global(.tools [data-testid='tee-detection-controls-summary']),
		:global(.tools .tool-note),
	:global(.tools .tee-candidate-list),
	:global(.tools .candidate-list),
	:global(.tools [data-testid='apply-basket-candidate-controls']) {
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

	.tee-experiment-controls {
		display: flex;
		flex-direction: column;
		gap: 0.55rem;
	}

	.tee-variant-toggles {
		display: flex;
		flex-wrap: wrap;
		gap: 0.35rem;
	}

	.tee-variant-toggles label,
	.tee-full-res-toggle {
		display: flex;
		align-items: center;
		gap: 0.35rem;
		padding: 0.4rem 0.55rem;
		border: 1px solid #3f3f46;
		border-radius: 5px;
		font-size: 0.76rem;
		cursor: pointer;
	}

	.tee-variant-toggles label.active,
	.tee-full-res-toggle.active {
		border-color: #3b82f6;
		background: rgb(59 130 246 / 15%);
	}

	.tee-variant-toggles input,
	.tee-full-res-toggle input {
		margin: 0;
	}

	.tee-experiment-candidate rect {
		fill-opacity: 0.15;
		stroke-width: 2;
		vector-effect: non-scaling-stroke;
	}

	.tee-experiment-candidate rect.selected {
		stroke-width: 4;
	}

	.tee-experiment-candidate .tee-candidate-gray-center {
		fill: #38bdf8;
		stroke: #38bdf8;
	}

	.tee-experiment-candidate .tee-candidate-edge-loop {
		fill: #c084fc;
		stroke: #c084fc;
		stroke-dasharray: 4 3;
	}

	.tee-experiment-candidate .tee-candidate-fused {
		fill: #facc15;
		stroke: #facc15;
		stroke-dasharray: 2 2;
	}

	.tee-experiment-label {
		fill: #fff;
		stroke: #18181b;
		stroke-width: 3px;
		paint-order: stroke fill;
		font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
		font-weight: 700;
		pointer-events: none;
	}

	.tee-diagnostics {
		border: 1px solid #3f3f46;
		border-radius: 5px;
		background: #18181b;
	}

	.tee-diagnostics summary {
		padding: 0.5rem 0.55rem;
		cursor: pointer;
		font-size: 0.75rem;
		font-weight: 650;
		color: #e4e4e7;
	}

	.tee-stage-counts {
		display: flex;
		flex-wrap: wrap;
		gap: 0.35rem;
		padding: 0 0.55rem 0.45rem;
		font-size: 0.68rem;
		color: #a1a1aa;
	}

	.tee-stage-counts span {
		background: #27272a;
		padding: 0.15rem 0.3rem;
		border-radius: 4px;
	}

	.tee-candidate-list {
		display: flex;
		flex-direction: column;
		max-height: 16rem;
		overflow: auto;
		border-top: 1px solid #3f3f46;
	}

	.tee-candidate-list button {
		display: grid;
		grid-template-columns: minmax(7rem, 1.2fr) 3.5rem 5rem 3rem minmax(0, 1fr);
		gap: 0.35rem;
		align-items: baseline;
		padding: 0.35rem 0.5rem;
		border-bottom: 1px solid #2b2b30;
		font-size: 0.68rem;
		text-align: left;
	}

	.tee-candidate-list button:last-child {
		border-bottom: 0;
	}

	.tee-candidate-list button.selected {
		background: rgb(59 130 246 / 15%);
	}

	.tee-candidate-tag {
		font-weight: 700;
	}

	.tee-candidate-score {
		color: #fbbf24;
	}

	.tee-candidate-dims,
	.tee-candidate-orient,
	.tee-candidate-support {
		color: #a1a1aa;
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

	/* PART A — compact detection status strip and PART C's summary chip, both
	   anchored near the map (top-left of the canvas), one replacing the other. */
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

	.course-summary-chip {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
		padding: 0.65rem 0.75rem;
		border: 1px solid #3f3f46;
		border-radius: 8px;
		background: #18181bf2;
		box-shadow: 0 6px 16px rgb(0 0 0 / 45%);
	}

	.course-summary-line {
		margin: 0;
		font-size: 0.85rem;
		font-weight: 650;
		color: #f4f4f5;
	}

	.course-summary-honesty {
		margin: 0;
		font-size: 0.72rem;
		line-height: 1.4;
		color: #a1a1aa;
	}

	.course-summary-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
	}

	.course-summary-actions button {
		min-height: 2.25rem;
		padding: 0.35rem 0.6rem;
		border: 1px solid #52525b;
		border-radius: 5px;
		background: #27272a;
		color: #f4f4f5;
		font-size: 0.75rem;
		cursor: pointer;
	}

	.course-summary-actions button:disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}

	.course-summary-actions button:first-child {
		border-color: #f59e0b;
	}

	/* PART C — inline one-click confirmation chip anchored at the clicked candidate marker. */
	.candidate-assign-confirm {
		position: absolute;
		left: 0;
		top: 0;
		z-index: 25;
		display: flex;
		align-items: center;
		gap: 0.3rem;
		transform: translate(-50%, calc(-100% - 0.6rem));
		padding: 0.3rem 0.3rem 0.3rem 0.6rem;
		border: 1px solid #38bdf8;
		border-radius: 999px;
		background: #18181b;
		box-shadow: 0 6px 16px rgb(0 0 0 / 55%);
		white-space: nowrap;
	}

	.candidate-assign-confirm-accept {
		min-height: 2rem;
		padding: 0.3rem 0.6rem;
		border: 0;
		border-radius: 999px;
		background: #0369a1;
		color: #f0f9ff;
		font-size: 0.75rem;
		font-weight: 650;
		cursor: pointer;
	}

	.candidate-assign-confirm-accept:hover {
		background: #0284c7;
	}

	.candidate-assign-confirm-cancel {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 1.6rem;
		height: 1.6rem;
		border: 0;
		border-radius: 999px;
		background: transparent;
		color: #a1a1aa;
		font-size: 0.75rem;
		cursor: pointer;
	}

	.candidate-assign-confirm-cancel:hover {
		color: #f4f4f5;
	}

	/* PART B — staged reveal: hidden until each stage's turn, fading in via CSS transition. */
	.number-candidate-marker,
	.course-candidate-group,
	.grammar-link-candidate {
		opacity: 0;
		transition: opacity 220ms ease;
	}

	.number-candidate-marker.revealed,
	.course-candidate-group.revealed,
	.grammar-link-candidate.revealed {
		opacity: 1;
	}

	.grammar-link-candidate {
		stroke: #38bdf8;
		stroke-width: 1.5;
		stroke-dasharray: 2 3;
		pointer-events: none;
	}

	/* PART C — candidate markers become clickable once revealed. */
	.course-candidate-group.interactive {
		cursor: pointer;
	}

	.course-candidate-group.interactive:hover .tee-candidate-marker,
	.course-candidate-group.interactive:hover .basket-candidate-marker {
		stroke-width: 3;
		filter: brightness(1.25);
	}

	@media (prefers-reduced-motion: reduce) {
		.number-candidate-marker,
		.course-candidate-group,
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
</style>
