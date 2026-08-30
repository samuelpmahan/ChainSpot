import type { ComponentStats } from './components';

export type RasterPolarity = 'bright' | 'dark';
export type RasterBbox = readonly [number, number, number, number];

export interface RasterComponentRef {
	readonly polarity: RasterPolarity;
	readonly label: number;
	readonly bbox: RasterBbox;
	readonly area: number;
}

export interface ComponentAssembly {
	readonly status: 'assembled';
	readonly components: readonly RasterComponentRef[];
	/** The component whose own connected perimeter is the object's visible outer perimeter. */
	readonly outerComponent: RasterComponentRef;
	/** Union of the owned components; derived once, never detector/fitted geometry. */
	readonly bbox: RasterBbox;
}

export interface ComponentAssemblyFailure {
	readonly status: 'failed';
	readonly reason: string;
	readonly seedBbox: RasterBbox;
}

export type ComponentAssemblyResult = ComponentAssembly | ComponentAssemblyFailure;
export type BasketShellMargins = readonly [left: number, top: number, right: number, bottom: number];

function bboxOf(component: ComponentStats, yOffsetPx = 0): RasterBbox {
	return [component.bboxX, component.bboxY + yOffsetPx, component.bboxW, component.bboxH];
}

export function componentRef(
	polarity: RasterPolarity,
	component: ComponentStats,
	yOffsetPx = 0
): RasterComponentRef {
	return { polarity, label: component.label, bbox: bboxOf(component, yOffsetPx), area: component.area };
}

export function containsBbox(outer: RasterBbox, inner: RasterBbox): boolean {
	return (
		outer[0] <= inner[0] &&
		outer[1] <= inner[1] &&
		outer[0] + outer[2] >= inner[0] + inner[2] &&
		outer[1] + outer[3] >= inner[1] + inner[3]
	);
}

export function unionBbox(parts: readonly RasterBbox[]): RasterBbox {
	if (!parts.length) throw new Error('component assembly requires at least one component');
	const x0 = Math.min(...parts.map((bbox) => bbox[0]));
	const y0 = Math.min(...parts.map((bbox) => bbox[1]));
	const x1 = Math.max(...parts.map((bbox) => bbox[0] + bbox[2]));
	const y1 = Math.max(...parts.map((bbox) => bbox[1] + bbox[3]));
	return [x0, y0, x1 - x0, y1 - y0];
}

function merge(parts: readonly RasterComponentRef[], outerComponent: RasterComponentRef): ComponentAssembly {
	return {
		status: 'assembled',
		components: parts,
		outerComponent,
		bbox: unionBbox(parts.map((part) => part.bbox))
	};
}

/**
 * V1 badge assembly: the detector's accepted bright badge-family component is
 * already the white outside. Own the largest contained dark component as the
 * plate, plus all bright components contained by that plate (glyphs).
 * Ambiguous/overlapped outer-white recovery is deliberately not rescued here.
 */
export function assembleBadgeV1(
	outerBright: ComponentStats,
	brightComponents: readonly ComponentStats[],
	darkComponents: readonly ComponentStats[],
	yOffsetPx = 0
): ComponentAssemblyResult {
	const seed = componentRef('bright', outerBright, yOffsetPx);
	const darkChildren = darkComponents
		.filter((component) => containsBbox(bboxOf(outerBright), bboxOf(component)))
		.sort((a, b) => b.area - a.area || a.label - b.label);
	if (!darkChildren.length) return { status: 'failed', reason: 'no contained dark plate component', seedBbox: seed.bbox };
	if (darkChildren.length > 1 && darkChildren[0].area === darkChildren[1].area)
		return { status: 'failed', reason: 'ambiguous contained dark plate components', seedBbox: seed.bbox };
	const plate = darkChildren[0];
	const plateBbox = bboxOf(plate);
	const glyphs = brightComponents.filter(
		(component) => component.label !== outerBright.label && containsBbox(plateBbox, bboxOf(component))
	);
	const outer = seed;
	return merge(
		[outer, componentRef('dark', plate, yOffsetPx), ...glyphs.map((component) => componentRef('bright', component, yOffsetPx))],
		outer
	);
}

export function basketShellMargins(outerDark: ComponentStats, whiteBody: ComponentStats): BasketShellMargins {
	return [
		whiteBody.bboxX - outerDark.bboxX,
		whiteBody.bboxY - outerDark.bboxY,
		outerDark.bboxX + outerDark.bboxW - (whiteBody.bboxX + whiteBody.bboxW),
		outerDark.bboxY + outerDark.bboxH - (whiteBody.bboxY + whiteBody.bboxH)
	];
}

function smallestEnclosingDark(
	whiteBody: ComponentStats,
	darkComponents: readonly ComponentStats[]
): ComponentStats | null {
	const body = bboxOf(whiteBody);
	const candidates = darkComponents
		.filter((component) => containsBbox(bboxOf(component), body))
		.sort(
			(a, b) =>
				a.bboxW * a.bboxH - b.bboxW * b.bboxH ||
				b.area - a.area ||
				a.label - b.label
		);
	return candidates[0] ?? null;
}

