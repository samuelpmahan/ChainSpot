# Badge PCR discovery Script

This branch is intentionally organized as an empirical replay rather than an abstraction-first implementation.

The live badge path we must remain faithful to is:

1. `computeBrightDarkMasks` produces bright + dark masks from the same image.
2. `extractComponents` labels both masks.
3. `detectBadgeFamily` uses bright component geometry plus dark fraction inside each bbox, then selects the anchored bright family; `recoverDarkPlateBadges` may append dark-plate recoveries.
4. `readCourseBadges` extracts bright glyph evidence from the accepted badge interior, segments digits, normalizes each digit to 24x32, and scores 0-9.
5. Physical object acquisition later calls `assembleBadgeV1`: outer bright component + largest contained dark plate + bright glyph components inside that plate.
6. `materializeComponentAssembly` dereferences those selected component labels into exact owned pixels.
7. Only after that live claim exists do the scratch PCR experiments subtract ownership and study the residue.

The history should therefore reveal the same story the pixels revealed:

- gradual live composition;
- OOPS: dark digit counters visible in Mask2 never receive ownership;
- experimental fix: include those contained dark digit components;
- subtraction still leaves digit-shaped RGB residue;
- residual-only digit matching proves that residue encodes digit identity;
- population overlap reveals stable corner/rim residue;
- right-rail / local residue remains inconsistent and explicitly unexplained.

Do not reorder these merely to make the diagram prettier. The useful PCR is the one so faithful to the actual algorithm that the missing counters become obvious accidentally.
