# TODO (MVP, not pre-MVP): pre-read the thrown round during Import

The fair-use rule discards EVERY UDisc-derived pixel the moment annotation is
confirmed (see docs/rebuild-spec.md "Import Data page + fair-use pixel
discard"). Consequence for this folder:

- Walk-trace extraction (`walk-vertex` emissions, ordered via `seq`) and
  LandingDroplet detection (`landing-droplet` emissions) for the THROWN ROUND
  screenshot must run DURING Import, before the discard point at
  confirmAnnotation() in src/routes/+page.svelte.
- Their emissions are the only thing Map Round gets — by the time its page
  renders, the source pixels no longer exist anywhere.
- Registration of the round image onto the course blank (badge/basket
  correspondence → Transform2D) must likewise be computed pre-discard.
- Emissions land in the page's `detections` store today; the Import page must
  copy the thrown round's walk/droplet/registration results into the session
  handoff (MappedRound) at confirm, alongside CourseMap.

Delete this file when the pre-read pipeline exists and Map Round consumes
MappedRound end-to-end.
