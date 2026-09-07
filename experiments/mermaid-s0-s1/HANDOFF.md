# Review handoff: separate S0 and S1 Mermaid PCRs

Base: fa44a4505d9aafbf6d2d21a12400298edb7fa96d.
Checkpoint state: written, unrun, unrendered. No parity or visual acceptance claim.

## First task: run and render

Use the full DashsTrack screenshot. Compile S0.mmd and S1.mmd independently with
S0.args.json and S1.args.json, then execute experiments/mermaid-s0-s1/run.ts.
The CLI imports source; use a working tsx runtime and root dependencies.
Pass the full source image path as argument 1 and artifact directory as argument 2.
README.md under packages/alg/src/stages/S0/exp/mermaid-pcr has the current session's
exact invocation. On a fresh checkout, provision the runtime and input explicitly;
the scratch dependency directory and default image path are not repository assets.

Return actual run status and show the rendered canonical image and separate
owned/muted/remaining masks. Inspect crop and badge readings in receipt.json.
If execution fails, expose the error and successful prefix; repair bounded run
blockers without changing algorithm thresholds or expected results to manufacture
parity. Keep the review checkpoint fixed; commit fixes on your own work branch.

## Then: redo the checklist with Sam

Use observed results to replace provisional assumptions in REFINE.md. Distinguish
output parity, direct function-result behavior, visual meaning, and infrastructure
still unwired. Do not report a green prototype as shared PQL/Stage/S2 integration.

Current explicit gaps: isolated interpreter; no shared executor promotion, normal
Stage routing, browser inspection integration or S2 compatibility. Existing S1
registration seeds its raster, then the graph explicitly adapts the raster again.
The original S1 YAML remains the independent comparison baseline.

Sam owns visual acceptance and the revised checklist. Publishing this checkpoint
does not authorize landing it.
