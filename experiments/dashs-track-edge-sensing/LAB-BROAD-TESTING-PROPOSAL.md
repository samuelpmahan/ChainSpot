# Broad testing in LAB: audit and proposed Sweep matrix

Inspected 2026-09-06. This is a proposal, not an implemented command.

## Existing facilities

The LAB branch `lab/dashs-ternary-edge-pattern`, inspected at commit
`53a350de32596e177e62437186f8a73c2c28b2f4`, already has:

- `scripts/chainspot-lab/sweep/batch.ts`: one configuration across manifest-backed
  dev/demo/all/course cases, sequentially. Calls the normal Sweep operation,
  continues after failures, returns nonzero on execution failure, saves per-case
  evidence and aggregate JSON/text. Does not implicitly supply annotation truth.
- `sweep/gateVocabulary.ts`: G1–G7 cutoffs supported by dependency-complete plan
  prefixes. README's claim that only G1–G3 are valid is stale.
- `tests/unit/familyDeviationSweep.test.ts`: specialized two-configuration,
  four-course comparison with images and gate scoreboards.
- `tests/unit/corpusSweep.test.ts`: one memoized engine run per course reused
  across gate assertions. This is test-local reuse, not a general PxCQL compiler.

Existing command form: `./lab sweep batch --through G5 CONFIG.json dev demo`.
The chosen config must actually schedule the requested phase. This command has
not been executed in this audit; the finding is from source and its tests.

Main is a different implementation lineage. Its inspected tree
`b1f4c833d32426d3094c93403af5055057ea63f1` contains:

- `scripts/benchmark-course-corpus.ts`: parallel image × parameter jobs, bounded
  concurrency, per-job results and aggregate report. Calls the older detector.
- `scripts/benchmark-corridor-bend-detection.ts`: five-model comparison, separate
  false-bend-on-straight reporting, bend counts and location errors. It supplies
  truth Tee/Basket anchors to the models. Reuse report concepts, not that input
  scaffold. Its nearest-truth matching is not one-to-one; improve that too.

## Missing connection

No general LAB facility was found in the inspected Sweep sources that combines
named implementation variants, shared intermediate measurements, per-hole/event
grouping, resumable immutable runs, and source-backed disagreement galleries.
Current batch success means execution succeeded; it does not mean a correct path.
Its summary fields chiefly count Badges, Baskets, and Tees. Output paths are based
on config/course/case, so repeated runs need distinct identities before comparison.

## Proposed extension of Sweep

Proposed command: `./lab sweep matrix MATRIX.json dev demo`.
Use the existing Sweep operation and manifest expansion. A matrix declares named
runnable implementations and explicit ABFeature parameter variants, requested
materials/measurements, compute budget, and report groupings. Selecting an `exp/`
composition runs its contents. Freezing an implementation does not bump versions.

1. Resolve all cases and variants up front. Save immutable source hashes, raster
   dimensions/frame, source implementation/dependency hashes, resolved parameters,
   seed provenance, and the complete requested job list. Missing prerequisites
   remain visible rows. No endpoint assignment prerequisite for sensor testing.
2. Share pure preparation/materials through PxC. Identity includes calculation
   revision, input content/revisions, raster frame/format, and parameters. Identical
   profiles can feed different predicates without counting as independent evidence.
   Isolate mutable run state. Keep hit/miss and uncached-parity receipts.
3. Execute with bounded workers, per-case progress, durable completion receipts,
   and resume by exact identity. Preserve execution errors separately from
   unsupported/unknown measurements and tracker budget exhaustion.
4. Emit one row per course/capture/hole/variant and child rows for local events.
   Retain both signed edge readings, center/reference resemblance, width and its
   search bounds, heading, observed support/occlusion, alternatives, and stop reason.
   Variant geometry must be retained; a scalar score cannot produce a comparison.
5. Group by observable behavior: paired support persists; left/right support drops;
   width changes or hits a search bound; alternatives diverge; edge reacquired;
   budget exhausted. Review labels such as road/roof/circle diversion attach to
   source witnesses, not inferred labels presented as ground truth. Compare events
   spatially on the same hole, not solely by step index.
6. Render a gallery for each group, with source crops and all variant tracks;
   retain access to every member, including ungrouped/unknown cases. Report
   denominators, missing seeds, and annotation-assisted starts explicitly.

## First concrete matrix

Start with all 18 DashsTrack holes, then every available course/capture manifest.
Prepare source evidence on cases lacking seeds too; record follower ineligibility
without dropping their sensor observations. Do not limit the learning set to H18.

First vary sensing while holding tracking policy fixed: narrow edge difference,
broad signed transition, broad transition plus center-reference resemblance.
Then vary turn handling with each sensor: current stepping, smaller steps near
support loss, and walkback with several continuation headings. These are proposed
arms; the current prototype does not implement every arm. Learn local width and
appearance from each source; 40px/50px are observations to inspect, not universal
fixed widths. Only pool course-level width after comparing local measurements.

Measure how long paired support persists, where each side first loses support,
whether support is reacquired on the same strip, and whether a straight control
gains false bends. Source-space distances and images come before a pooled score.
After each trace is frozen, independently match bend proposals to annotations
one-to-one with unmatched proposals/misses preserved. Candidate C2 encounters
may be evaluated downstream, never used as attraction targets.

Begin with the matrix receipts and grouped gallery (usable); add adaptive job
selection and richer PxCQL planning after measured reuse and parity (useful).

## Correction: compute slices must not limit hole length

The first follower checkpoint used 90 poses (~356 nominal forward pixels). That
is an arbitrary distance cap and does not accommodate a course's long outlier
hole. A matrix must not mistake this censored prefix for a completed path or a
geometric failure.

The proposed follower contract separates three events: observed terminal
evidence, unresolved continuation, and scheduler pause. Steady paired support
advances without a fixed hole-length allowance. Support changes trigger finer
steps, local walkback and competing continuations. A scheduler slice yields a
serializable frontier plus accumulated trace, material revisions, unresolved
branches and scoring state; resuming must match uninterrupted execution. Do not
restart each chunk from its winning point and discard other live hypotheses.

Test this specifically with a supported corridor longer than the old cap, the
same corridor split across different compute slices, a closed loop, and a
branching distractor. Loop/revisit detection is a separate explicit condition.
The present prototype is capped and does not yet implement this resumption.
