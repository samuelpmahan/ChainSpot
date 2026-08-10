# The 13-inch first-class pass

*Usability audit, August 2026, at commit `91c3589`. Method: the real app (`npm run dev`)
driven by Playwright/Chromium at the three certification viewports, using the real
Bill Allen demo dataset (`static/resources/demo/bill-allen/`) through the real intake
paths — smart import, the stitch → annotate handoff, real course detection, the demo
walkthrough. Every number below is a measured `getBoundingClientRect` /
`scrollWidth` value from a live session, not a reading of the CSS.*

**Certification viewports**

| Name | Size | Bar |
|---|---|---|
| 1280×715 | 13″ MacBook minus browser chrome | must work |
| 1440×815 | comfortable demo size | must be comfortable |
| 1152×650 | 1440 at 125% zoom | graceful degradation |

**The budget** (from the owner's brief): 1) zero horizontal page scroll; 2) canvas ≥55%
of viewport width and ≥65% of height during core interactions; 3) no mid-task scroll
traps; 4) targets ≥36px, text ≥13px, dialogs contained; 5) demo rail must not occlude
critical controls at 1280; 6) CV status strip and review chip visible with the
candidates they describe.

---

## Headline verdict

**13″ is functional but not yet first-class: 11 of 22 audited screens PASS clean at
1280×715 (50%), 7 are ANNOYING, 4 are FAILING.** The good news is structural: there is
**zero horizontal overflow anywhere, in any state, at any of the three viewports**
(budget 1 passes outright), the on-canvas CV showcase (status strip → staged reveal →
review chip) is genuinely built for small screens and passes budget 6, the new radial
menu and on-canvas zoom controls pass every target-size check, and dialogs are
contained. The failures are concentrated in four fixable places: the annotate canvas
is under the width budget with the rail expanded, the hole bar / Done button scroll
away during the single most common interaction in the product, the collapsed
diagnostics rail's re-expand button is clipped off-screen (a real bug, at every width
≥1181px), and CV candidate click-targets are ~9px.

---

## Scorecard — 1280×715 (must work)

Ranked roughly by how often the screen is touched in a real editing session
(annotation is where hours go; stitch is minutes per course; demo is prospect-only).

