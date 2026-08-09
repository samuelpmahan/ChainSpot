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
 * default export straight to `module.exports`) but breaks under two other
 * module runners, for related but distinct reasons:
 *
 * 1. Vite's SSR module runner (what executes this file under vitest) wraps a
 *    required CJS module's exports in a `Proxy` so the namespace supports
 *    live bindings. Wrapping a `Proxy` around a `Promise` is normally
 *    harmless, but the *value being awaited* resolves to that `Proxy`, and
 *    V8's native `Promise.prototype.then` checks an internal `[[PromiseState]]`
 *    slot on `this` that a `Proxy` around a `Promise` does not carry — so
 *    awaiting it throws `TypeError: Method Promise.prototype.then called on
 *    incompatible receiver`. This is triggered by evaluating *any* import of
 *    the package under the SSR runner, static or dynamic — confirmed by
 *    trying a static top-level import here, which broke vitest even though
 *    the Node branch below never executes it.
 *
 * 2. The production Web Worker bundle (built by esbuild, not Rollup, unlike
 *    the main SvelteKit app/SSR bundles) hits a different but same-shaped
 *    bug when *dynamically* importing this package. esbuild's CJS-interop
 *    helper synthesizes the ESM namespace object via
 *    `Object.create(Object.getPrototypeOf(mod))` so the namespace preserves
 *    `instanceof`/inherited-method behaviour for exotic CJS exports. Because
 *    `module.exports` here *is* a `Promise` instance, its prototype is
 *    `Promise.prototype` — so the synthesized namespace object also inherits
 *    `Promise.prototype`, making it look "thenable" (it has a `.then` via the
 *    prototype chain) without being a real `Promise` (no `[[PromiseState]]`
 *    slot). The dynamic `import()`'s own promise-resolution machinery sees
 *    that namespace object, treats it as a thenable, and calls `.then()` on
 *    it internally to adopt its state — which throws the exact same
 *    "incompatible receiver" error, this time from inside the bundler's own
 *    interop code rather than anything `getCv()` does. Confirmed empirically
 *    by inspecting the built worker bundle: the throw happens before
 *    `getCv()`'s own code ever runs. A *static* import of the package does
 *    not go through this dynamic-import interop path and sidesteps the bug
 *    (confirmed against the actual built worker bundle in a real browser).
 *
 * Since a static import breaks (1) and a dynamic import breaks (2), and both
 * runners execute *this* file, the static import is isolated in
 * `cvRuntimeBrowser.ts` and reached only via a dynamic `import()` of that
 * (real-ESM, not CJS) module from the browser branch below. The Node branch
 * returns before that dynamic import happens, so vitest's SSR runner never
 * loads `cvRuntimeBrowser.ts` and never hits bug (1); dynamically importing
 * our own already-real-ESM module never hits bug (2), because it isn't a CJS
 * package needing bundler interop synthesis.
 *
 * Lazy loading is preserved throughout because nothing imports *this* module
 * statically either — the only reference is a dynamic `import('./cvRuntime')`
 * inside `cvMatch.ts` — so the WASM payload is only fetched once `getCv()`
 * actually runs, not at app/worker startup.
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
	const { default: cvReady } = await import('./cvRuntimeBrowser');
	return await cvReady;
}
