# PCA Through Frames — inspiration and merge-back target

## The inspiration

The basket work exposed a reusable experimental pattern that is bigger than baskets and smaller than a grand AutoScience architecture.

The important move was **not PCA by itself**. It was threading a factorization step through a sequence of explicit, human-legible Frames while preserving the rich observable at every stage.

For basket-backwards, the rich observable is the entire angular evidence profile, not only the winning bearing. The general flow is:

`observe -> frame* -> perturb -> delta -> factor -> project -> explain`

Where:

- **observe** preserves the rich measurement field/vector/profile;
- **frame** re-expresses the same evidence under an explicit named viewpoint;
- **perturb** makes one controlled experimental change;
- **delta** preserves the structured difference instead of collapsing immediately to a scalar;
- **factor** finds recurring dimensions in those deltas — PCA is the first intentionally simple implementation;
- **project** maps those factors back into the domain that produced them;
- **explain** produces a textual account mechanically tied to the same evidence.

## Why Frames matter

Examples discovered during the basket experiment include:

- `basketTipFrame` — move semantic origin to the documented bottom-center pole tip;
- `imageNorthFrame` — express angular evidence with image north at 0°;
- `incomingEvidenceFrame` — rotate relative to a truth-blind observed incoming direction;
- `rgbFrame` — raw RGB evidence;
- `lumaFrame` — luminance-only appearance;
- `exactColorFrame` — relation to exact black/white classes without inventing ownership;
- `courseResidualFrame` — residual relative to a course-local clean-basket baseline.

A Frame is useful because it can answer a human question:

> Does the error survive when I account for this kind of variation?

That produces compact explanations such as:

> Spatial normalization barely changed the disagreement. Course-residual normalization removed most of it. Incoming-direction alignment removed most of what remained.

That sentence should have a corresponding VisualRender showing the same story.

## PCA is the first Factor primitive, not the ontology

PCA is attractive here because it is cheap, transparent, deterministic, and easy to challenge. It can summarize recurring shapes in structured deltas without requiring semantic labels up front.

LAB must not automatically name a principal component. A large factor with no understandable textual or visual projection remains **unexplained**.

The generic primitive is therefore `Factor`, with PCA as the first concrete implementation.

Possible later Factor implementations are intentionally out of scope until experiments earn them.

## Project factors back into their native domain

This is essential for human/AI coworking.

Examples:

- angular profile factor -> `RadialRender` around the semantic basket tip;
- pixel factor -> raster overlay;
- candidate-score factor -> candidate/ranking view;
- assignment factor -> assignment-edge view;
- path-support factor -> path/raster view.

The explanation is not an LLM story generated after seeing numbers. The experiment itself carries enough structure to say what changed and where.

## Basket-backwards concrete experiment

For each truth-blind localized basket:

1. Preserve the complete angular evidence profile.
2. Run a baseline and one controlled basket-pixel muting perturbation.
3. Compute the angular-profile delta.
4. Re-express that delta through explicit Frames such as TrueNorth and incoming-evidence alignment.
5. Run PCA across baskets/courses on the framed deltas.
6. Record explained variance, loadings, and per-case scores without semantic overclaiming.
7. Project the factors through the shared `RadialRender` primitive.
8. Emit a concise textual explanation tied directly to those Frame/delta/factor results.
9. Only after the truth-blind measurement is sealed, optionally evaluate directional error against truth.

The useful VisualRender should let a human see something like:

> These removed pixels consistently distorted evidence toward this basket-relative direction.

without needing to understand PCA terminology.

## SmartGridSearch connection

This substrate could later let SmartGridSearch search explanatory transformations rather than only scalar parameters.

Examples of useful search questions:

- Does error survive semantic-origin normalization?
- Does it collapse under course residual?
- Does incoming-direction alignment explain the residual?
- Does exact-color or luminance normalization expose another independent effect?

That gives search a way to decide **where to investigate next** from the structure of remaining error.

Do not implement a universal optimizer on this branch. The substrate should merely make that future behavior possible.

## Feature-complete / merge-back checkpoint

This branch is ready to merge back into LAB when **one real bounded experiment** can run end-to-end through reusable/registered code and demonstrate all of these primitives:

1. **Observe** — preserve a rich measurement vector/field/profile.
2. **Frame** — apply explicit named composable Frames with provenance and human explanation hooks.
3. **Perturb** — apply one controlled experimental change while preserving baseline semantics.
4. **Delta** — retain the structured difference rather than only a scalar result.
5. **Factor** — PCA as the first Factor implementation, preserving explained variance/loadings/scores without semantic invention.
6. **Project** — project at least one factor back into the original domain using `RadialRender`.
7. **Explain** — emit a concise textual explanation mechanically tied to Frame/delta/factor evidence.
8. **VisualRender** — make the same explanation understandable visually.
9. **Truth discipline** — keep localization/measurement truth-blind until optional final evaluation.
10. **Replay** — one bounded LAB-visible experiment can reproduce the receipt/render from declared inputs.

That is the proposed **feature-complete merge-back point**. Anything beyond it — SmartGridSearch, more Factor types, automatic Frame discovery, generalized experiment scheduling — should be earned by subsequent use.

## Historical mistake that motivated explicit Frames

The first PCA radial probe centered angles on the middle of the 42×66 basket body rather than the documented semantic basket point at the bottom-center pole tip.

The Frame substrate exists partly so assumptions like semantic origin and orientation cannot remain invisible inside analysis code.
