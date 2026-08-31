# PCR 2 — the dark digit counters survive

Replay the live badge algorithm exactly through subtraction:

1. `computeBrightDarkMasks()` produces the bright and dark masks together.
2. Both masks are component-labeled.
3. `detectBadgeFamily()` chooses the bright-family badges using aspect plus dark fraction.
4. `readCourseBadges()` extracts bright glyph pixels, segments them, normalizes to 24x32, and scores the digits.
5. `assembleBadgeV1()` composes the physical badge from the accepted outer bright component, the largest contained dark plate, and bright glyph components inside that plate.
6. `materializeComponentAssembly()` turns exactly those selected components into owned pixels.
7. Subtract those owned pixels from the observed RGB crop.

The surprising result is visible without changing the algorithm: for glyphs with counters/holes (`0/4/6/8/9`), small contained dark components are present in the already-computed dark-component evidence, but they are not selected by `assembleBadgeV1()`. They therefore survive exact subtraction.

This checkpoint is intentionally pre-fix. It records the discrepancy between the algorithm's available evidence and its physical-ownership claim before altering custody.
