/**
 * Resolution side of the Spotlight anchor contract (see `DemoAnchorId` in
 * `$lib/demo/catalog.ts`).
 *
 * Product elements opt in with `data-demo-anchor="<id>"`; this module finds
 * the one usable element for an id at render time. "Usable" means attached,
 * not `hidden`, and actually occupying layout space — a stale reference, a
 * display:none branch, or a control the route has not rendered yet all
 * resolve to `null`, and every caller treats `null` as "render the guide
 * without emphasis", never as an error.
 */
import type { DemoAnchorId } from '$lib/demo/catalog';

/** The attribute product markup carries to participate in the contract. */
export const DEMO_ANCHOR_ATTRIBUTE = 'data-demo-anchor';

/**
 * Finds the currently usable element for `id`, or `null`. When the same id
 * appears on mutually exclusive branches (Create Graphics renders its
 * location-search button in two alternate spots), the first usable one wins.
 */
export function resolveDemoAnchor(id: DemoAnchorId): HTMLElement | null {
	if (typeof document === 'undefined') return null;
	const candidates = document.querySelectorAll<HTMLElement>(`[${DEMO_ANCHOR_ATTRIBUTE}="${id}"]`);
	for (const candidate of candidates) {
		if (!candidate.isConnected || candidate.hidden) continue;
		const rect = candidate.getBoundingClientRect();
		if (rect.width <= 0 || rect.height <= 0) continue;
		return candidate;
	}
	return null;
}

export interface AnchorRect {
	readonly top: number;
	readonly left: number;
	readonly width: number;
	readonly height: number;
}

/** Viewport-relative rect for a resolved anchor, for fixed-position overlays. */
export function measureAnchor(element: HTMLElement): AnchorRect {
	const rect = element.getBoundingClientRect();
	return { top: rect.top, left: rect.left, width: rect.width, height: rect.height };
}

/**
 * Re-resolves and re-measures `id` on every visual invalidation the browser
 * exposes cheaply (resize, any scroll) plus a slow safety interval for layout
 * shifts neither reports (panels expanding, results appearing). Calls `onRect`
 * with `null` whenever the anchor stops being usable. Returns a cleanup
 * function; safe to call in any environment (no-ops without a `window`).
 */
export function observeDemoAnchor(
	id: DemoAnchorId,
	onRect: (rect: AnchorRect | null) => void
): () => void {
	if (typeof window === 'undefined') return () => {};

	const update = (): void => {
		const element = resolveDemoAnchor(id);
		onRect(element ? measureAnchor(element) : null);
	};

	update();
	window.addEventListener('resize', update);
	// Capture-phase so scrolls inside nested panes invalidate too.
	window.addEventListener('scroll', update, true);
	const interval = window.setInterval(update, 500);

	return () => {
		window.removeEventListener('resize', update);
		window.removeEventListener('scroll', update, true);
		window.clearInterval(interval);
	};
}
