# E badge workbench probe

Storybook owns only selection and projection. Its source adapter executes the opt-in Badge E
producer and decodes the resulting content-addressed artifacts; `BadgeEvidenceView` and the CI
image receipt both consume the same pure `projectBadgeImage()` result.

```sh
npm run storybook
npm run build-storybook
npm run test-storybook
npm run storybook:receipt
```

`CHAINSPOT_BADGE_IMAGE` may point at a DashsTrack source image. Otherwise the adapter looks for the
sibling `chainspot-corpus` checkout. Without that private corpus, Storybook still compiles and marks
the evidence library unavailable instead of silently substituting a fixture. With the corpus, the
image test also proves every E-backed badge-0 projection is byte-identical to the earlier direct
recomputation backend.

## Staging ProofFloor

`npm run build` compiles only application routes. `npm run build:staging` overlays
`src/staging-routes` for that build and then shears the generated route tree away. The staging build
therefore contains `/lab` and `/lab/pcr`; the production build contains neither route nor its LAB
code.

`/lab/pcr` reuses the Storybook inspection molecules against the same materialized computation. It
opens with the checked `DEFAULT_PCR_INSPECTION_PLAN` (Badge PCR, `badgeStage.masks`, badge 1,
composed Materialization). The staging build fails loudly if the corpus is absent or any default
PCR, Tick, or specimen identity has drifted.
