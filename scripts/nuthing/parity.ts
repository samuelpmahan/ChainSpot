// Python <-> TypeScript NuThing P1 parity comparator.
//
// Loads a p1_trace.py trace and a run-p1.ts trace for the same raster and
// compares them structurally. Component label ids are implementation details
// (OpenCV's block-based labeler numbers components differently than the TS
// raster-scan labeler), so components are matched by (bbox, area, centroid)
// and every membership/list comparison goes through that mapping.
//
// Small floating-point differences are tolerated; semantic divergence
// (membership, ordering, counts, masks) is an error.
//
// Usage: npx tsx scripts/nuthing/parity.ts PY_TRACE TS_TRACE [--report OUT.md]

import { readFileSync, writeFileSync } from 'node:fs';

interface TraceComponent {
  label: number;
  cx: number;
  cy: number;
  area: number;
  bbox: [number, number, number, number];
  major: number;
  minor: number;
  angle: number;
  fill: number;
}

interface RankedRow {
  label: number;
  score: number;
  explained: number;
  coverage: number;
  dx: number;
  dy: number;
}

interface Trace {
  name: string;
  width: number;
  height: number;
  rgba_sha256: string;
  runtime_seconds: number;
  bright_mask_sha256: string;
  dark_mask_sha256: string;
  bright_pixel_count: number;
  dark_pixel_count: number;
  bright_components: TraceComponent[];
  dark_components: TraceComponent[];
  badge_labels: number[];
  badge_count: number;
  basket_labels: number[];
  remaining_bright_labels: number[];
  tee_modal_labels: number[];
  tee_modal_major: number;
  tee_modal_minor: number;
  tee_seed_labels: number[];
  tee_border_template: string[];
  tee_ranked: RankedRow[];
  tee_primary_labels: number[];
  tee_secondary_A_labels: number[];
  tee_culled_A_labels: number[];
  tee_secondary_B_labels: number[];
  tee_culled_B_labels: number[];
}

const SCORE_TOL = 2e-6; // float32 reduction noise
const GEOM_REL_TOL = 1e-9;

interface Failure {
  where: string;
  detail: string;
}

function componentKey(c: TraceComponent): string {
  return `${c.bbox.join(',')}|${c.area}`;
}

function relClose(a: number, b: number, tol: number): boolean {
  const scale = Math.max(Math.abs(a), Math.abs(b), 1);
  return Math.abs(a - b) <= tol * scale;
}

function buildMapping(
  py: TraceComponent[],
  ts: TraceComponent[],
  which: string,
  failures: Failure[],
): { pyToTs: Map<number, number>; ok: boolean } {
  const pyToTs = new Map<number, number>();
  if (py.length !== ts.length) {
    failures.push({
      where: `${which} component count`,
      detail: `py=${py.length} ts=${ts.length}`,
    });
    return { pyToTs, ok: false };
  }
  const tsByKey = new Map<string, TraceComponent[]>();
  for (const c of ts) {
    const key = componentKey(c);
    const list = tsByKey.get(key);
    if (list) list.push(c);
    else tsByKey.set(key, [c]);
  }
  let ok = true;
  for (const c of py) {
    const list = tsByKey.get(componentKey(c)) ?? [];
    // Disambiguate identical bbox+area (rare) by centroid.
    const match = list.find(
      (t) =>
        !t.hasOwnProperty('_used') &&
        relClose(t.cx, c.cx, 1e-6) &&
        relClose(t.cy, c.cy, 1e-6),
    ) as (TraceComponent & { _used?: boolean }) | undefined;
    if (!match) {
      failures.push({
        where: `${which} component match`,
        detail: `py label ${c.label} bbox=[${c.bbox}] area=${c.area} has no TS twin`,
      });
      ok = false;
      continue;
    }
    match._used = true;
    pyToTs.set(c.label, match.label);
    for (const [field, tol] of [
      ['cx', GEOM_REL_TOL],
      ['cy', GEOM_REL_TOL],
      ['major', GEOM_REL_TOL],
      ['minor', GEOM_REL_TOL],
      ['fill', GEOM_REL_TOL],
    ] as const) {
      const a = c[field];
      const b = match[field];
      if (!relClose(a, b, tol)) {
        failures.push({
          where: `${which} ${field}`,
          detail: `py label ${c.label}: ${a} vs ${b}`,
        });
        ok = false;
      }
    }
    // angle can legitimately differ by pi for degenerate axes; compare axis direction.
    const da = Math.abs(c.angle - match.angle);
    if (da > 1e-6 && Math.abs(da - Math.PI) > 1e-6) {
      failures.push({
        where: `${which} angle`,
        detail: `py label ${c.label}: ${c.angle} vs ${match.angle}`,
      });
      ok = false;
    }
  }
  return { pyToTs, ok };
}

