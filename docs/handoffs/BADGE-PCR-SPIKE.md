# Badge PCR spike

This checkpoint records the first concrete **Progressive Compositional Render (PCR)** spike for badges. It intentionally keeps the producer in scratch/repro custody rather than promoting the badge analysis machinery into LAB or the engine.

## Render-first claim

The render is the feature sketch:

`observed population -> candidate parts -> account for every instance -> unexplained/anomalous residue`

For the DashsTrack course-local spike, the candidate decomposition is still intentionally provisional:

`observed badge ~= shared frame + variable digit + local/contextual residue + unexplained`

The nouns are not architecture. The progression is the useful thing.

## One trace, two projections

The scratch producer emits one `badge-pcr-v1` trace and derives both:

- the PNG PCR;
- the CLI text receipt.

Both projections carry the same `traceId`, instance labels, and anomaly ordering. The producer fails if those projection summaries disagree.

Current reproducible DashsTrack trace:

- trace: `2339a46a7f1be1b6`
- input: 18 badges
- coordinate frame: `badge-crop-normalized:74x62`
- schema identity: `threeFactor.badgeStage+BadgeReading`
- experimental support threshold: `0.60`
- frame samples: 18
- digit samples: `0:1, 1:11, 2..8:2 each, 9:1`

The visual progression keeps all 18 observed badges visible, shows frame and digit population evidence, then shows every instance as `input residual -> unexplained residual`. The worst unexplained instances remain visible in a final anomaly lane rather than being silently absorbed.

## Important correction learned while building the PCR

The first support map accidentally treated **bbox coverage** as evidence support: any non-neutral pixel, including arbitrary map background, counted as support. That made the composer appear to explain background it had no right to claim.

The corrected spike separates those ideas:

- normalization bbox = common coordinate frame;
- support = repeatability of non-neutral RGB across aligned samples;
- variable background remains visible and unclaimed.

The current support score is deliberately local to this spike: stable non-neutral mean relative to observed RGB variance. It is not proposed as a universal support law.

This correction is exactly why render-first helped: the false claim was visually obvious before being promoted into an execution abstraction.

## What PCR earned

PCR earned a reusable **trace/projection discipline**:

1. construct one evidence trace;
2. render the claimed decomposition from it;
3. print the textual receipt from it;
4. keep unexplained evidence explicit;
5. machine-check that render/text projection summaries refer to the same trace.

It did **not** earn a predetermined drawing vocabulary or a generic rendering DSL.

## Next: smallest real fork.compare

Now compare two badge composers from the same prepared badge checkpoint:

- `defaultLive`: current V1 component ownership;
- `experimentalPcr`: residual-aware PCR composer (dark digit-hole ownership + learned frame/digit support).

The default remains untouched. The sidecar compares only. No winner, merge, or pin mutation is allowed.

The comparison should retain input schema identity, coordinate frame, per-branch plan/config hash, evidence trace, render fragment, unexplained residual, and timing, and should derive render + CLI receipt from one comparison trace.
