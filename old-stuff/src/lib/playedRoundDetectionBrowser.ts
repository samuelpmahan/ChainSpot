import { base } from '$app/paths';
import { decodeImageFile } from './imageIntake';
import {
	classifyLandingDropletGlyphs,
	findLandingDroplets,
	landingDropletGlyphTemplateFromMask
} from './autoAnnotation/landingDropletDetection';
import type {
	DeferredOverlapRegion,
	LandingDropletCv,
	LandingDropletGlyphTemplate,
	LandingDropletRaster,
	LandingMarkerCandidate,
	LandingMarkerKind
} from './autoAnnotation/landingDropletDetection';

export interface PlayedRoundDetectionResult {
	readonly candidates: readonly LandingMarkerCandidate[];
	readonly deferredOverlaps: readonly DeferredOverlapRegion[];
}

const GLYPH_KINDS: readonly LandingMarkerKind[] = ['c1', 'c2', 'off-fairway'];

function rasterFromImage(image: CanvasImageSource, widthPx: number, heightPx: number): LandingDropletRaster {
	const canvas = document.createElement('canvas');
	canvas.width = widthPx;
	canvas.height = heightPx;
	const context = canvas.getContext('2d', { willReadFrequently: true });
	if (!context) throw new Error('The browser could not create a 2D canvas for played-round detection.');
	context.drawImage(image, 0, 0, widthPx, heightPx);
	return { rgba: context.getImageData(0, 0, widthPx, heightPx).data, widthPx, heightPx, sourceScale: 1 };
}

async function decodeUrl(url: string): Promise<{ image: HTMLImageElement; widthPx: number; heightPx: number }> {
	const response = await fetch(url);
	if (!response.ok) throw new Error(`Could not load played-round detector template (${response.status}).`);
	const blob = await response.blob();
	return decodeImageFile(new File([blob], url.split('/').at(-1) ?? 'template.png', { type: blob.type || 'image/png' }));
}

async function loadTemplates(): Promise<readonly LandingDropletGlyphTemplate[]> {
	return Promise.all(GLYPH_KINDS.map(async (kind) => {
		const decoded = await decodeUrl(`${base}/resources/chainspot_cv_templates/round-landing-glyph-${kind}.png`);
		const raster = rasterFromImage(decoded.image, decoded.widthPx, decoded.heightPx);
		const gray = new Uint8Array(decoded.widthPx * decoded.heightPx);
		for (let pixel = 0, offset = 0; pixel < gray.length; pixel += 1, offset += 4) gray[pixel] = raster.rgba[offset];
		return landingDropletGlyphTemplateFromMask(kind, gray, decoded.widthPx, decoded.heightPx);
	}));
}

/** Runs the already-proven landing-droplet detector against the original held screenshot. */
export async function detectPlayedRoundLandings(blob: Blob, fileName: string): Promise<PlayedRoundDetectionResult> {
	const decoded = await decodeImageFile(new File([blob], fileName, { type: blob.type || 'image/png' }));
	const raster = rasterFromImage(decoded.image, decoded.widthPx, decoded.heightPx);
	const [{ getCv }, templates] = await Promise.all([import('./cv/runtime'), loadTemplates()]);
	const cv = await getCv() as LandingDropletCv;
	const localized = findLandingDroplets(cv, raster);
	return {
		candidates: classifyLandingDropletGlyphs(raster, localized.droplets, templates),
		deferredOverlaps: localized.deferredOverlaps
	};
}
