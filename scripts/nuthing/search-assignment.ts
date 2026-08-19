// Fast offline search over the middle-out endpoint ASSIGNMENT combined cost
// (assignCourseEndpoints in src/lib/nuthing/ribbon.ts), scored against dev
// truth, using the candidate pools cached by dump-endpoint-pools.ts. No
// pipeline stage (badge stage, ribbon support, geodesic flood) reruns here —
// only triple construction + greedy assignment, which is milliseconds per
// config, so several thousand configs can be tried.
//
// Usage: npx tsx scripts/nuthing/search-assignment.ts [CACHE_DIR]
// Default CACHE_DIR: /workspace/nuthing-work/pools-cache

import { readFileSync, readdirSync } from 'node:fs';

const TOL = 10; // bbox containment tolerance, px (matches middle-out-pair-eval.ts)
const VIRTUAL_RADIUS = 30; // virtual-terminus hit radius, px (matches middle-out-pair-eval.ts)

// ---------------------------------------------------------------------------
// Cache types (mirrors scripts/nuthing/dump-endpoint-pools.ts output).

interface DumpedComponent {
  label: number;
  bboxX: number;
  bboxY: number;
  bboxW: number;
  bboxH: number;
  area: number;
  fill: number;
}

interface DumpedCandidate {
  component: DumpedComponent | null;
  x: number;
  y: number;
  geodesic: number;
  radius: number;
  efficiency: number;
  kind: 'tee-rect' | 'basket-sprite' | 'other' | 'virtual';
  firstIcon: boolean | null;
  gateX: number | null;
  gateY: number | null;
}

interface DumpedBadge {
  label: string;
  cx: number;
  cy: number;
  candidates: DumpedCandidate[];
}

interface DumpedTruthHole {
  number: number;
  tee: [number, number];
  basket: [number, number];
}

interface DumpedCourse {
  name: string;
  viewportTop: number;
  viewportBottom: number;
  badges: DumpedBadge[];
  truth: DumpedTruthHole[];
}

// ---------------------------------------------------------------------------
// Parameterized combined cost + greedy assignment (pure re-implementation of
// assignCourseEndpoints).

interface AssignConfig {
  /** Weight on (geodesicT + geodesicB) in the combined cost. Default 0.5. */
  geodesicWeight: number;
  /** Flat penalty when the tee candidate is not the first icon outward. Default 40. */
  firstIconPenaltyT: number;
  /** Flat penalty when the basket candidate is not the first icon outward. Default 40. */
  firstIconPenaltyB: number;
  /** Flat penalty when the tee/basket flood paths do NOT diverge at the badge. Default 80. */
  divergencePenalty: number;
  /** Gate-pixel distance (src px) above which two legs count as diverged. Default 16. */
  divergeGateThreshold: number;
  /** Geodesic below which both legs are "trivial" and exempted from the divergence test. Default 18. */
  divergeTrivialGeodesic: number;
  /** Triple generation prefilter: max badge-to-midpoint residual (src px). Default 400. */
  midpointPrefilterCap: number;
  /** Round-1 acceptance cap on total combined cost. Default 220. */
  round1Cap: number;
  /** Round-2 (relaxed) acceptance cap on total combined cost. Default 400. */
  round2Cap: number;
  /** Weight on |geodesicT - geodesicB| (badge-as-midpoint balance prior). Default 0 (off). */
  balanceWeight: number;
  /** Weight on (efficiencyT + efficiencyB). Default 0 (off). */
  efficiencyWeight: number;
  /** Extra penalty admitting a 'other'-kind component as a tee candidate; null disables admission entirely (matches current behavior). */
  otherKindTeePenalty: number | null;
}

const DEFAULT_CONFIG: AssignConfig = {
  geodesicWeight: 0.5,
  firstIconPenaltyT: 40,
  firstIconPenaltyB: 40,
  divergencePenalty: 80,
  divergeGateThreshold: 16,
  divergeTrivialGeodesic: 18,
  midpointPrefilterCap: 400,
  round1Cap: 220,
  round2Cap: 400,
  balanceWeight: 0,
  efficiencyWeight: 0,
  otherKindTeePenalty: null,
};

interface Triple {
  badge: number;
  t: DumpedCandidate;
  b: DumpedCandidate;
  cost: number;
}

interface Assignment {
  tee: (DumpedCandidate | null)[];
  basket: (DumpedCandidate | null)[];
}

