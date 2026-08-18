/**
 * ChainSpot cross-route in-memory session state (Ticket 2 consolidation of
 * P1 Ticket 1's `editorSession.ts` / `annotatedRoundSession.ts` /
 * `stitch/handoff.ts`, plus Course Memory's `courseBadgeSession.ts` and the
 * guided demo's `demo/stageInbox.ts`).
 *
 * One module, six independent mechanisms, all carrying state across
 * client-side SPA route changes so it survives navigation but never a full
 * page reload (nothing here is persisted to storage, IndexedDB, or the
 * server):
 *
 * - **Retained editors** (`retainEditor` / `takeRetainedEditor`) — keeps
 *   each stage's active `ProjectEditor` alive across navigation.
 * - **Pending stitch handoff** (`setPendingHandoff` / `getPendingHandoff` /
 *   `consumePendingHandoff`) — the stitched PNG blob in transit from Stitch
 *   Map to its target role's stage.
 * - **Pending/active AnnotatedRound** (`setPendingAnnotatedRound` / …,
 *   `setActiveAnnotatedRound` / `getActiveAnnotatedRound`) — the Annotate
 *   Round → Create Graphics handoff artifact.
 * - **Pending course badges** (`setPendingCourseBadges` / …) — Course
 *   Memory's badge/basket anchors, which ride separately from
 *   `AnnotatedRound` because that artifact can never carry them.
 * - **Thrown-round source** (`setThrownRoundSource` / …) — the played-round
 *   image kept on Stitch Map as a semantic input distinct from the clean
 *   course source, surviving through Annotate Course into Create Graphics.
 *
 * Vocabulary is uniform across all of these: `pending*` names a one-shot
 * crossing slot (set by the sender, read-and-cleared by the receiver);
 * `retain`/`take` names the editor-retention pair; `active` (used only by
 * the AnnotatedRound slot) names the longer-lived slot described below.
 */
import type { ProjectEditor } from './domain/editor';
import type { ImageRole, HoleNumberBadgeAnchor } from './domain/project';
import type { AnnotatedRound } from './domain/annotatedRound';
import type { CompositeProvenance } from './domain/provenance';
import type { LabeledPoint } from './courseSignature';

export type { LabeledPoint };

// ---------------------------------------------------------------------------
// Retained editors
// ---------------------------------------------------------------------------

/**
 * Keeps each stage's active `ProjectEditor` alive across client-side SPA
 * navigation, so loaded images, project name, control points, undo/redo
 * history, dirty state, and the editor's transient decoded image resources
 * survive route changes. A full browser reload clears it; nothing is
 * persisted to storage, IndexedDB, or the server. Route unmounting never
 * revokes or destroys image resources still owned by a retained session.
 *
 * Keyed by stage, one independent slot per key — Annotate Round and Create
 * Graphics never share a slot. Reason: Svelte's branch-swap during
 * navigation creates the new page's mount effect before destroying the old
 * page's, so a single shared destructively-read slot would race a
 * mount-read against a destroy-write within one navigation. Two independent
 * keyed slots avoid this entirely, since each key is only ever written by
 * its own route's destroy and read by its own route's mount.
 */
export type EditorSessionKey = 'annotate-course' | 'map-round' | 'create-graphics';

const retainedEditors = new Map<EditorSessionKey, ProjectEditor>();

/**
 * Hands the current editor to the holder for `key` (called when that stage's
 * page is about to be destroyed). Replacing the page's editor (open bundle)
 * automatically retains the replacement because retention happens at unmount
 * time.
 */
export function retainEditor(key: EditorSessionKey, editor: ProjectEditor): void {
	retainedEditors.set(key, editor);
}

/**
 * Claims the retained editor for `key`'s mounting page. Returns null on a
 * fresh visit or after a full page reload.
 */
export function takeRetainedEditor(key: EditorSessionKey): ProjectEditor | null {
	const editor = retainedEditors.get(key) ?? null;
	retainedEditors.delete(key);
	return editor;
}

// ---------------------------------------------------------------------------
// Pending stitch handoff
// ---------------------------------------------------------------------------

/**
 * A tiny module-level store carrying the stitched PNG blob from /stitch-map to
 * whichever downstream stage owns `destination` — /annotate-course or
 * /map-round for a `source-overview`-role image, /create-graphics for
 * `target-basemap` — across client-side navigation. Survives SPA route
 * changes; a full page reload clears it (stitch sessions are deliberately
 * never persisted). The item is consumed only on a successful import or
 * explicit dismissal on the destination page; a cancelled replacement leaves
 * it available.
 *
 * `targetRole` and `destination` answer different questions and both are
 * needed: `targetRole` is the domain role the imported image gets inside
 * `ProjectState` (still a plain `ImageRole`, unchanged by the Annotate Round
 * split), while `destination` is session-routing only — which of the two
 * routes that both accept a `source-overview` image should claim this
 * particular handoff. Before the split a single `targetRole` was enough
 * because exactly one route claimed each role; now two routes share
 * `source-overview`.
 */
