/**
 * End-to-end badge reading: NuThing P1 result -> per-badge digit string.
 *
 * Browser-portable: pure TS over typed arrays, no Node APIs. The classifier
 * is injected through the DigitScorer interface so competing models
 * (prototype matcher, logistic regression, ...) run through the identical
 * pipeline: badge -> glyph mask -> label-blind segmentation -> canonical
 * normalization -> per-digit scores -> concatenated label.
 *
 * Every prediction retains the evidence needed to render a full diagnostic
 * card (glyph mask, per-digit bbox/mask/normalized raster, scores, margins).
 */

import type { Mask } from '../raster';
import type { ComponentStats } from '../components';
import { extractBadgeGlyph } from './badgeGlyph';
import type { BadgeGlyph } from './badgeGlyph';
import { segmentDigits } from './segment';
import type { DigitCandidate } from './segment';
import { normalizeDigitMask } from './normalize';
import type { NormalizedDigit } from './normalize';

export const DIGIT_CLASSES = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'] as const;

/** A trained digit model: scores a normalized 24x32 mask for classes 0-9. */
export interface DigitScorer {
  readonly name: string;
  /** Higher = more likely; index i corresponds to digit String(i). */
  scores(mask: NormalizedDigit): number[];
}

export interface DigitReading {
  candidate: DigitCandidate;
  normalized: NormalizedDigit;
  scores: number[];
  predicted: string;
  runnerUp: string;
  /** score[winner] - score[runnerUp]. */
  margin: number;
}

export interface BadgeReading {
  badge: ComponentStats;
  glyph: BadgeGlyph;
  digits: DigitReading[];
  /** Concatenated predicted digits ('' when no digit segments). */
  label: string;
  /** Minimum per-digit margin (Infinity when no digits). */
  confidence: number;
}

/** Minimal context readBadge needs — satisfied by NuThingP1Result and the
 * fast BadgeStageResult alike. */
export interface BadgeReadContext {
  brightMask: Mask;
  darkMask: Mask;
  brightLabels: Int32Array;
  badges: ComponentStats[];
  /** Optional: enables large-component exclusion for plate-recovered badges. */
  brightComponents?: ComponentStats[];
}

export function readBadge(
  badge: ComponentStats,
  result: BadgeReadContext,
  scorer: DigitScorer,
): BadgeReading {
  const glyph = extractBadgeGlyph(
    badge,
    result.brightMask,
    result.darkMask,
    result.brightLabels,
    result.brightComponents,
  );
  const segmented = glyph.mask.width > 0 ? segmentDigits(glyph.mask) : { digits: [], notes: [] };
  const digits: DigitReading[] = [];
  for (const candidate of segmented.digits) {
    const normalized = normalizeDigitMask(candidate.mask, candidate.bbox[2], candidate.bbox[3]);
    const scores = scorer.scores(normalized);
    let win = 0;
    let second = -1;
    for (let i = 1; i < scores.length; i++) {
      if (scores[i] > scores[win]) {
        second = win;
        win = i;
      } else if (second < 0 || scores[i] > scores[second]) {
        second = i;
      }
    }
    digits.push({
      candidate,
      normalized,
      scores,
      predicted: DIGIT_CLASSES[win],
      runnerUp: second >= 0 ? DIGIT_CLASSES[second] : DIGIT_CLASSES[win],
      margin: second >= 0 ? scores[win] - scores[second] : 0,
    });
  }
  return {
    badge,
    glyph,
    digits,
    label: digits.map((d) => d.predicted).join(''),
    confidence: digits.length ? Math.min(...digits.map((d) => d.margin)) : Infinity,
  };
}

/** Read every badge-family observation of a P1 (or badge-stage) result. */
export function readCourseBadges(result: BadgeReadContext, scorer: DigitScorer): BadgeReading[] {
  return result.badges.map((badge) => readBadge(badge, result, scorer));
}