| # | Journey · step | Grade | Key numbers |
|---|---|---|---|
| 1 | Annotate · working canvas, rail **expanded** (default) | **FAILING** | canvas 638px = **49.8%** of width (budget ≥55%) |
| 2 | Annotate · working canvas, rail **collapsed** | PASS | canvas 914px = **71.4%** of width; height 640px = 89.5% |
| 3 | Annotate · hole-bar / Done reachability mid-task | **FAILING** | with canvas in view (scrollY 310) hole bar bottom = **−7px**, Done = **−200px**; after a hole is selected the pane grows to 842px tall and the gap is 310–521px of scrolling per hole switch |
| 4 | Annotate · CV click-to-assign targets | **FAILING** | tee/basket candidate markers ≈ **9×9.5px** at fit zoom (budget ≥36px); number badges 53×26px; confirm-chip cancel 26×26px |
| 5 | Annotate · collapsed-rail re-expand toggle | **FAILING** | toggle at x=1339 on a 1280px viewport — **off-screen and pointer-unreachable** (hit-test at its position returns `MAIN`); same at 1440 (x=1499) |
| 6 | Annotate · CV status strip during detection | PASS | strip on-canvas at (317,87), 158×33, visible with the map — but 12.5px text (budget ≥13px) |
| 7 | Annotate · CV review summary chip | PASS | chip 352×136 fully on-canvas; action buttons 36px tall — but 12px button text and **no dismiss control** (occludes canvas top-left indefinitely) |
| 8 | Annotate · radial menu (HTML popover) | PASS | all actions 44×44, contained in pane, Escape closes |
| 9 | Annotate · corridor width / undo controls | PASS | visible in tools column at the same scroll as the canvas |
| 10 | Annotate · handoff import banner | PASS* | banner + Import visible without scroll; *Import button is 143×**21px** (budget ≥36px) |
| 11 | Stitch · initial import screen | PASS | import affordance in first screen |
| 12 | Stitch · smart-import result review | ANNOYING | assignment + confidence + crop proposal all in the first screen — but the proposal says "inspect before applying" while the crop preview is 250px **below the fold** |
| 13 | Stitch · crop adjust | **FAILING**→ANNOYING | crop canvas 882×**280px** = 39.2% of height (budget ≥65%); fields are beside it, so no trap — graded ANNOYING only because zoom+keyboard make it operable |
| 14 | Stitch · alignment adjust | ANNOYING | workspace 1100×442 = 61.8% height (just under 65%); tile controls + Snap + readiness co-visible (good); Use-as-source 13px below the fold at that scroll |
| 15 | Stitch · handoff buttons | PASS | a scroll position exists showing workspace + readiness + all three actions |
| 16 | Graphics · correspondence placement | ANNOYING | pane area 1246px = 97.3% width (pass) but panes are **420px = 58.7%** of height (budget ≥65%); Add correspondence + guidance + both panes co-visible (good) |
| 17 | Graphics · NAIP fetch UI | PASS | search, radius, manual coordinates, fetch all in one screen (network egress blocked in the audit sandbox; UI exercised up to the fetch) |
| 18 | Graphics · alignment estimate | ANNOYING | estimate panel at y=1254 (scrollY 0); reading residuals puts both panes ~700px off-screen — adjusting a pair after reading is a ~900px round trip |
| 19 | Graphics · hole-graphic export | PASS | style select + Download-all + preview 1 co-visible; per-hole download at the fold edge |
| 20 | Graphics · discard dialog | PASS | 458×154 at (411,281) — fully contained |
| 21 | Demo · rail over stitch (steps 1) | ANNOYING | rail 386×514 fixed bottom-right; occludes right ~28% of the alignment workspace and part of the crop preview when scrolled; **no buttons occluded**; rail is collapsible |
| 22 | Demo · rail over annotate (step 2) | ANNOYING | rail covers the on-canvas **zoom-out (partially) and Fit (fully)** buttons (cluster ends at x=935; rail starts at x=878); zoom-in stays visible; keyboard `0`/`+`/`-` still work; rail is collapsible |

**PASS 11 · ANNOYING 7 · FAILING 4** (rows 4 and 13 each straddle a boundary; counted
as FAILING and ANNOYING respectively).

### 1440×815 (must be comfortable)

Mostly the same shape, two differences worth knowing:

- Annotate canvas with rail expanded is 798px = **55.4%** — passes the width budget by
  4px. Collapsed: 1074px = 74.6%.
- The create-graphics panes are still fixed at 420px, which is now **51.5%** of the
  taller viewport — the "comfortable" size is *relatively worse* here. Same for the
  stitch crop preview (280px = 34.4%) and alignment workspace (442px = 54.2%).
- The collapsed-rail toggle is equally unreachable (x=1499 on a 1440 viewport).
- The stitch alignment step is genuinely comfortable: workspace + all tile controls +
  readiness + export/handoff buttons fit in one 815px screen with no scrolling.

### 1152×650 (stress)

- No horizontal overflow, nothing breaks. Canvas sizes degrade gracefully
  (annotate canvas 1126px = 97.7% wide / 640px = 98.5% tall — the ≤1180px
  single-column layout is excellent *for viewing*).
- The trap gets worse: single-column puts the 405px tools stack **between** the hole
  bar and the canvas, so with the canvas in view the hole bar is at −654px and Detect
  at −297px. Only the on-canvas zoom/fit cluster remains reachable. Acceptable as
  "graceful degradation" only because of those on-canvas controls.

---

## The FAILING items, with root causes and minimal fixes

### F1 — Annotate canvas is 49.8% wide at 1280 (rail expanded, the default)

- **Evidence:** canvas 638/1280 = 49.8% (budget ≥55%). Chrome: tools column 288px
  (18rem) + diagnostics rail 320px (20rem) + borders = 642px of non-canvas width.
