/** Opt-in Stage experiments. The pre-existing Sweep/default path remains unchanged. */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { PNG } from 'pngjs';
import { decodeNodeFile } from '@chainspot/alg/adapters/node';
import { ComponentPxC } from '@chainspot/alg/stages/componentPxC';
import { BadgePxC } from '@chainspot/alg/stages/S1/clean/Badge';
import { BasketPxC } from '@chainspot/alg/stages/S2/clean/Basket';
import { TeePxC, type Tee } from '@chainspot/alg/stages/S3/clean/Tee';
import type { StageContract, StageOutput, StagePanel } from '@chainspot/alg/stages/contract';
import { discoverStageContracts, renderProgression, stroke } from './stageOperation';
import { capturePxC, digest, restorePxC, snapshotIdentity } from './pxcSnapshot';

const require = createRequire(import.meta.url);
const PREFIX_ADDRESSES = [...new Set([
  'px.source.selectedInput', 'px.source.fullImage', 'px.course.canonicalPixels',
  ...Object.values(ComponentPxC).map(key => key.address),
  ...Object.values(BadgePxC).map(key => key.address),
  ...Object.values(BasketPxC).map(key => key.address)
])];
const TEE_ADDRESSES = Object.values(TeePxC).map(key => key.address);

function hashTree(root: string): string {
  const files: [string, string][] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(js|json)$/.test(entry.name)) files.push([path.slice(root.length), digest(readFileSync(path))]);
    }
  };
  walk(root);
  return digest(JSON.stringify(files));
}

function atomicWrite(path: string, data: string | Uint8Array): void {
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, data);
  renameSync(temp, path);
}

/** Materialization only: exact raster bytes and existing Stage-declared boxes. */
function nativePanel(panel: StagePanel): PNG {
  const png = new PNG({ width: panel.widthPx, height: panel.heightPx, colorType: 6 });
  png.data.set(panel.rgba);
  // Transparent ownership subtraction must be visible, not flattened onto black.
  for (let pixel = 0; pixel < panel.widthPx * panel.heightPx; pixel++) {
    const alpha = png.data[pixel * 4 + 3] / 255;
    if (alpha === 1) continue;
    const x = pixel % panel.widthPx, y = Math.floor(pixel / panel.widthPx);
    const checker = (Math.floor(x / 8) + Math.floor(y / 8)) % 2 ? 170 : 225;
    for (let c = 0; c < 3; c++) png.data[pixel * 4 + c] = Math.round(png.data[pixel * 4 + c] * alpha + checker * (1 - alpha));
    png.data[pixel * 4 + 3] = 255;
  }
  for (const box of panel.boxes ?? []) stroke(png, ...box.bbox, box.color);
  return png;
}

