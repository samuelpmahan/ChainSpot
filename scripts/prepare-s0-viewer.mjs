import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { PNG } from 'pngjs';
import { executeNodeCanonicalInputTick } from '../packages/alg/dist/exec/node-intake.js';
import { formatS0ReceiptText } from '../packages/alg/dist/stages/S0/clean/index.js';

// Materialize the viewer's saved snapshot with the same frozen S0 as LAB.
// Browser view controls consume these outputs; they never rerun the stage.
export async function prepareS0Viewer(routeRoot, assetRoot) {
	const sourcePath = 'experiments/dashs-track-edge-sensing/restored/edge-diagnostic/edge-reading-inspection/DashsTrack-full.jpg';
	const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
	const run = await executeNodeCanonicalInputTick(resolve(sourcePath));
	mkdirSync(assetRoot, { recursive: true });
	const panels = [run.fullImage, run.croppedImage].map((raster, index) => {
		const label = index === 0 ? 'FullImage' : 'CroppedImage';
		const filename = `${label}.png`;
		writeFileSync(join(assetRoot, filename), PNG.sync.write({ width: raster.widthPx, height: raster.heightPx, data: Buffer.from(raster.rgba) }));
		return { label, filename, widthPx: raster.widthPx, heightPx: raster.heightPx, imageId: raster.imageId,
			address: index === 0 ? 'px.source.fullImage' : 'px.course.canonicalPixels' };
	});
	const receipt = formatS0ReceiptText(run, { inputLabel: 'DashsTrack-full.jpg' });
	const snapshot = { sourceSha, sourcePath, panels, crop: run.cropReceipt, receipt,
		contract: readFileSync('packages/alg/src/stages/S0/contract.ts', 'utf8') };
	writeFileSync(join(assetRoot, 'snapshot.json'), `${JSON.stringify(snapshot, null, 2)}\n`);
	writeFileSync(join(assetRoot, 'S0.receipt.txt'), `${receipt}\n`);
	writeFileSync(join(routeRoot, '+page.server.js'), `export function load() { return ${JSON.stringify(snapshot)}; }\n`);
	console.log(`S0_VIEWER ${panels.map(p => `${p.label}=${p.widthPx}x${p.heightPx}`).join(' ')} source=${sourceSha}`);
}
