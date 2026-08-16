# 2026-08-15 — Integration changelog

## Annotation workflow

Hole review now follows the natural Tee → Basket → Bends → Approve sequence. Once tee and basket exist, empty-map clicks place corridor bends directly. Bends are ordered geometrically along the tee→basket path, including after drag edits. Guide/corridor geometry is covered against stale updates. Hole navigation centers on the number badge when available and preserves the current zoom.

## Keyboard correction workflow

Annotate Course now has a keyboard-first review path: Tab accepts and advances through TEE → BASKET → BENDS → next hole, X rejects the current proposal, Ctrl-Z restores workflow/annotation/camera state, WASD pans, Q/E zooms, and 1–6 adjust corridor width. The active hole and current review step are shown on-map. Existing mouse interaction remains available.

## Manual correction safety

Local snap is capped at a small absolute correction distance so CV cannot pull a manual correction far away. A hole's own badge no longer steals placement clicks for that hole. Badge click-target sizing is now UI-owned instead of derived from CV candidate dimensions.

## Heritage tee detection

Using the authoritative Heritage annotations in the same post-autocrop coordinate frame production uses, 17/18 tee truths have a reliable nearby bright-component correspondence under the current audit rule. Fifteen fail the current minimum-area geometry check, H5/H10 correspond to oversized merged bright components and fail maximum area, and H15 has no reliable correspondence. None reaches the appearance gate. The active geometry/scale alternatives remain experiments rather than production changes.

## Heritage false-positive protection

A separate Heritage failure showed that a bright surface could satisfy the tee geometry rules without containing the characteristic gray tee-pad interior. Production now requires the already-established gray-interior signal for this candidate class, preventing the observed rooftop false positive from being silently auto-applied as a tee.

## Ribbon investigation tooling

Added a reusable ribbon-component inspector that reports badge/basket component agreement, component size/bounds, nearby seeds, and can render the isolated connected component for visual inspection. Generated ribbon inspection renders are ignored by Git. Ribbon transparency, segmentation, prefill, occluder bridging, continuity, tracing, and bend extraction remain active experiment work rather than production defaults.

## CV experiment structure

Production stays on `main`. Geometry/scale candidate-generation work belongs on `experiment/cv-geometry-scale`; ribbon recovery/tracing work belongs on `experiment/cv-ribbon-tracing`. CoNoCo, SAM, and other orthogonal probes remain optional experiment patches that may be composed with either branch without implying promotion to production.

## Toph

Toph proved useful as a machine-auditable P1 debugging layer: it can preserve mask/component identity, ordered check execution, first rejection, short-circuited checks, correspondence reliability, and materialization lineage. The Heritage trace was sufficient to separate minimum-area failures, oversized merged components, unreliable correspondence, and stages never reached. Remaining work is to instrument the places where objects can still disappear before the current audited stages.
