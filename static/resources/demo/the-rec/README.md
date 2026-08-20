# Demo dataset — The REC, McKinney, TX

Real captures of a real 9-hole disc golf course (9 Holes • Par 27 • 2175 ft),
served publicly so the `/demo` walkthrough can feed genuine inputs into the
genuine `/stitch-map`, `/annotate-course`, `/map-round`, and
`/create-graphics` routes. Nothing here is synthetic and nothing here is a
screenshot of ChainSpot itself.

| File | What it is |
| --- | --- |
| `rec-capture-1.png`, `rec-capture-2.png` | Two 1290×2796 iPhone screenshots of the UDisc course map (left and right halves, generous overlap), phone status bar and UDisc chrome included. Copied byte-for-byte from the corpus repo's `demo/TheRec-L.PNG` / `demo/TheRec-R.PNG`. The capture files are deliberately named without their positions; Smart Import infers placement from image content, never the file name. |
| `rec-round-overview.png` | A single 1290×2796 iPhone screenshot of the same course, mid-round: UDisc's own purple thrown-route lines and per-hole markers are pixels in the image. Copied byte-for-byte from the corpus repo's `demo/TheRec-Thrown-full.PNG`. Used exactly as captured, full phone chrome and all (status bar, "The REC / Yellow DISCatcher Pro" title, "9 Holes • Par 27 • 2175 ft" banner, bottom nav) — the Map Round handoff does not crop chrome on this path. Unlike the previous demo course's thrown capture (2 holes), this round covers the full course, which is why The REC is the demo dataset. |

Two properties of this dataset the walkthrough narration accounts for:

- **Capture zoom.** These screenshots are at 2× the render zoom the
  detection corpus was measured at. Basket sprites and hole badges are
  screen-space (identical at any zoom); corridors, basket zones, and tee
  pads are geographic (doubled here). The demo arms the NuThing
  render-identity detection lane with its capture calibration
  (`nuthingGeoScale` 0.5) via `src/lib/demo/catalog.ts`'s `vision` field —
  swapping datasets remains a pure data change.
- **Thrown-round triage.** Handing Stitch Map these two clean captures can
  surface the "is one of these the thrown round?" question; the honest
  answer for this set is "No thrown round — stitch all", and the step's
  narration says so. The played round arrives separately in Map Round.

The clean basemap for Create Graphics is not stored here. The walkthrough
fetches it live from public aerial imagery after locating the course through
course search, because that is exactly what a real user does.
