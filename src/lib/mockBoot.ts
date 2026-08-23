// Dev-only "mock boot": lets the owner preload a finished course (skip
// upload/CV/annotation) to test UI/UX. Every entry point that touches this
// module is gated on import.meta.env.DEV by the callers — see the COACH:
// notes at each call site for why that gate is safe in production builds.

import { setCourseMap, setMappedRound } from '$lib/session';
import type { ReviewHoleState, Point } from '$lib/guidedReview';
import type { WorldTransform } from '$lib/geo';

export interface MockCourseFixture {
	readonly name: string;
	readonly holes: readonly ReviewHoleState[];
	readonly transform: WorldTransform | null;
	readonly round: {
		readonly walk: readonly { xPx: number; yPx: number }[];
		readonly droplets: readonly { xPx: number; yPx: number }[];
	};
}

/**
 * Fetches static/mock/<name>.json (SvelteKit serves everything under
 * static/ from the site root, in dev and in prod alike) and hydrates
 * session.ts the same way pairsDone()/confirmAnnotation() would.
 */
export async function loadMockFixture(name: string): Promise<MockCourseFixture> {
	const res = await fetch(`/mock/${name}.json`);
	if (!res.ok) {
		throw new Error(`mock fixture "${name}" not found (/mock/${name}.json -> ${res.status})`);
	}
	const fixture = (await res.json()) as MockCourseFixture;
	setCourseMap({ holes: fixture.holes, transform: fixture.transform });
	setMappedRound(fixture.round);
	return fixture;
}

// Corpus schemaVersion-1 annotation shape (chainspot-corpus/dev/Annotated/**),
// as hand-labeled by the LAB tooling. It has no `badge` field — the badge is
// a review-time concept, not an annotation one — so the translator below
// derives one.
export interface CorpusAnnotationPoint {
	readonly xPx: number;
	readonly yPx: number;
}
export interface CorpusAnnotationHole {
	readonly number: number;
	readonly tee: CorpusAnnotationPoint | null;
	readonly basket: CorpusAnnotationPoint | null;
	readonly corridorBends?: readonly CorpusAnnotationPoint[];
	readonly corridorWidthPx?: number;
}
export interface CorpusAnnotation {
	readonly schemaVersion: number;
	readonly holes: readonly CorpusAnnotationHole[];
}

/**
 * Translates a corpus annotation into the ReviewHoleState[] shape the app
 * uses post-review. Every hole comes out already 'accepted' with zero
 * replacement counts — a mock fixture never went through GuidedReview, it's
 * standing in for what GuidedReview would have produced.
 */
export function fromAnnotationJson(corpusJson: CorpusAnnotation): ReviewHoleState[] {
	return corpusJson.holes.map((h): ReviewHoleState => {
		const tee = h.tee ?? null;
		const basket = h.basket ?? null;
		// badge = midpoint of tee/basket when both exist, else whichever one
		// does. A hole missing both isn't representable (badge is required) —
		// annotation data as of schemaVersion 1 always has at least one.
		let badge: Point;
		if (tee && basket) {
			badge = { xPx: (tee.xPx + basket.xPx) / 2, yPx: (tee.yPx + basket.yPx) / 2 };
		} else if (tee) {
			badge = tee;
		} else if (basket) {
			badge = basket;
		} else {
			throw new Error(`hole ${h.number}: annotation has neither tee nor basket`);
		}

		return {
			n: h.number,
			badge,
			tee,
			basket,
			bends: h.corridorBends ?? [],
			status: 'accepted',
			replacements: { tee: 0, basket: 0, bend: 0 }
		};
	});
}
