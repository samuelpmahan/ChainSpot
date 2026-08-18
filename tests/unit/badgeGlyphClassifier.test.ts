import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { PNG } from 'pngjs';
import { describe, expect, test } from 'vitest';
import {
  classifyKnownBadgeBodiesPureTs,
  type BadgeGlyphRaster
} from '../../src/lib/autoAnnotation/badgeGlyphClassifier';
import type { HoleNumberTemplate, KnownBadgeBody } from '../../src/lib/autoAnnotation/holeNumberDetection';

const ROOT = join(process.cwd(), 'static', 'resources', 'chainspot_cv_templates');
const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8')) as {
  templates: { holeNumbers: string[] };
};

function loadTemplate(fileName: string, label: number): HoleNumberTemplate {
  const png = PNG.sync.read(readFileSync(join(ROOT, fileName)));
  return {
    label,
    raster: {
      format: 'rgba',
      widthPx: png.width,
      heightPx: png.height,
      data: new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.byteLength)
    }
  };
}

const templates = manifest.templates.holeNumbers.map(loadTemplate);

function rasterOf(template: HoleNumberTemplate): BadgeGlyphRaster {
  if (template.raster.format !== 'rgba') throw new Error('fixture template must be rgba');
  return {
    widthPx: template.raster.widthPx,
    heightPx: template.raster.heightPx,
    data: template.raster.data
  };
}

function bodyOf(raster: BadgeGlyphRaster): KnownBadgeBody {
  return {
    xPx: raster.widthPx / 2,
    yPx: raster.heightPx / 2,
    widthPx: raster.widthPx,
    heightPx: raster.heightPx,
    fill: 1
  };
}

function resizeNearest(source: BadgeGlyphRaster, scale: number): BadgeGlyphRaster {
  const widthPx = Math.max(1, Math.round(source.widthPx * scale));
  const heightPx = Math.max(1, Math.round(source.heightPx * scale));
  const data = new Uint8Array(widthPx * heightPx * 4);
  for (let y = 0; y < heightPx; y += 1) {
    const sy = Math.min(source.heightPx - 1, Math.floor(y / scale));
    for (let x = 0; x < widthPx; x += 1) {
      const sx = Math.min(source.widthPx - 1, Math.floor(x / scale));
      const src = (sy * source.widthPx + sx) * 4;
      const dst = (y * widthPx + x) * 4;
      data.set(source.data.subarray(src, src + 4), dst);
    }
  }
  return { widthPx, heightPx, data };
}

function classifyFixture(raster: BadgeGlyphRaster, expected: number) {
  const result = classifyKnownBadgeBodiesPureTs(raster, templates, [bodyOf(raster)])[0];
  return { correct: result.label === expected, result };
}

describe('pure-TS known-badge glyph classifier', () => {
  test('is manifest-driven and labels every shipped canonical template without whole-raster discovery', () => {
    expect(templates.length).toBe(manifest.templates.holeNumbers.length);
    expect(templates.length).toBeGreaterThan(0);
    const started = performance.now();
    const outcomes = templates.map((template) => classifyFixture(rasterOf(template), template.label));
    const elapsedMs = performance.now() - started;
    const correct = outcomes.filter((outcome) => outcome.correct).length;
    const minimumMargin = Math.min(...outcomes.map((outcome) => outcome.result.ambiguityMargin));
    console.info('[badge-glyph-native-benchmark]', {
      templates: templates.length,
      correct,
      accuracy: correct / templates.length,
      elapsedMs,
      msPerBadge: elapsedMs / templates.length,
      minimumMargin
    });
    expect(correct).toBe(templates.length);
    expect(outcomes.every((outcome) => outcome.result.method === 'pure-ts')).toBe(true);
    expect(outcomes.every((outcome) => outcome.result.abstention === null)).toBe(true);
  });

  test('normalization preserves labels across representative source scaling', () => {
    const scales = [0.75, 1, 1.35, 1.75];
    const rows = scales.map((scale) => {
      const started = performance.now();
      const outcomes = templates.map((template) =>
        classifyFixture(resizeNearest(rasterOf(template), scale), template.label)
      );
      const elapsedMs = performance.now() - started;
      const correct = outcomes.filter((outcome) => outcome.correct).length;
      return {
        scale,
        correct,
        accuracy: correct / templates.length,
        elapsedMs,
        msPerBadge: elapsedMs / templates.length,
        minimumMargin: Math.min(...outcomes.map((outcome) => outcome.result.ambiguityMargin))
      };
    });
    console.table(rows);
    expect(rows.every((row) => row.correct === templates.length)).toBe(true);
  });

  test('explicitly abstains on a localized body with no bright glyph', () => {
    const raster: BadgeGlyphRaster = {
      widthPx: 48,
      heightPx: 36,
      data: new Uint8Array(48 * 36 * 4)
    };
    const result = classifyKnownBadgeBodiesPureTs(raster, templates, [bodyOf(raster)])[0];
    expect(result.label).toBeUndefined();
    expect(result.abstention).toBe('empty-glyph');
  });
});
