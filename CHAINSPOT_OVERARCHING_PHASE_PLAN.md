# Project ChainSpot
## Overarching Product and Phase Plan

**Codename:** Project ChainSpot  
**Working product description:** A local-first creator tool that converts user-supplied disc golf round maps and clean basemaps into reusable, broadcast-ready hole graphics.

## 1. Product hypothesis

Disc golf video viewers often cannot tell:

- the intended shape of a hole;
- where the tee and basket are relative to one another;
- where a player currently lies;
- how a shot changed the remaining route to the basket.

Creators rarely add hole overlays because producing them manually is too time-consuming relative to the size of the audience. UDisc already captures much of the useful source information: full-course routing, per-hole corridors, tees, baskets, GPS tracks, and optional throw-by-throw positions. ChainSpot does not need to replace UDisc or require a second tracking workflow. It needs to turn user-provided UDisc screenshots into clean, editable graphics.

The initial product hypothesis is:

> A creator will use hole graphics when an entire round can be prepared with a short import-and-correction workflow rather than hand-built in a video editor.

This is intentionally scoped as a high-leverage indie tool, not a venture-scale platform. A successful outcome could be a useful weekend project, a small recurring-revenue product, or a relationship-builder with creators, manufacturers, and tournament media teams.

## 2. Core workflow

1. The creator records a round in UDisc, using throw-by-throw tracking.
2. The creator uploads a north-up full-round UDisc overview screenshot.
3. The creator uploads a clean north-up satellite or aerial image of the same course.
4. ChainSpot aligns the two images using manual and later automatic image registration.
5. ChainSpot transfers the useful geometry from the UDisc image into a clean coordinate system:
   - hole corridors;
   - tees and baskets;
   - throw positions;
   - optional walking path;
   - optional hole labels and metadata.
6. The user reviews the 18-hole extraction and supplies closer screenshots only for ambiguous holes.
7. ChainSpot renders reusable single-hole graphics and optionally an animated throw progression.
8. The creator exports transparent or composited assets for their editing workflow.

## 3. Guiding principles

### 3.1 Local-first

The first versions should run entirely in the browser or on the creator's machine. User screenshots may reveal precise location history, so there should be no unnecessary upload requirement.

### 3.2 Human-correctable, not magically perfect

The system should attempt automation but always provide fast correction controls. Three reliable clicks and ten seconds of cleanup are better than a brittle promise of one-click perfection.

### 3.3 Structured geometry over edited screenshots

UDisc screenshots are references and annotations, not the final product. ChainSpot should convert useful information into its own editable vector representation rather than simply cropping and redistributing the screenshot.

### 3.4 Progressive refinement

The full-round screenshot establishes the global course context. Close-up screenshots refine only the holes that need more detail. Users should not be required to submit 18 close-ups by default.

### 3.5 No AI dependency

The core product should rely on deterministic geometry, classical computer vision, and direct manipulation. Neural vision models may later help with difficult cases, but they are not required for the proof of concept.

### 3.6 Stable internal coordinate system

Every observation—overview screenshot, close-up screenshot, clean map, manually edited geometry—must map into one canonical course coordinate system. This keeps later extraction, rendering, and refinement composable.

## 4. System model

ChainSpot works with three conceptual layers:

1. **Reference layers**
   - UDisc full-round screenshot;
   - optional UDisc hole close-ups;
   - clean satellite or aerial image.

2. **Registration data**
   - corresponding control-point pairs;
   - estimated transforms;
   - residual error and confidence;
   - crop and viewport metadata.

3. **Course geometry**
   - hole corridor polygons;
   - tee and basket points;
   - throw points and straight displacement segments;
   - optional route polylines;
   - labels, par, distance, and style metadata.

Reference images can be replaced later without invalidating the course geometry, provided the new image can be registered into the canonical coordinate system.

## 5. Phase plan

## Phase 0 — Correspondence Workspace

Build the foundational browser workspace for loading two images and creating trustworthy matching control points.

**Primary output:** A saved project containing two source images and editable point correspondences in image-space coordinates.

**Includes:**

- two-image upload and display;
- independent pan and zoom;
- paired control-point creation;
- marker drag, delete, relabel, and reorder;
- undo and redo;
- project save and reload;
- original pixel and normalized coordinate storage;
- basic validation and diagnostics.

**Explicitly excludes:**

- transform estimation;
- image warping;
- automatic feature matching;
- overlay extraction;
- hole detection;
- map APIs;
- production export assets.

**Exit gate:** A user can accurately create and revise 3–10 correspondences across two differently sized images without coordinate drift after zooming, panning, resizing, saving, or reopening.

