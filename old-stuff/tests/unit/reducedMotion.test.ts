// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from 'vitest';
import { prefersReducedMotion } from '../../src/lib/reducedMotion';

function mockMatchMedia(matches: boolean): void {
	Object.defineProperty(window, 'matchMedia', {
		configurable: true,
		writable: true,
		value: (query: string) => ({
			matches,
			media: query,
			onchange: null,
			addEventListener: () => {},
			removeEventListener: () => {},
			addListener: () => {},
			removeListener: () => {},
			dispatchEvent: () => false
		})
	});
}

describe('prefersReducedMotion', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	test('reflects a matching prefers-reduced-motion media query', () => {
		mockMatchMedia(true);
		expect(prefersReducedMotion()).toBe(true);
	});

	test('reflects a non-matching prefers-reduced-motion media query', () => {
		mockMatchMedia(false);
		expect(prefersReducedMotion()).toBe(false);
	});

	test('never throws when matchMedia is unavailable', () => {
		const original = window.matchMedia;
		// @ts-expect-error deliberately simulating an environment without matchMedia
		delete window.matchMedia;
		expect(() => prefersReducedMotion()).not.toThrow();
		expect(prefersReducedMotion()).toBe(false);
		window.matchMedia = original;
	});
});
