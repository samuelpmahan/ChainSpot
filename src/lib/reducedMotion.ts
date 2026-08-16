/**
 * ChainSpot shared reduced-motion check (CHSPT-55/56 auto-first Stitch Map
 * UX). A tiny, pure, synchronous helper so callers stop hand-rolling the
 * same `window.matchMedia('(prefers-reduced-motion: reduce)').matches`
 * guard — Stitch Map alone now needs it in at least two places (phase
 * transitions, the badge-anchor flash).
 *
 * Deliberately does not become the one canonical import for the whole
 * codebase in this change: `ImageEditorPane.svelte` and
 * `AnnotationWorkspace.svelte` already have their own local ad hoc checks,
 * and migrating them is out of scope here — only new call sites in this
 * feature use this module.
 *
 * Safe outside a browser (SSR/tests): `window`/`matchMedia` are checked
 * before use, so this never throws when either is unavailable.
 */
export function prefersReducedMotion(): boolean {
	return (
		typeof window !== 'undefined' &&
		typeof window.matchMedia === 'function' &&
		window.matchMedia('(prefers-reduced-motion: reduce)').matches
	);
}
