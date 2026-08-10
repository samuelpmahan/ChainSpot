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

> **Re-audit note.** Annotate Round has since been split into **Map mode** and **Round
> mode**, and `/demo` is now the two-act "Dash's Track" walkthrough. Rows 1–10 and
> 21–22 of the scorecard below, and Tickets B and C, were **re-measured at commit
> `ca268e7` on 2026-08-10** — see [Re-audit](#re-audit--mapround-split-and-the-two-act-demo-2026-08-10-commit-ca268e7).
> Rows 11–20 (stitch-map, create-graphics) and Tickets A and D were **not** re-measured;
> their numbers below stand as first measured.

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

## Re-audit — Map/Round split and the two-act demo (2026-08-10, commit `ca268e7`)

*Scope: `/annotate-round` (both modes) and `/demo` only. Stitch Map and Create
Graphics were not re-measured; their rows above stand. Method is unchanged from the
original pass — the real app on a dev server, driven by Playwright/Chromium at the
same three viewports, every number a `getBoundingClientRect` from a live session.
Three commits landed since the original pass: the native-resolution crop boundary fix
(`4a33dad`), map/round radial menu action coverage (`66b911b`), and simplified
assigned hole labels (`ca268e7`).*

**What was driven.** (a) `/annotate-round` with a source loaded, in Map and Round mode,
rail expanded and collapsed, empty and with a hole selected; (b) the demo's own act-1
path end to end — four real Dash's Track captures → Smart Import ("Export is ready")
→ "Use as UDisc source" → Annotate Round → a real **"Detect full course"** run (37s
wall clock at 1280, no mocking) for the CV surfaces and candidate targets; (c) the
demo rail on every route it rides, at all three viewports, expanded and collapsed.

**What was not measured, and why.** The NAIP/Nominatim basemap steps (live network,
out of scope for a viewport pass and unchanged from row 17); the `kind: 'reload'` step
(a real `window.location.assign`, deliberately not driven here); and the Round-mode
auto-switch the step-5 narration promises — it is gated on the "Recognized course →
Import saved holes" path, which needs a Course Memory entry written by step 2's Done,
and this run entered step 5 directly. With the played-round capture imported at step
5, the toggle measured `aria-pressed="false"` (Map mode). That is expected for a
direct entry, **not** evidence the narration is wrong; a full 1→6 sequential run was
not performed. Round-mode *geometry* was measured directly on the route instead.

### Annotate Round at 1280×715 — Map mode

| # | Item | Grade | Key numbers (baseline → now) |
|---|---|---|---|
| M1 | Canvas, rail **expanded** (default) | **FAILING** | 638px = **49.8%** (unchanged) |
| M2 | Canvas, rail **collapsed** | PASS | 914px = **71.4%**; 640px tall empty, **793.6px** with a hole selected |
| M3 | Hole bar / Done / mode toggle mid-task | **FAILING, worse** | canvas in view now needs scrollY **457** (was 310): hole bar bottom **−82** (was −7), compact ‹/›/label row **−203**, **mode toggle −274**, Done **−346.8** (was −200) |
| M4 | On-canvas zoom cluster with a hole selected | **FAILING (new)** | canvas cell 793.6px > 715px viewport ⇒ all three buttons at y 744.6–780.6, **entirely below the fold**. With no hole selected they sit at 666–702 and pass |
| M5 | Collapsed-rail re-expand toggle | **FAILING** | x **1339.5–1369.8** on a 1280 viewport; `elementFromPoint` at its centre returns **null** (off-viewport); rail `scrollWidth` 150 vs `clientWidth` 57; toggle itself **30.4×30.4** (budget ≥36) |
| M6 | Radial menu (Map) | PASS | exactly `tee`/`basket`/`bend`, each **44×44**, fully inside the viewport at all three sizes |
| M7 | Existing-marker pointer target | **FAILING (new)** | `MARKER_HIT_RADIUS_PX = 12` in *screen* space — probed empirically: 12px away re-opens the marker menu, 13px away opens the placement menu ⇒ **24×24 effective target**; drawn marker 14×14 |
| M8 | CV candidate targets (real detection) | **FAILING** | 18 tee candidates **2.2×2.8 … 9.3×9.2**, 15 basket candidates **16×16**, 16 number badges **53.4×22.3**. Effective *pointer* radius is 12px for tee/basket ⇒ **24px**, not 9px — the DOM marker is smaller than the hit area, and both are under 36px |
| M9 | CV status strip | PASS* | **239.4×33** at (317, 233), on-canvas with the map; *12.5px text (budget ≥13px) |
| M10 | CV review chip | PASS* | **352×135.9**; buttons 96.6×36 and 133.3×36; *12px button text, *still no dismiss control |
| M11 | Hole bar targets | PASS | tab **63×44**, Add hole 106.3×44, "+" beyond-18 44×44, compact ‹/› **44×46** |
| M12 | Map/Round toggle (new chrome) | PASS* | buttons **117.5×44**, group 265.2×55.6; *hint text **11.5px**, hole-tab indicator glyphs **9.9px** |
| M13 | Handoff Import button | **FAILING (target)** | **143.4×21px** — unchanged from row 10 |

### Annotate Round at 1280×715 — Round mode

Round mode is the same route and the same pane, and every geometry number above is
**identical** in it (canvas 638/914, scrollY 457, hole bar −82, toggle x 1339.5, page
1268px tall). The measured differences are the ones the mode is *for*:

| # | Item | Grade | Key numbers |
|---|---|---|---|
| R1 | Radial menu with a hole active | PASS | exactly `shot`/`walk`, **44×44**, contained at all three viewports |
| R2 | Radial menu with **no** hole selected | PASS | exactly `walk`, 44×44, contained — the walk path deliberately needs no hole, so it stays reachable in the one state where nothing else is |
| R3 | Marker hit-testing is mode-scoped | (contract) | Map mode hit-tests tee/basket/bend only, Round mode shot/walk only; both share the same 12px screen radius as M7 |
| R4 | Canvas / hole bar / rail | same as M1–M5 | measured separately in Round mode, no divergence |

### 1440×815 and 1152×650

- **1440×815:** canvas 798px = **55.4%** expanded, 1074px = 74.6% collapsed (both
  unchanged). The M4 failure does **not** occur here — the 793.6px canvas cell fits
  the taller viewport, so the zoom cluster stays at y 765.6–801.6, inside. The trap is
  the same shape but shallower: at scrollY 436 the hole bar ends at −61, mode toggle
  −253, Done −325.8. Collapsed-rail toggle equally unreachable (x 1499.5).
- **1152×650:** still no horizontal overflow, still the ≤1180px single-column layout —
  canvas 1126px = 97.7% wide, 640px = 98.5% tall, and the collapsed-rail toggle
  becomes reachable (`elementFromPoint` returns the button). The trap is much worse
  than at the original pass because the page is now taller: **1922px** with a hole
  selected (was ~1596 empty). With the canvas in view (scrollY 1167) the hole bar ends
  at **−804**, the mode toggle at −992 and Done at **−1060.8**. Only the on-canvas
  zoom cluster remains reachable — and see D3 below for what the demo rail does to it.

### `/demo` — the two-act rail

The rail's geometry is step-independent: a fixed **386×514** panel at (878, 185) at
1280×715, **386×49.2** at (878, 649.8) when collapsed, on every route it rides. Zero
horizontal overflow with a tour running on every route, at every viewport.

| # | Item | Grade | Key numbers at 1280×715 |
|---|---|---|---|
| D1 | Rail containment / overflow | PASS | rail fully inside the viewport; overflow 0 on stitch-map, annotate-round (both modes), create-graphics, and the cover |
| D2 | Rail's own controls | **FAILING (new)** | Collapse **67.4×24**, Exit **77×24**, Back 58.4×**30.8**, Next 57×**30.8**, "Load the real inputs"/"Reload the page" 360×**30.8**, Finish 64.2×**30.8** — every one under the 36px budget; Collapse/Exit text **12px**. The `@media (max-width: 640px)` rule already gives them `min-height: 2.5rem`; a 13″ laptop gets nothing |
| D3 | On-canvas zoom cluster (annotate, both modes) | **FAILING** | Fit **fully covered** (36×33 of a 36×36 button), zoom-out 12×33, zoom-in clear — as first measured. New: **collapsing the rail does not clear them** (the 49.2px collapsed header spans the same corner and covers exactly the same two buttons), so "start collapsed" alone would not close Ticket D. At **1152×650 all three** buttons are fully covered (36×36 each), expanded *and* collapsed |
| D4 | Hole bar controls (annotate) | **FAILING (new)** | On the 18-hole course the demo itself produces, hole tabs **15–18** (63×44 each) are fully covered and `elementFromPoint` at their centres returns `demo-guide`; the compact **"Next hole"** button (44×46) is fully covered too. Add hole, Done and the Map/Round toggle are clear (0 overlap). Same at 1152; at 1440 tabs 15–18 are 72×29 covered (top 15px still clickable) and Next hole is clear |
| D5 | Create Graphics panes | **FAILING (new)** | The rail covers **385×420px** of the target-basemap pane — 62.7% of its width, its full height — on the route the two-act script visits **twice** and where the visitor must click landmarks in both panes. Source pane, Add correspondence and the guidance line are clear. Collapsing *does* clear this one. 1440: 385×372; 1152: 385×397 plus the guidance line (386×16) |
| D6 | Cover page with a tour running | **FAILING (new)** | "Finish" is a link back to `/demo` that leaves the tour running. There, the rail covers the last step card's own **"Start here"** (94.2×35.8) at **every scroll position the page allows** — the card's x-range 833–927 is inside the rail's 878–1264, and its y never leaves the rail's 185–699 band — so `elementFromPoint` returns `demo-guide`. Same at 1152 (fully covered); clear at 1440. Separately, every cover step button is **94.2×35.8**, 0.2px under the target budget |
| D7 | CV surfaces vs the rail | PASS | measured during the real detection run with the rail active: status strip and review chip have **zero** overlap with it |
| D8 | Stitch Map (step 1) | PASS (empty state) | rail clears `alignment-workspace`, `stitch-readiness` and `use-as-source` at scrollY 0. The *loaded*-state occlusion recorded in row 21 was not re-measured — out of scope |

**Verdict for the re-audited surfaces.** The Map/Round split did not cost anything on
the width budget and added one genuinely good thing (mode-scoped radial menus that
pass every target check, including the no-hole walk case). It did make the mid-task
trap worse — there is now a third control row above the canvas — and the demo rail is
in worse shape than the original pass recorded, because the pass measured it against a
one-act script that never reached Create Graphics twice and never had 18 hole tabs on
screen.

**Two non-viewport observations, recorded rather than fixed:**

1. The real detection run on the shipped Dash's Track stitch reports **"0 numbers · 18
   tees · 15 baskets · 0 ready"** → chip **"Found 18 holes — 0 ready, 18 need review"**
   with "Accept 0 ready holes" disabled. The step-2 narration's one-click *"accept the
   ready holes"* moment therefore cannot fire on the dataset the demo ships — the same
   observation the original pass recorded for the Bill Allen dataset, now confirmed for
   Dash's Track. Owned by whoever owns the CV pipeline, not by this pass.
2. Hole-bar tab labels now read `Hole 1, selected: tee missing, basket missing, number
   present, 0 bends, 0 throws` (the simplified-labels commit). Nothing viewport-related;
   noted only because the label text is what a re-audited selector reads.

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

`tests/e2e/viewportBudget.spec.ts` runs at exactly 1280×715. After the re-audit it is
**19 active + 13 `test.fixme`**, and **enforces now**:

- `documentElement.scrollWidth === clientWidth` on all five routes, including with
  images loaded and pairs placed (budget 1, all states audited) — and with a demo tour
  running on annotate-round and create-graphics.
- Annotate canvas ≥55% width / ≥65% height with the rail collapsed, **in both Map and
  Round mode**, measured with a hole selected (the state a user annotates in).
- Create-graphics combined pane area ≥55% width.
- On-canvas zoom cluster: present, ≥36px targets, inside the viewport when the canvas
  is scrolled into view **with no hole selected** — the state that passes. The
  hole-selected state is fixme'd separately (M4) rather than folded in here.
- Radial menu: the action set is asserted *exactly* per mode — `tee/basket/bend` in Map,
  `shot/walk` in Round, `walk` alone in Round with no hole — all ≥36px and fully inside
  the viewport, so a wedge leaking across the mode split fails here.
- Discard dialog fully contained.
- Handoff/working state reachable end-to-end without horizontal overflow.
- Demo rail: fully inside the viewport, and zero overlap with Annotate Round's
  page-level controls (Done, Map/Round toggle, Add hole).

**Documented as `test.fixme()`** (target state; each verified genuinely red by running
the suite with the fixmes stripped, and each citing this file): annotate canvas ≥55%
width with the rail *expanded* (F1); the canvas cell fitting one screen and the zoom
cluster staying in view with a hole selected (M4 → Ticket C); hole bar **and mode
toggle** visible while the canvas is in view, in both modes (F2 → Ticket B); the
rail-collapsed toggle inside the viewport and ≥36px (F3 → Ticket B); an existing marker
as a ≥36px pointer target (M7 → Ticket B); create-graphics pane height ≥65% and stitch
crop preview ≥65% (Ticket A, untouched by this re-audit); and five demo cases — rail
control sizes (D2), the zoom cluster (D3 → Ticket D), the hole bar's own controls (D4),
the Create Graphics target pane (D5), and the cover page's controls with a tour running
(D6) — the last three under Ticket E.

CV-showcase visibility (budget 6) is measured PASS in this audit and in the re-audit
(M9/M10/D7, on a real detection run) but still not asserted in the suite: driving real
detection costs a full stitch plus a WASM+CV pass per run, and
`tests/unit/annotateRoundCvUx.test.ts` already pins the strip/chip *logic* with
mocked detection. The geometry that makes it pass — strip and chip render inside the
pane's popover layer, anchored to the canvas — is pinned indirectly by the
canvas-visibility assertions. The candidate-target failure (M8) is likewise not
asserted in the suite; M7 pins the same 12px screen radius on an ordinary marker, which
is the same constant and needs no CV.

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

### Ticket B — Annotate Round: canvas-first hole selection

*Rewritten 2026-08-10 on owner design intent. This supersedes the re-scoped version,
which solved the wrong problem. Line anchors verified at `ca268e7`.*

**Files:** `src/routes/annotate-round/+page.svelte` only.

#### The correction

The previous version of this ticket tried to rescue the out-of-frame hole bar — make
`.hole-bar-compact` sticky, duplicate Done into it, enlarge the 18 tabs. The owner's
stated intent is the opposite:

> "I didnt want hole selectors outside the frame, they were supposed to be small
> completion indicators for a quick check. You select a hole much more ergonomically
> by clicking the hole number."

So the hole bar is **not** the selector and should not be engineered into one. The
selector is the hole number **on the image** — already implemented via
`numberCandidateHitAt` (`:736`) and `numberSelectDrag` (`:1107`), claimed through
`claimAnnotationPointer` before placement, exactly like the tee/basket candidates.
`.hole-indicators` (`:3314`) is **status, not a target**: it answers "which holes are
done" at a glance and is never the thing you aim at.

Getting this right dissolves the scroll trap instead of working around it. If you do
not need the hole bar mid-annotation, it does not matter that it scrolls away.

#### Blocking dependency — read before starting

`numberCandidateHitAt:741` is `if (candidate.label === undefined) continue;` — **only
*labeled* badges are clickable.** On the shipped demo dataset 0 of 18 badges are
labeled, so on that data canvas hole selection does not work at all and the hole bar is
the only way to change holes. **This ticket cannot be finished, or honestly demoed,
until badge labeling produces labels on the demo dataset** (see the 0-ready CV
investigation). Do the parts below that stand alone; do not fake a selector that has no
labels behind it, and do not delete the hole bar until the canvas path actually works.

#### The work

1. **Collapsed rail toggle is off-screen (do this first, it is a plain bug).** The
   collapsed rail (`:3840-3851`, `@media (min-width: 1181px)`) puts its toggle at
   x 1339.5–1369.8 — past the right edge of a 1280px viewport. `elementFromPoint` at the
   toggle centre returns `null`: collapse the rail and you cannot re-open it. Hide the
   `h2` when collapsed, or absolutely position the toggle inside the 2.75rem column.
   Verify by hit-test, not by clicking (Playwright auto-scrolls and will hide this). The
   toggle is also **30.4×30.4** (`.diagnostics-rail-toggle`, `:3819`); take it to ≥36px.
2. **Then default the rail collapsed at ≤1280.** `readStoredDiagnosticsRailExpanded()`
   (`:370-378`): with no stored preference, default collapsed when
   `window.innerWidth <= 1280`; a stored preference always wins. Auto-expand (without
   writing the preference) when a course-detection result lands. Gated behind item 1 —
   shipping this first would strand users in a rail they cannot reopen. Worth it: the
   canvas goes from 49.8% to 71.4% of the viewport width.
3. **Make the on-image hole number a first-class selector.** The mechanism exists; what
   is missing is that it does not *look* selectable and gives no feedback.
   - Labeled badges need a visible affordance — hover/focus state, and a clear
     indication of which badge is the active hole.
   - Keyboard parity: a labeled badge must be reachable and activatable without a
     pointer, since the hole bar stops being the primary path.
   - The badge hit radius (`:744-747`,
     `max(MARKER_HIT_RADIUS_PX, (max(w,h)/2) * zoom + 10)`) is already generous; leave
     it alone unless measurement says otherwise.
4. **Demote the hole bar to what the owner intended.** Keep the 18-tab grid as
   completion status and a fallback selector — it must remain usable and accessible, and
   it is the only path when badges are unlabeled (see the dependency above). Do not make
   it sticky and do not duplicate ‹/current/› into a sticky row. `.hole-indicators` stays
   small: it is status. It is currently **9.9px**, which is too small to *read* — raise
   it to a legible size without turning it into a 36px target. Do not confuse
   "legible" with "tappable" here.
5. **Done and the Map/Round toggle still need to be reachable.** These are not hole
   selection and the redesign does not address them. With the canvas in view (scrollY
   457) the Map/Round toggle sits at −274 and Done at −346.8; at 1152 the round trip is
   ~1000px. Switching activity mid-round is now as common as switching hole. Keep these
   two — and only these two — persistently reachable, on-canvas or in a slim persistent
   affordance. This is the one piece of the old sticky-row idea worth keeping.
6. **Pointer targets on the canvas matter more now, not less.**
   - Ordinary markers (tee/basket/bend/shot/walk) hit-test at `MARKER_HIT_RADIUS_PX = 12`
     screen px (`:125`, used by `pointHitAt` `:708`) — 24×24 effective in both modes.
     Take it to ≥18 (36px effective).
   - CV candidates: `courseCandidateHitAt` (`:775`) uses
     `max(MARKER_HIT_RADIUS_PX, radiusPx * view.zoom)`, so at fit zoom (0.17) tee and
     basket candidates are also 24px effective while drawing at **2.2–9.3px** (tee) and
     16×16 (basket). Raising the shared constant fixes the hit area; give the markers an
     invisible screen-space hit circle too, so what the eye aims at and what the pointer
     hits are the same thing.
   - Confirm-chip cancel ≥36px; strip/chip/button text ≥13px (measured 12.5px on the
     strip, 12px on the chip buttons). `.mode-toggle-hint` (`:2783`) is **11.5px**.
   - The handoff banner's Import button is **143.4×21px** (`.handoff-actions`, `:2852`);
     give it `min-height: 36px`.
   - Add an ✕ dismiss to the summary chip that nulls only chip visibility, not
     `courseDetection`.
7. **Specs.** Flip the fixmes in `viewportBudget.spec.ts` that this work actually fixes:
   the collapsed-rail toggle case, `an existing marker is a ≥36px pointer target`, and
   the expanded-width case if the rail default makes the default state pass. The two
   `hole navigation and the mode toggle stay reachable` cases now measure the wrong
   thing — the hole bar is *allowed* to scroll away. Rewrite them against item 5: Done
   and the Map/Round toggle stay reachable with the canvas in view, and a labeled badge
   is clickable at the fit zoom. `tests/e2e/annotateRound.spec.ts:123-143` pins
   `aria-expanded` defaults at 1280×720 and asserts default-expanded; update it in the
   same change, since it tests exactly the behavior item 2 alters.

### Ticket C — ImageEditorPane grid: canvas width share and height cap

*Re-scoped 2026-08-10. The file is unchanged since the original pass (both line
anchors still hold), but item 2 now has a measured user-visible consequence, and it is
the more urgent of the two.*

**Files:** `src/lib/components/ImageEditorPane.svelte` only.

1. At ≤1366px, narrow the chrome: `.editor-body.with-tools` (`:345-347`)
   `18rem / 20rem` → `minmax(13rem, 16rem) / 17rem` (or similar) so the canvas cell
   is ≥55% of a 1280 viewport even with the rail expanded (re-measured 638px = 49.8%,
   identical in Map and Round mode — the chrome is mode-independent).
2. **Cap the canvas cell height — this now costs the user a control, not just space.**
   `.canvas-shell`'s `min-height: 640px` (`:367`) plus grid stretch lets the tools
   column drive the cell to **793.6px** as soon as a hole is selected, i.e. taller than
   a 715px viewport. Scrolling the canvas into view then puts the bottom-anchored
   on-canvas zoom cluster at y 744.6–780.6 — **all three buttons below the fold** — and
   those are precisely the controls the F2 hole-bar trap leaves as the last reachable
   ones. Give `.tools` `overflow-y: auto` with `max-height` tied to the canvas cell, or
   cap `.canvas-shell` at `max-height: calc(100vh - 4rem)`, so the cell never exceeds
   one screen. At 1440×815 the same 793.6px cell fits and the cluster stays in view, so
   this is a ≤~800px-tall-viewport failure specifically.
3. Do not change the `popover`/`overlay` contract (see
   `docs/imageviewport-event-contract.md` §1.6 addendum) — the radial menu clamps
   itself to `paneSize` and must keep working. The re-audit re-measured every wedge at
   44×44 and fully contained in both modes; that must survive the cap.
4. Acceptance: flip `annotate-round: on-canvas zoom controls stay in view with a hole
   selected` in `viewportBudget.spec.ts` (it asserts both the ≤viewport cell height and
   the three buttons' containment), and keep the two collapsed-rail canvas-share cases
   green in both modes.
5. Coordinate with Ticket B only through the shared budget spec; no shared files.

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

> **Re-audit note on D (2026-08-10, ticket text left as written).** The zoom-cluster
> occlusion is unchanged and confirmed (Fit 36×33 covered, zoom-out 12×33, zoom-in
> clear). Two measurements bear on the remedies offered above: **"start it collapsed"
> does not work on its own** — the collapsed rail is a 386×49.2 header in the same
> corner and covers exactly the same two buttons — and at **1152×650 all three** zoom
> buttons are fully covered, expanded or collapsed, so the fix needs to apply below
> 1280 too. Raising `bottom` or docking bottom-left both still work. The non-occlusion
> check asked for in item 3 now exists in `viewportBudget.spec.ts` as a `test.fixme`
> (`demo: the guide rail does not cover the on-canvas zoom cluster`); it is stable
> without CV and flips when this ticket lands. `course-summary-chip` from item 2 was
> measured on a real detection run and has **zero** overlap with the rail.

### Ticket E — Demo rail: control sizes and the occlusions Ticket D does not cover

*New from the 2026-08-10 re-audit. Disjoint from A–D in files; overlaps D only in that
both edit `DemoGuide.svelte`, so **run them as one ticket or serialize them** — this is
the one pair in this document that shares a file.*

**Files:** `src/lib/components/DemoGuide.svelte` only.

1. **Rail control targets (D2).** Every control the rail owns is under 36px: Collapse
   67.4×24, Exit 77×24, Back/Next 57–58.4×30.8, "Load the real inputs" / "Reload the
   page" 360×30.8, Finish 64.2×30.8; Collapse/Exit text is 12px. The
   `@media (max-width: 640px)` block (`:427-439`) already applies `min-height: 2.5rem`
   to `button, .finish-link` — the base rule (`:371-383`) and `button.ghost` (`:414`)
   need the same floor at every width, and ghost text ≥13px.
2. **Hole bar occlusion (D4).** On the 18-hole course the walkthrough itself produces,
   the rail fully covers hole tabs 15–18 and the compact "Next hole" button at 1280 and
   1152 (`elementFromPoint` at their centres returns `demo-guide`), which is exactly
   how step 2's script says to reach the hole flagged for review. Whatever fix Ticket D
   takes for the zoom cluster should be chosen to clear the hole bar's right-hand end
   too — docking bottom-left clears both; raising `bottom` clears the hole bar only if
   the bar is scrolled below the rail's top edge, so verify, do not assume.
3. **Create Graphics pane occlusion (D5).** The rail covers 385×420px of the
   target-basemap pane — 62.7% of its width — on the route the two-act script visits
   twice and where the visitor clicks landmarks in *both* panes. Collapsing clears it,
   so an acceptable minimum is auto-collapsing on that route; docking bottom-left does
   not help here (the source pane is on the left).
4. **Cover page with a tour running (D6).** "Finish" links back to `/demo` without
   exiting the tour, and there the rail covers the last step card's "Start here" at
   *every* scroll position the page allows, at 1280 and 1152 — a pointer lockout of the
   same class as F3, on the demo's own page. Either exit the tour on Finish, or hide
   the rail on `/demo` (it narrates a step the visitor is not on), or dock it clear.
   Also: the cover's step buttons are 94.2×35.8, 0.2px under the target budget — a
   one-line fix in `src/routes/demo/+page.svelte` if that file is opened for the same
   pass; otherwise leave it, it is not this ticket's file.
5. Acceptance: flip `demo: the guide rail's own controls are ≥36px`, `demo: the guide
   rail does not cover the hole bar's own controls`, `demo: the guide rail does not
   cover the Create Graphics target pane`, and `demo: the cover page's own controls
   stay reachable while a tour is running` in `viewportBudget.spec.ts`. Keep
   `tests/e2e/demo.spec.ts` and the two active demo cases green.

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

**Re-audit artifacts (2026-08-10, commit `ca268e7`).** Four throwaway Playwright
drivers — the annotate journey (both modes × three viewports), the demo-rail journey
(every step route × three viewports), a target/text probe including the empirical
marker hit-radius bisection, and the real act-1 CV run — plus their raw measurement
JSON. Session artifacts, deliberately not committed: everything they establish is
either a number in the re-audit section above or an assertion in
`tests/e2e/viewportBudget.spec.ts`, which is where a measurement belongs if it is
meant to keep holding.
