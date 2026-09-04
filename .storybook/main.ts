import type { StorybookConfig } from '@storybook/sveltekit';
import { materializeBadgeSpecimens } from '../src/lib/server/evidence-workbench/materializeBadgeSpecimens.mjs';

const virtualId = 'virtual:e-badge-specimens';
const resolvedVirtualId = `\0${virtualId}`;

const config: StorybookConfig = {
	staticDirs: ['../artifacts'],
	stories: ['../src/**/*.mdx', '../src/**/*.stories.@(js|ts|svelte)'],
	addons: ['@storybook/addon-docs', '@storybook/addon-vitest'],
	framework: {
		name: '@storybook/sveltekit',
		options: {}
	},
	async viteFinal(viteConfig) {
		viteConfig.plugins ??= [];
		viteConfig.plugins.push({
			name: 'chainspot-e-badge-specimens',
			resolveId(id) {
				return id === virtualId ? resolvedVirtualId : undefined;
			},
			async load(id) {
				if (id !== resolvedVirtualId) return undefined;
				const library = await materializeBadgeSpecimens();
				return `export const badgeSpecimenLibrary = ${JSON.stringify(library)};`;
			}
		});
		return viteConfig;
	}
};

export default config;
