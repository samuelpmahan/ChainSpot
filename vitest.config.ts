import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	resolve: {
		alias: {
			$lib: fileURLToPath(new URL('./src/lib', import.meta.url)),
			// @chainspot/alg's package exports point at packages/alg/dist, so
			// without this a test silently runs the LAST BUILD, not the source
			// you just edited -- you have to remember `npm run build --workspace
			// @chainspot/alg` or you get stale results with no error. Alias the
			// tests straight at src so edit-then-test is always honest.
			// Longest specifier first: '@chainspot/alg' alone would otherwise
			// shadow every subpath.
			'@chainspot/alg/': fileURLToPath(new URL('./packages/alg/src/', import.meta.url)),
			'@chainspot/alg': fileURLToPath(new URL('./packages/alg/src/index.ts', import.meta.url))
		}
	},
	test: {
		environment: 'node',
		include: ['tests/unit/**/*.test.ts']
	}
});
