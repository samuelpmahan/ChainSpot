// Run the pure-TypeScript NuThing P1 port on one raster and dump a trace
// JSON shaped exactly like scripts/nuthing/p1_trace.py output, so
// parity.ts can compare the two structurally.
//
// Usage: npx tsx scripts/nuthing/run-p1.ts INPUT OUT_DIR [--name NAME]

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { runNuThingP1 } from '../../src/lib/nuthing/p1';
import type { ComponentStats } from '../../src/lib/nuthing/components';
import { CANON_SIZE } from '../../src/lib/nuthing/chamfer';
import { decodeImageFile } from './decode';

function componentRow(c: ComponentStats) {
  return {
    label: c.label,
    cx: c.cx,
    cy: c.cy,
    area: c.area,
    bbox: [c.bboxX, c.bboxY, c.bboxW, c.bboxH],
    major: c.major,
    minor: c.minor,
    angle: c.angle,
    fill: c.fill,
  };
}

function maskRows(mask: Uint8Array): string[] {
  const rows: string[] = [];
  for (let y = 0; y < CANON_SIZE; y++) {
    let row = '';
    for (let x = 0; x < CANON_SIZE; x++) row += mask[y * CANON_SIZE + x] ? '1' : '0';
    rows.push(row);
  }
  return rows;
}

function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function main(): void {
  const args = process.argv.slice(2);
  const nameIdx = args.indexOf('--name');
  let name: string | null = null;
  if (nameIdx >= 0) {
    name = args[nameIdx + 1];
    args.splice(nameIdx, 2);
  }
  const [input, outDir] = args;
  if (!input || !outDir) {
    console.error('Usage: tsx scripts/nuthing/run-p1.ts INPUT OUT_DIR [--name NAME]');
    process.exit(1);
  }
  name = name ?? basename(input).replace(/\.(rgba\.bin|png|jpe?g)$/i, '');
  mkdirSync(outDir, { recursive: true });

  const image = decodeImageFile(input);
  const t0 = performance.now();
  const result = runNuThingP1(image);
  const elapsed = (performance.now() - t0) / 1000;

  const rgba =
    image.data instanceof Uint8Array ? image.data : new Uint8Array(image.data);
  const trace = {
    name,
    source_image: input,
    width: image.width,
    height: image.height,
    rgba_sha256: sha256(rgba),
    runtime_seconds: elapsed,
    bright_mask_sha256: sha256(result.brightMask.data),
    dark_mask_sha256: sha256(result.darkMask.data),
    bright_pixel_count: result.brightMask.data.reduce((a, b) => a + b, 0),
    dark_pixel_count: result.darkMask.data.reduce((a, b) => a + b, 0),
    bright_components: result.brightComponents.map(componentRow),
    dark_components: result.darkComponents.map(componentRow),
    badge_labels: result.badges.map((c) => c.label),
    badge_count: result.badgeCount,
    basket_labels: result.baskets.map((c) => c.label),
    remaining_bright_labels: result.remainingBright.map((c) => c.label),
    tee_modal_labels: result.teeModalFamily.map((c) => c.label),
    tee_modal_major: result.teeModalMajor,
    tee_modal_minor: result.teeModalMinor,
    tee_seed_labels: result.teeSeeds.map((c) => c.label),
    tee_border_template: maskRows(result.teeBorderTemplate),
    tee_ranked: result.teeRanked.map((r) => ({
      label: r.component.label,
      score: r.score,
      explained: r.explained,
      coverage: r.coverage,
      dx: r.dx,
      dy: r.dy,
    })),
    tee_primary_labels: result.teePrimary.map((r) => r.component.label),
    tee_secondary_A_labels: result.teeSecondaryA.map((r) => r.component.label),
    tee_culled_A_labels: result.teeCulledA.map((r) => r.component.label),
    tee_secondary_B_labels: result.teeSecondaryB.map((r) => r.component.label),
    tee_culled_B_labels: result.teeCulledB.map((r) => r.component.label),
  };

  const tracePath = join(outDir, `${name}.trace.json`);
  writeFileSync(tracePath, JSON.stringify(trace));
  console.log(
    `${name}: ${image.width}x${image.height} bright=${result.brightComponents.length} ` +
      `badges=${result.badgeCount} ranked=${result.teeRanked.length} ` +
      `runtime=${elapsed.toFixed(2)}s -> ${tracePath}`,
  );
}

main();
