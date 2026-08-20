# `ImageViewport` input-event contract

**Scope:** `src/lib/components/ImageViewport.svelte` and `src/lib/viewport.svelte.ts`
(`ViewportController`), plus every consumer: `ImageEditorPane.svelte`, `ImagePane.svelte`,
`routes/stitch-map/+page.svelte` (two viewports, two Konva stages), `routes/ribbon-editor/+page.svelte`,
`routes/annotate-round/+page.svelte` (through `ImageEditorPane`).

**Why this document exists.** One component has produced three shipped, user-visible bugs, and none
of them was a logic typo. Each was a *spec-level* interaction — a rule of the Pointer Events or UI
Events specification that the code did not account for:

| # | Fixed in | What actually went wrong |
|---|----------|--------------------------|
| 1 | `cc7924e` | `preventDefault()` on a **mouse-origin** `pointerdown` suppresses **all compatibility mouse events** (`mousedown`/`mousemove`/`mouseup`/`click`) for the rest of that pointer's gesture. Konva's drag engine listens for `mousemove`/`mouseup` on `window`. Result: the stitch-map crop handles could not be dragged at all. |
| 2 | `fb51c7a` | The wheel handler zoomed on every wheel event and returned early when `deltaY === 0`, leaving a horizontal-only two-finger trackpad swipe **unconsumed**. macOS/Chromium then interpreted it as a history back-swipe and navigated away, destroying the in-memory editing session. |
| 3 | `f38b13c` | Per the Pointer Events spec, once an element has **pointer capture**, the browser's synthesized `click` is **retargeted to the capturing element**. `ImageViewport` captures on its own container to drive panning, so a `<button>` rendered inside a consumer's `content` snippet received `pointerdown` but never `click`. |

The pattern is consistent: the bugs live in the **arbitration between input systems**, not inside any
one of them. `docs/architecture-teardown.md` §11 already names this ("the recent crop-handle drag bug
lived in the *arbitration between* input systems, not in having multiple renderers"). Three
occurrences justify writing the arbitration rules down once, in full, rather than a fourth spot fix.

This document is deliberately explicit about browser mechanics. It assumes no prior knowledge of the
Pointer Events spec.

---

## Part 0 — Six browser rules you need in order to read Part 1

These are the specification facts the contract is built on. Everything in Part 1 is a consequence of
one of them.

1. **Pointer events are the unified layer; mouse and touch events are still dispatched underneath.**
   A physical mouse press produces `pointerdown` *and* `mousedown`. A finger produces `pointerdown`
   *and* `touchstart`. Libraries that predate Pointer Events (or that support old browsers) often
   listen to the *older* families. Konva 10.3.0 does both — see rule 6.

2. **`preventDefault()` on `pointerdown` cancels the *compatibility mouse events*, not the pointer
   events.** For a `pointerType === 'mouse'` pointer, the compatibility events *are* the mouse events
   — so preventing the default kills `mousemove`, `mouseup`, and `click` for that whole gesture. For
   `pointerType === 'touch'`, `touchstart`/`touchmove`/`touchend` still fire (they are the *source*
   of the pointer events, not compatibility output); what gets suppressed is the delayed synthetic
   mouse sequence after `touchend`, plus scroll/selection default actions. **This asymmetry is the
   entire reason `ImageViewport` calls `preventDefault()` conditionally on `pointerType`.**

3. **`setPointerCapture(id)` redirects every subsequent event for that pointer to the capturing
   element**, regardless of what is physically under the pointer — and, critically, it also
   **retargets the synthesized `click`** at the end of the gesture to the capturing element. Capture
   also **suppresses boundary events** (`pointerover`/`pointerout`/`pointerenter`/`pointerleave`)
   until the capture is released.

4. **Capture is released implicitly** on `pointerup`/`pointercancel`, and when the capturing element
   is removed from the document (which fires `lostpointercapture`). `releasePointerCapture` for a
   pointer that is not captured **throws** — hence the `try/catch` wrappers in the component.

5. **`wheel` listeners on `window`, `document`, and `body` are passive by default in Chromium**, so
   `preventDefault()` silently does nothing there. On any other element the default is non-passive.
   `ImageViewport` binds `wheel` on its own container **with an explicit `{ passive: false }`**, which
   is what makes bug #2's fix work. `pointermove` is *not* force-passive anywhere, so the
   `preventDefault()` in `onAnyPointerMove` is real (though it does very little — `touch-action: none`
   on the container is what actually blocks scrolling).

6. **Konva 10.3.0's own bindings** (verified in `node_modules/konva/lib/Stage.js` and
   `DragAndDrop.js`): the Stage binds `mousedown`, `mousemove`, `mouseup`, `touchstart`, `touchmove`,
   `touchend`, `touchcancel`, `pointerdown`, `pointermove`, `pointerup`, `pointercancel`,
   `lostpointercapture`, `wheel`, and `contextmenu` **on the container element** — which, for
   `ImagePane` and both stitch-map viewports, is *the very same div `ImageViewport` binds to*.
   Konva's drag engine (`DragAndDrop.js`) binds **only** `mousemove`, `touchmove`, `mouseup`,
   `touchend`, `touchcancel` on `window`. **There is no `pointercancel` in Konva's drag engine at
   all.** Rules 2 and 6 together are bug #1 in one sentence.

---

## Part 1 — The actual contract, as implemented today

### 1.1 Who owns which element

```
<div class="image-viewport">            ← controller.container, bound via bind:this
    touch-action: none                   (blocks browser scroll/pinch on this element)
    overscroll-behavior: none
    cursor: grab / grabbing
    │
    ├── ImageViewport binds:  wheel {passive:false}, pointerdown        (element-level)
    ├── Konva Stage binds:    the 14 events in Part 0 rule 6           (element-level, ImagePane + stitch-map only)
    ├── ImagePane binds:      pointermove, pointerleave (magnifier)    (element-level)
    └── {@render content()}   ← consumer scene: <img>+SVG, Konva canvases, or empty
```

Everything else `ImageViewport` uses is **`window`-level and added only for the duration of a
gesture**. Nothing is registered at `document` level. No listener is registered with `capture: true`.
No handler anywhere in the component or in any consumer calls `stopPropagation()`.

### 1.2 The `pointerdown` decision flowchart

This is the authoritative reading of `onPointerDown` (`ImageViewport.svelte:170`). Each step runs in
order; `return` means the component does nothing further for that event.

```
pointerdown fires on .image-viewport (bubble phase, non-passive)
│
├─[A] event.button !== 0 ?                              → RETURN.
│     (right/middle/aux button, pen barrel button)         Pointer is NOT tracked.
│                                                          No capture, no preventDefault.
│                                                          Native context menu etc. proceeds.
│
├─[B] isInteractiveControl(event.target) ?              → RETURN.
│     target.closest('button, a[href], input,              Pointer is NOT tracked.
│                     select, textarea, label')            No capture, no preventDefault,
│                                                          claimPointer is NEVER consulted.
│                                                          → This is the f38b13c guard: the
│                                                            control keeps its native click.
│
├─ pointer = controller.pointerIn(event)   (container-local CSS px)
├─ activePointers.set(pointerId, pointer)  ← the ONLY place pointers enter tracking
│
├─[C] activePointers.size >= 2 ?  → PINCH / RE-ANCHOR
│     ├─ setPointerCapture(pointerId) on the container      [best-effort, try/catch]
│     ├─ event.preventDefault()                             [UNCONDITIONAL — incl. mouse. See H2]
│     ├─ if (gesture)        endGesture()                   pan abandoned, controller.panning = false
│     ├─ if (claimedGesture) onClaimedPointerCancel?.(...)  ← the ONLY cancel signal a claimant gets
│     │                      endClaimedGesture()               for this transition
│     ├─ startPinch()  → anchors on the FIRST TWO entries of activePointers (Map insertion order)
│     ├─ window += pointermove/pointerup/pointercancel → onAnyPointerMove / onAnyPointerUp
│     └─ RETURN
│
├─[D] gesture || claimedGesture already active ?         → RETURN. (Pointer stays tracked.)
│
├─[E] claimPointer?.(pointer, event) === true ?          → CLAIMED GESTURE
│     ├─ if (event.pointerType !== 'mouse') event.preventDefault()   ← cc7924e asymmetry
│     ├─ NO setPointerCapture — deliberately. A claimant may be driving its own
│     │  drag off compatibility mouse events on a descendant element (Konva crop handles),
│     │  and capture would retarget those away from it.
│     ├─ claimedGesture = { pointerId }
│     ├─ window += pointermove/pointerup/pointercancel
│     │           → handleClaimedPointerMove / Up / Cancel  → onClaimedPointer* props
│     └─ RETURN
│
└─[F] otherwise → VIEWPORT PAN GESTURE
      ├─ setPointerCapture(pointerId) on the container      [best-effort, try/catch]
      ├─ event.preventDefault()                             [UNCONDITIONAL — incl. mouse]
      ├─ gesture = { pointerId, start, transform: {...controller.view}, panning: false }
      │            ↑ the transform is SNAPSHOTTED at pointerdown; every pan move is computed
      │              against that snapshot, never incrementally, so a click never drifts.
      └─ window += pointermove/pointerup/pointercancel → onPointerMove / onPointerUp / onPointerCancel
```

