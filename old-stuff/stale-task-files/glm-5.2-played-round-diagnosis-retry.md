# GLM 5.2 — played-round diagnosis retry

- Session: `ses_feff44f32ffedIjWsMnih9BWN2`
- Model: `opencode-go/glm-5.2`
- Runtime: approximately 421 seconds for the retry, after a 90-second incomplete first attempt
- Cumulative session cost: `$0.28159626`
- Lead score: **2/4 — basically correct**
- Accepted evidence: defects 1 and 2 are confirmed; defect 3 is a plausible, correctly labeled risk.
- Reviewer defect: the proposed fix for defect 2 is incorrect. With `draft.order = 2` and two current shots it still produces index 1, reproducing the silent reorder instead of appending.

The following is GLM's retry response, preserved verbatim.

---

# Played-Round → Detector → Editable State: Ranked Top-Three Defect Report

Scope: `playedRoundDetectionBrowser.ts`, `playedRoundReview.ts`, `PlayedRoundProposalReview.svelte`, `create-graphics/+page.svelte`, plus direct dependencies (`playedRoundContract.ts`, `holeAnnotation.ts`, `cv/types.ts`, `alignment/transform.ts`, `domain/project.ts`). No files edited.

---

## #1 — CONFIRMED: Re-registration does not re-run detection or recompute proposals; accepted throws land at stale clean-image coordinates

