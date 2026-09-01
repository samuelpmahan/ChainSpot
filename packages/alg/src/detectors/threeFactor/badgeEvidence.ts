import type { MaterializedComponentAssembly, RasterComponentRef } from './componentAssembly';
import type { BrightDarkComponentFields } from './componentField';
import type { BadgeEvidence, RgbaImage } from './types';

export const BADGE_MATERIALIZED_EVIDENCE_SCHEMA = 'chainspot.badge-evidence/v1' as const;

export interface BadgeEvidenceProvenance {
	readonly imageId: string;
	readonly paramsHash: string;
	readonly detector: string;
	readonly detectorVersion: string;
}

export interface MaterializedBadgeEvidence {
	readonly schema: typeof BADGE_MATERIALIZED_EVIDENCE_SCHEMA;
	readonly id: string;
	readonly provenance: BadgeEvidenceProvenance;
	readonly badge: BadgeEvidence;
	readonly raster: { readonly width: number; readonly height: number };
	readonly region: {
		readonly bbox: readonly [number, number, number, number];
		readonly rgba: Uint8Array;
		readonly brightMask: Uint8Array;
		readonly darkMask: Uint8Array;
		readonly brightLabels: Int32Array;
		readonly darkLabels: Int32Array;
	};
	readonly components: readonly RasterComponentRef[];
	readonly ownedBwPixels: Uint32Array;
	readonly aaPixels: Uint32Array;
	readonly residuePixels: Uint32Array;
	readonly measurements: {
		readonly bwOwnedPixelCount: number;
		readonly aaAddedPixelCount: number;
		readonly residueBefore: number;
		readonly residueAfter: number;
	};
}

function cropBbox(
	bbox: readonly [number, number, number, number],
	width: number,
	height: number
): readonly [number, number, number, number] {
	const x0 = Math.max(0, bbox[0] - 1);
	const y0 = Math.max(0, bbox[1] - 1);
	const x1 = Math.min(width, bbox[0] + bbox[2] + 1);
	const y1 = Math.min(height, bbox[1] + bbox[3] + 1);
	return [x0, y0, x1 - x0, y1 - y0];
}

function cropBytes(
	source: ArrayLike<number>,
	rasterWidth: number,
	bbox: readonly [number, number, number, number],
	channels = 1
): Uint8Array {
	const [x0, y0, width, height] = bbox;
	const out = new Uint8Array(width * height * channels);
	let target = 0;
	for (let y = y0; y < y0 + height; y++) {
		const start = (y * rasterWidth + x0) * channels;
		for (let offset = 0; offset < width * channels; offset++)
			out[target++] = source[start + offset] ?? 0;
	}
	return out;
}

function cropLabels(
	source: Int32Array,
	rasterWidth: number,
	bbox: readonly [number, number, number, number]
): Int32Array {
	const [x0, y0, width, height] = bbox;
	const out = new Int32Array(width * height);
	let target = 0;
	for (let y = y0; y < y0 + height; y++) {
		const start = y * rasterWidth + x0;
		for (let offset = 0; offset < width; offset++) out[target++] = source[start + offset];
	}
	return out;
}

function sorted(values: Iterable<number>): Uint32Array {
	return Uint32Array.from([...values].sort((a, b) => a - b));
}

/**
 * Refine exact B+W component ownership with the deliberately naive AA floor.
 * This consumes measurements already made by G1/object acquisition; it never
 * thresholds, labels, selects components, or consults truth.
 */
export function materializeBadgeEvidence(
	image: RgbaImage,
	fields: BrightDarkComponentFields,
	badge: BadgeEvidence,
	assembly: MaterializedComponentAssembly,
	provenance: BadgeEvidenceProvenance
): MaterializedBadgeEvidence {
	if (image.data.length !== image.width * image.height * 4)
		throw new Error('badge evidence source RGBA does not match declared dimensions');
	for (const field of [fields.bright, fields.dark]) {
		if (field.mask.width !== image.width || field.mask.height !== image.height)
			throw new Error('badge evidence component-field mask dimensions do not match source');
		if (field.labels.length !== image.width * image.height)
			throw new Error('badge evidence component-field labels do not match source dimensions');
	}
	if (assembly.rasterWidth !== image.width)
		throw new Error('badge evidence ownership raster width does not match source');

	const owned = new Set<number>(assembly.ownedPixels);
	const aa = new Set<number>();
	for (const pixel of assembly.perimeterPixels) {
		const x = pixel % image.width;
		const y = (pixel - x) / image.width;
		for (let dy = -1; dy <= 1; dy++) {
			for (let dx = -1; dx <= 1; dx++) {
				if (dx === 0 && dy === 0) continue;
				const xx = x + dx;
				const yy = y + dy;
				if (xx < 0 || yy < 0 || xx >= image.width || yy >= image.height) continue;
				const neighbor = yy * image.width + xx;
				if (owned.has(neighbor)) continue;
				if (fields.bright.mask.data[neighbor] || fields.dark.mask.data[neighbor]) continue;
				aa.add(neighbor);
			}
		}
	}

	const regionBbox = cropBbox(assembly.bbox, image.width, image.height);
	const [x0, y0, width, height] = regionBbox;
	const residueBefore = new Set<number>();
	const residueAfter = new Set<number>();
	for (let y = y0; y < y0 + height; y++) {
		for (let x = x0; x < x0 + width; x++) {
			const pixel = y * image.width + x;
			if (!owned.has(pixel)) residueBefore.add(pixel);
			if (!owned.has(pixel) && !aa.has(pixel)) residueAfter.add(pixel);
		}
	}

	return {
		schema: BADGE_MATERIALIZED_EVIDENCE_SCHEMA,
		id: badge.detId,
		provenance,
		badge,
		raster: { width: image.width, height: image.height },
		region: {
			bbox: regionBbox,
			rgba: cropBytes(image.data, image.width, regionBbox, 4),
			brightMask: cropBytes(fields.bright.mask.data, image.width, regionBbox),
			darkMask: cropBytes(fields.dark.mask.data, image.width, regionBbox),
			brightLabels: cropLabels(fields.bright.labels, image.width, regionBbox),
			darkLabels: cropLabels(fields.dark.labels, image.width, regionBbox)
		},
		components: assembly.components,
		ownedBwPixels: sorted(owned),
		aaPixels: sorted(aa),
		residuePixels: sorted(residueAfter),
		measurements: {
			bwOwnedPixelCount: owned.size,
			aaAddedPixelCount: aa.size,
			residueBefore: residueBefore.size,
			residueAfter: residueAfter.size
		}
	};
}
