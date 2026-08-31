# 01 — Compose only what the live badge algorithm claims

This checkpoint intentionally stops before fixing anything.

The purpose is to make the live badge claim visible in the same order the code actually executes, so any missing custody can reveal itself without being announced in advance.

## Live execution order

1. `computeBrightDarkMasks(image)` produces the bright and dark masks together.
2. `extractComponents` labels bright and dark connected components.
3. `detectBadgeFamily` evaluates bright components using bbox geometry plus dark fraction and selects the anchored bright family.
4. `recoverDarkPlateBadges` may append badges recovered from dark plate geometry.
5. `readCourseBadges` extracts bright glyph evidence from accepted badge interiors, then segments, normalizes to 24x32, and scores digits.
6. Physical object acquisition later calls `assembleBadgeV1`.
7. `assembleBadgeV1` claims exactly:
   - the accepted outer bright component;
   - the largest contained dark component as the plate;
   - bright components contained by that plate as glyphs.
8. `materializeComponentAssembly` converts those selected component labels into exact owned pixels and perimeter pixels.

## PCR Tick projection for this checkpoint

The PCR should expose the live progression without adding new semantics:

- **Tick 1 — Masks:** show bright and dark masks from the same thresholding step.
- **Tick 2 — Components / family:** show the labeled components and which bright components survive into the badge family; show dark-plate recovery separately when used.
- **Tick 3 — Digit read:** show extracted bright glyph evidence, segmentation, 24x32 normalization, and scores.
- **Tick 4 — Physical composition:** show exactly the component union selected by `assembleBadgeV1` and the materialized ownership it produces.
- **Tick 5 — Subtraction:** remove only that live ownership from original RGB and show the residue unchanged.

Nothing in this checkpoint claims that the live composition is complete.

The intended experiment is simply:

> if the live algorithm says it owns the badge, what remains after we subtract exactly what it says it owns?

Do not hide or reinterpret residue yet.
