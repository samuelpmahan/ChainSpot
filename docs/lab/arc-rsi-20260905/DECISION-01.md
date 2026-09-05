# ARC-RSI decision 01 — 18 is not 18

Base computation: supplied packet checkpoint 60f53cd9, unchanged clean S0-S3. All six new warm-S3 course-level renderings were opened, not inferred from receipts.

| Course | Badges | Baskets | Tees |
|---|---:|---:|---:|
| AlexClark |18|15|14|
| DashsTrack |18|17|18|
| Heritage |18|15|14|
| Lenard |18|16|17|
| NorthPark |18|17|16|
| TowneLake |18|18|17|

Observation: DashsTrack's selected boxes include two Maps letters and the SAT A. White pads beside badges 3 and 5 are visible but unboxed. Their nearly uniform gray interiors survive where range-circle strokes interrupt their white borders. AlexClark also has a Maps-letter selection. This falsifies count-only success. The extra letters are observed, not inferred from a low metric.

A new, isolated LAB grader was implemented locally because the existing scorer prints Annotation coordinates. `lab grade-stage RECEIPT.json --truth-archive ARCHIVE.zip` privately consumes truth and returns an allowlist of semantic hole/detection IDs, missing targets, and coverage boundaries. It neither extracts truth nor emits coordinates, distances, masks, or truth structures. It reuses the existing inclusive 26px one-to-one matching convention without tuning. Sparse truth and zero targets cannot establish a whole-course pass. Source bytes must match and the source-to-canonical transform must come from the recorded S0 crop; no coordinate fitting.

Referee: DashsTrack matches 15/18 annotated Tee targets; MISSING TEE H3, H5, H12. T16/T17/T18 are unmatched. The other five cases return NO_BYTE_MATCHING_ANNOTATION. Those are UNKNOWN, not failures of ALG or permission to weaken frame custody. No raw Annotation content has been inspected.

Grader validation: 11 synthetic tests pass, including actual CLI dispatch, 26px parity, one-to-one matching, sparse real hole IDs, empty-target rejection, crop handling, coordinate non-disclosure, source mutation refusal, and sanitized error output. tidy check passes all four frozen surfaces. The full suite has not yet been run.

HUHs: packaged .bin launchers resolve imports relative to .bin and fail; direct installed-package entrypoints work without installing. The first real grader command exposed a missing option in the help catalog despite loader tests passing; registered the option and added the dispatch regression test. These failures were not relabeled successes.

Next experiment: S3/exp flat-interior sensor. Learn a renderer-color expectation from measured Tee interiors; test whether interior components plus white-border evidence recover outline breaks and distinguish UI glyphs. Keep tinted Tees eligible. Do not turn one gray color, scale, orientation, or common family into a universal law. Preserve clean baseline, ownership, PCR provenance, and rejected alternatives. Falsifier: no actual missed pad gained, a visually false proposal, loss of an existing true Tee, or a distant regression. No Stage is solved or promoted by this note.

Local artifacts: artifacts/sweep/stage-experiments/{course}/clean/{run}/07-tee-objects.png, run.receipt.json, and pxc.bin. Session BASELINE.json and BASELINE-GRADES.json retain exact receipt/source/computation hashes. Implementation and those compact receipts are to be committed in the next checkpoint.
