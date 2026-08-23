import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [sveltekit()],
	// @chainspot/alg is an npm-workspace-linked CJS package (dist/ built by
	// tsc, no bundler — see packages/alg's own tsconfig for why). By default
	// Vite resolves the workspace symlink/junction to its real underlying
	// path (packages/alg/dist/...), which is OUTSIDE node_modules — so Vite
	// treats it as "your own source" rather than a normal dependency: no
	// CJS->ESM interop on the client (browser SyntaxError: "does not
	// provide an export named ..."), and the SSR module runner tries to
	// execute the compiled `exports.foo = ...` output directly instead of
	// handing it to Node's require() ("exports is not defined").
	// preserveSymlinks keeps the node_modules/@chainspot/alg path intact so
	// Vite treats it like any other npm dependency; ssr.external and
	// optimizeDeps.include then get the normal CJS-interop treatment on
	// both sides.
	resolve: {
		preserveSymlinks: true
	},
	ssr: {
		external: ['@chainspot/alg']
	},
	optimizeDeps: {
		include: ['@chainspot/alg']
	}
});