export type PendingHandoffDestination = 'annotate-course' | 'map-round' | 'create-graphics';

export interface PendingHandoff {
	readonly blob: Blob;
	readonly fileName: string;
	readonly targetRole: ImageRole;
	readonly destination: PendingHandoffDestination;
	/**
	 * CHSPT-49/55: how `blob`'s exact pixels were derived from original capture(s) via
	 * AutoCrop/AutoStitch, carried across this handoff so it can land on the resulting
	 * `ImageAsset.provenance` (see `imageIntake.ts`'s `intakeImageFile`). Present only for
	 * a `source-overview` handoff — Stitch Map never produces a `target-basemap`.
	 */
	readonly provenance?: CompositeProvenance | null;
	/**
	 * The original, unmodified bytes of every capture `provenance.sources` references,
	 * keyed by `SourceCapture.sourceId`, so the receiving stage can register them (see
	 * `ProjectEditor.setSourceCaptureBytes`) and a later save can archive them (CHSPT-49:
	 * original captures must never be discarded once a composite replaces them). Absent
	 * when `provenance` is absent.
	 */
	readonly sourceCaptures?: ReadonlyMap<string, Uint8Array>;
}

let pendingHandoff: PendingHandoff | null = null;

/**
 * Listeners notified when a handoff is published.
 *
 * Stitch Map's own "Use as UDisc source" always navigates immediately after
 * publishing, so for years the destination's `onMount` read was sufficient.
 * The guided demo can publish while the destination is *already mounted*
 * (`/demo`'s rail arms a step the visitor is standing on), and a mounted page
 * has no reason to re-read a plain module variable — so the banner never
 * appeared and the arming reported a success the visitor could not see.
 * Publishing now announces itself, and destinations subscribe in addition to
 * their mount-time read.
 */
type PendingHandoffListener = () => void;
const handoffListeners = new Set<PendingHandoffListener>();

export function setPendingHandoff(handoff: PendingHandoff): void {
	pendingHandoff = handoff;
	for (const listener of [...handoffListeners]) listener();
}

/**
 * Subscribes to handoff publications. Returns an unsubscribe function for the
 * caller's teardown; a destination that forgets to call it would keep a
 * destroyed component's closure alive.
 */
export function subscribePendingHandoff(listener: PendingHandoffListener): () => void {
	handoffListeners.add(listener);
	return () => handoffListeners.delete(listener);
}

export function getPendingHandoff(): PendingHandoff | null {
	return pendingHandoff;
}

export function consumePendingHandoff(): void {
	pendingHandoff = null;
}

// ---------------------------------------------------------------------------
// Pending stitch captures (demo inbox)
// ---------------------------------------------------------------------------

/**
 * One-shot slot carrying demo-loaded files across the client-side navigation
 * from `/demo` (or the guide rail) to `/stitch-map`, with the same vocabulary
 * and lifetime as the pending-handoff slot above. Survives SPA route changes;
 * a full page reload clears it.
 *
 * Only Stitch Map needs an inbox. The two downstream stages already accept an
 * externally supplied image through the pending-handoff slot, so the demo
 * reuses that rather than inventing a parallel path — the fewer seams the
 * demo owns, the less of the demo can drift away from the real product.
 *
 * The slot carries plain `File`s, which Stitch Map hands to the same Smart
 * Import entry point its own file input uses. It deliberately does not carry
 * decoded images, placements, crops, or any precomputed result: the
 * arrangement a visitor sees must be one the product just computed in front
 * of them.
 */
let pendingStitchCaptures: File[] | null = null;

/**
 * Listeners notified when captures are deposited, mirroring the handoff
 * subscription above for the same reason: the rail can arm a step the visitor
 * is already standing on, and a mounted Stitch Map has no reason to re-read a
 * plain module variable. Without this the visitor clicks "Load the real
 * inputs", is told it worked, and watches nothing happen.
 */
type StitchCaptureListener = () => void;
const stitchCaptureListeners = new Set<StitchCaptureListener>();

export function setPendingStitchCaptures(files: readonly File[]): void {
	pendingStitchCaptures = [...files];
	for (const listener of [...stitchCaptureListeners]) listener();
}

