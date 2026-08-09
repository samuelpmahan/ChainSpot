import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { runDetection as runTeeDetection } from './detect-tees';
import { runDetection as runBasketDetection } from './detect-baskets';
import { loadValidatedCvTemplateManifest } from './cv-template-manifest';

function invariant(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(`CV guardrail regression failed: ${message}`);
}

async function main(): Promise<void> {
	const projectRoot = resolve(import.meta.dirname, '..');
	const templateDir = join(projectRoot, 'static', 'resources', 'chainspot_cv_templates');
	const teeFixture = join(projectRoot, 'resources', 'GoldenTeeSet.chainspot.zip');
	const basketFixture = join(projectRoot, 'resources', 'GoldenBasketSet.chainspot.zip');
	const outputRoot = mkdtempSync(join(tmpdir(), 'chainspot-cv-guardrail-'));
	loadValidatedCvTemplateManifest(templateDir);

	try {
		const tee = await runTeeDetection({
			inputPath: teeFixture,
			mode: 'fused',
			outputDir: join(outputRoot, 'tees'),
			templateDir,
			maxCandidates: 18,
			ignoreCirclesPx: []
		});

		invariant(Number.isFinite(tee.uiScalePx) && tee.uiScalePx > 0, 'derived UiScalePx is not positive and finite');
		invariant(tee.numberDetection, 'tee fixture did not run raw number detection');
		invariant(tee.numberDetection.labeling === 'assigned', `number labeling is ${tee.numberDetection.labeling}, expected assigned`);
		invariant(tee.numberDetection.candidateCount === 18, `number candidate count is ${tee.numberDetection.candidateCount}, expected 18`);
		invariant(tee.numberDetection.labeledCount === 18, `number labeled count is ${tee.numberDetection.labeledCount}, expected 18`);
		const labels = tee.numberDetection.candidates.map((candidate) => candidate.label).sort((a, b) => (a ?? 0) - (b ?? 0));
		invariant(labels.every((label, index) => label === index + 1), `number labels are not exactly 1..18: ${labels.join(',')}`);
		for (const candidate of tee.numberDetection.candidates) {
			invariant(Number.isFinite(candidate.xPx) && Number.isFinite(candidate.yPx), `number ${candidate.label ?? '?'} has non-finite coordinates`);
			invariant(candidate.xPx >= 0 && candidate.xPx <= tee.input.widthPx, `number ${candidate.label ?? '?'} x is out of bounds`);
			invariant(candidate.yPx >= 0 && candidate.yPx <= tee.input.heightPx, `number ${candidate.label ?? '?'} y is out of bounds`);
		}
		invariant(tee.truthEvaluation, 'GoldenTeeSet does not contain tee truth');
		invariant(tee.candidateCount === 18, `fused tee candidate count is ${tee.candidateCount}, expected 18`);
		invariant(tee.truthEvaluation.matchedNumbers.length >= 17, `tee raw recall is ${tee.truthEvaluation.matchedNumbers.length}/18, expected at least 17/18`);
		invariant(
			tee.truthEvaluation.missedNumbers.every((number) => number === 5),
			`unexpected tee misses: ${tee.truthEvaluation.missedNumbers.join(',')}`
		);

		loadValidatedCvTemplateManifest(templateDir);
		const baskets = await runBasketDetection({
			inputPath: basketFixture,
			outputDir: join(outputRoot, 'baskets'),
			templateDir,
			maxCandidates: 18
		});
		invariant(baskets.truthEvaluation, 'GoldenBasketSet does not contain basket truth');
		invariant(baskets.truthEvaluation.matchedNumbers.length === 18, `basket raw recall is ${baskets.truthEvaluation.matchedNumbers.length}/18, expected 18/18`);
		invariant(baskets.truthEvaluation.falsePositiveCount === 0, `basket false positives are ${baskets.truthEvaluation.falsePositiveCount}, expected 0`);

		console.log(
			JSON.stringify(
				{
					numbers: {
						labeling: tee.numberDetection.labeling,
						candidates: tee.numberDetection.candidateCount,
						labeled: tee.numberDetection.labeledCount
					},
					uiScalePx: tee.uiScalePx,
					tees: {
						candidates: tee.candidateCount,
						matched: tee.truthEvaluation.matchedNumbers.length,
						missed: tee.truthEvaluation.missedNumbers,
						falsePositives: tee.truthEvaluation.falsePositiveCount
					},
					baskets: {
						candidates: baskets.candidateCount,
						matched: baskets.truthEvaluation.matchedNumbers.length,
						missed: baskets.truthEvaluation.missedNumbers,
						falsePositives: baskets.truthEvaluation.falsePositiveCount
					}
				},
				null,
				2
			)
		);
	} finally {
		rmSync(outputRoot, { recursive: true, force: true });
	}
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
