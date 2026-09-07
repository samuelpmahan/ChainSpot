import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { executeNodeCanonicalInputTick } from '../packages/alg/dist/exec/node-intake.js';
import { createPxCRootMounts } from '../packages/alg/dist/exec/mounts.js';
import { createStage } from '../packages/alg/dist/stages/S1/exp/badge-assembly/stage.js';
import { S0_CROPPED_IMAGE_ADDRESS } from '../packages/alg/dist/stages/S0/clean/index.js';

const [corpusRoot = 'chainspot-corpus/dev', output = '/tmp/warm-dev-pxc-roots.json'] = process.argv.slice(2);
const TARGET_MS = 40_000;
const HARD_MS = 55_000;
const started = performance.now();
const watchdog = setTimeout(() => {
	console.error(`HARD WATCHDOG: warm PxC roots exceeded ${HARD_MS}ms`);
	process.exit(124);
}, HARD_MS);

const yaml = readFileSync(
	resolve('packages/alg/dist/stages/S1/exp/badge-assembly/PrincipleComponentRender.yaml'),
	'utf8'
);
const roots = createPxCRootMounts();
const labels = new Map();
const rows = [];

function fullImageIn(dir) {
	const files = readdirSync(dir)
		.filter((name) => /\.(png|jpe?g)$/i.test(name))
		.sort();
	return files.find((name) => /-full\./i.test(name)) ?? files[0];
}

for (const label of readdirSync(corpusRoot).sort()) {
	if (label === 'Annotated') continue;
	const dir = join(corpusRoot, label);
	if (!statSync(dir).isDirectory()) continue;
	const file = fullImageIn(dir);
	if (!file) continue;

	const imagePath = resolve(dir, file);
	const s0 = await executeNodeCanonicalInputTick(imagePath);
	const defaultResult = createStage(yaml).run({ pxc: s0.pxc }).find(
		(result) => result.kind === 'default' && result.status === 'completed'
	);
	if (!defaultResult) throw new Error(`${label}: Default S1 world did not complete.`);

	const root = s0.fullImage.imageId;
	roots.mount(root, defaultResult.pxc);
	labels.set(root, label);
	rows.push({
		label,
		root,
		input: basename(imagePath),
		croppedPx: {
			width: defaultResult.pxc.get(S0_CROPPED_IMAGE_ADDRESS).widthPx,
			height: defaultResult.pxc.get(S0_CROPPED_IMAGE_ADDRESS).heightPx
		}
	});
}

// Wide access proof: one semantic address, independently resolved in every mounted world.
const wideCanonicalPixels = roots.entries().map(([root, pxc]) => {
	const image = pxc.get(S0_CROPPED_IMAGE_ADDRESS);
	return { root, label: labels.get(root), widthPx: image.widthPx, heightPx: image.heightPx };
});

const elapsedMs = performance.now() - started;
clearTimeout(watchdog);
const report = {
	rootSemantics: '<ImgID>/{px.*,fn.*}',
	addressMutation: false,
	mountedRoots: roots.roots().length,
	targetMs: TARGET_MS,
	hardMs: HARD_MS,
	elapsedMs,
	withinTarget: elapsedMs <= TARGET_MS,
	rows,
	wideCanonicalPixels
};
writeFileSync(output, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (elapsedMs > TARGET_MS) console.warn(`TARGET MISS: ${elapsedMs.toFixed(1)}ms > ${TARGET_MS}ms (hard limit still ${HARD_MS}ms)`);
