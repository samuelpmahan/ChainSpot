import { describe, expect, it } from 'vitest';
import { toPlainSourcePoint } from '../../src/lib/autoAnnotation/corridorBendDetectionCapsuleWorker';

/**
 * Regression test for a real bug caught only by live-browser verification
 * (jsdom has no real `Worker`/structured-clone, so no automated test could
 * have caught this otherwise): `detectCorridorBendsCapsuleInWorker` used to
 * pass `teeSrcPx`/`basketSrcPx`/`badgeSrcPx` straight through to
 * `worker.postMessage(...)`. In production those points are read off a live
 * Svelte 5 `$state` array (`holes`/`numberBadges`), which wraps them in
 * reactivity Proxies -- and a Proxy fails `postMessage`'s structured-clone
 * algorithm with `DataCloneError`, thrown synchronously inside the Promise
 * executor. That silently rejected every real detection call site
 * `corridorBendDetectionCapsuleWorker.ts`'s own outer `try/catch` (in
 * `detectAndApplyCorridorBendsCapsuleAsync`) swallows, so the entire
 * worker-based detector would have returned zero bends for every hole,
 * every time, in the actual app -- while every existing unit/integration
 * test kept passing, since none of them exercise real reactive `$state`
 * objects flowing into a real `Worker`. `toPlainSourcePoint` is the fix;
 * this test proves it actually produces a clonable value, using Node's own
 * `structuredClone` (the same algorithm `postMessage` uses) as the oracle,
 * not just a shape-based assertion that could pass while the real bug
 * persists.
 */
describe('toPlainSourcePoint', () => {
	it('a Proxy-wrapped point (same failure shape as a Svelte $state read) fails structuredClone directly', () => {
		const target = { xPx: 10, yPx: 20 };
		const proxied = new Proxy(target, {});
		// Sanity check that this test's premise is real, not vacuous: a bare
		// Proxy over a plain object is exactly the kind of value that fails
		// the structured-clone algorithm postMessage uses.
		expect(() => structuredClone(proxied)).toThrow();
	});

	it('toPlainSourcePoint strips the Proxy so the result survives structuredClone', () => {
		const target = { xPx: 10, yPx: 20 };
		const proxied = new Proxy(target, {});
		const plain = toPlainSourcePoint(proxied);
		expect(() => structuredClone(plain)).not.toThrow();
		expect(structuredClone(plain)).toEqual({ xPx: 10, yPx: 20 });
	});

	it('is a genuine copy, not the same reference', () => {
		const original = { xPx: 5, yPx: 6 };
		const copy = toPlainSourcePoint(original);
		expect(copy).toEqual(original);
		expect(copy).not.toBe(original);
	});
});