Detailed implementation requirements live in `ChainSpot_PHASE_0_DETAILED_PLAN.md`.

---

## Phase 1 — Manual Image Registration

Use Phase 0 control points to estimate and preview an alignment between the UDisc overview and the clean map.

**Capabilities:**

- similarity transform from two or more point pairs;
- affine transform from three or more non-collinear pairs;
- robust estimation when extra pairs are present;
- transformed overlay preview;
- opacity slider and flicker comparison;
- residual error shown per control point;
- ability to disable an outlier pair;
- transform reset and recompute.

**Design constraint:** Begin with similarity and affine transforms. Do not introduce homography until real examples show that affine registration is insufficient.

**Exit gate:** On representative north-up screenshots, a user can align stable landmarks across most of the course with a short control-point workflow and visually verify the result.

---

## Phase 2 — Registration Assistance

Reduce the amount of manual alignment work while preserving the Phase 1 correction workflow.

**Capabilities:**

- automatic candidate feature detection using classical methods such as SIFT, AKAZE, or ORB;
- feature matching between the UDisc background and clean map;
- RANSAC-based rejection of mismatches;
- automatic transform proposal;
- confidence and match visualization;
- manual correction using the existing control-point editor;
- diagnostics for incompatible imagery, insufficient overlap, or poor landmark distribution.

**Exit gate:** The system proposes a usable initial alignment on a meaningful subset of courses and fails transparently when it cannot.

---

## Phase 3 — UDisc Overlay Extraction

Extract useful graphical annotations from the registered UDisc screenshot and convert them into editable geometry.

**Initial targets:**

- translucent hole corridor regions;
- tee and basket markers;
- throw markers;
- straight throw displacement segments;
- optional purple walking route;
- optional hole-number labels.

**Likely techniques:**

- HSV or Lab color segmentation;
- connected components;
- morphological cleanup;
- contour extraction and simplification;
- template or shape matching for stable icons;
- image differencing when the basemap imagery is sufficiently similar;
- manual correction tools for every extracted object.

**Non-goal:** Recovering the curved physical flight of the disc. The throw tracker records endpoints; the connector represents displacement, not the exact flight path.

**Exit gate:** At least one representative tracked hole can be converted from screenshot annotations into editable vector geometry faster than tracing it manually.

---

## Phase 4 — Course and Hole Decomposition

Turn a registered full-round screenshot into a reusable 18-hole course project.

**Capabilities:**

- detect or manually identify hole corridors;
- associate tees, baskets, and labels with holes;
- maintain one global course coordinate system;
- show an 18-hole review checklist;
- flag low-confidence or overlapping holes;
- accept optional close-up screenshots;
- register each close-up back into the global course system;
- replace rough geometry with refined local geometry without disturbing other holes.

**Exit gate:** A user can create a coherent 18-hole course package from one overview plus only the close-ups that are genuinely necessary.

---

## Phase 5 — Clean Hole Renderer and Export

Transform course geometry into useful creator assets.

**Initial static outputs:**

- single-hole transparent PNG;
- single-hole composited PNG over the licensed basemap;
- 16:9 hole card;
- configurable crop, rotation, padding, and label placement;
- reusable visual themes.

**Later motion outputs:**

- animated throw progression;
- player marker state changes;
- previous lies and displacement lines;
- transparent WebM or another practical alpha-capable format;
- frame sequence export when alpha video support is inconsistent.

**Exit gate:** A creator can take one prepared hole and insert an attractive, readable export into a normal video-editing workflow without further graphic reconstruction.

---

## Phase 6 — Round Production Workflow

Make ChainSpot practical for preparing an entire filmed round.

**Capabilities:**

- round-level project view;
- batch theme and layout settings;
- per-hole overrides;
- player and throw ordering;
- reusable course maps across future rounds;
- batch export of all holes;
- naming conventions suitable for Premiere, Resolve, or Final Cut bins;
- export manifest containing hole and throw metadata;
- optional keyboard-first review flow.

**Exit gate:** A creator can prepare a complete round in a workflow measured in minutes rather than hours.

---

## Phase 7 — Productization and Distribution

Only begin after the workflow has been validated with real creators.

**Possible additions:**

- packaged desktop application;
- project templates and manufacturer branding;
- licensed clean-map provider integration;
- shared course library;
- manufacturer/team seats for sponsored players;
- paid creator tier;
- optional plugins or exchange formats for major editors;
- telemetry that is strictly opt-in and avoids raw location data.

**Commercial validation questions:**

