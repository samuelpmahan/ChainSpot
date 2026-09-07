import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { serialize } from 'node:v8';
import { PNG } from 'pngjs';
import { decodeNodeFile } from '../../packages/alg/src/adapters/node';
import { compareProof } from '../../packages/alg/src/stages/S0/exp/mermaid-pcr/proof';
import { MermaidExecutionError } from '../../packages/alg/src/stages/S0/exp/mermaid-pcr/runner';
import type { CompositeResult } from '../../packages/alg/src/g0/composite';
import type { PixelSet, OwnedBadge } from '../../packages/alg/src/stages/S1/exp/badge-assembly/ownership';

async function main() {
 const input = resolve(process.argv[2] ?? '../smoke-inputs-fa44/DashsTrack-full.jpg');
 const out = resolve(process.argv[3] ?? 'artifacts/mermaid-s0-s1');
 const text = (path: string) => readFile(path, 'utf8');
 await mkdir(out, { recursive: true });
 console.log(`S0 and S1 Mermaid proof: ${input}`);
 try {
  const result = await compareProof({ source: input, decode: decodeNodeFile,
   s0Graph: await text('experiments/mermaid-s0-s1/S0.mmd'), s0Args: await text('experiments/mermaid-s0-s1/S0.args.json'),
   s1Graph: await text('experiments/mermaid-s0-s1/S1.mmd'), s1Args: await text('experiments/mermaid-s0-s1/S1.args.json'),
   existingS1: await text('packages/alg/src/stages/S1/exp/badge-assembly/PrincipleComponentRender.yaml') });
  await writeFile(`${out}/S0.pcr.yaml`, result.s0Yaml);
  await writeFile(`${out}/S1.pcr.yaml`, result.s1Yaml);
  // Binary trace retains typed arrays and shared object identity without giant JSON arrays.
  await writeFile(`${out}/actual-runs.v8`, serialize({ s0: result.generated.run, s1: result.generatedS1 }));
  const image = result.generated.pxc.get<CompositeResult>('px.course.canonicalPixels');
  const writePng = async (name: string, rgba: Uint8Array | Uint8ClampedArray) => {
   const png = new PNG({ width: image.widthPx, height: image.heightPx });
   png.data = Buffer.from(rgba); await writeFile(`${out}/${name}.png`, PNG.sync.write(png));
  };
  await writePng('canonical', image.rgba);
  await writePng('baseline-canonical', result.baseline.croppedImage.rgba);
  for (const [name, address] of [['owned', 'px.badges.px'], ['muted', 'px.badges.muted'], ['remaining', 'px.remaining.afterBadges']]) {
   const pixels = result.generated.pxc.get<PixelSet>(address);
   const rgba = new Uint8Array(image.widthPx * image.heightPx * 4);
   for (let p = 0; p < rgba.length; p += 4) rgba[p + 3] = 255;
   for (const p of pixels.pixels) { rgba[p * 4] = 255; rgba[p * 4 + 1] = 255; rgba[p * 4 + 2] = 255; }
   await writePng(name, rgba);
  }
  const receipt = { ok: result.ok, input, checks: result.checks,
   badges: result.generated.pxc.get<OwnedBadge[]>('px.badges.objects').map(b => ({ id: b.id, reading: b.reading, unaccountedButOwned: b.unaccountedButOwned.bbox })),
   calls: [...result.generated.run.calls, ...result.generatedS1.calls].map(({ inputs, output, ...call }) => call),
   inspection: 'actual-runs.v8 preserves actual inputs/outputs; masks show exact sets separately.' };
  await writeFile(`${out}/receipt.json`, JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify({ ok: result.ok, checks: result.checks, output: out }, null, 2));
  if (!result.ok) process.exitCode = 1;
 } catch (error) {
  if (error instanceof MermaidExecutionError) {
   await writeFile(`${out}/failed-run.v8`, serialize(error.run));
   await writeFile(`${out}/failure.json`, JSON.stringify({ name: error.run.name, calls: error.run.calls.map(({ inputs, output, ...call }) => call) }, null, 2));
  }
  throw error;
 }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