function compareLabelSet(
  pyLabels: number[],
  tsLabels: number[],
  pyToTs: Map<number, number>,
  where: string,
  failures: Failure[],
): void {
  const mapped = new Set(pyLabels.map((l) => pyToTs.get(l) ?? -1));
  const actual = new Set(tsLabels);
  const missing = [...mapped].filter((l) => !actual.has(l));
  const extra = [...actual].filter((l) => !mapped.has(l));
  if (missing.length || extra.length) {
    failures.push({
      where,
      detail: `size py=${pyLabels.length} ts=${tsLabels.length}; missing=[${missing}] extra=[${extra}]`,
    });
  }
}

function compareLabelList(
  pyLabels: number[],
  tsLabels: number[],
  pyToTs: Map<number, number>,
  where: string,
  failures: Failure[],
): void {
  const mapped = pyLabels.map((l) => pyToTs.get(l) ?? -1);
  if (mapped.length !== tsLabels.length || mapped.some((l, i) => l !== tsLabels[i])) {
    failures.push({
      where,
      detail: `ordered mismatch\n  py(mapped)=[${mapped}]\n  ts        =[${tsLabels}]`,
    });
  }
}

export interface ParityOutcome {
  name: string;
  pass: boolean;
  failures: Failure[];
  warnings: string[];
  stats: {
    brightCount: number;
    darkCount: number;
    badgeCount: number;
    rankedCount: number;
    maxScoreDelta: number;
    pyRuntime: number;
    tsRuntime: number;
    boundaryTies: string[];
  };
}

