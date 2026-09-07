const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');
const { decodeNodeFile } = require('../../packages/alg/dist/adapters/node.js');
const { stageContract: s0Contract } = require('../../packages/alg/dist/stages/S0/contract.js');
const { stageContract: s1Contract } = require('../../packages/alg/dist/stages/S1/contract.js');
const { stageContract: s2Contract } = require('../../packages/alg/dist/stages/S2/contract.js');
const { stageContract: s3Contract } = require('../../packages/alg/dist/stages/S3/contract.js');
const { executeS3VisibleTees, materializeS3Subtraction } = require('../../packages/alg/dist/stages/S3/clean/index.js');

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }
function writePng(filePath, panel) {
  const png = new PNG({ width: panel.widthPx, height: panel.heightPx });
  png.data = Buffer.from(panel.rgba);
  fs.writeFileSync(filePath, PNG.sync.write(png));
}
function slug(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

async function main() {
  const imagePath = path.resolve(process.argv[2]);
  const outDir = path.resolve(process.argv[3]);
  if (!fs.existsSync(imagePath)) throw new Error(`image does not exist: ${imagePath}`);
  ensureDir(outDir);

  const base = { source: imagePath, inputLabel: path.basename(imagePath), decode: decodeNodeFile };
  const s0 = await s0Contract.execute(base);
  const s1 = await s1Contract.execute({ ...base, pxc: s0.pxc });
  const s2 = await s2Contract.execute({ ...base, pxc: s1.pxc });
  const s3 = await s3Contract.execute({ ...base, pxc: s2.pxc });
  const run = executeS3VisibleTees(s2.pxc);
  const subtraction = materializeS3Subtraction(run.image, run.tees);

  const panels = {};
  for (const [stage, stagePanels] of [['s0', s0.panels], ['s1', s1.panels], ['s2', s2.panels], ['s3', s3.panels]]) {
    for (const panel of stagePanels) {
      const file = `${stage}-${slug(panel.label)}.png`;
      writePng(path.join(outDir, file), panel);
      panels[`${stage}:${panel.label}`] = file;
    }
  }

  const teePixels = new Set();
  for (const tee of run.tees) for (const px of tee.px) teePixels.add(Number(px));
  const familyFrames = new Set(run.family.members.map((member) => member.frame.label));

  const frame = (member, index) => ({
    order: index + 1,
    ring: member.ring,
    bbox: [member.frame.bboxX, member.frame.bboxY, member.frame.bboxW, member.frame.bboxH],
    major: member.frame.major,
    minor: member.frame.minor,
    area: member.frame.area,
    angle: member.frame.angle,
    label: member.frame.label
  });

  const snapshot = {
    schema: 'chainspot-quick-anno-s3-snapshot@1',
    input: imagePath,
    panels,
    s0Receipt: s0.receiptText,
    s1Receipt: s1.receiptText,
    s2Receipt: s2.receiptText,
    s3Receipt: s3.receiptText,
    canonical: { widthPx: run.image.widthPx, heightPx: run.image.heightPx },
    counts: {
      enclosed: run.rings.enclosed.length,
      elongated: run.rings.elongated.length,
      excludedByBadge: run.rings.excludedByBadge.length,
      candidates: run.rings.candidates.length,
      measured: run.family.measured.length,
      unframed: run.family.unframed.length,
      family: run.family.members.length,
      tees: run.tees.length,
      teePx: subtraction.teePx,
      overlapPx: subtraction.overlapPx,
      remainingOpaquePx: subtraction.remainingOpaquePx
    },
    rings: {
      candidates: run.rings.candidates,
      excludedByBadge: run.rings.excludedByBadge
    },
    measured: run.family.measured.map(frame),
    unframed: run.family.unframed,
    rejectedFramed: run.family.measured.filter((member) => !familyFrames.has(member.frame.label)).map(frame),
    family: run.family.members.map(frame),
    tees: run.tees.map((tee, index) => ({
      order: index + 1,
      center: tee.center,
      innerBbox: tee.innerBbox,
      bbox: tee.bbox,
      angleRad: tee.angleRad,
      pxCount: tee.px.length,
      px: Array.from(tee.px, Number)
    })),
    teePixels: [...teePixels].sort((a, b) => a - b),
    runtimePcr: run.pcr
  };

  fs.writeFileSync(path.join(outDir, 'snapshot.json'), JSON.stringify(snapshot, null, 2));
  fs.writeFileSync(path.join(outDir, 's3.receipt.txt'), s3.receiptText + '\n');
  console.log(path.join(outDir, 'snapshot.json'));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