export async function runStageExperimentCli(args: readonly string[]): Promise<void> {
  const rest = [...args];
  const flag = (name: string): string | undefined => {
    const index = rest.indexOf(name);
    if (index < 0) return;
    const value = rest[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${name} requires a value.`);
    rest.splice(index, 2);
    return value;
  };
  const through = flag('--through');
  const variant = flag('--exp') ?? 'clean';
  const warmIndex = rest.indexOf('--warm');
  if (warmIndex >= 0) rest.splice(warmIndex, 1);
  if (through !== 'S3' || rest.length !== 1 || !/^[a-z][a-z0-9-]*$/.test(variant))
    throw new Error('Usage: lab sweep --through S3 --warm [--exp NAME] INPUT (one image; opt-in S3 lane).');
  const source = resolve(rest[0]);
  if (!['.png', '.jpg', '.jpeg'].includes(extname(source).toLowerCase())) throw new Error('Stage input must be PNG/JPG/JPEG.');
  const adapters = discoverStageContracts();
  const target = variant === 'clean'
    ? adapters.find(stage => stage.id === 'S3')
    : (() => {
      const path = resolve('packages/alg/dist/stages/S3/exp', variant, 'contract.js');
      if (!existsSync(path)) throw new Error(`Experimental Stage contract not found: ${path}`);
      return (require(path) as { stageContract: StageContract }).stageContract;
    })();
  if (!target || target.id !== 'S3') throw new Error('Expected an S3 Stage contract.');
  const started = performance.now();
  const identity = {
    schema: 'stage-prefix-pxc-v1', source, inputSha256: digest(readFileSync(source)),
    compiledAlgSha256: hashTree(resolve('packages/alg/dist')),
    dependencySha256: digest(readFileSync('package-lock.json')),
    labDependencySha256: digest(readFileSync('scripts/chainspot-lab/package-lock.json')),
    adapterSha256: digest(readFileSync(new URL('./stageExperiment.ts', import.meta.url))),
    snapshotAdapterSha256: digest(readFileSync(new URL('./pxcSnapshot.ts', import.meta.url))),
    runtime: `${process.version}/${process.platform}/${process.arch}`, through: 'S2'
  };
  const key = snapshotIdentity(identity);
  const cacheDir = resolve('artifacts', 'pxc-cache', key);
  const statePath = join(cacheDir, 'prefix.pxc.bin');
  const metaPath = join(cacheDir, 'prefix.json');
  const cacheHit = warmIndex >= 0 && existsSync(statePath) && existsSync(metaPath);
  let snapshot: Buffer;
  let upstreamReceipts: string[];
  if (cacheHit) {
    const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
    snapshot = readFileSync(statePath);
    if (meta.key !== key || meta.sha256 !== digest(snapshot)) throw new Error('Warm PxC identity/checksum mismatch; refusing reuse.');
    upstreamReceipts = meta.receipts;
  } else {
    let prior: StageOutput | undefined;
    upstreamReceipts = [];
    for (const id of ['S0', 'S1', 'S2']) {
      const adapter = adapters.find(stage => stage.id === id);
      if (!adapter) throw new Error(`Missing upstream Stage ${id}.`);
      prior = await adapter.execute({ source, inputLabel: basename(source), decode: decodeNodeFile, pxc: prior?.pxc });
      upstreamReceipts.push(prior.receiptText);
    }
    snapshot = capturePxC(prior!.pxc, PREFIX_ADDRESSES);
    if (warmIndex >= 0) {
      mkdirSync(cacheDir, { recursive: true });
      atomicWrite(statePath, snapshot);
      atomicWrite(metaPath, JSON.stringify({ key, identity, sha256: digest(snapshot), addresses: PREFIX_ADDRESSES, receipts: upstreamReceipts }, null, 2));
    }
  }
  const upstreamMs = performance.now() - started;
  const pxc = restorePxC(snapshot);
  const beforePixels = digest(pxc.get(ComponentPxC.image).rgba);
  const computeStart = performance.now();
  const output = await target.execute({ source, inputLabel: basename(source), decode: decodeNodeFile, pxc });
  const computeMs = performance.now() - computeStart;
  if (digest(output.pxc.get(ComponentPxC.image).rgba) !== beforePixels) throw new Error('Stage mutated canonical pixels.');
  const badges = output.pxc.get(BadgePxC.objects);
  const baskets = output.pxc.get(BasketPxC.objects);
  const selectionAddress = output.pxc.has('px.tees.exp.objects') ? 'px.tees.exp.objects' : TeePxC.objects.address;
  const tees = output.pxc.get<readonly (Pick<Tee, 'center' | 'bbox' | 'angleRad' | 'px'> & { readonly has: unknown })[]>(selectionAddress);
  const family = output.pxc.get(TeePxC.family);
  const members = new Set(family.members.map(member => member.frame.label));
  const runId = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const outDir = resolve('artifacts', 'sweep', 'stage-experiments', basename(source, extname(source)), variant, runId);
  mkdirSync(outDir, { recursive: true });
  const panels = output.panels.map((panel, index) => {
    const file = `${String(index + 1).padStart(2, '0')}-${panel.label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.png`;
    writeFileSync(join(outDir, file), PNG.sync.write(nativePanel(panel)));
    return { label: panel.label, path: file };
  });
  writeFileSync(join(outDir, 'progression.png'), PNG.sync.write(renderProgression(output.panels)));
  const extra = ['px.tees.exp.pcr', 'px.tees.exp.selectionFn', 'px.tees.exp.interior', 'px.tees.exp.audit', 'px.tees.exp.objects'].filter(address => output.pxc.has(address));
  const retained = capturePxC(output.pxc, [...PREFIX_ADDRESSES, ...TEE_ADDRESSES, ...extra]);
  writeFileSync(join(outDir, 'pxc.bin'), retained);
  const receipt = {
    schemaVersion: 1, runId, source, variant, selectionAddress, throughStage: 'S3', identity,
    cache: { key, hit: cacheHit, upstreamExecuted: !cacheHit, addresses: PREFIX_ADDRESSES },
    timing: { upstreamMs, computeMs, totalMs: performance.now() - started },
    canonicalPixelsUnchanged: true,
    counts: { badges: badges.length, baskets: baskets.length, tees: tees.length },
    badgeLabels: badges.map(b => b.label),
    family: family.measured.map(m => ({ selected: members.has(m.frame.label), ring: m.ring, frame: m.frame })),
    tees: tees.map(tee => ({ center: tee.center, bbox: tee.bbox, angleRad: tee.angleRad, ownedPx: tee.px.length, has: tee.has })),
    pcr: output.pxc.has('px.tees.exp.pcr') ? output.pxc.get('px.tees.exp.pcr') : null,
    experimentAudit: output.pxc.has('px.tees.exp.audit') ? output.pxc.get('px.tees.exp.audit') : null,
    pcrStatus: variant === 'clean' ? 'not exposed by clean Stage adapter' : 'retained',
    semanticCorrectness: 'UNKNOWN', recovery: 'NOT RUN', pathfinding: 'NOT RUN', promotion: 'NONE',
    artifacts: { panels, progression: 'progression.png', pxc: { path: 'pxc.bin', sha256: digest(retained) } },
    replay: `./lab sweep --through S3 --warm${variant === 'clean' ? '' : ` --exp ${variant}`} ${JSON.stringify(source)}`
  };
  writeFileSync(join(outDir, 'run.receipt.json'), JSON.stringify(receipt, null, 2));
  writeFileSync(join(outDir, 'run.receipt.txt'), [
    `S0–S2: ${cacheHit ? 'CACHE HIT — prior receipt, not rerun' : 'EXECUTED'}`,
    ...upstreamReceipts, output.receiptText, `cache key: ${key}`,
    `canonical pixels unchanged: true`, `semantic correctness: UNKNOWN`, `promotion: NONE`, receipt.replay
  ].join('\n\n') + '\n');
  console.log(`STAGE EXPERIMENT ${variant}: badges=${badges.length} baskets=${baskets.length} tees=${tees.length}`);
  console.log(`PxC: ${cacheHit ? 'HIT (S0–S2 not rerun)' : 'COLD'}; S3=${computeMs.toFixed(1)}ms; total=${receipt.timing.totalMs.toFixed(1)}ms`);
  console.log(`SEMANTICS UNKNOWN; RECOVERY NOT RUN; PATHFINDING NOT RUN; PROMOTION NONE`);
  console.log(`receipt: ${join(outDir, 'run.receipt.json')}`);
}
