import { base } from '$app/paths';
import type { CourseGrammarResult } from './courseGrammar';
import type {
	CalibratedBasketCandidate,
	CalibratedHoleNumberDetection
} from './cvCalibratedDetectors';
import { asUiScalePx } from './cvCalibration';
import type {
	BasketTemplateScale,
	NumberTemplateScale,
	TemplateScale,
	UiScalePx
} from './cvCalibration';
import type {
	TeePadCandidate,
	TeePadStageCounts,
	TeePadVariant,
	TeePadVariantResult
} from './teePadDetection';
import type { LocalSnapKind, LocalSnapPoint } from '../cv/localSnap';

export type BasketCandidate = CalibratedBasketCandidate;

export interface CourseDetectionPerformance {
	readonly totalMs: number;
	readonly cachedAtStart: {
		readonly runtime: boolean;
		readonly templatePack: boolean;
	};
	readonly input: {
		readonly sourceWidthPx: number;
		readonly sourceHeightPx: number;
		readonly analysisWidthPx: number;
		readonly analysisHeightPx: number;
		readonly analysisScale: number;
	};
	readonly stages: {
		readonly bootstrapMs: number;
		readonly analysisRasterMs: number;
		readonly numbersMs: number;
		readonly basketsMs: number;
		readonly basketRasterMs: number;
		readonly basketAnchorMs: number;
		readonly basketCandidatesMs: number;
		readonly teesMs: number;
		readonly teeRasterMs: number;
		readonly teeDetectionMs: number;
		readonly grammarMs: number;
	};
	readonly counts: {
		readonly numberTemplates: number;
		readonly numberCandidates: number;
		readonly labeledNumbers: number;
		readonly baskets: number;
		readonly tees: number;
		readonly basketAnchorScaleEvaluations: number;
	};
	readonly calibration: {
		readonly numberTemplateScale: NumberTemplateScale;
		readonly basketTemplateScale: BasketTemplateScale;
		readonly basketTemplateScalePerNumberTemplateScale: number;
	};
}

export interface CourseDetectionResult {
	readonly numberDetection: CalibratedHoleNumberDetection;
	readonly tees: readonly TeePadCandidate[];
	readonly baskets: readonly BasketCandidate[];
	readonly grammar: CourseGrammarResult;
	/** Present on production worker results; optional so existing test fixtures/mocks remain source-compatible. */
	readonly performance?: CourseDetectionPerformance;
}

export type { TeePadVariant, TeePadStageCounts, TeePadVariantResult } from './teePadDetection';
export type {
	BasketTemplateScale,
	NumberTemplateScale,
	TemplateScale,
	UiScalePx
} from './cvCalibration';

/**
 * Transitional public input for a user-supplied UI calibration. Plain numeric
 * CLI/UI values are accepted and immediately branded at the worker boundary,
 * but a TemplateScale is structurally rejected by TypeScript.
 */
type UnbrandedScaleNumber = number & { readonly __brand?: never };
export type UiScaleInput = UiScalePx | UnbrandedScaleNumber;

export interface DetectTeesOptions {
	readonly variants?: readonly TeePadVariant[];
	readonly uiScalePx?: UiScaleInput;
	readonly mapBoundsPx?: Readonly<{ topPx: number; bottomPx: number }>;
	readonly fullResolution?: boolean;
}

export interface DetectTeesResult {
	readonly uiScalePx: UiScalePx;
	readonly results: readonly TeePadVariantResult[];
}

export type CourseDetectionProgressStage =
	| 'opencv'
	| 'baskets'
	| 'templates'
	| 'numbers'
	| 'tees'
	| 'grammar';

export interface CourseDetectionProgress {
	readonly stage: CourseDetectionProgressStage;
	readonly message: string;
	/** Milliseconds elapsed since the detect-course request began. */
	readonly elapsedMs?: number;
}

interface BasketWorkerSuccess {
	ok: true;
	token: string;
	kind: 'detect' | 'detect-course' | 'prewarm' | 'detect-tees' | 'local-snap';
	candidates?: readonly BasketCandidate[];
	course?: CourseDetectionResult;
	uiScalePx?: number;
	results?: readonly TeePadVariantResult[];
	snapped?: LocalSnapPoint | null;
}

interface BasketWorkerProgress {
	ok: true;
	token: string;
	kind: 'progress';
	progress: CourseDetectionProgress;
}

interface BasketWorkerFailure {
	ok: false;
	token: string;
	kind: 'detect' | 'detect-course' | 'prewarm' | 'detect-tees' | 'local-snap';
	message: string;
}

type BasketWorkerReply = BasketWorkerSuccess | BasketWorkerProgress | BasketWorkerFailure;

