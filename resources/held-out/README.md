# resources/held-out/

Drop point for GRayT (tee-recovery ribbon-ray + pad-template fusion) cross-validation
captures. Scanned by `scripts/cv-probes/grayt_tune.py --input-dir resources/held-out`
(the default).

Two kinds of file are recognized:

- **`*.chainspot.zip`** -- a TUNABLE (labeled) course. `project.json` must carry
  `holes[]` with `number`, `tee{xPx,yPx}`, `basket{xPx,yPx}` truth. These courses
  participate in leave-one-course-out cross-validation (see
  `scripts/cv-probes/grayt-tuning-report.md`) -- never manually tuned against, and
  never graded with parameters their own truth influenced.
- **bare `.png` / `.jpg`** -- an OVERLAY-ONLY (unlabeled) capture. Never used to fit
  parameters. The tuned chain runs on it, an overlay is rendered for human review,
  and two automated consistency checks flag anything that looks wrong (see the
  report).

This folder is empty in this repo snapshot -- as of this tuning pass, the only
labeled courses available are the two repo fixtures
(`resources/GoldenTeeSet.chainspot.zip` + `resources/GoldenBasketSet.chainspot.zip`,
merged into one course, and `resources/AlexClarkSet.chainspot.zip`), and the only
overlay-only demonstration capture used was `resources/ThrownRounds/ReferenceStitch.png`
(referenced directly, not copied here). `grayt_tune.py` always includes the two
fixtures regardless of this folder's contents. Drop additional labeled or
overlay-only captures here to grow the cross-validation set.
