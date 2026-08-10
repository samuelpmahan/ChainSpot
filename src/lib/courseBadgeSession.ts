/**
 * ChainSpot pending course-badge/basket handoff (Course Memory, stage 2).
 *
 * `AnnotatedRound`/`AnnotatedHole` can never carry provisional or CV-only
 * metadata (the Done-boundary purity rule in `domain/annotatedRound.ts`), so
 * hole-number-badge anchors and their basket counterparts — course-shape
 * signature input, not round annotation — cannot ride inside that artifact's
 * handoff. This is a minimal sibling to `annotatedRoundSession.ts`, carrying
 * exactly the payload that rule forbids attaching directly, across the same
 * /annotate-round -> /create-graphics client-side navigation.
 *
 * One module-level, one-shot slot: Annotate Round's `handleDone` sets it
 * alongside `setPendingAnnotatedRound`; Create Graphics's
 * `importAnnotatedRound` reads it right after `editor.setHoles(round.holes)`
 * and consumes it. A full page reload clears it — never persisted, exactly
 * like its sibling.
 */
import type { HoleNumberBadgeAnchor } from './domain/project';
import type { LabeledPoint } from './courseSignature';

export type { LabeledPoint };

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

let pending: PendingCourseBadges | null = null;

export function setPendingCourseBadges(value: PendingCourseBadges): void {
	pending = value;
}

export function getPendingCourseBadges(): PendingCourseBadges | null {
	return pending;
}

export function consumePendingCourseBadges(): void {
	pending = null;
}