- **Root cause:** `src/lib/components/ImageEditorPane.svelte:346` —
  `.editor-body.with-tools { grid-template-columns: 18rem minmax(0, 1fr) 20rem; }`.
- **Minimal fix:** either make the collapsed rail the default at ≤1280 (see the
  recommendation below — this alone takes the canvas to 71.4%) or narrow the columns
  at ≤1366 (`minmax(13rem, 16rem)` / `minmax(0,1fr)` / `17rem` gets the canvas to
  ~53–56%). The first is one line of state; the second is one media query.

### F2 — Hole bar and Done scroll away during annotation (the most-touched trap)

- **Evidence:** page is 1042–1245px tall at 1280×715; the canvas needs scrollY
  310–385 to be in view, which puts the hole bar (176px tall, ends at y=303) and the
  Done button entirely above the viewport. Every hole switch is a 300–520px scroll
  round trip; on an 18-hole course that is ~36 scrolls minimum. After selecting a
  hole, the tools column grows and stretches the canvas to 842px (taller than the
  viewport), widening the gap.
- **Root cause (two parts):**
  - `src/routes/annotate-round/+page.svelte:2811` — `.hole-bar` is in normal flow
    (176px: compact row + 18-button grid + add row), not sticky; the page header
    (Done) likewise.
  - `src/lib/components/ImageEditorPane.svelte:339-346` — the canvas cell stretches
    to the tools column's height (`min-height: 640px` at `:342`/`:367`, no max), so a
    tall tools column makes the canvas exceed the viewport.
- **Minimal fix:** make the compact hole-bar row (`.hole-bar-compact`, already built —
  `annotate-round/+page.svelte:1627-1645`) `position: sticky; top: 0` and let only the
  18-button grid scroll away; cap the canvas cell at `max-height:
  calc(100vh - <sticky bar height>)` and give `.tools` its own `overflow-y: auto`.
  The ‹/› cycle buttons in the compact row already switch holes, so a sticky compact
  row alone kills most of the trap.

### F3 — Collapsed diagnostics rail cannot be re-expanded by pointer (real bug)

- **Evidence:** collapsed, the rail is a 44px column at x=1226–1270; the toggle
  measures x=1339–1369 — beyond the 1280px viewport. `document.elementFromPoint` at
  the toggle's location returns `MAIN`. The rail's `scrollWidth` is 143 vs
  `clientWidth` 44. Keyboard focus can still reach it (browsers scroll hidden
  overflow on focus), and Playwright's auto-scroll is why
  `tests/e2e/annotateRound.spec.ts` passes — a human with a mouse cannot click it at
  any window width ≥1181px.
- **Root cause:** `src/routes/annotate-round/+page.svelte:3433-3438` — the collapsed
  override shrinks `.diagnostics` to `2.75rem` with `overflow: hidden`, but the
  header row inside it still lays out `<h2>Diagnostics</h2>` (~110px) *before* the
  30px toggle (`:1980-1996`), pushing the toggle past the clip.
- **Minimal fix:** in the collapsed state, hide the `h2` (or reorder toggle first /
  `position: absolute; right` the toggle within the 44px column). Pure CSS, ~3 lines.

### F4 — CV candidate click-targets are ~9px

- **Evidence:** at fit zoom on the stitched course (2094×2336 image in a 638–798px
  pane), tee/basket candidate markers measure **8.9×9.5px**; the budget is 36px. The
  click-to-assign flow (a deliberate showcase feature) requires hitting them.
  Number badges are 53×26px. The replace/move confirm chip is well-anchored and
  contained, but its cancel button is 26×26 and its text 12px.
- **Root cause:** the SVG candidate markers are drawn — and hit-tested — at *image*
  scale (`src/routes/annotate-round/+page.svelte:2212` region, `tee-candidate-*` /
  `basket-candidate-*` markers), so their on-screen size shrinks with fit zoom.
  Note the *canvas-click* path already solves this class of problem: the pane's
  click-to-assign hit-test in `+page.svelte:~690-717` (`consider(...)` radii) uses
  generous image-space radii. The markers' own DOM hit areas do not.
