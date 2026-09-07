import { parseWorkspace, type Workspace } from './model';
export const storageKey = 'chainspot.disc-studio.v1';
export function saveDraft(workspace: Workspace): void {
	const raw = JSON.stringify(workspace);
	if (raw.length > 4_500_000)
		throw new Error('Local draft is full. Download the draft or use smaller photos.');
	localStorage.setItem(storageKey, raw);
}
/** Decode locally, preserve the complete image, bound its size. No upload or recognition. */
export async function readPhoto(file: File): Promise<{ src: string; alt: string }> {
	if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type))
		throw new Error('Use a JPEG, PNG or WebP photo. Convert HEIC first.');
	if (file.size > 15 * 1024 * 1024)
		throw new Error('Photo is too large. Choose an image under 15 MB.');
	const bitmap = await createImageBitmap(file);
	try {
		const scale = Math.min(1, 1000 / Math.max(bitmap.width, bitmap.height));
		const canvas = document.createElement('canvas');
		canvas.width = Math.max(1, Math.round(bitmap.width * scale));
		canvas.height = Math.max(1, Math.round(bitmap.height * scale));
		const context = canvas.getContext('2d');
		if (!context) throw new Error('Your browser could not prepare the photo.');
		context.fillStyle = '#f7f7f4';
		context.fillRect(0, 0, canvas.width, canvas.height);
		context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
		let src = canvas.toDataURL('image/jpeg', 0.86);
		if (src.length > 850_000) src = canvas.toDataURL('image/jpeg', 0.65);
		if (src.length > 850_000)
			throw new Error('This image is still too large. Choose a smaller photo.');
		return { src, alt: file.name.slice(0, 200) };
	} finally {
		bitmap.close();
	}
}
export function loadDraft(): Workspace | null {
	const raw = localStorage.getItem(storageKey);
	return raw ? parseWorkspace(raw) : null;
}
