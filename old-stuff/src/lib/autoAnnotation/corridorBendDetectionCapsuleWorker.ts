/**
 * Main-thread client for the corridor-bend-detection worker
 * (`corridorBendDetectionCapsule.worker.ts`). Same shape as
 * `ribbonMassShadow.ts`'s worker client: a lazily-created singleton worker,
 * a token-correlated request/reply promise, and here also the SAME
 * `detectAndApplyCorridorBendsCapsule` no-clobber/no-op rules the
 * synchronous production entry point in `corridorBendDetectionCapsule.ts`
 * uses (reusing `applyDetectedCorridorBends` directly, not a reimplementation)
 * so a caller gets the identical eligibility/no-op contract, just off the
 * main thread.
 *
 * `detectAndApplyCorridorBendsCapsule` (the synchronous version) is left
 * untouched and still exported from `corridorBendDetectionCapsule.ts` — it
 * remains the one Node/test-side callers (the parity script, unit tests) use,
 * since Node has no `Worker`. This file is browser-only; nothing here is
 * imported by any Node script.
 */
import type { AnnotatedHole, SourcePoint } from '../domain/annotatedRound';
import { applyDetectedCorridorBends } from './corridorBendDetection';
import type { CorridorBendRaster } from './corridorBendDetection';
import { DEFAULT_DETECT_CORRIDOR_BENDS_CAPSULE_PARAMS } from './corridorBendDetectionCapsule';
import type { DetectCorridorBendsCapsuleParams } from './corridorBendDetectionCapsule';
import type { CorridorBendDetectionCapsuleReply, CorridorBendDetectionCapsuleRequest } from './corridorBendDetectionCapsule.worker';

let detectionWorker: Worker | null = null;
let tokenCounter = 0;

function ensureWorker(): Worker {
	detectionWorker ??= new Worker(new URL('./corridorBendDetectionCapsule.worker.ts', import.meta.url), {
		type: 'module'
	});
	return detectionWorker;
}

/** Plain `{xPx, yPx}` copy of a possibly Svelte-`$state`-proxied `SourcePoint` -- `postMessage`'s structured clone throws `DataCloneError` on a Proxy, and `teeSrcPx`/`basketSrcPx`/`badgeSrcPx` here are read from a live `holes`/`numberBadges` `$state` array almost every real call, not a plain literal. Exported for `corridorBendDetectionCapsuleWorker.test.ts`'s regression test -- this file itself can't be unit-tested end-to-end (no real `Worker`/`postMessage` in the Node test environment), so this is the one piece of the DataCloneError fix that can be verified directly. */
export function toPlainSourcePoint(point: SourcePoint): SourcePoint {
	return { xPx: point.xPx, yPx: point.yPx };
}

/**
 * Runs `detectCorridorBendsCapsule` in the dedicated worker. `raster.data`'s
 * backing buffer is transferred (not copied) into the worker -- `raster`
 * itself must not be read again after calling this.
 */
function detectCorridorBendsCapsuleInWorker(
	raster: CorridorBendRaster,
	teeSrcPx: SourcePoint,
	basketSrcPx: SourcePoint,
	badgeSrcPx: SourcePoint | undefined,
	params: DetectCorridorBendsCapsuleParams
): Promise<SourcePoint[]> {
	const worker = ensureWorker();
	tokenCounter += 1;
	const token = `corridor-bend-capsule-${tokenCounter}`;
	return new Promise((resolve, reject) => {
		const onMessage = (event: MessageEvent<CorridorBendDetectionCapsuleReply>) => {
			if (event.data.token !== token) return;
			worker.removeEventListener('message', onMessage);
			if (!event.data.ok) {
				reject(new Error(event.data.message));
				return;
			}
			resolve(event.data.bends.slice());
		};
		worker.addEventListener('message', onMessage);
		const request: CorridorBendDetectionCapsuleRequest = {
			token,
			widthPx: raster.widthPx,
			heightPx: raster.heightPx,
			originXPx: raster.originXPx,
			originYPx: raster.originYPx,
			scale: raster.scale,
			// `Uint8ClampedArray.buffer` is typed `ArrayBufferLike` (it could
			// theoretically back onto a `SharedArrayBuffer`), but a raster's data
			// always comes from `canvas.getImageData()`, which is always a plain
			// `ArrayBuffer` in practice -- safe to narrow here.
			buffer: raster.data.buffer as ArrayBuffer,
			teeSrcPx: toPlainSourcePoint(teeSrcPx),
			basketSrcPx: toPlainSourcePoint(basketSrcPx),
			badgeSrcPx: badgeSrcPx ? toPlainSourcePoint(badgeSrcPx) : undefined,
			params
		};
		worker.postMessage(request, [raster.data.buffer]);
	});
}

/**
 * Async, off-main-thread sibling of `detectAndApplyCorridorBendsCapsule` (see
 * that function's doc comment for the full contract -- this is byte-for-byte
 * the same eligibility/no-op rules, just with the detector call itself
 * awaited via the worker instead of run inline). This is what
 * `approveHolePieces` and the eager placement-time trigger both call in the
 * browser; the synchronous version stays reserved for Node (tests, the
 * benchmark/parity scripts).
 *
 * `raster` is consumed (its buffer is transferred into the worker) -- do not
 * reuse it after calling this.
 */
export async function detectAndApplyCorridorBendsCapsuleAsync(
	holes: readonly AnnotatedHole[],
	holeId: string,
	raster: CorridorBendRaster | null,
	badgeSrcPx: SourcePoint | undefined,
	params: DetectCorridorBendsCapsuleParams = DEFAULT_DETECT_CORRIDOR_BENDS_CAPSULE_PARAMS
): Promise<AnnotatedHole[]> {
	const hole = holes.find((candidate) => candidate.id === holeId);
	if (!hole?.tee || !hole.basket || hole.corridorBends.length > 0 || !raster) return holes.slice();
	try {
		const bends = await detectCorridorBendsCapsuleInWorker(raster, hole.tee, hole.basket, badgeSrcPx, params);
		return applyDetectedCorridorBends(holes, holeId, bends);
	} catch {
		return holes.slice();
	}
}