/** Subscribes to deposits. Returns an unsubscribe function for teardown. */
export function subscribePendingStitchCaptures(listener: StitchCaptureListener): () => void {
	stitchCaptureListeners.add(listener);
	return () => stitchCaptureListeners.delete(listener);
}

export function getPendingStitchCaptures(): File[] | null {
	return pendingStitchCaptures ? [...pendingStitchCaptures] : null;
}

/** Claims the pending captures, leaving the slot empty. */
export function takePendingStitchCaptures(): File[] | null {
	const files = pendingStitchCaptures;
	pendingStitchCaptures = null;
	return files;
}

export function clearPendingStitchCaptures(): void {
	pendingStitchCaptures = null;
}

// ---------------------------------------------------------------------------
// Pending / active AnnotatedRound
// ---------------------------------------------------------------------------

/**
 * Two module-level in-memory slots carrying the AnnotatedRound artifact
 * across client-side navigation from /annotate-course or /map-round to
 * /create-graphics, using the same `pending`/`active` vocabulary as the rest
 * of this module. `pending` is the one-shot crossing slot: either annotation
 * route sets it on Done, Create Graphics reads it on mount and consumes it
 * after importing. `active`
 * is longer-lived: Create Graphics sets it once the artifact is imported, and
 * it survives Create Graphics <-> Stitch Map round trips for future tickets
 * to read. Both survive SPA route changes; a full page reload clears them
 * (annotation sessions are deliberately never persisted).
 */
let pendingAnnotatedRound: AnnotatedRound | null = null;
let activeAnnotatedRound: AnnotatedRound | null = null;

export function setPendingAnnotatedRound(round: AnnotatedRound): void {
	pendingAnnotatedRound = round;
}

export function getPendingAnnotatedRound(): AnnotatedRound | null {
	return pendingAnnotatedRound;
}

export function consumePendingAnnotatedRound(): void {
	pendingAnnotatedRound = null;
}

export function setActiveAnnotatedRound(round: AnnotatedRound): void {
	activeAnnotatedRound = round;
}

export function getActiveAnnotatedRound(): AnnotatedRound | null {
	return activeAnnotatedRound;
}

// ---------------------------------------------------------------------------
// Thrown-round source (CHSPT-65)
// ---------------------------------------------------------------------------

/**
 * The played-round screenshot (the one carrying UDisc's purple throw/walk
 * graphics), preserved as its own semantic input from Stitch Map all the way
 * into Create Graphics. It is deliberately NOT a `PendingHandoff`: the
 * pending-handoff slot is a one-shot crossing consumed by a destination's
 * image intake, and the thrown-round image must never enter the
 * `source-overview`/`target-basemap` intake path — that is exactly the silent
 * role substitution CHSPT-65 forbids. This slot is `active`-style instead
 * (like `activeAnnotatedRound`): set once on Stitch Map, readable but never
 * auto-consumed, surviving Stitch Map -> Annotate Course -> Create Graphics
 * and any further SPA round trips until a replacement, an explicit clear, or
 * a full page reload.
 *
 * Registration of these graphics onto the clean target is a follow-up ticket;
 * nothing here decodes or transforms the blob.
 */
export interface ThrownRoundSource {
	readonly blob: Blob;
	readonly fileName: string;
	/** Same derivation-fact contract as `PendingHandoff.provenance`, when the image came out of AutoCrop/AutoStitch. */
	readonly provenance?: CompositeProvenance | null;
}

let thrownRoundSource: ThrownRoundSource | null = null;

/**
 * Workflow-scoping for the slot above. A thrown round is meaningful for
 * exactly one course workflow; without a boundary, a round kept in workflow A
 * and never consumed would silently present itself as workflow B's input —
 * stale state indistinguishable from valid preserved state.
 *
 * The boundary is "a new course source image lands in Annotate Course"
 * (`markCourseSourceIntake`, called from that route's three intake paths:
 * pane replace, stitch handoff import, draft open). The rule:
 *
 *  - a freshly kept round is UNATTACHED; the first course intake after it
 *    attaches it to that course (this is the normal Stitch Map -> keep ->
 *    Annotate Course order, and also covers keeping the round after the
 *    course already arrived — the keep resets attachment, the round rides
 *    with the current course);
 *  - a second course intake while a round is still ATTACHED means a new
 *    workflow started without a new thrown round: the old round is stale and
 *    is cleared rather than presented as the new course's input.
 *
 * Ordinary navigation (Annotate Course <-> Stitch Map <-> Create Graphics
 * round trips) never touches this — only an actual source intake does. The
 * deliberate conservative edge: re-importing a corrected course source
 * mid-workflow counts as a fresh intake and drops an attached round (the user
 * re-keeps it); erring toward dropping is safer than mislabeling.
 */
