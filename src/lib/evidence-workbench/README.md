# E badge workbench probe

Storybook owns only selection and projection. The temporary source adapter recomputes live badge
evidence; `BadgeEvidenceView` and the CI image receipt both consume the same pure
`projectBadgeImage()` result.

```sh
npm run storybook
npm run build-storybook
npm run test-storybook
npm run storybook:receipt
```

`CHAINSPOT_BADGE_IMAGE` may point at a DashsTrack source image. Otherwise the adapter looks for the
sibling `chainspot-corpus` checkout. Without that private corpus, Storybook still compiles and marks
the evidence library unavailable instead of silently substituting a fixture.