function isTeeish(c: DumpedCandidate, cfg: AssignConfig): boolean {
  if (c.kind === 'tee-rect' || c.kind === 'virtual') return true;
  if (c.kind === 'other' && cfg.otherKindTeePenalty !== null) return true;
  return false;
}
function isBasketish(c: DumpedCandidate): boolean {
  return c.kind === 'basket-sprite';
}

function diverges(a: DumpedCandidate, b: DumpedCandidate, cfg: AssignConfig): boolean {
  if (a.gateX === null || b.gateX === null) return true;
  if (a.geodesic <= cfg.divergeTrivialGeodesic && b.geodesic <= cfg.divergeTrivialGeodesic) return true;
  const d = Math.hypot((a.gateX ?? 0) - (b.gateX ?? 0), (a.gateY ?? 0) - (b.gateY ?? 0));
  return d >= cfg.divergeGateThreshold;
}

function assignCourse(course: DumpedCourse, cfg: AssignConfig): Assignment {
  const n = course.badges.length;
  const tee: (DumpedCandidate | null)[] = new Array(n).fill(null);
  const basket: (DumpedCandidate | null)[] = new Array(n).fill(null);
  const usedComponents = new Set<number>();

  const triples: Triple[] = [];
  for (let i = 0; i < n; i++) {
    const badge = course.badges[i];
    const cands = badge.candidates;
    const tees = cands.filter((c) => isTeeish(c, cfg));
    const baskets = cands.filter(isBasketish);
    for (const t of tees) {
      for (const b of baskets) {
        const mx = (t.x + b.x) / 2;
        const my = (t.y + b.y) / 2;
        const residual = Math.hypot(mx - badge.cx, my - badge.cy);
        if (residual > cfg.midpointPrefilterCap) continue;
        let cost =
          residual +
          cfg.geodesicWeight * (t.geodesic + b.geodesic) +
          (t.firstIcon === true ? 0 : cfg.firstIconPenaltyT) +
          (b.firstIcon === true ? 0 : cfg.firstIconPenaltyB) +
          (diverges(t, b, cfg) ? 0 : cfg.divergencePenalty) +
          cfg.balanceWeight * Math.abs(t.geodesic - b.geodesic) +
          cfg.efficiencyWeight * (t.efficiency + b.efficiency);
        if (t.kind === 'other' && cfg.otherKindTeePenalty !== null) cost += cfg.otherKindTeePenalty;
        triples.push({ badge: i, t, b, cost });
      }
    }
  }
  triples.sort((a, b) => a.cost - b.cost);

  const caps = [cfg.round1Cap, cfg.round2Cap];
  for (const cap of caps) {
    for (const tr of triples) {
      if (tr.cost > cap) continue;
      if (tee[tr.badge] || basket[tr.badge]) continue;
      const tLabel = tr.t.component?.label ?? -1;
      const bLabel = tr.b.component?.label ?? -2;
      if (tLabel !== -1 && usedComponents.has(tLabel)) continue;
      if (usedComponents.has(bLabel)) continue;
      tee[tr.badge] = tr.t;
      basket[tr.badge] = tr.b;
      if (tLabel !== -1) usedComponents.add(tLabel);
      usedComponents.add(bLabel);
    }
  }
  return { tee, basket };
}

// ---------------------------------------------------------------------------
// Scoring: same hit rule as middle-out-pair-eval.ts (bbox+TOL containment
// for real components, VIRTUAL_RADIUS for virtual termini); "both" = tee AND
// basket both hit, i.e. either chosen (tee or basket) candidate contains the
// truth point — replicated exactly including that subtlety.

function hit(chosen: DumpedCandidate[], p: [number, number]): boolean {
  return chosen.some((c) => {
    const comp = c.component;
    if (comp) {
      return (
        p[0] >= comp.bboxX - TOL &&
        p[0] <= comp.bboxX + comp.bboxW + TOL &&
        p[1] >= comp.bboxY - TOL &&
        p[1] <= comp.bboxY + comp.bboxH + TOL
      );
    }
    return Math.hypot(c.x - p[0], c.y - p[1]) <= VIRTUAL_RADIUS;
  });
}