**Location:** `src/routes/create-graphics/+page.svelte:2197-2203` (mount gate + no remount key); `src/lib/components/PlayedRoundProposalReview.svelte:67-83` (detection/proposal build only in `onMount`); `src/lib/playedRoundReview.ts:66-91` (proposals bind the registration's `playedToClean`).

**Failure scenario:**
1. User confirms a registration → `playedRoundRegistrationConfirmed = R1` (`+page.svelte:490-493`). `PlayedRoundProposalReview` mounts; `onMount` runs `detectPlayedRoundLandings` and `createPlayedRoundProposals(candidates, R1, holes)`. Proposals' `cleanPoint` = `applyTransform(playedPoint, R1.playedToClean)` (`playedRoundReview.ts:73-79`).
2. User closes the registration panel (`onClose` → `playedRoundRegistrationOpen=false`, but `playedRoundRegistrationConfirmed` stays set; the review stays mounted).
3. User reopens ("Review played-round registration", `+page.svelte:2175-2177`), edits landmarks, clicks Confirm again. `confirmPlayedRoundRegistration(R2)` sets `playedRoundRegistrationConfirmed = R2` with a *different* `playedToClean`.
4. The `{#if playedRoundRegistrationConfirmed}` block at `+page.svelte:2197` stays truthy; Svelte updates the `registration` prop in place — **`onMount` does not re-fire**. `proposals` and `drafts` still hold `cleanPoint`s computed from R1.
5. User accepts a proposal: `acceptProposal` (`PlayedRoundProposalReview.svelte:47-54`) builds `reviewed.cleanPoint` from `draft.xPx/yPx` (the R1-era value) and calls `acceptPlayedRoundProposal` → `addShot` (`holeAnnotation.ts:200-208`) writes that stale coordinate into `editor.state.holes[*].shots[*].landing`, which is authoritative source-overview-pixel state.

**Impact:** Silent corruption of authoritative round geometry. The user is never warned that the displayed landings correspond to the discarded transform.

**Smallest fix:** Force remount on registration identity so `onMount` re-runs:
```svelte
{#key playedRoundRegistrationConfirmed}
  {#if playedRoundRegistrationConfirmed}
    <PlayedRoundProposalReview registration={playedRoundRegistrationConfirmed} holes={currentHoles()} onHolesChange={updatePlayedRoundHoles} />
  {/if}
{/key}
```
(Place at `+page.svelte:2197-2203`.) This is the minimal change; the review's `onMount` already does the right work, it just never runs again.

---

## #2 — CONFIRMED: Stale `draft.order` makes accepting a later proposal silently reorder already-accepted throws

**Location:** `src/lib/components/PlayedRoundProposalReview.svelte:29-38` (`initialDraft`, run once in `onMount` at `:74`); `:44-57` (`acceptProposal`); `src/lib/playedRoundReview.ts:94-104` (`acceptPlayedRoundProposal` → `reorderShot`); `src/lib/holeAnnotation.ts:236-252` (`reorderShot`).

**Failure scenario:**
1. Hole 1 starts with one accepted throw `[S1]` (index 0). Detection produces proposals A and B, both suggested for hole 1. `initialDraft` (`:34`) sets `order = (hole.shots.length ?? 0) + 1 = 2` for **both** A and B (computed once from the holes snapshot at mount).
2. User accepts A: `toIndex = Math.max(0, Math.round(2)-1) = 1`. `addShot` appends S2 → `[S1, S2]`; `reorderShot(..., S2, 1)` is a no-op (already at 1). Correct.
3. `onHolesChange` updates `editor.state.holes`; the `holes` prop refreshes, but `drafts` is **never recomputed** (only built in `onMount`). B's draft still says `order = 2`.
4. User accepts B: `toIndex = Math.max(0, 2-1) = 1`. `addShot` appends S3 → `[S1, S2, S3]`; `reorderShot(..., S3, 1)` moves S3 from index 2 to index 1 → `[S1, S3, S2]`. **S2 was silently demoted from 2nd to 3rd** without any user action on S2.

`reorderShot` (`holeAnnotation.ts:245`) only clamps to `shots.length - 1`; it does not detect that the target index reflects stale input, so it happily moves an existing throw.

**Impact:** Authoritative throw ordering (array order in `AnnotatedHole.shots` is the canonical order per `domain/project.ts:120-128`) is silently changed. The user's prior acceptance is rewritten behind their back.

**Smallest fix:** Recompute the target index from the *current* hole shot count at accept time, clamping a non-explicit order to "append":
```ts
// inside acceptProposal, before acceptPlayedRoundProposal
const hole = holes.find((h) => h.id === draft.holeId);
const appendAt = hole ? hole.shots.length : 0;
const toIndex = Math.max(0, Math.min(Math.round(draft.order) - 1, appendAt));
```
Use `toIndex` in the `acceptPlayedRoundProposal` call (`:48-54`). This preserves explicit in-the-middle inserts (order ≤ current length) while making a stale/oversized order append instead of reordering existing shots.

---

## #3 — RISK (confirmed mechanism): Proposal IDs collide on duplicate `(kind, xPx, yPx)` detector candidates, breaking the keyed list, the drafts map, and accept-then-filter

**Location:** `src/lib/playedRoundReview.ts:76` (id construction); `src/lib/components/PlayedRoundProposalReview.svelte:74` (drafts `Object.fromEntries`), `:102` (`{#each proposals as proposal (proposal.id)}`), `:56` (`proposals.filter(... !== proposal.id)`).

**Mechanism:** The id is `landing-${candidate.kind}-${candidate.xPx.toFixed(3)}-${candidate.yPx.toFixed(3)}` — deterministic from float coordinates with no uniqueness suffix. If the detector (`classifyLandingDropletGlyphs` via `findLandingDroplets`) ever returns two candidates with the same `kind` and centers that agree at 1/1000 px (overlapping droplets, a detector change, or a fixture with stacked markers), the downstream invariants break:

- `drafts = Object.fromEntries(proposals.map((p) => [p.id, initialDraft(p)]))` (`:74`) collapses duplicates: only the last draft survives.
- `{#each proposals as proposal (proposal.id)}` (`:102`) uses a non-unique key — Svelte 5 treats duplicate keyed-each keys as undefined behavior; one row may clobber the other's DOM state.
- `acceptProposal` then runs `proposals = proposals.filter((c) => c.id !== proposal.id)` (`:56`), which removes **every** proposal sharing that id, even ones the user never accepted → data loss of the remaining duplicate proposals.

**Why risk, not confirmed:** I could not read `findLandingDropletGlyphs`/`findLandingDroplets` in this review, so I cannot prove the detector emits exact-coordinate duplicates today. The collision mechanism in the review/UI layer is confirmed; the trigger depends on detector output.

**Smallest fix:** Make the id unique without depending on coordinate uniqueness — append the array index (or a generated id) at proposal construction:
```ts
return candidates.map((candidate, index) => ({
  id: `landing-${candidate.kind}-${candidate.xPx.toFixed(3)}-${candidate.yPx.toFixed(3)}-${index}`,
  ...
```
(`playedRoundReview.ts:72-90`.) Index is stable for a single detection pass and sufficient to disambiguate within one `createPlayedRoundProposals` call.

---

### Notes explicitly excluded
- Visual styling / Gate 3 graphics — out of scope per instructions.
- `acceptPlayedRoundProposal`'s silent no-op on an unknown `holeId` (`playedRoundReview.ts:102`, `holeAnnotation.ts:200-208`) is a defensive fragility, but in the current flow `holes` only mutates through the review's own `onHolesChange` callback (`+page.svelte:500-504`), so a stale `holeId` is not reachable today; noted as a hardening item, not ranked.
- `loadTemplates` re-fetches on every detection (`playedRoundDetectionBrowser.ts:41-49`) — performance, not correctness.
