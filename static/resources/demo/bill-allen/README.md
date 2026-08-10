# Demo dataset — Bill Allen Memorial Park, Frisco, TX

Real UDisc captures of a real 18-hole course, served publicly so the `/demo`
walkthrough can feed genuine inputs into the genuine `/stitch-map`,
`/annotate-round`, and `/create-graphics` routes. Nothing here is synthetic and
nothing here is a screenshot of ChainSpot itself.

| File | What it is |
| --- | --- |
| `udisc-capture-1.png` … `udisc-capture-4.png` | Four 1290×2796 iPhone screenshots of the UDisc course map at one fixed zoom, covering the course as a 2×2 grid with roughly 25% overlap. |
| `udisc-course-overview.jpg` | A single lower-zoom UDisc screenshot of the whole course. Reference/context only — it is not a clean basemap, and the walkthrough never feeds it to Create Graphics. |

The capture files are **deliberately named without their grid position**, and
capture number does not follow the order they were taken in. Smart Import infers
placement from image content and never from the file name, so handing it a
shuffled, position-free set is an honest demonstration rather than a staged one.
Keep it that way if these files are ever replaced.

These captures overlap generously — the two left-hand ones share most of their
content. That is a supported capture style, not a flaw in the dataset: more
overlap means stronger neighbor matches. Smart Import may label the two
left-hand captures' corners the other way up, because with that much shared
content either vertical ordering explains the overlap. The placements it
computes are correct either way and the exported composite is the right map.

The clean basemap for Create Graphics is not stored here. The walkthrough
fetches it live from USGS NAIP after locating the course through OpenStreetMap
Nominatim, because that is exactly what a real user does.
