import assert from 'node:assert/strict';
import test from 'node:test';
import { runS0CropFork } from '../../scripts/pxcube-s0-fork.mjs';

test('real S0 Crop clean stays authoritative while candidate is isolated and compared', async () => {
  const widthPx = 600, heightPx = 1000;
  const rgba = new Uint8ClampedArray(widthPx * heightPx * 4);
  for (let i = 0; i < rgba.length; i += 4) { rgba[i] = 90; rgba[i+1] = 120; rgba[i+2] = 150; rgba[i+3] = 255; }
  const fullImage = { imageId: 'fixture', widthPx, heightPx, rgba };
  const run = await runS0CropFork(fullImage, { top: 10, right: 0, bottom: 20, left: 0 });
  assert.equal(run.tick, 'source.cropUDiscChrome');
  assert.equal(run.authoritative.lineage, 'clean');
  assert.equal(run.observations[0].lineage, 'exp/manual-insets');
  assert.equal(run.observations[0].boundary, 'STOP');
  assert.equal(run.observations[0].output.heightPx, 970);
  assert.equal(run.observations[0].comparison.heightDeltaPx, run.observations[0].output.heightPx - run.authoritative.output.heightPx);
  assert.equal(typeof run.authoritative.elapsedMs, 'number');
  assert.equal(typeof run.observations[0].elapsedMs, 'number');
});
