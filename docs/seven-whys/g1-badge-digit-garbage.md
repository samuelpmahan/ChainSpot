# Seven whys — G1 badge digit garbage ("1868", "295", "787", duplicate "17"/"12")

Opus lead forensics, 2026-08-28. Base `ffcf9dc`. Truth-free; every number
below is reproducible from the canonical rasters this document cites.

Reproduce:

```
./lab sweep packages/alg/src/detectors/threeFactor/configs/default.json \
  ../chainspot-corpus/dev/<Course>/<image> --through G1
node scripts/ocr-forensics.mjs      <run>/renders/input/g0.canonical.png <Course>
node scripts/ocr-intruder-probe.mjs <run>/renders/input/g0.canonical.png <outDir> <badgeIdx>...
node scripts/ocr-counterfactual.mjs <run>/renders/input/g0.canonical.png <Course>
```

Those three scripts are read-only probes over `packages/alg/dist`. They
import the real detector code; nothing is re-implemented except
`labelCandidates`, copied verbatim from `measure.ts:164-181` so the emitted
label can be attributed line by line.

---

## The one-line root cause

**`extractBadgeGlyph`'s frame-exclusion clause is a silent no-op for every
`dark-plate-recovery` badge, so the badge's own plate outline is fed to the
digit segmenter as if it were a glyph.**

`badgeGlyph.ts:55` builds the glyph mask as "bright pixels in the interior
that are not part of the badge frame component":

```ts
if (brightMask.data[i] && brightLabels[i] !== badge.label) {
```

That test excludes the frame only when `badge.label` is a real
**bright**-component label. `recoverDarkPlateBadges`
(`badgeStage.ts:157`) synthesizes badges from **dark** plate components and
stamps them with a sentinel:

```ts
badges.push({
    label: -1,
    ...
});
badgeSources.push('dark-plate-recovery');
```

No pixel in `brightLabels` is ever `-1`, so `brightLabels[i] !== -1` is
**true for every bright pixel in the interior**. The plate's bright rounded
-rect outline is therefore included in the glyph mask, and the digit
pipeline is asked to read it as a digit.

Measured, AlexClark badge-10 vs the healthy control badge-9:

| | badge-9 (bright-family) | badge-10 (dark-plate-recovery) |
|---|---|---|
| `component.label` | `141` | **`-1`** |
| plate area | 445 | **1306** |
| interior inset from plate bbox | 3px left / 3px top | **0px / 4px** |
| components feeding glyph mask | `143` 7x21 (digit `1`), `144` 14x21 (digit `7`) | `217` **57x40 spanning the whole interior**, `223` 7x21, `224` 14x21 |

Component `217` is the plate outline. It is not a digit and never was.

---

## The seven whys

1. **Why does badge-10 emit "1868"?** Because `readBadges.ts:96` joins four
   per-digit predictions: `label: digits.map((d) => d.predicted).join('')`.
   There is no cap on how many digits may be joined.
2. **Why are there four digits?** Segmentation returned four candidates: the
   two real digits (`1`@0.9927, `8`@0.9811) plus two fragments of the plate
   outline.
3. **Why is the outline in the segmenter's input at all?** The frame-
   exclusion no-op above (`badgeGlyph.ts:55` vs `badgeStage.ts:157`).
4. **Why does the outline survive `segmentDigits`' noise filters?** It fails
   neither. Its area (437px in-interior) is far above `minComponentArea` 6,
   and the height filter is *relative to the tallest surviving component* —
   which is the outline itself (`segment.ts:227-229`). It cannot be filtered
   by a rule it defines.
5. **Why does it become two candidates instead of one?** `segment.ts:254`,
   `isWide = c.bboxW > 0.95 * c.bboxH`. The outline is 57x40, so it is
   "wider than tall" and is treated as two touching digits, then
   valley-split at its own hollow centre (`col=17, colSum=3`) into a 17x40
   and a 40x40 fragment.
6. **Why doesn't the classifier reject those fragments?** It cannot — it is a
   10-class softmax with no reject class. Both fragments score essentially at
   chance (top-3 `8:0.2306 2:0.1850 6:0.1800` and `6:0.1794 9:0.1517
   1:0.1002`; chance is 0.1). The model is behaving correctly; it was handed
   something that is not a digit and must still name a digit.