export function compareTraces(py: Trace, ts: Trace): ParityOutcome {
  const failures: Failure[] = [];
  const warnings: string[] = [];

  if (py.rgba_sha256 !== ts.rgba_sha256) {
    failures.push({
      where: 'input rgba',
      detail: `py=${py.rgba_sha256} ts=${ts.rgba_sha256} — inputs are not identical`,
    });
  }
  if (py.bright_mask_sha256 !== ts.bright_mask_sha256) {
    failures.push({
      where: 'bright mask',
      detail: `sha mismatch (py count=${py.bright_pixel_count} ts count=${ts.bright_pixel_count})`,
    });
  }
  if (py.dark_mask_sha256 !== ts.dark_mask_sha256) {
    failures.push({
      where: 'dark mask',
      detail: `sha mismatch (py count=${py.dark_pixel_count} ts count=${ts.dark_pixel_count})`,
    });
  }

  const { pyToTs } = buildMapping(py.bright_components, ts.bright_components, 'bright', failures);
  buildMapping(py.dark_components, ts.dark_components, 'dark', failures);

  compareLabelSet(py.badge_labels, ts.badge_labels, pyToTs, 'badge family', failures);
  if (py.badge_count !== ts.badge_count) {
    failures.push({ where: 'badge_count', detail: `py=${py.badge_count} ts=${ts.badge_count}` });
  }
  compareLabelSet(py.basket_labels, ts.basket_labels, pyToTs, 'basket family', failures);
  compareLabelSet(
    py.remaining_bright_labels,
    ts.remaining_bright_labels,
    pyToTs,
    'remaining bright',
    failures,
  );
  compareLabelSet(py.tee_modal_labels, ts.tee_modal_labels, pyToTs, 'modal tee family', failures);
  if (!relClose(py.tee_modal_major, ts.tee_modal_major, 1e-9)) {
    failures.push({
      where: 'modal major',
      detail: `${py.tee_modal_major} vs ${ts.tee_modal_major}`,
    });
  }
  if (!relClose(py.tee_modal_minor, ts.tee_modal_minor, 1e-9)) {
    failures.push({
      where: 'modal minor',
      detail: `${py.tee_modal_minor} vs ${ts.tee_modal_minor}`,
    });
  }
  // Seeds: ordered comparison with tie awareness. Seeds are ordered by
  // distance-to-mode; identical rendered glyphs tie exactly and their
  // relative order (and, past the seed cutoff, even membership) follows
  // component enumeration order. Positions may differ only where the
  // distance-to-mode values agree exactly.
  {
    const pyComp = new Map(py.bright_components.map((c) => [c.label, c]));
    const tsComp = new Map(ts.bright_components.map((c) => [c.label, c]));
    const dist = (c: TraceComponent, mm: number, mn: number): number =>
      Math.max(Math.abs(Math.log(c.major / mm)), Math.abs(Math.log(c.minor / mn)));
    const mappedSeeds = py.tee_seed_labels.map((l) => pyToTs.get(l) ?? -1);
    if (mappedSeeds.length !== ts.tee_seed_labels.length) {
      failures.push({
        where: 'tee seeds',
        detail: `count py=${mappedSeeds.length} ts=${ts.tee_seed_labels.length}`,
      });
    } else {
      let seedTieSwaps = 0;
      for (let i = 0; i < mappedSeeds.length; i++) {
        if (mappedSeeds[i] === ts.tee_seed_labels[i]) continue;
        const a = pyComp.get(py.tee_seed_labels[i]);
        const b = tsComp.get(ts.tee_seed_labels[i]);
        const da = a ? dist(a, py.tee_modal_major, py.tee_modal_minor) : NaN;
        const db = b ? dist(b, ts.tee_modal_major, ts.tee_modal_minor) : NaN;
        if (a && b && Math.abs(da - db) <= 1e-12) {
          seedTieSwaps++;
        } else {
          failures.push({
            where: `tee seed[${i}]`,
            detail: `py ${py.tee_seed_labels[i]} (dist=${da}) vs ts ${ts.tee_seed_labels[i]} (dist=${db})`,
          });
        }
      }
      if (seedTieSwaps > 0) {
        warnings.push(`${seedTieSwaps} seed positions permuted within exact distance ties`);
      }
    }
  }

  if (py.tee_border_template.join('\n') !== ts.tee_border_template.join('\n')) {
    let diffPixels = 0;
    for (let y = 0; y < py.tee_border_template.length; y++) {
      const a = py.tee_border_template[y];
      const b = ts.tee_border_template[y] ?? '';
      for (let x = 0; x < a.length; x++) if (a[x] !== (b[x] ?? '')) diffPixels++;
    }
    failures.push({ where: 'border template', detail: `${diffPixels} differing pixels` });
  }

  // Ranked list comparison.
  //
  // Two tolerated (and explicitly reported) non-semantic effects:
  //
  // 1. Tie permutations: identical rendered glyphs produce exact score ties
  //    whose relative order depends on component enumeration order (an
  //    implementation detail — OpenCV's labeler vs raster order).
  //
  // 2. Unstable-axis components: np.cov runs through BLAS dgemm whose
  //    summation order is not reproducible outside that BLAS build; the
  //    ~1e-13 covariance noise is amplified into visible canonical-mask
  //    differences only for components whose PCA axis is mathematically
  //    undefined (near-circular: major ~= minor) or whose projection is
  //    grossly clipped by the canonical window (major*scale >> CANON_SIZE,
  //    e.g. a 96px-wide blob projected at 30x when the modal family is a
  //    2px speck). Their scores may differ up to UNSTABLE_SCORE_TOL; every
  //    other component must agree to SCORE_TOL. The ranking must match
  //    exactly once unstable labels are removed from both lists.
  let maxScoreDelta = 0;
  let tieSwaps = 0;
  const unstable: string[] = [];
  if (py.tee_ranked.length !== ts.tee_ranked.length) {
    failures.push({
      where: 'ranked count',
      detail: `py=${py.tee_ranked.length} ts=${ts.tee_ranked.length}`,
    });
  } else {
    const UNSTABLE_SCORE_TOL = 1e-2;
    const pyCompByLabel = new Map(py.bright_components.map((c) => [c.label, c]));
    const canonScale = 60.0 / py.tee_modal_major;
    const tsRowByLabel = new Map(ts.tee_ranked.map((r) => [r.label, r]));
    const unstablePyLabels = new Set<number>();
    const unstableTsLabels = new Set<number>();

    // Pass 1: per-component score agreement (label-aligned, rank-independent).
    for (const a of py.tee_ranked) {
      const mapped = pyToTs.get(a.label) ?? -1;
      const b = tsRowByLabel.get(mapped);
      if (!b) {
        failures.push({
          where: 'ranked membership',
          detail: `py label ${a.label} (ts ${mapped}) missing from ts ranking`,
        });
        continue;
      }
      const d = Math.abs(a.score - b.score);
      maxScoreDelta = Math.max(maxScoreDelta, d);
      if (d <= SCORE_TOL) continue;
      const comp = pyCompByLabel.get(a.label);
      const nearCircular = comp ? Math.abs(Math.log(comp.major / comp.minor)) <= 1e-3 : false;
      const clipped = comp ? comp.major * canonScale > 90 : false;
      if (d <= UNSTABLE_SCORE_TOL && (nearCircular || clipped)) {
        unstablePyLabels.add(a.label);
        unstableTsLabels.add(mapped);
        unstable.push(
          `label ${a.label} (${nearCircular ? 'near-circular' : 'window-clipped'}): ` +
            `py score=${a.score} ts score=${b.score}`,
        );
      } else {
        failures.push({
          where: 'ranked score',
          detail: `label ${a.label}: py=${a.score} ts=${b.score} (delta=${d})`,
        });
      }
    }

    // Pass 2: order agreement with unstable labels removed, permutations
    // allowed only within score-tie windows.
    const pyStable = py.tee_ranked.filter((r) => !unstablePyLabels.has(r.label));
    const tsStable = ts.tee_ranked.filter((r) => !unstableTsLabels.has(r.label));
    const tsStableRank = new Map<number, number>();
    tsStable.forEach((r, i) => tsStableRank.set(r.label, i));
    for (let i = 0; i < Math.min(pyStable.length, tsStable.length); i++) {
      const a = pyStable[i];
      const b = tsStable[i];
      const mapped = pyToTs.get(a.label) ?? -1;
      if (mapped !== b.label) {
        const j = tsStableRank.get(mapped);
        let tieWindow = j !== undefined && Math.abs(a.score - b.score) <= SCORE_TOL;
        if (tieWindow && j !== undefined) {
          for (let k = Math.min(i, j); k <= Math.max(i, j); k++) {
            if (
              Math.abs(pyStable[k].score - a.score) > SCORE_TOL ||
              Math.abs(tsStable[k].score - a.score) > SCORE_TOL
            ) {
              tieWindow = false;
              break;
            }
          }
        }
        if (tieWindow) {
          tieSwaps++;
        } else {
          failures.push({
            where: `ranked[${i}] order`,
            detail: `py label ${a.label}->(ts ${mapped}) at ts rank ${j} (py score=${a.score}, ts score=${b.score})`,
          });
        }
        continue;
      }
      for (const field of ['explained', 'coverage'] as const) {
        if (Math.abs(a[field] - b[field]) > SCORE_TOL) {
          failures.push({
            where: `ranked[${i}] ${field}`,
            detail: `py=${a[field]} ts=${b[field]} (label ${a.label})`,
          });
        }
      }
      if (a.dx !== b.dx || a.dy !== b.dy) {
        // Score agreement is enforced above; a different arg-max shift with an
        // agreeing score is float32 tie-break noise (several shifts score
        // equal to ~1e-13), not semantic divergence. Track as a warning.
        warnings.push(
          `ranked[${i}] best shift: py=(${a.dx},${a.dy}) ts=(${b.dx},${b.dy}) ` +
            `label ${a.label} score=${a.score}`,
        );
      }
    }
    if (tieSwaps > 0) {
      warnings.push(`${tieSwaps} rank positions permuted within exact/near score-tie windows`);
    }
    for (const u of unstable) warnings.push(`UNSTABLE-AXIS ${u}`);
  }

  // Partition lists: membership may only differ by swapping candidates whose
  // scores agree within tolerance (tie-boundary swaps).
  const pyScoreByLabel = new Map<number, number>();
  for (const r of py.tee_ranked) pyScoreByLabel.set(r.label, r.score);
  const tsScoreByLabel = new Map<number, number>();
  for (const r of ts.tee_ranked) tsScoreByLabel.set(r.label, r.score);
  const tsToPy = new Map<number, number>();
  for (const [k, v] of pyToTs) tsToPy.set(v, k);

  const comparePartition = (pyLabels: number[], tsLabels: number[], where: string): void => {
    const mapped = new Set(pyLabels.map((l) => pyToTs.get(l) ?? -1));
    const actual = new Set(tsLabels);
    const missing = [...mapped].filter((l) => !actual.has(l));
    const extra = [...actual].filter((l) => !mapped.has(l));
    if (missing.length === 0 && extra.length === 0) return;
    const missingScores = missing.map((l) => pyScoreByLabel.get(tsToPy.get(l) ?? -1) ?? NaN);
    const extraScores = extra.map((l) => tsScoreByLabel.get(l) ?? NaN);
    const tieOnly =
      missing.length === extra.length &&
      missingScores.every((s) => extraScores.some((t) => Math.abs(s - t) <= SCORE_TOL));
    if (tieOnly) {
      warnings.push(
        `${where}: ${missing.length} tie-boundary swap(s) ` +
          `(scores ${missingScores.map((s) => s.toFixed(6)).join(',')})`,
      );
    } else {
      failures.push({
        where,
        detail: `size py=${pyLabels.length} ts=${tsLabels.length}; missing=[${missing}] extra=[${extra}]`,
      });
    }
  };

  comparePartition(py.tee_primary_labels, ts.tee_primary_labels, 'PRIMARY');
  comparePartition(py.tee_secondary_A_labels, ts.tee_secondary_A_labels, 'secondary A');
  comparePartition(py.tee_culled_A_labels, ts.tee_culled_A_labels, 'culled A');
  comparePartition(
    py.tee_secondary_B_labels,
    ts.tee_secondary_B_labels,
    'secondary B (forwarded)',
  );
  comparePartition(py.tee_culled_B_labels, ts.tee_culled_B_labels, 'culled B (.40 floor)');

  // Tie audit: exact score ties that touch a partition boundary make the
  // partition sensitive to component enumeration order.
  const boundaryTies: string[] = [];
  const n = py.tee_ranked.length;
  const primaryEnd = py.tee_primary_labels.length;
  for (let i = 0; i + 1 < n; i++) {
    if (py.tee_ranked[i].score === py.tee_ranked[i + 1].score) {
      if (i + 1 === primaryEnd) {
        boundaryTies.push(
          `PRIMARY boundary tie at rank ${i + 1}/${i + 2} (score=${py.tee_ranked[i].score})`,
        );
      }
      if (py.tee_ranked[i].score === 0.4) {
        boundaryTies.push(`floor tie at rank ${i + 1} (score exactly 0.40)`);
      }
    }
  }

  return {
    name: py.name,
    pass: failures.length === 0,
    failures,
    warnings,
    stats: {
      brightCount: py.bright_components.length,
      darkCount: py.dark_components.length,
      badgeCount: py.badge_count,
      rankedCount: py.tee_ranked.length,
      maxScoreDelta,
      pyRuntime: py.runtime_seconds,
      tsRuntime: ts.runtime_seconds,
      boundaryTies,
    },
  };
}

