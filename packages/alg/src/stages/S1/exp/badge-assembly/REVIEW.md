# Stage consolidation checkpoint

Consolidated Default ran on Dash’s Track: 18 candidate pixel sets matched the prior assembly exactly. Build and four focused tests passed. JS produced HTML/SVG; Chromium interaction checks remain unverified because the browser download timed out.

## Decisions implemented

- PrincipleComponentRender.yaml owns the full experimental S1 order and arguments. The Stage factory prepares inputs/registers implementations and delegates to the shared runner.
- Each registered ABFeature participates automatically. Default and each feature run independently in registration order. No enabled/default-off switch exists in this path.
- Overrides map declared fn identities to registered replacement fn identities, with optional argument patches. Repeated uses of that fn in the YAML all receive the override. Named Part inputs cannot be replaced by arguments.
- Re-registering a feature ID replaces its definition. The Default has a separate result kind, even if a feature is named Default.
- A PxC fork snapshots slot and function maps. It shares immutable values, including raster buffers. Each run's writes stay in its own fork. A following Stage can consume the chosen result's pxc.
- The caller receives results and the input PxC stores them at px.pql.<Stage>.results. Runs retain declared call, actualCall, effective args, inputs, and outputs for differentiation. This is recorded material, not a comparison score.
- Variant failures produce failed results and do not suppress later variants. Earlier writes in the failed fork remain available; partial Calculation records are not yet returned.
- The shared browser-safe JS renderer produces SVG from exact pixel membership. The HTML inspector reads Calculation outputs, lets the user select an item and toggle its component Parts, and exports the same SVG projection. View controls perform no CV calculations.
- Existing ABFeatureSet consumers remain operational. Its interface is deprecated for new compositions; migration of frozen stages is not part of this experimental S1 change.
- One Node host replaces three experiment hosts. The two Python sheet generators are removed. This is a standalone inspector; staging integration remains pending.

## Unresolved labels

- {CalculationOccurrenceTargeting}: target just one invocation of a shared fn, if needed.
- {CombinedABFeatureComposition}: combine multiple features and resolve overlapping overrides. Independent variants currently need no precedence rule.
- {PartPublication}: canonical child addresses and sourceTickId stamping remain unset by the generic runner. Inspection follows actual nested output Parts and execution records.
- {DifferentiationPolicy}: which comparisons/scores to compute from stored variant results.
- {PartialExecutionRecords}: retain Calculation records completed before a failed Tick.
- {OtherPartRenderers}: masks and component pixel sets have a projection; other semantic Part kinds need their own view conventions as they appear.

These labels are review notes, not executable placeholders or hidden guards.