7. **Why does a 4-digit read escape the 1-18 hole-label cap?** This is the
   defect the owner flagged. `measure.ts:250`:

   ```ts
   label: candidates[0] ? String(candidates[0].label) : entry.reading.label || null,
   ```

   `labelCandidates` (`measure.ts:164-181`) filters 1-18 down to labels whose
   **string length equals the digit count**:

   ```ts
   .filter((label) => String(label).length === reading.digits.length)
   ```

   With 4 digits, no label in 1-18 has length 4, so `candidates` is **empty**,
   the ternary falls through to `entry.reading.label`, and the raw
   uncapped `"1868"` is emitted. **The 1-18 vocabulary is enforced only when
   the digit count is already 1 or 2 — exactly the case that never needed
   enforcing.** Whenever segmentation is wrong, the cap turns itself off.

---

## Two distinct failure modes

Both originate at why-3; they diverge at why-4.

### Mode A — cap bypass (out-of-vocab label escapes)

Plate outline is ~40px tall vs 21px digits, and the real digits *survive*
alongside it. Digit count becomes 3 or 4, `labelCandidates` returns empty,
and the raw concatenation is emitted verbatim.

Produces: `"1868"`, `"295"`, `"787"`. Loud — the label is obviously not a
hole number, and confidence is 0.003-0.028.

### Mode B — silent in-vocab corruption (the dangerous one)

On HeritagePark the plate outline is **43px** tall and the digits are 21px.
`heightThresh = 0.5 * 43 = 21.5`, so:

```
note: dropped label=2 height=21 < 21.50 (0.5 x tallest=43)
note: dropped label=3 height=21 < 21.50 (0.5 x tallest=43)
```

**The real digits are discarded as noise and only the outline's two
valley-split halves survive.** Digit count is exactly 2, so the 1-18 filter
*does* apply — and picks the argmax over pure noise. The result is a
well-formed, in-vocabulary, entirely fabricated hole number.

The height filter's comment (`segment.ts:20-25`) reasons that "a sub-half-
height blob is not a digit". That is sound when the intruder is *smaller*
than the digits. When the intruder is twice their height the rule inverts and
drops the signal to keep the noise.

Receipts (HeritagePark):

| badge | raw read | conf | emitted | note |
|---|---|---|---|---|
| badge-7 | `62` | 0.0262 | **`12`** | both real digits dropped as noise |
| badge-9 | `62` | 0.0250 | **`12`** | collides with badge-7 |
| badge-12 | `17` | 0.0044 | **`17`** | collides with badge-17's genuine `17`@0.9927 |
| badge-14 | `03` | 0.0756 | **`13`** | raw read contains a leading `0`; there is no hole 0 |

`badge-14`'s raw `"03"` is the proof that no vocabulary discipline exists in
the assembly step: an impossible string is produced, then silently laundered
into a plausible one.

---

## Per-failing-badge forensic table

`true label` is the counterfactual read (below), independently corroborated
by set-completion: for each course the corrupted badges' recovered labels are
*exactly* the labels absent from the confidently-read badges.

| course | badge | plate bbox | plate area | source | intruder comp (in-interior bbox) | current read @ conf | true label @ conf |
|---|---|---|---|---|---|---|---|
| AlexClark | badge-10 | `[519,1087,57,44]` | 1306 | dark-plate-recovery | `217` 57x40 | `"1868"` @ 0.0278 | **18** @ 0.9811 |
| AlexClark | badge-16 | `[593,1873,56,44]` | 1459 | dark-plate-recovery | `314` 52x40 | `"295"` @ 0.0029 | **5** @ 0.9892 |
| NorthPark | badge-2 | `[831,694,56,44]` | 1532 | dark-plate-recovery | `223` 55x40 | `"787"` @ 0.0015 | **7** @ 0.9936 |
| HeritagePark | badge-7 | `[762,1202,56,44]` | 1365 | dark-plate-recovery | `1171` 55x43 | `"12"` @ 0.0262 | **12** @ 0.9926 |
| HeritagePark | badge-9 | `[806,1400,56,44]` | 1358 | dark-plate-recovery | `1254` 53x43 | `"12"` @ 0.0250 | **13** @ 0.9891 |
| HeritagePark | badge-12 | `[1171,1518,56,44]` | 1343 | dark-plate-recovery | `1284` 51x43 | `"17"` @ 0.0044 | **15** @ 0.9899 |
| HeritagePark | badge-14 | `[416,1533,56,44]` | 1475 | dark-plate-recovery | `1299` 54x43 | `"13"` @ 0.0756 | **2** @ 0.9926 |

