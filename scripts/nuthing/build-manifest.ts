// Build the reproducible badge-observation manifest from TS NuThing P1.
//
// For every hydrated corpus raster this runs the TS P1 port, materializes one
// manifest entry per badge-family observation (bbox, center, crops, bright
// glyph mask, P1 evidence), and grounds labels for annotated dev images via a
// *proven* spatial association:
//
//   annotation hole (number, tee, corridorBends, basket)
//     -> corridor path midpoint (badges are rendered at the hole path's
//        midpoint in these captures; verified across the dev corpus)
//     -> nearest badge observation, accepted only when
//          distance <= MAX_ASSOC_DIST
//          and (second nearest - nearest) >= MIN_MARGIN
//          and no other hole's accepted claim targets the same badge
//
// Annotation grounding is only attempted when the annotation's
// sourceImage.sha256 matches the corpus raster: sha verification showed that
// of the five dev annotations only DashsTrack-full was annotated on the exact
// corpus raster; HeritagePark/Lenard/TowneLake annotations were made on
// different captures (1290x2012..2115 vs 1290x2796) whose coordinate frame
// cannot be reliably registered to the raster (similarity RANSAC over tee
// candidates reached only 5/18 inliers), and AlexClark's older schema has no
// sha and failed a visual audit. Ungated association against those frames
// produced provably wrong labels (visual audit: 13/13 non-DashsTrack labels
// wrong), so the gate is load-bearing.
//
// A second, independent grounding channel supplies the rest: manual visual
// reads of the raw badge crops (resources/nuthing-p2/manual-badge-labels.json),
// recorded per badge id with reader+date. On DashsTrack, where both channels
// exist, they agree 14/14. Where channels would disagree the entry becomes
// UNRESOLVED. Fountain Hills badges stay HELD_OUT: their manual reads are
// stored as evalLabel (evaluation-only truth) and must never train a model.
//
// Usage: npx tsx scripts/nuthing/build-manifest.ts RGBA_DIR OUT_DIR [--summary MD]

import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { runNuThingP1 } from '../../src/lib/nuthing/p1';
import type { NuThingP1Result } from '../../src/lib/nuthing/p1';
import type { ComponentStats } from '../../src/lib/nuthing/components';
import { decodeRgbaBin } from './decode';

const MAX_ASSOC_DIST = 120;
const MIN_MARGIN = 60;

interface AnnotationHole {
  id: string;
  number: number;
  tee: { xPx: number; yPx: number };
  basket: { xPx: number; yPx: number };
  corridorBends?: { xPx: number; yPx: number }[];
}

interface CourseAnnotation {
  sourceImage: { sha256: number | string };
  holes: AnnotationHole[];
}

/** Annotation files matched to canonical raster names (byte-identical
 * dev/Annotated/** duplicates are intentionally not repeated), with the
 * corpus raster whose sha256 the annotation must match to be usable.
 * Heritage/Lenard/TowneLake annotations exist but were made on different
 * captures (sha mismatch — see module docs); AlexClark's has no sha at all.
 * They are listed so the mismatch is checked and reported, not assumed. */
const ANNOTATIONS: Record<string, { annotation: string; raster: string }> = {
  'DashsTrack-full': {
    annotation: 'dev/DashsTrack/DashsTrack-full.annotation.json',
    raster: 'dev/DashsTrack/DashsTrack-full.jpg',
  },
  'HeritagePark-full': {
    annotation: 'dev/Heritage/HeritagePark-full.annotation.json',
    raster: 'dev/Heritage/HeritagePark-full.png',
  },
  'Lenard-full': {
    annotation: 'dev/Lenard/Lenard-full.annotation.json',
    raster: 'dev/Lenard/Lenard-full.PNG',
  },
  'TowneLake-full': {
    annotation: 'dev/TowneLake/TowneLake-full.annotation.json',
    raster: 'dev/TowneLake/TowneLake-full.png',
  },
};

const CORPUS_ROOT = '/workspace/chainspot-corpus';
const MANUAL_LABELS_PATH = 'resources/nuthing-p2/manual-badge-labels.json';

interface ManualLabels {
  reader: string;
  date: string;
  labels: Record<string, string>;
}

type ProvenanceClass = 'REAL_GROUNDED' | 'SYNTHETIC' | 'PSEUDOLABELED' | 'HELD_OUT' | 'UNRESOLVED';

