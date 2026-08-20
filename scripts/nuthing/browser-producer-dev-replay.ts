// Integration gate for the ACTUAL browser producer (detectCourseWithNuThing),
// not the frozen pair-matrix script. Consumes bit-identical RGBA dumps made
// from the four dev course rasters and checks user-visible tee/basket proposals
// against registered truth.
//
// Usage: npx tsx scripts/nuthing/browser-producer-dev-replay.ts RGBA_DIR CORPUS_ROOT

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { detectCourseWithNuThing } from '../../src/lib/autoAnnotation/nuthingCourseDetection';
import { decodeRgbaBin } from './decode';

type TruthHole = {
  number: number;
  tee: [number, number];
  basket: [number, number];
};

type Registered = Record<string, {
  registeredHoles: Array<{ number: number; tee: number[]; basket: number[] }>;
}>;

function loadTruth(corpusRoot: string): Record<string, TruthHole[]> {
  const registered = JSON.parse(
    readFileSync('resources/nuthing-p2/registered-annotations.json', 'utf8'),
  ) as Registered;
  const dashs = JSON.parse(
    readFileSync(join(corpusRoot, 'dev/DashsTrack/DashsTrack-full.annotation.json'), 'utf8'),
  ) as {
    holes: Array<{
      number: number;
      tee: { xPx: number; yPx: number };
      basket: { xPx: number; yPx: number };
    }>;
  };
  const out: Record<string, TruthHole[]> = {
    'DashsTrack-full': dashs.holes.map((h) => ({
      number: h.number,
      tee: [h.tee.xPx, h.tee.yPx],
      basket: [h.basket.xPx, h.basket.yPx],
    })),
  };
  for (const name of ['HeritagePark-full', 'Lenard-full', 'TowneLake-full']) {
    out[name] = registered[name].registeredHoles.map((h) => ({
      number: h.number,
      tee: [h.tee[0], h.tee[1]],
      basket: [h.basket[0], h.basket[1]],
    }));
  }
  return out;
}

async function main(): Promise<void> {
  const [rgbaDir, corpusRoot] = process.argv.slice(2);
  if (!rgbaDir || !corpusRoot) {
    console.error('Usage: tsx scripts/nuthing/browser-producer-dev-replay.ts RGBA_DIR CORPUS_ROOT');
    process.exit(2);
  }
  const truth = loadTruth(corpusRoot);
  let exact = 0;
  let total = 0;
  let allPassed = true;

  for (const name of ['DashsTrack-full', 'HeritagePark-full', 'Lenard-full', 'TowneLake-full']) {
    const raster = decodeRgbaBin(join(rgbaDir, `${name}.rgba.bin`));
    const rgba = new Uint8ClampedArray(raster.data.buffer, raster.data.byteOffset, raster.data.byteLength);
    const result = await detectCourseWithNuThing(
      new Uint8Array(0),
      'image/png',
      raster.width,
      raster.height,
      { geoScale: 1, rgba },
    );

    let courseExact = 0;
    const issues: string[] = [];
    for (const h of truth[name]) {
      total++;
      const got = result.grammar.holes.find((p) => p.number === h.number);
      if (!got?.tee || !got.basket) {
        issues.push(`h${h.number}: missing proposal`);
        continue;
      }
      const dT = Math.hypot(got.tee.xPx - h.tee[0], got.tee.yPx - h.tee[1]);
      const dB = Math.hypot(got.basket.xPx - h.basket[0], got.basket.yPx - h.basket[1]);
      // Same truth-matching tolerances used by pair-matrix.ts: registrations
      // carry a few px residual and an edge tee can render ~14px from annotation.
      const ok = dT <= 18 && dB <= 16;
      if (ok) {
        exact++;
        courseExact++;
      } else {
        issues.push(
          `h${h.number}: tee ${dT.toFixed(1)}px, basket ${dB.toFixed(1)}px ` +
          `(got T=${got.tee.xPx.toFixed(1)},${got.tee.yPx.toFixed(1)} ` +
          `B=${got.basket.xPx.toFixed(1)},${got.basket.yPx.toFixed(1)})`,
        );
      }
    }

    const L = result.nuthing.ledger;
    console.log(
      `${name}: exact=${courseExact}/${truth[name].length} ` +
      `candidates=${result.nuthing.counts.tees}T/${result.nuthing.counts.baskets}B ` +
      `assigned=${result.nuthing.counts.assignedHoles} ` +
      `ledger straight=${L.straightCalibrationTriples} samples=${L.calibrationSamples} ` +
      `buckets=${L.bucketCounts.join('/')} lift=${L.bucketMeanLift.map((v) => v.toFixed(1)).join('/')} ` +
      `occ=${L.signedOccluderPatchedCells} gaps=${L.contrastGapPatchedCells} ` +
      `linear=${L.consistencyDiscountedCells} recoveredT=${L.runtimeRecoveredTees} reroute=${L.rerouted} ` +
      `runtime=${result.nuthing.totalMs.toFixed(0)}ms`,
    );
    for (const issue of issues) console.log(`  FAIL ${issue}`);
    if (issues.length) allPassed = false;
  }

  console.log(`BROWSER PRODUCER DEV72: exact=${exact}/${total}`);
  if (!allPassed || exact !== total) process.exit(1);
}

void main();
