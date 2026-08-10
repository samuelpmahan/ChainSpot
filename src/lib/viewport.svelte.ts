/**
 * ChainSpot shared image-viewport controller (P05-002 review).
 *
 * One authoritative `ViewTransformState` per image-editing surface, owned by a
 * `ViewportController` and driven by the `ImageViewport` component. All math
 * reuses the existing pure functions from `$lib/coords.ts` and `$lib/navigation.ts`;
 * nothing here is duplicated.
 *
 * The controller deliberately knows nothing about projects, roles, control
 * points, stitch slots, or crops: it only manages display navigation over a
 * `ViewportFitTarget` supplied by the consumer.
 */
import {
	fitViewTransform,
	identityViewTransform,
	imageToScreen,
	screenToImage
} from './coords';
import type { ImageSpacePoint, ScreenSpacePoint, ViewTransformState } from './coords';
import { untrack } from 'svelte';
import {
	DEFAULT_VIEW_ZOOM_LIMITS,
	panBy,
	zoomAtPointer,
	zoomLimitsForFit
} from './navigation';
import type { ViewZoomLimits } from './navigation';

/**
 * Click-versus-drag / drag-start threshold in CSS pixels, kept as the mouse
 * value for any external reference that still wants a single constant (and
 * as `clickSlopPx`'s own fallback below). Chromium's own mouse click/drag
 * slop is ~5px; OS-filtered trackpad drift is typically 1-3px, so 4 is
 * defensible for mouse/trackpad input. It is deliberately too tight for
 * touch — see `clickSlopPx`.
 */
export const CLICK_SLOP_PX = 4;

/** Pen click/drag threshold in CSS pixels: a stylus tip is more precise than a finger but still less so than a mouse cursor. */
const PEN_CLICK_SLOP_PX = 6;

/**
 * Touch click/drag threshold in CSS pixels. Platform touch-slop norms are
 * ~8px (Android) to ~10px (iOS); at the mouse value of 4px an ordinary
 * finger tap routinely drifts past the threshold before lift, so the
 * gesture is promoted to a micro-pan/drag and the tap's `click` (or, in a
 * claimed gesture, its non-drag outcome) never fires. See
 * `docs/imageviewport-event-contract.md`, hazard H9.
 */
const TOUCH_CLICK_SLOP_PX = 10;

/**
 * Pointer-type-aware click-versus-drag / drag-start threshold in CSS
 * pixels. Governs both directions of the same arbitration everywhere it is
 * compared: whether an unclaimed pointer gesture is a click or a pan
 * (`ImageViewport`), and whether a claimed gesture is a tap/click or a drag
 * (marker drag, ribbon vertex drag, stitch tile drag, annotate-round's
 * point/number drags). `pointerType` is `'mouse' | 'pen' | 'touch'` per the
 * Pointer Events spec; an empty string or `undefined` — jsdom's default for
 * a bare `new PointerEvent(...)`, and the value Safari has historically
 * reported for some synthetic events — falls back to the mouse value so
 * existing tests that never set `pointerType` keep their prior behavior.
 */
export function clickSlopPx(pointerType: string | undefined): number {
	switch (pointerType) {
		case 'touch':
			return TOUCH_CLICK_SLOP_PX;
		case 'pen':
			return PEN_CLICK_SLOP_PX;
		default:
			return CLICK_SLOP_PX;
	}
}

/** The logical content a viewport fits: an axis-aligned rect in content coordinates. */
export interface ViewportFitTarget {
	readonly xPx: number;
	readonly yPx: number;
	readonly widthPx: number;
	readonly heightPx: number;
}

/**
 * Centered fit over a target rectangle whose origin may not be `(0, 0)` (for
 * example the union of translated stitch tiles). Identical to the pane fit for
 * origin-zero targets.
 */
export function fitViewportTransform(
	target: ViewportFitTarget,
	paneWidth: number,
	paneHeight: number
): ViewTransformState {
	const fit = fitViewTransform(target.widthPx, target.heightPx, paneWidth, paneHeight);
	return {
		zoom: fit.zoom,
		panX: fit.panX - target.xPx * fit.zoom,
		panY: fit.panY - target.yPx * fit.zoom
	};
}

function nearlyEqual(a: ViewTransformState, b: ViewTransformState): boolean {
	return (
		Math.abs(a.zoom - b.zoom) <= 1e-9 &&
		Math.abs(a.panX - b.panX) <= 1e-9 &&
		Math.abs(a.panY - b.panY) <= 1e-9
	);
}

export class ViewportController {
	/** Authoritative transient view state (display state only, never domain state). */
	view = $state<ViewTransformState>(identityViewTransform());
	/** The fit transform for the current target and size; Fit restores this. */
	fitView = $state<ViewTransformState>(identityViewTransform());
	/** Pane content size in CSS pixels (stage-local coordinates). */
	size = $state({ width: 1, height: 1 });
	/** The viewport container element, bound by `ImageViewport`. */
	container = $state<HTMLDivElement | null>(null);
	/** The logical content the viewport fits; null hides/disabled the viewport. */
	fitTarget = $state<ViewportFitTarget | null>(null);
	/** True while the viewport itself is drag-panning (cursor feedback). */
	panning = $state(false);

