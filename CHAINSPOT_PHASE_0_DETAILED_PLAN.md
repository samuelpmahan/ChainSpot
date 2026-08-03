# Project ChainSpot
## Detailed Phase 0 Plan: Correspondence Workspace

## 1. Purpose

Phase 0 builds the annotation and project foundation required by every later registration, extraction, and rendering phase.

It is not an image-alignment implementation. It is a trustworthy workspace for loading two images and recording where the same physical landmarks appear in each image.

The two initial image roles are:

- **Source image:** the user-provided UDisc full-round overview screenshot;
- **Target image:** a clean, north-up satellite or aerial image of the same course.

Phase 0 must produce durable, inspectable, editable point correspondences in each image's native coordinate system.

## 2. Phase 0 success criterion

A user can load two differently sized images, create 3–10 matching landmark pairs, revise them precisely, save the project, reload it, and observe no coordinate drift after any combination of:

- panning;
- zooming;
- window resizing;
- image fitting;
- marker dragging;
- project serialization;
- project restoration.

The workspace should feel safe enough that these control points can become authoritative inputs to Phase 1 registration.

## 3. Scope

### Required

- local image upload for two image roles;
- side-by-side image workspaces;
- independent pan and zoom;
- fit-to-view and reset-view controls;
- paired control-point creation;
- visible pair numbering;
- completion-state guidance;
- marker dragging;
- pair selection;
- pair deletion;
- optional point-pair labels;
- undo and redo;
- point list with native and normalized coordinates;
- project save and reload;
- schema versioning;
- basic validation and error handling;
- deterministic automated tests for coordinate conversion and serialization.

### Recommended before Phase 1

- keyboard nudging for selected markers;
- magnified cursor preview;
- hide/show marker overlays;
- out-of-bounds protection;
- warning for incomplete pairs;
- warning when all points are tightly clustered;
- content hashes for loaded images;
- local autosave.

### Explicit non-goals

- calculating similarity, affine, or projective transforms;
- warping one image onto another;
- blending aligned images;
- automatic feature detection or matching;
- extracting UDisc overlay colors or shapes;
- detecting holes, tees, baskets, labels, or throws;
- OCR;
- calling satellite-map APIs;
- user accounts, cloud storage, payments, or collaboration;
- production graphics export.

## 4. Technology recommendation

### Application shell

- Vite;
- TypeScript in strict mode;
- a minimal component framework only if the repository already favors one;
- otherwise plain TypeScript modules and DOM controls are sufficient.

### Canvas workspace

Use Konva.js unless an existing codebase already standardizes on another mature canvas scene graph.

Reasons:

- image, marker, and future vector layers can live in one coordinate-aware scene;
- built-in transforms simplify pan and zoom;
- markers are naturally draggable;
- stage and layer separation maps cleanly onto future registration previews and extracted overlays;
- the application can convert pointer coordinates into image coordinates without positioning DOM markers over a transformed canvas.

### Persistence

Phase 0 should remain local-first.

Recommended project format:

```text
sample-round.ChainSpot.zip
├── project.json
└── images/
    ├── source-original.png
    └── target-original.png
```

A ZIP bundle avoids broken file references and makes a project portable. A simpler development milestone may begin with JSON export plus required image re-selection, but ZIP bundling should be the Phase 0 completion target.

IndexedDB may be used for local autosave, but the portable bundle is the authoritative user-controlled save format.

## 5. Domain terminology

Use consistent names in code and UI:

- **Image asset:** an uploaded raster image with immutable metadata.
- **Source image:** initially the UDisc screenshot.
- **Target image:** initially the clean map.
- **Control point:** one landmark position on one image.
- **Control-point pair:** the source and target positions that represent the same physical landmark.
- **Image-space coordinate:** a coordinate measured in original image pixels.
- **Normalized coordinate:** image-space coordinate divided by the original image width or height.
- **View transform:** pan and zoom used only to display an image.
- **Pending pair:** a pair with only one side defined.
- **Complete pair:** a pair with both source and target points defined.

Avoid calling Phase 0 points “registration points” in the data model. They may later serve several registration methods, but Phase 0 only records correspondences.

## 6. User workflow

### 6.1 New project

1. Open the application.
2. Upload the source image.
3. Upload the target image.
4. Both images appear fit within their own workspaces.
5. The application reports original dimensions and orientation.
6. The “Add correspondence” action becomes available.

### 6.2 Add a control-point pair

