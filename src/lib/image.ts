import type { CapturedSource } from '$lib/sourceIntake';

export interface LoadedImage {
	readonly file: File;
	readonly name: string;
	readonly imageId: string;
	readonly sourceByteLength: number;
	readonly selectionIndex: number;
	readonly objectUrl: string;
	readonly widthPx: number;
	readonly heightPx: number;
}

export type LoadImageResult =
	{ ok: true; image: LoadedImage } | { ok: false; reason: 'not-a-decodable-image' };

export async function loadImageFromFile(source: CapturedSource): Promise<LoadImageResult> {
	const { file } = source;
	let bitmap: ImageBitmap;
	try {
		bitmap = await createImageBitmap(file);
	} catch {
		return { ok: false, reason: 'not-a-decodable-image' };
	}

	const widthPx = bitmap.width;
	const heightPx = bitmap.height;

	bitmap.close();

	return {
		ok: true,
		image: {
			file,
			name: file.name,
			imageId: source.imageId,
			sourceByteLength: source.sourceByteLength,
			selectionIndex: source.selectionIndex,
			objectUrl: URL.createObjectURL(file),
			widthPx,
			heightPx
		}
	};
}

export function releaseImage(image: LoadedImage): void {
	URL.revokeObjectURL(image.objectUrl);
}