interface BadgeEntry {
  id: string;
  image: string;
  imageRgbaSha256: string;
  badgeLabel: number;
  bbox: [number, number, number, number];
  center: [number, number];
  aspect: number;
  darkInteriorFraction: number;
  badgeFamilySize: number;
  crops: {
    raw: string;
    interior: string;
    glyphMask: string;
    interiorBbox: [number, number, number, number];
    glyphPixelCount: number;
  };
  label: string | null;
  labelProvenance:
    | {
        source: 'annotation-association';
        annotationFile: string;
        annotationSha256Verified: true;
        holeId: string;
        holeNumber: number;
        pathMidpoint: [number, number];
        distance: number;
        secondDistance: number;
        rule: string;
        manualReadAgrees: boolean | null;
      }
    | { source: 'manual-visual'; reader: string; date: string }
    | { reason: string };
  provenanceClass: ProvenanceClass;
  /** HELD_OUT only: evaluation-only truth from the manual-visual channel.
   * Never a training label. */
  evalLabel?: string | null;
  evalLabelProvenance?: { source: 'manual-visual'; reader: string; date: string };
}

function pathMidpoint(h: AnnotationHole): [number, number] {
  const pts: [number, number][] = [
    [h.tee.xPx, h.tee.yPx],
    ...(h.corridorBends ?? []).map((p): [number, number] => [p.xPx, p.yPx]),
    [h.basket.xPx, h.basket.yPx],
  ];
  const seg: number[] = [];
  let total = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const L = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
    seg.push(L);
    total += L;
  }
  let acc = 0;
  const half = total / 2;
  for (let i = 0; i < seg.length; i++) {
    if (acc + seg[i] >= half && seg[i] > 0) {
      const f = (half - acc) / seg[i];
      return [
        pts[i][0] + f * (pts[i + 1][0] - pts[i][0]),
        pts[i][1] + f * (pts[i + 1][1] - pts[i][1]),
      ];
    }
    acc += seg[i];
  }
  return pts[pts.length - 1];
}

function writePng(path: string, width: number, height: number, rgba: Uint8Array): void {
  const png = new PNG({ width, height });
  Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength).copy(png.data);
  writeFileSync(path, PNG.sync.write(png));
}

function cropRgba(
  data: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  x0: number,
  y0: number,
  w: number,
  h: number,
): Uint8Array {
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const sy = y0 + y;
    for (let x = 0; x < w; x++) {
      const sx = x0 + x;
      const o = (y * w + x) * 4;
      if (sx >= 0 && sx < width && sy >= 0 && sy < height) {
        const s = (sy * width + sx) * 4;
        out[o] = data[s];
        out[o + 1] = data[s + 1];
        out[o + 2] = data[s + 2];
        out[o + 3] = 255;
      } else {
        out[o + 3] = 255;
      }
    }
  }
  return out;
}

function maskToRgba(mask: Uint8Array, n: number): Uint8Array {
  const out = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const v = mask[i] ? 255 : 0;
    out[i * 4] = v;
    out[i * 4 + 1] = v;
    out[i * 4 + 2] = v;
    out[i * 4 + 3] = 255;
  }
  return out;
}

function heldOut(name: string): boolean {
  return name.startsWith('FountainHills');
}

interface Claim {
  holeId: string;
  holeNumber: number;
  mid: [number, number];
  d1: number;
  d2: number;
  badgeLabel: number;
}

function groundLabels(
  name: string,
  badges: ComponentStats[],
):
  | { file: string; claims: Map<number, Claim>; conflicts: Set<number> }
  | { file: string; shaMismatch: true }
  | null {
  const spec = ANNOTATIONS[name];
  if (!spec) return null;
  const annPath = spec.annotation;
  const ann = JSON.parse(readFileSync(join(CORPUS_ROOT, annPath), 'utf8')) as CourseAnnotation;
  const rasterSha = createHash('sha256')
    .update(readFileSync(join(CORPUS_ROOT, spec.raster)))
    .digest('hex');
  if (String(ann.sourceImage?.sha256 ?? '') !== rasterSha) {
    return { file: annPath, shaMismatch: true };
  }
  const accepted: Claim[] = [];
  for (const hole of ann.holes) {
    const mid = pathMidpoint(hole);
    const ds = badges
      .map((b) => ({ b, d: Math.hypot(b.cx - mid[0], b.cy - mid[1]) }))
      .sort((p, q) => p.d - q.d);
    if (ds.length === 0) continue;
    const d1 = ds[0].d;
    const d2 = ds.length > 1 ? ds[1].d : Infinity;
    if (d1 <= MAX_ASSOC_DIST && d2 - d1 >= MIN_MARGIN) {
      accepted.push({
        holeId: hole.id,
        holeNumber: hole.number,
        mid,
        d1,
        d2,
        badgeLabel: ds[0].b.label,
      });
    }
  }
  const byBadge = new Map<number, Claim[]>();
  for (const c of accepted) {
    const list = byBadge.get(c.badgeLabel);
    if (list) list.push(c);
    else byBadge.set(c.badgeLabel, [c]);
  }
  const claims = new Map<number, Claim>();
  const conflicts = new Set<number>();
  for (const [label, list] of byBadge) {
    if (list.length === 1) claims.set(label, list[0]);
    else conflicts.add(label);
  }
  return { file: annPath, claims, conflicts };
}

