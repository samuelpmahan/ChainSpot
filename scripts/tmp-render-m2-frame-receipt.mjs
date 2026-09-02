#!/usr/bin/env node

/* One-shot raw-frame receipt. Presentation consumes one materialized trace. */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import threeFactor from '@chainspot/alg/detectors/threeFactor';
import configModule from '@chainspot/alg/detectors/threeFactor/config';
import measureModule from '@chainspot/alg/detectors/threeFactor/measure';
import engineModule from '@chainspot/alg/detectors/threeFactor/engine';
import m2FeatureModule from '@chainspot/alg/detectors/threeFactor/features/g5.badgeM2Aa';
import traceIdentityModule from '@chainspot/alg/detectors/threeFactor/features/traceIdentity';
import execModule from '@chainspot/alg/exec';

const sharp = createRequire(import.meta.url)('sharp');
const { canonicalJson } = threeFactor;
const { parseConfig, resolveConfig } = configModule;
const { seedBoard } = measureModule;
const { createTraceContext } = engineModule;
const { BADGE_M2_AA_FEATURE_ID, decodeMaterializedBadgeM2Library } = m2FeatureModule;
const { makeTraceRunId, sealTrace } = traceIdentityModule;
const { compileExecutionPlan, createExecBoard, createMemorySink, executeCompiledPlan } = execModule;

const root = process.env.CHAINSPOT_CORPUS_ROOT ? resolve(process.env.CHAINSPOT_CORPUS_ROOT) : resolve('../chainspot-corpus');
const encoded = readFileSync(resolve(root, 'dev', 'DashsTrack', 'DashsTrack-full.jpg'));
const decoded = jpeg.decode(encoded, { useTArray: true, maxMemoryUsageInMB: 2048 });
const image = { width: decoded.width, height: decoded.height, data: new Uint8ClampedArray(decoded.data.buffer, decoded.data.byteOffset, decoded.data.byteLength) };
const parsed = parseConfig(JSON.parse(readFileSync(resolve('packages/alg/src/detectors/threeFactor/configs/badge-m2-aa-on.json'), 'utf8')));
const config = resolveConfig(parsed, parsed.execution);
const paramsHash = createHash('sha256').update(canonicalJson(config)).digest('hex');
const plan = compileExecutionPlan(config, paramsHash);
const board = createExecBoard();
seedBoard(board, image, undefined);
board.set('paramsHash', paramsHash);
board.set('recoveredTees', []);
board.set('straightTestTruthAssistance', { mode: 'blind', locks: [] });
const sink = createMemorySink();
const imageId = createHash('sha256').update(encoded).digest('hex');
const runId = makeTraceRunId(imageId, paramsHash, plan.planFingerprint);
const { ctx, trace } = createTraceContext(config, paramsHash, plan.ops, { runId, imageId, canonicalFrame: 'DashsTrack source pixels' });
const receipts = executeCompiledPlan(plan, board, ctx, sink);
const sealedTrace = sealTrace(trace, { runId, imageId });
const receipt = receipts.find((value) => value.opId === 'badgeEvidence.m2Aa');
if (!receipt) throw new Error('Badge M2 operation did not execute');
const libraryRef = receipt.artifacts.find((value) => value.kind === 'measurementTable');
if (!libraryRef) throw new Error('Badge M2 library artifact missing');
const bytes = sink.blobs.get(libraryRef.id);
if (!bytes) throw new Error('Badge M2 library bytes missing');
const library = decodeMaterializedBadgeM2Library(bytes);
const representation = library.representations.find((value) => value.objectId === 'badge-0');
if (!representation) throw new Error('Badge 0 M2 representation missing');

/*
 * Pending producer seam. Do not fall back to representation.aa, because that
 * would silently rerun/reshape the old candidate universe in the renderer.
 * The producer may call this field `rawFrameTrace` or `rawFrame` while the
 * trace contract settles; both are intentionally narrow aliases.
 */
const probe = library.rawProbe?.trace;
const control = library.rawProbe?.control ?? probe?.control;
const sourceBehavior = probe ?? representation.rawFrameTrace ?? representation.rawFrame ?? representation.frameTrace;
if (!sourceBehavior)
  throw new Error('M2 raw-frame trace missing: wire representation.rawFrameTrace before running this receipt');