Set-completion corroboration:

- AlexClark confident badges cover `1,2,3,4,6,7,8,9,10,11,12,13,14,15,16,17`;
  absent `5,18` — recovered exactly.
- NorthPark absent `7` — recovered exactly.
- HeritagePark confident badges cover
  `1,3,4,5,6,7,8,9,10,11,14,16,17,18`; absent `2,12,13,15` — recovered
  exactly, and the two collisions dissolve.

Visual receipts (6x, magenta = pixels handed to `segmentDigits`, green =
other bright): `artifacts/ocr-forensics/<Course>/badge-<n>.crop6x.png`.
`HeritagePark/badge-7.crop6x.png` shows a badge that plainly reads **12**
with the plate outline tinted magenta alongside the digits.

---

## Counterfactual — the root cause proved by repair

`scripts/ocr-counterfactual.mjs` changes exactly one thing: inside the glyph
mask it drops any component whose bbox spans >=85% of the interior in both
axes (that is the plate frame; a digit never spans the interior). Everything
downstream is untouched.

HeritagePark:

```
badge- 7 | dark-plate-recovery | "62"@0.0262 | "12"@0.9926   <<< CHANGED
badge- 9 | dark-plate-recovery | "62"@0.0250 | "13"@0.9891   <<< CHANGED
badge-12 | dark-plate-recovery | "17"@0.0044 | "15"@0.9899   <<< CHANGED
badge-14 | dark-plate-recovery | "03"@0.0756 | "2"@0.9926    <<< CHANGED
```

AlexClark `"1868"->18`@0.9811, `"295"->5`@0.9892. NorthPark `"787"->7`@0.9936.

**Every** bright-family badge on all three courses is byte-identical before
and after. 7 of 7 failures repaired; 47 of 47 healthy reads unchanged;
resulting label sets are complete 1-18 and collision-free on all three
courses.

The 85%-span rule is a *probe*, not the prescribed fix — see the contract.

---

## WTF HAPPENED: old `badgeGlyphClassifier.ts` vs new `digits/`

The rebuild swapped a **whole-label template matcher** for a **per-digit
classifier with free-form concatenation**, and in doing so dropped three
safety properties the old design got structurally for free.

### 1. Vocabulary was structural; now it is an afterthought

Old: `badgeGlyphClassifier.ts:355-357` ranks the candidate glyph against the
18 rasterized templates `hole-01.png`..`hole-18.png`
(`badgeGlyphClassifier.ts:87-96` enforces the filename contract;
`:127-164` loads the pack). The output label is *drawn from the template
set*. Emitting `"1868"` or `"03"` was not a bug you had to prevent — it was
unrepresentable.

New: `readBadges.ts:96` concatenates whatever digits segmentation produced.
The vocabulary constraint was moved downstream into `measure.ts:164-181`,
where it is conditioned on digit count and then bypassed entirely by the
`||` fallback at `measure.ts:250`. A structural guarantee became a
conditional one, and the condition fails in exactly the failing case.

### 2. Abstention was first-class; now nothing can abstain

Old: `badgeGlyphClassifier.ts:31-35` declares
`BadgeGlyphAbstention = 'empty-glyph' | 'low-score' | 'ambiguous' |
'opencv-unlabeled'`, with thresholds `minScore: 0.58` and
`minMargin: 0.045` (`:58-65`) and the decision at `:363-364`:

```ts
const abstention: BadgeGlyphAbstention | null =
  !winner ? 'empty-glyph' : bestScore < p.minScore ? 'low-score'
  : ambiguityMargin < p.minMargin ? 'ambiguous' : null;
```

`label` is set **only** when `abstention === null` (`:368`), while
`bestLabel` is always retained (`:369`) so a receipt can print what it
*would* have said. `old-stuff/tests/unit/badgeGlyphClassifier.test.ts:125-133`
locks the empty-glyph abstention in place.

New: there is no reject path anywhere. `readBadge` always emits a label;
`makeBadges` always emits a `BadgeEvidence.label`. Every failing badge in the
table above scored 0.0015-0.0756 — an order of magnitude below the old
`minMargin` of 0.045 in most cases, and all far below `minScore` 0.58. **The
old classifier would have abstained on all seven.** The information needed to
reject was computed and then discarded.

### 3. Collision detection existed; now nothing checks uniqueness

