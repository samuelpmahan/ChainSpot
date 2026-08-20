# `/demo` — the guided product walkthrough

A link you can send a prospective customer that walks them through ChainSpot end
to end, using real inputs, driving the real routes.

## The problem it solves

ChainSpot's value is a pipeline, not a screen: four phone screenshots become one
high-detail map, the map becomes an annotated course, the course lands on a
clean aerial basemap, and the result is per-hole graphics that survive to air.
And the map pays off more than once — a course built today is a course
Course Memory remembers for every round played on it afterward, with no
re-annotation of the geometry. Any one screen looks unremarkable in isolation.
A prospect who opens `/stitch-map` cold sees an empty grid and four file
pickers, and has nothing to put in them.

So the demo has to supply the inputs. The design question is what kind of demo
that makes it, and there is a bad answer that is very easy to reach for: a
guided-tour route that renders its own canvas, replays a recorded interaction,
or ships precomputed results. That demo is cheap to build and worth nothing —
the one thing a prospective customer wants to know is whether the product does
this on real data, and a mock cannot answer that question.

## The shape

`/demo` is a **narration layer over the real product**, not a second
implementation of it.

```
/demo (cover page)
  │  "Start the walkthrough"
  │    1. fetch real assets  →  2. hand to a real intake path  →  3. goto(real route)
  ▼
/stitch-map ──▶ /annotate-course ──▶ /create-graphics ──▶ (real reload) ──▶ /map-round ──▶ /create-graphics
      ▲                 ▲                    ▲                                    ▲                    ▲
      └───────────────────────────  DemoGuide rail (mounted once in +layout.svelte)  ─────────────────────┘
                              narration · step navigation · "Load the real inputs"
```

Build the map once (stitch, annotate on Annotate Course), put one course on
air (basemap + export), then prove the map is worth having built: a real
browser reload — the guide's own affordance, never a proxy for a product
control — clears every in-memory session the app keeps, and the walkthrough
finishes by annotating a *played round* of the same course (Map Round: throws
and walking path) purely from what Course Memory remembered across that
reload. Annotate Course and Map Round used to be one shared `/annotate-round`
route with an internal mode toggle; they are now two real routes, each visited
exactly once by the script.

Every step is performed on a production route by production code. The demo owns
exactly three things: which real assets to hand over, what the visitor is told,
and where they are in the script.

### Why the rail lives in the layout

The guide is mounted once in `src/routes/+layout.svelte` so a tour survives
client-side navigation between the stages it walks through. It renders nothing
at all unless a tour is running, so it costs non-demo users one `if`.

It is an overlay, never a wrapper. It does not proxy clicks, gate controls, or
dim the page, because the most valuable moment in a demo is the one where the
visitor stops following the script and pokes at the product — the rail has to
survive that without losing its place.

## The four rules

These are the constraints that make the demo worth sending, and each one is
enforced somewhere in code or tests rather than by good intentions.

**1. No mocked surfaces.** No demo-only canvas, no scripted animation, no
screenshot of the app pretending to be the app. `tests/e2e/demo.spec.ts` asserts
that starting the walkthrough lands on `/stitch-map` and that the real stitch
workspace is what renders.

