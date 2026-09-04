import type { CompositeResult } from '../g0/composite';
import type { BrightDarkComponentFields } from '../detectors/threeFactor/componentField';
import type { Mask } from '../detectors/threeFactor/raster';
import { pxKey } from '../exec/board';

export interface BrightDarkMasks {
	readonly bright: Mask;
	readonly dark: Mask;
}

/** Generic raster/component substrate shared by object Stages. */
export const ComponentPxC = {
	image: pxKey<CompositeResult>('px.image.cropped'),
	masks: pxKey<BrightDarkMasks>('px.components.masks'),
	fields: pxKey<BrightDarkComponentFields>('px.components')
} as const;
