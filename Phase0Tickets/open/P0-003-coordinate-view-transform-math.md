# P0-003: Coordinate and view-transform mathematics

## Status

`open`

## Objective

Provide a small, deterministic coordinate boundary that keeps saved point locations fixed in original image space through every display transform.

## Why this exists

Coordinate correctness is the central Phase 0 risk. Pointer, canvas, CSS, and device-pixel-ratio coordinates must not leak into authoritative annotations.

## Scope

- Implement pure image-to-screen and screen-to-image conversion for scale and translation view transforms.
- Implement original-pixel to normalized-coordinate conversion and compatible normalized-value verification/recomputation.
- Define and implement the Phase 0 point bounds policy for click, drag, nudge, numeric entry, and load validation consumers.
- Implement fit-transform calculation from intrinsic image dimensions and available pane size.
- Document the coordinate spaces and the point at which Konva/pointer input must be inverted into image space.

## Out of scope

- Konva event wiring, actual pan/zoom UI, marker rendering, or responsive layout.
- Image registration, affine/projective math, canonical course coordinates, geospatial coordinates, or arbitrary transform frameworks.
- Device-specific canvas abstractions.

## Dependencies

P0-001

## Requirements

- Original pixel coordinates use `[0,width) × [0,height)` and remain authoritative.
- `xNorm = xPx / width` and `yNorm = yPx / height`; normalization must reject invalid dimensions.
- Inverse conversion must account for combined pan and zoom, not CSS bounds alone.
- Image-to-screen-to-image round trips must remain within an explicitly small numeric tolerance.
- Calculations must not depend on device pixel ratio.
- Fit behavior must preserve aspect ratio and be deterministic for a given image/pane size.
- Bounds handling must be explicit and consistent; callers may request rejection or intentional clamping where the interaction requires it, without silently storing out-of-range values.

## Implementation notes

A simple view transform containing scale and translation is sufficient. Isolate these functions because they protect an explicit architectural boundary and have several Phase 0 consumers. Do not wrap Konva's general transform system or create an abstraction for alternate canvas libraries.

## Acceptance criteria

- [ ] Identity, pan-only, zoom-only, and combined conversions return expected coordinates.
- [ ] Image-to-screen and inverse round trips meet the documented tolerance.
- [ ] Normalized conversions use original intrinsic dimensions and preserve pixel authority.
- [ ] Bounds helpers consistently reject or intentionally clamp points at every edge.
- [ ] Fit transforms center the full image without changing its aspect ratio.
- [ ] Changing simulated device pixel ratio does not change any project coordinate result.

## Test requirements

- Unit-test identity, pan, zoom, combined pan/zoom, negative translation, and non-integer scale conversions.
- Unit-test image-to-screen-to-image round trips across representative points.
- Unit-test normalized conversion, invalid/zero dimensions, and compatible normalized-value recomputation.
- Unit-test edge bounds and clamping/rejection policy.
- Unit-test fit calculations for portrait, landscape, square, and narrow pane sizes.
- Unit-test device-pixel-ratio independence directly rather than relying on visual behavior.

## Manual verification

None.

## Deliverables

- Focused pure TypeScript coordinate and fit-transform functions.
- Deterministic unit tests.
- Concise coordinate-space contract documentation.

## Completion record

### Summary

### Tests run

### Manual checks

### Deviations

### Follow-up concerns
