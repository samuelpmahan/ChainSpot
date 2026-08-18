# CHSPT-78 — Semantic pose seed → local OpenCV verification

## Contract

A semantic pose prediction is a search hint, not accepted geometry.

For a predicted directed pair `(a,b,orientation,dx,dy)`:

1. Run the existing `cvMatch.matchTranslationNear` in a small full-resolution window around the predicted translation.
2. If the local NCC score clears the configured evidence bar, use that verified translation and do **not** pay for a global coarse search for that pair.
3. If the local score is weak, invoke the caller-owned global fallback unchanged. In `poseGraph.ts` that fallback remains the existing both-directions × both-orientations pair search.
4. Record local verification time, fallback time, chosen path, and the weak local match when fallback occurred.

This is deliberately provider-agnostic. CHSPT-75/76 can later inject real seeds; fixtures can inject them now.

## Why the fallback callback is outside this module

`poseGraph.ts` already owns pair direction/orientation search and topology. Copying that logic here would create a second pose-graph implementation and make semantic failure behavior subtly different from the current production fallback. `verifySemanticPoseSeed` therefore only owns the new decision: **cheap local evidence sufficient, or run the old search**.

## Expected latency shape

The current global coarse matcher searches the whole low-resolution image and tests multiple direction/orientation hypotheses for each unordered pair. The seeded path performs one windowed full-resolution match around a predicted offset. The exact wall-clock win is fixture/hardware dependent; CHSPT-80 consumes the timing fields rather than baking a guessed speedup into this ticket.
