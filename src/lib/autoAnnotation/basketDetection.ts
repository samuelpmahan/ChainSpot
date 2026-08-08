/**
 * Browser-side basket candidate detection.
 *
 * This is deliberately a proposal-only vertical slice. It searches the loaded
 * UDisc/source image and returns ranked source-image points; it does not assign
 * a candidate to a hole or mutate ProjectState until the user accepts one.
 *
 * The OpenCV runtime is large enough that a detector worker is kept alive for
 * the life of this module. That lets a prewarm fetch/initialize it off the main
 * thread, and makes subsequent detections reuse both WASM and the template.
 */

export interface BasketCandidate {
	readonly xPx: number;
	readonly yPx: number;
	readonly score: number;
	readonly widthPx: number;
	readonly heightPx: number;
	readonly scale: number;
}

import type { CourseGrammarResult } from './courseGrammar';
import type { HoleNumberDetection } from './holeNumberDetection';
import type { TeePadCandidate } from './teePadDetection';

export interface CourseDetectionResult {
	readonly numberDetection: HoleNumberDetection;
	readonly tees: readonly TeePadCandidate[];
	readonly baskets: readonly BasketCandidate[];
	readonly grammar: CourseGrammarResult;
}

interface BasketWorkerSuccess {
	ok: true;
	token: string;
	kind: 'detect' | 'detect-course' | 'prewarm';
	candidates?: readonly BasketCandidate[];
	course?: CourseDetectionResult;
}

interface BasketWorkerFailure {
	ok: false;
	token: string;
	kind: 'detect' | 'detect-course' | 'prewarm';
	message: string;
}

type BasketWorkerReply = BasketWorkerSuccess | BasketWorkerFailure;

interface BasketDetectionRequest {
	readonly kind: 'detect' | 'detect-course';
	readonly token: string;
	readonly bitmap: ImageBitmap;
	readonly widthPx: number;
	readonly heightPx: number;
}

interface BasketPrewarmRequest {
	readonly kind: 'prewarm';
	readonly token: string;
}

type BasketWorkerRequest = BasketDetectionRequest | BasketPrewarmRequest;

interface PendingRequest {
	readonly worker: Worker;
	readonly resolve: (reply: BasketWorkerReply) => void;
	readonly reject: (reason: Error) => void;
}

let activeWorker: Worker | null = null;
let requestSequence = 0;
const pendingRequests = new Map<string, PendingRequest>();
let prewarmWorker: Worker | null = null;
let prewarmPromise: Promise<void> | null = null;

function nextToken(): string {
	requestSequence = (requestSequence + 1) >>> 0;
	return `${Date.now().toString(36)}-${requestSequence.toString(36)}-${Math.random()
		.toString(36)
		.slice(2)}`;
}

function workerErrorMessage(event: ErrorEvent | MessageEvent): string {
	const message = (event as { message?: unknown }).message;
	if (typeof message === 'string' && message) return message;
	return 'Basket detection worker failed.';
}

function rejectWorkerRequests(worker: Worker, message: string): void {
	for (const [token, pending] of pendingRequests) {
		if (pending.worker !== worker) continue;
		pendingRequests.delete(token);
		pending.reject(new Error(message));
	}
}

function retireWorker(worker: Worker, message: string): void {
	rejectWorkerRequests(worker, message);
	if (activeWorker !== worker) return;
	activeWorker = null;
	if (prewarmWorker === worker) {
		prewarmWorker = null;
		prewarmPromise = null;
	}
	worker.terminate();
}

function handleWorkerMessage(worker: Worker, event: MessageEvent<BasketWorkerReply>): void {
	const reply = event.data;
	if (!reply || typeof reply.token !== 'string') return;
	const pending = pendingRequests.get(reply.token);
	if (!pending || pending.worker !== worker) return;
	pendingRequests.delete(reply.token);
	if (reply.ok) {
		pending.resolve(reply);
	} else {
		// A request-level failure can leave a rejected OpenCV initialization
		// promise inside the worker. Retire only on this exceptional path so the
		// next request gets a clean runtime instead of repeating that failure.
		retireWorker(worker, reply.message);
		pending.reject(new Error(reply.message));
	}
}

function getWorker(): Worker {
	if (activeWorker) return activeWorker;
	const worker = new Worker(new URL('./basketDetection.worker.ts', import.meta.url), {
		type: 'module'
	});
	worker.addEventListener('message', (event: MessageEvent<BasketWorkerReply>) => {
		handleWorkerMessage(worker, event);
	});
	worker.addEventListener('error', (event) => {
		retireWorker(worker, workerErrorMessage(event));
	});
	worker.addEventListener('messageerror', (event) => {
		retireWorker(worker, workerErrorMessage(event));
	});
	activeWorker = worker;
	return worker;
}

