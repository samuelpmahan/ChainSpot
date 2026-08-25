# AUDIT — completeness pass over `docs/unported`

**Date:** 2026-08-25 · **Lens:** completeness. One question only: *what knowledge is still trapped
only in code or files on the C: drive, and would be lost if those checkouts vanished tonight?*

**Result: 13 genuine gaps.** Three of them are not omissions but **false negatives** — a spec
affirmatively states that something does not exist, when it does, on disk, right now. Those are the
most damaging kind, because a reader who trusts the spec will never go look.

Two dimensions came back **clean**, and that is recorded in the last section rather than padded into
the gap list.

Every gap below carries the exact command that recovers the missing knowledge. Commands are written
for **PowerShell**, because `git show <ref>:.task/<file>` gets its path mangled by Git Bash's MSYS
path conversion (the `.task` leading dot triggers it); where a `.task` file is involved the command
uses `git cat-file blob` against a pinned blob SHA instead.

---

## The three most urgent

### GAP 1 — `dsh-fountain-hills.md` says the inputs and outputs are gone. They are not. They are in an orphaned, unversioned directory that git cannot see.

`dsh-fountain-hills.md` lines 196–199 state:

> the runner writes `metrics.json`, `intake.tsv`, `FINDINGS.md`, and every overlay, badge, circle,
> support-heatmap and path PNG into a **gitignored** directory. That directory does not exist on
> disk. Neither does `.fountain-hills-input/` (also gitignored), so the four source captures are gone
> too. Nor `dev_middleout_output/`. Nor `.wheels/`.

All of it exists, at `C:/Users/tenni/workspace/ChainSpot-dsh-fountain-hills`:

| Thing the spec says is gone | Actual state |
|---|---|
| results directory | `scripts/cv-probes/middleout/fountain-hills-results/` — **20 files, 16 rendered evidence PNGs** (`*_badges.png`, `*_circles.png`, `*_path.png`, `*_support.png` for all four captures), written 2026-08-18 15:00–15:01 |
| `FINDINGS.md` | present, 2,707 bytes |
| `metrics.json` | present, 9,158 bytes |
| `intake.tsv` | present, 387 bytes |
| `.fountain-hills-input/` | present — all four source captures, byte-present |
| `.wheels/` | present |
| `dev_middleout_output/` | **genuinely absent** — this one part of the claim holds |

Why the extractor missed it: **the directory is an orphaned worktree.** Its git admin directory was
pruned, so `git -C ChainSpot worktree list` does not list it and `git -C ChainSpot-dsh-fountain-hills
rev-parse HEAD` fails with `fatal: not a git repository:
C:/Users/tenni/workspace/ChainSpot/.git/worktrees/ChainSpot-dsh-fountain-hills`. The files are real;
git has no idea they are there. **Nothing tracks them, nothing backs them up, and one `rm` ends
them.** This is the single most fragile knowledge on either disk.