// The producer cannot know the final sealed RunTrace hash while it is
// materializing the probe. Attach that identity exactly once at this boundary.
const identity = {
  runId: sealedTrace.runId,
  imageId: sealedTrace.imageId,
  paramsHash: sealedTrace.paramsHash,
  featureId: BADGE_M2_AA_FEATURE_ID,
  traceHash: sealedTrace.traceHash
};
let behavior = sourceBehavior;
if (probe) {
  const target = probe.final.targets.find((value) => value.targetId === 'badge-0');
  const registration = probe.registrations.find((value) => value.sampleId === 'badge-0');
  const marginPx = probe.final.finalMarginPx;
  if (!target || !registration || marginPx === null) throw new Error('M2 raw probe has no materialized badge-0 target/crop');
  const [x0, y0, baseWidth, baseHeight] = registration.ownedBbox;
  const crop0 = { x: x0 - marginPx, y: y0 - marginPx, width: baseWidth + marginPx * 2, height: baseHeight + marginPx * 2 };
  const cropRgba = new Uint8ClampedArray(crop0.width * crop0.height * 4);
  for (let y = 0; y < crop0.height; y++) for (let x = 0; x < crop0.width; x++) {
    const sourceX = crop0.x + x, sourceY = crop0.y + y;
    if (sourceX < 0 || sourceY < 0 || sourceX >= image.width || sourceY >= image.height) continue;
    const sourceOffset = (sourceY * image.width + sourceX) * 4;
    cropRgba.set(image.data.slice(sourceOffset, sourceOffset + 4), (y * crop0.width + x) * 4);
  }
  const shifted = (values) => values.map(([x, y]) => [x + marginPx, y + marginPx]);
  const status = (value) => value === 'clear' ? 'clear' : value === 'supported' ? 'touching' : 'unknown-truncated';
  const controlStatistics = control ? (() => {
    const thresholds = new Map();
    for (const margin of control.margins) for (const [threshold, value] of Object.entries(margin.bySupportThreshold)) thresholds.set(Number(threshold), { threshold: Number(threshold), globalMaxOverlap: { observed: value.globalMaxExactOverlap.observed, nullMean: value.globalMaxExactOverlap.nullMean, nullSd: value.globalMaxExactOverlap.nullSampleSd, nullQuantiles: value.globalMaxExactOverlap.nullQuantiles, nullMax: value.globalMaxExactOverlap.nullMaximum, empiricalP: value.globalMaxExactOverlap.empiricalP }, largest8ConnectedCluster: { observed: value.largestEightConnectedCluster.observed, nullMean: value.largestEightConnectedCluster.nullMean, nullSd: value.largestEightConnectedCluster.nullSampleSd, nullQuantiles: value.largestEightConnectedCluster.nullQuantiles, nullMax: value.largestEightConnectedCluster.nullMaximum, empiricalP: value.largestEightConnectedCluster.empiricalP } });
    const outer = control.margins.find((margin) => margin.outermostClearedRing)?.outermostClearedRing;
    return { empiricalNull: { controlSeed: control.controlSeed, B: control.replicateCount, thresholds: [...thresholds.values()], ...(outer ? { outermostClearedRingNegativeControl: { observed: outer.observed, nullMean: outer.nullMean, nullSd: outer.nullSampleSd, nullQuantiles: outer.nullQuantiles, nullMax: outer.nullMaximum, empiricalP: outer.empiricalP } } : {}) } };
  })() : undefined;
  behavior = {
    objectId: 'badge-0', coordinateFrame: 'm1-owned-bbox-local', crop: crop0, marginPx, rawRgba: cropRgba,
    exactBaselinePixels: shifted(target.finalExactSupportedCoordinates),
    partition: Object.fromEntries(Object.entries(target.partition.byPartition).map(([name, values]) => [name, shifted(values)])),
    glyph: { exactPixels: shifted(registration.glyphExactCoordinates), haloPixels: shifted(registration.glyphHaloCoordinates) },
    support: { exactCount: target.finalExactSupportedCoordinates.length, minimumSupportCount: probe.algorithm.exact.minimumSupportCount, minimumSupportFraction: null, sampleCount: probe.registrations.length, alignedSampleCount: probe.registrations.length, registration: probe.algorithm.modelProvenance },
    quantizedBinWidth: probe.algorithm.quantized?.binWidth,
    boundaryByMargin: probe.margins.map((value) => ({ marginPx: value.marginPx, status: status(value.exactBoundary.status), supportedPixelCount: value.exactSupportedCoordinates.length, boundarySupportedPixelCount: value.exactBoundary.total, unobservedSampleCount: value.unobservedSampleCount, sides: { top: status(value.exactBoundary.top.status), right: status(value.exactBoundary.right.status), bottom: status(value.exactBoundary.bottom.status), left: status(value.exactBoundary.left.status) } })),
    frameBoundary: [0, 0, crop0.width, crop0.height],
    statistics: probe.statistics ?? probe.stats ?? controlStatistics,
    jpegCaveat: library.rawProbe?.provenance?.jpegCaveat
  };
}
const crop = behavior.crop;
const rgba = behavior.rawRgba ?? behavior.rgba;
if (!identity.runId || !identity.imageId || !identity.paramsHash || !identity.featureId || !identity.traceHash)
  throw new Error('M2 raw-frame trace is missing sealed runId/imageId/paramsHash/featureId/traceHash');
