/**
 * Vitest resolution stub for SvelteKit's `$app/paths` (no `sveltekit()`
 * Vite plugin runs under vitest.config.ts, only `$lib`, so the real generated
 * module is never resolvable here). Aliased in vitest.config.ts. `base` is
 * empty to match local dev/test, where the app is served from the domain root.
 */
export const base = '';
