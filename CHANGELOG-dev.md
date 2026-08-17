# ChainSpot dev changelog

One line per landed feature. Condensed/reset periodically; Git history keeps
prior contents.

## 2026-08-17 — CHSPT-72: release a superseded thrown round back into the pool

- Stitch Map: picking a different tile as the thrown round releases the previously-reserved tile's image back into the grid instead of losing it
- Stitch Map: discarding a tile-sourced thrown round (banner's Discard) restores it to the grid when a slot is free; if the grid has already fully stitched, discarding says plainly the tile can't be restored instead of silently corrupting the completed layout

Verified: `npm run check`; `thrownRoundFlow` unit suite unaffected (unmodified, still green);
ad hoc Playwright runs (not committed) covering the tile-to-tile swap, a mid-import Discard
restore, and a post-stitch Discard (byte-identical tile placements before/after, no phantom
slot). Independent review caught a real regression in the first pass — `restoreTileToPool`'s
`addSlot()` fallback silently corrupted other tiles' already-committed placements when Discard
fired after a completed stitch with no empty slot — fixed by dropping that fallback entirely;
re-review confirmed the fix. Known non-blocker: `heldThrownRoundTile` can survive "Start a new
map" into an unrelated later session; flagged as an optional follow-up, not fixed here.

## 2026-08-17 — CHSPT-65: course + thrown-round inputs into Create Graphics

- Stitch Map: import prompt with thumbnails — pick the thrown round BEFORE any crop/stitch
- Stitch Map: "Thrown round" button on each loaded tile slot
- Stitch Map: pick the thrown round from a stitched result (clean map re-stitches without it)
- Stitch Map: "Keep as thrown round" for a single-capture result
- Stitch Map: persistent held-round banner with Discard
- Session: thrown-round slot, distinct from clean-source handoff, survives into Create Graphics
- Session: stale thrown round auto-cleared when a new course workflow starts
- Annotate Course: completion panel button "Continue to Create Graphics" (skips Map Round)
- Annotate Course: Holes selector 9/18 — 9-hole courses can now complete
- Annotate Course: completion blocked if confirmed holes exist beyond selected length
- Annotate Course: CV detection auto-selects 9 when all evidence is in holes 1–9
- Create Graphics: banner showing the carried thrown round
- Create Graphics: Fetch Clean Target moves above the panes until a clean target is committed
- Unchanged: Map Round route, direct image upload, correspondence/registration flow

Verified: `npm run check`; unit suites `thrownRoundFlow` + `annotateCourseCompletionHandoff`;
26/26 scripted Chromium checks; independent review addressed; staged for manual acceptance.
No unit coverage for detection→9 (needs real Worker). Six pointer-test suites red at clean
HEAD in the work container — pre-existing, unrelated.
