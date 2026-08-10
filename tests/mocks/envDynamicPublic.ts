/**
 * Vitest resolution stub for SvelteKit's `$env/dynamic/public` (no `sveltekit()`
 * Vite plugin runs under vitest.config.ts, only `$lib`, so the real generated
 * module is never resolvable here — same reasoning as `appNavigation.ts` and
 * `appPaths.ts`). Aliased in vitest.config.ts. Deliberately empty: it mirrors
 * running keyless with no `PUBLIC_GOOGLE_MAPS_API_KEY` set anywhere. Tests that
 * need a key exercise `googleMapsConfig.ts`'s `setGoogleMapsApiKeyForTesting`
 * seam instead of mutating this module.
 */
export const env: Record<string, string | undefined> = {};
