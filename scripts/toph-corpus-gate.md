# `toph-corpus-gate.ts` — one-command corpus fetch + P1 detection gate

Fetches the 4 in-scope `chainspot-corpus` course fixtures (no local checkout
of that repo required) and runs the existing `scripts/toph-tune.ts` sweep
against them, reproducing the 4-course P1 detection table with zero manual
download step. Doubles as a CI-less regression gate: non-zero exit if the
active-default config falls below the acceptance bar.

## Usage

```
npx tsx scripts/toph-corpus-gate.ts [--cache-dir <dir>] [--with-association]
```

- `--cache-dir <dir>` — where fetched corpus files are cached. Default
  `.corpus-cache/` at the repo root (git-ignored).
- `--with-association` — also run the opt-in DashsTrack-only association
  check described below. Off by default.

Exit code is non-zero if the `default` row of the printed table falls below
the acceptance bar (tees <58/72, baskets <67/72, or FP >3) or if DashsTrack
is not exactly `t18/18 b18/18 +0`; with `--with-association`, a failing
association check also makes the exit code non-zero (reported as a
separate line, never folded into the detection numbers).

## Detection vs. association — this table proves one, not the other

This script's 4-course table is a **P1 detection/localization recall**
measurement — exactly what `scripts/toph-tune.ts` scores: for each
ground-truth tee/basket point, "is there some emitted P1 object within
tolerance anywhere in the image?" **There is no hole-number matching in this
metric at all.** It cannot distinguish "hole 3's tee and hole 5's tee got
swapped" from "both correct" — both look like 2/2 detected. The metric lives
entirely inside P1 (`rawObjectMask.ts`), which makes it, by construction,
**blind to P3–P6** (badge labeling, ownership, ribbon segmentation, sparse
assignment, low-par basket assignment). It is a valid P1 regression check.
It is **not** proof that any course's tees or baskets are correctly
*associated* with the right hole number.

**Association/assignment correctness** — does hole N's full-pipeline
(P1→P6) assigned tee/basket actually land within tolerance of hole N's own
truth point, matched by hole `number` — is verified separately, by
`scripts/pancake-harness.ts`, and **only for DashsTrack** in this port. That
scope is not an oversight: `pancake-harness.ts` does not reproduce
ChainSpot's intake autocrop the way `toph-run.ts`/`toph-tune.ts` do
(`autocropLikeIntake`), so feeding Heritage's, Lenard's, or TowneLake's raw
un-autocropped images directly into it produces large (~400–530px) per-hole
frame-offset errors — a tooling gap in `pancake-harness.ts`, not a real
detection or association failure. This was confirmed directly by the lead:
DashsTrack needs no autocrop and is unaffected; the other three do and are
not usable with this harness as-is. Fixing that gap is out of scope for this
port.

**Do not read this script's 4-course table (t58/72 tees, b67/72 baskets) as
an association claim about all four courses — it isn't one, for the reason
above.** If you need per-hole association proof, that exists only for
DashsTrack, either via `npx tsx scripts/pancake-harness.ts
<DashsTrack-full.jpg> .` directly or via this script's `--with-association`
flag (see below). When reporting either number anywhere (a Review Brief,
`CHANGELOG-dev.md`, a status update), state them under clearly separate
labels — never merge them into one blanket "18/18 verified" claim.

### Optional: `--with-association` (DashsTrack only)

With this flag, after the detection table the script also shells out to
`scripts/pancake-harness.ts` on the cached DashsTrack image, runs the real
P1→P6 pipeline, and compares `course.grammar.holes[]` — the full-pipeline,
hole-numbered proposals — against DashsTrack's own annotation truth, matched
by hole `number`, at 26px tolerance. This is printed and gated as a
**separate** "DashsTrack-only association check" block/result, distinct from
the "detection gate" block above; the two are never combined into one
pass/fail or one count. It exists only for DashsTrack, for the same
autocrop-gap reason above.

## sha256 verification

Images (`DashsTrack-full.jpg`, `HeritagePark-full.png`, `Lenard-full.PNG`,
`TowneLake-full.png`) are Git LFS-tracked in `chainspot-corpus`, so a plain
`raw.githubusercontent.com` fetch of that path returns a small LFS *pointer
stub* (a few lines of text: `version …`, `oid sha256:<hex>`, `size <n>`),
not the real image bytes. For each image, this script:

1. Fetches the pointer stub from
   `https://raw.githubusercontent.com/samuelpmahan/chainspot-corpus/main/<path>`
   and parses `oid sha256:<hex>` (and `size`) out of it.
2. Fetches the real bytes from
   `https://media.githubusercontent.com/media/samuelpmahan/chainspot-corpus/main/<path>`.
3. Hashes the downloaded bytes with `node:crypto`'s `createHash('sha256')`
   and hard-fails with a clear error if the hash doesn't match the
   pointer's `oid` (or if the byte count doesn't match the pointer's
   declared `size`) — corrupted or truncated downloads are never used.

Annotation truth files (`<Course>-full.annotation.json`) are plain JSON, not
LFS-tracked — fetched directly from `raw.githubusercontent.com`, with a
hard fail on a non-200 response or a body that doesn't parse as JSON.

**Caching:** fetched files are cached under `--cache-dir` (default
`.corpus-cache/`, git-ignored), mirroring the corpus repo's own
`dev/Annotated/<Course>/<file>` layout. On a repeat run, the LFS pointer is
still re-fetched every time (cheap, a few bytes of text) to learn the
corpus's current `oid`, but the large media fetch is skipped whenever the
cached file's own sha256 already matches it — so a warm cache is
network-light, not network-free. A cached file that fails that check (wrong
hash — e.g. corrupted on disk, or the corpus updated the file upstream) is
never used as-is: it's treated as a cache miss, logged (`[cache stale]
…re-fetching`), and re-fetched + re-verified. Annotation JSON caching works
the same way minus the hash: a cached copy is reused only if it still parses
as JSON.

## AlexClark exclusion

`chainspot-corpus` also has a `dev/Annotated/AlexClark/` course. It is
**deliberately excluded** from this script and from `scripts/toph-tune.ts` /
`scripts/toph-measure-zerobend.ts` — do not fetch it, do not add it to the
course list, do not reference it in gate math. See `.task/CHSPT-70.md`
("Known context") for why it's out of scope for this port.

## Where the numbers and mechanisms come from

This script reproduces the corpus-tuning table; it does not re-derive or
re-explain it. The tuned threshold values, the three attributed mechanisms
behind them (badge-digit consensus poisoning, satellite-scale tee
shrinkage, occluded-basket under-fill), the dead ends, and the small-N
honesty caveats all live in
[`scripts/cv-probes/toph-p1-corpus-tuning-findings.md`](./cv-probes/toph-p1-corpus-tuning-findings.md).
Read that document for *why* the active defaults are what they are; read
this one for *how to reproduce the numbers with one command*.
