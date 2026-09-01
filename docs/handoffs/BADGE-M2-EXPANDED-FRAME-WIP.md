# Badge M2 expanded-frame checkpoint

Status: **WIP checkpoint, not a graduated M2 representation**

Branch: `lab/m1-bw-representation`

M1 control HEAD before this checkpoint: `77c2573`

## Frozen control

M1 is the proven B+W representation. It materializes independently addressable bright/dark
components, the actual V1 relationships that compose them into Badge/Basket objects, contextual
component consumption, exact pixel identities, and available/explained/unexplained accounting.
Storybook reads that E materialization rather than reconstructing it.

Pinned Badge 0 control:

- M1 B+W pixels: 2096
- M1 explained pixels: 2096
- M1 pixel-set SHA-256: `e6eab2ea93451528d6736c85e2393559d028ae093222470c01d408b6858625dc`
- naive one-pixel AA candidates: 278
- old materialized-region residue: 90
- old non-M1 region: 368 = 278 + 90

Do not redesign M1, reinterpret its denominator, replace its primitive identities, or make M1
retroactively know about AA.

## What this checkpoint contains

The ungraduated worktree introduces a default-OFF `badgeM2Aa` feature, M1-to-M2 set accounting,
candidate-overlap experiments, an expanded raw-frame probe, an empirical-null control module, and
E/Storybook/receipt projections. It is committed so the next worker can inspect the actual path and
the failed approaches rather than rediscovering them from prose.

Some pure seams and focused tests work. The final production path is not yet scientifically closed:
the production G5 feature has not been proven to attach the corrected statistical control to the raw
probe, and the final semantics have not completed a real 18-badge DashsTrack receipt.

## Hidden mousetraps

1. **The old E region is too small.** `MaterializedBadgeEvidence.region` is the assembly bbox plus a
   one-pixel ring. It cannot prove that the Badge signal ends there. Expanded frames must be sampled
   again from the original source raster.

2. **The 278 candidates are not the search space.** Building an overlap field from `aaPixels` asks
   only how often the already-selected candidates recur. It excludes the 90 motivating residue
   pixels and every pixel outside the old region.

3. **Candidate plus residue is a tautology.** For Badge 0, `278 + 90 = 368`, the complete non-M1
   remainder of the old region. Overlapping a binary `candidate OR residue` mask merely turns on
   every non-M1 location; it discovers nothing.

4. **The search area itself is under test.** Register all 18 Badge specimens, begin outside the old
   boundary, and expand symmetrically. A frame is not adequate while repeat-supported structure
   touches any side. Source clipping must be reported per side and produces UNKNOWN, never a pass.

5. **Mask only the numbers.** Do not mask the whole Badge interior or a digit bounding rectangle.
   Mask the actual known glyph pixels and only explicitly justified glyph AA support. The surrounding
   dark plate, corners, full outer perimeter, and exterior ring remain searchable.

6. **Use all 18 samples.** There is no holdout requirement for this descriptive overlap experiment.
   An incomplete sample set must fail loudly instead of being relabeled as clipping or adequacy.

7. **Measure raw appearance, not detector membership.** `numOverlaps` must count registered raw pixel
   appearances (exact RGBA first; explicitly parameterized quantization only as a separate view), not
   membership in `aaPixels`, `residuePixels`, or another derived candidate set.

8. **Move raw samples in the null control.** A valid circular-shift null independently shifts each
   registered raw crop and its glyph mask, then recomputes recurrence. Shifting an already-aggregated
   overlap field is invalid. Freezing target-mask eligibility while shifting colors is also invalid.
   Unequal/incompatible crop geometry must return UNKNOWN unless the transform is justified.

9. **Do not multiply neighboring-pixel probabilities.** Spatial neighbors are dependent. Control the
   searched field with a global maximum-overlap statistic and coherent structures with a largest
   8-connected-cluster statistic. The empirical p-value uses the add-one form
   `(1 + null >= observed) / (B + 1)`.

10. **Keep exact and quantized claims separate.** E should retain the 18 raw RGBA observations,
    modal value/count/fraction, per-channel sample standard deviation, exact groups, quantized groups,
    seed, replicate count, and null distribution. A renderer may arrange or color those facts but may
    not calculate replacements.

11. **The generic LAB statistics calculator is requested but not implemented here.** The intended
    command family includes descriptive statistics, exact binomial tails, Wilson proportion intervals,
    two-proportion comparison, Fisher 2x2, and normal-tail calculations, with text and JSON receipts.

## Ownership is the point

This work is literally defining the pixel-ownership model of composed objects. Refusing in principle
to attribute strongly recurring, registered, statistically controlled pixels to the object is utterly
asinine: it defeats the purpose of the representation.

Recurrence is evidence of ownership. Exact 18/18 recurrence has per-channel observed sample standard
deviation zero. Under the intentionally generous specified-value binary null `p = 0.5`, its upper-tail
probability is `0.5^18 = 3.814697265625e-6` (one in 262144). The empirical raw-crop control is still
needed to account honestly for the real color distribution, multiple searched coordinates, and spatial
dependence, but statistical caution must refine the ownership claim rather than prohibit one.

The intended promotion rule is therefore:

`adequate expanded frame AND exact 18/18 registered recurrence AND empirical-null significance`

Lower recurrence remains graded evidence. It is not silently deleted merely because it does not meet
the first hard promotion rule.

## Known integration gap at checkpoint

The corrected control seam exists in WIP form, but reciprocal review found that the production
`g5.badgeM2Aa.ts` path still called the raw probe without attaching the control result. Until the G5
artifact carries the reviewed statistics and a real corpus receipt proves correspondence, Storybook
must not imply that the ownership verdict is production-backed.

## Next executable step

1. Attach the corrected raw-sample control to the production G5 artifact.
2. Run all 18 DashsTrack Badges from the original source raster.
3. Materialize margin-by-margin boundary status and the exact/quantized recurrence fields.
4. Render the full discovered support, then partition it against M1 / old 278 / old 90 / exterior.
5. Require trace-to-CLI and trace-to-Visual identity, frozen-OFF parity, unchanged M1 hash, and an
   inspectable ownership decision.
6. Only then split/clean the WIP checkpoint into graduated implementation commits.