- **Minimal fix:** give each candidate marker an invisible hit circle with a
  *screen-space* minimum (e.g. `r = max(markerR, 18 / zoom)` in image units), and
  bump the confirm-chip cancel to 36px / text to 13px. No detection code changes.

---

## The rail-default question — measured recommendation

> Should the diagnostics rail default to **collapsed** at ≤1280 wide?

**Yes — with one precondition and one refinement.**

The numbers: at 1280 the rail costs 276px of canvas — 49.8% wide (fails budget)
expanded vs 71.4% (passes with room) collapsed. At 1440 expanded scrapes by at 55.4%.
The rail's steady-state content (worker status, candidate list) is only *needed*
during CV review; the new on-canvas strip and summary chip now carry the
detection-progress story on the map itself, which is where the eyes are.

- **Precondition:** fix F3 first. Defaulting users into a state whose exit control is
  pointer-unreachable would convert a sizing annoyance into a lockout.
- **Refinement:** auto-expand the rail when a detection result lands (the candidate
  list and "Apply to Hole" fallback live there), and respect any explicit
  user choice stored in `chainspot.diagnosticsRail` over the width-based default.
  A stored preference should win; only the *unset* default should be width-aware.
- 1152–1180 needs nothing: the single-column layout already stacks the rail away.

---

## ANNOYING items worth fixing opportunistically

| Item | Evidence | Root cause | Minimal fix |
|---|---|---|---|
| Stitch crop preview 280px tall | 39.2% of 715px height while hand-adjusting a crop the product itself flagged low-confidence | `stitch-map/+page.svelte:1867-1875` `.crop-preview { height: 280px }` | `height: clamp(280px, 55vh, 560px)` |
| Stitch alignment workspace 442px | 61.8% at 1280; 54.2% at 1440 | `stitch-map/+page.svelte:1947-1952` `height: 440px` | `height: clamp(440px, 62vh, 640px)` |
| Create-graphics panes 420px | 58.7% at 1280, **51.5%** at 1440 | `src/lib/components/ImagePane.svelte:692-698` `.scene { height: 420px }` | `height: clamp(420px, 60vh, 640px)`; the `@media (max-width: 900px)` rule at `:791-795` already uses `min(420px, 58vh)` — extend the idea upward |
| Crop proposal asks "inspect before applying" with the preview below the fold | proposal at y=425–524, preview at y=776–1056 | proposal renders in the smart-import section, preview in the crop section (`stitch-map/+page.svelte:1395-1419` vs `1439-1450`) | move the proposal actions adjacent to the crop preview, or scroll the preview into view when a proposal appears |
| Alignment estimate far from the panes | panel at y=1254; panes off-screen while reading residuals | page order in `create-graphics/+page.svelte` (§ layout) | surface the one-line summary (`alignment-summary`) as a status chip near the pane header |
| Review chip is not dismissible | occupies 352×136 of canvas top-left until a new detection or image replace clears `courseDetection` (`annotate-round/+page.svelte:2292-2323`, cleared only at `:1097`/`:1241`) | no dismiss affordance | add an ✕ that hides the chip (candidates stay) |
| Sub-13px text in the CV surfaces | strip 12.5px, chip buttons 12px, controls-progress 11.5px, per-hole download 12.8px | `.course-detection-strip` (`:3242`), `.course-summary-chip` buttons | bump to 0.8125rem+ |
| Handoff Import button 143×21px | `annotate-round/+page.svelte:1554` banner buttons | link-styled buttons | min-height 36px |
| Demo rail covers the Fit/zoom-out on-canvas buttons at 1280 | rail x≥878; cluster ends x=935 (annotate); also overlays right ~28% of stitch alignment workspace | `DemoGuide.svelte:193-208` fixed `right: 1rem; bottom: 1rem`, width 24rem | at ≤1280, either offset the rail above the pane bottom (`bottom: ~5rem`) or start it collapsed; the cluster is the only *control* it occludes |