1. User activates **Add correspondence**.
2. UI prompts: **Click a landmark in the UDisc image.**
3. User clicks the source image.
4. A temporary marker appears with the next pair number.
5. UI prompts: **Click the same landmark in the clean map.**
6. User clicks the target image.
7. Both markers become a complete numbered pair.
8. The pair appears in the point list.
9. Add mode remains active only if the user has chosen a repeated-entry mode; otherwise it returns to selection mode.

A user must never be able to accidentally add a second source point while the target side is still pending without an explicit cancel or replace action.

### 6.3 Correct a point

The user may correct a point through any of these methods:

- drag the marker;
- select it and use arrow keys for one-pixel image-space nudges;
- enter exact pixel coordinates in the point inspector;
- delete and recreate the pair.

Dragging must remain correct at every zoom level.

### 6.4 Navigate

- mouse wheel or trackpad gesture: zoom around pointer;
- drag empty canvas: pan;
- fit: show entire image within the pane;
- reset: return to default fit;
- optional `1:1`: display one image pixel per CSS pixel when practical.

Source and target view transforms are independent. A later phase may add synchronized navigation, but it is unnecessary in Phase 0.

### 6.5 Save and reopen

1. User chooses **Save project**.
2. Application writes a versioned ChainSpot project bundle containing both original images and project JSON.
3. User closes or reloads the application.
4. User opens the project bundle.
5. Images, control points, labels, and optional view state are restored.
6. All points resolve to the same native image pixels as before saving.

## 7. UI layout

Desktop-first, with graceful narrowing rather than a full mobile workflow.

```text
┌───────────────────────────────────────────────────────────────────┐
│ Project name                 Add pair  Undo  Redo  Save  Open     │
├───────────────────────────────┬───────────────────────────────────┤
│ UDisc source                  │ Clean target                      │
│ [Fit] [1:1] [Reset]           │ [Fit] [1:1] [Reset]               │
│                               │                                   │
│            ● 1                │                 ● 1               │
│                               │                                   │
│      ● 2                      │       ● 2                         │
│                               │                                   │
├───────────────────────────────┴───────────────────────────────────┤
│ Point pairs                                                      │
│ 1  Parking corner  src (824,391) ↔ dst (614,288)  [edit] [delete]│
│ 2  Pond edge       src (511,602) ↔ dst (342,472)  [edit] [delete]│
└───────────────────────────────────────────────────────────────────┘
```

### Required visible states

- no images loaded;
- one image loaded;
- both images loaded;
- adding source side;
- adding target side;
- complete pair selected;
- point being dragged;
- invalid or unreadable image;
- unsaved changes;
- project save/open failure.

## 8. Canvas and layer architecture

Each image pane should use a scene with explicit layers:

```text
ImagePane
├── rasterImageLayer
├── futureRegistrationPreviewLayer
├── futureExtractedOverlayLayer
├── controlPointLayer
└── interactionLayer
```

Only `rasterImageLayer`, `controlPointLayer`, and `interactionLayer` need active content in Phase 0. Reserve the others in architecture or interfaces, but do not implement empty complexity merely for appearance.

Control points must be canvas scene objects anchored in image space. Do not use absolutely positioned HTML elements over the canvas.

## 9. Coordinate systems

This is the most important correctness requirement in Phase 0.

### 9.1 Original image coordinates

The authoritative location of a point is measured in the original raster image:

```text
xPx ∈ [0, imageWidth)
yPx ∈ [0, imageHeight)
```

These values are independent of canvas size, fit scale, device pixel ratio, pan, or zoom.

### 9.2 Normalized coordinates

Store derived normalized coordinates for portability and debugging:

```text
xNorm = xPx / imageWidth
yNorm = yPx / imageHeight
```

The pixel coordinates remain authoritative. Normalized values should either be computed on serialization or verified against pixel coordinates on load.

### 9.3 View coordinates

The canvas library will maintain a view transform:

```text
screenPoint = viewTransform(imagePoint)
imagePoint  = inverse(viewTransform)(screenPoint)
```

Every pointer event must be converted through the inverse view transform before updating project state.

Do not infer image coordinates from CSS bounding rectangles alone once pan and zoom are supported.

### 9.4 Device pixel ratio

The visual canvas may use a high-DPI backing store, but project coordinates must never depend on device pixel ratio. Add automated tests or development assertions around this boundary.

## 10. Suggested project schema

