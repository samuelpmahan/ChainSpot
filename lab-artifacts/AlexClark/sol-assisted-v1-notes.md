# AlexClark Sol machine-assisted blind endpoints v1

## Boundary and vocabulary

- **PIXEL OBSERVATION**: visible raster structure, without assigning semantic identity.
- **MEASUREMENT**: a reproduced output of the existing detector implementation.
- **INFERENCE**: Sol's assignment of a measured candidate to a hole.
- **HYPOTHESIS**: an explanation not established by the current pixels or measurements.
- **ORACLE OBSERVATION**: none; Alex truth remained sealed.
- Canonical frame: 1290 x 2082 production-auto-cropped raster; origin top-left, +x right, +y down.
- Geometry boundary: endpoints only. Existing corridorBends and corridorWidthPx fields were copied unchanged from state A and were not re-evaluated.

## BADGES

- MEASUREMENT: 16 badge-family plates; decoded labels 1-4 and 6-17. Every produced label had minimum per-digit probability margin >= 0.9787.
- AGREES: 15. CONTRADICTS_BLIND: H17 coordinate. STILL_UNRESOLVED by machine: H5 and H18, whose visual judgments are retained.
- H17 changed from visual center (578,711) to measured plate center (574.27,787.53). This is a coordinate correction, not an Oracle ruling.
- LIMIT: the logistic model and segmentation were developed from labeled dev data. Runtime inputs are truth-free, but the model is not provenance-clean enough to make its label an Oracle-like fact.

## BASKETS

- MEASUREMENT: 20 sprite matches. Eighteen correspond to visible course sprites; two low-score matches terminate at the bottom boundary and were rejected as boundary artifacts.
- Useful fields: template bbox, onFrac, offFrac, score, and the fixed pole-tip transform tip=(center.x, bbox.bottom+4).
- All 18 blind sprite identities were reproduced. Exact pole tips replaced visual center estimation.
- RESOLVES_BLIND_UNCERTAINTY: H13 and H15 ownership. H13 resolution is an INFERENCE from distinct H13/H14/H15 tee inventory plus the sprite inventory, not a basket-detector ownership output.
- STILL_UNRESOLVED: H16 ownership. The sprite is real (score 0.9747), but the basket detector supplies no hole label and no independent H16 tee was measured.
- LIMIT: the committed basket template metadata says 66 observations, and source comments describe truth-guided dev contact-sheet derivation. Runtime matching is truth-free; historical calibration is not fully clean-room.

## TEES

- MEASUREMENT: 25 tee candidates: ring and component tiers. Candidate count is not hole count; several component candidates are basket residues or screen furniture.
- AGREES: H1, H5-H7, H9-H11, H14-H15, H18 (10).
- CONTRADICTS_BLIND: H2, H3, H4 center estimates; H17 identity (4).
- RESOLVES_BLIND_UNCERTAINTY: H12 and H13 (2).
- STILL_UNRESOLVED: H8 and H16 (2).
- Assisted annotation stores 16 tees. H12 is now stored as an endpoint even though its route geometry remains unresolved; endpoint identity and bend geometry are separate questions.

## Causal cases

- H13 tee — BLIND: (734,69) rejected as a duplicate view of H15. MEASUREMENT: ring center (732.79,67.71), elongation 1.661, ringFrac 0.603, area 77; H15 is a separate ring at (705.89,108.98), elongation 1.587, ringFrac 0.885, area 206. ASSISTED INFERENCE: accept H13 tee at (733,68).
- H17 tee — BLIND: (675,694) rejected as square C1/C2 furniture. MEASUREMENT: center (675.07,700.05), elongation 1.547, ringFrac 0.754, area 206, angle 2.450 rad. ASSISTED INFERENCE: accept H17 tee at (675,700). Difficulty: at course scale the bright outer glyph looks square; enclosed-hole covariance preserves the elongation hidden by the outline.
- H8 tee — component candidates near (446.47,862.80) and (459.18,866.66) overlap basket pixels and lack enclosing-ring evidence. ASSISTED: unresolved.
- H16 tee — no ring/component candidate near the visual search region. ASSISTED: unresolved.
- H2/H3/H4 — detector identity is useful mainly as a center measurement: corrections of about 50, 19, and 20 px respectively exceed the frozen visual uncertainty.

## Instrument quality

- Helpful: enclosing-hole elongation, ring fraction, ring/component tier, exact sprite template offset, and explicit on/off fractions.
- Persuasive-looking but insufficient: decoded badge label without acknowledging labeled-model provenance; basket score as if it assigned ownership; component-tier tee candidates without enclosing-ring evidence.
- Missing: truth-independent recovered-tee evidence, hole ownership scores for baskets/tees, and a negative-evidence record explaining rejected component candidates.
- Recovered tier was not used. The available recovery probe consumes truth basket coordinates and hard-coded course answers; its Alex outputs were refused.
