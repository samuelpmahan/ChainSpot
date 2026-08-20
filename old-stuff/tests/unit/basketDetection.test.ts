import { afterEach, describe, expect, it, vi } from 'vitest';

type ReplyListener = (event: MessageEvent) => void;
type ErrorListener = (event: Event) => void;

class FakeWorker {
	static instances: FakeWorker[] = [];
	readonly messages: Array<{ payload: unknown; transfer: Transferable[] | undefined }> = [];
	terminated = false;
	private readonly messageListeners = new Set<ReplyListener>();
	private readonly errorListeners = new Set<ErrorListener>();

	constructor(_url: URL, _options: WorkerOptions) {
		FakeWorker.instances.push(this);
	}

	addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
		if (type === 'message') this.messageListeners.add(listener as ReplyListener);
		if (type === 'error') this.errorListeners.add(listener as ErrorListener);
	}

	removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
		if (type === 'message') this.messageListeners.delete(listener as ReplyListener);
		if (type === 'error') this.errorListeners.delete(listener as ErrorListener);
	}

	postMessage(payload: unknown, transfer?: Transferable[]): void {
		this.messages.push({ payload, transfer });
	}

	terminate(): void {
		this.terminated = true;
	}

	emitMessage(data: unknown): void {
		for (const listener of this.messageListeners) listener({ data } as MessageEvent);
	}
}

afterEach(() => {
	FakeWorker.instances = [];
	vi.unstubAllGlobals();
	vi.resetModules();
});

describe('basket detection worker transport', () => {
	it('prewarms once, reuses that worker for detection, and transfers source-image coordinates', async () => {
		const bitmap = { close: vi.fn() } as unknown as ImageBitmap;
		const createBitmap = vi.fn().mockResolvedValue(bitmap);
		vi.stubGlobal('createImageBitmap', createBitmap);
		vi.stubGlobal('Worker', FakeWorker);
		const { detectBasketCandidates, prewarmBasketDetection } = await import(
			'../../src/lib/autoAnnotation/basketDetection'
		);

		const firstWarmup = prewarmBasketDetection();
		const secondWarmup = prewarmBasketDetection();
		expect(secondWarmup).toBe(firstWarmup);
		await vi.waitFor(() => expect(FakeWorker.instances).toHaveLength(1));
		const worker = FakeWorker.instances[0]!;
		expect(worker.messages).toHaveLength(1);
		const warmupRequest = worker.messages[0]!.payload as { kind: string; token: string };
		expect(warmupRequest.kind).toBe('prewarm');
		expect(worker.messages[0]!.transfer).toEqual([]);
		worker.emitMessage({ ok: true, kind: 'prewarm', token: warmupRequest.token });
		await expect(firstWarmup).resolves.toBeUndefined();

		const detection = detectBasketCandidates(new Uint8Array([1, 2, 3]), 'image/png', 1600, 900);
		await vi.waitFor(() => expect(worker.messages).toHaveLength(2));
		expect(createBitmap).toHaveBeenCalledTimes(1);

		const message = worker.messages[1]!;
		const request = message.payload as {
			kind: string;
			token: string;
			bitmap: ImageBitmap;
			widthPx: number;
			heightPx: number;
		};
		expect(request.kind).toBe('detect');
		expect(request.bitmap).toBe(bitmap);
		expect(request.widthPx).toBe(1600);
		expect(request.heightPx).toBe(900);
		expect(message.transfer).toEqual([bitmap]);

		worker.emitMessage({ ok: true, kind: 'detect', token: 'stale', candidates: [] });
		await Promise.resolve();
		expect(worker.terminated).toBe(false);

		const candidates = [
			{ xPx: 800, yPx: 720, score: 0.92, widthPx: 82, heightPx: 105, scale: 1 }
		] as const;
		worker.emitMessage({ ok: true, kind: 'detect', token: request.token, candidates });

		await expect(detection).resolves.toEqual(candidates);
		expect(FakeWorker.instances).toHaveLength(1);
		expect(worker.terminated).toBe(false);
	});

	it('rejects invalid dimensions before decoding or constructing a worker', async () => {
		const createBitmap = vi.fn();
		vi.stubGlobal('createImageBitmap', createBitmap);
		vi.stubGlobal('Worker', FakeWorker);
		const { detectBasketCandidates } = await import('../../src/lib/autoAnnotation/basketDetection');

		await expect(
			detectBasketCandidates(new Uint8Array([1]), 'image/png', 0, 900)
		).rejects.toThrow('invalid image dimensions');
		expect(createBitmap).not.toHaveBeenCalled();
		expect(FakeWorker.instances).toEqual([]);
	});

	it('detects tees and returns per-variant results with uiScalePx', async () => {
		const bitmap = { close: vi.fn() } as unknown as ImageBitmap;
		vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue(bitmap));
		vi.stubGlobal('Worker', FakeWorker);
		const { detectTees } = await import('../../src/lib/autoAnnotation/basketDetection');

		const detection = detectTees(new Uint8Array([1]), 'image/png', 1600, 900, {
			variants: ['gray-center', 'fused'],
			uiScalePx: 12.5,
			fullResolution: true
		});
		await vi.waitFor(() => expect(FakeWorker.instances).toHaveLength(1));
		const worker = FakeWorker.instances[0]!;
		await vi.waitFor(() => expect(worker.messages).toHaveLength(1));

		const request = worker.messages[0]!.payload as {
			kind: string;
			token: string;
			variants: string[];
			uiScalePx: number;
			fullResolution: boolean;
			bitmap: ImageBitmap;
		};
		expect(request.kind).toBe('detect-tees');
		expect(request.variants).toEqual(['gray-center', 'fused']);
		expect(request.uiScalePx).toBe(12.5);
		expect(request.fullResolution).toBe(true);
		expect(request.bitmap).toBe(bitmap);

		const results = [
			{
				variant: 'gray-center',
				candidates: [],
				stageCounts: { discovered: 0, final: 0 }
			},
			{
				variant: 'fused',
				candidates: [
					{
						xPx: 100,
						yPx: 200,
						orientationDeg: 0,
						widthPx: 30,
						heightPx: 20,
						score: 0.9,
						support: ['gray-center', 'edge-loop']
					}
				],
				stageCounts: { discovered: 1, grayCenter: 1, edgeLoop: 0, final: 1 }
			}
		] as const;
		worker.emitMessage({
			ok: true,
			kind: 'detect-tees',
			token: request.token,
			uiScalePx: 12.5,
			results
		});

		await expect(detection).resolves.toEqual({ uiScalePx: 12.5, results });
	});

	it('rejects when the tee detection worker reports an error', async () => {
		const bitmap = { close: vi.fn() } as unknown as ImageBitmap;
		vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue(bitmap));
		vi.stubGlobal('Worker', FakeWorker);
		const { detectTees } = await import('../../src/lib/autoAnnotation/basketDetection');

		const detection = detectTees(new Uint8Array([1]), 'image/png', 100, 100);
		await vi.waitFor(() => expect(FakeWorker.instances).toHaveLength(1));
		const worker = FakeWorker.instances[0]!;
		await vi.waitFor(() => expect(worker.messages).toHaveLength(1));

		const request = worker.messages[0]!.payload as { kind: string; token: string };
		expect(request.kind).toBe('detect-tees');
		worker.emitMessage({
			ok: false,
			kind: 'detect-tees',
			token: request.token,
			message: 'Worker tee error'
		});

		await expect(detection).rejects.toThrow('Worker tee error');
	});
});
