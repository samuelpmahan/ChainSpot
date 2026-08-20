# Annotate Round: end-user ask copy

**Status**: design only, nothing here is implemented. Companion to
`docs/annotate-round-correction-log.md` (schema, storage, gating policy)
and `docs/annotate-round-pipeline-debug-view.md` (the internal-only
counterpart of this doc) -- this one is the shippable, end-user-facing
piece of the semi-supervised track: the actual words a user sees when the
system asks them something.

The three-way split this copy implements (confirm one / disambiguate
between two / place from scratch) is defined in
`annotate-round-correction-log.md`'s gating-policy section, mapped to the
specific failure patterns found in this session's GRayT vision pass
(`docs/deferred-detection-experiments.md`). This doc only covers wording
and interaction, not when each type fires.

Each ask should be answerable in one glance and one tap, no CV vocabulary
exposed -- "confidence," "NCC," "gate," and detector names belong in the
internal debug view, never here:

- **Confirm**: "Is this hole 6's tee?" + the marker shown on the image.
  One tap confirms, a drag corrects -- reuses the existing frictionless
  chip verbatim, just now logged.
- **Disambiguate**: "Which pin is hole 2's basket?" with exactly the two
  contested candidates shown, nothing else on screen competing for
  attention. Never more than two options -- if courseGrammar's candidate
  pool has more than one real contender beyond the top two, that's a
  Place case instead, not a three-or-more-way picker.
- **Place**: "Tap hole 14's tee" with no candidate shown at all (per the
  isolated-badge pattern, showing a bad guess to reject is worse than
  admitting there isn't one) -- optionally centered/zoomed near the badge
  as a starting point, never a system-wide guess.

No hole should ever surface more than one of these at a time.

## Exact copy

So there's no ambiguity to bikeshed later:

| Ask type | Endpoint | Prompt | Primary action | Secondary action |
|---|---|---|---|---|
| Confirm | tee | "Is this hole {N}'s tee?" | Tap marker = Yes | Drag marker = "moved it for you" |
| Confirm | basket | "Is this hole {N}'s basket?" | Tap marker = Yes | Drag marker = "moved it for you" |
| Disambiguate | tee | "Which one is hole {N}'s tee?" | Tap A or B | -- (exactly 2 options, never "neither" here -- see Place) |
| Disambiguate | basket | "Which one is hole {N}'s basket?" | Tap A or B | -- |
| Place | tee | "Tap hole {N}'s tee" | Tap anywhere on image | "Skip for now" |
| Place | basket | "Tap hole {N}'s basket" | Tap anywhere on image | "Skip for now" |

## Rules the table is enforcing

Stated once so future copy changes stay consistent:

- Always "hole {N}," never "endpoint" or "candidate" -- the user thinks in
  holes, not in the schema's vocabulary.
- Tee/basket is always named explicitly, never "point" or "marker" alone
  -- ambiguity between the two is exactly the kind of mistake this whole
  system exists to prevent, the copy shouldn't reintroduce it.
- "Skip for now," never "skip" or "cancel" bare -- signals it'll come back
  later (matches the correction log's `userAction: 'skip'` staying
  revisitable, not a dead end) and is only offered on Place, where there's
  genuinely nothing to fall back to. Confirm/Disambiguate don't need it --
  worst case on those is "drag it to the right spot," never "I have no
  idea."
- No progress-bar/count language ("3 of 18 remaining") in the ask itself
  -- that's a legitimate thing to show *around* the ask (e.g. a header),
  but stapling it onto the question adds a second thing to parse per tap.
