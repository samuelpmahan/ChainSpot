/**
 * Ad-hoc CHSPT-75/76/77 timing/diagnostic harness for PNG source captures.
 * Usage: npx tsx scripts/semantic-stitch-benchmark.ts a.png b.png [c.png ...]
 * Optional: SEMANTIC_STITCH_OVERLAY_DIR=/tmp/semantic-overlays
 */
import { basename, join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import { detectSemanticLandmarkBatch } from '../src/lib/stitch/semanticLandmarks';
import { buildSemanticPoseGraph } from '../src/lib/stitch/semanticPoseGraph';
import { renderSemanticLandmarkOverlaySvg, renderSemanticTranslationOverlaySvg } from '../src/lib/stitch/semanticDiagnostics';

const paths = process.argv.slice(2);
if (paths.length < 2) {
  console.error('usage: npx tsx scripts/semantic-stitch-benchmark.ts a.png b.png [c.png ...]');
  process.exit(2);
}
for (const path of paths) {
  if (!existsSync(path)) throw new Error(`source capture not found: ${path}`);
}
const rasters = paths.map((path, index) => {
  const png = PNG.sync.read(readFileSync(path));
  return {
    sourceId: `${index}:${basename(path)}`,
    rgba: new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.byteLength),
    widthPx: png.width,
    heightPx: png.height
  };
});
const landmarks = detectSemanticLandmarkBatch(rasters);
const graph = buildSemanticPoseGraph(landmarks.sources);

const report = {
  localizationMs: landmarks.diagnostics.elapsedMs,
  graphMs: graph.elapsedMs,
  scales: landmarks.scales,
  sources: landmarks.sources.map((source) => ({
    sourceId: source.sourceId,
    badges: source.landmarks.filter((landmark) => landmark.family === 'badge').length,
    baskets: source.landmarks.filter((landmark) => landmark.family === 'basket').length
  })),
  connected: graph.connected,
  edges: graph.pairProbes.map((probe) => ({
    a: probe.a,
    b: probe.b,
    ok: probe.vote.ok,
    reason: probe.vote.reason,
    dxPx: probe.vote.translation?.dxPx ?? null,
    dyPx: probe.vote.translation?.dyPx ?? null,
    inliers: probe.vote.winner?.inlierCount ?? 0,
    familyDiversity: probe.vote.winner?.familyDiversity ?? 0,
    rmsResidualPx: probe.vote.winner?.rmsResidualPx ?? null,
    ambiguityMargin: probe.vote.ambiguityMargin,
    pairwiseMs: probe.vote.elapsedMs
  })),
  visitOrder: graph.visitOrder,
  placementEdges: graph.placementEdges.map((edge) => ({
    parent: edge.parent,
    child: edge.child,
    inliers: edge.inlierCount,
    familyDiversity: edge.familyDiversity,
    rmsResidualPx: edge.rmsResidualPx,
    ambiguityMargin: edge.ambiguityMargin,
    weight: edge.weight
  })),
  transforms: [...graph.transforms].map(([source, coefficients]) => ({ source, coefficients })),
  pixelFallbackPairs: graph.pixelFallbackPairs
};
console.log(JSON.stringify(report, null, 2));

const overlayDir = process.env.SEMANTIC_STITCH_OVERLAY_DIR;
if (overlayDir) {
  mkdirSync(overlayDir, { recursive: true });
  for (let i = 0; i < landmarks.sources.length; i += 1) {
    writeFileSync(join(overlayDir, `source-${i}-landmarks.svg`), renderSemanticLandmarkOverlaySvg(landmarks.sources[i]));
  }
  for (const probe of graph.pairProbes) {
    writeFileSync(
      join(overlayDir, `pair-${probe.a}-${probe.b}.svg`),
      renderSemanticTranslationOverlaySvg(landmarks.sources[probe.a], probe.vote)
    );
  }
}
