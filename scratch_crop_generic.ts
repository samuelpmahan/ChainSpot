import { loadScopeInput } from './scripts/chainspot-lab/scope/operation.ts';
import fs from 'node:fs';
import { PNG } from 'pngjs';

async function main() {
  const imagePath = process.argv[2];
  const cx = parseFloat(process.argv[3]);
  const cy = parseFloat(process.argv[4]);
  const margin = parseFloat(process.argv[5] || '250');
  const zoom = parseFloat(process.argv[6] || '2');
  const outPath = process.argv[7];
  const loaded = await loadScopeInput(imagePath);
  const image = loaded.decoded.image; // { width, height, data(RGBA) }
  const minX = Math.max(0, Math.floor(cx - margin));
  const maxX = Math.min(image.width, Math.ceil(cx + margin));
  const minY = Math.max(0, Math.floor(cy - margin));
  const maxY = Math.min(image.height, Math.ceil(cy + margin));
  const w = maxX - minX, h = maxY - minY;
  const out = new PNG({ width: w * zoom, height: h * zoom });
  for (let y = 0; y < h * zoom; y++) {
    for (let x = 0; x < w * zoom; x++) {
      const sx = minX + Math.floor(x / zoom);
      const sy = minY + Math.floor(y / zoom);
      const idxOut = (w * zoom * y + x) << 2;
      const idxIn = (image.width * sy + sx) << 2;
      out.data[idxOut] = image.data[idxIn];
      out.data[idxOut + 1] = image.data[idxIn + 1];
      out.data[idxOut + 2] = image.data[idxIn + 2];
      out.data[idxOut + 3] = 255;
    }
  }
  fs.writeFileSync(outPath, PNG.sync.write(out));
  console.log('wrote', outPath, w, 'x', h, '(image', image.width, 'x', image.height, ')');
}
main();