The damage is not just missing files. `FINDINGS.md` contains exactly the quantitative record that
`dsh-fountain-hills.md` line 200–202 says was never recorded ("there is no recorded number anywhere
for how well MiddleOut performed"). Per capture, it has gray mean, dark-fraction, the **badge
threshold sweep at 40/50/60/70** (the brightness-sensitivity measurement the whole CHSPT-58 probe
existed to produce), fitted C1 radius, circle ratio, fit score, bandness coverage, and runtime. For
instance `FountainHills-1.PNG` selects only **10** badges and its sweep reads `{40:29, 50:27, 60:21,
70:21}` — badge yield *falls* as the threshold rises, which is a real finding about that capture that
appears in no spec.

This wrong claim propagates: it sets `dsh-fountain-hills.md`'s Verdict, README **decision 21**
("Re-capture Fountain Hills, or drop it from scope?"), and README **regeneration order step 14**
("zero surviving evidence; revisit only after re-capturing inputs"). All three should be re-ruled.

The inputs also survive a *second* time, in a pushed repo, so at least the capture side is safe:
`chainspot-corpus/validation/FountainHills/clean/` (`Fountain Hills-lazy.PNG`, `FountainHills-1.PNG`,
`FountainHills-2.PNG`, `FountainHills-full.PNG`), remote `https://github.com/samuelpmahan/chainspot-corpus.git`.

**Recover with:**

```powershell
$d = "C:/Users/tenni/workspace/ChainSpot-dsh-fountain-hills"
Get-Content "$d/scripts/cv-probes/middleout/fountain-hills-results/FINDINGS.md"
Get-Content "$d/scripts/cv-probes/middleout/fountain-hills-results/metrics.json"
Get-Content "$d/scripts/cv-probes/middleout/fountain-hills-results/intake.tsv"
Get-ChildItem -Recurse "$d/scripts/cv-probes/middleout/fountain-hills-results"
Get-ChildItem -Recurse -Force "$d/.fountain-hills-input"
# and copy the whole thing OFF this machine before anything else:
Copy-Item -Recurse "$d/scripts/cv-probes/middleout/fountain-hills-results" <somewhere-backed-up>
```

---

### GAP 2 — `refactor-separation-of-concerns.md` says "Worktree is clean — nothing is sitting dirty." It is not clean. ~579 lines of the campaign's final step are sitting uncommitted.

`refactor-separation-of-concerns.md` line 7 states, in the Source section, **"Worktree is clean —
nothing is sitting dirty."** The worktree at
`C:/Users/tenni/Documents/Codex/2026-08-16/you-are-sol-lead-architect-for` (branch
`refactor/separation-of-concerns`, HEAD `cd77466`) is dirty:

```
 M src/lib/features/createGraphics/public.ts                    (+8)
 M src/lib/features/stitch/public.ts                            (+5)
 M src/routes/create-graphics/+page.svelte                      (171 changed, mostly deletions)
 M src/routes/stitch-map/+page.svelte                           (395 changed, mostly deletions)
?? src/lib/features/createGraphics/application/alignmentModel.ts        1,988 bytes
?? src/lib/features/createGraphics/components/AlignmentPanel.svelte     2,996 bytes
?? src/lib/features/stitch/application/manualSceneAdapter.svelte.ts    12,935 bytes
```

Net `+70 / −509` across the tracked files, against 17,919 bytes of brand-new untracked source. The
mtimes are 2026-08-17 11:48:07 → 11:58:12 — i.e. immediately after the last commit `cd77466`
(*"docs(architecture): gate final route shells"*). This **is** the route-shell gating: the two fat
route files being emptied into three new application-layer modules. It is the campaign's actual final
step, and it is the one part of the campaign that has no commit, no push, and no spec.

That makes it strictly worse-preserved than the 26 committed commits the spec describes at length.
`uncommitted-work.md` does not cover it either — see GAP 3.

**Recover with:**

```powershell
$w = "C:/Users/tenni/Documents/Codex/2026-08-16/you-are-sol-lead-architect-for"
git -C $w status --porcelain
git -C $w diff
Get-Content "$w/src/lib/features/createGraphics/application/alignmentModel.ts"
Get-Content "$w/src/lib/features/createGraphics/components/AlignmentPanel.svelte"
Get-Content "$w/src/lib/features/stitch/application/manualSceneAdapter.svelte.ts"
```

---

### GAP 3 — `uncommitted-work.md` covers three dirty worktrees. There are five.

The spec's scope is `ChainSpot-chspt-82`, `ChainSpot-demo`, `ChainSpot-clickfix-ab`. A sweep of every
worktree finds two more, both carrying real work:

| Worktree | Branch | Dirty content | Covered? |
|---|---|---|---|
| `C:/Users/tenni/workspace/ChainSpot-chspt-82` | `integration/claude-t1-t6` | 3 M + 4 ?? | yes (tree A) |
| `C:/Users/tenni/workspace/ChainSpot-demo` | `demo/mock-engine` | 7 M + 6 ?? | yes (tree B) |
| `C:/Users/tenni/workspace/ChainSpot-clickfix-ab` | `codex/ab-local-snap-clickfix` | 5 M | yes (tree C) |
| `C:/Users/tenni/Documents/Codex/2026-08-16/you-are-sol-lead-architect-for` | `refactor/separation-of-concerns` | 4 M + 3 ?? | **NO** — GAP 2 |
| `C:/Users/tenni/Documents/Codex/2026-08-16/how-would-i-set-this-machine/ChainSpot-rec-demo` | `codex/rec-demo-18x18` | 1 M + `artifacts/` (72.5 MB) | **NO** — GAP 4, GAP 5 |

Plus two *orphaned* trees invisible to `git worktree list`, which no sweep based on that command will
ever surface: `ChainSpot-dsh-fountain-hills` (GAP 1) and `ChainSpot-teefamily` (GAP 9). And one
WSL-origin orphan, `.../ChainSpot-rec-demo-wsl` (admin dir points at `/home/mahansa/...`).

The lesson for anyone re-running this extraction: **`git worktree list` is not a complete inventory
of working trees on this machine.** Enumerate directories and test each one.

**Recover with:**

```powershell
# every worktree git knows about, plus dirt
git -C "C:/Users/tenni/workspace/ChainSpot" worktree list --porcelain |
  Select-String '^worktree ' | ForEach-Object { $_.ToString().Substring(9) } |
  ForEach-Object { $s = git -C $_ status --porcelain 2>$null; if ($s) { "### $_"; $s } }
# the orphans git does NOT know about
Get-ChildItem "C:/Users/tenni/workspace","C:/Users/tenni/Documents/Codex" -Recurse -Depth 3 -Directory `
  -Filter "ChainSpot*" | ForEach-Object { "$($_.FullName) -> $(git -C $_.FullName rev-parse --short HEAD 2>&1)" }
```

---

## The rest, most damaging first

### GAP 4 — 72.5 MB of per-stage rendered evidence images exist, and no spec knows about them.

README §5 item 6 says of essentially every accuracy figure: *"unreproduced source claim with **zero
rendered evidence images**."* Under
`C:/Users/tenni/Documents/Codex/2026-08-16/how-would-i-set-this-machine/ChainSpot-rec-demo/artifacts/rec-baseline/`
there are **13 PNGs totalling 72.53 MB**, in two complete runs (`single/` and `stitch-detection/`),
named exactly for the pipeline stages:

`tee-raw.png` → `tee-deduped.png` → `tee-assigned.png`, and `basket-raw.png` → `basket-assigned.png`,
plus `course.png` and a 7.3 MB `stitch.png`.

Alongside them: `course.json` (105 KB / 121 KB), `activeReview.json` (22 KB / 19.5 KB), a 121 KB
`stitch-detection.log`, and a `summarize.mjs` that reads `result.counts`, `result.teeBootstrap`, and
`result.teeStages.deduped` filtered by `candidate.nearestBadge`.

That log matters beyond the images. It carries **per-candidate rejection testimony** — entries
including `"reason": "needs-manual-placement"` and a `nearestBadge` field per candidate. README
regeneration **step 3** says the whole point of that step is that *"you cannot tune, or even argue
about, a gate that answers '0 tees' without saying which predicate killed which candidate."* A
worked, real-image instance of exactly that testimony already exists and was never opened.

All of it is untracked and in no git object anywhere. `stitch-overfit.log` also records a real
negative result worth keeping: `No tee truth available. Provide a .chainspot.zip with holes[].tee, or
pass --truth <bundle>.`

**Recover with:**

```powershell
$a = "C:/Users/tenni/Documents/Codex/2026-08-16/how-would-i-set-this-machine/ChainSpot-rec-demo/artifacts/rec-baseline"
Get-ChildItem -Recurse $a | Select-Object FullName, Length, LastWriteTime
Get-Content "$a/stitch-detection.log"          # per-candidate reasons + nearestBadge
Get-Content "$a/single/course.json" | ConvertFrom-Json | Select-Object counts, teeBootstrap
Get-Content "$a/summarize.mjs"
Copy-Item -Recurse $a <somewhere-backed-up>    # nothing in git holds these
```

---

### GAP 5 — `codex/rec-demo-18x18` is a local-only branch that no spec names, and it is the branch holding GAP 4.

Nine branches exist locally with **no remote counterpart** — these are the ones that die with the
disk. Eight are covered by a spec. This one is not:

```
codex/ab-local-snap-clickfix   ebbc61d  2026-08-22   covered (uncommitted-work, tree C)
codex/rec-demo-18x18           4308c60  2026-08-16   *** NOT COVERED ***
demo/mock-engine               0850f75  2026-08-23   covered (uncommitted-work, tree B — dirt only)
dsh/fountain-hills-pro-…       019089f  2026-08-18   covered
engine/dev72                   6c1ce4e  2026-08-24   covered
integration/claude-t1-t6       0615c93  2026-08-23   covered
lab/dev72-algorithm            eb5be4d  2026-08-24   covered
lab/render-evidence            b2d9e33  2026-08-24   covered
refactor/separation-of-concerns cd77466 2026-08-17   covered (commits only — see GAP 2)
```

Its SHA `4308c60` *is* cited — three times in `refactor-separation-of-concerns.md`, as the refactor
campaign's hardcoded base SHA. But nobody records that `4308c60` is the tip of a named branch with 12
unique commits and its own subject matter: the **CHSPT-48 GuidedReview interaction contract**. Its
unique files versus `main` are `AGENTS.md`, `CLAUDE.md`, `src/lib/components/AnnotationWorkspace.svelte`,
and `tests/unit/annotateCourseKeyboardReview.test.ts` — a pinned interaction contract for the same
guided-review surface that `uncommitted-work.md` tree B reworks from scratch. Anyone regenerating tree
B's reducer should read this test first; it is the prior contract they are about to break.

**Recover with:**

```powershell
$r = "C:/Users/tenni/workspace/ChainSpot"
git -C $r log --oneline main..codex/rec-demo-18x18
git -C $r diff --name-only main...codex/rec-demo-18x18
git -C $r show "codex/rec-demo-18x18:tests/unit/annotateCourseKeyboardReview.test.ts"
git -C $r diff main...codex/rec-demo-18x18 -- src/lib/components/AnnotationWorkspace.svelte
```

---

### GAP 6 — the producers README says were "searched for and not found" are on disk, and the DashsTrack 18/18 scoreboard is attributed to the wrong pipeline.

Two linked problems.

**(a) The producers exist.** README §5 item 6 lists figures whose *"producers … were searched for and
not found."* `old-stuff/` — **658 files** — carries them:

| Path (on `engine/dev72`) | Size |
|---|---|
| `old-stuff/scripts/toph-corpus-gate.ts` | 18,892 B |
| `old-stuff/scripts/toph-corpus-gate.md` | 7,371 B |
| `old-stuff/scripts/pancake-harness.ts` | 6,942 B |

`old-stuff/` is absent from `main` but present on `engine/dev72` **and on three remotes**
(`origin/lab/abf-hardening`, `origin/codex/chspt-82-3fd72-frozen-parity`,
`origin/samuelpmahan/chspt-82-frontend-rebuild-…`), so it survives a machine reset — but it was never
mined, and README §5 item 22's un-opened
`old-stuff/scripts/cv-probes/corridor-evidence-grid-results-ts/hole-11-basket-near-neighbor-tee-leakage-risk-.png`
lives in the same unexplored tree. That filename names the project's own trophy-basket-bbox-swallows-tee
hazard and is still unopened.

**(b) `ASSOCIATION_TOLERANCE_PX = 26` has no recorded home.** README §4 and
`engine-dev72-lineage.md:239` both give the value and say it *"silently sets every reported accuracy
number in T2 and T3"*, and README regeneration **step 4** demands a ruling on it — but neither says
which file to open. It is defined in four places, and the canonical one is:
`old-stuff/scripts/toph-corpus-gate.ts:45`. The other three
(`scripts/chainspot-lab/sweep/truthScoring.ts:17`, `tests/unit/corpusSweep.test.ts:66`,
`tests/unit/dashsTrackSweep.test.ts:54`) are all copies that say so.

**(c) The scoreboard is mis-sourced.** `engine-dev72-lineage.md:254` records
`DashsTrack scoreboard | G1 18/18, G2 18/18, G3 18/18, G4 18/18 | labSweep.test.ts`. The header of
`tests/unit/dashsTrackSweep.test.ts` — 38 lines of unusually careful provenance prose — says the
opposite in as many words: the historical *"DashsTrack exactly 18/18 t18/18 b18/18"* and *"26px
association tolerance"* figures come from **the OLD pre-rebuild pipeline** (`pancake-harness.ts` +
`toph-corpus-gate.ts` driving `src/lib/autoAnnotation/basketDetection.worker.ts` and
`src/lib/nuthing/*`), **not** from the threeFactor engine, and this test is *"the NEW threeFactor
engine's FIRST-EVER scoring run against DashsTrack's frozen corpus truth."* That header also records
the discipline the rebuild should inherit — `test.fails` for true-but-failing assertions rather than
loosening or silently skipping them, `test.todo` for G5 because no validated path truth exists, and
an explicit note that G1 digit truth relies on `invariants.ts` ~line 485 ("each numbered badge owns
one tee and one basket") rather than on separately-annotated digits.

**Recover with:**

```powershell
$r = "C:/Users/tenni/workspace/ChainSpot"
git -C $r grep -n "ASSOCIATION_TOLERANCE_PX" engine/dev72
git -C $r show "engine/dev72:old-stuff/scripts/toph-corpus-gate.md"
git -C $r show "engine/dev72:old-stuff/scripts/toph-corpus-gate.ts"
git -C $r show "engine/dev72:old-stuff/scripts/pancake-harness.ts"
git -C $r show "engine/dev72:tests/unit/dashsTrackSweep.test.ts"     # read the 38-line header
git -C $r ls-tree -r --name-only engine/dev72 -- old-stuff/          # 658 files, never mined
```

---

### GAP 7 — five `.task/PORT-*.md` handoff briefs are the primary sources for two specs, and neither spec cites them.

The `codex/ab-*` branches each carry a handoff brief that is the *specification the port was written
against*. Ten exist; **five are cited by no spec**:

| Brief | Blob SHA | Size | Cited? |
|---|---|---|---|
| `.task/PORT-TBS-FOUR-LANE-SENSOR.md` | `d9e7284fd81262df5ffbf0d1e029213fda3945e5` | 4,978 B | **no** |
| `.task/PORT-TBS-ORIENTED-RAILS.md` | `1cd39af4def90fbfe5ba32e2fd803874dc3c717e` | 4,511 B | **no** |
| `.task/PORT-TBS-COURSE-WIDTH.md` | `f85b535967079f670a15785e0bab713399126c3d` | 4,968 B | **no** |
| `.task/PORT-TBS-BADGE-TRANSIT.md` | `3157c508295be8d5f27373865667f5896764b192` | 4,009 B | **no** |
| `.task/PORT-TBS-MIN-REQUIRED-RUN.md` | `241e23338746bae51785371fe495d623c843d99e` | 4,871 B | **no** |
| `.task/PORT-G3-INTACT-TEE-FAMILY.md` | `2b427606c2df3264771ced70541fe895207bb859` | 5,885 B | yes |
| `.task/teefamily-recon-brief.md` | `310b8311d3dbdffad20e4a47837ab6c510e6f21b` | 5,721 B | yes |
| `.task/PORT-G2-CLEAN-BASKET-FAMILY.md` | `52261a4acd2b4937e980630a61ccdc05ff68bcf1` | 5,689 B | yes |
| `.task/PORT-TBS-MATERIAL-MAP.md` | `286ffd5150d204e3e5db6a59524fda5dce61e219` | 4,306 B | yes |
| `.task/PORT-TBS-COMPOSITE-RESIDUAL.md` | `9913def3e1beab4fe97c1f0645146efaead1511c` | 5,880 B | yes |

The five uncited ones back `fourlane-sensor-cluster.md` and `tbs-primitives.md`, and they contain
material those specs do not carry verbatim — the *exact* study math, plus the rulings that explain the
spec's own UNKNOWNs. From `PORT-TBS-ORIENTED-RAILS.md`: `theta = i*pi/24, i=0..23`; rail sample
offsets `±(W/2 − 2.5)` and `±(W/2 + 2.5)`; the signed axial delta `d = ((theta − H + pi/2) mod pi) −
pi/2`; the nine-component doubled-angle output vector; the explicit knob-ownership ruling ("`edgeDeltaPx`
and `liftReference` come only from the stacked `fourLaneSensorFeature`; this feature owns only
`orientationCount = 24`"); and the provenance verdict **SPECIFICATION-DERIVED** with the reason —
*"no raw implementation of the specified 24-angle producer was located; this is not a source
reproduction."* That last line is the direct answer to README **decision 15**, and the fixture
correction note ("the initial synthetic fixture placed W=40 rail samples at the wrong y coordinates;
correcting it … made the tests pass without changing implementation math") is the one recorded
instance of these constants being checked against anything.

Note also that `engine/dev72` carries **shorter, divergent** versions of four of these briefs
(`PORT-G3-INTACT-TEE-FAMILY.md` 2,694 B vs 5,885 B; `PORT-TBS-FOUR-LANE-SENSOR.md` 2,451 B vs 4,978 B;
`PORT-TBS-MATERIAL-MAP.md` 2,397 B; `PORT-TBS-COMPOSITE-RESIDUAL.md` 2,878 B). Two versions of the
same contract exist and no spec says which is authoritative.

These are on pushed remotes, so they survive a disk loss — the gap is that the specs do not point at
them, so a rebuilder working only from `docs/unported` never learns they exist.

**Recover with** (blob SHAs, because `git show <ref>:.task/…` is mangled by Git Bash):

```powershell
$r = "C:/Users/tenni/workspace/ChainSpot"
git -C $r cat-file blob d9e7284fd81262df5ffbf0d1e029213fda3945e5   # FOUR-LANE-SENSOR
git -C $r cat-file blob 1cd39af4def90fbfe5ba32e2fd803874dc3c717e   # ORIENTED-RAILS
git -C $r cat-file blob f85b535967079f670a15785e0bab713399126c3d   # COURSE-WIDTH
git -C $r cat-file blob 3157c508295be8d5f27373865667f5896764b192   # BADGE-TRANSIT
git -C $r cat-file blob 241e23338746bae51785371fe495d623c843d99e   # MIN-REQUIRED-RUN
# and to see the divergent short versions on engine/dev72:
git -C $r ls-tree -r --long engine/dev72 -- .task/
```

---

### GAP 8 — the campaign contracts `.task/CHSPT-82.md` and `.task/CODEX-TICKETS.md` are cited by no spec, and each exists in two divergent versions.

| File | On `codex/ab-*` | On `engine/dev72` |
|---|---|---|
| `.task/CHSPT-82.md` | `29f673aa…` 12,266 B | `9e158911…` **17,515 B** |
| `.task/CODEX-TICKETS.md` | — | `da710ad2…` 6,335 B (and `7982d747…` 5,102 B on `codex/heritage-g3-threshold-audit`) |

`CHSPT-82.md` is the contract every branch in the port family was written against, and the engine
version is 5 KB longer than the one the codex branches carried — meaning the ticket grew *after* the
ports forked, and the ports were built against the older text. `CODEX-TICKETS.md` is the five-lane
work split that produced T1–T6, which `engine-dev72-lineage.md` describes structurally without ever
citing the document that defines it. `refactor-separation-of-concerns.md` and `dsh-fountain-hills.md`
both cite their tickets (`CHSPT-67.md`, `CHSPT-58.md`); the CHSPT-82 family does not.

**Recover with:**

```powershell
$r = "C:/Users/tenni/workspace/ChainSpot"
git -C $r cat-file blob 9e158911ccbbe921ecaf7c5d61dc8216e841dec2   # CHSPT-82, engine/dev72 (17,515 B)
git -C $r cat-file blob 29f673aaeacd4063c19eed73cc234efc8870226a   # CHSPT-82, codex/ab-* (12,266 B)
git -C $r cat-file blob da710ad21c0e7fca5b4410843dae63d5fd2f53e7   # CODEX-TICKETS, engine/dev72
git -C $r cat-file blob 7982d7472f482e2f6be883806755a6b24aa47031   # CODEX-TICKETS, heritage audit
```

---

### GAP 9 — `all-deviations-on.json` exists in no git object anywhere on this machine, and it fixes an execution order that is a real design decision.

`C:/Users/tenni/workspace/ChainSpot-teefamily` is a 127-file working tree (excluding `node_modules`)
with **no `.git` at all** — not a worktree, not a clone, just loose files. Its newest file, written
2026-08-23 02:36:57, is
`src/lib/detectors/threeFactor/configs/all-deviations-on.json`, and `git log --all -- "**/all-deviations-on.json"`
returns nothing: **this file is in no commit on any branch, local or remote.**

It is the combined-deviations stress config — every deviation ABFeature on at once — and it pins an
execution order that appears in no spec:

```json
"execution": ["badgeStage","badges","supportField","badgeOcclusionPatch","baskets",
              "tees","teeFamily","rawPairs","measurement","assignment","phantomTee"],
"gates": { "G3": { "teeFamily": {"enabled": true}, "phantomTee": {"enabled": true} },
           "G5": { "zfit": {"enabled": true} } }
```

with the note *"teeFamily refines tees right after detection, zfit salvage active in scoring,
phantomTee synthesizes tees for tee-less holes after assignment and re-assigns. The E2E stress config
- NOT a tuned experiment."*

`phantomTee` running **after** `assignment` and re-assigning is exactly the negative-evidence seam
README **decision 3** is about: a synthesized tee filling a hole that G2/G3 rejected. That
interaction has never been written down. The tree also holds a `g3.teeFamily.ts` that differs from the
branch tip (15,761 B local vs 18,330 B at `codex/ab-g3-intact-tee-family`) — possibly only line
endings, possibly a divergent draft; nobody has diffed them.

**Recover with:**

```powershell
$d = "C:/Users/tenni/workspace/ChainSpot-teefamily"
Get-Content "$d/src/lib/detectors/threeFactor/configs/all-deviations-on.json"
git -C "C:/Users/tenni/workspace/ChainSpot" log --all --oneline -- "**/all-deviations-on.json"   # empty = nowhere in git
# is the local teeFamily a real divergence or just CRLF?
git -C "C:/Users/tenni/workspace/ChainSpot" show `
  "codex/ab-g3-intact-tee-family:src/lib/detectors/threeFactor/features/g3.teeFamily.ts" > "$env:TEMP/branch.ts"
git diff --no-index --ignore-cr-at-eol "$env:TEMP/branch.ts" `
  "$d/src/lib/detectors/threeFactor/features/g3.teeFamily.ts"
```

---

### GAP 10 — `origin/codex/ab-g1-dark-plate-primary` is a tenth member of the port family, and no spec mentions it.

The specs cover nine `codex/ab-*` port branches. There are ten. `origin/codex/ab-g1-dark-plate-primary`
has no local checkout, which is presumably why it was missed — every other port branch is checked out
in a worktree under `.../2026-08-23/new-chat-2/work/worktrees/`.

It matters more than its size suggests: **G1 is the badge stage that G2, G3, G4 and every ST feature
depend on.** README regeneration steps 5, 6, 7 and 11 all condition on badge geometry being settled,
and README decision 4 (the −7px vs +3px badge-inset polarity) is a G1-adjacent ruling. A dark-plate
primary detector for G1 is directly in that blast radius.

It is on the remote, so it survives; the gap is that `docs/unported` claims to cover the port family
and silently omits one tenth of it.

**Recover with:**

```powershell
$r = "C:/Users/tenni/workspace/ChainSpot"
git -C $r log --oneline 9a6e4b84ad089099c911b8b1b84923990aace7eb..origin/codex/ab-g1-dark-plate-primary
git -C $r diff --name-only 9a6e4b84ad089099c911b8b1b84923990aace7eb...origin/codex/ab-g1-dark-plate-primary
git -C $r ls-tree -r --long origin/codex/ab-g1-dark-plate-primary -- .task/
```

---

### GAP 11 — regeneration step 2 is "canonical G0 intake", and ten of the twelve G0 source files are named in no spec.

`engine/dev72` contributes 191 unique files past the clean-room base `9a6e4b8`; **113 are named by no
spec** (path or basename). Most of those are `R100` pure renames into `packages/alg/` and carry no new
knowledge. These do:

**G0 (`packages/alg/src/g0/`)** — `engine-dev72-lineage.md:270` names six of twelve in a single table
cell (`g0/{composite,crop,inputAsset,ledger,stitchSolve,truth}`). Unnamed anywhere:
`canonicalFrame.ts`, `projection.ts`, `roundPreRead.ts`, `thrownRound.ts`, `hash.ts`, `types.ts`.
`canonicalFrame.ts` and `projection.ts` are, by name, precisely the raw→crop→canonical frame
discipline that README regeneration step 2 exists to preserve.

**G0 tests** — twelve `tests/unit/g0*.test.ts` files, of which only `g0EvidenceHeritage.test.ts` is
cited. Unnamed: `g0Adapters`, `g0Composite`, `g0Crop`, `g0EvidenceRecTrio`, `g0InputAsset`, `g0Ledger`,
`g0Projection`, `g0RoundPreRead`, `g0StitchSolve`, `g0ThrownRound`, `g0Truth`, and **`g0TruthFirewall.test.ts`**
— that last one being the executable form of the semantic-vs-evidence firewall that
`refactor-separation-of-concerns.md` describes only as a types-level idea.

**exec core** — `engine-dev72-lineage.md` cites `exec/operations.ts` (and `contract`, `experiment`,
`index` appear). Unnamed: `board.ts`, `compile.ts`, `gateway.ts`, `node-sink.ts`, `sink.ts`,
`sha256.ts`. `board.ts` is the evidence board — the very slot README **decision 2** says must be
invented for four ST specs to mean anything.

**sweep helpers** — `sweep/truthScoring.ts` (owns `ASSOCIATION_TOLERANCE_PX`; see GAP 6),
`sweep/configIo.ts`, `sweep/gateVocabulary.ts`, `sweep/timeline.ts`.

**Recover with:**

```powershell
$r = "C:/Users/tenni/workspace/ChainSpot"; $B = "9a6e4b84ad089099c911b8b1b84923990aace7eb"
git -C $r diff --name-status ($B + "..." + "engine/dev72")        # 191 files; R100 = pure move, A = new
git -C $r show "engine/dev72:packages/alg/src/g0/canonicalFrame.ts"
git -C $r show "engine/dev72:packages/alg/src/g0/projection.ts"
git -C $r show "engine/dev72:tests/unit/g0TruthFirewall.test.ts"
git -C $r show "engine/dev72:packages/alg/src/exec/board.ts"
git -C $r show "engine/dev72:scripts/chainspot-lab/sweep/truthScoring.ts"
```

---

### GAP 12 — the deterministic DashsTrack merge oracle is unmentioned, and so are the mock fixtures that let it run without the external corpus.

`engine-dev72-lineage.md:443` describes `labSweep.test.ts` and correctly flags that it is
`describe.skipIf` — *"silently skipped when `../chainspot-corpus` is absent."* What no spec mentions is
the parallel machinery built so a real end-to-end check does not depend on that:

- `tests/unit/dashsTrackSweep.test.ts` (213 lines) — G1/G2/G3/G4 gate-by-gate against frozen truth,
  one memoized engine run, `test.todo` for G5. All four gate assertions currently assert full match.
- `tests/unit/helpers/dashsTrackFixture.ts` — the only place in the repo that decodes a real corpus
  photo into an `RgbaRaster` (the sole reason `jpeg-js` is a devDependency).
- `src/lib/mockBoot.ts` + `tests/unit/mockBoot.test.ts` + `static/mock/dashstrack.json` +
  `static/mock/heritage.json` — the dev-only fixture autoload.
- `tests/unit/corpusSweep.test.ts`, `tests/unit/familyDeviationSweep.test.ts`,
  `tests/unit/helpers/{courseFixture,sweepRender,intakeAutocrop}.ts`.
- `static/fixtures/chainspot-sweep/{manifest.json, receipts.jsonl, renders/…}` — including
  `renders/mask/badgeStage.masks.bright.stub.txt`, a **stub** render fixture, which is the one
  committed artifact that exercises the `summary.endsWith('stub only')` sniff README §4 calls *"the
  worst landmine here."*

`dashsTrackFixture.ts` also pins the corpus contract in prose worth keeping: `chainspot-corpus` must
be a **sibling** of the repo root; `dev/DashsTrack/` and `dev/Annotated/DashsTrack/` are
byte-identical copies and the loader uses the non-`Annotated` path.

**Recover with:**

```powershell
$r = "C:/Users/tenni/workspace/ChainSpot"
git -C $r show "engine/dev72:tests/unit/dashsTrackSweep.test.ts"
git -C $r show "engine/dev72:tests/unit/helpers/dashsTrackFixture.ts"
git -C $r show "engine/dev72:src/lib/mockBoot.ts"
git -C $r show "engine/dev72:static/fixtures/chainspot-sweep/renders/mask/badgeStage.masks.bright.stub.txt"
git -C $r ls-tree -r --name-only engine/dev72 -- static/fixtures/chainspot-sweep/ static/mock/
```

---

### GAP 13 — README decision 23 overstates the binary-corpus risk; the real unpushed binary is a different file.

README §5 item 23 says `TheRec-L.PNG`, `TheRec-R.PNG` and `TheRec-Thrown-full.PNG` *"exist only inside
two dirty worktrees … and cannot be carried by any document here,"* and asks whether the two copies are
byte-identical.

They exist in at least two more places, both inside a **pushed git repo**:
`chainspot-corpus/demo/` and `chainspot-corpus-fountain/demo/` (both remote
`https://github.com/samuelpmahan/chainspot-corpus.git`, both at `7a1fdac`), at 3,844,146 / 3,988,936 /
4,740,039 bytes — matching the sizes README quotes as 3.8 / 4.0 / 4.7 MB. The byte-identity question
is answerable in one command, and the copy-off-the-machine task is largely already done.

What *is* genuinely at risk and unmentioned: `chainspot-corpus` has a **dirty `demo.zip`** (13,137,947
bytes) that is not pushed, and `chainspot-corpus-fountain` is a second checkout of the same repo in
detached HEAD. Also unmentioned: the `dev/` corpus that `dashsTrackSweep.test.ts` and every accuracy
figure in these specs ultimately depend on (`AlexClark`, `DashsTrack`, `Heritage`, `Lenard`,
`NorthPark`, `TowneLake`, plus `Annotated/`) lives only in these sibling repos — no spec records that
the corpus is a separate repo at all, let alone which one.

**Recover with:**

```powershell
Get-FileHash "C:/Users/tenni/workspace/chainspot-corpus/demo/TheRec-L.PNG",
             "C:/Users/tenni/workspace/ChainSpot-chspt-82/static/tmp-corpus/TheRec-L.PNG",
             "C:/Users/tenni/workspace/ChainSpot-demo/static/resources/TheRec-L.PNG" -ErrorAction SilentlyContinue
git -C "C:/Users/tenni/workspace/chainspot-corpus" remote -v
git -C "C:/Users/tenni/workspace/chainspot-corpus" status --porcelain     # M demo.zip, unpushed
git -C "C:/Users/tenni/workspace/chainspot-corpus" log --oneline -1
Get-ChildItem "C:/Users/tenni/workspace/chainspot-corpus/dev" -Directory
```

---

## What came back clean

Two of the four things this audit was asked to check found **nothing**, and that is worth stating as
plainly as the gaps.

**Thresholds are recorded at exact value, not summarized.** Every named numeric constant and every
inline numeric literal in all nine ported `codex/ab-*` feature sources was extracted and matched
against its spec. Zero discrepancies. Arrays are reproduced element-by-element
(`candidateWidthsPx [24,30,32,36,40,48,56,64]`, `sampleFractions [0.2,0.35,0.5,0.65,0.78]`,
`insideOffsetFractions [-0.30,-0.15,0,+0.15,+0.30]`,
`outsideOffsetFractions [-0.90,-0.75,-0.65,+0.65,+0.75,+0.90]`), including the ones the specs
themselves flag as suspicious. Reproduce with:

```powershell
git -C "C:/Users/tenni/workspace/ChainSpot" show `
  "codex/ab-tbs-material-map:src/lib/detectors/threeFactor/configs/material-map-on.json"
```

**`uncommitted-work.md`'s appendix is verbatim, and complete for the three trees it covers.** Checked
mechanically rather than by eye: the three worktrees' live `git diff` output is **1,963 lines**, and
the doc's ```` ```diff ```` fences contain **1,963 lines**. Every hunk header matches exactly. All
seven untracked new files (`reviewMarker.ts`, `reviewDraft.ts`, three new test files,
`groundcheck-step0.md`, `launch.json`) are reproduced with zero missing lines. The only apparent
mismatches were UTF-8 em-dashes misread by the comparison shell. There is no paraphrase-as-data-loss
in that file — its problem is scope (GAP 3), not fidelity. Re-verify with:

```powershell
$doc = Get-Content "D:/LAB/ChainSpot/docs/unported/uncommitted-work.md"
$real = @("ChainSpot-chspt-82","ChainSpot-demo","ChainSpot-clickfix-ab") |
        ForEach-Object { git -C "C:/Users/tenni/workspace/$_" diff 2>$null }
$in=$false; $fenced=@(); foreach($l in $doc){
  if($l -match '^```diff'){$in=$true;continue}
  if($in -and $l -match '^```'){$in=$false;continue}
  if($in){$fenced+=$l} }
