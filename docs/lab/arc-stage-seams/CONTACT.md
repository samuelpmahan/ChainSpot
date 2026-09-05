# ARC Stage seams — 2026-09-05

## Custody

Working branch: lab/arc-stage-seams-20260905, created from package checkpoint 60f53cd9ae8ab210dc73aa884086e315dccbe0a2. Supplied archive: ChainSpot-Sweep-Ready-no-chromium(1).zip. Workspace: /mnt/data/ChainSpot-Sweep-Ready/chainspot. All eight critical manifest SHA-256 checks match. Node v22.16.0; npm 10.9.2. No install or code edits during boot. Shell Git cannot resolve github.com; GitHub connector branch creation and contents commits are the durable write transport. The later lab/dev-pathfinding HEAD differs only in packaging/workflow files; do not silently adopt it.

## Contact: CONTACTED, not a claim of completion

Command: ./lab sweep --through S0 ../chainspot-corpus/dev/NorthPark/NorthPark-full.png
Exit 0. Rendering verified and visually opened: artifacts/sweep/stages/NorthPark-full-through-S0/progression.png. PCR specification: S0.full-to-cropped. Canonical PxC: px.course.canonicalPixels. Input 1290x2796; crop removes 431 upper and 254 lower rows; canonical 1290x2111. Source and cropped panel show the same course without large app header/footer. Apple Maps and MAP/SAT controls remain inside the canonical image. Stderr included a terminal-setting warning; it did not prevent the rendering.

## HUHs and hypotheses

- Request says four courses; bundle contains six: AlexClark, DashsTrack, Heritage, Lenard, NorthPark, TowneLake. Establish which four have applicable truth without inspecting Annotation contents. Keep all six source images in visual regression coverage.
- Discovered Stage contracts stop at S3. S4-S7 exist only as intentions or legacy machinery until exercised. A legacy full-plan result is not execution of the new Stage progression.
- Known-good S3 does not mean all missing physical tees should be emitted by visible detection. The grader must distinguish localization, semantic association, recovery, and path requirements; a final-endpoint test alone cannot identify the faulty Stage.
- Package journal and current hint disagree about NorthPark Tee 5. Resolve from new source-derived PxC/renderings, not prose inheritance.
- Retained map UI may masquerade as course objects. Test identity, not just cardinality.

## Guardrails and next actions

No raw Annotation files opened, extracted, searched, or decoded. Only six manifest source images were provisioned from the packaged corpus. Frozen S0-S3 clean directories match tidy.manifest.yaml; tidy check passed with no Git HEAD (hash verification, not historical custody proof). Do not promote or edit clean/.

Run S3 with warm PxC and the existing full legacy plan across the dev inputs. Inspect every course and local failures. Locate the registered good-annotations tester before claiming a truth verdict. Introduce only isolated downstream experiments that retire a measured uncertainty. Preserve negative results. Initial active hypothesis: the tester and/or execution surface collapse Stage responsibilities; falsifier is a stage-aware evaluator plus compatible S3-to-S4 state consumption.