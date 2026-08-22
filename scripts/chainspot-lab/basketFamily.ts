import type { InvariantCard } from './invariants';

/**
 * Provisional object-specific instantiation of I20 Useful Family Signal.
 * Kept separate while the card schema is still being refined; the evidence is
 * intentionally short and points back to the detector/case cards for detail.
 */
export const BASKET_FAMILY_SIGNAL_CARD: InvariantCard = {
	id: 'I22-basket-family-signal',
	title: 'Basket Family Signal',
	strength: 'renderer-family-observed',
	gates: [2, 3, 6],
	detectors: ['D03-basket-sprite'],
	claim:
		'An intact basket is a repeated renderer family whose expected white sprite support and local black enclosure agree; partial baskets remain identifiable when the missing support is attributable to a known higher renderer object.',
	scope:
		'Dev72 plus the 2026-08-22 Beaver/Coleto/Fountain/SeaTac basket-family study. Object identity only; hole ownership is downstream.',
	evidence: [
		'Dev72 clean-family pass found 66/72 baskets with no prototype extras; the six misses were renderer-overlap cases and all six were recovered by badge/basket-seeded local search.',
		'Beaver/Coleto/Fountain/SeaTac produced 79 clean + 7 attributable recoveries = 86 basket objects, matching the 86 visible badge inventory; the old broad matcher had produced 243 candidates across the same four courses.',
		'Clean Beaver baskets repeatedly exposed the same 42x66 white family near 1746 bright pixels while the enclosing dark connected-component size varied wildly; local black enclosure, not global dark-component size, was stable testimony.',
		'The hardest measured Dev72 recovery retained about 39% effective expected-white visibility and remained identifiable but MEDIUM rather than HIGH confidence.'
	],
	use: [
		'Instantiate I20 with separate white-family support, local black-border support, effective visibility, and occluder provenance; do not collapse them into one opaque template score.',
		'Recognize intact/topmost baskets first, then search only neighborhoods where a known badge or accepted basket can explain missing expected support.',
		'Treat shifted responses explained by one accepted sprite as duplicate hypotheses, not additional basket objects.'
	],
	doNotInfer: [
		'Basket identity does not establish hole ownership.',
		'Missing pixels under a known occluder are not negative testimony.',
		'A large enclosing black component does not invalidate a basket when the expected local enclosure survives.',
		'Matching badge cardinality is a useful red flag/check, not proof that every object is correct.'
	],
	breakers: [
		'Renderer scale/version changes that alter the sprite family.',
		'Too few intact baskets to bootstrap a trustworthy course-local black-border consensus.',
		'An unmodeled occluder removes most expected white and black testimony.',
		'Mixed zoom/resampling inside one raster.'
	],
	retest:
		'On a fresh raster, report clean/recovered counts, duplicate candidates, white-family coverage, black-border support, effective visibility and recovery source; with truth, report recall/FP and pole-tip error before changing thresholds.',
	sources: [
		'I20 Useful Family Signal',
		'D03 Basket Sprite Matcher',
		'I05 basket-sprite anchor',
		'I01 Render Stack Order',
		'C02 Tight Cluster',
		'C03 Merged Renderer Component',
		'2026-08-22 smart-basket two-pass Dev72 + held-out validation study'
	]
};

if (process.argv[1]?.endsWith('basketFamily.ts')) {
	console.log(`${BASKET_FAMILY_SIGNAL_CARD.id} — ${BASKET_FAMILY_SIGNAL_CARD.title}`);
	console.log(BASKET_FAMILY_SIGNAL_CARD.claim);
	for (const value of BASKET_FAMILY_SIGNAL_CARD.evidence) console.log(`  - ${value}`);
}
