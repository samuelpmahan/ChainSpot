// LAB tooling: run the (heavy, synchronous) threeFactor pipeline off the main
// thread. The algorithm itself is untouched — this is pure transport.
import { runThreeFactor } from '$lib/detectors/threeFactor';
import type { RgbaRaster } from '$lib/detect';

self.onmessage = (event: MessageEvent<RgbaRaster>) => {
	try {
		const t0 = performance.now();
		const run = runThreeFactor(event.data);
		self.postMessage({ ok: true, run, ms: Math.round(performance.now() - t0) });
	} catch (e) {
		self.postMessage({ ok: false, error: e instanceof Error ? e.message : String(e) });
	}
};
