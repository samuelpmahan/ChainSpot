/**
 * ChainSpot's single source of truth for whether Google Maps Platform features
 * (Places Text Search course lookup, Dynamic Maps satellite confirm step) are
 * available. Every component reads the key through here rather than touching
 * `$env` directly, so "is Google configured" is answered in exactly one place.
 *
 * Read via `$env/dynamic/public`, not `$env/static/public`: the static variant
 * is a *build error* when the referenced env var is entirely unset (SvelteKit
 * validates it against `.env`/process env at build time), which would break
 * ChainSpot's default keyless build. The dynamic variant simply yields
 * `undefined` for an unset var, matching this app's deliberate keyless-first
 * ethos — no key configured anywhere (repo secret or local `.env`) must still
 * produce a working build with zero Google contact.
 *
 * `PUBLIC_GOOGLE_MAPS_API_KEY` is wired in by `docs/google-maps-setup.md` and
 * `.github/workflows/deploy-pages.yml`.
 */
import { env } from '$env/dynamic/public';

/**
 * Test-only override: forces `googleMapsApiKey`/`googleMapsEnabled` to behave
 * as though the given key were configured (or, with `null`, as keyless),
 * bypassing `$env` entirely. `undefined` (the default) restores normal
 * env-based resolution. Application code never calls this.
 */
let testOverrideKey: string | null | undefined;

function resolveKey(): string | null {
	if (testOverrideKey !== undefined) return testOverrideKey;
	const raw = env.PUBLIC_GOOGLE_MAPS_API_KEY;
	return typeof raw === 'string' && raw.trim() !== '' ? raw : null;
}

/** The configured Google Maps Platform key, or `null` when running keyless. */
export function googleMapsApiKey(): string | null {
	return resolveKey();
}

/** Whether any Google Maps Platform feature (Places search, the map confirm step) should be offered at all. */
export function googleMapsEnabled(): boolean {
	return resolveKey() !== null;
}

/** Test seam for `googleMapsApiKey`/`googleMapsEnabled` — see `testOverrideKey` above. */
export function setGoogleMapsApiKeyForTesting(key: string | null | undefined): void {
	testOverrideKey = key;
}