function main(): void {
  const [pyPath, tsPath] = process.argv.slice(2);
  if (!pyPath || !tsPath) {
    console.error('Usage: tsx scripts/nuthing/parity.ts PY_TRACE TS_TRACE');
    process.exit(1);
  }
  const py = JSON.parse(readFileSync(pyPath, 'utf8')) as Trace;
  const ts = JSON.parse(readFileSync(tsPath, 'utf8')) as Trace;
  const outcome = compareTraces(py, ts);
  const s = outcome.stats;
  console.log(
    `${outcome.pass ? 'PASS' : 'FAIL'} ${outcome.name}: bright=${s.brightCount} ` +
      `badges=${s.badgeCount} ranked=${s.rankedCount} maxScoreDelta=${s.maxScoreDelta.toExponential(2)} ` +
      `py=${s.pyRuntime.toFixed(2)}s ts=${s.tsRuntime.toFixed(2)}s`,
  );
  for (const tie of s.boundaryTies) console.log(`  TIE ${tie}`);
  for (const warning of outcome.warnings) console.log(`  WARN ${warning}`);
  for (const fail of outcome.failures.slice(0, 40)) {
    console.log(`  FAIL ${fail.where}: ${fail.detail}`);
  }
  if (outcome.failures.length > 40) {
    console.log(`  ... ${outcome.failures.length - 40} more failures`);
  }
  process.exit(outcome.pass ? 0 : 1);
}

const invokedDirectly = process.argv[1]?.endsWith('parity.ts');
if (invokedDirectly) main();