interface BasketDetectionRequest {
	readonly kind: 'detect' | 'detect-course';
	readonly token: string;
	readonly basePath: string;
	readonly bitmap: ImageBitmap;
	readonly widthPx: number;
	readonly heightPx: number;
}

interface BasketPrewarmRequest {
	readonly kind: 'prewarm';
	readonly token: string;
	readonly basePath: string;
}

interface TeeDetectionRequest {
	readonly kind: 'detect-tees';
	readonly token: string;
	readonly basePath: string;
	readonly bitmap: ImageBitmap;
	readonly widthPx: number;
	readonly heightPx: number;
	readonly variants: readonly TeePadVariant[];
	readonly uiScalePx?: UiScalePx;
	readonly mapBoundsPx?: { topPx: number; bottomPx: number };
	readonly fullResolution?: boolean;
}

interface LocalSnapWorkerRequest {
	readonly kind: 'local-snap';
	readonly token: string;
	readonly basePath: string;
	readonly bitmap: ImageBitmap;
	readonly snapKind: LocalSnapKind;
	readonly clickPx: LocalSnapPoint;
	readonly numberAnchor: { scale: number; widthPx: number; heightPx: number };
}

type BasketWorkerRequest =
	| BasketDetectionRequest
	| BasketPrewarmRequest
	| TeeDetectionRequest
	| LocalSnapWorkerRequest;

interface PendingRequest {
	readonly worker: Worker;
	readonly resolve: (reply: BasketWorkerSuccess | BasketWorkerFailure) => void;
	readonly reject: (reason: Error) => void;
	readonly onProgress?: (progress: CourseDetectionProgress) => void;
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
	return typeof message === 'string' && message ? message : 'Basket detection worker failed.';
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
	if (reply.ok && reply.kind === 'progress') {
		pending.onProgress?.(reply.progress);
		return;
	}
	pendingRequests.delete(reply.token);
	if (reply.ok) pending.resolve(reply);
	else {
		retireWorker(worker, reply.message);
		pending.reject(new Error(reply.message));
	}
}

function getWorker(): Worker {
	if (activeWorker) return activeWorker;
	const worker = new Worker(new URL('./basketDetection.worker.ts', import.meta.url), { type: 'module' });
	worker.addEventListener('message', (event: MessageEvent<BasketWorkerReply>) => handleWorkerMessage(worker, event));
	worker.addEventListener('error', (event) => retireWorker(worker, workerErrorMessage(event)));
	worker.addEventListener('messageerror', (event) => retireWorker(worker, workerErrorMessage(event)));
	activeWorker = worker;
	return worker;
}

