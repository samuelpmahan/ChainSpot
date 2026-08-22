# DashsTrack one-course HITL annotation smoke

Purpose: after finishing the Basket Family detector, attempt exactly one whole-course annotation using the current LAB understanding instead of widening weak detectors until they emit 18 objects.

This is **not a blind accuracy result**. The existing Dash annotation file was available in the session; construction used detector evidence plus visual HITL and the Oracle was used for post-hoc comparison. Treat this as a workflow/reproducibility smoke only.

## Construction

- Badges: 18 dark plates detected; digit identities were visually unambiguous.
- Baskets: 17 clean-family detections + 1 basket-on-basket recovery. The recovery scored identity ~0.996 with ~0.659 effective visibility and was seeded from the neighboring accepted basket.
- Tees: 15 intact-family hollow/gray tee observations were directly measurable. Three missing intact observations were filled by HITL visual endpoint placement rather than loosening the intact-family rule.
- Corridor: visual centerline/bend pass recorded 10 bend points; straight holes remained zero-bend.

## Post-hoc Oracle comparison

Approximate endpoint comparison for the constructed annotation:

- tee median error: ~0.33 px
- tee max error: ~1.32 px
- basket median error: ~5.02 px
- basket max error: ~5.02 px
- matched bend median error: ~0.46 px
- matched bend max error: ~1.97 px

The basket ~5 px bias is the current fixed semantic pole-tip transform in this local reproduction; object localization itself is substantially tighter.

## Load-bearing result

The useful behavior was **not** “make every detector return 18.” It was:

1. recognize the intact repeated object family precisely;
2. interpret the deficit as a named recovery/HITL problem;
3. recover only where renderer/visual evidence explains the missing object;
4. preserve which placements were measured versus HITL.

That is the workflow to carry forward to the next fresh course.
