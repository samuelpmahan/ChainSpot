// Thrown-round arbitration — the DECIDE half of a two-step job. The MEASURE
// half already lives in detectors/purpleMass.ts (measurePurpleMass); this
// file extracts the rule that used to live inline in the page's
// considerAutoThrownRound() (src/routes/+page.svelte, ~lines 417-434):
// given one purple-mass score per candidate image, is exactly one of them
// the thrown round?
//
// Exact-one-candidate semantics, preserved from the page: zero candidates
// above threshold means "nothing to auto-pick yet" (the caller keeps
// waiting or leaves selection manual); more than one means genuinely
// ambiguous — the app must not guess, it surfaces the ambiguity and waits
// for the user to mark one manually. Auto-selection only fires on the
// single unambiguous case.
//
// Session-state gates that stay page-side (not part of this rule): "has
// the user already picked one" (thrownIdx >= 0), "is auto-selection even
// enabled right now" (autoThrownEnabled), and "are there any images at
// all" — those are about WHEN to ask this question, not the answer to it.
//
// OperationKind (future exec integration, see g0/README note in truth.ts):
// this is a 'decide' operation; its sibling 'measure' operation is
// measurePurpleMass.

/** Purple is not expected on a clean course capture — see purpleMass.ts. */
export const THROWN_ROUND_PURPLE_MASS_MIN = 0;

export interface ThrownRoundCandidate {
	readonly index: number;
	readonly score: number;
}

export type ThrownRoundDecision =
	| { readonly status: 'waiting' }
	| { readonly status: 'none' }
	| { readonly status: 'auto'; readonly index: number; readonly score: number }
	| { readonly status: 'ambiguous'; readonly candidates: readonly ThrownRoundCandidate[] };

/**
 * `scores[i]` is image i's purple-mass confidence, or `undefined` when that
 * image's measurement hasn't finished yet (mirrors the page's
 * `purpleReady` gate — any undefined score means the whole decision waits,
 * matching `images.some((image) => !purpleReady[...])`).
 */
export function decideThrownRound(
	scores: readonly (number | undefined)[],
	threshold: number = THROWN_ROUND_PURPLE_MASS_MIN
): ThrownRoundDecision {
	if (scores.length === 0) return { status: 'none' };
	if (scores.some((score) => score === undefined)) return { status: 'waiting' };

	const candidates: ThrownRoundCandidate[] = scores
		.map((score, index) => ({ index, score: score as number }))
		.filter(({ score }) => score > threshold);

	if (candidates.length === 0) return { status: 'none' };
	if (candidates.length === 1) return { status: 'auto', index: candidates[0].index, score: candidates[0].score };
	return { status: 'ambiguous', candidates };
}
