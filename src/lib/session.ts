/**
 * ChainSpot cross-route in-memory session state (Ticket 2 consolidation of
 * P1 Ticket 1's `editorSession.ts` / `annotatedRoundSession.ts` /
 * `stitch/handoff.ts`, plus Course Memory's `courseBadgeSession.ts`).
 *
 * One module, four independent mechanisms, all carrying state across
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
 *
 * Vocabulary is uniform across all four: `pending*` names a one-shot
 * crossing slot (set by the sender, read-and-cleared by the receiver);
 * `retain`/`take` names the editor-retention pair; `active` (used only by
 * the AnnotatedRound slot) names the longer-lived slot described below.
 */
import type { ProjectEditor } from './domain/editor';
import type { ImageRole, HoleNumberBadgeAnchor } from './domain/project';
import type { AnnotatedRound } from './domain/annotatedRound';
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
export type EditorSessionKey = 'annotate-round' | 'create-graphics';

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
 * whichever downstream stage owns `targetRole` — /annotate-round for
 * `source-overview`, /create-graphics for `target-basemap` — across
 * client-side navigation. Survives SPA route changes; a full page reload
 * clears it (stitch sessions are deliberately never persisted). The item is
 * consumed only on a successful import or explicit dismissal on the
 * destination page; a cancelled replacement leaves it available.
 */
export interface PendingHandoff {
	readonly blob: Blob;
	readonly fileName: string;
	readonly targetRole: ImageRole;
}

let pendingHandoff: PendingHandoff | null = null;

export function setPendingHandoff(handoff: PendingHandoff): void {
	pendingHandoff = handoff;
}

export function getPendingHandoff(): PendingHandoff | null {
	return pendingHandoff;
}

export function consumePendingHandoff(): void {
	pendingHandoff = null;
}

// ---------------------------------------------------------------------------
// Pending / active AnnotatedRound
// ---------------------------------------------------------------------------

/**
 * Two module-level in-memory slots carrying the AnnotatedRound artifact
 * across client-side navigation between /annotate-round and /create-graphics,
 * using the same `pending`/`active` vocabulary as the rest of this module.
 * `pending` is the one-shot crossing slot: Annotate Round sets it on Done,
 * Create Graphics reads it on mount and consumes it after importing. `active`
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
// Pending course badges (Course Memory)
// ---------------------------------------------------------------------------

/**
 * `AnnotatedRound`/`AnnotatedHole` can never carry provisional or CV-only
 * metadata (the Done-boundary purity rule in `domain/annotatedRound.ts`), so
 * hole-number-badge anchors and their basket counterparts — course-shape
 * signature input, not round annotation — cannot ride inside that artifact's
 * handoff. This is a minimal sibling to the AnnotatedRound slots above,
 * carrying exactly the payload that rule forbids attaching directly, across
 * the same /annotate-round -> /create-graphics client-side navigation.
 *
 * One module-level, one-shot slot: Annotate Round's `handleDone` sets it
 * alongside `setPendingAnnotatedRound`; Create Graphics's
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