**2. No synthetic inputs.** The map-creation dataset is four real UDisc
screenshots of a real 18-hole course (Dash's Track, McKinney/Frisco TX area),
catalogued in `src/lib/demo/catalog.ts` and served from
`static/resources/demo/dashs-track/`. `fetchDemoFile` turns each one into an
ordinary `File` — same name, same MIME type, same bytes — so a demo run
exercises the identical validation, decode, and error paths a customer's own
screenshots would.

The capture files carry no grid position in their names and are not in the order
they were taken. Smart Import infers placement from pixel content, so a shuffled,
position-free set makes the inference demonstrable rather than staged.

The round-annotation dataset is a second, independent real capture of the
*same* course, already played: UDisc's own blue landing droplets and purple
walking path are pixels in that screenshot, and the visitor annotates over
them. It carries full phone chrome — status bar, course title bar, hole/par
banner, bottom nav — and, unlike the four map-creation tiles, nothing crops
it before Map Round sees it; the narration says so rather than
pretending otherwise. It is a deliberate interim stand-in the user has said
will be replaced with a cleaner capture (see
`static/resources/demo/dashs-track/README.md`) — swapping it for a better
capture is scoped to be a one-field catalog change plus a file under
`static/`, never a new branch in a route.

**3. No mocked services.** The clean basemap is deliberately *not* shipped as a
fixture. The basemap/export steps — before *and* after the reload — send the
visitor through the live OpenStreetMap Nominatim search and the live USGS NAIP
`exportImage` endpoint the product already uses, refetched from scratch the
second time because nothing about a fresh page load is special-cased for the
demo. A prospect who suspects the aerial is canned can type their own course
instead and watch it work.

**4. No precomputed results.** Arming puts files where a real intake path finds
them and stops. It never writes an editor, never supplies placements, crops, or
detections. Whatever arrangement appears on screen was computed by the product
while the visitor watched.

## Arming: how real inputs reach a real route

Two of the three stages needed no new seam at all.

| Stage | Path in | New code |
| --- | --- | --- |
| Annotate Course (step 2) | `setPendingHandoff({ targetRole: 'source-overview', destination: 'annotate-course' })` — the store Stitch Map's "Use as UDisc source" already writes. No demo-side arming: the product's own handoff carries the visitor's own stitched export forward. | none |
| Map Round (step 5) | Same store, demo-armed this time (`DemoArming` kind `annotate-source`) with the played-round capture and `destination: 'map-round'`, since there is no upstream product step to hand this one off. | none — reuses the same store |
| Create Graphics | Same store, `targetRole: 'target-basemap'`, `destination: 'create-graphics'` (unused: the basemap steps fetch their own aerial live) | none |
| Stitch Map | The pending-stitch-captures slot in `src/lib/session.ts` (originally its own `demo/stageInbox.ts`, folded into the session-state consolidation), claimed on mount and passed straight to `requestSmartImport` | 2 lines in the route |

Reusing the product's own handoff store is the load-bearing choice. Either
annotation route shows its ordinary import banner, applies its ordinary
replacement and point-discard rules, and reports its ordinary errors — a demo
visitor sees the real intake contract, and the demo has nothing of its own
that can drift away from it. This is why the Map Round step's arming still
routes through that store instead of inventing a second one, even though
nothing upstream produced its input. `destination` is what disambiguates the
two annotation routes now that both accept a `source-overview`-role image
(see `PendingHandoffDestination` in `$lib/session.ts`) — before the route
split a single shared `targetRole` was enough, because exactly one route
claimed each role.

The Stitch Map inbox exists because Stitch Map has no equivalent store, and it
is modelled directly on `src/lib/stitch/handoff.ts`: module-level, one-shot,
cleared by a full page reload, carrying plain `File`s and nothing precomputed.

### The one thing arming must never do

`armDemoStep` refuses to overwrite a pending handoff that is already waiting,
because a waiting handoff is usually the visitor's own work in transit — their
stitched export on the way to Annotate Course in step 2, or (less likely, but
the guard does not special-case which role) a basemap export on its way to
Create Graphics. Replacing it with a sample would be the single most damaging
thing this code could do, so it is a guard in `src/lib/demo/arming.ts` and a
unit test in `tests/unit/demoWalkthrough.test.ts` covering both roles the
shared slot can carry.

Related: a failed asset load leaves the Stitch Map inbox *empty* rather than
half-filled. Three of four files would reach Smart Import as a wrong-file-count
rejection, which reads to a prospect as a product defect rather than the network
problem it is.

## Tour state

`src/lib/demo/tour.svelte.ts` holds a reactive cursor over `DEMO_STEPS` and
nothing else — no images, no project state, no editor. That separation is what
makes "Exit demo" safe: it clears a cursor, and everything the visitor built
stays exactly where it is. Leaving the tour leaves them holding a real, fully
usable project they can keep working on with their own course.

Position is mirrored into `sessionStorage`, never `localStorage`. A full page
reload clears every in-memory session the product keeps, and without this the
visitor would also be dumped back at the cover page. Only two integers and a
flag are stored; loaded images and project state deliberately do not survive,
exactly as in normal use. The stored value is treated as untrusted — anything
malformed or out of range resets to a closed tour rather than throwing on
mount, so a storage-disabled browser still runs the demo.

## Step navigation and route changes

Advancing only navigates when the next step lives on a different route. The
basemap/export step and the reload step both happen on Create Graphics, and
re-navigating between them would throw away the basemap and correspondences
the visitor just created. Annotate Course (step 2) and Map Round (step 5) are
two distinct routes now, each visited exactly once, so the ordinary `goto`
path applies there same as anywhere else — before the route split they were
one shared `/annotate-round` route visited twice (once per mode), which is
what originally motivated `DemoGuide`'s repeated-route fallback logic. That
fallback is still needed today for Create Graphics, which is still visited
three times.

### The reload step

One step (`kind: 'reload'` in `src/lib/demo/catalog.ts`) is not a narration-only
stop: its Next action, `DemoGuide`'s `reloadAndAdvance`, performs a real
`window.location.assign`, not an SPA `goto`. This is deliberate, not an
oversight — the step's narrated claim is that in-session product state does not
survive a reload, and an SPA navigation would leave `src/lib/session.ts`'s
retained editors sitting there untouched, making the claim false. Advancing the
tour cursor (which persists to `sessionStorage`) happens *before* the
navigation fires, so `DemoTour.restore()` on the reloaded page resumes on the
reload step's successor rather than replaying the reload step itself.

## What building the demo found

Step 1 was the load-bearing one for the walkthrough's first dataset (Bill Allen
Memorial Park), and running it surfaced a real defect worth fixing rather than
narrating around: the product reported "usable; review recommended" with a
direction-mismatch warning on captures that were placed perfectly correctly.
The cause was that those captures overlap generously, and the more content two
tiles share, the more readily that shared region also explains itself under the
*other* orientation hypothesis. The warning therefore fired hardest at users who
captured most carefully.