Old, `badgeGlyphClassifier.ts:420-426`:

```ts
export function badgeGlyphBatchIsComplete(
  classifications: readonly BadgeGlyphClassification[]
): boolean {
  if (classifications.length === 0) return false;
  const labels = classifications.flatMap((c) => c.label === undefined ? [] : [c.label]);
  return labels.length === classifications.length && new Set(labels).size === labels.length;
}
```

Every badge labelled **and all labels distinct**. `sourceBadgeIdentity.ts:87`
uses it as the escalation gate: if the cheap pure-TS pass cannot prove a
unique label set, it escalates the same ROIs to the OpenCV scorer
(`:96-102`) rather than shipping a duplicate.

New: nothing. HeritagePark ships two badges labelled `12` and two labelled
`17` with no warning anywhere in the receipt. This is precisely the check
whose absence the owner noticed.

### What the new design does better (keep these)

- Per-digit training generalizes beyond 18 labels; the template pack is
  capped at whatever `hole-NN.png` files ship. The 1-18 cap in
  `measure.ts:166` is a *separate* known minesweeper HIGH item and the new
  architecture is the right substrate for lifting it.
- `readBadges.ts:32-40` retains full per-digit evidence (bbox, normalized
  raster, all 10 scores, margin) — richer receipt material than the old
  `bestScore/runnerUpScore` pair.
- `labelCandidates` produces a ranked posterior over labels, not just a
  winner; that is strictly more useful than the old single label + margin,
  *if* something ever consumes the ranking honestly.

### The honest summary

Nothing was lost in the port for lack of skill; the *substrate* changed from
"choose one of 18 templates, or abstain" to "read digits, concatenate", and
the three guarantees that the first substrate provided for free were never
re-established as explicit code in the second. The old file's last three
public functions — abstention, `bestLabel`, `badgeGlyphBatchIsComplete` —
are a checklist of what the new pipeline still owes.

---

## FIX CONTRACT

Binding on the builders. Detector source is theirs; this is what the fixed
reader must guarantee.

### C1 — The glyph mask must contain glyphs only

`extractBadgeGlyph` must exclude the badge's own plate frame for **every**
badge source, not only `bright-family`. The `-1` sentinel comparison against
`brightLabels` is a silent no-op and must not survive; a `dark-plate-recovery`
badge must carry an explicit way to identify its own frame pixels (its
`plateBbox` is already threaded through `badgeStage`/`measure`, and
`badgeSources[i]` already distinguishes the case).

The fix must be *positive identification of the frame*, not a size heuristic
that happens to work. If a component-spanning rule is used it must be
justified against the plate geometry the recovery step already measured, and
carry its provenance in the receipt.

Acceptance: on AlexClark, NorthPark, HeritagePark the glyph mask for every
`dark-plate-recovery` badge contains exactly the digit components (7x21 for
`1`, 14-16x21 otherwise) and nothing else.

### C2 — A hole label is 1 or 2 digits, always

Multi-digit assembly must **reject** any read that assembles to more than 2
digits. It must never emit it. `"1868"` is not a label to be passed on with
low confidence; it is evidence that segmentation failed, and the badge must
be reported UNREAD with the raw string preserved for the receipt.

A read whose first digit is `0` is likewise invalid and must be rejected, not
normalized (`"03"` must never become `13`).

### C3 — The vocabulary cap must not be conditional

`measure.ts:250`'s `|| entry.reading.label` fallback must go. When
`labelCandidates` yields nothing, the correct emission is `null` (UNREAD) —
never the uncapped raw string. The 1-18 cap must be enforced on **every**
path, including the paths it currently silently skips. (Widening 1-18 to a
course-derived vocabulary remains a separate minesweeper item; do not
conflate. Whatever the vocabulary is, the cap must be unconditional.)

### C4 — Confidence floors, restoring old-stuff's abstention

Adopt explicit floors with named abstention reasons, in the spirit of
`badgeGlyphClassifier.ts:363-364`. A read below the floor emits `label: null`
plus a machine-readable reason (`empty-glyph`, `low-score`, `ambiguous`,
`too-many-digits`, `leading-zero`, `collision`), while retaining the
would-be label as `bestLabel` so the receipt can show it.

The seven failures span 0.0015-0.0756 and the 47 healthy reads span
0.978-0.994. The separation is three orders of magnitude and any floor in
between catches all seven with zero false rejections — but the floor must be
**derived and its provenance printed**, not a literal dropped in (footgun
law). Derive it from the run's own margin distribution.

