# Ribbon-mass handoff 2: from validated shadow path to per-hole repair

**Audience**: a fresh agent continuing toward (almost) fully autonomous
labeling of Dash's course maps. This report is self-contained on purpose —
the original Phase-1/2 findings docs live on a different branch
(`claude/grayt-ribbon-mass-ihcxiq`), and everything from them that still
matters is restated or superseded here.

**State**: branch `claude/grayt-tuning-b3bj2q`, pushed. Key commits:

| commit | what |
|---|---|
| `6183766` | Ribbon-mass Phase 1+2 ported into Annotate Round as the attribution shadow path |
| `f413122` | `confuserLabel` annotations + ring-arc spike (gap↔radius measurement) |
| `2f745ad` | Fix: IndexedDB rejects Svelte `$state` proxies — snapshot before put |
| `8ccee8d` | Occluder-bridge spike v1 (chord rule — **falsified**, see §4) |
| `998aff2` | `--render` for the spike (the falsifier) |
| `8cda382` | Spike v2: strictly local, stroke-scale annulus closing |

## 1. What exists and is trusted

- **`src/lib/autoAnnotation/ribbonMass.ts`** — TypeScript port of the
  Python research segmentation + ownership. Validated:
  `npx tsx scripts/cv-probes/compare-ribbon-mass-port.ts` reproduces the
  committed Python fixture results — all 36 per-hole topology buckets
  exactly, basket 18/18, one documented float-borderline tee per course.
- **`src/lib/autoAnnotation/ribbonMassShadowRun.ts`** — `RibbonMassShadowRun`
  record: ShadowRun A (production reality) frozen at detection time in
  `handleDetectCourse`, immutable; experiments B (ownership-only
  corrections, exact-coordinate matched) and C (review-approved
  location+ownership) derived at export from the stored RLE label map (the
  label map is seed-invariant, so no re-segmentation). Texture baseline
  always logged. Own IndexedDB DB, sibling to the correction log; "Export
  shadow runs" button in annotate-round dev tools.
- **Dev overlay** — "Shadow ribbon overlay" toggle in annotate-round's dev
  footer: mask colored by ownership (green 1-hole / amber multi-hole /
  blue texture-only), split-hole connectors, and a **"Label confusers"**
  panel that persists per-component `confuserLabel` annotations
  (`ring-graphic` / `powerline` / `tee-marker-graphic` / `road` / `other`)
  into the stored run via `withComponentAnnotations`.
- **Spikes** (all in `scripts/cv-probes/`, all support the fixture pair):
  `ring-arc-spike.ts` (gap↔radius measurement), `occluder-bridge-spike.ts`
  (v2 annulus closing, `--render`), shared data in `ribbonMassFixtures.ts`.
- **Correction log** — snap-coupled events now record the post-snap
  coordinate as `finalValue` with the raw drop in
  `interactionMeta.rawDropPx`.

Ground rules carried forward, non-negotiable:

- Post-review geometry is **review-approved**, never "truth"/"oracle" —
  reviewed coordinates are CV-snap-influenced. Fixture truth stays in
  `scripts/cv-probes/` only.
- **Log facts, not classifications** — `confuserLabel` is a human
  annotation; no ring/powerline/road classifier exists.
- ShadowRun A is immutable; `componentAnnotations` is the one sanctioned
  post-hoc field.
- The shadow path never touches authoritative `AnnotatedHole` geometry.
- N=2 labeled courses; nothing here is a validated production signal.
- **Render before believing any metric.** See §4.

## 2. Ground truth: Sam's per-hole audit of Dash's course (GoldenTeeSet)

This is the reference table for the next iteration, from Sam's visual
audit of the v2 render (`occluder-bridge-spike.ts --render`,
`ribbon-mass-results-ts/GoldenTeeSet-annulus-close.png`). "B*n*" = hole
*n*'s basket glyph (the rendered white basket icon), "C1/C2" = the
putting-circle ring glyphs. Do not soften these when re-evaluating —
e.g. hole 8 is **not connected**, regardless of any within-30px metric.