function postToWorker(
	request: BasketWorkerRequest,
	transfer: Transferable[] = []
): Promise<BasketWorkerReply> {
	const worker = getWorker();
	return new Promise<BasketWorkerReply>((resolve, reject) => {
		pendingRequests.set(request.token, { worker, resolve, reject });
		try {
			worker.postMessage(request, transfer);
		} catch (error) {
			pendingRequests.delete(request.token);
			const failure = error instanceof Error ? error : new Error(String(error));
			retireWorker(worker, failure.message);
			reject(failure);
		}
	});
}

function assertWorkerSupport(): void {
	if (typeof Worker === 'undefined') {
		throw new Error('Basket detection requires a browser with Web Worker support.');
	}
}

/**
 * Starts the reusable worker and loads OpenCV plus the basket template without
 * blocking the UI. Call this after a source image is selected (or on an idle
 * route) so the Detect button does not pay the cold WASM cost.
 */
export function prewarmBasketDetection(): Promise<void> {
	assertWorkerSupport();
	const worker = getWorker();
	if (prewarmWorker === worker && prewarmPromise) return prewarmPromise;

	const token = nextToken();
	prewarmWorker = worker;
	const warming = postToWorker({ kind: 'prewarm', token }).then((reply) => {
		if (!reply.ok) throw new Error(reply.message);
		if (reply.kind !== 'prewarm') throw new Error('Basket detection worker returned an invalid prewarm reply.');
	});
	prewarmPromise = warming.catch((error) => {
		if (prewarmWorker === worker) {
			prewarmWorker = null;
			prewarmPromise = null;
		}
		throw error;
	});
	return prewarmPromise;
}

/**
 * Runs the detector off the main thread. The original bytes are used instead
 * of the transient HTMLImageElement so the worker receives an independently
 * decodable bitmap and the source-image coordinate contract stays explicit.
 */
export async function detectBasketCandidates(
	bytes: Uint8Array,
	mimeType: string,
	widthPx: number,
	heightPx: number
): Promise<readonly BasketCandidate[]> {
	assertWorkerSupport();
	if (typeof createImageBitmap === 'undefined') {
		throw new Error('Basket detection requires a browser with ImageBitmap support.');
	}
	if (!Number.isFinite(widthPx) || !Number.isFinite(heightPx) || widthPx <= 0 || heightPx <= 0) {
		throw new Error(`Basket detection received invalid image dimensions (${widthPx} × ${heightPx}).`);
	}

	const bitmap = await createImageBitmap(new Blob([bytes as BufferSource], { type: mimeType }));
	const token = nextToken();
	try {
		const reply = await postToWorker(
			{ kind: 'detect', token, bitmap, widthPx, heightPx },
			[bitmap as unknown as Transferable]
		);
		if (!reply.ok) throw new Error(reply.message);
		if (reply.kind !== 'detect' || !reply.candidates) {
			throw new Error('Basket detection worker returned an invalid detection reply.');
		}
		return reply.candidates;
	} catch (error) {
		// A bitmap whose transfer failed remains owned by this thread. Closing it
		// is harmless after a successful transfer, and prevents a decode resource
		// leak on the synchronous postMessage failure path.
		bitmap.close();
		throw error;
	}
}

/**
 * Runs the complete MVP detector in the same persistent OpenCV worker used by
 * basket assist. The returned grammar remains proposal-only until the user
 * explicitly applies ready holes in Annotate Round.
 */
export async function detectCourseCandidates(
	bytes: Uint8Array,
	mimeType: string,
	widthPx: number,
	heightPx: number
): Promise<CourseDetectionResult> {
	assertWorkerSupport();
	if (typeof createImageBitmap === 'undefined') {
		throw new Error('Course detection requires a browser with ImageBitmap support.');
	}
	if (!Number.isFinite(widthPx) || !Number.isFinite(heightPx) || widthPx <= 0 || heightPx <= 0) {
		throw new Error(`Course detection received invalid image dimensions (${widthPx} × ${heightPx}).`);
	}

	const bitmap = await createImageBitmap(new Blob([bytes as BufferSource], { type: mimeType }));
	const token = nextToken();
	try {
		const reply = await postToWorker(
			{ kind: 'detect-course', token, bitmap, widthPx, heightPx },
			[bitmap as unknown as Transferable]
		);
		if (!reply.ok) throw new Error(reply.message);
		if (reply.kind !== 'detect-course' || !reply.course) {
			throw new Error('Course detection worker returned an invalid detection reply.');
		}
		return reply.course;
	} catch (error) {
		bitmap.close();
		throw error;
	}
}
