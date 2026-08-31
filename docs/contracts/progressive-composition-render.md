# Progressive Composition Render contract

A Progressive Composition Render (PCR) is a visible composition of evidence
transformations. Each tick has the form:

> input -> relationship or change -> output + remainder

The output of one tick normally becomes input context for the next. A completed
PCR preserves enough of the progression that a reviewer can walk backward from
the result to the evidence that produced it.

## Tick contract

Each material tick makes visible:

- what entered;
- what was added, removed, related, or transformed;
- what representation resulted;
- what remained rejected, unknown, muted, unavailable, or unexplained.

A tick may use any layout or rendering primitive appropriate to its evidence.
It fails when the output appears without enough of the transformation to
understand where it came from.

## Composition contract

Ticks compose rather than merely coexist. Later ticks preserve enough
provenance to distinguish inherited evidence, newly introduced evidence, the
operation performed, the resulting representation, and the remainder.

Every material evidence value is spatially depicted, visibly summarized, or
explicitly identified as unavailable or unused. The render and receipt describe
the same composition. Numbers may summarize spatial evidence; they do not
replace showing it.

Branches may compare alternative transformations from the same input. They
rejoin only in a comparison render and never silently select or merge a winner.

## Basket composition sequence

The initial basket PCR is deliberately five small ticks:

1. **Mask 1** — `Source -> Mask1`
2. **Mask 2** — `Source -> Mask2`
3. **Family composition** — `Mask1 + Mask2 -> CandidateFamilies`
4. **Border matching** — `CandidateFamilies -> AcceptedMappings + RejectedMappings`
5. **B+W subtraction** — `EvaluationRegion - ComposedBW -> UnclaimedPixels`

For the current basket instance, Mask 1 is the black mask and Mask 2 is the
white mask. That naming is an instance detail, not a restriction on PCR reuse.

### Tick 1 — Mask 1

Produce Mask 1 and show its evidence in source coordinates. Pixels in the mask
are observations at this stage, not established basket ownership. One explicit
clean control basket is sufficient; a population must not enter yet.

### Tick 2 — Mask 2

Produce Mask 2 in the same coordinates while preserving Tick 1. Pixels in the
mask remain observations until later composition establishes their role. It is
the same control basket as Tick 1; family evidence still has not entered.

### Tick 3 — Family composition

Compose connected components into candidate cross-mask families. Preserve the
originating mask and component identity. Ambiguity and rejection remain visible
rather than being forced into a family. This is the first tick permitted to
introduce multiple baskets or a superposition.

### Tick 4 — Border matching

Test the precise border relationship joining the two sides of a candidate
family. For baskets, blue identifies the black-mask side, red identifies the
white-mask side, and the merge seam is explicit. Accepted and rejected mappings
both remain inspectable.

### Tick 5 — B+W subtraction

Compose accepted Mask 1 and Mask 2 pixels, then subtract that exact support from
the same evaluation region. Distinguish composed support, unclaimed pixels,
rejected or unresolved evidence, and unavailable evidence. This exposes input
for later fringe, PCA, or directional hypotheses without deciding what the
remaining pixels mean.

## Comparative forks

Any tick may fork into alternative methods. Each branch receives the same input
and executes the same remaining tick contract:

> Shared input -> Method A -> remaining ticks -> Evidence A
>
> Shared input -> Method B -> remaining ticks -> Evidence B

Methods are compared through downstream empirical consequences, not by how
convincing an isolated intermediate mask looks. If measures disagree, the
disagreement is the result.

## Review contract

A PCR passes when the completed composition makes it possible to answer:

1. What was observed?
2. How was it decomposed?
3. What relationship transformed or joined the parts?
4. What representation resulted?
5. What entered at each tick?
6. What remained outside the representation?
7. Where does the composition hold or fail across examples?
8. Does the receipt reconcile with the visible argument?

This contract does not prescribe a scene graph, drawing library, fixed layout,
generic execution engine, PCA method, or ABFeature structure. Those decisions
must be earned by repeated use.
