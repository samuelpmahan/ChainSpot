/**
 * ChainSpot Stitch Map duplicate-screenshot detection.
 *
 * Heavy neighbor overlap is a legitimate, well-supported capture style — a
 * careful user panning in small steps produces tiles that share most of their
 * content, and the matcher handles that fine. The one arrangement that is never
 * recoverable is the same screenshot supplied twice: no 2×2 exists, so whatever
 * the matcher returns would stack two tiles on top of each other and export a
 * map missing a quarter of the course.
 *
 * That case is worth naming precisely rather than letting it surface as a
 * baffling arrangement, so this is a deliberately literal test: byte-equal
 * analysis rasters of equal size. Nothing is inferred, no threshold is tuned,
 * and two captures that differ by even one pixel of pan are not duplicates and
 * are never rejected. The cost of being wrong here is high — refusing a real
 * capture set is worse than any warning — so the check errs entirely toward
 * permissiveness.
 *
 * Pure and deterministic: it reports the first duplicate pair in index order,
 * so the same four files always produce the same message.
 */
import type { AnalysisRaster } from './analysis';

export interface DuplicateRasterPair {
	/** Index of the earlier occurrence, in the caller's raster ordering. */
	readonly firstIndex: number;
	/** Index of the later, duplicate occurrence. */
	readonly duplicateIndex: number;
}

function rastersIdentical(a: AnalysisRaster, b: AnalysisRaster): boolean {
	if (a.widthPx !== b.widthPx || a.heightPx !== b.heightPx) return false;
	if (a.gray.length !== b.gray.length) return false;
	for (let i = 0; i < a.gray.length; i += 1) {
		if (a.gray[i] !== b.gray[i]) return false;
	}
	return true;
}

/**
 * Finds the first pair of pixel-identical rasters, or null when every raster is
 * distinct. Comparison is on the analysis rasters the matcher itself scores, so
 * a screenshot re-encoded to a different file size or format is still caught:
 * what matters is that the images are the same picture, not the same bytes.
 */
export function findDuplicateRasters(
	rasters: readonly AnalysisRaster[]
): DuplicateRasterPair | null {
	for (let later = 1; later < rasters.length; later += 1) {
		for (let earlier = 0; earlier < later; earlier += 1) {
			if (rastersIdentical(rasters[earlier], rasters[later])) {
				return { firstIndex: earlier, duplicateIndex: later };
			}
		}
	}
	return null;
}

/**
 * The user-facing sentence for a rejected duplicate. Shared, because the two
 * import paths — the in-process `smartImportFiles` and the worker pipeline that
 * the browser actually runs — detect duplicates independently and must not
 * drift into explaining the same problem two different ways.
 */
export function duplicateImageMessage(firstName: string, duplicateName: string): string {
	return firstName === duplicateName
		? `"${duplicateName}" was selected twice. The four screenshots must be four different captures of the course.`
		: `"${duplicateName}" is the same image as "${firstName}". The four screenshots must be four different captures of the course, so check for a duplicated or re-saved screenshot.`;
}