function main(): void {
  const [rgbaDir, outDir, ...rest] = process.argv.slice(2);
  if (!rgbaDir || !outDir) {
    console.error('Usage: tsx scripts/nuthing/build-manifest.ts RGBA_DIR OUT_DIR [--summary MD]');
    process.exit(1);
  }
  const summaryIdx = rest.indexOf('--summary');
  const summaryPath = summaryIdx >= 0 ? rest[summaryIdx + 1] : null;
  mkdirSync(join(outDir, 'crops'), { recursive: true });
  const manualLabels = JSON.parse(readFileSync(MANUAL_LABELS_PATH, 'utf8')) as ManualLabels;

  const entries: BadgeEntry[] = [];
  const perImage: {
    image: string;
    badges: number;
    grounded: number;
    unresolved: number;
    heldOut: number;
    annotatedHoles: number | null;
  }[] = [];

  const names = readdirSync(rgbaDir)
    .filter((f) => f.endsWith('.rgba.bin'))
    .map((f) => f.replace(/\.rgba\.bin$/, ''))
    .sort();

  for (const name of names) {
    const image = decodeRgbaBin(join(rgbaDir, `${name}.rgba.bin`));
    const rgbaSha = createHash('sha256')
      .update(image.data instanceof Uint8Array ? image.data : new Uint8Array(image.data))
      .digest('hex');
    const result: NuThingP1Result = runNuThingP1(image);
    const grounding = groundLabels(name, result.badges);
    const isHeld = heldOut(name);
    let grounded = 0;
    let unresolvedCount = 0;

    for (const badge of result.badges) {
      const id = `${name}#badge${badge.label}`;
      const margin = 4;
      const rx = badge.bboxX - margin;
      const ry = badge.bboxY - margin;
      const rw = badge.bboxW + 2 * margin;
      const rh = badge.bboxH + 2 * margin;
      const rawName = `${name}-badge${badge.label}-raw.png`;
      writePng(
        join(outDir, 'crops', rawName),
        rw,
        rh,
        cropRgba(image.data, image.width, image.height, rx, ry, rw, rh),
      );

      // Interior: bounding box of dark pixels inside the badge bbox (the dark
      // rounded-rect the digits sit on).
      let ix0 = badge.bboxX + badge.bboxW;
      let iy0 = badge.bboxY + badge.bboxH;
      let ix1 = badge.bboxX - 1;
      let iy1 = badge.bboxY - 1;
      let darkCount = 0;
      for (let y = badge.bboxY; y < badge.bboxY + badge.bboxH; y++) {
        for (let x = badge.bboxX; x < badge.bboxX + badge.bboxW; x++) {
          if (result.darkMask.data[y * image.width + x]) {
            darkCount++;
            if (x < ix0) ix0 = x;
            if (y < iy0) iy0 = y;
            if (x > ix1) ix1 = x;
            if (y > iy1) iy1 = y;
          }
        }
      }
      const hasInterior = ix1 >= ix0 && iy1 >= iy0;
      const iw = hasInterior ? ix1 - ix0 + 1 : 0;
      const ih = hasInterior ? iy1 - iy0 + 1 : 0;
      const interiorName = `${name}-badge${badge.label}-interior.png`;
      if (hasInterior) {
        writePng(
          join(outDir, 'crops', interiorName),
          iw,
          ih,
          cropRgba(image.data, image.width, image.height, ix0, iy0, iw, ih),
        );
      }

      // Glyph mask: bright pixels inside the interior bbox that are NOT part
      // of the badge frame component (digits are separate bright components).
      const glyph = new Uint8Array(iw * ih);
      let glyphCount = 0;
      if (hasInterior) {
        for (let y = 0; y < ih; y++) {
          for (let x = 0; x < iw; x++) {
            const src = (iy0 + y) * image.width + (ix0 + x);
            if (result.brightMask.data[src] && result.brightLabels[src] !== badge.label) {
              glyph[y * iw + x] = 1;
              glyphCount++;
            }
          }
        }
      }
      const glyphName = `${name}-badge${badge.label}-glyph.png`;
      if (hasInterior) {
        writePng(join(outDir, 'crops', glyphName), iw, ih, maskToRgba(glyph, iw * ih));
      }

      const manualRaw = manualLabels.labels[id];
      const manualDigit =
        manualRaw !== undefined && !manualRaw.startsWith('NON_DIGIT') ? manualRaw : null;
      const manualNonDigit = manualRaw !== undefined && manualRaw.startsWith('NON_DIGIT');

      let label: string | null = null;
      let labelProvenance: BadgeEntry['labelProvenance'] = { reason: 'NO_ANNOTATION' };
      let provenanceClass: ProvenanceClass = isHeld ? 'HELD_OUT' : 'UNRESOLVED';
      let evalLabel: string | null | undefined;
      let evalLabelProvenance: BadgeEntry['evalLabelProvenance'];

      if (isHeld) {
        // Fountain Hills: never a training label. Manual read becomes
        // evaluation-only truth.
        if (manualRaw !== undefined) {
          evalLabel = manualDigit;
          evalLabelProvenance = {
            source: 'manual-visual',
            reader: manualLabels.reader,
            date: manualLabels.date,
          };
        }
      } else {
        const claim =
          grounding && 'claims' in grounding ? grounding.claims.get(badge.label) : undefined;
        if (claim && manualDigit !== null && manualDigit !== String(claim.holeNumber)) {
          labelProvenance = {
            reason: `CHANNEL_DISAGREEMENT annotation=${claim.holeNumber} manual=${manualDigit}`,
          };
          unresolvedCount++;
        } else if (claim) {
          label = String(claim.holeNumber);
          labelProvenance = {
            source: 'annotation-association',
            annotationFile: grounding && 'claims' in grounding ? grounding.file : '',
            annotationSha256Verified: true,
            holeId: claim.holeId,
            holeNumber: claim.holeNumber,
            pathMidpoint: [claim.mid[0], claim.mid[1]],
            distance: claim.d1,
            secondDistance: claim.d2,
            rule: `path-midpoint nearest badge, d<=${MAX_ASSOC_DIST}, margin>=${MIN_MARGIN}, unique claim`,
            manualReadAgrees: manualDigit === null ? null : true,
          };
          provenanceClass = 'REAL_GROUNDED';
          grounded++;
        } else if (manualDigit !== null) {
          label = manualDigit;
          labelProvenance = {
            source: 'manual-visual',
            reader: manualLabels.reader,
            date: manualLabels.date,
          };
          provenanceClass = 'REAL_GROUNDED';
          grounded++;
        } else if (manualNonDigit) {
          labelProvenance = { reason: manualRaw ?? 'NON_DIGIT' };
          unresolvedCount++;
        } else if (grounding && 'shaMismatch' in grounding) {
          labelProvenance = { reason: 'ANNOTATION_COORDINATE_FRAME_MISMATCH' };
          unresolvedCount++;
        } else if (grounding && 'conflicts' in grounding && grounding.conflicts.has(badge.label)) {
          labelProvenance = { reason: 'CONFLICTING_HOLE_CLAIMS' };
          unresolvedCount++;
        } else {
          labelProvenance = { reason: 'NO_ACCEPTED_HOLE_CLAIM_OR_MANUAL_READ' };
          unresolvedCount++;
        }
      }

      entries.push({
        id,
        image: name,
        imageRgbaSha256: rgbaSha,
        badgeLabel: badge.label,
        bbox: [badge.bboxX, badge.bboxY, badge.bboxW, badge.bboxH],
        center: [badge.cx, badge.cy],
        aspect: badge.bboxW / badge.bboxH,
        darkInteriorFraction: darkCount / (badge.bboxW * badge.bboxH),
        badgeFamilySize: result.badgeCount,
        crops: {
          raw: `crops/${rawName}`,
          interior: hasInterior ? `crops/${interiorName}` : '',
          glyphMask: hasInterior ? `crops/${glyphName}` : '',
          interiorBbox: hasInterior ? [ix0, iy0, iw, ih] : [0, 0, 0, 0],
          glyphPixelCount: glyphCount,
        },
        label,
        labelProvenance,
        provenanceClass,
        ...(evalLabel !== undefined ? { evalLabel } : {}),
        ...(evalLabelProvenance !== undefined ? { evalLabelProvenance } : {}),
      });
    }

    const annotated = grounding !== null && 'claims' in grounding;
    perImage.push({
      image: name,
      badges: result.badges.length,
      grounded,
      unresolved: unresolvedCount,
      heldOut: isHeld ? result.badges.length : 0,
      annotatedHoles: annotated
        ? (
            JSON.parse(
              readFileSync(join(CORPUS_ROOT, ANNOTATIONS[name].annotation), 'utf8'),
            ) as CourseAnnotation
          ).holes.length
        : null,
    });
    console.log(
      `${name}: badges=${result.badges.length} grounded=${grounded} ` +
        `unresolved=${unresolvedCount}${isHeld ? ' (HELD_OUT)' : ''}`,
    );
  }

  const manifest = {
    generator: 'scripts/nuthing/build-manifest.ts',
    associationRule: {
      description:
        'annotation hole path midpoint (tee + corridorBends + basket polyline) ' +
        'to nearest P1 badge center; accepted iff distance <= MAX_ASSOC_DIST, ' +
        'second-nearest margin >= MIN_MARGIN, and the badge is claimed by ' +
        'exactly one accepted hole. Conflicts/failures stay UNRESOLVED.',
      maxAssocDist: MAX_ASSOC_DIST,
      minMargin: MIN_MARGIN,
    },
    images: perImage,
    badges: entries,
  };
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 1));

  const counts: Record<string, number> = {};
  for (const e of entries) counts[e.provenanceClass] = (counts[e.provenanceClass] ?? 0) + 1;
  const labelHist: Record<string, number> = {};
  for (const e of entries) {
    if (e.label !== null) labelHist[e.label] = (labelHist[e.label] ?? 0) + 1;
  }
  console.log('provenance:', counts);
  console.log('label histogram:', labelHist);

  if (summaryPath) {
    const lines: string[] = [];
    lines.push('# Badge observation manifest');
    lines.push('');
    lines.push(
      'Built by `scripts/nuthing/build-manifest.ts` from TS NuThing P1 badge ' +
        'observations over the deduplicated hydrated corpus (byte-identical ' +
        '`dev/Annotated/**` copies excluded). Two grounding channels: ' +
        'sha-verified annotation association (DashsTrack only — see below) ' +
        'and independent manual visual reads; disagreement or ambiguity ' +
        'stays UNRESOLVED. Fountain Hills is HELD_OUT: its manual reads are ' +
        'evaluation-only truth (`evalLabel`), never training labels.',
    );
    lines.push('');
    lines.push('| image | badges | grounded | unresolved | held-out | annotated holes |');
    lines.push('|---|---|---|---|---|---|');
    for (const r of perImage) {
      lines.push(
        `| ${r.image} | ${r.badges} | ${r.grounded} | ${r.unresolved} | ${r.heldOut} | ` +
          `${r.annotatedHoles ?? '—'} |`,
      );
    }
    lines.push('');
    lines.push(`Provenance classes: ${JSON.stringify(counts)}`);
    lines.push('');
    lines.push(
      `Grounded label histogram: ${Object.entries(labelHist)
        .sort((a, b) => Number(a[0]) - Number(b[0]))
        .map(([k, v]) => `${k}×${v}`)
        .join(', ')}`,
    );
    lines.push('');
    lines.push(
      '## Grounding channels and what the audit found\n\n' +
        '1. **Annotation association** (sha-verified frames only). The ' +
        'preferred basket chain was measured first; on the one annotation ' +
        'whose sourceImage.sha256 matches its corpus raster (DashsTrack) the ' +
        'corridor **path midpoint** is the badge anchor (accepted claims at ' +
        '5–70px with 60px+ margins), and nearest-basket association is ' +
        'strictly more ambiguous. The Heritage/Lenard/TowneLake annotations ' +
        'were made on different captures (1290×2012–2115 vs 1290×2796, sha ' +
        'MISMATCH) and AlexClark’s older schema has no sha: ungated ' +
        'association against those frames produced labels that a visual ' +
        'audit showed to be 13/13 **wrong**, so annotation grounding is ' +
        'hard-gated on the sha match.\n' +
        '2. **Manual visual reads** of every raw badge crop ' +
        '(`resources/nuthing-p2/manual-badge-labels.json`), independent of ' +
        'any classifier. On DashsTrack the two channels agree 14/14. ' +
        'Fountain Hills reads are stored as `evalLabel` (evaluation-only ' +
        'truth) and are never training labels.',
    );
    writeFileSync(summaryPath, lines.join('\n'));
    console.log(`summary -> ${summaryPath}`);
  }
}

main();
