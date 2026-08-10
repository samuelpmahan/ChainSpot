/** Throwaway: visualize raw Canny edge output near hole 7 at a few threshold pairs. */
import { readFileSync, writeFileSync } from 'node:fs';
import jpeg from 'jpeg-js';
import { strFromU8, unzipSync } from 'fflate';
import { PNG } from 'pngjs';
import { loadCv } from '../src/lib/stitch/cvMatch';

async function main(): Promise<void> {
	const bytes = new Uint8Array(readFileSync('resources/GoldenTeeSet.chainspot.zip'));
	const entries = unzipSync(bytes);
	const decoded = jpeg.decode(Buffer.from(entries['images/source-original.jpg']), { useTArray: true });
	const cv: any = await loadCv(); // eslint-disable-line @typescript-eslint/no-explicit-any
	const gray = new Uint8Array(decoded.width * decoded.height);
	for (let p = 0, o = 0; p < gray.length; p += 1, o += 4) gray[p] = (decoded.data[o] * 0.299 + decoded.data[o + 1] * 0.587 + decoded.data[o + 2] * 0.114 + 0.5) | 0;
	const x0 = 350,
		y0 = 850,
		cropW = 350,
		cropH = 350;
	const cropGray = new Uint8Array(cropW * cropH);
	for (let y = 0; y < cropH; y += 1) for (let x = 0; x < cropW; x += 1) cropGray[y * cropW + x] = gray[(y0 + y) * decoded.width + (x0 + x)];
	const grayMat = new cv.Mat(cropH, cropW, cv.CV_8UC1);
	grayMat.data.set(cropGray);
	const blurred = new cv.Mat();
	cv.GaussianBlur(grayMat, blurred, new cv.Size(3, 3), 0, 0, cv.BORDER_DEFAULT);
	for (const [t1, t2] of [
		[20, 60],
		[40, 120],
		[10, 30]
	]) {
		const edges = new cv.Mat();
		cv.Canny(blurred, edges, t1, t2);
		const png = new PNG({ width: cropW, height: cropH });
		for (let i = 0; i < cropW * cropH; i += 1) {
			const v = edges.data[i];
			const o = i * 4;
			png.data[o] = v;
			png.data[o + 1] = v;
			png.data[o + 2] = v;
			png.data[o + 3] = 255;
		}
		writeFileSync(`/tmp/claude-0/-home-user-ChainSpot/ac93230d-47cf-5c69-9b31-e29eac6e7ade/scratchpad/canny-${t1}-${t2}.png`, PNG.sync.write(png));
		edges.delete();
	}
	console.log('done');
}
main();