Note the ordering consequence of **[B] before [C]**: a finger that lands on a `<button>` inside
`content` is never added to `activePointers`, so it cannot participate in — or trigger — a pinch.

And of **[C] before [D]/[E]**: a second pointer **always** wins over a pan or a claim. Pinch is the
highest-priority gesture in the component.

### 1.3 Contract table by input class

| Input class | First receiver | `setPointerCapture` | `preventDefault` on down | `claimPointer` consulted | Viewport pans | Window listeners while active | Passive? |
|---|---|---|---|---|---|---|---|
| **Mouse, primary button, on non-interactive content, unclaimed** | container `pointerdown` | **Yes**, on container | **Yes** | Yes (returned false) | Yes, past `clickSlopPx('mouse')` = 4 px slop | `pointermove`/`pointerup`/`pointercancel` → `onPointerMove`/`onPointerUp`/`onPointerCancel` | No |
| **Mouse, primary, claimed** | container `pointerdown` | **No** (by design, `cc7924e`) | **No** (by design, `cc7924e`) | Yes (returned true) | No | `pointermove`/`pointerup`/`pointercancel` → `onClaimedPointer*` props | No |
| **Mouse, non-primary button** | container `pointerdown` | No | No | **No** | No | none | — |
| **Mouse/touch on `button, a[href], input, select, textarea, label` inside `content`** | container `pointerdown` | **No** | **No** | **No** | No | none | — |
| **Single touch, unclaimed** | container `pointerdown` | **Yes** | **Yes** | Yes (returned false) | Yes, past `clickSlopPx('touch')` = 10 px slop (see H9 — closed) | same as mouse-unclaimed | No |
| **Single touch, claimed** | container `pointerdown` | **No** | **Yes** (`pointerType !== 'mouse'`) | Yes (returned true) | No | same as mouse-claimed | No |
| **Second+ pointer (pinch)** | container `pointerdown` | **Yes**, on the arriving pointer only | **Yes, unconditionally** | **No** — and any active claim is cancelled | Yes: zoom about the two-finger midpoint **and** pan by midpoint delta | `pointermove`/`pointerup`/`pointercancel` → `onAnyPointerMove`/`onAnyPointerUp` | No |
| **Wheel / trackpad two-finger scroll** | container `wheel` | n/a | **Yes**, whenever a fit target exists and the normalized delta is nonzero | n/a | Pans (`-dx, -dy`) | none | **Explicitly `{ passive: false }`** |
| **ctrl+wheel / meta+wheel (trackpad pinch, Cmd+scroll)** | container `wheel` | n/a | Same as above | n/a | Zooms at the pointer, gained by `PINCH_GAIN` | none | `{ passive: false }` |
| **Wheel with no `controller.fitTarget`** | container `wheel` | n/a | **No — event escapes entirely** | n/a | No | none | — (see **H5**) |
| **Keyboard, viewport focused, no modifier** | container `keydown` | n/a | **Yes**, for Arrow/`+`/`=`/`-`/`_`/`0`; no-op for anything else | n/a | Arrow keys pan; `0` fits | none | n/a |
| **Keyboard, viewport focused, `Cmd`/`Ctrl` held** | container `keydown` | n/a | **Yes**, same as above — this is what blocks the browser's native page-zoom while focused | n/a | `+`/`-`/`0` zoom/fit same as unmodified | none | n/a |
| **Keyboard, event target is a focusable descendant (not the container itself)** | container `keydown` (bubbled) | n/a | **No — handler bails via `event.target !== event.currentTarget`** | n/a | No | none | n/a |
| **Keyboard, viewport not focused** | **nothing reaches this component** | — | — | — | — | — | — |
| **Click/tap on an on-canvas zoom/fit button** | container `pointerdown`, same as any `content` control | **No** | **No** | **No** | No | none | — (same row as the `button, a[href], input, select, textarea, label` case above — these are that case) |

### 1.4 The `claimPointer` protocol — what it promises and what it does not

`claimPointer(pointer: ScreenSpacePoint, event: PointerEvent): boolean`, called at step **[E]**.

**It promises:**
- Called exactly once per gesture, synchronously inside the `pointerdown` handler, on the primary
  button only.
- `pointer` is in **container-local CSS pixels**, matching the Konva stage coordinate space and the
  space `ViewportController.toImage`/`toScreen` operate in.
- Returning `true` guarantees the viewport will **not pan** and will **not fire `onViewportClick`**
  for that gesture.
- If `onClaimedPointerMove`/`Up`/`Cancel` are supplied, they receive viewport-local coordinates for
  the *same pointer id*, from `window`-level listeners, so the gesture survives the pointer leaving
  the container.

**It explicitly does NOT promise:**
- **No pointer capture is taken.** This is load-bearing, not an oversight — see `cc7924e`. Claimants
  that need capture must take it themselves, on their own element.
- **`preventDefault()` is pointer-type-asymmetric.** Mouse-origin claimed pointerdowns are *not*
  prevented (so compatibility mouse events survive for Konva-style claimants); touch/pen claimed
  pointerdowns *are* prevented. A claimant that relies on default suppression for mouse (text
  selection, native image drag) does not get it.
- **No exclusivity against a second pointer.** Any second pointer landing on the container abandons
  the claim (step **[C]**). The claimant is told via `onClaimedPointerCancel` — **if and only if it
  passed one**. This is the single most consequential unpromised guarantee (see **H1**).
- **No exclusivity against the wheel.** `onWheel` never checks whether a gesture is in flight, so the
  view transform can change *underneath* a claimed drag (see **H4**).
- **No ordering guarantee versus Konva.** Konva's Stage has its own `pointerdown` on the same
  element; neither system stops propagation, so both always run, in DOM registration order.
- **Nothing about `activePointers`.** A claimed pointer stays in the map and counts toward the pinch
  threshold.

### 1.5 Teardown paths

| Event | Pan gesture | Claimed gesture | Pinch | `activePointers` | Capture |
|---|---|---|---|---|---|
| `pointerup`, matching id | `onPointerUp` → maybe `onViewportClick`, `endGesture()` | `handleClaimedPointerUp` → `onClaimedPointerUp`, `endClaimedGesture()` | `onAnyPointerUp` → drops to <2 ⇒ pinch cleared; still ≥2 ⇒ `startPinch()` re-anchor | **deleted** | released |
| `pointerup`, **mismatched id** | `endGesture()` only | `endClaimedGesture()` only | n/a | **NOT deleted → leak (H3)** | not released |
| `pointermove`, **mismatched id** | `endGesture()` only | `endClaimedGesture()` only | ignored if untracked | **NOT deleted → leak (H3)** | not released |
| `pointercancel` | `onPointerCancel` → `endGesture()` | `handleClaimedPointerCancel` → `onClaimedPointerCancel` | `onAnyPointerUp` (same handler) | deleted | released |
| Second pointer arrives | `endGesture()` | `onClaimedPointerCancel` + `endClaimedGesture()` | (re)anchored | kept (both still down) | new pointer captured |
| **Component destroy** | `endGesture()` | `endClaimedGesture()` | `pinch = null`, `onAnyPointer*` removed | `.clear()` | **not explicitly released** — relies on the implicit release when the element leaves the document |
| `$effect` re-run / cleanup | — | — | — | — | container `wheel` + `pointerdown` removed |
| **Lost capture** (`lostpointercapture`) | **not observed at all** | n/a | not observed | unchanged | — |

