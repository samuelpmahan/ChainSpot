# `/demo` — the guided product walkthrough

A link you can send a prospective customer that walks them through ChainSpot end
to end, using real inputs, driving the real routes.

## The problem it solves

ChainSpot's value is a pipeline, not a screen: four phone screenshots become one
high-detail map, the map becomes an annotated round, the round lands on a clean
aerial basemap, and the result is per-hole graphics that survive to air. Any one
screen looks unremarkable in isolation. A prospect who opens `/stitch-map` cold
sees an empty grid and four file pickers, and has nothing to put in them.

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
/stitch-map ──▶ /annotate-round ──▶ /create-graphics
      ▲                 ▲                    ▲
      └─────────  DemoGuide rail (mounted once in +layout.svelte)  ──────┘
                  narration · step navigation · "Load the real inputs"
```

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

**2. No synthetic inputs.** The dataset is four real UDisc screenshots of a real
18-hole course (Bill Allen Memorial Park, Frisco TX), catalogued in
`src/lib/demo/catalog.ts` and served from `static/resources/demo/bill-allen/`.
`fetchDemoFile` turns each one into an ordinary `File` — same name, same MIME
type, same bytes — so a demo run exercises the identical validation, decode, and
error paths a customer's own screenshots would.

The capture files carry no grid position in their names and are not in the order
they were taken. Smart Import infers placement from pixel content, so a shuffled,
position-free set makes the inference demonstrable rather than staged.

**3. No mocked services.** The clean basemap is deliberately *not* shipped as a
fixture. Step 3 sends the visitor through the live OpenStreetMap Nominatim
search and the live USGS NAIP `exportImage` endpoint the product already uses,
with a real course name as the query. A prospect who suspects the aerial is
canned can type their own course instead and watch it work.

**4. No precomputed results.** Arming puts files where a real intake path finds
them and stops. It never writes an editor, never supplies placements, crops, or
detections. Whatever arrangement appears on screen was computed by the product
while the visitor watched.

## Arming: how real inputs reach a real route

Two of the three stages needed no new seam at all.

| Stage | Path in | New code |
| --- | --- | --- |
| Annotate Round | `setPendingHandoff({ targetRole: 'source-overview' })` — the store Stitch Map's "Use as UDisc source" already writes | none |
| Create Graphics | same store, `targetRole: 'target-basemap'` (unused: step 3 fetches its own basemap live) | none |
| Stitch Map | `src/lib/demo/stageInbox.ts`, a one-shot slot claimed on mount and passed straight to `requestSmartImport` | 2 lines in the route |

Reusing the product's own handoff store is the load-bearing choice. Annotate
Round shows its ordinary import banner, applies its ordinary replacement and
point-discard rules, and reports its ordinary errors — a demo visitor sees the
real intake contract, and the demo has nothing of its own that can drift away
from it.

The Stitch Map inbox exists because Stitch Map has no equivalent store, and it
is modelled directly on `src/lib/stitch/handoff.ts`: module-level, one-shot,
cleared by a full page reload, carrying plain `File`s and nothing precomputed.

### The one thing arming must never do

`armDemoStep` refuses to overwrite a pending handoff that is already waiting,
because that handoff is usually the visitor's own stitched export from step 1.
Replacing their work with a sample would be the single most damaging thing this
code could do, so it is a guard in `src/lib/demo/arming.ts` and a unit test in
`tests/unit/demoWalkthrough.test.ts`.

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

Advancing only navigates when the next step lives on a different route. Steps 3
through 5 all happen on Create Graphics, and re-navigating would throw away the
basemap and correspondences the visitor just created.

## What the walkthrough claims, and where it is honest

Step 1 is the load-bearing one, and on this dataset the product reports
"usable; review recommended" with a direction-mismatch warning: the two
left-hand captures overlap almost completely in the vertical direction, so
corner labelling is genuinely ambiguous. The computed placements are still
correct and the exported composite is still the right map.

The step's narration says so up front rather than hoping nobody reads the status
line. A product that shows its confidence and stays correctable is a better
thing to demonstrate than one that pretends to be certain, and a prospect who
spots an unmentioned warning stops believing the rest of the tour.

For the same reason, `tests/e2e/demo.spec.ts` asserts what matters to a visitor —
four distinct captures placed, an arrangement the product itself calls
exportable — and not which corner each file lands in. Pinning corner labelling
there would make it a Smart Import regression test wearing a demo's clothes, and
it would fail for reasons that have nothing to do with the demo.

## Files

| File | Role |
| --- | --- |
| `src/routes/demo/+page.svelte` | Cover page: pitch, dataset, five steps, start controls |
| `src/lib/components/DemoGuide.svelte` | The guide rail, mounted in the layout |
| `src/lib/demo/catalog.ts` | Dataset manifest and step script — the only place to edit copy |
| `src/lib/demo/assets.ts` | Catalogued asset → ordinary `File`, with typed failures |
| `src/lib/demo/arming.ts` | The one place the demo touches product state |
| `src/lib/demo/stageInbox.ts` | One-shot Stitch Map inbox |
| `src/lib/demo/tour.svelte.ts` | Reactive narration cursor |
| `static/resources/demo/bill-allen/` | The real captures, with provenance in its README |

Adding a course is a data change in `catalog.ts` plus files in `static/`. It must
never require a new branch in a route.

## Cost

The four captures total roughly 15 MB, because that is what four full-resolution
phone screenshots weigh — the demo pays the same intake cost a customer does.
They are fetched only when a visitor starts the walkthrough, never on the cover
page, which loads one 0.6 MB overview image.
