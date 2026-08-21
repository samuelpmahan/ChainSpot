export interface LoadedImage {
	readonly file: File;
	readonly name: string;
	readonly objectUrl: string;
	readonly widthPx: number;
	readonly heightPx: number;
}

export type LoadImageResult =
	{ ok: true; image: LoadedImage } | { ok: false; reason: 'not-a-decodable-image' };

export async function loadImageFromFile(file: File): Promise<LoadImageResult> {
	let bitmap: ImageBitmap;
	try {
		bitmap = await createImageBitmap(file);
	} catch {
		return { ok: false, reason: 'not-a-decodable-image' };
	}

	const widthPx = bitmap.width;
	const heightPx = bitmap.height;

	bitmap.close();

	return { ok: true, image: { file, name: file.name, objectUrl: URL.createObjectURL(file), widthPx, heightPx } };
}

export function releaseImage(image: LoadedImage): void {
	URL.revokeObjectURL(image.objectUrl);
}
