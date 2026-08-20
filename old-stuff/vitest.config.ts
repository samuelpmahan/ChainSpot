import { fileURLToPath } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	plugins: [svelte()],
	resolve: {
		conditions: ['browser'],
		alias: {
			$lib: fileURLToPath(new URL('./src/lib', import.meta.url)),
			'$app/navigation': fileURLToPath(new URL('./tests/mocks/appNavigation.ts', import.meta.url)),
			'$app/paths': fileURLToPath(new URL('./tests/mocks/appPaths.ts', import.meta.url)),
			'$env/dynamic/public': fileURLToPath(new URL('./tests/mocks/envDynamicPublic.ts', import.meta.url))
		}
	},
	test: {
		environment: 'node',
		include: ['tests/**/*.test.ts'],
		setupFiles: ['./tests/setup.ts']
	}
});