function scoreCourse(course: DumpedCourse, cfg: AssignConfig): { correct: number; total: number; fails: string[] } {
  const assignment = assignCourse(course, cfg);
  let correct = 0;
  let total = 0;
  const fails: string[] = [];
  course.badges.forEach((badge, i) => {
    if (!badge.label) return;
    const t = course.truth.find((h) => h.number === Number(badge.label));
    if (!t) return;
    total++;
    const chosen = [assignment.tee[i], assignment.basket[i]].filter(
      (c): c is DumpedCandidate => c !== null,
    );
    const th = hit(chosen, t.tee);
    const bh = hit(chosen, t.basket);
    if (th && bh) {
      correct++;
    } else {
      fails.push(`h${badge.label}(${th ? '' : 'T'}${bh ? '' : 'B'})`);
    }
  });
  return { correct, total, fails };
}

interface TotalResult {
  total: number;
  perCourse: { name: string; correct: number; total: number; fails: string[] }[];
}

function scoreAll(courses: DumpedCourse[], cfg: AssignConfig): TotalResult {
  const perCourse = courses.map((c) => ({ name: c.name, ...scoreCourse(c, cfg) }));
  return { total: perCourse.reduce((s, c) => s + c.correct, 0), perCourse };
}

// ---------------------------------------------------------------------------
// Search.

function loadCourses(cacheDir: string): DumpedCourse[] {
  const names = ['DashsTrack-full', 'HeritagePark-full', 'Lenard-full', 'TowneLake-full'];
  return names.map((nm) => JSON.parse(readFileSync(`${cacheDir}/${nm}.json`, 'utf8')) as DumpedCourse);
}

// mulberry32 PRNG for reproducible random search.
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function choice<T>(rng: () => number, arr: T[]): T {
  return arr[Math.floor(rng() * arr.length)];
}

const GEODESIC_WEIGHTS = [0, 0.1, 0.25, 0.35, 0.5, 0.65, 0.75, 1.0];
const FIRSTICON_PENALTIES = [0, 10, 20, 30, 40, 60, 80, 100];
const DIVERGE_PENALTIES = [0, 20, 40, 60, 80, 100, 140, 180];
const DIVERGE_GATE_THRESHOLDS = [4, 8, 16, 24, 32];
const DIVERGE_TRIVIAL_GEO = [10, 14, 18, 24];
const ROUND1_CAPS = [120, 150, 180, 220, 260, 300];
const ROUND2_CAPS = [260, 300, 350, 400, 450, 500, 600];
const BALANCE_WEIGHTS = [0, 0, 0, 0.1, 0.25, 0.5, 0.75];
const EFFICIENCY_WEIGHTS = [0, 0, 0, 5, 15, 30, 50];
const OTHER_TEE_PENALTIES: (number | null)[] = [null, null, null, 60, 100, 150];

function randomConfig(rng: () => number): AssignConfig {
  const round1Cap = choice(rng, ROUND1_CAPS);
  let round2Cap = choice(rng, ROUND2_CAPS);
  if (round2Cap < round1Cap) round2Cap = round1Cap;
  const midpointPrefilterCap = Math.max(round2Cap, choice(rng, ROUND2_CAPS));
  return {
    geodesicWeight: choice(rng, GEODESIC_WEIGHTS),
    firstIconPenaltyT: choice(rng, FIRSTICON_PENALTIES),
    firstIconPenaltyB: choice(rng, FIRSTICON_PENALTIES),
    divergencePenalty: choice(rng, DIVERGE_PENALTIES),
    divergeGateThreshold: choice(rng, DIVERGE_GATE_THRESHOLDS),
    divergeTrivialGeodesic: choice(rng, DIVERGE_TRIVIAL_GEO),
    midpointPrefilterCap,
    round1Cap,
    round2Cap,
    balanceWeight: choice(rng, BALANCE_WEIGHTS),
    efficiencyWeight: choice(rng, EFFICIENCY_WEIGHTS),
    otherKindTeePenalty: choice(rng, OTHER_TEE_PENALTIES),
  };
}

