import type { CompositeResult } from '../../../../g0/composite';
import { extractComponents } from '../../../../detectors/threeFactor/components';
import { opencvSaturation } from '../../../../detectors/threeFactor/raster';
import { pxFn, pxKey, type PxC, type PxKey } from '../../../../exec/board';
import { S0_CROPPED_IMAGE_ADDRESS } from '../../../S0/clean';

/** Shared mask calculations; execution order and arguments live in Stage YAML. */
const ROOT = 'px.s1.exp.maskComponents.part.' as const;
function partKey<T>(address: PartAddress): PxKey<T> & { readonly address: PartAddress } {
	return { ...pxKey<T>(address), address };
}
export const MaskComponentsPxC = {
	croppedRaster: partKey<RasterPart>(`${ROOT}croppedRaster`),
	blackMask: partKey<MaskPart>(`${ROOT}blackMask`),
	blackComponents: partKey<ComponentSetPart>(`${ROOT}blackComponents`),
	whiteMask: partKey<MaskPart>(`${ROOT}whiteMask`),
	whiteComponents: partKey<ComponentSetPart>(`${ROOT}whiteComponents`),
} as const;

type Polarity = 'black' | 'white';
type PartAddress = `px.s1.exp.maskComponents.part.${string}`;
type PartKind = 'cropped-raster' | 'mask' | 'component-set' | 'component';

interface PartBase {
	readonly id: string;
	readonly address: PartAddress;
	readonly kind: PartKind;
	readonly widthPx: number;
	readonly heightPx: number;
	/** Every raster-derived Part shares S0 CroppedImage coordinates. */
	readonly coordinateFrameId: typeof S0_CROPPED_IMAGE_ADDRESS;
	readonly sourceTickId: string | null;
}

export interface RasterPart extends PartBase {
	readonly id: 'cropped-raster';
	readonly kind: 'cropped-raster';
	readonly pixels: Uint8ClampedArray;
	readonly pixelFormat: 'rgba-8';
	readonly sourceAddress: typeof S0_CROPPED_IMAGE_ADDRESS;
}
export interface MaskPart extends PartBase {
	readonly id: `${Polarity}-mask`;
	readonly kind: 'mask';
	readonly polarity: Polarity;
	/** Exact row-major 0/1 membership. */
	readonly pixels: Uint8Array;
}
export interface ComponentPart extends PartBase {
	readonly id: `${Polarity}-component-${number}`;
	readonly kind: 'component';
	readonly polarity: Polarity;
	readonly label: number;
	/** Exact row-major pixel indexes, as a view into its set's table. */
	readonly pixels: Uint32Array;
}
export interface ComponentSetPart extends PartBase {
	readonly id: `${Polarity}-components`;
	readonly kind: 'component-set';
	readonly polarity: Polarity;
	/** All member indexes, contiguous and ascending within each label. */
	readonly pixels: Uint32Array;
	readonly components: readonly ComponentPart[];
}
export type MaskComponentsPart = RasterPart | MaskPart | ComponentPart | ComponentSetPart;
interface SelectMaskArgs { readonly raster: RasterPart; readonly polarity: Polarity; readonly valueMax?: number; readonly valueMin?: number; readonly saturationMax?: number; readonly alpha: 'ignored'; }
interface GroupComponentsArgs { readonly mask: MaskPart; readonly connectivity: 8; readonly retainSingletons: true; }
export const MaskComponentsFn = {
	selectHsvMask: pxFn<SelectMaskArgs, MaskPart>('fn.s1.exp.maskComponents.selectHsvMask'),
	group8Connected: pxFn<GroupComponentsArgs, ComponentSetPart>('fn.s1.exp.maskComponents.group8Connected')
} as const;