**What is genuinely good and should be protected** (the budget suite pins these):
zero horizontal overflow everywhere; the on-canvas CV strip/chip pattern; the radial
menu (44px targets, pane-clamped popover); the on-canvas zoom cluster (36px, exempt
from pan-gesture stealing); correspondence placement fitting on one screen; contained
dialogs; the stitch alignment step at 1440.

---

## What the budget suite enforces vs. documents

`tests/e2e/viewportBudget.spec.ts` runs at exactly 1280×715 and **enforces now**:

- `documentElement.scrollWidth === clientWidth` on all five routes, including with
  images loaded and pairs placed (budget 1, all states audited).
- Annotate canvas ≥55% width with the rail collapsed; ≥89% canvas height (size).
- Create-graphics combined pane area ≥55% width.
- On-canvas zoom cluster: present, ≥36px targets, inside the viewport when the canvas
  is scrolled into view (the mid-task controls that *do* work).
- Radial menu: opens on canvas click, all actions ≥36px, fully inside the viewport.
- Discard dialog fully contained.
- Handoff/working state reachable end-to-end without horizontal overflow.

**Documented as `test.fixme()`** (target state; would be red today — each cites this
file): annotate canvas ≥55% width with the rail *expanded*; rail-collapsed toggle
inside the viewport (F3); hole bar visible while the canvas is in view (F2);
create-graphics pane height ≥65%; stitch crop preview ≥65% height.

CV-showcase visibility (budget 6) is measured PASS in this audit but not asserted in
the suite: driving real detection costs 60–120s of WASM+CV per run, and
`tests/unit/annotateRoundCvUx.test.ts` already pins the strip/chip *logic* with
mocked detection. The geometry that makes it pass — strip and chip render inside the
pane's popover layer, anchored to the canvas — is pinned indirectly by the
canvas-visibility assertions.

---

## Fix tickets (parallel-safe agent briefs)

Each brief touches a disjoint file set and can run concurrently. All must finish with
`npm run check`, `npm run test:unit`, and `PW_CHROMIUM_PATH=/opt/pw-browsers/chromium
npm run test:e2e` green, and must flip the corresponding `test.fixme()` assertions in
`tests/e2e/viewportBudget.spec.ts` to live assertions.

### Ticket A — Viewport-relative canvas heights (stitch + graphics panes)

**Files:** `src/routes/stitch-map/+page.svelte` (CSS only),
`src/lib/components/ImagePane.svelte` (CSS only).

1. `.crop-preview` (`stitch-map:1867`): `height: 280px` → `height: clamp(280px, 55vh, 560px)`.
2. `.alignment-workspace` (`stitch-map:1947`): `height: 440px` → `height: clamp(440px, 62vh, 640px)`.
3. `ImagePane` `.scene` (`:692`): `height: 420px` → `height: clamp(420px, 60vh, 640px)`;
   fold the existing ≤900px `min(420px, 58vh)` rule (`:791`) into the same expression
   if it simplifies.
4. Acceptance: at 1280×715 each canvas is measurably taller than today (crop
   393px vs 280, panes 429px vs 420 at minimum — tune the vh terms upward toward the
   65% budget where the surrounding controls allow); at 1440×815 every canvas must be
   *taller* than at 1280, never shorter. Un-fixme the crop-height and pane-height
   assertions **only if** the ≥65% bar is actually met; otherwise raise the clamp
   and/or update the fixme comment with the new measured value. No geometry/behavior
   changes — CSS only; existing e2e canvas coordinate tests must stay green.

### Ticket B — Annotate Round: rail default, toggle bug, hole-bar trap, CV target sizes

**Files:** `src/routes/annotate-round/+page.svelte` only.

1. **F3 first:** collapsed rail (`:3429-3438`) must keep its toggle on-screen — hide
   the `h2` when collapsed or absolutely position the toggle inside the 2.75rem
   column. Verify by pointer click (not Playwright auto-scroll): `elementFromPoint`
   at the toggle center must return the button.
2. **Collapsed by default at ≤1280:** `readStoredDiagnosticsRailExpanded()` (`:325-336`)
   — when no stored preference exists, default to collapsed if
   `window.innerWidth <= 1280`; a stored preference always wins. Auto-expand (without
   writing the preference) when a course-detection result lands.
