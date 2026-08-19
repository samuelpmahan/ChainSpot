// Aggregate Python<->TS parity over every trace pair in a work directory and
// write the markdown parity report.
//
// Usage: npx tsx scripts/nuthing/parity-all.ts PY_DIR TS_DIR REPORT_MD

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { compareTraces } from './parity';

function main(): void {
  const [pyDir, tsDir, reportPath] = process.argv.slice(2);
  if (!pyDir || !tsDir || !reportPath) {
    console.error('Usage: tsx scripts/nuthing/parity-all.ts PY_DIR TS_DIR REPORT_MD');
    process.exit(1);
  }
  const names = readdirSync(pyDir)
    .filter((f) => f.endsWith('.trace.json'))
    .map((f) => f.replace(/\.trace\.json$/, ''))
    .sort();

  const lines: string[] = [];
  lines.push('# NuThing P1 Python ↔ TypeScript parity report');
  lines.push('');
  lines.push(
    'Python reference: `scripts/nuthing-p1-canonical.py` (traces via ' +
      '`scripts/nuthing/p1_trace.py`). TypeScript port: `src/lib/nuthing/p1.ts` ' +
      '(traces via `scripts/nuthing/run-p1.ts`). Both sides consumed ' +
      'bit-identical RGBA dumps; comparison is structural (components matched ' +
      'by bbox+area+centroid, not label id).',
  );
  lines.push('');
  lines.push(
    '| image | bright | dark | badges | ranked | max score Δ | py s | ts s | verdict |',
  );
  lines.push('|---|---|---|---|---|---|---|---|---|');

  let allPass = true;
  const details: string[] = [];
  for (const name of names) {
    const py = JSON.parse(readFileSync(join(pyDir, `${name}.trace.json`), 'utf8'));
    const ts = JSON.parse(readFileSync(join(tsDir, `${name}.trace.json`), 'utf8'));
    const o = compareTraces(py, ts);
    if (!o.pass) allPass = false;
    const s = o.stats;
    lines.push(
      `| ${name} | ${s.brightCount} | ${s.darkCount} | ${s.badgeCount} | ${s.rankedCount} | ` +
        `${s.maxScoreDelta.toExponential(2)} | ${s.pyRuntime.toFixed(2)} | ` +
        `${s.tsRuntime.toFixed(2)} | ${o.pass ? 'PASS' : 'FAIL'} |`,
    );
    if (o.failures.length || o.warnings.length || s.boundaryTies.length) {
      details.push(`## ${name}`);
      for (const f of o.failures) details.push(`- **FAIL** ${f.where}: ${f.detail}`);
      for (const t of s.boundaryTies) details.push(`- TIE ${t}`);
      for (const w of o.warnings) details.push(`- warn: ${w}`);
      details.push('');
    }
    console.log(`${o.pass ? 'PASS' : 'FAIL'} ${name}`);
  }

  lines.push('');
  lines.push('## Tolerated non-semantic differences');
  lines.push('');
  lines.push(
    '- **Score agreement:** every component must score within 2e-6 of the ' +
      'baseline (float32 reduction noise; numpy vectorized float32 exp differs ' +
      'from `Math.fround(Math.exp(...))` by ≤1 ulp).',
  );
  lines.push(
    '- **Tie permutations:** identical rendered glyphs tie exactly; their ' +
      'relative order follows component enumeration order (OpenCV block-based ' +
      'labeling vs raster order), which is an implementation detail on both sides.',
  );
  lines.push(
    '- **Best-shift arg-max:** when several of the 25 shifts score equal to ' +
      '~1e-13, the reported (dx,dy) may differ while the score agrees.',
  );
  lines.push(
    '- **Unstable-axis components:** `np.cov` runs on BLAS whose summation ' +
      'order is not reproducible outside that build. The ~1e-13 covariance ' +
      'noise only becomes visible for components whose PCA axis is undefined ' +
      '(near-circular) or whose canonical projection is grossly clipped ' +
      '(major×scale ≫ 96). These are itemized per image below; scores may ' +
      'differ up to 1e-2 for them and the surviving ranking must still match.',
  );
  lines.push('');
  if (details.length) {
    lines.push('# Per-image notes');
    lines.push('');
    lines.push(...details);
  }
  lines.push(`\n**Overall: ${allPass ? 'PASS' : 'FAIL'}** (${names.length} images)`);
  writeFileSync(reportPath, lines.join('\n'));
  console.log(`report -> ${reportPath}`);
  process.exit(allPass ? 0 : 1);
}

main();
