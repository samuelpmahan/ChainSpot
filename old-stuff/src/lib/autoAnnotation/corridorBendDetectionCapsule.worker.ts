/**
 * Dedicated worker for the production capsule bend detector
 * (`detectCorridorBendsCapsule` in `corridorBendDetectionCapsule.ts`). The
 * detector itself is unchanged and unmodified here -- this file only moves
 * WHERE it runs. Real in-browser timing
 * (`scripts/measure-bend-detection-session.ts`) showed a single hole can
 * take up to ~600ms on solid hardware (median ~130ms, worst case scaling
 * higher on lower-end devices); running that synchronously on the main
 * thread is a real, user-visible stall, so this worker takes over the
 * expensive part (evidence construction + capsule search) while the cheap
 * part (the canvas crop that produces the raster this worker receives)
 * stays on the main thread in `cropSourceRasterAroundHole`, same convention
 * `ribbonMassShadow.worker.ts` uses for the ribbon-mass segmentation pass.
 *
 * The raster's pixel buffer is received and returned via its `ArrayBuffer`
 * (transferred, not copied, on the way in) since `postMessage` cannot send a
 * live `Uint8ClampedArray` view without either copying it or transferring
 * its backing buffer.
 */
import { DEFAULT_DETECT_CORRIDOR_BENDS_CAPSULE_PARAMS, detectCorridorBendsCapsule } from './corridorBendDetectionCapsule';
import type { DetectCorridorBendsCapsuleParams } from './corridorBendDetectionCapsule';
import type { CorridorBendRaster } from './corridorBendDetection';
import type { SourcePoint } from '../domain/annotatedRound';

export interface CorridorBendDetectionCapsuleRequest {
	readonly token: string;
	readonly widthPx: number;
	readonly heightPx: number;
	readonly originXPx: number;
	readonly originYPx: number;
	readonly scale: number;
	/** `CorridorBendRaster.data`'s backing buffer, transferred. */
	readonly buffer: ArrayBuffer;
	readonly teeSrcPx: SourcePoint;
	readonly basketSrcPx: SourcePoint;
	readonly badgeSrcPx?: SourcePoint;
	readonly params?: DetectCorridorBendsCapsuleParams;
}

export interface CorridorBendDetectionCapsuleSuccess {
	readonly ok: true;
	readonly token: string;
	readonly bends: readonly SourcePoint[];
}

export interface CorridorBendDetectionCapsuleFailure {
	readonly ok: false;
	readonly token: string;
	readonly message: string;
}

export type CorridorBendDetectionCapsuleReply = CorridorBendDetectionCapsuleSuccess | CorridorBendDetectionCapsuleFailure;

self.onmessage = (event: MessageEvent<CorridorBendDetectionCapsuleRequest>) => {
	const request = event.data;
	try {
		const raster: CorridorBendRaster = {
			widthPx: request.widthPx,
			heightPx: request.heightPx,
			originXPx: request.originXPx,
			originYPx: request.originYPx,
			scale: request.scale,
			data: new Uint8ClampedArray(request.buffer),
			channels: 4
		};
		const bends = detectCorridorBendsCapsule(
			raster,
			request.teeSrcPx,
			request.basketSrcPx,
			request.badgeSrcPx,
			request.params ?? DEFAULT_DETECT_CORRIDOR_BENDS_CAPSULE_PARAMS
		);
		const reply: CorridorBendDetectionCapsuleSuccess = { ok: true, token: request.token, bends };
		(self as unknown as Worker).postMessage(reply);
	} catch (error) {
		const reply: CorridorBendDetectionCapsuleFailure = {
			ok: false,
			token: request.token,
			message: error instanceof Error ? error.message : 'corridor bend detection failed'
		};
		(self as unknown as Worker).postMessage(reply);
	}
};
