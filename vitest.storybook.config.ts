import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { playwright } from '@vitest/browser-playwright';
import { storybookTest } from '@storybook/addon-vitest/vitest-plugin';
import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config';

const dirname = path.dirname(fileURLToPath(import.meta.url));
process.env.PLAYWRIGHT_BROWSERS_PATH ??= path.join(dirname, '.playwright-browsers');

export default mergeConfig(
	viteConfig,
	defineConfig({
		plugins: [
			storybookTest({
				configDir: path.join(dirname, '.storybook'),
				storybookScript: 'npm run storybook -- --no-open'
			})
		],
		test: {
			browser: {
				enabled: true,
				provider: playwright({}),
				headless: true,
				instances: [{ browser: 'chromium' }]
			},
			setupFiles: ['./.storybook/vitest.setup.ts']
		}
	})
);