if (!crop || !rgba) throw new Error('M2 raw-frame trace is missing crop/rawRgba');
if (behavior.objectId !== 'badge-0') throw new Error('M2 raw-frame trace object mismatch');
if (behavior.coordinateFrame !== 'm1-owned-bbox-local') throw new Error('M2 raw-frame trace frame mismatch');
if (rgba.length !== crop.width * crop.height * 4) throw new Error('M2 raw-frame trace RGBA/crop mismatch');
const partition = behavior.partition ?? behavior.targetPartitions;
const partitionNames = ['m1-owned', 'old-aa', 'old-residue', 'exterior'];
if (!partition || partitionNames.some((name) => !Array.isArray(partition[name]))) throw new Error('M2 raw-frame trace support partition is missing');
const glyph = behavior.glyph;
if (!glyph || !Array.isArray(glyph.exactPixels) || !Array.isArray(glyph.haloPixels)) throw new Error('M2 raw-frame trace glyph masks are missing');
const boundaryByMargin = behavior.boundaryByMargin ?? behavior.margins;
if (!Array.isArray(boundaryByMargin) || boundaryByMargin.length === 0) throw new Error('M2 raw-frame trace per-margin boundary outcomes are missing');
if (boundaryByMargin[0].marginPx !== 2) throw new Error('M2 raw-frame trace sweep must start at margin 2px');