let thrownRoundAttachedToCourse = false;

/** Replaces any previously kept thrown-round source — the roles clean-vs-thrown stay distinct, but within the thrown role the newest keep wins. The new round is unattached: it belongs to the next course intake. */
export function setThrownRoundSource(source: ThrownRoundSource): void {
	thrownRoundSource = source;
	thrownRoundAttachedToCourse = false;
}

export function getThrownRoundSource(): ThrownRoundSource | null {
	return thrownRoundSource;
}

export function clearThrownRoundSource(): void {
	thrownRoundSource = null;
	thrownRoundAttachedToCourse = false;
}

/**
 * Announces that a new course source image landed in Annotate Course. See
 * `thrownRoundAttachedToCourse` above for the full lifecycle rule: first
 * intake attaches the pending round to that course; a further intake while
 * still attached clears it as stale. No-op with nothing kept.
 */
export function markCourseSourceIntake(): void {
	if (!thrownRoundSource) return;
	if (thrownRoundAttachedToCourse) {
		thrownRoundSource = null;
		thrownRoundAttachedToCourse = false;
		return;
	}
	thrownRoundAttachedToCourse = true;
}

// ---------------------------------------------------------------------------
// Front-door auto-advance (single-page consolidated flow)
// ---------------------------------------------------------------------------

/**
 * One-shot flag set by the front door (`/`) when it deposits captures for
 * Stitch Map via `setPendingStitchCaptures`. Stitch Map consumes it when
 * claiming those captures; a subsequent `'auto'`-confidence pipeline success
 * then continues straight to Annotate Course with no "Continue" click. A
 * `'review'`-confidence result ignores it and keeps the existing result
 * screen with manual correction open — low confidence always gets review.
 *
 * Deliberately NOT set by the guided demo's inbox (a demo visitor should see
 * the result screen) or by direct /stitch-map visits (a bookmarked user may
 * want the result screen even on an auto result — e.g. to send the composite
 * to `target-basemap` instead). Same lifetime as every other one-shot slot
 * here: survives SPA navigation, cleared by consumption or a full reload.
 */
let frontDoorAutoAdvance = false;

export function setFrontDoorAutoAdvance(): void {
	frontDoorAutoAdvance = true;
}

export function consumeFrontDoorAutoAdvance(): boolean {
	const value = frontDoorAutoAdvance;
	frontDoorAutoAdvance = false;
	return value;
}

// ---------------------------------------------------------------------------
// Pending course badges (Course Memory)
// ---------------------------------------------------------------------------

/**
 * `AnnotatedRound`/`AnnotatedHole` can never carry provisional or CV-only
 * metadata (the Done-boundary purity rule in `domain/annotatedRound.ts`), so
 * hole-number-badge anchors and their basket counterparts — course-shape
 * signature input, not round annotation — cannot ride inside that artifact's
 * handoff. This is a minimal sibling to the AnnotatedRound slots above,
 * carrying exactly the payload that rule forbids attaching directly, across
 * the same /annotate-course or /map-round -> /create-graphics client-side
 * navigation.
 *
 * One module-level, one-shot slot: either annotation route's `handleDone`
 * sets it alongside `setPendingAnnotatedRound`; Create Graphics's
 * `importAnnotatedRound` reads it right after `editor.setHoles(round.holes)`
 * and consumes it. A full page reload clears it — never persisted, exactly
 * like its sibling.
 */
export interface PendingCourseBadges {
	readonly numberBadges: readonly HoleNumberBadgeAnchor[];
	// TODO(course-memory): `baskets` is currently captured on Done but never
	// consumed on import (see create-graphics/+page.svelte's
	// importAnnotatedRound) — it isn't safe to just apply or just drop, since
	// it can carry CV-detected points for holes the user never confirmed.
	// Needs an export/import option dialog so the user can decide per point
	// whether it's a real extra basket or leftover CV noise.
	readonly baskets: readonly LabeledPoint[];
}

let pendingCourseBadges: PendingCourseBadges | null = null;

export function setPendingCourseBadges(value: PendingCourseBadges): void {
	pendingCourseBadges = value;
}

export function getPendingCourseBadges(): PendingCourseBadges | null {
	return pendingCourseBadges;
}

export function consumePendingCourseBadges(): void {
	pendingCourseBadges = null;
}
