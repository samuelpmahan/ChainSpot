# CHSPT-72 — Stitch Map: releasing a superseded tile-sourced thrown round back into the pool

## Goal
When a user picks a different tile as the thrown round (or discards a
tile-sourced thrown round), the previously-reserved tile's image reappears
in the stitching pool instead of being silently lost.

## Required behavior
- `handleMarkTileAsThrownRound` (src/routes/stitch-map/+page.svelte,
  ~line 1444): before reserving the newly-picked tile, if a *tile-sourced*
  thrown round is already held, restore it into the slot just vacated by the
  new pick instead of dropping it.
- `handleClearThrownRound` (~line 1457): when the discarded thrown round is
  tile-sourced, restore it into an empty active slot (adding one via the
  existing `addSlot()` if none is free) instead of dropping it.

## Non-goals
- Changing the single-slot "replace on set" design of
  `session.ts`'s `thrownRoundSource` (correct; covered by
  `tests/unit/thrownRoundFlow.test.ts`).
- The Smart Import "pick from result" flow
  (`handleMarkResultSourceAsThrownRound`) — it never populates the per-tile
  grid to begin with (bulk import lands directly on the composited result;
  the grid path and the bulk path are mutually exclusive entry points per
  the existing code comment at that function), so there is nothing tile-
  sourced to release there.
- "Keep as thrown round" from a composited result
  (`handleKeepAsThrownRound`). **Known gap, deliberately out of scope**: if
  a user marks a grid tile as thrown round, then later (after stitching
  completes) clicks "Keep as thrown round" on the *result* instead, the
  tile-sourced reservation is still silently dropped — same root cause, but
  outside this ticket's approved acceptance criteria, which pins that flow
  as "unchanged". Flag as a candidate follow-up if this repros in practice.

## Known context
- The "pool" is `tiles` (`Partial<Record<TileSlot, StitchTile>>`) keyed by
  `activeSlots`; a `StitchTile` already carries the decoded `image` plus the
  original `file`, so restoring one is a plain state assignment — no
  re-decode needed.
- `handleRemove(slot)` (~line 799) is the only place that empties a slot; it
  also fires `resetToImport()` when no slot has a tile left. Restoring a
  released tile must happen atomically with the removal that frees its
  target slot (not as a separate follow-up write), or a same-tick
  `resetToImport()` could wipe `activeSlots` out from under the intended
  restore.
- The `$effect` at ~line 1844 already (re)initializes `placements` once all
  active slots are filled and the crop validates — restoring a tile into an
  emptied slot needs no separate placement bookkeeping.
- `heldThrownRoundTile` (new page-local var, full `StitchTile`, not `$state`
  since nothing renders it directly) tracks which `StitchTile` is behind the
  current `heldThrownRound` display var — but only when it came from the
  grid. It resets to `null` on every remount (page tiles are transient
  browser resources, never durable — matches the existing comment at
  `tiles`'s declaration), so a thrown round carried across a route round
  trip and then discarded on the far side has nothing tile-shaped to
  restore. That mirrors the existing session-persistence boundary and is not
  a regression.

## Acceptance
- Mark tile A as thrown round, then mark tile B as thrown round instead:
  tile A's image reappears as an available slot in the grid, tile B is now
  the reserved thrown round.
- Discarding a tile-sourced thrown round via the banner's Discard restores
  that tile to the grid.
- `handleKeepAsThrownRound` and `handleMarkResultSourceAsThrownRound`
  behavior is unchanged.
- `npm run check` passes; existing `thrownRoundFlow` unit suite still
  passes unmodified (its scope is `session.ts`/`create-graphics`, not this
  page).

## Proof Plan
- Highest-value behavior to prove: the tile-to-tile swap round-trips a
  tile's `File`/dimensions back into a real slot in `tiles`/`activeSlots`
  (not just that the old thrown-round reference isn't leaked) — this is a
  Svelte 5 runes state + Konva-backed page, so it is not unit-testable in
  jsdom (`tests/setup.ts` stubs `HTMLCanvasElement.getContext` to null;
  Konva rendering is Playwright-only per AGENTS.md). No committed unit or
  e2e spec currently exercises the per-tile thrown-round grid at all
  (checked: `tests/e2e/stitchMap.spec.ts` has zero thrown-round coverage
  today), so there is no regression suite to lean on here.
- Regression test that would fail if wrong: none exists yet for this exact
  interaction; verification for this ticket is manual/scripted-browser
  (ad hoc Playwright driving the dev server), not a new committed spec,
  consistent with AGENTS.md's guidance to avoid adding e2e specs unless
  they're the highest-value proof and with this being a scoped hotfix.
- Real-browser verification is required: yes — pointer-driven grid
  interaction, DOM text assertions (slot filename/dimensions), not provable
  by typecheck alone.
- Nearby regression risk: the `handleRemove(slot, replacement?)` signature
  change (adding an optional replacement param) is shared with the plain
  "Remove" button per tile slot (line ~2057) — must confirm removal-without-
  replacement still empties the slot and still triggers `resetToImport()`
  when it was the last tile.
- Limitation: cannot prove the Konva canvas *visually* reflects the restored
  tile in jsdom or headless without real GPU/canvas support; DOM-level state
  (slot text, `tiles` object shape) is what gets verified.
