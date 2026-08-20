// Validate detectCourseWithNuThing (the in-app producer) headlessly against
// the known-good script-pipeline assignments: The Rec at geoScale 0.5 must
// reproduce the 9/9 assignment; DashsTrack at geoScale 1 must reproduce its
// 18/18. (The producer runs without the offline occluded-tee recovery
// resource, so courses that depend on recovered pads — Heritage, Lenard —
// are not expected to match; that capability gap is a known open item.)
import { readFileSync } from 'node:fs';
import { detectCourseWithNuThing } from '../../src/lib/autoAnnotation/nuthingCourseDetection';
import { decodeRgbaBin } from './decode';

async function checkCourse(
  tag: string,
  rasterPath: string,
  geoScale: number,
  assignmentsPath: string
): Promise<void> {
  const raster = decodeRgbaBin(rasterPath);
  const rgba = new Uint8ClampedArray(raster.data.buffer, raster.data.byteOffset, raster.data.byteLength);
  const result = await detectCourseWithNuThing(new Uint8Array(0), 'image/png', raster.width, raster.height, {
    geoScale,
    rgba
  });
  const expected = JSON.parse(readFileSync(assignmentsPath, 'utf8')) as {
    holes: { hole: number; tee: { xPx: number; yPx: number }; basket: { xPx: number; yPx: number } }[];
  };
  let ok = 0;
  const issues: string[] = [];
  for (const hole of expected.holes) {
    const got = result.grammar.holes.find((h) => h.number === hole.hole);
    if (!got?.tee || !got.basket) {
      issues.push(`h${hole.hole}: missing tee/basket in producer output`);
      continue;
    }
    // Script assignments are in the geometry full frame; producer output is
    // in the capture (native) frame = geometry / geoScale.
    const dTee = Math.hypot(got.tee.xPx - hole.tee.xPx / geoScale, got.tee.yPx - hole.tee.yPx / geoScale);
    const dBasket = Math.hypot(
      got.basket.xPx - hole.basket.xPx / geoScale,
      got.basket.yPx - hole.basket.yPx / geoScale
    );
    if (dTee <= 2 && dBasket <= 2) ok++;
    else issues.push(`h${hole.hole}: tee off ${dTee.toFixed(1)}px basket off ${dBasket.toFixed(1)}px`);
  }
  console.log(
    `${tag}: ${ok}/${expected.holes.length} match (geoScale ${geoScale}) ` +
      `[${result.nuthing.counts.badges} badges, ${result.nuthing.counts.tees} tees, ` +
      `${result.nuthing.counts.baskets} baskets, ${result.nuthing.totalMs.toFixed(0)}ms]`
  );
  for (const issue of issues) console.log(`  ${issue}`);
  const ready = result.grammar.holes.filter((h) => h.status === 'ready').length;
  console.log(`  status: ${ready} ready / ${result.grammar.holes.length} proposals`);
}

async function main(): Promise<void> {
  await checkCourse(
    'TheRec',
    '/workspace/nuthing-work/traces-py/TheRec-native.rgba.bin',
    0.5,
    '/workspace/nuthing-work/pair-matrix-v6/TheRec-full-assignments.json'
  );
  await checkCourse(
    'DashsTrack',
    '/workspace/nuthing-work/traces-py/DashsTrack-full.rgba.bin',
    1,
    '/workspace/nuthing-work/pair-matrix-v6/DashsTrack-full-assignments.json'
  );
}
void main();
