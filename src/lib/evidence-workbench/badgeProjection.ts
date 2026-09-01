import type { BadgeSpecimen } from './badgeSpecimen';

export type BadgeProjection =
	'raw' | 'bw' | 'ownership' | 'aa' | 'residue-before' | 'residue-after' | 'composed';

export const BADGE_STORY_PROJECTIONS: readonly BadgeProjection[] = [
	'raw',
	'bw',
	'ownership',
	'aa',
	'residue-before',
	'residue-after',
	'composed'
];

export interface BadgeProjectionImage {
	readonly width: number;
	readonly height: number;
	readonly rgba: Uint8ClampedArray;
}

const COLORS = {
	neutral: [232, 232, 232, 255],
	transparent: [0, 0, 0, 0],
	bright: [255, 255, 255, 255],
	dark: [18, 18, 18, 255],
	owned: [250, 204, 21, 255],
	aa: [124, 58, 237, 255],
	residue: [185, 28, 28, 255]
} as const;

function put(out: Uint8ClampedArray, pixel: number, color: readonly number[]): void {
	const offset = pixel * 4;
	out[offset] = color[0];
	out[offset + 1] = color[1];
	out[offset + 2] = color[2];
	out[offset + 3] = color[3];
}

export function projectBadge(
	specimen: BadgeSpecimen,
	projection: BadgeProjection
): Uint8ClampedArray {
	const pixels = specimen.crop.width * specimen.crop.height;
	if (specimen.sourceRgba.length !== pixels * 4)
		throw new Error('badge specimen RGBA dimensions disagree');
	const out = new Uint8ClampedArray(pixels * 4);
	for (let pixel = 0; pixel < pixels; pixel++) {
		if (projection === 'raw') {
			const offset = pixel * 4;
			out.set(specimen.sourceRgba.slice(offset, offset + 4), offset);
			continue;
		}
		if (projection === 'bw') {
			put(
				out,
				pixel,
				specimen.brightMask[pixel]
					? COLORS.bright
					: specimen.darkMask[pixel]
						? COLORS.dark
						: COLORS.neutral
			);
			continue;
		}
		if (projection === 'ownership') {
			put(out, pixel, specimen.ownedMask[pixel] ? COLORS.owned : COLORS.transparent);
			continue;
		}
		if (projection === 'aa') {
			put(out, pixel, specimen.aaMask[pixel] ? COLORS.aa : COLORS.transparent);
			continue;
		}
		if (projection === 'residue-before') {
			if (specimen.residueBeforeMask[pixel]) {
				const offset = pixel * 4;
				out.set(specimen.sourceRgba.slice(offset, offset + 4), offset);
			} else put(out, pixel, COLORS.transparent);
			continue;
		}
		if (projection === 'residue-after') {
			if (specimen.residueAfterMask[pixel]) {
				const offset = pixel * 4;
				out.set(specimen.sourceRgba.slice(offset, offset + 4), offset);
			} else put(out, pixel, COLORS.transparent);
			continue;
		}
		put(
			out,
			pixel,
			specimen.ownedMask[pixel]
				? COLORS.owned
				: specimen.aaMask[pixel]
					? COLORS.aa
					: specimen.residueAfterMask[pixel]
						? COLORS.residue
						: COLORS.transparent
		);
	}
	return out;
}

/** The browser canvas and the CI PNG receipt consume this exact image. */
export function projectBadgeImage(
	specimen: BadgeSpecimen,
	projection: BadgeProjection
): BadgeProjectionImage {
	return {
		width: specimen.crop.width,
		height: specimen.crop.height,
		rgba: projectBadge(specimen, projection)
	};
}

export function assertBadgeConservation(specimen: BadgeSpecimen): void {
	for (let pixel = 0; pixel < specimen.ownedMask.length; pixel++) {
		if (specimen.ownedMask[pixel] && specimen.aaMask[pixel])
			throw new Error(`owned/AA overlap at ${pixel}`);
		if (specimen.ownedMask[pixel] && specimen.residueAfterMask[pixel])
			throw new Error(`owned/residue overlap at ${pixel}`);
		if (specimen.aaMask[pixel] && specimen.residueAfterMask[pixel])
			throw new Error(`AA/residue overlap at ${pixel}`);
		if (
			!specimen.ownedMask[pixel] &&
			!specimen.aaMask[pixel] &&
			!specimen.residueAfterMask[pixel]
		) {
			throw new Error(`unreconstructed crop pixel at ${pixel}`);
		}
	}
}
