# Refine checklist — S0 and S1 Mermaid proof

Base: fa44a4505d9aafbf6d2d21a12400298edb7fa96d.
Current state: uncommitted implementation, not executed or rendered in this turn.
Entry and exact commands: README.md in this directory.

- [ ] Compile S0 and S1 independently; inspect generated Tick names and occurrence IDs.
- [ ] Run on full DashsTrack (default), not a pre-cropped input.
- [ ] Confirm one async decode; bounds and applyCrop receive the same object.
- [ ] Confirm no FullImage address or separate cache call in generated S0.
- [ ] Inspect the actual StripChromeResult and resulting crop visually.
- [ ] Compare canonical dimensions and every RGBA byte against legacy S0.
- [ ] Compare all 15 S1 occurrences, their named bindings, args and output values.
- [ ] Compare complete badge objects/readings/ownership declarations and all pixels
      at px.badges.px, px.badges.muted and px.remaining.afterBadges.
- [ ] Inspect separate ownership masks; additional muted pixels must stay distinct
      from the full bbox exclusion query and explained component pixels.
- [ ] Confirm appended valid Ticks do not change public output lookup.
- [ ] Trigger failure: inspect successful prefix, failing ID, inputs and error.
- [ ] Check repeated runs isolate direct values and compiler rejects ambiguous graphs.
- [ ] Review existing S1 registration's raster seeding; graph repeats shape adaptation
      but neither path reruns a detector for compatibility.
- [ ] Record actual invocation, source identity, results, images and known gaps;
      commit a useful checkpoint and use the agreed review-push workflow.

Not completed by this prototype: shared PQL integration, Stage selection/routing,
browser traversal, S2 compatibility or promotion. These remain explicit follow-up
work; a passing proof alone does not establish them.
