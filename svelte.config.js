import adapter from '@sveltejs/adapter-static';

const routes = process.env.CHAINSPOT_ROUTES_DIR ?? 'src/routes';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	kit: {
		outDir: process.env.CHAINSPOT_SURFACE === 'staging' ? '.svelte-kit-lab' : '.svelte-kit',
		adapter: adapter(),
		files: { routes, assets: process.env.CHAINSPOT_ASSETS_DIR ?? 'static' }
	}
};

export default config;