`confidence` must also stop being overloaded: `measure.ts:237-240` silently
substitutes `darkFraction(...)` — a geometric fill ratio — when there are no
digits. A fill fraction and a classifier margin are not the same quantity and
must not share a field.

### C5 — Collisions are receipt-visible, never silent

Restore `badgeGlyphBatchIsComplete`'s property (`badgeGlyphClassifier.ts:
420-426`): after reading all badges, the emitted in-vocabulary labels must be
**distinct**. Any duplicate is a conflict that appears in the receipt as a
CONFLICT verdict on every badge involved. Resolution may keep the higher-
confidence claimant and mark the other UNREAD, but silently shipping two
badges labelled `12` is forbidden.

Completeness (all 18 present) is a *report*, not an assertion — do not
back-fill a missing label by elimination. Set-completion is how this
investigation corroborated its answer; it must never become how the detector
picks one.

### C6 — No silent drops

Every badge appears in the receipt exactly once, whether read, abstained, or
in conflict. `segmentDigits`' existing `notes` must reach the receipt for any
badge that is not cleanly read — they are already computed
(`segment.ts:171-211`) and currently discarded before anything human-readable
sees them.

---

## RECEIPT FORMAT

One line per badge, stable column order, sorted by `detId`. A human accepts
or rejects the whole G1 digit stage on sight.

```
G1 DIGIT READS (per-badge, provenance: BadgeEvidence.label from
digits/readBadges.ts; UNREAD is a fact, never a guess)
badgeId | plate bbox | src | digits | read | conf | runner-up | verdict

badge-00 | [ 549, 765, 54,42] | bright | 2 | 17 | 0.993 | 12@0.002 | OK
badge-07 | [ 762,1202, 56,44] | plate  | 2 | 12 | 0.993 | 16@0.003 | OK
badge-09 | [ 806,1400, 56,44] | plate  | 2 | 13 | 0.989 | 18@0.004 | OK
badge-10 | [ 519,1087, 57,44] | plate  | 4 | -- | 0.028 | --       | UNREAD too-many-digits raw="1868"
badge-12 | [1171,1518, 56,44] | plate  | 2 | -- | 0.004 | 12@0.193 | UNREAD low-score (floor 0.42, derived p50/8 of this run's margins)
badge-16 | [ 593,1873, 56,44] | plate  | 3 | -- | 0.003 | --       | UNREAD too-many-digits raw="295"
badge-17 | [ 466,1980, 54,42] | bright | 1 |  4 | 0.994 |  1@0.002 | OK

summary: 18 badges | 18 read | 0 UNREAD | 0 CONFLICT
labels: 1-18 complete, all distinct
floor: 0.42 (derived: this run's per-badge margin p50 0.989 / 8; provenance printed per C4)
```

Rules:

- `src` is `bright` or `plate` (`badgeSources[i]`) — the failing population
  is entirely `plate`, so this column is load-bearing, not decoration.
- `digits` is the segmented candidate count *before* any rejection. A count
  of 3+ is visible even though the read is UNREAD.
- `read` is `--` whenever the verdict is not OK. Never print a label the
  detector is not standing behind.
- `conf` is always printed, including for UNREAD rows — the reader must be
  able to see *how* far below the floor it landed.
- `verdict` is `OK`, `UNREAD <reason>`, or `CONFLICT with <badgeId>`; the
  reason vocabulary is C4's. `raw="..."` is appended whenever a rejected
  string exists, so no evidence is destroyed.
- The `summary` and `labels` lines make completeness and collisions visible
  without reading 18 rows.
- On any non-OK row, the corresponding `segmentDigits` notes follow indented
  beneath it (C6).

A reviewer should be able to answer, from this block alone: did every badge
get read, did anything get guessed, and is any hole number claimed twice.

---

## Ownership

- C1 is a `badgeGlyph.ts` / `badgeStage.ts` change (glyph-mask correctness).
- C2, C4 are `readBadges.ts` (assembly + abstention).
- C3, C5, C6 and the receipt block are `measure.ts` plus the receipt renderer.

C1 alone repairs all 7 observed failures (counterfactual above). C2-C6 are
what keep the *next* segmentation failure from silently corrupting hole
identity instead of loudly failing. Both halves are in scope: the owner's
complaint is not only that these badges read wrong, it is that they read
wrong **silently**.
