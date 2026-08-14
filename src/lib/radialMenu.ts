/**
 * Pure geometry for the Annotate Course / Map Round radial placement menu.
 *
 * The menu itself is rendered as real HTML `<button>` elements by
 * `$lib/components/RadialMenu.svelte` (an accessible popover, not SVG), so the
 * only thing this module owns is the math: where each action's button sits on
 * a ring around the anchor point, and how far the whole ring must be nudged
 * so every button stays fully within the viewport pane's bounds. Both
 * functions are pure and reusable independent of Svelte, DOM, or
 * `AnnotationWorkspace`'s domain types.
 */

/** A button's center point, relative to the ring's anchor (0, 0). */
export interface RadialPosition {
	readonly x: number;
	readonly y: number;
}

/** Uniform on-screen size, in CSS px, shared by every ring button — used by `clampRingOffset`. */
export const RADIAL_BUTTON_SIZE_PX = 44;

/** Distance from the anchor to each button's center. */
export const RADIAL_RING_RADIUS_PX = 64;

function polarPoint(radius: number, angleRad: number): RadialPosition {
	return { x: radius * Math.sin(angleRad), y: -radius * Math.cos(angleRad) };
}

/**
 * Lays out `itemCount` positions evenly spaced around a circle of `radius`,
 * starting at 12 o'clock and proceeding clockwise — the same convention the
 * previous SVG wedge layout used, so the visual radial arrangement (and the
 * "radial order" arrow-key cycling is defined over) is unchanged. A single
 * item is placed at 6 o'clock (half the full circle from the start), which
 * reads naturally as "the one action, just below the click."
 */
export function radialPositions(
	itemCount: number,
	options: { radius?: number } = {}
): RadialPosition[] {
	const radius = options.radius ?? RADIAL_RING_RADIUS_PX;
	const count = Math.max(1, Math.floor(itemCount));
	const angleStep = (Math.PI * 2) / count;

	const positions: RadialPosition[] = [];
	for (let index = 0; index < count; index += 1) {
		const midAngle = index * angleStep + angleStep / 2;
		positions.push(polarPoint(radius, midAngle));
	}
	return positions;
}

export interface RingClampBounds {
	readonly width: number;
	readonly height: number;
}

export interface RingClampDelta {
	readonly dx: number;
	readonly dy: number;
}

/** Clamps a single axis's [min, max] span into [boundMin, boundMax], best-effort centering it if it doesn't fit. */
function clampAxis(min: number, max: number, boundMin: number, boundMax: number): number {
	let delta = 0;
	if (min < boundMin) delta = boundMin - min;
	else if (max > boundMax) delta = boundMax - max;
	// The span is wider than the available bounds (a pathologically small pane) —
	// no delta keeps both edges in bounds, so center it as the best available fit.
	if (min + delta < boundMin && max + delta > boundMax) {
		delta = (boundMin + boundMax - (min + max)) / 2;
	}
	return delta;
}

/**
 * The single translation that, applied to every button in `positions`
 * uniformly, keeps the whole ring's bounding box fully inside `bounds`
 * (a `[0, width] x [0, height]` pane, `anchor`-relative). The ring is moved
 * as one rigid shape — not each button independently — so the radial
 * arrangement stays visually coherent near an edge or corner, the same way a
 * native context menu repositions wholesale rather than warping its layout.
 * The anchor itself is never adjusted: only the visual ring offset is.
 */
export function clampRingOffset(
	positions: readonly RadialPosition[],
	itemSizePx: number,
	anchor: { x: number; y: number },
	bounds: RingClampBounds
): RingClampDelta {
	if (positions.length === 0) return { dx: 0, dy: 0 };
	const half = itemSizePx / 2;
	const xs = positions.map((position) => anchor.x + position.x);
	const ys = positions.map((position) => anchor.y + position.y);
	const minX = Math.min(...xs) - half;
	const maxX = Math.max(...xs) + half;
	const minY = Math.min(...ys) - half;
	const maxY = Math.max(...ys) + half;
	return {
		dx: clampAxis(minX, maxX, 0, bounds.width),
		dy: clampAxis(minY, maxY, 0, bounds.height)
	};
}
