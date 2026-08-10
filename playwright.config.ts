import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
	testDir: 'tests/e2e',
	fullyParallel: true,
	use: {
		baseURL: 'http://127.0.0.1:5173',
		trace: 'on-first-retry'
	},
	webServer: {
		command: 'npm run dev -- --host 127.0.0.1',
		url: 'http://127.0.0.1:5173',
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
