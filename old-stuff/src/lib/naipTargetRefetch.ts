import { clampPointToImageBounds } from './coords';
import type { ProjectEditor } from './domain/editor';
import { createImageAsset, findImageByRole } from './domain/project';
import {
	bundlePathFor,
	decodeImageFile,
	readFileBytes,
	sha256Hex
} from './imageIntake';
import type { DecodeImageFile, HashBytes } from './imageIntake';
import { fetchNaipImage, naipMetersPerPixel, NAIP_EXPORT_SIZE_PX } from './naip';
import type { NaipFetchGeometry } from './naipCoverage';
import { remapNaipPixel } from './naipCoverage';

export type GeoTargetRefetchResult =
	| { ok: true; metersPerPixel: number }
	| { ok: false; message: string };

interface GeoTargetRefetchOptions {
	editor: ProjectEditor;
	expectedTargetId: string;
	oldGeometry: NaipFetchGeometry;
	newGeometry: NaipFetchGeometry;
	decode?: DecodeImageFile;
	hash?: HashBytes;
	createAssetId?: () => string;
}

/**
 * Re-fetches a north-up radius-based NAIP target at `newGeometry`, replacing
 * the current target WITHOUT throwing away correspondence identity.
 *
 * Every target point is mapped old pixel → WGS84 → new pixel using the exact
 * inverse pair in `naipCoverage.ts`. The caller owns page-level transient state
 * (pending correspondence cancellation, loading/error copy, retained geo
 * metadata); this helper owns only the deterministic image/domain mutation.
 *
 * `expectedTargetId` is checked both before and after the network/decode/hash
 * work. If the user replaces the target while a request is in flight, stale
 * bytes are refused rather than clobbering the newer target.
 */
export async function refetchGeoReferencedTarget(
	options: GeoTargetRefetchOptions
): Promise<GeoTargetRefetchResult> {
	const {
		editor,
		expectedTargetId,
		oldGeometry,
		newGeometry,
		decode = decodeImageFile,
		hash = sha256Hex,
		createAssetId = () => globalThis.crypto.randomUUID()
	} = options;

	const initialTarget = findImageByRole(editor.state.images, 'target-basemap');
	if (!initialTarget || initialTarget.id !== expectedTargetId) {
		return { ok: false, message: 'The clean target changed before the re-fetch started. Nothing was changed.' };
	}

	try {
		const fetched = await fetchNaipImage(newGeometry.center, newGeometry.radiusMeters);
		if (!fetched.ok) return { ok: false, message: fetched.error.message };

		const file = new File([fetched.blob], 'naip-aerial.png', { type: 'image/png' });
		const decoded = await decode(file);
		if (decoded.widthPx !== initialTarget.widthPx || decoded.heightPx !== initialTarget.heightPx) {
			return {
				ok: false,
				message: 'The re-fetched aerial came back at unexpected dimensions. Nothing was changed.'
			};
		}
		const bytes = await readFileBytes(file);
		const sha256 = await hash(bytes);

		const liveTarget = findImageByRole(editor.state.images, 'target-basemap');
		if (!liveTarget || liveTarget.id !== expectedTargetId) {
			return { ok: false, message: 'The clean target changed while the aerial was loading. Nothing was changed.' };
		}

		const asset = createImageAsset({
			id: createAssetId(),
			role: 'target-basemap',
			fileName: file.name,
			mimeType: file.type,
			widthPx: decoded.widthPx,
			heightPx: decoded.heightPx,
			sha256,
			bundlePath: bundlePathFor('target-basemap', file.type)
		});
		const previousRotation = liveTarget.rotationDeg ?? 0;

		editor.replaceImage({ role: 'target-basemap', asset, bytes, retainPoints: true });
		editor.setDecodedResource(asset.id, decoded.image);
		for (const pair of editor.state.controlPointPairs) {
			if (pair.target.imageId !== asset.id) continue;
			const remapped = remapNaipPixel(oldGeometry, newGeometry, pair.target);
			editor.movePoint(
				pair.id,
				'target',
				clampPointToImageBounds(remapped, decoded.widthPx, decoded.heightPx)
			);
		}
		if (previousRotation !== 0) editor.setTargetRotation(previousRotation);

		return {
			ok: true,
			metersPerPixel: naipMetersPerPixel(newGeometry.radiusMeters, NAIP_EXPORT_SIZE_PX)
		};
	} catch (error) {
		return {
			ok: false,
			message: error instanceof Error ? error.message : 'Could not re-fetch the aerial.'
		};
	}
}
