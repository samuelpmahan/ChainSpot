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

The corner each capture is *labelled* with is the product's own judgement, and
on this course it is worth understanding before showing it to anyone. The two
left captures overlap almost completely in the vertical direction, so Smart
Import reports "usable; review recommended" with a direction-mismatch warning
and may label the two left captures' corners the other way up. The placements it
computes are still correct and the exported composite is still the right map —
which is exactly the point the walkthrough makes at this step: every automatic
decision is shown with its confidence and stays correctable by hand.

The clean basemap for Create Graphics is not stored here. The walkthrough
fetches it live from USGS NAIP after locating the course through OpenStreetMap
Nominatim, because that is exactly what a real user does.
