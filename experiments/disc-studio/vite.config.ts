import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { fileURLToPath } from 'node:url';
// A standalone entry to the SAME Svelte component; no CV import or workspace build.
export default defineConfig({
	root: fileURLToPath(new URL('.', import.meta.url)),
	base: './',
	plugins: [svelte({ configFile: false })],
	server: { host: '127.0.0.1', port: 5174, strictPort: true },
	build: { outDir: '../../artifacts/disc-studio-site', emptyOutDir: true }
});
