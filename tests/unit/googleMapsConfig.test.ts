import { afterEach, describe, expect, test } from 'vitest';
import { googleMapsApiKey, googleMapsEnabled, setGoogleMapsApiKeyForTesting } from '../../src/lib/googleMapsConfig';

afterEach(() => {
	setGoogleMapsApiKeyForTesting(undefined);
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