| hole | status | detail |
|---|---|---|
| 1 | ✅ good | |
| 2 | ⚠️ shared | corridor complete; minor tearing by its own C1; shares component with 3 |
| 3 | ⚠️ shared | major tearing from H5's C2; shares component with 2 |
| 4 | ❌ basket end | connects to its own tee, but **B4 breaks 4's ribbon** — never reaches its basket. Likely a COMMON pattern |
| 5 | ⚠️ fragile | almost disconnected; saved by a 1px or kitty-corner (diagonal) connection |
| 6 | ❌ tee side | badge↔basket healed, but tee→badge is cut because **B7 breaks 6's ribbon** |
| 7 | ❌ false repair | still bridges into 6, and v2 drew a red dot connecting 7 to **5** — a false repair |
| 8 | ❌ pad | does not appear to connect to its pad |
| 9 | ❓ can't tell | might bridge (red dot) to its pad; **B9 appears to break the ribbon** |
| 10 | ❓ can't tell | same story as 9 |
| 11 | ❌ double split | still split in two places; its tiny (9.5px) tear sits at ~99px radius where the discovered band (88px) fell short |
| 12 | ❌ foreign glyph | **B11 breaks 12's ribbon**; the far end of that path has 12's basket, and the breaking glyph is assigned to a different hole → tie-break heuristic (§5.9) |
| 13 | ❌ powerline | cut between badge and tee |
| 14 | ✅ good | |
| 15 | ⚠️ precision | complete, but its mass FOLLOWS the powerlines (false ribbon), which in turn disrupt 16 |
| 16 | ❌ compound | powerlines + C2 (maybe C1 too) produce the huge gap; unrepaired |
| 17 | ✅ good | (its own C2 almost splits it, but doesn't) |
| 18 | ✅ good | |

**Tee-ray list**: holes **2, 3, 6, 8, 9, 11, 13, 16** can be *partially*
recovered by raying out of the tee pad through the hole's own number
badge, ignoring the basket entirely (§5.3).

## 3. The corrected taxonomy — what the audit changes

1. **Basket glyphs are the dominant un-modeled occluder, not rings.**
   B4, B7, B9, B11 (± B10) sever ribbons — a glyph cuts its OWN hole's
   corridor at the terminus (4, 9, 10) *and* FOREIGN corridors passing
   near it (6 cut by B7, 12 cut by B11). Same predictable-geometry class
   as rings: center = detected basket, radius ≈ the per-course marker
   radius the earlier research already measured (~96px Golden, ~76px
   Alex — full-glyph footprint; the occluding icon core may be smaller,
   measure rather than assume). Sam: "this could be common — we'll have
   to be good at fixing it."
2. **Rings still matter, but their share shrank.** Stroke-scale ring
   tears are real and heal locally (§4 v2), yet several breaks previously
   blamed on rings are actually basket glyphs.
3. **Evaluation must be segment-wise.** Three separately-failing
   segments per hole: **tee→badge**, **badge→basket corridor**,
   **basket-end connection**. Boolean "connected" hid that hole 4 has a
   good tee side + dead basket end while hole 6 is the reverse.
4. **Ownership arbitration and connectivity repair are different
   problems** and must never share a union-find (v1's core failure).

## 4. The v1→v2 lesson (do not relearn it)

v1 bridged component pairs whose ≤90px closest-approach chord straddled
a ring radius, with a global union-find, and reported tee recall
14/18→18/18 on both fixtures. **The render falsified it**: the rule was
permissive long-distance merging; the recall was contaminated by
transitive kept-promotion. v2 (current) replaces it with multi-source
BFS wavefronts confined to predicted annulus bands, max 18px total gap,
no union-find, per-hole evaluation. Its accepted-gap histogram clusters
sharply at ≤9px (Golden 27/44, Alex 23/29 connections) — the stroke-tear
mechanism is real — and it repairs 5/7 Golden + 3/8 Alex splits while
correctly refusing the wide (22–170px) tears. But §2 shows v2 still has
false repairs (7↔5) and misses everything basket-glyph-related.

Standing rule: **every new mechanism ships with `--render`, and the
render gets eyeballed against §2 before any metric is quoted.**

## 5. Prioritized work queue

Each item: mechanism → acceptance test against §2.

1. **Basket-glyph occluder bands.** Add glyph discs (detected basket
   centers × measured glyph radius) as a third band type in
   `occluder-bridge-spike.ts`; re-run v2 closing. Accept: 4/9/10
   basket-end connections heal locally; 6's tee→badge heals across B7;
   12 heals across B11; **no new cross-hole repairs appear in the
   render**.
2. **Segment-wise per-hole evaluation.** Split the spike's per-hole
   report (and eventually `RibbonMassExperimentResult`) into tee→badge /
   badge→basket / basket-end. Accept: mechanically reproduces §2's
   status column for the current baseline.
3. **Tee-ray invariant probe.** Reverse-GRayT: from tee-end fragments,
   cast through the hole's own badge (the badge-on-tee-line domain fact);
   score corridor membership without baskets. Accept: partial recovery on
   2, 3, 6, 8, 9, 11, 13, 16.
4. **Ring-radius peak-picking fix.** Reconcile the radial-profile peak
   (88px) with the marker-radius measurement (~96px) — the picker is the
   weak link. Accept: hole 11's 9.5px tear heals at the ≤6px threshold.
5. **False-repair gate.** Tangent agreement between fragment ends and/or
   per-hole corridor scoping on accepted connections. Accept: the 7↔5
   red dot disappears; true repairs (6, 9, 10) survive.
6. **Graded connectivity.** Min neck width per connection/component
   junction instead of boolean adjacency. Accept: hole 5 flagged fragile.
7. **Dark-line powerline extractor.** Evidence-ridge Hough found ZERO
   lines — powerlines suppress evidence rather than emit it, and attract
   mass alongside (15). Extract from the raster (dark thin lines) or as
   thin gap-ridges in evidence; use extracted lines twice: discount mass
   following them (15) and band-bridge across them (13, 16). Validate
   against `confuserLabel: 'powerline'` annotations from the dev panel.
8. **Compound occluder composition.** Overlapping bands (16: powerlines
   + C2 ± C1) must compose into one traversable crossing. Accept: 16's
   gap closes without raising the global gap cap.
9. **Ownership tie-break heuristic** (from 12/B11): a foreign basket
   glyph interrupting a ribbon does not claim that corridor — the glyph's
   own hole assignment disambiguates. Feed this into shared-component
   arbitration (2/3, 6/7) rather than inventing a separate rule.

Explicitly deferred: porting any bridging into the shadow path (only
after the local mechanism survives §2 re-audit), tee localization from
component endpoints, backend/sync anything.

## 6. Verification / how to run everything

```bash
# Port parity vs committed Python results (expect: all OK, tee ±1 documented)
npx tsx scripts/cv-probes/compare-ribbon-mass-port.ts

# Current repair baseline + renders (ribbon-mass-results-ts/*.png)
npx tsx scripts/cv-probes/occluder-bridge-spike.ts --render

# Unit tests for the port, shadow-run schema, and A/B/C derivation rules
NODE_OPTIONS=--experimental-require-module npx vitest run \
  tests/unit/ribbonMass.test.ts tests/unit/ribbonMassShadowRun.test.ts
```

In-app: load a course image in annotate-round (detection auto-runs and
freezes ShadowRun A), dev footer → "Shadow ribbon overlay" → "Label
confusers"; "Export shadow runs" derives B/C + evaluation. Known
dev-mode quirk: Vite full-reloads the page the first time the shadow
worker loads on a fresh server, eating that detection's run — re-run
detection once.

And the rule worth repeating: eyeball every render against §2 before
trusting any new metric. The 18/18 that died in §4 looked great right up
until the red lines were drawn.