	/** Pointer position in container-local CSS pixels, matching the Konva stage space. */
	pointerIn(event: { clientX: number; clientY: number }): ScreenSpacePoint {
		const container = this.container;
		if (!container) return { x: event.clientX, y: event.clientY };
		const rect = container.getBoundingClientRect();
		return {
			x: event.clientX - rect.left - container.clientLeft,
			y: event.clientY - rect.top - container.clientTop
		};
	}

	containsPoint(event: { clientX: number; clientY: number }): boolean {
		const container = this.container;
		if (!container) return false;
		const rect = container.getBoundingClientRect();
		const left = rect.left + container.clientLeft;
		const top = rect.top + container.clientTop;
		return (
			event.clientX >= left &&
			event.clientX < left + container.clientWidth &&
			event.clientY >= top &&
			event.clientY < top + container.clientHeight
		);
	}

	toImage(point: ScreenSpacePoint): ImageSpacePoint {
		return screenToImage(point, this.view);
	}

	toScreen(point: ImageSpacePoint): ScreenSpacePoint {
		return imageToScreen(point, this.view);
	}

	/** Interactive zoom limits derived from the current fit zoom (Phase 0 rule). */
	zoomLimits(): ViewZoomLimits {
		if (!this.fitTarget) return DEFAULT_VIEW_ZOOM_LIMITS;
		return zoomLimitsForFit(this.fitView.zoom);
	}

	/** Pointer-centered wheel zoom (limits from `zoomLimits`). */
	zoomAtPointer(pointer: ScreenSpacePoint, zoomFactor: number): void {
		this.view = zoomAtPointer(this.view, pointer, zoomFactor, this.zoomLimits());
	}

	/** The viewport's own center, in container-local CSS pixels — the anchor for keyboard zoom and the on-canvas zoom buttons (neither has a pointer position to anchor on). */
	centerPoint(): ScreenSpacePoint {
		return { x: this.size.width / 2, y: this.size.height / 2 };
	}

	/** Zoom about the viewport center (limits from `zoomLimits`, same clamp as `zoomAtPointer`). */
	zoomAtCenter(zoomFactor: number): void {
		this.zoomAtPointer(this.centerPoint(), zoomFactor);
	}

	/** Background drag-pan in CSS-pixel screen space, retaining zoom. */
	panBy(deltaX: number, deltaY: number): void {
		this.view = panBy(this.view, deltaX, deltaY);
	}

	/** Restores the full fit of the current target. No-op without a target. */
	fit(): void {
		if (!this.fitTarget) return;
		this.view = { ...this.fitView };
	}

	/**
	 * Updates the fitted content. When the view is currently at the previous fit,
	 * the view follows the new fit; a custom zoom/pan is preserved. Clearing the
	 * target resets the view to identity so a later session never inherits stale
	 * pan/zoom. Reads and writes are untracked so effects calling this never loop
	 * on view state.
	 */
	setFitTarget(target: ViewportFitTarget | null): void {
		untrack(() => {
			const previousFit = this.fitView;
			this.fitTarget = target;
			if (!target) {
				this.fitView = identityViewTransform();
				this.view = identityViewTransform();
				return;
			}
			this.fitView = fitViewportTransform(target, this.size.width, this.size.height);
			if (nearlyEqual(this.view, previousFit)) {
				this.view = { ...this.fitView };
			}
		});
	}

	/**
	 * Viewport resize policy (Phase 0): at the default fit the new fit is used;
	 * from a custom view, zoom is retained and the content point under the pane
	 * center is anchored to the new center. The fitted check compares directly
	 * against `fitView` (which carries the fit-target origin), and the custom
	 * branch is computed inline from that single decision — it never re-runs an
	 * origin-zero fit detection that could misclassify a custom translated view
	 * as fitted. Untracked like `setFitTarget`.
	 */
	setSize(next: { width: number; height: number }): void {
		untrack(() => {
			const previous = this.size;
			const target = this.fitTarget;
			if (!target) {
				this.size = next;
				return;
			}
			const wasFitted = nearlyEqual(this.view, this.fitView);
			const anchor = screenToImage(
				{ x: previous.width / 2, y: previous.height / 2 },
				this.view
			);
			const zoom = this.view.zoom;

			this.size = next;
			this.fitView = fitViewportTransform(target, next.width, next.height);

			if (wasFitted) {
				this.view = { ...this.fitView };
			} else {
				this.view = {
					zoom,
					panX: next.width / 2 - anchor.xPx * zoom,
					panY: next.height / 2 - anchor.yPx * zoom
				};
			}
		});
	}
}