const sourcePng = new PNG({ width: crop.width, height: crop.height });
sourcePng.data.set(Uint8Array.from(rgba));
const sourceHref = `data:image/png;base64,${PNG.sync.write(sourcePng).toString('base64')}`;
const colors = { 'm1-owned': '#22c55e', 'old-aa': '#3b82f6', 'old-residue': '#f59e0b', exterior: '#a855f7', 'glyph-exact': '#f8fafc', 'glyph-halo': '#ec4899' };
const esc = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const scale = 8;
const gap = 28;
const titleHeight = 48;
const panelWidth = crop.width * scale;
const panelHeight = crop.height * scale;
const width = panelWidth * 3 + gap * 4;
const height = titleHeight + panelHeight + 240;
const rect = ([x, y], color, opacity = 0.9) => `<rect x="${x * scale}" y="${y * scale}" width="${scale}" height="${scale}" fill="${color}" fill-opacity="${opacity}"/>`;
const overlays = (names, includeGlyph = false) => {
  const out = names.flatMap((name) => partition[name].map((pixel) => rect(pixel, colors[name])));
  if (includeGlyph) {
    out.push(...glyph.haloPixels.map((pixel) => rect(pixel, colors['glyph-halo'], 0.85)));
    out.push(...glyph.exactPixels.map((pixel) => rect(pixel, colors['glyph-exact'], 0.95)));
  }
  return out.join('');
};
const panel = (index, title, overlay = '') => {
  const x = gap + index * (panelWidth + gap);
  return `<g transform="translate(${x},${titleHeight})"><text x="0" y="-14" fill="#f8fafc" font-size="18" font-family="system-ui" font-weight="700">${esc(title)}</text><image href="${sourceHref}" width="${panelWidth}" height="${panelHeight}" image-rendering="pixelated"/><rect width="${panelWidth}" height="${panelHeight}" fill="#020617" fill-opacity="${overlay ? 0.3 : 0}"/>${overlay}<rect width="${panelWidth}" height="${panelHeight}" fill="none" stroke="#f8fafc" stroke-width="2"/></g>`;
};
const partitionCounts = Object.fromEntries(partitionNames.map((name) => [name, partition[name].length]));
const receiptIdentity = { runId: identity.runId, imageId: identity.imageId, paramsHash: identity.paramsHash, featureId: identity.featureId ?? BADGE_M2_AA_FEATURE_ID, traceHash: identity.traceHash };
const identityRows = [`runId=${receiptIdentity.runId} imageId=${receiptIdentity.imageId}`, `paramsHash=${receiptIdentity.paramsHash} featureId=${receiptIdentity.featureId} traceHash=${receiptIdentity.traceHash}`];
const support = behavior.support ?? behavior.registration;
if (!support) throw new Error('M2 raw-frame trace registration/support is missing');
const statistics = behavior.statistics;
const statisticLines = [];
if (statistics) {
  if (statistics.modalExactTuple) statisticLines.push(`modal exact tuple RGBA=(${statistics.modalExactTuple.join(',')}) count=${statistics.modalExactCount ?? 'UNKNOWN'} fraction=${statistics.modalExactFraction ?? 'UNKNOWN'}`);
  if (statistics.retainedSampleValues) statisticLines.push(`retained per-sample RGBA values: ${statistics.retainedSampleValues.map((value) => `${value.sampleId}=(${value.rgba.join(',')})`).join(' ')}`);
  if (statistics.channelStandardDeviation) statisticLines.push(`per-channel sample SD: r=${statistics.channelStandardDeviation.r} g=${statistics.channelStandardDeviation.g} b=${statistics.channelStandardDeviation.b} a=${statistics.channelStandardDeviation.a}`);
  if (statistics.assumedP !== undefined) statisticLines.push(`null model: assumed p=${statistics.assumedP}`);
  if (statistics.allSamplesExactCount !== undefined && statistics.sampleTotal !== undefined) statisticLines.push(`exact sample support=${statistics.allSamplesExactCount}/${statistics.sampleTotal}`);
  if (statistics.exactProbability !== undefined) statisticLines.push(`exact support probability=${statistics.exactProbability}${statistics.exactProbabilityPercent === undefined ? '' : ` = ${statistics.exactProbabilityPercent}%`}`);
  if (statistics.empiricalNull) {
    const empirical = statistics.empiricalNull;
    statisticLines.push(`empirical circular-shift null: controlSeed=${empirical.controlSeed} B=${empirical.B} ownershipSignificant=${empirical.ownershipSignificant ?? 'UNKNOWN'}`);
    for (const threshold of empirical.thresholds) {
      const g = threshold.globalMaxOverlap, c = threshold.largest8ConnectedCluster;
      statisticLines.push(`threshold=${threshold.threshold} global-max-overlap observed=${g.observed} nullMean=${g.nullMean} nullSD=${g.nullSd} nullQuantiles=${JSON.stringify(g.nullQuantiles)} nullMax=${g.nullMax} empiricalP=${g.empiricalP ?? 'UNKNOWN'}`);
      statisticLines.push(`threshold=${threshold.threshold} largest-8-connected-cluster observed=${c.observed} nullMean=${c.nullMean} nullSD=${c.nullSd} nullQuantiles=${JSON.stringify(c.nullQuantiles)} nullMax=${c.nullMax} empiricalP=${c.empiricalP ?? 'UNKNOWN'}`);
    }
    if (empirical.outermostClearedRingNegativeControl) {
      const n = empirical.outermostClearedRingNegativeControl;
      statisticLines.push(`outermost-cleared-ring negative control observed=${n.observed} empiricalP=${n.empiricalP ?? 'UNKNOWN'} verdict=${n.verdict ?? 'UNKNOWN'}`);
    }
  } else statisticLines.push('caveat: adjacent-pixel probabilities are NOT multiplied without justified independence');
} else statisticLines.push('null model: assumed p=.5; 18/18 => 0.5^18 = 3.814697265625e-6 = 0.00038147%', 'caveat: adjacent-pixel probabilities are NOT multiplied without justified independence');
statisticLines.push('simple reference only (not ownership gate): assumed p=.5; 18/18 => 0.5^18 = 3.814697265625e-6 = 0.00038147%');
const cliLines = [
  `M2 RAW FRAME RECEIPT · object=${behavior.objectId}`,
  ...identityRows,
  `coordinateFrame=${behavior.coordinateFrame} crop=(${crop.x},${crop.y}) ${crop.width}×${crop.height}px finalMarginPx=${behavior.marginPx}`,
  `samples=${support.sampleCount} aligned=${support.alignedSampleCount} registration=${support.registration}`,
  `exact baseline RGBA=${behavior.exactBaselinePixels.length} pixels · minimum support count=${support.minimumSupportCount} fraction=${support.minimumSupportFraction ?? 'UNKNOWN'}`,
  `quantized RGBA diagnostic: NON-AUTHORITATIVE${behavior.quantizedBinWidth ? ` · q(c)=floor(c/${behavior.quantizedBinWidth})` : ''}`,
  `glyph exact mask=${glyph.exactPixels.length} pixels · glyph halo/support=${glyph.haloPixels.length} pixels`,
  ...statisticLines,
  ...boundaryByMargin.map((outcome) => `margin ${outcome.marginPx}px: boundary=${outcome.status} sides=${outcome.sides ? `top:${outcome.sides.top},right:${outcome.sides.right},bottom:${outcome.sides.bottom},left:${outcome.sides.left}` : 'UNKNOWN'} supported=${outcome.supportedPixelCount} touching=${outcome.boundarySupportedPixelCount} unknownTruncated=${outcome.unobservedSampleCount}`),
  `evidence retention: superseded margins retain summaries only (no per-pixel replay); full per-pixel observations retained for the final margin ${behavior.marginPx}px only (of ${boundaryByMargin.length} margins swept)`,
  `final support partition: ${partitionNames.map((name) => `${name}=${partitionCounts[name]}`).join(' ')}`,
  `CAVEAT: ${behavior.jpegCaveat ?? 'JPEG values are decoded samples; exact RGBA means exact decoded bytes.'}`,
  `visual/trace identity: runId=${receiptIdentity.runId} imageId=${receiptIdentity.imageId} traceHash=${receiptIdentity.traceHash}`
];
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#0f172a"/>${panel(0, 'A · full raw crop')}${panel(1, 'B · exact baseline partition', overlays(partitionNames))}${panel(2, 'C · glyph mask + support', overlays(partitionNames, true))}<g transform="translate(${gap},${titleHeight + panelHeight + 32})" font-family="system-ui" font-size="14" fill="#e2e8f0">${cliLines.map((line, index) => `<text x="0" y="${index * 18}">${esc(line)}</text>`).join('')}</g></svg>`;

