import type { StorybookConfig } from '@storybook/sveltekit';
import { materializeBadgeSpecimens } from './storybookBadgeSource.mjs';

const virtualId = 'virtual:e-badge-specimens';
const resolvedVirtualId = `\0${virtualId}`;

const config: StorybookConfig = {
	stories: ['../src/**/*.mdx', '../src/**/*.stories.@(js|ts|svelte)'],
	addons: ['@storybook/addon-docs'],
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
