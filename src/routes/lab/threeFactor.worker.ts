// LAB tooling: run the (heavy, synchronous) threeFactor pipeline off the main
// thread. The algorithm itself is untouched — this is pure transport.
// Message: a bare RgbaRaster (legacy) or { raster, config?, paramsHash? }.
import { runThreeFactor, type ResolvedConfig } from '$lib/detectors/threeFactor';
import type { RgbaRaster } from '$lib/detect';

interface RunRequest {
	readonly raster: RgbaRaster;
	readonly config?: ResolvedConfig;
	readonly paramsHash?: string;
}

self.onmessage = (event: MessageEvent<RgbaRaster | RunRequest>) => {
	try {
		const request: RunRequest =
			'imageId' in event.data ? { raster: event.data as RgbaRaster } : (event.data as RunRequest);
		const t0 = performance.now();
		const run = runThreeFactor(request.raster, {
			config: request.config,
			paramsHash: request.paramsHash
		});
		const transfers = run.trace
			? Object.values(run.trace.heatmaps).map((heatmap) => heatmap.buffer as ArrayBuffer)
			: [];
		// materialize the trace's lazy units getter for structured clone
		const payload = run.trace
			? { ...run, trace: { ...run.trace, units: [...run.trace.units] } }
			: run;
		(self as unknown as Worker).postMessage(
			{ ok: true, run: payload, ms: Math.round(performance.now() - t0) },
			transfers
		);
	} catch (e) {
		self.postMessage({ ok: false, error: e instanceof Error ? e.message : String(e) });
	}
};