const out = resolve('artifacts/storybook-e/m2-frame');
mkdirSync(out, { recursive: true });
const stem = 'badge-0-raw-frame';
const svgPath = resolve(out, `${stem}.svg`);
const pngPath = resolve(out, `${stem}.png`);
const jsonPath = resolve(out, `${stem}.json`);
writeFileSync(svgPath, svg);
await sharp(Buffer.from(svg)).png().toFile(pngPath);
const jsonReceipt = { receiptIdentity, cliText: cliLines.join('\n'), visualIdentityText: identityRows.join('\n'), visualReceipt: { svgPath: `${stem}.svg`, pngPath: `${stem}.png` }, objectId: behavior.objectId, coordinateFrame: behavior.coordinateFrame, crop, marginPx: behavior.marginPx, partitionCounts, glyphCounts: { exact: glyph.exactPixels.length, halo: glyph.haloPixels.length }, boundaryByMargin, support, frameBoundary: behavior.frameBoundary, jpegCaveat: behavior.jpegCaveat ?? 'JPEG values are decoded samples; exact RGBA means exact decoded bytes.' };
if (jsonReceipt.visualIdentityText !== identityRows.join('\n') || identityRows.some((row) => !svg.includes(row))) throw new Error('M2 receipt identity mismatch: JSON and visible receipt drifted');
writeFileSync(jsonPath, `${JSON.stringify(jsonReceipt, null, 2)}\n`);
console.log(JSON.stringify({ svgPath, pngPath, jsonPath, receiptIdentity, marginCount: boundaryByMargin.length, partitionCounts }, null, 2));
