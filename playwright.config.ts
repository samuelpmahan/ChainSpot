import { defineConfig, devices } from '@playwright/test';

// PW_PORT lets a second checkout run the suite on a private port instead of
// colliding with (or silently reusing, via reuseExistingServer) another dev
// server already on 5173. Unset = today's exact behavior.
const port = process.env.PW_PORT ?? '5173';
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
	testDir: 'tests/e2e',
	fullyParallel: true,
	use: {
		baseURL,
		trace: 'on-first-retry'
	},
	webServer: {
		command: `npm run dev -- --host 127.0.0.1 --port ${port}`,
		url: baseURL,
		reuseExistingServer: !process.env.CI
	},
	projects: [
		{
			name: 'chromium',
			use: {
				...devices['Desktop Chrome'],
				// Sandboxed/CI environments can provide their own Chromium build
				// instead of the exact revision this Playwright version pins.
				...(process.env.PW_CHROMIUM_PATH
					? { launchOptions: { executablePath: process.env.PW_CHROMIUM_PATH } }
					: {})
			}
		}
	]
});
