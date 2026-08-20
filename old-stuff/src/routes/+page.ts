/**
 * Front door (`/`): the single entry surface for a fresh visitor (see
 * `+page.svelte`). Previously a 307 redirect straight to `/annotate-course`;
 * that shortcut is gone now that `/` is a real consolidated page in its own
 * right; a bookmark to `/` lands here instead.
 *
 * No route in this app declares its own `prerender` — the root `+layout.ts`
 * already sets `prerender = true` for the whole app (required by the static
 * adapter), and every route inherits it. This file exists only so `/` has an
 * explicit, self-documenting home for that inherited contract; it carries no
 * `load` function because the page needs none — all of its work (file
 * selection, classification, routing) happens client-side inside event
 * handlers, after hydration.
 */
export const prerender = true;
