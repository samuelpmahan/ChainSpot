import adapter from '@sveltejs/adapter-static';

const routes = process.env.CHAINSPOT_ROUTES_DIR ?? 'src/routes';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	kit: {
		adapter: adapter(),
		files: { routes }
	}
};

export default config;
