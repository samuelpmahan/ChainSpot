/**
 * Dedicated worker for the ribbon-mass attribution shadow pass. Separate
 * from `basketDetection.worker.ts` on purpose: the shadow pass is
 * fire-and-forget instrumentation that must never add latency, failure
 * modes, or OpenCV coupling to the production detection path. It receives
 * the decoded source bitmap plus the already-frozen production badge boxes,
 * runs the pure Phase-1 segmentation (`ribbonMass.ts`), and returns the
 * segmentation pieces; the main thread assembles and persists the
 * `RibbonMassShadowRun`. Nothing here touches authoritative geometry.
 */
import { segmentRibbonMass, DEFAULT_RIBBON_MASS_PARAMS } from './ribbonMass';
import type { RibbonMassComponentRecord, RibbonMassParams } from './ribbonMass';

export interface RibbonMassShadowRequest {
	readonly token: string;
	readonly bitmap: ImageBitmap;
	readonly widthPx: number;
	readonly heightPx: number;
	readonly badges: readonly { readonly xPx: number; readonly yPx: number }[];
	readonly params?: RibbonMassParams;
}

export interface RibbonMassShadowSuccess {
	readonly ok: true;
	readonly token: string;
	readonly widthEv: number;
	readonly heightEv: number;
	readonly scale: number;
	/** Transferred, not copied. */
	readonly labels: Int32Array;
	readonly components: readonly RibbonMassComponentRecord[];
	readonly textureKeptLabels: readonly number[];
}

export interface RibbonMassShadowFailure {
	readonly ok: false;
	readonly token: string;
	readonly message: string;
}

export type RibbonMassShadowReply = RibbonMassShadowSuccess | RibbonMassShadowFailure;

self.onmessage = (event: MessageEvent<RibbonMassShadowRequest>) => {
	const request = event.data;
	try {
		const canvas = new OffscreenCanvas(request.widthPx, request.heightPx);
		const context = canvas.getContext('2d', { willReadFrequently: true });
		if (!context) throw new Error('ribbon-mass shadow pass could not create an OffscreenCanvas context');
		context.drawImage(request.bitmap, 0, 0);
		const rgba = context.getImageData(0, 0, request.widthPx, request.heightPx).data;
		request.bitmap.close();

		const segmentation = segmentRibbonMass(
			{ data: rgba, widthPx: request.widthPx, heightPx: request.heightPx, channels: 4 },
			request.badges,
			request.params ?? DEFAULT_RIBBON_MASS_PARAMS
		);
		const reply: RibbonMassShadowSuccess = {
			ok: true,
			token: request.token,
			widthEv: segmentation.widthEv,
			heightEv: segmentation.heightEv,
			scale: segmentation.scale,
			labels: segmentation.labels,
			components: segmentation.components,
			textureKeptLabels: [...segmentation.textureKeptLabels].sort((a, b) => a - b)
		};
		(self as unknown as Worker).postMessage(reply, [segmentation.labels.buffer]);
	} catch (error) {
		const reply: RibbonMassShadowFailure = {
			ok: false,
			token: request.token,
			message: error instanceof Error ? error.message : 'ribbon-mass shadow pass failed'
		};
		(self as unknown as Worker).postMessage(reply);
	}
};