/** Exact modal component geometry, no tolerance. Fused shells become V1 failures. */
export function learnBasketShellFamilyV1(
	whiteBodies: readonly ComponentStats[],
	darkComponents: readonly ComponentStats[]
): BasketShellMargins | null {
	const counts = new Map<string, { margins: BasketShellMargins; count: number }>();
	for (const body of whiteBodies) {
		const shell = smallestEnclosingDark(body, darkComponents);
		if (!shell) continue;
		const margins = basketShellMargins(shell, body);
		const key = margins.join(',');
		const prior = counts.get(key);
		counts.set(key, { margins, count: (prior?.count ?? 0) + 1 });
	}
	const ranked = [...counts.values()].sort((a, b) => b.count - a.count || a.margins.join(',').localeCompare(b.margins.join(',')));
	if (!ranked.length) return null;
	if (ranked.length > 1 && ranked[0].count === ranked[1].count) return null;
	return ranked[0].margins;
}

export function assembleBasketV1(
	whiteBody: ComponentStats,
	darkComponents: readonly ComponentStats[],
	intactFamily: BasketShellMargins,
	yOffsetPx = 0
): ComponentAssemblyResult {
	const body = componentRef('bright', whiteBody, yOffsetPx);
	const shell = smallestEnclosingDark(whiteBody, darkComponents);
	if (!shell) return { status: 'failed', reason: 'no enclosing dark shell component', seedBbox: body.bbox };
	const margins = basketShellMargins(shell, whiteBody);
	if (margins.some((value, index) => value !== intactFamily[index])) {
		return {
			status: 'failed',
			reason: `outer dark shell component is fused/nonmodal: margins=${margins.join(',')} intactFamily=${intactFamily.join(',')}`,
			seedBbox: body.bbox
		};
	}
	const outer = componentRef('dark', shell, yOffsetPx);
	return merge([body, outer], outer);
}

/** V1 intact tee: the enclosing bright component is already the white outside. */
export function assembleTeeV1(outerBright: ComponentStats, yOffsetPx = 0): ComponentAssembly {
	const outer = componentRef('bright', outerBright, yOffsetPx);
	return merge([outer], outer);
}

export interface ComponentRasterEvidence {
	readonly width: number;
	readonly height: number;
	readonly topPx: number;
	readonly brightLabels: Int32Array;
	readonly darkLabels: Int32Array;
}

export interface MaterializedComponentAssembly extends ComponentAssembly {
	/** Original-image raster width used to decode packed pixel indices. */
	readonly rasterWidth: number;
	/** Exact union of every owned connected-component pixel, packed as y*width+x. */
	readonly ownedPixels: Uint32Array;
	/** Boundary pixels of the exact owned union, packed in the same frame. */
	readonly perimeterPixels: Uint32Array;
}

/**
 * Materialize an already-decided component union into self-contained physical
 * ownership. No thresholding, dilation, filling, fitting, or component search
 * occurs here: labels are only dereferenced for the component refs acquisition
 * already selected.
 */
export function materializeComponentAssembly(
	assembly: ComponentAssembly,
	raster: ComponentRasterEvidence
): MaterializedComponentAssembly {
	const { width, height, topPx, brightLabels, darkLabels } = raster;
	if (brightLabels.length !== width * height || darkLabels.length !== width * height)
		throw new Error('component assembly label rasters do not match declared dimensions');
	const ownedLocal = new Set<number>();
	for (const part of assembly.components) {
		const labels = part.polarity === 'bright' ? brightLabels : darkLabels;
		const [x, originalY, w, h] = part.bbox;
		const localY = originalY - topPx;
		for (let yy = Math.max(0, localY); yy < Math.min(height, localY + h); yy++) {
			const row = yy * width;
			for (let xx = Math.max(0, x); xx < Math.min(width, x + w); xx++) {
				const index = row + xx;
				if (labels[index] === part.label) ownedLocal.add(index);
			}
		}
	}
	if (!ownedLocal.size) throw new Error('component assembly selected no raster pixels');

	const ownedLocalSorted = [...ownedLocal].sort((a, b) => a - b);
	const ownedPixels = new Uint32Array(ownedLocalSorted.length);
	let minX = width;
	let minY = height + topPx;
	let maxX = -1;
	let maxY = -1;
	for (let i = 0; i < ownedLocalSorted.length; i++) {
		const local = ownedLocalSorted[i];
		const x = local % width;
		const localY = (local - x) / width;
		const y = localY + topPx;
		ownedPixels[i] = y * width + x;
		if (x < minX) minX = x;
		if (x > maxX) maxX = x;
		if (y < minY) minY = y;
		if (y > maxY) maxY = y;
	}

	const perimeter: number[] = [];
	for (const local of ownedLocalSorted) {
		const x = local % width;
		const y = (local - x) / width;
		const exposed =
			x === 0 ||
			x === width - 1 ||
			y === 0 ||
			y === height - 1 ||
			!ownedLocal.has(local - 1) ||
			!ownedLocal.has(local + 1) ||
			!ownedLocal.has(local - width) ||
			!ownedLocal.has(local + width);
		if (exposed) perimeter.push((y + topPx) * width + x);
	}

	return {
		...assembly,
		bbox: [minX, minY, maxX - minX + 1, maxY - minY + 1],
		rasterWidth: width,
		ownedPixels,
		perimeterPixels: Uint32Array.from(perimeter)
	};
}
