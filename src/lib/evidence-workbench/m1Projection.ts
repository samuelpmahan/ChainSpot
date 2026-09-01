import type { M1WorkbenchComponent, M1WorkbenchLibrary, M1WorkbenchObject } from './badgeSpecimen';

export type M1Projection =
	'available' | 'explained' | 'unexplained' | 'components' | 'relationships' | 'consumers';

export const M1_PROJECTIONS: readonly M1Projection[] = [
	'available',
	'explained',
	'unexplained',
	'components',
	'relationships',
	'consumers'
];

export interface M1ProjectionImage {
	readonly width: number;
	readonly height: number;
	readonly x: number;
	readonly y: number;
	readonly rgba: Uint8ClampedArray;
}

const COLORS = {
	available: [250, 204, 21, 255],
	explained: [34, 197, 94, 255],
	unexplained: [220, 38, 38, 255],
	bright: [250, 250, 250, 255],
	dark: [23, 23, 23, 255],
	roles: [
		[59, 130, 246, 255],
		[249, 115, 22, 255],
		[168, 85, 247, 255],
		[20, 184, 166, 255]
	] as const
} as const;

function bboxForComponents(
	components: readonly M1WorkbenchComponent[]
): readonly [number, number, number, number] {
	if (!components.length) return [0, 0, 1, 1];
	const x0 = Math.min(...components.map((component) => component.bbox[0]));
	const y0 = Math.min(...components.map((component) => component.bbox[1]));
	const x1 = Math.max(...components.map((component) => component.bbox[0] + component.bbox[2]));
	const y1 = Math.max(...components.map((component) => component.bbox[1] + component.bbox[3]));
	return [x0, y0, x1 - x0, y1 - y0];
}

function putPixels(
	out: Uint8ClampedArray,
	pixels: readonly number[],
	rasterWidth: number,
	bbox: readonly [number, number, number, number],
	color: readonly number[]
): void {
	for (const pixel of pixels) {
		const x = pixel % rasterWidth;
		const y = (pixel - x) / rasterWidth;
		if (x < bbox[0] || y < bbox[1] || x >= bbox[0] + bbox[2] || y >= bbox[1] + bbox[3]) continue;
		const offset = ((y - bbox[1]) * bbox[2] + x - bbox[0]) * 4;
		out.set(color, offset);
	}
}

function objectComponents(
	library: M1WorkbenchLibrary,
	object: M1WorkbenchObject
): readonly M1WorkbenchComponent[] {
	const byId = new Map(library.components.map((component) => [component.id, component]));
	return object.componentUses.flatMap((use) => {
		const component = byId.get(use.componentId);
		return component ? [component] : [];
	});
}

/** Story canvas and CI PNG generation share this exact Args-driven projection. */
export function projectM1Image(
	library: M1WorkbenchLibrary,
	subjectId: string,
	projection: M1Projection
): M1ProjectionImage {
	const component = library.components.find((value) => value.id === subjectId);
	const object = library.objects.find((value) => value.id === subjectId);
	if (!component && !object) throw new Error(`M1 subject '${subjectId}' does not exist in E`);
	const components = component ? [component] : objectComponents(library, object!);
	const bbox = component ? component.bbox : bboxForComponents(components);
	const out = new Uint8ClampedArray(bbox[2] * bbox[3] * 4);
	if (component) {
		putPixels(
			out,
			component.pixels,
			library.raster.width,
			bbox,
			component.polarity === 'bright' ? COLORS.bright : COLORS.dark
		);
		return { width: bbox[2], height: bbox[3], x: bbox[0], y: bbox[1], rgba: out };
	}
	if (object!.accounting.status !== 'known')
		return { width: bbox[2], height: bbox[3], x: bbox[0], y: bbox[1], rgba: out };
	if (projection === 'available' || projection === 'explained' || projection === 'unexplained') {
		putPixels(
			out,
			object!.accounting[`${projection}Pixels`],
			library.raster.width,
			bbox,
			COLORS[projection]
		);
	} else {
		components.forEach((value, index) =>
			putPixels(
				out,
				value.pixels,
				library.raster.width,
				bbox,
				COLORS.roles[index % COLORS.roles.length]
			)
		);
	}
	return { width: bbox[2], height: bbox[3], x: bbox[0], y: bbox[1], rgba: out };
}