function address(id: string): PartAddress {
	const aliases: Record<string, string> = {
		'cropped-raster': 'croppedRaster', 'black-mask': 'blackMask', 'white-mask': 'whiteMask',
		'black-components': 'blackComponents', 'white-components': 'whiteComponents'
	};
	return `${ROOT}${aliases[id] ?? id.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())}`;
}

function selectMask(args: SelectMaskArgs): MaskPart {
	const { raster, polarity } = args;
	const pixels = new Uint8Array(raster.widthPx * raster.heightPx);
	for (let index = 0, rgba = 0; index < pixels.length; index++, rgba += 4) {
		const r = raster.pixels[rgba], g = raster.pixels[rgba + 1], b = raster.pixels[rgba + 2];
		const value = Math.max(r, g, b);
		pixels[index] = polarity === 'black'
			? Number(value <= args.valueMax!)
			: Number(value >= args.valueMin! && opencvSaturation(r, g, b) <= args.saturationMax!);
	}
	const id = `${polarity}-mask` as const;
	return { id, address: address(id), kind: 'mask', polarity, widthPx: raster.widthPx, heightPx: raster.heightPx,
		coordinateFrameId: S0_CROPPED_IMAGE_ADDRESS, pixels, sourceTickId: null };
}

/** Uses the known-good 8-connected labels and restores all labels, including singleton stats omissions. */
function group8Connected({ mask, connectivity, retainSingletons }: GroupComponentsArgs): ComponentSetPart {
	if (connectivity !== 8 || !retainSingletons) throw new Error('S1 exp mask-components only declares known-good 8-connected singleton-retaining grouping.');
	const { labels } = extractComponents({ width: mask.widthPx, height: mask.heightPx, data: mask.pixels });
	const groups = new Map<number, number[]>();
	for (let index = 0; index < labels.length; index++) {
		const label = labels[index];
		if (!label) continue;
		const group = groups.get(label) ?? [];
		group.push(index);
		groups.set(label, group);
	}
	const ordered = [...groups.entries()].sort(([left], [right]) => left - right);
	const pixels = Uint32Array.from(ordered.flatMap(([, members]) => members));
	let offset = 0;
	const components = ordered.map(([label, members]) => {
		const id = `${mask.polarity}-component-${label}` as const;
		const component: ComponentPart = { id, address: address(id), kind: 'component', polarity: mask.polarity, label,
			widthPx: mask.widthPx, heightPx: mask.heightPx, coordinateFrameId: S0_CROPPED_IMAGE_ADDRESS,
			pixels: pixels.subarray(offset, offset + members.length), sourceTickId: null };
		offset += members.length;
		return component;
	});
	const id = `${mask.polarity}-components` as const;
	return { id, address: address(id), kind: 'component-set', polarity: mask.polarity, widthPx: mask.widthPx, heightPx: mask.heightPx,
		coordinateFrameId: S0_CROPPED_IMAGE_ADDRESS, pixels, components, sourceTickId: null };
}

function seedWarmRaster(pxc: PxC): RasterPart {
	const cropped = pxc.get<CompositeResult>(S0_CROPPED_IMAGE_ADDRESS);
	const raster: RasterPart = { id: 'cropped-raster', address: MaskComponentsPxC.croppedRaster.address, kind: 'cropped-raster',
		widthPx: cropped.widthPx, heightPx: cropped.heightPx, coordinateFrameId: S0_CROPPED_IMAGE_ADDRESS, pixels: cropped.rgba,
		pixelFormat: 'rgba-8', sourceAddress: S0_CROPPED_IMAGE_ADDRESS, sourceTickId: null };
	pxc.set(MaskComponentsPxC.croppedRaster, raster);
	return raster;
}

/** Warm raster adapter and registration only; invokes no Calculations. */
export function prepareMaskComponentsExp(pxc: PxC): void {
	seedWarmRaster(pxc);
	pxc.register(MaskComponentsFn.selectHsvMask, selectMask);
	pxc.register(MaskComponentsFn.group8Connected, group8Connected);
}
