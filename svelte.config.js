import adapter from '@sveltejs/adapter-static';

// Set by the GitHub Pages workflow to the repo name (e.g. "/ChainSpot") so
// asset and route URLs resolve correctly under a project-pages subpath.
// Unset for local dev/build, where the app is served from the domain root.
const base = process.env.BASE_PATH ?? '';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	kit: {
		adapter: adapter(),
		paths: {
			base
		}
	}
};

export default config;
