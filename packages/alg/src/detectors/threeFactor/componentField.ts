import type { Mask } from './raster';
import type { BrightDarkMasks } from './raster';
import { extractComponents, type ComponentStats } from './components';

export type ComponentFieldPolarity = 'bright' | 'dark';

/**
 * One connected-component view of one binary raster class. Bright and dark
 * are configurations of this same object; consumers can retain the whole
 * coherent value instead of recomputing labels/components from a mask.
 */
export interface ComponentField {
	readonly config: { readonly polarity: ComponentFieldPolarity };
	readonly mask: Mask;
	readonly labels: Int32Array;
	readonly components: readonly ComponentStats[];
}

export interface BrightDarkComponentFields {
	readonly bright: ComponentField;
	readonly dark: ComponentField;
}

export const BRIGHT_COMPONENT_FIELD = { polarity: 'bright' } as const;
export const DARK_COMPONENT_FIELD = { polarity: 'dark' } as const;

/** Group an already-measured binary mask without changing mask/component math. */
export function groupComponentField(
	mask: Mask,
	config: { readonly polarity: ComponentFieldPolarity }
): ComponentField {
	const { labels, components } = extractComponents(mask);
	return { config, mask, labels, components };
}

/**
 * The minimal E/cache value for the existing shared HSV measurement: same
 * threshold outputs as computeBrightDarkMasks, now grouped into two instances
 * of one component-field object.
 */
export function groupBrightDarkComponentFields(masks: BrightDarkMasks): BrightDarkComponentFields {
	return {
		bright: groupComponentField(masks.bright, BRIGHT_COMPONENT_FIELD),
		dark: groupComponentField(masks.dark, DARK_COMPONENT_FIELD)
	};
}
