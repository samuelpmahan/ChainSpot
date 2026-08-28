// Mirrors old-stuff/tests/unit/badgeGlyphClassifier.test.ts's core assertion
// against this port: every canonical template must classify as itself.
import { loadTemplatesFromDisk, classifyKnownBadgeBodiesPureTs } from './oldClassifier.ts';

const dir = '/home/user/ChainSpot/.claude/worktrees/agent-a0da58feaf09b2fd8/old-stuff/static/resources/chainspot_cv_templates';
const { templates } = loadTemplatesFromDisk(dir);
let correct = 0;
for (const t of templates) {
  const raster = { data: t.raster.data, widthPx: t.raster.widthPx, heightPx: t.raster.heightPx };
  const body = { xPx: raster.widthPx / 2, yPx: raster.heightPx / 2, widthPx: raster.widthPx, heightPx: raster.heightPx };
  const [result] = classifyKnownBadgeBodiesPureTs(raster, templates, [body]);
  if (result.label === t.label) correct++;
  else console.log('MISMATCH', t.label, result);
}
console.log(`self-test: ${correct}/${templates.length} templates classify as themselves`);
if (correct !== templates.length) process.exit(1);