```json
{
  "schemaVersion": 1,
  "project": {
    "id": "project-uuid",
    "name": "Sample Round",
    "createdAt": "2026-08-02T00:00:00.000Z",
    "updatedAt": "2026-08-02T00:00:00.000Z"
  },
  "images": [
    {
      "id": "image-source",
      "role": "source-overview",
      "fileName": "udisc-overview.png",
      "mimeType": "image/png",
      "widthPx": 1179,
      "heightPx": 2556,
      "sha256": "...",
      "bundlePath": "images/source-original.png"
    },
    {
      "id": "image-target",
      "role": "target-basemap",
      "fileName": "clean-map.png",
      "mimeType": "image/png",
      "widthPx": 1600,
      "heightPx": 1200,
      "sha256": "...",
      "bundlePath": "images/target-original.png"
    }
  ],
  "controlPointPairs": [
    {
      "id": "cp-0001",
      "ordinal": 1,
      "label": "Parking lot northeast corner",
      "enabled": true,
      "source": {
        "imageId": "image-source",
        "xPx": 748.25,
        "yPx": 720.5,
        "xNorm": 0.634648,
        "yNorm": 0.281886
      },
      "target": {
        "imageId": "image-target",
        "xPx": 788.0,
        "yPx": 403.25,
        "xNorm": 0.4925,
        "yNorm": 0.336042
      },
      "createdAt": "2026-08-02T00:00:00.000Z",
      "updatedAt": "2026-08-02T00:00:00.000Z"
    }
  ],
  "viewState": {
    "source": {
      "zoom": 1.4,
      "panX": -92,
      "panY": 17
    },
    "target": {
      "zoom": 1.1,
      "panX": 0,
      "panY": -35
    }
  }
}
```

### Schema rules

- IDs are immutable.
- Pair ordinals are presentation values and may be regenerated after reorder.
- Coordinates may be floating-point because transforms and subpixel dragging will later matter.
- A pending pair may exist in in-memory editor state but should not be written into a normal saved project unless explicitly marked incomplete.
- Unknown future fields must be ignored rather than causing a load failure.
- A project with a newer unsupported major schema version must fail with a clear message rather than being partially loaded.

## 11. State model

Separate durable project state from transient editor state.

### Durable project state

- project metadata;
- image metadata;
- control-point pairs;
- optional persisted view state.

### Transient editor state

- active tool;
- selected pair and side;
- pending source point;
- pointer location;
- hover state;
- drag state;
- temporary magnifier;
- unsaved-history cursor;
- file handles or decoded image objects.

Do not serialize transient interaction objects from Konva or the component framework. Serialize only plain domain data.

## 12. Commands and undo/redo

Use command-oriented state changes so undo and redo are deterministic.

Minimum command set:

- add complete pair;
- move source point;
- move target point;
- edit pair label;
- enable or disable pair;
- delete pair;
- reorder pair;
- replace source image;
- replace target image.

Pan and zoom do not need to enter the main undo history. They are view operations, not project geometry edits.

A pending half-pair should be cancellable with Escape and should not pollute undo history until completed.

## 13. Validation and diagnostics

### Required validation

- supported raster type;
- successful image decode;
- non-zero width and height;
- point is within image bounds;
- no duplicate pair IDs;
- every complete pair references the correct source and target images;
- bundle image hashes match the project manifest;
- schema version is supported.

### Helpful diagnostics

Phase 0 may report, without calculating a transform:

- number of complete pairs;
- number of incomplete pairs;
- whether there are enough pairs for a future similarity transform;
- whether there are enough pairs for a future affine transform;
- approximate landmark coverage across each image;
- warning if all points occupy a small region;
- warning if two points within one image are nearly identical.

Suggested language:

```text
4 complete pairs
Ready for affine registration
Coverage warning: landmarks are concentrated in the upper-left quarter
```

Diagnostics should guide rather than block. A user may intentionally create clustered points while testing.

## 14. Precision aids

### 14.1 Marker design

- same ordinal on both images;
- visually distinct selected state;
- readable over bright and dark imagery;
- screen-constant marker size while zooming;
- small image-space anchor at the exact stored coordinate;
- larger hit target than the visible anchor.

### 14.2 Magnifier

A small magnified preview around the pointer or selected marker greatly improves point placement. It should show the exact anchor crosshair and use original image pixels rather than magnifying an already downscaled canvas when possible.

### 14.3 Keyboard nudge

When a marker is selected:

- arrow key: one original-image pixel;
- Shift + arrow: ten original-image pixels;
- optional Alt/Option + arrow: subpixel movement later, but not required in Phase 0.

