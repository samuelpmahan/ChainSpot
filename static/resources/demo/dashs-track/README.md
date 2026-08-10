# Demo dataset — Dash's Track, McKinney/Frisco, TX

Real captures of a real disc golf course, served publicly so the `/demo`
walkthrough can feed genuine inputs into the genuine `/stitch-map`,
`/annotate-round`, and `/create-graphics` routes. Nothing here is synthetic and
nothing here is a screenshot of ChainSpot itself.

| File | What it is |
| --- | --- |
| `udisc-capture-1.png` … `udisc-capture-4.png` | Four 1290×2796 iPhone screenshots of the UDisc course map, phone status bar and UDisc chrome included, covering the course as a 2×2 grid with overlap. Restored from git history (`git show b8323db^:static/resources/clean-tiles/clean-tile-{1..4}.PNG`) — these were the four raw captures behind the pre-stitched export commit `b8323db` deleted as "zero references" before this dataset existed. Only the four raw tiles were restored; the pre-stitched composite (`clean-tile-1-stitched.png`) was deliberately left out — the walkthrough's whole point is that Smart Import computes that arrangement live, so shipping a precomputed one would contradict it. |
| `udisc-round-overview.png` | A single 1290×2796 iPhone screenshot of the same course, mid-round: blue landing droplets mark thrown holes and a purple walking path traces holes 1–2. Copied byte-for-byte from `resources/ThrownRounds/IMG_5613.png` (a second, independent capture, not derived from the four tiles above). Unlike the four map-creation tiles, **this one is used exactly as captured, full phone chrome and all** — status bar, the "Dash's Track / Main" title bar, the "18 Holes • Par 54 • 3612 ft" banner, and the bottom nav bar. The Annotate Round handoff does not crop chrome on this path; that is a known, accepted property of this capture, not a bug to route around. This is still an **interim stand-in** for the round-annotation step — the user has said a cleaner capture is coming before this demo goes to anyone else. Swapping it stays a pure data change: replace this file (or point the `roundOverview` entry in `src/lib/demo/catalog.ts` at a new one) and nothing else. |

The capture files are **deliberately named without their grid position**, and
capture number does not follow the order they were taken in. Smart Import infers
placement from image content and never from the file name, so handing it a
shuffled, position-free set is an honest demonstration rather than a staged one.
Keep it that way if these files are ever replaced.

Smart Import's placement inference has not been validated against this
specific dataset in this repo's automated tests (the demo previously used
Bill Allen Memorial Park's captures, which were tuned against a known
direction-mismatch false positive — see `docs/demo-walkthrough.md`'s "What
building the demo found" section). Whether these four tiles produce a
"strong, no warnings" arrangement the way the prior dataset did is unverified;
watch for spurious direction-mismatch warnings the first time this dataset is
run through the real Smart Import pipeline in a browser.

The clean basemap for Create Graphics is not stored here. The walkthrough
fetches it live from USGS NAIP after locating the course through OpenStreetMap
Nominatim, because that is exactly what a real user does.