- Do creators actually use the exported graphics?
- How many minutes per hole or round are saved?
- Do manufacturers value consistent branding enough to pay for team licenses?
- Is the highest-value customer the individual creator, media company, event organizer, or manufacturer?

## 6. Basemap strategy

The clean basemap is both a technical and licensing track.

### Proof-of-concept path

Allow the user to upload a clean, north-up aerial screenshot of the same course. This avoids blocking Phase 0 and Phase 1 on an imagery provider integration.

### Shipping path

Before commercial distribution, select a basemap source whose terms permit the intended display, transformation, caching, and export workflow. The final architecture should isolate imagery acquisition behind a provider interface so the registration and geometry pipeline does not depend on one vendor.

### Long-term possibility

Once a course has been traced and reviewed, its reusable vector geometry may become more valuable than any specific satellite image. ChainSpot should preserve that geometry independently and allow different licensed visual backgrounds or fully stylized vector rendering.

## 7. Proposed technical architecture

### Frontend

- TypeScript;
- Vite;
- Konva.js or a similarly mature scene-graph canvas library;
- modular state store with explicit serializable project state;
- Web Workers later for expensive CV operations if needed.

### CV and geometry

Two reasonable paths remain open:

1. Browser-side OpenCV.js for an entirely local application.
2. Local Python service using OpenCV and FastAPI for faster iteration and access to the full Python CV ecosystem.

Phase 0 should not commit the project to either. Its saved project format should be consumable by both.

### Persistence

- local project bundle containing project JSON and original images;
- optional IndexedDB autosave;
- no account or cloud requirement for early versions;
- versioned project schema with migrations.

### Rendering

- internal vector geometry stored independently from the canvas implementation;
- SVG or canvas preview;
- deterministic high-resolution export path;
- future video export separated from the editor state model.

## 8. Initial data model

The exact schema will evolve, but the top-level entities should remain stable:

```json
{
  "schemaVersion": 1,
  "project": {
    "id": "...",
    "name": "Sample Course Round",
    "createdAt": "...",
    "updatedAt": "..."
  },
  "images": [],
  "controlPointPairs": [],
  "registrations": [],
  "course": {
    "coordinateSystem": "canonical-course-pixels",
    "holes": []
  },
  "renderSettings": {},
  "history": {}
}
```

Each image should retain:

- immutable ID;
- semantic role;
- original width and height;
- content hash;
- file name and MIME type;
- optional crop and orientation metadata;
- view state stored separately from image-space annotations.

## 9. Primary risks

### 9.1 Basemap mismatch

Different imagery providers or capture dates may make automatic registration unreliable, especially on heavily wooded courses.

**Mitigation:** Preserve manual control points as the authoritative fallback and prefer stable landmarks such as roads, roofs, concrete edges, ponds, and trail intersections.

### 9.2 Low overview resolution

A full-course screenshot may not contain enough pixels to recover small throw markers or narrow corridors.

**Mitigation:** Use the overview for global alignment and request close-ups only for uncertain holes.

### 9.3 Overlapping holes

Dense courses may have multiple corridors and labels crossing in a small area.

**Mitigation:** Human review, per-hole isolation, and close-up refinement.

### 9.4 Fragile color extraction

Translucent overlays change appearance based on the underlying imagery.

**Mitigation:** Broad color-space segmentation, registered-image differencing, shape cues, and editable vector proposals rather than uneditable masks.

### 9.5 Licensing

A technically convenient imagery source may not permit the final export workflow.

**Mitigation:** Keep the PoC user-supplied, isolate provider integration, and validate terms before productization.

### 9.6 Building too much before demand validation

The target creator population is real but limited.

**Mitigation:** Validate each phase with actual exported graphics and creator reactions. Do not build subscriptions, collaboration, or expensive AI features before the graphics are demonstrably useful.

## 10. Near-term execution order

1. Build Phase 0 with the existing screenshots as fixtures.
2. Verify coordinate correctness through zoom, pan, resize, save, and reload.
3. Implement a minimal affine transform in Phase 1.
4. Produce one manually traced, clean Hole 1 graphic from the current test round.
5. Show that graphic to real disc golf creators before investing deeply in automatic extraction.
6. Add automation only where the manual workflow proves tedious.

## 11. Definition of proof-of-concept success

The PoC succeeds when a user can:

1. load a full-round UDisc overview and clean aerial map;
2. align them through a short correspondence workflow;
3. select or refine one hole;
4. transfer its corridor, tee, basket, and throw positions into editable geometry;
5. export a clean graphic that would materially improve a disc golf video;
6. complete the process quickly enough that using the overlay feels worthwhile.

That is the core question ChainSpot must answer before becoming anything larger.
