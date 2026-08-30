# Patch 0003 — RadialRender skeleton

## Why
TrueNorth and angled/influence views appear to share one radial visual grammar. We want the shared primitive before either view grows bespoke rendering logic.

## Expected change
Adds a `RadialRender` skeleton plus two thin presets:
- `TrueNorth`: image north is visual 0°.
- `AngledInfluence`: an explicitly supplied truth-blind reference frame becomes visual 0°.

Both use the documented bottom-center basket pole tip as semantic origin.

## What must NOT change
- No PCA projection math.
- No automatic incoming-angle inference.
- No truth-derived orientation.
- No statistical normalization.
- No claim that this SVG format is final.

## Verify before continuing
Smoke emits deterministic placeholder SVG/JSON outputs for both presets and logs the declared origin/reference frame. The renderer should be visibly boring but semantically correct.