`onDestroy` is correct for the component's *own* listeners. It cannot remove the listeners a
*consumer* registered from inside `claimPointer` — `ImagePane` and `stitch-map` each register their
own `window` listeners there and each correctly removes them in their own `onDestroy`
(`ImagePane.svelte:520`, `stitch-map/+page.svelte:1305`). That is convention, not enforcement.

### 1.6 Per-consumer summary

| Consumer | Viewport(s) | Scene | Claims on | Own `window` listeners? | `onClaimedPointerCancel` wired? |
|---|---|---|---|---|---|
| `ImageEditorPane` (annotate-round) | 1 | `<img>` + SVG overlay (`pointer-events: none`) + empty-state `<button>` | delegated to route | No — uses viewport plumbing | **Yes** (`cancelAnnotationPointer`) |
| `ImagePane` (create-graphics) | 1 per role, **2 on the page** | Konva stage in the container | any marker hit; **everything** when no image | **Yes** (`onMarkerMove`/`Up`/`Cancel`) | **No — gap (H1)** |
| `stitch-map` crop | 1 | Konva stage in the container | Konva crop-handle nodes only | No — Konva's own DD engine | **No — gap (H1, H10)** |
| `stitch-map` alignment | 1 | Konva stage in the container | pointer inside the selected movable tile | **Yes** (`handleTileDrag*`) | **No — gap (H1)** |
| `ribbon-editor` | 1 | `<img>` + SVG overlay | vertex within `POINT_HIT_RADIUS_PX` | No — uses viewport plumbing | **Yes** (`handlePointCancel`) |

Note that stitch-map and create-graphics each mount **two `ImageViewport` instances on one page**,
each with its own independent set of `window` listeners. This matters for **H3**.

**Addendum — `ImageEditorPane`'s `popover` snippet (annotate-round's radial menu).** A second
content slot, `popover`, renders as a *sibling* of `<ImageViewport>` inside `.canvas-shell`, not
inside `.image-viewport` the way `content`/`overlay` do (`src/lib/components/ImageEditorPane.svelte`).
Two consequences, both deliberate:

- Its elements are never DOM descendants of `.image-viewport`, so a `pointerdown` on them never
  reaches step **[B]** (the `isInteractiveControl` guard) at all — not because the guard's selector
  matches real `<button>`s (it does), but because bubbling never gets that far. The guard stays
  correct as a backstop for anything a future `content`/`overlay` consumer adds, but this popover
  doesn't depend on it.
- It is therefore also immune to `.image-viewport`'s `overflow: hidden`: `.canvas-shell` itself sets
  no `overflow`, so a popover positioned in the same CSS-pixel coordinate space as `ScreenSpacePoint`
  (`.image-viewport` fills `.canvas-shell` with no offset) can extend past the pane's edges — never
  desired, which is why `RadialMenu.svelte` clamps itself to the pane's own size instead of relying on
  clipping to hide overflow.

The popover also relies on `.image-viewport` being programmatically focusable so it can call
`.focus({ preventScroll: true })` on close (e.g. Escape). The container's `tabindex="0"` (from the
keyboard contract in Part 1.7 below) satisfies this; no separate `tabindex="-1"` is needed.

### 1.7 Keyboard pan/zoom/fit, and on-canvas zoom controls

