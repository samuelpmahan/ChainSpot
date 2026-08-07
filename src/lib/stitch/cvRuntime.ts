/**
 * Isolation boundary for the OpenCV WASM runtime.
 *
 * `@techstark/opencv-js`'s UMD wrapper does `module.exports = factory()`, and
 * `factory()` immediately invokes the Emscripten-generated async module
 * function, so `require('@techstark/opencv-js')` (or a default import of it)
 * yields a genuine `Promise` — not a lazy factory, the actual in-flight
 * `Promise` object. That is what `scripts/probe-cv-match.mjs` relies on when
 * it does `import cvReady from '@techstark/opencv-js'; await cvReady`.
 *
 * That shape is fine under plain Node ESM (Node's CJS interop binds the
 * default export straight to `module.exports`) but breaks under Vite's SSR
 * module runner, which is what executes this file under vitest. The runner
 * wraps a required CJS module's exports in a `Proxy` so the namespace supports
 * live bindings. Wrapping a `Proxy` around a `Promise` is normally harmless,
 * but here the *value being awaited* (either `import('@techstark/opencv-js')`
 * or the namespace produced for this very module, once it re-exported the
 * promise-shaped value) resolves to that `Proxy`. V8's native
 * `Promise.prototype.then` checks an internal `[[PromiseState]]` slot on
 * `this`, and a `Proxy` around a `Promise` does not carry that slot — so
 * awaiting it throws `TypeError: Method Promise.prototype.then called on
 * incompatible receiver [object Module]`. This reproduces with nothing but
 * `await import('@techstark/opencv-js')` in a vitest test, i.e. it has nothing
 * to do with how `cvMatch.ts` calls into this module.
 *
 * The fix is to never let Vite's SSR runner touch the require of this package
 * on Node at all. `createRequire` goes straight to Node's own CJS loader,
 * bypassing Vite's transform/proxy layer entirely, so the returned value is
 * the raw `Promise` — identical to what the working probe script gets.
 *
 * In a browser or worker build there is no `createRequire`/`process`, and no
 * SSR runner either: Vite's client-side pipeline rewrites this CJS dependency
 * into real ESM at (pre-)bundle time (esbuild during dev's `optimizeDeps`,
 * Rollup's commonjs plugin in production) rather than proxying a live CJS
 * export, so a plain dynamic `import()` there never hits the Proxy/Promise
 * interaction above.
 *
 * Lazy loading is preserved either way because nothing imports *this* module
 * statically — the only reference is a dynamic `import('./cvRuntime')` inside
 * `cvMatch.ts` — and this file only touches the OpenCV package inside
 * `getCv()`, not at module scope, so the WASM payload is fetched on first use
 * rather than at startup.
 */

/** Resolves once the WASM runtime is initialized and the API is usable. */
export async function getCv(): Promise<unknown> {
	if (typeof process !== 'undefined' && process.versions?.node) {
		const { createRequire } = await import('node:module');
		const require = createRequire(import.meta.url);
		// Raw Node `require`, not Vite's SSR runner: returns the actual Promise
		// that `@techstark/opencv-js`'s factory() produced, unproxied.
		return await require('@techstark/opencv-js');
	}
	// Browser/worker: already real ESM by the time this runs, so the default
	// export is the same in-flight Promise, reached without ever going through
	// Vite's SSR CJS interop.
	const mod = (await import('@techstark/opencv-js')) as { default: unknown };
	return await mod.default;
}
