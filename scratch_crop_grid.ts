import { loadScopeInput } from './scripts/chainspot-lab/scope/operation.ts';
import fs from 'node:fs';
import { PNG } from 'pngjs';

async function main() {
  const imagePath = process.argv[2];
  const minX = parseFloat(process.argv[3]);
  const minY = parseFloat(process.argv[4]);
  const w = parseFloat(process.argv[5]);
  const h = parseFloat(process.argv[6]);
  const zoom = parseFloat(process.argv[7] || '3');
  const outPath = process.argv[8];
  const loaded = await loadScopeInput(imagePath);
  const image = loaded.decoded.image;
  const out = new PNG({ width: w * zoom, height: h * zoom });
  for (let y = 0; y < h * zoom; y++) {
    for (let x = 0; x < w * zoom; x++) {
      const sx = minX + Math.floor(x / zoom);
      const sy = minY + Math.floor(y / zoom);
      const idxOut = (w * zoom * y + x) << 2;
      if (sx < 0 || sy < 0 || sx >= image.width || sy >= image.height) { continue; }
      const idxIn = (image.width * sy + sx) << 2;
      out.data[idxOut] = image.data[idxIn];
      out.data[idxOut + 1] = image.data[idxIn + 1];
      out.data[idxOut + 2] = image.data[idxIn + 2];
      out.data[idxOut + 3] = 255;
    }
  }
  // grid every 20 source px
  for (let sx = Math.ceil(minX / 20) * 20; sx < minX + w; sx += 20) {
    const x = Math.round((sx - minX) * zoom);
    for (let y = 0; y < out.height; y++) {
      const idx = (out.width * y + x) << 2;
      if (x >= 0 && x < out.width) { out.data[idx] = 255; out.data[idx+1] = 0; out.data[idx+2] = 0; out.data[idx+3] = 120; }
    }
  }
  for (let sy = Math.ceil(minY / 20) * 20; sy < minY + h; sy += 20) {
    const y = Math.round((sy - minY) * zoom);
    for (let x = 0; x < out.width; x++) {
      const idx = (out.width * y + x) << 2;
      if (y >= 0 && y < out.height) { out.data[idx] = 255; out.data[idx+1] = 0; out.data[idx+2] = 0; out.data[idx+3] = 120; }
    }
  }
  fs.writeFileSync(outPath, PNG.sync.write(out));
  console.log('wrote', outPath, 'origin=', minX, minY, 'grid=20px(red)');
}
main();