function postToWorker(
	request: BasketWorkerRequest,
	transfer: Transferable[] = [],
	onProgress?: (progress: CourseDetectionProgress) => void
): Promise<BasketWorkerSuccess | BasketWorkerFailure> {
	const worker = getWorker();
	return new Promise((resolve, reject) => {
		pendingRequests.set(request.token, { worker, resolve, reject, onProgress });
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
		throw new Error('CV detection requires a browser with Web Worker support.');
	}
}

export function prewarmBasketDetection(): Promise<void> {
	assertWorkerSupport();
	const worker = getWorker();
	if (prewarmWorker === worker && prewarmPromise) return prewarmPromise;
	const token = nextToken();
	prewarmWorker = worker;
	const warming = postToWorker({ kind: 'prewarm', token, basePath: base }).then((reply) => {
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

function validDimensions(widthPx: number, heightPx: number): void {
	if (!Number.isFinite(widthPx) || !Number.isFinite(heightPx) || widthPx <= 0 || heightPx <= 0) {
		throw new Error(`CV detection received invalid image dimensions (${widthPx} × ${heightPx}).`);
	}
}

async function sourceBitmap(bytes: Uint8Array, mimeType: string): Promise<ImageBitmap> {
	if (typeof createImageBitmap === 'undefined') {
		throw new Error('CV detection requires a browser with ImageBitmap support.');
	}
	return createImageBitmap(new Blob([bytes as BufferSource], { type: mimeType }));
}

export async function detectBasketCandidates(
	bytes: Uint8Array,
	mimeType: string,
	widthPx: number,
	heightPx: number
): Promise<readonly BasketCandidate[]> {
	assertWorkerSupport();
	validDimensions(widthPx, heightPx);
	const bitmap = await sourceBitmap(bytes, mimeType);
	const token = nextToken();
	try {
		const reply = await postToWorker(
			{ kind: 'detect', token, basePath: base, bitmap, widthPx, heightPx },
			[bitmap as unknown as Transferable]
		);
		if (!reply.ok) throw new Error(reply.message);
		if (reply.kind !== 'detect' || !reply.candidates) {
			throw new Error('Basket detection worker returned an invalid detection reply.');
		}
		return reply.candidates;
	} catch (error) {
		bitmap.close();
		throw error;
	}
}

export async function detectCourseCandidates(
	bytes: Uint8Array,
	mimeType: string,
	widthPx: number,
	heightPx: number,
	onProgress?: (progress: CourseDetectionProgress) => void
): Promise<CourseDetectionResult> {
	assertWorkerSupport();
	validDimensions(widthPx, heightPx);
	const bitmap = await sourceBitmap(bytes, mimeType);
	const token = nextToken();
	try {
		const reply = await postToWorker(
			{ kind: 'detect-course', token, basePath: base, bitmap, widthPx, heightPx },
			[bitmap as unknown as Transferable],
			onProgress
		);
		if (!reply.ok) throw new Error(reply.message);
		if (reply.kind !== 'detect-course' || !reply.course) {
			throw new Error('Course detection worker returned an invalid detection reply.');
		}
		if (reply.course.performance) {
			console.info('[ChainSpot CV benchmark]', reply.course.performance);
			console.table(reply.course.performance.stages);
		}
		return reply.course;
	} catch (error) {
		bitmap.close();
		throw error;
	}
}

export async function detectTees(
	bytes: Uint8Array,
	mimeType: string,
	widthPx: number,
	heightPx: number,
	options: DetectTeesOptions = {}
): Promise<DetectTeesResult> {
	assertWorkerSupport();
	validDimensions(widthPx, heightPx);
	const bitmap = await sourceBitmap(bytes, mimeType);
	const token = nextToken();
	const explicitUiScale =
		options.uiScalePx === undefined
			? undefined
			: asUiScalePx(options.uiScalePx, 'Explicit browser tee UI scale');
	try {
		const reply = await postToWorker(
			{
				kind: 'detect-tees',
				token,
				basePath: base,
				bitmap,
				widthPx,
				heightPx,
				variants: options.variants ?? (['gray-center', 'edge-loop', 'fused'] as const),
				uiScalePx: explicitUiScale,
				mapBoundsPx: options.mapBoundsPx,
				fullResolution: options.fullResolution
			},
			[bitmap as unknown as Transferable]
		);
		if (!reply.ok) throw new Error(reply.message);
		if (reply.kind !== 'detect-tees' || !Number.isFinite(reply.uiScalePx) || !reply.results) {
			throw new Error('Tee detection worker returned an invalid detection reply.');
		}
		return {
			uiScalePx: asUiScalePx(reply.uiScalePx as number, 'Worker tee UI scale'),
			results: reply.results
		};
	} catch (error) {
		bitmap.close();
		throw error;
	}
}

export interface LocalSnapRequestOptions {
	readonly kind: LocalSnapKind;
	readonly clickPx: LocalSnapPoint;
	/** The same number-badge anchor `detectCourse`'s result already carries (`courseDetection.numberDetection.anchor`); the worker re-derives `UiScalePx`/`BasketTemplateScale` from it itself. */
	readonly numberAnchor: { scale: number; widthPx: number; heightPx: number };
}

/**
 * "Snap-to-detection" (see `src/lib/cv/localSnap.ts`'s doc comment for the
 * main-thread-vs-worker choice this makes). Routes through the same
 * `basketDetection.worker.ts` instance every other detection call uses --
 * typically already warm after "Detect course"/"Detect tees" -- rather than
 * loading a second OpenCV WASM runtime on the main thread. Never throws for
 * "nothing found": resolves to `null` exactly like a failed local pass
 * should. Callers on a latency budget (this feature's own wiring included)
 * should not await this before placing the raw click -- see
 * `annotate-round/+page.svelte`'s optimistic-placement call site.
 */
export async function requestLocalSnap(
	bytes: Uint8Array,
	mimeType: string,
	options: LocalSnapRequestOptions
): Promise<LocalSnapPoint | null> {
	assertWorkerSupport();
	const bitmap = await sourceBitmap(bytes, mimeType);
	const token = nextToken();
	try {
		const reply = await postToWorker(
			{
				kind: 'local-snap',
				token,
				basePath: base,
				bitmap,
				snapKind: options.kind,
				clickPx: options.clickPx,
				numberAnchor: options.numberAnchor
			},
			[bitmap as unknown as Transferable]
		);
		if (!reply.ok) throw new Error(reply.message);
		if (reply.kind !== 'local-snap') {
			throw new Error('Local snap worker returned an invalid reply.');
		}
		return reply.snapped ?? null;
	} catch (error) {
		bitmap.close();
		throw error;
	}
}
