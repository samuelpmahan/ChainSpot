# refactor/separation-of-concerns

## Source

Lineage: **OLD layout** — `C:/Users/tenni/workspace/ChainSpot`, branch `refactor/separation-of-concerns`.

- **Status: committed, never pushed.** `git branch -r --contains e274589` returns empty. Every commit exists only on the local branch. Worktree is clean — nothing is sitting dirty.
- **Campaign base SHA:** `4308c60c14acad9782f8961da1d3d60cda5e2529` (this SHA is hardcoded inside the checker script, not just in docs).
- **Merge-base with `main` today:** `a81ea40f83685ff409996125baf8fd2e62d075ca`. The branch is 38 commits ahead of `main`; the **last 26** are the refactor campaign. The 12 older commits are CHSPT-48 hotfix/regression churn and agent-workflow docs, not part of this work.
- **Campaign range:** `e274589` (`docs: freeze separation of concerns architecture`, 2026-08-16) … `cd77466` (`docs(architecture): gate final route shells`, 2026-08-17). Two calendar days of work.
- **Diff for the 26-commit range:** 79 files, +10,473 / −6,184. (The task brief's "83 files / +10,635 / −6,245" is the full 38-commit `main...branch` diff, which includes the CHSPT-48 commits.)
- **Ticket:** CHSPT-67, contract at `.task/CHSPT-67.md` on the branch (blob `71339491aeaf3f9d0e21d0e133444490b30df30c` — the path has a leading dot and `git show <branch>:.task/...` gets mangled by the shell's path conversion; read it via `git cat-file blob`).

Key files to read if the branch is ever revisited:

| Path (on branch) | What it is |
| --- | --- |
| `docs/architecture/refactor-campaign.md` | The frozen architecture decision. 169 lines. The single most valuable file. |
| `docs/architecture/dependency-rules.md` | The ratchet policy, written as an English contract before code existed. |
| `docs/architecture/spark-dag.md` | Execution DAG: 25 bounded tasks, prerequisites, owned/forbidden file globs, per-task acceptance checks, hot-file reservation schedule. |
| `docs/architecture/refactor-baseline.md` | Pre-change measurement, including an honest record of 36 pre-existing test failures. |
| `scripts/architecture/architecture-policy.mjs` | 159 lines. Pure zone-classification + forbidden-edge rules. |
| `scripts/architecture/check-architecture.mjs` | 641 lines. Walker, import parser, Tarjan SCC, baseline compare, reporter. |
| `scripts/architecture/baseline.json` | 531 lines of mechanically captured existing debt. |
| `tests/unit/architectureRatchet.test.ts` | 129 lines, 12 cases, all against throwaway temp fixture trees. |

## What it detects

Nothing about pixels. **This branch contains zero computer vision.** It is a code-organization campaign with a machine that watches code organization.

Two distinct things live here, and they should be evaluated separately:

**1. A written architecture** — plain-language rules about which folder is allowed to know about which other folder, plus a small set of domain types describing what a disc-golf round and course actually *are* (a course, a layout of that course, an observation of that layout's geometry, a played round, a throw, a landing point).

**2. An "architecture ratchet"** — a script run as `npm run check:architecture` that reads every `.ts`/`.svelte.ts`/`.svelte` file under `src/`, and fails the build if the codebase got *structurally worse* than a frozen snapshot. "Ratchet" means one-directional: existing mess is grandfathered at its exact recorded size, and may shrink but never grow; brand-new mess fails immediately.

The ratchet watches four things:

- **File size.** New file over 600 lines → fail. New file over 400 → warn. New route file over 100 → warn. New `*Workspace.svelte` over 300 → warn. An already-oversized file that grows by even one line past its recorded count → fail.
- **Import direction.** Each file is classified into a zone by path prefix (`domain` / `feature` / `infrastructure` / `shared` / `route` / `other`), and eight rules say which zone→zone edges are illegal. A new illegal edge → fail.
- **Import cycles.** Tarjan strongly-connected-components over the resolved import graph. Cycles are recorded as an exact sorted membership set. A new cycle, an *enlarged* cycle, or a cycle with changed membership → fail. Shrinking or deleting one → allowed.
- **Exceptions.** A separate `allowlist.json` with a rigid `{path, kind, reason}` shape. Malformed or duplicate entries fail the run. It shipped empty and stayed empty.

The reporter prints the SHA-256 of both `baseline.json` and `allowlist.json` on every run, plus the full allowlist contents. That makes "someone quietly widened the exceptions" visible in CI log diffs.

**There is deliberately no `--accept-current` or `--update-baseline` flag.** That absence is the whole point of the design.

## Why it exists

The measured problem, from `refactor-baseline.md` and `.task/CHSPT-67.md`:

| Lines at base SHA | File |
| ---: | --- |
| 5,997 | `src/lib/components/AnnotationWorkspace.svelte` |
| 3,553 | `src/routes/create-graphics/+page.svelte` |
| 2,885 | `src/routes/stitch-map/+page.svelte` |
| 1,665 | `src/lib/autoAnnotation/teePadDetection.ts` |
| 1,503 | `src/lib/projectSchema.ts` |
| 1,030 | `src/lib/persistence.ts` |

27 production files were over 600 lines. Two Svelte components — one workspace and two routes — held roughly 12,400 lines of interleaved UI, state, persistence, session, and CV-orchestration logic. A single `AnnotationWorkspace.svelte` served *both* "annotate a course" and "map a round I played", so touching one mode risked the other, and Map Round transitively imported course CV it had no business knowing about.

Stated goal: *"a normal change is local to one feature and its tests"*, and specifically *"leave Map Round structurally independent from Annotate Course and course computer vision."*

The ratchet exists because the campaign author did not trust the campaign to hold. Godfiles do not grow in one commit; they grow 40 lines at a time over months while everyone agrees they are a problem. The ratchet converts "we agree that's bad" into "CI says no."

## Signal and evidence

No pixels. The inputs are:

- **The file tree.** Recursive walk of `src/` for the three source extensions. Skips nothing else — no gitignore awareness, no `node_modules` guard (there is none under `src/`).
- **Physical line count**, with `\r\n` normalized and one trailing newline discounted so a file does not appear to grow by 1 just from a final blank line. Explicitly *not* logical/statement count, and `dependency-rules.md` states the countermeasure in words: *"Line-count compliance never justifies minification, merged statements, or meaningless one-function files."* That rule is prose only — nothing enforces it.
- **Import specifiers, extracted by regex**, not by parsing. One regex catches `import … from '…'`, `export … from '…'`, and dynamic `import('…')`. See Known failure cases.
- **Resolved import targets.** Handles relative paths and the SvelteKit `$lib/` alias; tries the bare path, then each of `.ts` / `.svelte.ts` / `.svelte`, then `index.<ext>`. Bare package specifiers resolve to `null` and are treated as "external".

Zone classification is **purely path-prefix based** — the checker has no idea what a file *does*, only where it sits:

```
src/lib/domain/**          -> domain
src/lib/features/<name>/** -> feature (named by <name>)
src/lib/infrastructure/**  -> infrastructure
src/lib/shared/**          -> shared
src/lib/coords*            -> shared, and specially blessed as "domain-neutral"
src/lib/geometry/**        -> shared, and specially blessed as "domain-neutral"
src/routes/**              -> route
everything else            -> other
```

`other` is the interesting bucket: at base SHA the vast majority of `src/lib` (`autoAnnotation/`, `stitch/`, `components/`, `alignment/`, `cv/`) was `other`, which is why the baseline shows 65 `route-to-feature-public` violations — routes importing `$lib/...` files that had not yet been sorted into a zone.

## Thresholds and constants

Every number below is **either a governance choice or a pre-existing constant that merely changed address.** This campaign introduced no new tuned value. That is verifiable: grepping the new-file diff for numeric literals yields only the constants in the last block, and each of them is present at base SHA `4308c60` in the route file it was extracted from.

**Governance limits** — all in `scripts/architecture/architecture-policy.mjs`:

| Name | Value | How derived | Confidence |
| --- | ---: | --- | --- |
| `SIZE_LIMIT` | 600 | **UNKNOWN.** No rationale anywhere in the branch. Chosen so that exactly 27 files land above it — a round number picked to make the grandfathered set a manageable size. Treat as arbitrary. | Low (as a number). High (as a policy — *some* hard ceiling is the point). |
| `NEW_PRODUCTION_WARNING_LIMIT` | 400 | **UNKNOWN.** Two-thirds of the fail limit; a "you're drifting" line. | Low |
| `NEW_WORKSPACE_WARNING_LIMIT` | 300 | **UNKNOWN.** Matches `dependency-rules.md`'s "workspace/composition shells: target 250–300 lines". The 250 half of that range appears nowhere in code. | Low |
| `NEW_ROUTE_WARNING_LIMIT` | 100 | **UNKNOWN** as a number, but the *intent* is explicit: a route should be a composition shell that does nothing but mount a workspace. 100 lines is "you cannot hide logic in this". | Medium |
| `SOURCE_EXTENSIONS` | `.ts`, `.svelte.ts`, `.svelte` | The project's actual source extensions. | High |
| `PRODUCTION_ROOT` | `src` | Project layout. | High |
| `BASE_SHA` | `4308c60c…` | The campaign's frozen base. Hardcoded in `check-architecture.mjs` *and* duplicated in `baseline.json` and two docs. | High (as a fact), Low (as a design — see Known failure cases) |

**Grandfathered baseline** (`baseline.json`, 531 lines): 151 production files, 27 oversized entries recorded at exact line counts, 67 forbidden import triples (2 × `domain-to-feature/infrastructure/route`, 65 × `route-to-feature-public`), 2 cycles: a self-loop on `src/lib/cv/runtime.ts` and a 2-file cycle `src/lib/graphics/distances.ts` ↔ `src/lib/holeGraphics.ts`. Every one of these is a **mechanical capture**, not a curated list — `dependency-rules.md` says explicitly *"The implementer may not choose which findings to omit."*

**Domain constants** — `src/lib/domain/discGolf/circles.ts`:

| Name | Value | How derived | Confidence |
| --- | ---: | --- | --- |
| `CIRCLE_1_RADIUS_METRES` | 10 | PDGA rule. Sport truth, world metres only. Labeled `hard-sport`. | Certain |
| `CIRCLE_2_RADIUS_METRES` | 20 | PDGA rule; exactly 2 × Circle 1. | Certain |

The file's comment is worth preserving verbatim in spirit: *"no raster or viewport measurement is involved."* `refactor-campaign.md` explicitly bars raster radii, confidence values, and detector thresholds from the `discGolf` domain folder.

**Constants that moved, unchanged** (all verified present at `4308c60` in the route they came from — none are new decisions):

| Name | Value | Origin | Now in |
| --- | ---: | --- | --- |
| `DEFAULT_NAIP_RADIUS_METERS` | 300 | `create-graphics/+page.svelte:366` | `createGraphics/application/basemapController.ts` |
| `TILE_RADIUS_METERS` | 300 | `create-graphics/+page.svelte:372` | same |
| `DEFAULT_BOX_FRACTION` | 0.9 | `create-graphics/+page.svelte:374` | same |
| `MIN_BOX_SIZE_PX` | 128 | `create-graphics/+page.svelte:375` | same |
| lat/lon guards | ±90 / ±180 | pre-existing | same |
| `CROP_ZOOM_SOURCE_WIDTH_PX` | 24 | `stitch-map/+page.svelte:835` | `stitch/components/ManualCropSurface.svelte` |
| `CROP_ZOOM_ROWS_ABOVE` / `_BELOW` | 8 / 8 | pre-existing | same |
| `CROP_ZOOM_SCALE` | 8 | `stitch-map/+page.svelte:838` | same |
| `CURRENT_SCHEMA_VERSION` | 7 | `projectSchema.ts:152` | `infrastructure/persistence/schema/contracts.ts` |
| affine coefficient count | 6 | pre-existing | `schema/decode/*` |

**None of these were re-derived, re-measured, or re-justified during the move — and none should be trusted as validated just because they now live in a tidier folder.** They are dataset-fit / UI-fit values carried forward at face value.

## Gate placement

**This work sits entirely outside G0–G5.** It never runs during detection. Nothing in the CV funnel imports anything created here.

The campaign explicitly *froze* CV rather than touching it. Multiple independent statements of this:

- `.task/CHSPT-67.md` non-goals: *"Course CV tuning, detector redesign, or fixture reinterpretation."*
- `refactor-campaign.md` §5: *"Behavior and CV tuning are frozen."*
- `spark-dag.md` escalation clause: *"If any move changes a CV result or threshold, stop and return it to Sol; this campaign permits a mechanical adapter only."*
- `spark-dag.md` ANNOTATE-03 acceptance: *"Detector code/thresholds/fixtures do not change; its regression gates must match baseline."*

All 15 `src/lib/autoAnnotation/*` files over 600 lines — including `teePadDetection.ts` (1,665), `holeNumberDetection.ts` (1,195), `basketDetection.worker.ts` (1,090), `basketOcclusionRecovery.ts`, `teeOcclusionRecovery.ts` — are recorded in `baseline.json` and **not modified by a single commit on this branch.**

The only pipeline-adjacent placement is the *gate that gates the gates*: `npm run check:architecture` was to run at every integration checkpoint (CP-0 through CP-4 plus a final VERIFY-01), alongside `npm run check`, focused Vitest groups, `npm run build`, and — only where CV contracts moved — the CV regression gates.

**What actually got built, versus what was planned:**

| Wave | Planned | Built |
| --- | --- | --- |
| RATCHET-01 | checker + policy + baseline + allowlist + tests | ✅ complete |
| DOMAIN-01..04 | coordinates, discGolf, course, round, legacy adapter | ✅ complete |
| PERSIST-01..02 | facade + archive split + schema codec split | ✅ complete |
| MEMORY-01..03 | repository, recognition, import | ✅ complete |
| SESSION-01 | session behind data-only contracts | ✅ complete |
| GRAPHICS-01..04 | projectIo, correspondence, basemap, export | ✅ complete |
| GRAPHICS-04A, 05 | alignment panel, route shell ≤100 lines | ❌ **never started** |
| STITCH-01..04 | intake, crop, placement, result handoff | ✅ complete |
| STITCH-04A, 05 | Konva scene adapter, route shell ≤100 lines | ❌ **never started** |
| ANNOTATE-01..05 | shared interaction, annotateCourse, annotateRound workspaces | ❌ **never started** |
| CLEANUP-01, VERIFY-01 | remove dead facades, write verification report | ❌ **never started** |

`src/lib/features/` at the branch tip contains exactly three directories: `annotateRound`, `createGraphics`, `stitch`. `annotateCourse` and `annotationShared` **do not exist.** No `docs/architecture/refactor-verification-report.md` exists.

**The campaign stopped short of its own stated goal.** The headline promise — Map Round structurally independent from Annotate Course and course CV — was never delivered. `AnnotationWorkspace.svelte` is still 5,997 lines at the branch tip, byte-identical to base.

The final commit `cd77466` is the tell. It is a docs-only commit that inserts two brand-new tasks (`GRAPHICS-04A`, `STITCH-04A`) and adds this warning to both route-shell tasks:

> *"Do not start by moving the remaining route wholesale: at the GRAPHICS-04 checkpoint it still contained 1,916 lines, so the integrator must first prove the residual … ownership fits bounded modules."*

Four extraction waves took the Create Graphics route from 3,553 → 1,916 lines and Stitch Map from 2,885 → 1,656. Both were still 16–19× over the 100-line target. The author looked at that, wrote down that the remaining step was bigger than planned, and stopped.

## Known failure cases

**In the ratchet itself:**

- **Import detection is a regex, not a parser.** `parseSpecifiers` will happily match an import-shaped string inside a comment, a template literal, or a `.svelte` markup block. It can produce phantom edges and phantom cycles. Nothing in the test suite covers a false positive from a commented-out import.
- **`BASE_SHA` is hardcoded in three places** (`check-architecture.mjs`, `baseline.json`, two docs) and never verified against the actual repo. The checker prints it and compares nothing to it. If the baseline drifts from the SHA it claims, nothing notices.
- **Rename = reset.** Baseline entries are keyed by exact path. `git mv` an oversized grandfathered file and it becomes "new", instantly failing the 600-line rule — which is arguably correct, but is a hard stop mid-refactor with no escape hatch except an allowlist entry that requires review. The absence of `--accept-current` is a feature until it isn't.
- **Line count is a proxy that the policy itself admits can be gamed.** The anti-gaming rule ("no minification, no merged statements, no meaningless one-function files") is prose in a markdown file. Zero enforcement.
- **`other` is unguarded.** Anything not under a recognized prefix has no direction rules at all. At base SHA that was most of `src/lib`. A file can dodge every rule by living in the wrong folder — the checker rewards path hygiene, not actual coupling.

**In the architecture as executed:**

- **`public.ts` became the barrel it was forbidden to be.** `dependency-rules.md`: *"A `public.ts` may export only the contract needed by consumers; it is not a convenience barrel."* `src/lib/features/stitch/public.ts` is 62 lines and re-exports ~35 symbols including 11 straight pass-throughs from `$lib/stitch/geometry`, plus `cvMatch`, `smartImport`, `analysis`, `render`, `pipelineResult`, and `pipelineUiHelpers`. It is a barrel with a comment explaining why it is a barrel. **The checker cannot detect this** — it only checks that the *path* ends in `/public`, never what the file contains.
- **Mechanical extraction silently changed behavior at least once.** Commit `92e1316` (`fix: preserve course sync after project save`): during GRAPHICS-01, `editor.markSaved()` and the `onSaved` callback were both moved inside the "clean save" branch. That dropped the Course Memory sync side-effect whenever an edit landed during an async save. Caught only because a characterization test existed. **This is the argument for characterization tests before extraction, and it is the campaign's own best evidence.**
- **The campaign's baseline test suite was already red.** 36 failures across 5 annotation test files at base SHA, honestly recorded rather than papered over. But it means "did the refactor break anything?" was never answerable for the annotation surface — which is precisely the surface the campaign never reached.
- **`npm run test:unit` was never stably run.** `refactor-baseline.md` records nine Vitest fork-worker startup timeouts under concurrent load and calls the full suite *"Inconclusive/fail … not a stable correctness baseline."*

**Occlusion / bounding boxes / negative evidence — explicitly called out:**

The catastrophic pattern (a square bounding box around a trophy-shaped basket sprite swallows a nearby tee pad → an inspector concludes "no tee here" → correct code gets deleted) is a *detection* failure, and **this branch contains no detection code.** `basketOcclusionRecovery.ts` and `teeOcclusionRecovery.ts` are in the frozen baseline, untouched.

But this branch does something structurally relevant that a rebuilder should not lose:

**It puts a type-level firewall between "we know a tee is here" and "a detector saw a tee here."** `src/lib/domain/course/index.ts`:

```ts
export interface GeometryEndpoint {
  /** Semantic endpoint inferred from product understanding; present even when detector evidence is absent. */
  readonly semantic: Authoritative<SourceImagePoint>;
  /**
   * Optional detector-visible or CV-visible coordinate for this endpoint.
   * Its absence must not block semantic modeling.
   */
  readonly evidence?: Authoritative<SourceImagePoint>;
}
```

`semantic` is **required**. `evidence` is **optional**. The domain cannot express "no detector evidence, therefore no tee" — the shape does not permit that inference. `refactor-campaign.md` states it in words: *"A semantic tee or target may exist even when a detector-visible marker does not."* And `src/lib/domain/round/index.ts` gives the same idea a name: `EndpointEvidenceState = 'observed' | 'semantic-only' | 'ambiguous' | 'missing'` — four states where a boolean would have been the bug.

Reinforcements elsewhere on the branch:

- `refactor-campaign.md` §3: *"No persistence codec may silently infer confidence, missing coordinates, course identity, layout identity, or transforms."*
- `refactor-campaign.md` §1: *"CV returns candidates/results. Application code decides whether to apply them to authoritative state."*
- `courseRecognition.ts` returns `{ rankedCandidates, recommendedLayoutId, abstained }` — **every evaluated candidate is returned including rejected ones, with its evidence**, and abstention is a first-class result rather than an empty array. *"Failure or abstention never blocks explicit layout selection and loading."*
- `importCourseMemory.ts` carries `preserveManualValues` (defaults `true`) and stamps every field with `CourseMemoryValueOrigin = 'imported' | 'preserved-manual' | 'existing' | 'missing'`. §4: *"never allows later automation to overwrite a human correction."*

**These four ideas are the most transferable content on the branch, and they are one paragraph of prose plus twelve lines of type declarations.**

## What proves it works

**For the ratchet: real, self-contained proof.** `tests/unit/architectureRatchet.test.ts`, 129 lines, 12 cases, every one building a throwaway `mkdtemp` tree and running the real `analyze`/`baselineFrom`/`run` against it. No mocks, no fixtures checked in, no dependence on the actual `src/`. Covers: new >600-line file fails; grandfathered growth by one line fails; domain→feature import fails; domain→`node:crypto` fails; domain→`coords`/`geometry/` is *allowed*; cross-feature private import fails; duplicate forbidden triples dedupe to one; new cycle fails; route→`$lib/domain` fails; route→`./$types` is *allowed*; malformed allowlist entry fails; `$lib` alias resolves. Both the failing and the permitted directions are asserted — that is unusually good discipline for a lint script.

**For the domain models: adequate.** `domainDiscGolf.test.ts` (55 lines), `domainCourse.test.ts` (148), `domainRound.test.ts` (101), `legacyRoundAdapter.test.ts` (205). `spark-dag.md` names the specific cases required: ace = one throw / zero landing points; three-throw completed hole = three throws / two landings with one final holed-out throw; non-18-hole and partial-geometry courses; zero-or-more corridor bends. These are property statements, not sample-fit.

**For the extracted controllers: characterization only, and the browser proofs never ran.** `persistenceFacade.test.ts` (134), `sessionContracts.test.ts` (164), `courseMemoryImport.test.ts` (190), `courseMemoryRepository.test.ts` (66), `courseRecognition.test.ts` (69), `createGraphicsProjectIo.test.ts` (82), `stitchGeometry.test.ts` (57), `stitchPipeline.test.ts` (45), `stitchRender.test.ts` (54). `spark-dag.md` demands focused Playwright proof for every Red task (`tests/e2e/correspondence.spec.ts`, `stitchMap.spec.ts`, `annotateCourse.spec.ts`). **No e2e spec files were added or changed by any commit in the campaign range.** Whether the browser proofs were run and simply not committed is unknown; no Review Brief, checkpoint report, or verification report exists on the branch.

**Evidence images: nothing.** Zero rendered images, zero screenshots, zero CV gallery output. This is correct — the work makes no perceptual claim. The only numbers it claims are line counts and violation counts, both of which the checker recomputes from source on every run. That is a genuinely self-verifying form of evidence, and it is the right shape for the claim being made.

**No overall verification.** VERIFY-01 never ran. No end-of-campaign "everything still passes" record exists.

## Regeneration notes

### For `D:/LAB/ChainSpot`, the rebuild

Context that decides most of this: the rebuild already quarantined the old app into `old-stuff/`, moved the algorithm into a real npm workspace at `packages/alg`, and currently has ~13 files in `src/lib` and 4 entries in `src/routes`. **The zone taxonomy this branch enforces — `domain` / `features` / `infrastructure` / `shared` — does not exist in the rebuild, and there is nothing there yet that needs it.**

But the rebuild is not immune. Today:

```
1113  src/routes/+page.svelte
 634  packages/alg/src/detectors/threeFactor/measure.ts
 609  packages/alg/src/detectors/threeFactor/endpoints.ts
 604  src/routes/lab/+page.svelte
```

A 1,113-line route file, from a clean-room rebuild, already. The godfile is regrowing from zero. **That, not the old app's 5,997-line workspace, is the argument for taking anything from this branch.**

### Must get right

1. **Semantic-vs-evidence separation, if any domain types get written.** `semantic` required, `evidence` optional, and a named multi-state evidence enum rather than a boolean. Twelve lines. Copy the *idea*; the types themselves are trivial to retype and are shaped for the old app's `ProjectState`.
2. **"CV returns candidates; application code decides."** Recognition returns *all* ranked candidates with evidence, plus an explicit `abstained` flag, and abstention never blocks a manual choice. This is the same rule as the semantic/evidence split, applied at a call boundary.
3. **Human corrections are never overwritten by automation**, and every field carries an origin label saying who wrote it. `preserveManualValues` defaults to `true`.
4. **Characterization tests before extraction, not after.** Commit `92e1316` is the receipt. A "purely mechanical" move dropped a side effect and only a pre-existing test caught it.
5. **Record the baseline mechanically, and forbid the implementer from curating it.** *"The implementer may not choose which findings to omit."* If a debt-freezing snapshot is hand-picked, it is a wishlist, not a baseline.
6. **No `--accept-current` mode.** The single most important design choice in the checker. Every ratchet tool that ships an "update baseline" flag becomes a formality within a quarter.
7. **Ship a red baseline honestly.** `refactor-baseline.md` records 36 pre-existing test failures and nine flaky worker timeouts and refuses to call the suite a correctness baseline. That paragraph is worth more than the checker.

### May freely change

- **Every threshold.** 600 / 400 / 300 / 100 are all UNKNOWN in derivation. Pick numbers that fit the rebuild's actual file-size distribution and write down why.
- **The zone taxonomy.** `domain`/`features`/`infrastructure`/`shared` was designed for a 20k-line SvelteKit app with two conjoined annotation modes. The rebuild's real seam is already `packages/alg` (pure, framework-free, testable) versus `src` (Svelte app). That is one boundary instead of five, and it is enforced by the package manifest rather than by a script.
- **The whole SparkStorm/Spark-DAG process layer.** Owned/forbidden file globs, hot-file reservations, colored risk classes, the Sol/Terra role split — this is scaffolding for parallel agents editing one repo. Useful *only* if that is how the rebuild is being worked. It maps naturally onto SHH/sushh wave gating if it is.
- **The regex import scanner.** If the rebuild ever wants this, `ts-morph`, `dependency-cruiser`, or `eslint-plugin-boundaries` all do the import-direction and cycle half properly, with a real parser. The only piece worth hand-rolling is the **size ratchet with a mechanically captured, non-rewritable baseline** — that specific behavior is not something off-the-shelf tools do well.
- **All 26 commits of code.** Every file moved. Nothing ports.

### Do NOT do

- **Do not port `baseline.json`.** 531 lines describing files that do not exist in the rebuild. It is a fossil.
- **Do not adopt the ratchet before there is something to ratchet.** Freezing a baseline over a 19k-line codebase mid-rebuild locks in whatever mess happens to exist today, and the escape hatch is deliberately painful.
- **Do not re-derive confidence from this branch's constants.** The moved constants (300m NAIP radius, 0.9 box fraction, 128px min box, 24/8/8 crop zoom) were carried at face value with no re-measurement. A tidier folder is not validation.
- **Do not treat "the architecture doc is frozen" as "the architecture was delivered."** Two-thirds of the plan never ran.

## Verdict

**Partially worth it — take about 300 words of it and discard 10,000 lines of code.**

Worth regenerating, as ideas rather than files:

- The **semantic-vs-evidence firewall** (`semantic` required, `evidence` optional, four-state evidence enum, "CV returns candidates, application decides", human corrections protected with origin labels). This is the direct structural antidote to the delete-correct-code failure mode, it costs a dozen lines of types plus a paragraph of prose, and it is the only content here that touches what ChainSpot actually does.
- The **ratchet's design stance**: mechanical non-curated baseline, no accept-current escape hatch, exceptions in a separately-hashed file printed on every run, existing debt shrinks-only.
- The **honest-red-baseline discipline** from `refactor-baseline.md`.

Discard:

- All 79 changed files. Every path moved; nothing merges.
- `baseline.json`, the zone taxonomy, and the 600/400/300/100 thresholds — all fitted to an app that has been quarantined.
- The Spark DAG's 25 task cards, unless the rebuild is being worked by parallel agents on one tree.

The blunt part: **this branch is a well-designed campaign that did not finish.** It froze a good architecture, built a genuinely good enforcement tool with genuinely good tests, decomposed persistence and session cleanly, then discovered at the fourth wave that the route files were still 16–19× over target — and stopped, having never touched the 5,997-line file that motivated the entire effort. A rebuild that already deleted that file has *already collected the payoff this campaign was chasing*, at zero cost, by starting over.

The one thing the rebuild has not solved is **recurrence** — `src/routes/+page.svelte` is at 1,113 lines from a clean start. If that bothers anyone enough to act, rebuild the ratchet from this description in an afternoon with a fresh baseline and honest thresholds. Do not port it.
