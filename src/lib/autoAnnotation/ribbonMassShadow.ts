/**
 * Main-thread client for the ribbon-mass shadow pass: freezes the
 * production snapshot from a just-completed `CourseDetectionResult`, runs
 * the Phase-1 segmentation in a dedicated worker, assembles the immutable
 * ShadowRun A record, and persists it to the shadow-run store. Entirely
 * fire-and-forget from the caller's perspective — any failure resolves to
 * null and must never surface as an annotation error or affect
 * authoritative geometry.
 */
import type { CourseDetectionResult } from './basketDetection';
import type { RibbonMassSegmentation } from './ribbonMass';
import { buildShadowRunA, freezeProductionSnapshot, getDefaultRibbonMassShadowRunStore } from './ribbonMassShadowRun';
import type { RibbonMassShadowRun, RibbonMassShadowRunStore } from './ribbonMassShadowRun';
import type { RibbonMassShadowReply, RibbonMassShadowRequest } from './ribbonMassShadow.worker';

let shadowWorker: Worker | null = null;
let tokenCounter = 0;

function ensureWorker(): Worker {
	shadowWorker ??= new Worker(new URL('./ribbonMassShadow.worker.ts', import.meta.url), {
		type: 'module'
	});
	return shadowWorker;
}

function segmentInWorker(
	bitmap: ImageBitmap,
	widthPx: number,
	heightPx: number,
	badges: readonly { xPx: number; yPx: number }[]
): Promise<RibbonMassSegmentation> {
	const worker = ensureWorker();
	tokenCounter += 1;
	const token = `ribbon-mass-${tokenCounter}`;
	return new Promise((resolve, reject) => {
		const onMessage = (event: MessageEvent<RibbonMassShadowReply>) => {
			if (event.data.token !== token) return;
			worker.removeEventListener('message', onMessage);
			if (!event.data.ok) {
				reject(new Error(event.data.message));
				return;
			}
			const reply = event.data;
			resolve({
				widthEv: reply.widthEv,
				heightEv: reply.heightEv,
				scale: reply.scale,
				labels: reply.labels,
				components: reply.components,
				textureKeptLabels: new Set(reply.textureKeptLabels)
			});
		};
		worker.addEventListener('message', onMessage);
		const request: RibbonMassShadowRequest = { token, bitmap, widthPx, heightPx, badges };
		worker.postMessage(request, [bitmap]);
	});
}

export interface RunShadowPassInput {
	readonly projectId: string;
	readonly imageId: string;
	readonly imageSha256: string | null;
	readonly imageBytes: Uint8Array;
	readonly mimeType: string;
	readonly widthPx: number;
	readonly heightPx: number;
	readonly detection: CourseDetectionResult;
}

/**
 * Freeze and persist ShadowRun A for a just-completed detection. Call this
 * immediately after the detection result lands, BEFORE any review
 * interaction can exist — the snapshot must represent what the production
 * system actually believed at detection time. Resolves to the stored run,
 * or null on any failure (best-effort instrumentation, never blocking).
 */
export async function runRibbonMassShadowPass(
	input: RunShadowPassInput,
	store: RibbonMassShadowRunStore = getDefaultRibbonMassShadowRunStore()
): Promise<RibbonMassShadowRun | null> {
	try {
		if (typeof Worker === 'undefined' || typeof createImageBitmap === 'undefined') return null;
		const snapshot = freezeProductionSnapshot(input.detection);
		const bitmap = await createImageBitmap(
			new Blob([input.imageBytes as BufferSource], { type: input.mimeType })
		);
		const segmentation = await segmentInWorker(bitmap, input.widthPx, input.heightPx, snapshot.badges);
		const run = buildShadowRunA({
			projectId: input.projectId,
			imageId: input.imageId,
			imageSha256: input.imageSha256,
			segmentation,
			snapshot
		});
		await store.append(run);
		return run;
	} catch {
		// Shadow instrumentation is strictly best-effort.
		return null;
	}
}