"real=$($real.Count) doc=$($fenced.Count)"     # must be equal
```

**Every spec says "nothing" where nothing exists.** All ten specs' *What proves it works* sections
name their evidence or state its absence in blunt terms ("Evidence images: NOTHING", "The AUC numbers
are backed by NOTHING", "Nothing on a real image"). No spec asserts a behavior works without saying
what does or does not back it. The failure mode found here is the **opposite** one — GAPs 1, 2 and 4
are specs saying "nothing exists" when something does.

---

## Suggested edits to existing specs

Ordered by how wrong the current text is.

| File | Line(s) | Change |
|---|---|---|
| `dsh-fountain-hills.md` | 196–199 | Delete the "does not exist on disk / are gone" claim. Replace with the orphan-worktree path, the file inventory, and the `FINDINGS.md` numbers. Re-rule the Verdict. |
| `refactor-separation-of-concerns.md` | 7 | Delete "Worktree is clean — nothing is sitting dirty." Replace with the dirty inventory and a verbatim reproduction of the three untracked files. |
| `README.md` | §5 item 21 | Fountain Hills inputs are **not** gone; outputs are **not** gone. Re-frame as "back up the orphan tree", not "re-capture or drop". |
| `README.md` | §5 item 6 | The producers *were* found: `old-stuff/scripts/{toph-corpus-gate.ts,pancake-harness.ts}`. |
| `README.md` | §5 item 23 | Add the `chainspot-corpus` pushed-repo copies; re-point the risk at the dirty `demo.zip`. |
| `engine-dev72-lineage.md` | 254 | The 18/18 scoreboard is the OLD pipeline's, not the new engine's — per `dashsTrackSweep.test.ts`'s own header. |
| `engine-dev72-lineage.md` | 239 | Record where `ASSOCIATION_TOLERANCE_PX` is defined: `old-stuff/scripts/toph-corpus-gate.ts:45`, copied to three other files. |
| `uncommitted-work.md` | Source | Widen scope to five worktrees, or state explicitly that two are out of scope and name them. |
| `fourlane-sensor-cluster.md`, `tbs-primitives.md` | Source | Cite the five `.task/PORT-TBS-*.md` briefs by blob SHA. |
