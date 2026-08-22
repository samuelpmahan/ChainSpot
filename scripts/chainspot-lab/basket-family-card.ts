import type { InvariantCard } from './invariants';

/**
 * Provisional object-specific instantiation of I20 Useful Family Signal.
 * Kept separate while the card schema is still being refined; the content is
 * intentionally small and heavily cross-linked rather than duplicating D03.
 */
export const BASKET_FAMILY_SIGNAL_CARD: InvariantCard = {
  id: 'I22-basket-family-signal',
  title: 'Basket Family Signal',
  strength: 'renderer-family-observed',
  gates: [2, 6],
  detectors: ['D03-basket-sprite'],
  claim: 'An intact basket is a repeated white 42x66 renderer family inside strong local black enclosure; family outliers should first be treated as attributable overlap cases rather than widening the intact family.',
  scope: 'Dev72 plus Beaver/Coleto/Fountain/SeaTac basket-family study on 2026-08-22; ownership remains downstream.',
  evidence: [
    'Dev72 Pass 1 found 66/72 clean baskets; all six misses were renderer overlaps and a seeded recovery pass recovered 6/6.',
    'Beaver/Coleto/Fountain/SeaTac produced 79 clean + 7 attributable recoveries = 86 basket objects for 86 visible badges in the local reproduction.',
    'On Beaver, 18 clean baskets shared the same 42x66 / 1746-bright-pixel family; the old global matcher produced 44 candidates because real baskets generated shifted echoes.',
    'The hardest measured Dev72 recovery retained about 39% effective basket-white visibility and remained MEDIUM rather than HIGH confidence.'
  ],
  use: [
    'Instantiate I20 with separate white-family, local-black-enclosure, visibility, and occluder testimony.',
    'Pass 1 accepts the intact repeated family; Pass 2 searches only neighborhoods where a known badge or accepted basket can explain missing pixels.',
    'Keep object identity separate from hole ownership and preserve recovery source plus effective visibility.'
  ],
  doNotInfer: [
    'A high family score assigns the basket to a hole.',
    'Total size of the connected black component matters; only local enclosure is observed to matter.',
    'Missing pixels hidden by a known occluder are negative evidence.',
    'A shifted template response is a second basket object.'
  ],
  breakers: [
    'Renderer scale/theme/version changes the basket family.',
    'Too few clean examples survive to bootstrap the current-image black-border family.',
    'An unmodeled occluder removes evidence without an attributable seed.',
    'Mixed scales exist inside one canonical raster.'
  ],
  retest: 'On a fresh course, report clean/recovered object counts, white coverage, local black support, effective visibility, duplicate-object count, and badge-count mismatch before changing thresholds.',
  sources: ['I20 Useful Family Signal', 'I05 basket-sprite anchor', 'I06 anchor-locked basket zone', 'C02 Tight Cluster', 'C03 Merged Renderer Component', '2026-08-22 smart basket family study']
};
