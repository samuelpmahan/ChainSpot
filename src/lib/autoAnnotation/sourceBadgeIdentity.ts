/**
 * Source-space badge identity for CHSPT-79/80.
 *
 * Hierarchy is explicit and deliberately never starts with whole-raster P2:
 *   1. pure-TS glyph score on already-localized source badge bodies;
 *   2. existing P2/OpenCV glyph assignment on those same source ROIs only;
 *   3. caller may use historical whole-raster detection only when source
 *      localization/identity remains incomplete after this module returns.
 */
import { loadCv } from '../stitch/cvMatch';
import type { SemanticLandmarkBatchResult } from '../stitch/semanticLandmarks';
import {
  badgeGlyphBatchIsComplete,
  classifyKnownBadgeBodiesPureTs,
  classifyKnownBadgeBodiesWithOpenCv,
  loadBadgeGlyphTemplatePack,
  type BadgeGlyphClassification,
  type BadgeGlyphRaster
} from './badgeGlyphClassifier';
import type { HoleNumberCvModule, KnownBadgeBody } from './holeNumberDetection';

export interface SourceBadgeIdentitySource {
  readonly sourceId: string;
  readonly classifications: readonly BadgeGlyphClassification[];
}

export interface SourceBadgeIdentityBatch {
  readonly sources: readonly SourceBadgeIdentitySource[];
  readonly vocabularyLabels: readonly number[];
  readonly templateLoadMs: number;
  readonly pureTsMs: number;
  readonly roiOpenCvMs: number;
  readonly roiOpenCvSourceCount: number;
  readonly wholeRasterDiscoveryCount: 0;
}

function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function knownBadgeBodies(
  source: SemanticLandmarkBatchResult['sources'][number]
): KnownBadgeBody[] {
  return source.landmarks
    .filter((landmark) => landmark.family === 'badge')
    .map((landmark) => ({
      xPx: landmark.xPx,
      yPx: landmark.yPx,
      widthPx: landmark.widthPx,
      heightPx: landmark.heightPx,
      fill: landmark.fill
    }));
}

/**
 * Classifies the exact source rasters that semantic localization already ran
 * on. An absent pixel buffer is a hard abstention for this optimization, not
 * a reason to discover badges elsewhere.
 */
export async function classifySemanticSourceBadges(
  batch: SemanticLandmarkBatchResult,
  sourcePixels: ReadonlyMap<string, BadgeGlyphRaster>,
  basePath: string
): Promise<SourceBadgeIdentityBatch> {
  const templateStartedAt = nowMs();
  const pack = await loadBadgeGlyphTemplatePack(basePath);
  const templateLoadMs = nowMs() - templateStartedAt;
  let pureTsMs = 0;
  let roiOpenCvMs = 0;
  let roiOpenCvSourceCount = 0;
  let cvPromise: ReturnType<typeof loadCv> | null = null;
  const sources: SourceBadgeIdentitySource[] = [];

  for (const source of batch.sources) {
    const raster = sourcePixels.get(source.sourceId);
    const bodies = knownBadgeBodies(source);
    if (!raster || bodies.length === 0) {
      sources.push({ sourceId: source.sourceId, classifications: [] });
      continue;
    }

    const pureStartedAt = nowMs();
    const pure = classifyKnownBadgeBodiesPureTs(raster, pack.templates, bodies);
    pureTsMs += nowMs() - pureStartedAt;
    if (badgeGlyphBatchIsComplete(pure)) {
      sources.push({ sourceId: source.sourceId, classifications: pure });
      continue;
    }

    // Pure TS could not prove a unique label set. Escalate only the known
    // ROIs, reusing the exact P2 glyph scorer/one-to-one assignment. Both
    // cvMatch and P2 receive the same runtime object from cv/runtime; their
    // local structural types simply describe different subsets of that object.
    const cvStartedAt = nowMs();
    cvPromise ??= loadCv();
    const cv = (await cvPromise) as unknown as HoleNumberCvModule;
    const roi = classifyKnownBadgeBodiesWithOpenCv(cv, raster, pack.templates, bodies);
    roiOpenCvMs += nowMs() - cvStartedAt;
    roiOpenCvSourceCount += 1;
    sources.push({ sourceId: source.sourceId, classifications: roi });
  }

  return {
    sources,
    vocabularyLabels: pack.vocabularyLabels,
    templateLoadMs,
    pureTsMs,
    roiOpenCvMs,
    roiOpenCvSourceCount,
    wholeRasterDiscoveryCount: 0
  };
}