**Formerly a deliberate absence (see git history for the original text of this section); closed in
this commit.** The container is now unconditionally `tabindex="0"` and carries an `onkeydown` handler
(`ImageViewport.svelte`'s `onKeyDown`), so every consumer gets a keyboard path to pan, zoom, and fit
with zero changes on its part — the whole point of putting this in the shared component rather than
in five separate consumers. A small on-canvas button cluster (zoom-in/zoom-out/fit) is rendered inside
the same container, also with no consumer-side changes required.

**Keys, while the viewport itself has focus** (see the target/currentTarget scoping below):

| Key | Action | Notes |
|---|---|---|
| `ArrowLeft` / `ArrowRight` / `ArrowUp` / `ArrowDown` | Pan by `KEYBOARD_PAN_STEP_PX` (40px) | Same sign convention as the wheel pan (`onWheel`'s `panBy(-dx, -dy)`): Down/Right behave like scrolling down/right — content shifts up/left, revealing what's below/to the right. |
| `Shift+Arrow*` | Pan by `KEYBOARD_PAN_STEP_PX * KEYBOARD_PAN_STEP_SHIFT_MULTIPLIER` (200px) | Larger step, same direction. |
| `+` / `=` | Zoom in about the **viewport center** by `KEYBOARD_ZOOM_STEP_FACTOR` (1.25×) | Center, not pointer — keyboard input has no pointer position to anchor on. Clamped by `zoomLimits()` (`zoomLimitsForFit`), identical to wheel/pinch zoom. |
| `-` / `_` | Zoom out about the viewport center by `1 / KEYBOARD_ZOOM_STEP_FACTOR` (0.8×) | Reciprocal of zoom-in, so a `+` then a `-` returns to the exact original zoom. |
| `0` | `controller.fit()` | No-op without a `fitTarget`. |
| `Cmd/Ctrl` held with any of the above | Same action, **and** `preventDefault()` still fires | See the focus-scoping rule below — this is what stops the browser's own page-zoom. |

All constants (`KEYBOARD_PAN_STEP_PX`, `KEYBOARD_PAN_STEP_SHIFT_MULTIPLIER`, `KEYBOARD_ZOOM_STEP_FACTOR`)
live in `src/lib/navigation.ts` alongside the wheel/pinch constants they parallel.

**Focus and `preventDefault()` scoping (Figma/Google Maps convention).** `onKeyDown` calls
`event.preventDefault()` for every key it recognizes — unconditionally, including when `Cmd`/`Ctrl` is
held and including when `controller.fitTarget` is `null` (only the actual pan/zoom/fit *action* is
skipped without a target; the prevention still happens). This is what stops `Cmd/Ctrl+Plus`,
`Cmd/Ctrl+Minus`, and `Cmd/Ctrl+0` from triggering the browser's native page-zoom while a viewport is
focused. The scoping mechanism is exactly focus: `onKeyDown` is bound directly on this container
(`onkeydown` in the template, not a delegated/global listener), so it only ever runs for a keydown
whose target is this element or a descendant — and when the target is a *focusable descendant*
(the one case in this codebase: the empty-state "Choose image" `<button>` some consumers render inside
`content`), the handler bails via `event.target !== event.currentTarget` and does nothing, native
button behavior included. **Consequence: browser zoom behaves normally everywhere else on the
page — every other viewport that doesn't have focus, and the page outside any viewport.** This
mirrors — deliberately, down to the exact guard expression — stitch-map's pre-existing
`handleAlignmentKeyDown`, which already uses `event.target !== event.currentTarget` to scope its
Arrow-key tile-nudge to its own `role="group"` wrapper. Because the two nest (the alignment viewport's
`ImageViewport` is a DOM descendant of that wrapper) and both use the identical guard, they compose
without any change to stitch-map: focus the outer wrapper and Arrow keys nudge the selected tile; Tab
once more into the inner viewport and Arrow keys pan the view instead — never both from one keypress.

**Role: `application` by default, not `img`.** A `role="img"` element is documented to assistive
technology as static, non-interactive content — the opposite of what this component now is, and with
no guarantee a screen reader's browse mode even forwards Arrow keys to the page instead of consuming
them for its own virtual-cursor navigation. `role="application"` is the standard technique for exactly
this case (Google Maps' and Figma's canvases both use it): it tells the browser/AT to stop intercepting
keys for browse-mode navigation and deliver them to the page, which is a precondition for the Arrow-key
pan above to reach a screen reader user at all. This was chosen over the alternative the task allowed
(`aria-roledescription` alone, keeping `role="img"`) because `aria-roledescription` only changes the
*announced name* of a role, not the AT's navigation-mode behavior — it would leave real screen-reader
users unable to reach the keyboard handler, defeating the point.

The component computes `role ?? 'application'` — an explicit `role` prop still wins. **Three existing
callers pass `role="img"` explicitly and are out of this change's reach** (owned by other in-flight
work at the time of this commit): `ImagePane.svelte`, `ImageEditorPane.svelte`, and
`routes/ribbon-editor/+page.svelte`. Their viewports keep `role="img"` — and, not incidentally, that is
exactly what two of them are pinned to by `tests/e2e/accessibility.spec.ts` (`toHaveAttribute('role',
'img')` at two call sites), which is the other reason the component honors an explicit override rather
than forcing its own default. Sighted keyboard users get full pan/zoom regardless of which role is
active, since `tabindex`/`onkeydown` function identically under any role value — only the screen-reader
navigation-mode behavior differs. `stitch-map/+page.svelte`'s two viewports pass no `role` at all today
and so pick up the new `application` default automatically. As a second, role-independent layer that
helps even the three `img`-pinned consumers, the component also sets `aria-roledescription="zoomable
image viewport"` unconditionally, regardless of which `role` is in effect — this only changes the
announced role name, so it composes safely with any of the above. Migrating the three fixed-role
consumers to drop their `role` override (or set it to `application` themselves) is a follow-up for
whichever agent next owns those files; nothing in this component blocks it.

**`aria-label` always names the keys, regardless of what a consumer passes.** The rendered
`aria-label` is `${ariaLabel} ${KEYBOARD_HINT}` when a consumer supplies one, or
`Image viewport. ${KEYBOARD_HINT}` when it doesn't — `KEYBOARD_HINT` is a fixed string ("Arrow keys
pan, hold Shift to pan further. Plus or minus zoom. 0 fits the image.") appended unconditionally inside
`ImageViewport` itself. Like the `aria-roledescription` above, this is a second mechanism chosen
specifically so the keyboard contract is announced even for the three consumers whose own `ariaLabel`
text (written before this change) doesn't mention it and that this change cannot edit.

**On-canvas zoom controls.** A `<div class="viewport-controls">` renders inside the same container,
after `{@render content()}`, containing three real `<button type="button">` elements —
`data-testid="viewport-zoom-in"`, `"viewport-zoom-out"`, `"viewport-zoom-fit"` — positioned
`position: absolute; right: 8px; bottom: 8px` with `min-width`/`min-height: 2.25rem` (WCAG 2.5.5-sized
targets), dark-panel styling matching the rest of the app (`background: #27272a`, `border: 1px solid
#52525b`, matching e.g. `ImageEditorPane`'s own `button { }` rule), and `#38bdf8` focus rings via
`:focus-visible` matching every other focus ring in the app. `zoom-in`/`zoom-out` call the exact same
`zoomAboutCenter` helper `+`/`-` use (same `KEYBOARD_ZOOM_STEP_FACTOR`, same center anchor, same
`zoomLimits()` clamp); `fit` calls `controller.fit()` directly. **The whole cluster is wrapped in
`{#if controller.fitTarget}`** so it disappears exactly when there is no image to operate on — no
`showControls` prop was needed; hiding falls out of state that already exists.

Because these are real `<button>` elements, `isInteractiveControl`'s existing selector
(`target.closest('button, a[href], input, select, textarea, label')`, the f38b13c guard — see §1.2
step **[B]**) already exempts them from pointer-gesture handling with zero changes: a pointerdown that
starts on one of these buttons is never added to `activePointers`, never captured, never
`preventDefault`ed, and native `click` reaches the button's own `onclick` exactly as it does for the
pre-existing empty-state "Choose image" button inside `content`. This was verified by reading the guard
rather than assumed — the selector matches on the `button` tag alone, independent of where in the DOM
subtree the button sits, so it applies equally to a button rendered by `content` and one rendered by
`ImageViewport` itself, as here. One acknowledged, pre-existing latent interaction (same category as
H7): for `ImagePane` and stitch-map, Konva's `Stage` is bound to this *same* container element and does
its own coordinate-based hit-testing independent of the DOM click target, so a click that lands on the
button is still, in principle, visible to Konva's own `pointerdown` handler. In practice this is
inert — the button cluster occupies a small, fixed screen-corner region that the app's Konva scenes
don't place interactive shapes over — but it is the same undocumented-and-unenforced order-independence
H7 already names, now with one more instance of it, not a new hazard class.
---

## Part 2 — Hazard analysis

Same class as the three shipped bugs: arbitration between input systems, not logic errors.
Severity is about user-visible consequence, weighted for how much durable data is at risk.

---

### H1 — A pinch silently cancels a claimed gesture, and two of four claimants never hear about it. **HIGH**

**CLOSED (this commit).** `ImagePane.svelte` and `stitch-map/+page.svelte`'s alignment viewport now pass `onClaimedPointerCancel`.

**Mechanism.** Step **[C]** calls `onClaimedPointerCancel?.(...)` and then `endClaimedGesture()`.
`ImagePane` and `stitch-map` (both viewports) pass **no** `onClaimedPointerCancel` prop. Worse, both
`ImagePane` and stitch-map's alignment viewport register their **own** `window` `pointermove`/`up`
listeners inside `claimPointer`. So when the pinch takes over:

- the viewport forgets the claim,
- the consumer's drag state (`gesture` / `tileDrag`) is still live,
- the consumer's own window listeners are still attached,
- and the pinch is now rewriting `controller.view` on every move,
- while the consumer's move handler maps screen→image through a **transform snapshotted at
  pointerdown** (`gesture.transform`, `tileDrag.startScreen` + live `alignmentVp.view.zoom`).

**Trigger.** Touch device. Start dragging a correspondence marker (create-graphics) or a stitch tile
(stitch-map alignment) with one finger; put a second finger down; lift both.

**Outcome.** On lift, the consumer's `pointerup` handler still matches the pointer id and **commits**:
`onPointMove(...)` moves the control point, or `updatePlacement(...)` moves the tile — to coordinates
computed from a transform that changed mid-gesture. This is silent **durable domain corruption**, not
a display glitch: control points and tile placements are saved state.

**Consumers hit.** `ImagePane` (create-graphics correspondence), `stitch-map` alignment. Not
ribbon-editor or annotate-round — they wire the callback.

**Test coverage.** **None.** `imageViewportPinchZoom.test.ts` mounts a bare viewport with no claimant.
`paneNavigation.test.ts` never uses two pointer ids. No e2e test performs multi-touch.

---

### H2 — The pinch branch `preventDefault()`s a mouse `pointerdown` unconditionally — this is bug #1, uncorrected. **HIGH**

**CLOSED (this commit).** The pinch branch now guards `preventDefault()` with `event.pointerType !== 'mouse'`, mirroring `cc7924e`.

**Mechanism.** `cc7924e` made `preventDefault()` conditional on `pointerType !== 'mouse'` in the
**claimed** path (step **[E]**) for exactly the reason in Part 0 rule 2. Step **[C]** — the pinch
branch — calls the same `event.preventDefault()` with **no pointer-type check**, and step **[C]** runs
*before* the claim is even offered. Any mouse `pointerdown` that arrives while `activePointers.size`
is already ≥ 1 therefore kills every compatibility mouse event for that gesture, which is precisely
the failure `cc7924e` fixed.

**Trigger (no other bug required).** A hybrid laptop or tablet with both a touchscreen and a mouse or
trackpad: a finger resting on the screen makes `activePointers.size === 1`; the next mouse press on
the viewport enters the pinch branch. Also reachable, permanently, via **H3**.

**Outcome.** Konva crop-handle drag dies (bug #1 verbatim), plus an unwanted "pinch" driven by a mouse
and a stationary finger.

**Consumers hit.** stitch-map crop (Konva DD), any future Konva-native claimant.

**Test coverage.** None. The pinch tests never vary `pointerType`, and jsdom `PointerEvent` defaults
`pointerType` to `''`, so even an added assertion would need to set it explicitly.

---

### H3 — Pointer-id mismatch bail-outs leak entries into `activePointers`, producing a permanent phantom-pinch state. **HIGH**

**CLOSED (this commit).** All four mismatch bail-outs (`onPointerMove`, `onPointerUp`, `handleClaimedPointerMove`, `handleClaimedPointerUp`) now delete the owned pointer from `activePointers` before tearing down.

**Mechanism.** Three handlers tear down on an id mismatch **without removing the owned pointer from
`activePointers`**:

- `onPointerMove` (`:278`) and `onPointerUp` (`:296`) → `endGesture()` and return.
- `handleClaimedPointerMove` (`:314`) and `handleClaimedPointerUp` (`:325`) → `endClaimedGesture()`.

After the bail-out the window listeners are gone, so the owning pointer's eventual `pointerup` reaches
nothing and its `activePointers` entry **never expires**. `activePointers` is a plain `Map` cleared
only on component destroy.

**Trigger — and it does not require exotic hardware.** Both `create-graphics` and `stitch-map` mount
**two** `ImageViewport` instances on one page, each with its own `window` listeners. Touch pane A with
one finger (viewport A starts a pan and attaches window listeners) and pane B with another (viewport
B's `onPointerDown` runs in its own instance). Viewport A's `window` `pointermove` now receives pane
B's pointer, sees a mismatched id, and tears down — leaving pane A's finger stranded in
`activePointers` forever. Equally reachable with one viewport: press inside the viewport, then press
any control elsewhere on the page with a second finger.

**Outcome — a stuck state that only a reload clears.** Every subsequent *single* touch on that pane
sees `activePointers.size === 2` and enters the pinch branch with one real point and one frozen
phantom. `startPinch` anchors on the phantom; `onAnyPointerMove` reads the phantom's never-updated
coordinates, so the distance ratio swings wildly (uncontrolled zoom) and panning runs at half speed
(midpoint of one moving and one static point). On lift, size drops to 1 → the `< 2` branch clears
`pinch` and the listeners, but **the phantom entry survives**, so the next touch does it again. It
also permanently satisfies the trigger for **H2**.

**Consumers hit.** All of them; worst on the two dual-viewport pages.

**Test coverage.** None — every existing test dispatches `pointerId` 0 (`paneNavigation.test.ts`
helpers omit it entirely), so no mismatch path is ever exercised.

---

### H4 — The wheel handler is never gated on an in-flight gesture, so the transform moves under a drag. **MEDIUM-HIGH**

**Mechanism.** `onWheel` checks only `controller.fitTarget` and the delta. It does not consult
`gesture`, `claimedGesture`, or `pinch`. Meanwhile every drag in the codebase maps screen→image
through a **transform snapshotted at pointerdown**.

**Trigger.** Trackpad. Begin a drag with a two-finger click-and-hold (or a mouse button held), then
scroll or ctrl+scroll. Chromium happily delivers `wheel` during a button-held drag.

**Outcome, per consumer:**
- **stitch-map crop (worst).** The Konva handle node's position is in *screen* space.
  `valueFromDrag()` recomputes the inset with the **current** `cropVp.view.panX/zoom` against a node
  placed under the **old** transform, so the committed crop inset is wrong. Compounding it, the crop
  scene rebuild is suppressed for the whole drag (`if (!cropDragActive) renderCropScene()`), so the
  underlying image and the crop rect stay at the old transform while the view has moved.
- **stitch-map alignment.** `handleTileDragEnd` divides the screen delta by the *current* zoom while
  `startScreen` was captured at the *old* zoom → wrong committed placement.
- **`ImagePane`, ribbon-editor, annotate-round.** The drag point detaches from the cursor (mapping
  through the stale `gesture.transform`), and the committed coordinate is wherever that stale mapping
  lands.
- **Viewport's own pan.** A zoom during a drag-pan is *silently discarded* — the next `pointermove`
  overwrites `controller.view` from the snapshot.

**Test coverage.** None. Wheel tests and drag tests are entirely separate and never interleave.

---

### H5 — With no fit target, the wheel handler returns before `preventDefault()`, re-opening the back-swipe data-loss path. **MEDIUM-HIGH**

**Mechanism.** `onWheel` line 142: `if (!controller.fitTarget) return;` — **before** the
`event.preventDefault()` that `fb51c7a` introduced as the load-bearing fix. An empty viewport
therefore lets a horizontal two-finger swipe through, exactly as before `fb51c7a`.

**Trigger.** stitch-map with the upper-left tile not yet loaded (`cropVp.fitTarget === null`) but one
to three other screenshots already imported, or with a not-yet-connected arrangement
(`alignmentVp.fitTarget === null`). Two-finger swipe left/right over the empty preview. Also
create-graphics before the first image is chosen.

**Outcome.** macOS history back-swipe → route change → **the in-memory stitch session is destroyed**,
including already-imported tiles and any hand-refined crop. This is the same data loss `fb51c7a`
fixed, in the state where the session is *partially* built.

**Note — this behavior is currently asserted as correct.** `tests/unit/paneNavigation.test.ts:467`
reads `// No image: wheel is not handled and must not be prevented.` and asserts the event is *not*
prevented. Any fix must change that assertion, so this is a deliberate decision to revisit, not an
oversight to patch quietly.

---

### H6 — `isInteractiveControl` is a tag whitelist, not a "does this element want the click" test. **MEDIUM (latent)**

**Mechanism.** `target.closest('button, a[href], input, select, textarea, label')`. Everything the
selector misses still loses its synthesized `click` to capture retargeting (Part 0 rule 3) exactly as
in bug #3. Not covered: `[role="button"]` / `[role="link"]` divs, `[contenteditable]`, `<summary>`,
`<area>`, `<audio|video controls>`, any element with `tabindex` and a click handler, `<a>` without
`href`, and anything inside a shadow root (`closest` does not cross shadow boundaries).

**Trigger.** A consumer adds any non-native clickable inside its `content` snippet — a styled
`role="button"` overlay chip, an SVG element with an `onclick`, a dismiss "×" rendered as a `<span>`.

**Outcome.** Bug #3 recurs verbatim: `pointerdown` lands on the element, `click` fires on
`div.image-viewport`, the handler never runs, and nothing in the UI hints why.

**Two sub-hazards in the same guard:**
- **H6a.** The bail is *before* `activePointers.set` and *before* `claimPointer`. A finger starting on
  a control cannot participate in a pinch, and a consumer can never claim a gesture that begins on a
  control — the claim isn't even offered.
- **H6b.** `label` is in the list (correctly — clicking a label synthesizes a click on its control),
  but it matches **any ancestor** label. A label wrapping a large region of viewport content would
  silently disable panning across its entire box. No consumer does this today; stitch-map's
  `label.crop-field` and `label.position-field` are outside the viewports.

**Test coverage.** `tests/e2e/annotateRound.spec.ts:83` pins the `<button>` case only.

---

### H7 — Konva's Stage binds `pointerdown` on the *same element* as `ImageViewport`. **MEDIUM (contract fragility)**

**Mechanism.** For `ImagePane` and both stitch-map viewports, `new Konva.Stage({ container })` is
passed `vp.container` — the `div.image-viewport` itself. Konva then binds its own `pointerdown`,
`mousedown`, and `touchstart` (all → `_pointerdown`) on that element, alongside `ImageViewport`'s.
Both handlers run for every press, in registration order, and **neither system calls
`stopPropagation()`**.

**Why it is currently safe.** `claimCropPointer` does its own `stage.getIntersection(pointer)` with
viewport-local coordinates rather than relying on anything Konva computed from the same event, so
`ImageViewport` and Konva are order-independent today.

**Why it is a hazard.** The safety is undocumented and unenforced. A single `stopPropagation()` added
by either side — a plausible instinct when "the viewport is stealing my event" — silently disables
the other. And any future claimant that *does* depend on Konva having processed the event first would
be depending on Svelte's `$effect` flush order between a child component and its parent.

---

### H8 — A claimed Konva drag has no cancellation route at all. **MEDIUM**

**Mechanism.** Konva's drag engine binds only `mousemove`/`touchmove`/`mouseup`/`touchend`/
`touchcancel` on `window` (Part 0 rule 6). There is **no `pointercancel` handler**. `cropDragActive`
is set on Konva's `dragstart` and cleared **only** on Konva's `dragend`.

**Trigger.** Anything that fires `pointercancel` without a `mouseup`/`touchend`: an OS-level gesture
takeover, a browser back-swipe, a device orientation change, the touch being converted to a scroll by
the compositor.

**Outcome.** `cropDragActive` stays `true` forever. The crop-scene effect
(`if (!cropDragActive) renderCropScene()`) then **never rebuilds the crop preview again** — crop
values typed into the numeric fields update the domain but the preview freezes. Requires a route
change to recover.

**Test coverage.** None; the e2e crop-handle test (`tests/e2e/stitchMap.spec.ts:292`) always completes
the drag normally.

---

### H9 — `CLICK_SLOP_PX = 4` is a single constant applied identically to mouse and touch. **CLOSED (this commit)**

**Fix.** The single constant became a pointer-type-aware function, `clickSlopPx(pointerType)`, in
`src/lib/viewport.svelte.ts`:

| `pointerType` | Threshold (CSS px) | Rationale |
|---|---|---|
| `'mouse'` | **4** (unchanged) | Chromium's own click/drag slop is ~5px; OS-filtered trackpad drift is typically 1-3px. The prior value was already correct here — see the original assessment below, kept for context. |
| `'pen'` | **6** | A stylus tip is more precise than a finger but still less so than a mouse cursor; between the mouse and touch values. |
| `'touch'` | **10** | Platform touch-slop norms are ~8px (Android) to ~10px (iOS); at the old flat 4px an ordinary finger tap routinely drifted past the threshold before lift. |
| `undefined` / `''` (unknown — jsdom's default for a bare `new PointerEvent(...)`) | **4** | Falls back to the mouse value so every pre-existing test that never set `pointerType` keeps its prior behavior unmodified. |

`CLICK_SLOP_PX` (value `4`) stays exported for any external reference that wants a single constant —
it is also `clickSlopPx`'s own mouse/fallback value, so the two can never drift apart.

**Call sites updated — seven usages across five consumer files** (the original audit's count of "five
places" undercounted the two separate `annotate-round` arbitrations and did not name ribbon-editor by
file; every real usage is listed here):

| File | Usage | pointerType source |
|---|---|---|
| `src/lib/components/ImageViewport.svelte` | pan-vs-click promotion (`onPointerMove`) | `gesture.pointerType`, captured on the `PanGesture` at `pointerdown` (the step-F branch) so move/up never re-derive it from a possibly-stale event |
| `src/lib/components/ImageViewport.svelte` | click test (`onPointerUp`, `isClick`) | same `gesture.pointerType` |
| `src/lib/components/ImagePane.svelte` | marker-drag threshold (`onMarkerMove`) | the `PointerEvent` already passed into the handler (`event.pointerType`) |
| `src/routes/ribbon-editor/+page.svelte` | vertex-drag threshold (`handlePointMove`) | `handlePointMove` gained an `event: PointerEvent` second parameter (it previously discarded the event `ImageViewport`'s `onClaimedPointerMove` always supplies) |
| `src/routes/annotate-round/+page.svelte` | number-select drag threshold (`previewAnnotationMove`) | `previewAnnotationMove` gained an `event: PointerEvent` second parameter, structurally compatible with `ImageEditorPane`'s three-argument `(pointer, event, view)` callback type |
| `src/routes/annotate-round/+page.svelte` | annotation-marker drag threshold (`previewAnnotationMove`, same function) | same `event` parameter |
| `src/routes/stitch-map/+page.svelte` | tile-drag threshold (`handleTileDragMove`) | the `PointerEvent` already passed into the handler (`event.pointerType`) |

Five of the seven usages already received the originating `PointerEvent` in their existing handler
signature (`ImageViewport`'s own two, `ImagePane`, and stitch-map), so those needed no plumbing change
at all — `event.pointerType` was simply substituted for the constant. Only two call sites
(`ribbon-editor`'s `handlePointMove`, `annotate-round`'s `previewAnnotationMove`) had their own
`onClaimedPointerMove` handler strip the event down to just the `pointer` argument; both gained a
second `event: PointerEvent` parameter, which is additive and does not change any existing call site
(the viewport always passed `event` as the second argument — these handlers just ignored it before).

**Consistency with claimed-gesture drag-start arbitration.** The task that closed this hazard required
the same threshold to govern both directions of the arbitration everywhere it is compared — not just
`ImageViewport`'s own click-vs-pan decision, but every claimed gesture's tap-vs-drag decision too, so
that (for example) a touch tap on a correspondence marker in `ImagePane` does not itself become a
false 5-8px marker-drag. All seven usages above use `clickSlopPx` uniformly; none was left on the flat
4px value.

**Test coverage (new).** `tests/unit/imageViewportClickSlop.test.ts` pins `clickSlopPx`'s per-type
values directly and exercises the `ImageViewport` boundary end-to-end (mouse 5px → pan, unset
pointerType 5px → pan, touch 8px → click, touch 11px → pan).
`tests/unit/imagePaneCorrection.test.ts` adds the same 8px/11px touch boundary for a claimed marker
drag. `tests/unit/annotateRoundRadialMenu.test.ts` adds the end-to-end interaction check: a touch tap
with an 8px drift now opens the radial menu (previously it would have been promoted to a pan at 4px
and `onViewportClick` would never have fired); an 11px drift still does not open it.

---

**Original assessment (superseded by the fix above; kept for the mouse-value rationale).** The
constant was used in five places as originally counted: the viewport's own pan threshold and click
test, `ImagePane`'s marker drag, ribbon-editor's vertex drag, stitch-map's tile drag, and
annotate-round's three drag arbitrations.

- **For mouse and trackpad it was defensible.** Chromium's own click/drag slop is ~5 CSS px; 4 is
  marginally tighter. Trackpad tap drift is typically 1-3 px because the pointer position is filtered
  by the OS before it becomes a `pointermove`. A prior audit's "4 px is tight" flag was fair as a
  caution but was not producing a failure mode on mouse input — which is why the fix above keeps 4 for
  mouse rather than raising it.
- **For touch it was clearly too tight.** Finger-tap drift of 5-10 CSS px is routine; platform touch
  slop is ~8 px (Android) to ~10 px (iOS). At 4 px a normal tap crossed the threshold, so:
  the viewport started a pan and `isClick` was false → **`onViewportClick` never fired**. That broke
  annotate-round's radial menu (opened from `onPlacement` ← `onViewportClick`), `ImagePane`'s
  placement clicks, and stitch-map's tile click-selection. It also produced a visible few-pixel view
  jump on every tap, because the pan began the instant the threshold was crossed.

---

### H10 — A claimed **mouse** gesture is never `preventDefault`ed, so native selection/drag defaults stay live. **LOW-MEDIUM**

This is the acknowledged cost of `cc7924e`, and it is correct — but it is undocumented. During a
mouse marker drag in annotate-round or ribbon-editor, the browser's native text-selection and
image-drag defaults are still armed over the `content` snippet. `.source-image { user-select: none }`
covers the `<img>` in `ImageEditorPane`; nothing covers the SVG overlay or surrounding text in either
route. Symptom: an I-beam cursor and a stray selection highlight during a drag. Cosmetic, but it has
a CSS-only mitigation that touches no event code (Part 3, item 5).

---

### H11 — Magnifier interactions during captured gestures. **LOW**

`ImagePane` binds `pointermove` and `pointerleave` on the container for the hover magnifier. During
an **unclaimed pan**, capture is held on that container, so (Part 0 rule 3) every `pointermove`
retargets there and `handleHoverMove` keeps firing even when the pointer is physically off the pane,
while `pointerleave` is suppressed until release. In practice this self-corrects: `handleHoverMove`
bounds-checks against the image and nulls the magnifier when outside. During a **claimed** marker drag
there is no capture, so container moves stop at the edge and the window-level `onMarkerMove` correctly
keeps the magnifier anchored to the clamped drag preview. No user-visible defect found; recorded so
the capture/boundary-event interaction is not re-derived next time.

---

### H12 — Destroy mid-gesture: correct, with two unenforced assumptions. **LOW**

`onDestroy` calls `endGesture()`, `endClaimedGesture()`, clears `activePointers` and `pinch`, removes
the `onAnyPointer*` window listeners, and disconnects the `ResizeObserver`. The `$effect` cleanup
removes the container's `wheel` and `pointerdown`. Verified by
`paneNavigation.test.ts:522`. Two things it does *not* do, both currently benign:

1. **Pointer capture is never explicitly released.** Removing the capturing element from the document
   releases implicitly (Part 0 rule 4), so this is fine — but it means the component's correctness
   depends on the element actually being removed, which is true for unmount and would not be true if
   the container were ever reused.
2. **Consumer window listeners are the consumer's problem.** `ImagePane` and `stitch-map` each clean
   up correctly in their own `onDestroy`; this is convention with no enforcement point. A future
   claimant that registers listeners in `claimPointer` and forgets its `onDestroy` leaks them past
   navigation.

---

### Hazard summary

| ID | Hazard | Severity | Worst consumer | Existing test would catch? |
|---|---|---|---|---|
| H1 | Pinch cancels a claim; 2 of 4 claimants never wired the cancel | **HIGH** | create-graphics, stitch-map alignment | No |
| H2 | Pinch branch `preventDefault`s mouse pointerdown (bug #1 uncorrected) | **HIGH** | stitch-map crop | No |
| H3 | `activePointers` leak on id mismatch → permanent phantom pinch | **HIGH** | any dual-viewport page | No |
| H4 | Wheel not gated on an active gesture | MED-HIGH | stitch-map crop | No |
| H5 | Wheel escapes `preventDefault` when `fitTarget` is null | MED-HIGH | stitch-map (partial session) | Test asserts the *opposite* |
| H6 | Interactive-control guard is a tag whitelist | MEDIUM | any future `content` control | Button case only |
| H7 | Konva binds `pointerdown` on the same element; no `stopPropagation` anywhere | MEDIUM | ImagePane, stitch-map | No |
| H8 | Konva drag has no `pointercancel` route; `cropDragActive` can stick | MEDIUM | stitch-map crop | No |
| H9 | `CLICK_SLOP_PX = 4` applied to touch as well as mouse | **CLOSED** | annotate-round | Yes (new, see H9) |
| H10 | Claimed mouse gesture leaves native selection defaults live | LOW-MED | annotate-round, ribbon-editor | No |
| H11 | Magnifier vs capture/boundary-event suppression | LOW | create-graphics | n/a |
| H12 | Destroy-time capture release and consumer listener cleanup are unenforced | LOW | — | Partly (`:522`) |

---

## Part 3 — Minimal hardening proposal

`docs/architecture-teardown.md` §11 forbids rewriting working code for style, and names this component
family specifically. Everything below is additive: no gesture flow is restructured, no consumer is
refactored, no abstraction is introduced. Ranked by **risk reduction per line changed**.

### Ranked changes

**1. Wire the two missing `onClaimedPointerCancel` props. — 2 lines, closes H1 (HIGH).**
The callback already exists and is already invoked by the viewport; two consumers simply never passed
it.
- `ImagePane.svelte`: add `onClaimedPointerCancel={onMarkerCancel}` to the `<ImageViewport>` — the
  handler already exists and already calls `endMarkerGesture()` + `clearDragPreview()`.
- `stitch-map/+page.svelte`: add `onClaimedPointerCancel={handleTileDragCancel}` to the alignment
  `<ImageViewport>` — likewise already written and already correct (it reconciles the live node back
  to the authoritative placements without committing).

Best ratio in the document: two props, and the highest-severity durable-data hazard is closed.

**2. Delete the owned pointer id in the three mismatch bail-outs. — 3 lines, closes H3 (HIGH).**
In `onPointerMove`/`onPointerUp` add `activePointers.delete(gesture.pointerId)` before `endGesture()`;
in `handleClaimedPointerMove`/`handleClaimedPointerUp` add
`activePointers.delete(claimedGesture.pointerId)` before `endClaimedGesture()`. This preserves the
existing (deliberate) tear-down-on-mismatch policy and only stops the map from accumulating pointers
whose listeners are gone. It also removes the permanent trigger for H2.

**3. Make the pinch branch's `preventDefault` pointer-type-aware. — 1 line, closes H2 (HIGH).**
In step **[C]**, replace `event.preventDefault();` with
`if (event.pointerType !== 'mouse') event.preventDefault();`, mirroring `cc7924e` exactly, and extend
the existing comment to say why. A mouse pointer reaching that branch is by definition part of a
mixed-input situation where Konva's compatibility-mouse drag must survive.

**4. Write this contract into the component as its authoritative doc comment. — ~40 comment lines, 0 behavior change.**
`ImageViewport.svelte` currently carries excellent *local* comments (`cc7924e`'s is the model) but no
statement of the whole contract at the top of the module. Add a module-level comment containing: the
step-A-through-F flowchart from §1.2 in condensed form, the "promises / does not promise" list from
§1.4, and a pointer to this file. The three shipped bugs were all cases where a reader could not see
the whole contract from the code — this is the cheapest structural mitigation available, and it is
exactly the treatment §11 endorses ("now explicitly documented at the seam in `ImageViewport`").

**5. `user-select: none` on `.image-viewport`. — 1 CSS line, closes H10.**
Pure CSS, touches no event code, removes the native selection defaults that a claimed *mouse* gesture
intentionally leaves armed. The empty-state `<button>` and any future control are unaffected.

**6. Move `event.preventDefault()` above the `fitTarget` check in `onWheel`. — 1 line + 1 test edit, closes H5 (MED-HIGH).**
Consume any nonzero wheel over the viewport whether or not there is content to zoom, then return.
This requires flipping the assertion at `paneNavigation.test.ts:467` and rewriting its comment —
call that out in the commit message, since the current test encodes the opposite intent and a silent
flip would look like a test being weakened. The rationale: an empty viewport is still a viewport, and
the thing being prevented is a **session-destroying navigation**, not a scroll.

**7. Gate the wheel handler on an in-flight gesture. — 1 line, closes H4 (MED-HIGH).**
After the `preventDefault()` of item 6, add
`if (gesture || claimedGesture || pinch) return;`. The wheel is still consumed (no back-swipe), but
the transform stops moving under a drag that snapshotted it. This is strictly safer than the
alternative of teaching five consumers to re-read the transform mid-drag.

**8. Clear `cropDragActive` on the viewport's cancel path. — ~3 lines in stitch-map, closes H8 (MEDIUM).**
Combined with item 1, give the crop viewport an `onClaimedPointerCancel` that calls `stopDrag()` on
the live handle and resets `cropDragActive = false`. Track the dragging handle in the existing
`dragstart` callback (it already sets `cropDragActive`). This is the only place in the codebase where
a claimant is a foreign drag engine, so it is also the only place that needs an explicit bridge.

**9. Broaden `isInteractiveControl`'s selector. — 1 line, mitigates H6 (MEDIUM).**
Append `, [role="button"], [role="link"], [contenteditable], summary` to the existing selector, and
extend the comment to state the invariant plainly: *any element inside a `content` snippet that needs
a native click must match this selector, or capture retargeting will eat its click.* This does not
make the guard complete (nothing short of a capability test would), but it covers the realistic
additions and, more importantly, names the rule for the next person adding something to `content`.

**Formerly not proposed, now done: `clickSlopPx` (H9), closed in a later commit.** This section
originally deferred the pointer-type-aware fix as its own ticket ("changing one shared constant used
by five call sites in four files is its own ticket with its own tests, not an audit side effect"). That
ticket has since landed — see H9 in Part 2 for the values, the full call-site list (seven usages across
five files, not five across four — this section's original count undercounted), and the new tests.

### Missing tests that pin the contract

One per shipped-bug class, one per new hazard closed. All are unit tests in the style of the existing
`imageViewportPinchZoom.test.ts` unless noted.

| Test | Pins | Shape |
|---|---|---|
| **T1** — a claimed `pointerType: 'mouse'` pointerdown is **not** `defaultPrevented`; a claimed `'touch'` one **is** | Bug #1 | Mount with a `claimPointer` returning true; dispatch both; assert `event.defaultPrevented`. Missing today at every level. |
| **T2** — an unclaimed pointerdown on a `<button>` inside `content` takes no capture and does not `preventDefault` | Bug #3 | Spy on `setPointerCapture`; assert not called. Complements the e2e filechooser test with a fast unit-level guard. |
| **T3** — a horizontal-only wheel is consumed **with no fit target** | Bug #2 / H5 | Replaces the current inverted assertion at `paneNavigation.test.ts:467`. |
| **T4** — a second pointer during a claimed gesture invokes `onClaimedPointerCancel` **and** the consumer stops committing | H1 | Viewport-level: assert the callback fires. Plus a `create-graphics` page-level test asserting no `onPointMove` commit results from a pinch-interrupted marker drag. |
| **T5** — a `pointermove` with a foreign pointer id does not leave a residue in `activePointers` | H3 | Down id 1, move id 2, up id 1, then down id 3 alone and assert a **pan** (not a pinch): `controller.view.zoom` unchanged, `panX` tracks the pointer 1:1. |
| **T6** — the pinch branch does not `preventDefault` a mouse pointerdown | H2 | Down `pointerId 1, pointerType 'touch'`; then `pointerId 2, pointerType 'mouse'`; assert `defaultPrevented === false` on the second. |
| **T7** — a wheel during an active pan or claimed gesture is consumed but does not change the view | H4 | Down, move past slop, dispatch ctrl+wheel, assert `preventDefault` returned false **and** `controller.view` is unchanged. |
| **T8** — `pointercancel` on a claimed crop gesture clears `cropDragActive` and the crop preview still rebuilds | H8 | stitch-map page-level; assert a crop-field change after the cancel still re-renders. |

`tests/unit/imageViewportPinchZoom.test.ts` needs one mechanical prerequisite: its `pointerDown`,
`pointerMove`, and `pointerUp` helpers must start passing `pointerType`, which they do not today
(jsdom defaults it to `''`, so no current test exercises either side of the mouse/touch asymmetry).

### What NOT to do

- **Do not unify `ImageViewport` with Konva's event system, in either direction.** They are two
  independent input stacks by design; §11 protects the multi-renderer arrangement explicitly. The fix
  for every hazard above is a *guard at the seam*, never a merged pipeline.
- **Do not introduce a gesture-recognition library** (Hammer, `@use-gesture`, Interact.js). Every
  hazard here is about *coexisting with* other input consumers on the same element; a library that
  wants to own the element makes that strictly worse, and none of them model the
  `preventDefault`/pointer-type asymmetry the Konva claimants depend on.
- **Do not add pointer capture to the claimed path.** It looks like it would tidy up the
  capture/no-capture split. It would re-introduce bug #1 for Konva claimants and bug #3 for anything
  clickable inside `content`.
- **Do not "simplify" the claim protocol into a full pointer arbiter / state machine.** Four claimants
  with four different needs are correctly served by a boolean plus three optional callbacks. Items 1-3
  above are two props and four lines; a rewrite is orders of magnitude more risk for the same outcome.
- **Do not make the `wheel` listener passive** or move it to `window`/`document`. Both silently
  disable `preventDefault` and restore bug #2 (Part 0 rule 5).
- **Do not remove the `pointerType !== 'mouse'` asymmetry** because it looks inconsistent. It is the
  fix for bug #1. Item 3 makes the codebase *more* consistent by applying the same rule in the one
  branch that missed it.
- **Do not decompose `stitch-map/+page.svelte` or the panes** while closing these hazards. Every
  change proposed here is a prop, a line, or a comment inside the existing structure — §11's ruling
  on those files stands.
- ~~Do not change `CLICK_SLOP_PX` as part of this work.~~ Superseded: this was scoped explicitly as its
  own follow-up (see H9's original text) and has since been done, replacing the flat constant with
  `clickSlopPx(pointerType)` while keeping `CLICK_SLOP_PX` exported as the unchanged mouse value.

---

## Appendix — file/line index for this review

| Thing | Location |
|---|---|
| `onPointerDown` decision tree | `src/lib/components/ImageViewport.svelte:288-348` |
| `cc7924e` mouse/touch `preventDefault` comment | `src/lib/components/ImageViewport.svelte:317-330` |
| `f38b13c` interactive-control guard | `src/lib/components/ImageViewport.svelte:274-286` |
| `fb51c7a` wheel model | `src/lib/components/ImageViewport.svelte:162-186` |
| `onKeyDown` (keyboard pan/zoom/fit; role/aria-label computation is above it, `:84-98`) | `src/lib/components/ImageViewport.svelte:205-272` |
| On-canvas zoom controls (`zoomAboutCenter`/`handleZoomInClick`/`handleZoomOutClick`/`handleFitClick`, markup) | `src/lib/components/ImageViewport.svelte:188-203, 565-608` |
| Keyboard pan/zoom step constants | `src/lib/navigation.ts` (`KEYBOARD_PAN_STEP_PX`, `KEYBOARD_PAN_STEP_SHIFT_MULTIPLIER`, `KEYBOARD_ZOOM_STEP_FACTOR`) |
| `ViewportController.centerPoint`/`zoomAtCenter` | `src/lib/viewport.svelte.ts` |
| Pinch anchor / re-anchor | `src/lib/components/ImageViewport.svelte:350-396` |
| Teardown | `src/lib/components/ImageViewport.svelte:486-546` |
| Container listener registration | `src/lib/components/ImageViewport.svelte:512-532` |
| `CLICK_SLOP_PX` (mouse/fallback value, `4`) and `clickSlopPx(pointerType)` | `src/lib/viewport.svelte.ts` |
| `ImagePane` marker claim (own window listeners) | `src/lib/components/ImagePane.svelte:219-237` |
| stitch-map tile claim (own window listeners) | `src/routes/stitch-map/+page.svelte:756-777` |
| stitch-map crop claim (Konva-native) | `src/routes/stitch-map/+page.svelte:891-898` |
| Konva crop-handle drag callbacks / `cropDragActive` | `src/routes/stitch-map/+page.svelte:1096-1109` |
| ribbon-editor claim (viewport plumbing) | `src/routes/ribbon-editor/+page.svelte:147-205` |
| annotate-round claim (viewport plumbing) | `src/routes/annotate-round/+page.svelte:624-725` |
| stitch-map's pre-existing `event.target !== event.currentTarget` scoping (the pattern `onKeyDown` mirrors) | `src/routes/stitch-map/+page.svelte:630-656` (`handleAlignmentKeyDown`) |
| Pinch tests | `tests/unit/imageViewportPinchZoom.test.ts` |
| Keyboard pan/zoom/fit + on-canvas control tests | `tests/unit/imageViewportKeyboard.test.ts` |
| Wheel + lifecycle tests | `tests/unit/paneNavigation.test.ts:461-570` |
| Crop-handle drag e2e (bug #1) | `tests/e2e/stitchMap.spec.ts:292-305` |
| Inline choose-button e2e (bug #3) | `tests/e2e/annotateRound.spec.ts:83-84` |
| On-canvas zoom controls + keyboard pan/zoom/fit e2e | `tests/e2e/ribbonEditor.spec.ts` (viewport keyboard/controls tests) |
| `role="img"` pin for the two consumers this change cannot edit | `tests/e2e/accessibility.spec.ts:124, 156-157` |