3. **F2:** make `.hole-bar-compact` sticky (`top: 0`, above the pane) so ‹/current/›
   is always available; the full 18-tab grid may scroll away. Done button: include it
   in (or duplicate it into) the sticky row.
4. **F4:** candidate markers (`tee-candidate-*`, `basket-candidate-*`,
   `number-candidate-*`) get invisible hit areas with an effective screen size ≥36px
   (e.g. transparent circle `r = max(current, 18/zoom)` image units). Confirm-chip
   cancel ≥36px; strip/chip/button text ≥13px (0.8125rem). Add an ✕ dismiss to the
   summary chip that nulls only the chip visibility, not `courseDetection`.
5. Flip the corresponding fixmes in `viewportBudget.spec.ts` (rail toggle, hole bar,
   expanded-width if the default change makes "default state" pass). Existing specs
   pinning `aria-expanded` defaults (`tests/e2e/annotateRound.spec.ts:123-143`) run at
   1280×720 — coordinate: that test asserts default-expanded; it will need its
   expectation updated to the new width-aware default (do it in the same PR, it is
   testing the exact behavior this ticket changes).

### Ticket C — ImageEditorPane grid: canvas width share and height cap

**Files:** `src/lib/components/ImageEditorPane.svelte` only.

1. At ≤1366px, narrow the chrome: `.editor-body.with-tools` (`:345-347`)
   `18rem / 20rem` → `minmax(13rem, 16rem) / 17rem` (or similar) so the canvas cell
   is ≥55% of a 1280 viewport even with the rail expanded.
2. Cap the canvas cell height: the `.canvas-shell` `min-height: 640px` (`:367`) plus
   grid stretch lets a tall tools column push the canvas to 842px (> viewport).
   Give `.tools` `overflow-y: auto` with `max-height` tied to the canvas cell, or cap
   `.canvas-shell` at `max-height: calc(100vh - 4rem)` so the canvas never exceeds
   one screen.
3. Do not change the `popover`/`overlay` contract (see
   `docs/imageviewport-event-contract.md` §1.6 addendum) — the radial menu clamps
   itself to `paneSize` and must keep working.
4. Coordinate with Ticket B only through the shared budget spec; no shared files.

### Ticket D — Demo rail vs. on-canvas controls at 1280

**Files:** `src/lib/components/DemoGuide.svelte` only.

1. At viewports ≤1280 wide, keep the rail clear of the pane's bottom-right zoom
   cluster: raise `bottom` (≥5rem), or dock the rail bottom-left, or start it
   collapsed (`demoTour.setCollapsed(true)` initial at ≤1280) — any one is enough.
2. Preserve the four demo rules (no occlusion of the *product's* own flow): verify at
   1280 that the rail overlaps none of: `viewport-zoom-*` buttons, `handoff-import`,
   `apply-suggested-crop`, `use-as-source`, `course-summary-chip`.
3. `tests/e2e/demo.spec.ts` must stay green; add the non-occlusion check to
   `viewportBudget.spec.ts` if stable without CV.

---

## Appendix — audit artifacts

Screenshots and raw measurement JSON per viewport/journey are under the audit
scratchpad (`shots/v1280`, `shots/v1440`, `shots/v1152`, `journey*-*.json`); they are
session artifacts, not committed. The journey scripts drive: smart import of the four
real captures → crop → handoff → annotate (real course detection: "Found 18 holes"
chip, staged reveal, click-to-assign, radial menu, rail both states) →
create-graphics (NAIP UI, 3 correspondence pairs, similarity estimate, per-hole
export) → the `/demo` walkthrough overlay. One product observation outside this
audit's scope, recorded for honesty: on the demo dataset the detection currently
reports **“Found 18 holes — 0 ready, 18 need review”** (0 of 18 number badges
labeled), so the one-click "Accept ready holes" showcase moment never fires on the
dataset the demo ships. Worth a look by whoever owns the CV pipeline.