The diagnostic now reports a direction mismatch only on an edge that is also
weak in the orientation the layout requires, where it is genuine evidence about
why that edge is weak. On a strongly matching edge, the committed placement came
from a near-perfect direct measurement and there is nothing a user could act on.
That dataset now reports "strong" with no warnings.

The same pass added the case that generous overlap was being confused with:
the same screenshot supplied twice, where no 2×2 exists and any arrangement
stacks two tiles and exports a map missing a quarter of the course. That is
rejected before scoring, naming both files. See `src/lib/stitch/duplicates.ts`.

Worth knowing for anything similar: the browser does **not** run
`smartImportFiles`. `smartStitch.worker.ts` is a second implementation of the
same pipeline, and a check added only to the in-process path passes its unit
tests while doing nothing in the product. The duplicate check is in both, with
one shared message builder.

`tests/e2e/demo.spec.ts` asserts what matters to a visitor — four distinct
captures placed, an arrangement the product itself calls exportable — and not
which corner each file lands in. Pinning corner labelling there would make it a
Smart Import regression test wearing a demo's clothes, and it would fail for
reasons that have nothing to do with the demo.

**Not yet re-verified against the current dataset.** The walkthrough moved to
Dash's Track's four captures without a browser run of Smart Import against
them — nothing in `tests/unit/demoWalkthrough.test.ts` or `tests/e2e/demo.spec.ts`
asserts a particular auto-layout outcome for this dataset precisely because
that outcome is unconfirmed. If the same overlap-driven direction-mismatch
false positive (or something new) shows up on this dataset, fix it the way the
paragraphs above describe — narrating around it is not an option under rule 4.

## Files

| File | Role |
| --- | --- |
| `src/routes/demo/+page.svelte` | Cover page: pitch, dataset, six steps, start controls |
| `src/lib/components/DemoGuide.svelte` | The guide rail, mounted in the layout |
| `src/lib/demo/catalog.ts` | Dataset manifest and step script — the only place to edit copy |
| `src/lib/demo/assets.ts` | Catalogued asset → ordinary `File`, with typed failures |
| `src/lib/demo/arming.ts` | The one place the demo touches product state |
| `src/lib/session.ts` | Cross-route session state, including the one-shot Stitch Map inbox the demo shares with the product (originally a dedicated `demo/stageInbox.ts`, folded in by the session-state consolidation) |
| `src/lib/demo/tour.svelte.ts` | Reactive narration cursor |
| `static/resources/demo/dashs-track/` | The real captures, with provenance in its README |

Adding a course is a data change in `catalog.ts` plus files in `static/`. It must
never require a new branch in a route.

## Cost

The four map-creation captures total roughly 17 MB and the round-annotation
capture roughly 4 MB more, because that is what full-resolution phone
screenshots weigh — the demo pays the same intake cost a customer does. Assets
are fetched only when a visitor starts the walkthrough at the step that needs
them, never speculatively and never on the cover page, which no longer loads a
standalone overview image.
