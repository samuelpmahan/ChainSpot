import { loadScopeInput } from './scripts/chainspot-lab/scope/operation.ts';
import { readDigitViewports } from './scripts/chainspot-lab/scope/digitViewport.ts';

async function main() {
  const imagePath = process.argv[2];
  const loaded = await loadScopeInput(imagePath);
  const readings = readDigitViewports(loaded.decoded.image);
  for (const r of readings) {
    console.log(JSON.stringify({ detId: r.detId, label: r.label, confidence: r.confidence, cxPx: r.cxPx, cyPx: r.cyPx }));
  }
}
main();
