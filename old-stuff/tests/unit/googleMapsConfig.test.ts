import { afterEach, describe, expect, test } from 'vitest';
import { googleMapsApiKey, googleMapsEnabled, setGoogleMapsApiKeyForTesting } from '../../src/lib/googleMapsConfig';
import { env as mockPublicEnv } from '../mocks/envDynamicPublic';

afterEach(() => {
	setGoogleMapsApiKeyForTesting(undefined);
	// Undo any direct mutation of the shared `$env/dynamic/public` mock (see the
	// "real env value" describe block below) so no test can leak its env shape
	// into a later one, regardless of run order.
	delete mockPublicEnv.PUBLIC_GOOGLE_MAPS_API_KEY;
});

describe('googleMapsConfig', () => {
	test('is keyless by default (no PUBLIC_GOOGLE_MAPS_API_KEY in the test env mock)', () => {
		expect(googleMapsApiKey()).toBeNull();
		expect(googleMapsEnabled()).toBe(false);
	});

	test('the test seam overrides resolution to a configured key', () => {
		setGoogleMapsApiKeyForTesting('test-key-abc');
		expect(googleMapsApiKey()).toBe('test-key-abc');
		expect(googleMapsEnabled()).toBe(true);
	});

	test('the test seam overrides resolution back to keyless with null', () => {
		setGoogleMapsApiKeyForTesting('test-key-abc');
		setGoogleMapsApiKeyForTesting(null);
		expect(googleMapsApiKey()).toBeNull();
		expect(googleMapsEnabled()).toBe(false);
	});

	test('undefined restores normal env-based resolution', () => {
		setGoogleMapsApiKeyForTesting('test-key-abc');
		setGoogleMapsApiKeyForTesting(undefined);
		expect(googleMapsApiKey()).toBeNull();
	});
});

/**
 * These bypass the `setGoogleMapsApiKeyForTesting` seam on purpose and mutate
 * the mocked `$env/dynamic/public` module directly, because the seam
 * short-circuits `resolveKey()` before its own `raw.trim() !== ''` guard ever
 * runs (see `resolveKey`) — it cannot exercise that guard at all. These two
 * shapes are exactly what production sees: GitHub Actions substitutes an
 * empty string, never an absent key, when the `GOOGLE_MAPS_API_KEY` repo
 * secret isn't set (`${{ secrets.GOOGLE_MAPS_API_KEY }}` in
 * deploy-pages.yml) — `docs/google-maps-setup.md`'s "no key configured ...
 * keyless" claim depends on the empty-string case resolving the same way as
 * the missing-entirely case, not merely on the latter.
 */
describe('googleMapsConfig — real $env/dynamic/public value (not the test seam)', () => {
	test('an empty-string env var (the shape an absent GitHub Actions secret produces) resolves keyless', () => {
		mockPublicEnv.PUBLIC_GOOGLE_MAPS_API_KEY = '';
		expect(googleMapsApiKey()).toBeNull();
		expect(googleMapsEnabled()).toBe(false);
	});

	test('a whitespace-only env var also resolves keyless', () => {
		mockPublicEnv.PUBLIC_GOOGLE_MAPS_API_KEY = '   ';
		expect(googleMapsApiKey()).toBeNull();
		expect(googleMapsEnabled()).toBe(false);
	});

	test('a non-empty env var resolves keyed, through the real (non-seam) path', () => {
		mockPublicEnv.PUBLIC_GOOGLE_MAPS_API_KEY = 'real-env-key-xyz';
		expect(googleMapsApiKey()).toBe('real-env-key-xyz');
		expect(googleMapsEnabled()).toBe(true);
	});
});
