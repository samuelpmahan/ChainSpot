import { defineConfig } from 'vitest/config';
export default defineConfig({
	test: { include: ['tests/disc-studio/**/*.test.ts'], environment: 'node' }
});