function perturb(rng: () => number, cfg: AssignConfig): AssignConfig {
  const jitter = (v: number, frac: number): number => Math.max(0, v * (1 + (rng() * 2 - 1) * frac));
  const round1Cap = Math.round(jitter(cfg.round1Cap, 0.15));
  let round2Cap = Math.round(jitter(cfg.round2Cap, 0.15));
  if (round2Cap < round1Cap) round2Cap = round1Cap;
  const midpointPrefilterCap = Math.max(round2Cap, Math.round(jitter(cfg.midpointPrefilterCap, 0.15)));
  return {
    ...cfg,
    geodesicWeight: jitter(cfg.geodesicWeight, 0.2),
    firstIconPenaltyT: Math.round(jitter(cfg.firstIconPenaltyT, 0.2)),
    firstIconPenaltyB: Math.round(jitter(cfg.firstIconPenaltyB, 0.2)),
    divergencePenalty: Math.round(jitter(cfg.divergencePenalty, 0.2)),
    divergeGateThreshold: Math.max(1, Math.round(jitter(cfg.divergeGateThreshold, 0.2))),
    divergeTrivialGeodesic: Math.max(1, Math.round(jitter(cfg.divergeTrivialGeodesic, 0.2))),
    round1Cap,
    round2Cap,
    midpointPrefilterCap,
    balanceWeight: jitter(cfg.balanceWeight, 0.3),
    efficiencyWeight: jitter(cfg.efficiencyWeight, 0.3),
  };
}

function fmtConfig(cfg: AssignConfig): string {
  return JSON.stringify(cfg);
}

function main(): void {
  const [cacheDirArg] = process.argv.slice(2);
  const cacheDir = cacheDirArg ?? '/workspace/nuthing-work/pools-cache';
  const files = readdirSync(cacheDir);
  if (files.length === 0) {
    console.error(`No cache files in ${cacheDir}; run dump-endpoint-pools.ts first.`);
    process.exit(1);
  }
  const courses = loadCourses(cacheDir);
  const truthTotal = courses.reduce(
    (s, c) => s + c.badges.filter((b) => b.label && c.truth.some((h) => h.number === Number(b.label))).length,
    0,
  );

  // Baseline: current defaults in src/lib/nuthing/ribbon.ts.
  const baseline = scoreAll(courses, DEFAULT_CONFIG);
  console.log(`Truth pairs available: ${truthTotal}`);
  console.log(
    `Baseline (current ribbon.ts defaults): ${baseline.total}/${truthTotal} ` +
      baseline.perCourse.map((c) => `${c.name}=${c.correct}/${c.total}`).join(' '),
  );
  console.log();

  const rng = mulberry32(20260819);
  const N = 6000;
  let results: { cfg: AssignConfig; result: TotalResult }[] = [];
  for (let i = 0; i < N; i++) {
    const cfg = randomConfig(rng);
    const result = scoreAll(courses, cfg);
    results.push({ cfg, result });
  }
  results.sort((a, b) => b.result.total - a.result.total);

  console.log(`Searched ${N} random configs.`);
  console.log(`Top 15 by total score:`);
  for (let i = 0; i < 15 && i < results.length; i++) {
    const { cfg, result } = results[i];
    console.log(
      `  #${i + 1} total=${result.total}/${truthTotal} ` +
        result.perCourse.map((c) => `${c.name.replace('-full', '')}=${c.correct}/${c.total}`).join(' '),
    );
    console.log(`      ${fmtConfig(cfg)}`);
  }
  console.log();

  // Stability: perturb the top 5 distinct configs and see how the score
  // distribution holds up (guards against a search spike that only works
  // because of a coincidental cache-specific alignment).
  console.log(`Stability check (30 perturbations of +-15-20% per numeric term, top 5 configs):`);
  const seen = new Set<string>();
  let stableCount = 0;
  for (const { cfg, result } of results) {
    const key = fmtConfig(cfg);
    if (seen.has(key)) continue;
    seen.add(key);
    if (stableCount >= 5) break;
    stableCount++;
    const perturbScores: number[] = [];
    for (let p = 0; p < 30; p++) {
      const pcfg = perturb(rng, cfg);
      perturbScores.push(scoreAll(courses, pcfg).total);
    }
    perturbScores.sort((a, b) => a - b);
    const mean = perturbScores.reduce((s, v) => s + v, 0) / perturbScores.length;
    const min = perturbScores[0];
    const max = perturbScores[perturbScores.length - 1];
    const median = perturbScores[Math.floor(perturbScores.length / 2)];
    console.log(
      `  config(total=${result.total}) perturbed: min=${min} median=${median} mean=${mean.toFixed(1)} max=${max} ` +
        `(spread=${max - min})`,
    );
  }

  // Also report the best config's own defaults formatted for easy transfer
  // into ribbon.ts.
  const best = results[0];
  console.log();
  console.log(`Best config (for transfer into assignCourseEndpoints defaults):`);
  console.log(JSON.stringify(best.cfg, null, 2));
}

main();