Prevent these shortcuts from firing while a text field is focused.

## 15. Error handling

Phase 0 should fail visibly and recoverably.

Examples:

- unsupported image: retain the other loaded image and show a specific message;
- corrupt project bundle: identify whether JSON, manifest, or image asset failed;
- missing bundled image: open project in a repair state rather than silently substituting an empty canvas;
- hash mismatch: warn that the image differs and require explicit replacement;
- replacing an image with different dimensions: ask whether existing points on that image should be discarded;
- save failure: preserve current in-memory state and allow retry.

## 16. Testing plan

### 16.1 Unit tests

Coordinate utilities:

- screen-to-image conversion at identity transform;
- conversion after pan;
- conversion after zoom;
- conversion after combined pan and zoom;
- image-to-screen-to-image round trip within tolerance;
- normalized-coordinate conversion;
- bounds clamping or rejection;
- device-pixel-ratio independence.

Project schema:

- serialize and deserialize without coordinate changes;
- reject unsupported major version;
- ignore unknown compatible fields;
- validate missing image references;
- validate duplicate IDs;
- verify content hashes when loading a bundle.

History:

- add pair then undo and redo;
- drag point then undo and redo;
- delete pair then restore;
- pending pair cancellation does not alter durable history.

### 16.2 Component or integration tests

- upload both fixture images;
- add a pair by clicking each pane;
- marker labels match;
- dragging at 200% zoom updates native coordinates correctly;
- fit/reset does not move stored points;
- resize the browser and confirm marker anchors remain fixed to landmarks;
- save a project, reload it, and compare all coordinates;
- replace one image and verify the confirmation path.

### 16.3 End-to-end acceptance test

Using the supplied UDisc round screenshot and a clean map fixture:

1. load both images;
2. create five point pairs distributed across the course;
3. zoom and pan both panes;
4. drag two markers for correction;
5. label one pair;
6. delete and restore one pair through undo;
7. save the project bundle;
8. reload the application;
9. open the bundle;
10. verify every marker remains on the same landmark within one original-image pixel.

## 17. Milestones

## Phase 0A — Image workspace

**Deliverables:**

- two hard-coded fixture images;
- side-by-side canvas panes;
- fit, reset, pan, and zoom;
- original image dimension display;
- coordinate conversion unit tests.

**Exit condition:** A developer can click a landmark and log the correct original-image pixel at any viewport or zoom.

## Phase 0B — Point-pair editor

**Deliverables:**

- pair creation state machine;
- numbered markers;
- drag correction;
- point list;
- delete;
- selection;
- undo and redo.

**Exit condition:** A user can build and revise a set of correspondences without accidental half-pairs or coordinate drift.

## Phase 0C — User files and project persistence

**Deliverables:**

- source and target image upload;
- portable project bundle save;
- project bundle open;
- schema validation;
- image hashing;
- unsaved-change indicator.

**Exit condition:** The end-to-end save and reload test passes exactly.

## Phase 0D — Precision and quality pass

**Deliverables:**

- magnifier;
- keyboard nudging;
- pair labels;
- marker visibility toggle;
- point distribution diagnostics;
- polished error states;
- accessibility and keyboard review.

**Exit condition:** A non-developer can create five well-distributed point pairs quickly and confidently.

## 18. Definition of done

Phase 0 is done when all of the following are true:

- two user-selected images can be loaded without a server;
- both can be panned and zoomed independently;
- point pairs can be created only through an explicit, unambiguous two-step flow;
- markers remain anchored to original image coordinates through all view changes;
- points can be selected, dragged, nudged, labeled, reordered, disabled, and deleted;
- undo and redo cover geometry edits;
- project data and original images can be saved as one portable bundle;
- the bundle can be reopened with no coordinate changes;
- automated tests cover coordinate transforms, state history, schema handling, and persistence;
- no image registration or overlay extraction has leaked into the scope.

## 19. Handoff to Phase 1

Phase 1 should consume Phase 0 output through a narrow interface:

```ts
interface CorrespondenceSet {
  sourceImage: ImageAsset;
  targetImage: ImageAsset;
  pairs: Array<{
    id: string;
    enabled: boolean;
    source: { xPx: number; yPx: number };
    target: { xPx: number; yPx: number };
  }>;
}
```

The registration module must not read Konva nodes or browser event state. It receives plain image metadata and image-space correspondences, estimates a transform, and returns diagnostics. This boundary is the main architectural payoff of building Phase 0 carefully.
