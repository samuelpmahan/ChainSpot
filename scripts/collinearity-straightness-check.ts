import { collinearityStraightnessTest } from '../src/lib/autoAnnotation/collinearityStraightnessTest';
import { IMG_5641_GROUND_TRUTH } from '../src/lib/autoAnnotation/courseGroundTruth';
import { buildDashGroundTruth } from './corridorBendGroundTruth';

/**
 * Validates the cheap tee/badge/basket-collinearity straightness pre-check
 * (`collinearityStraightnessTest.ts`) against real, hand-labeled course data
 * -- specifically the Dash course (`IMG_5641`), the only one of this repo's
 * two ground-truth courses with numbered-badge positions (AlexClark's
 * fixture has tee/basket/gutters only; see `corridorBendGroundTruth.ts`'s
 * doc comment).
 *
 * For each of Dash's 18 holes this prints the fitted RMSE (source px) next
 * to the existing bend ground truth (`corridorBendGroundTruth.ts`'s
 * `truthCount`, already used by the corridor-bend-detection benchmark) and
 * reports whether a single RMSE threshold cleanly separates straight from
 * bent holes, plus whether RMSE tracks bend severity.
 *
 * Read-only analysis over checked-in fixtures. Does not touch the live app
 * and does not modify `corridorBendDetection.ts`/its benchmark.
 */

interface Row {
	readonly holeNumber: number;
	readonly rmse: number;
	readonly truthCount: number;
	readonly category: string;
	readonly straight: boolean;
}

function buildRows(): Row[] {
	const teeBasketByNumber = new Map(IMG_5641_GROUND_TRUTH.holes.map((hole) => [hole.number, hole]));
	const badgeByNumber = new Map(IMG_5641_GROUND_TRUTH.badges.map((badge) => [badge.number, badge]));
	const truth = buildDashGroundTruth();

	return truth.map((holeTruth) => {
		const teeBasket = teeBasketByNumber.get(holeTruth.holeNumber);
		const badge = badgeByNumber.get(holeTruth.holeNumber);
		if (!teeBasket || !badge) {
			throw new Error(`Missing tee/basket/badge ground truth for Dash hole ${holeTruth.holeNumber}.`);
		}
		const { rmse } = collinearityStraightnessTest(
			teeBasket.tee,
			{ xPx: badge.xPx, yPx: badge.yPx },
			teeBasket.basket
		);
		return {
			holeNumber: holeTruth.holeNumber,
			rmse,
			truthCount: holeTruth.truthCount,
			category: holeTruth.category,
			straight: holeTruth.truthCount === 0
		};
	});
}

/** Sweeps every midpoint between consecutive sorted RMSE values (plus the extremes) and returns the threshold that maximizes straight/bent classification accuracy, preferring the smallest RMSE on ties. */
function bestSeparatingThreshold(rows: readonly Row[]): { threshold: number; correct: number; wrong: Row[] } {
	const sorted = [...rows].sort((a, b) => a.rmse - b.rmse);
	const candidates = [sorted[0].rmse - 1, ...sorted.slice(0, -1).map((row, i) => (row.rmse + sorted[i + 1].rmse) / 2), sorted[sorted.length - 1].rmse + 1];

	let best = { threshold: candidates[0], correct: -1, wrong: [] as Row[] };
	for (const threshold of candidates) {
		const wrong = rows.filter((row) => (row.rmse <= threshold) !== row.straight);
		const correct = rows.length - wrong.length;
		if (correct > best.correct) best = { threshold, correct, wrong };
	}
	return best;
}

function main(): void {
	const rows = buildRows().sort((a, b) => a.rmse - b.rmse);

	console.log('Dash (IMG_5641) — tee/badge/basket collinearity RMSE, sorted ascending:');
	console.log('hole  rmse(px)  truth  category      label');
	for (const row of rows) {
		console.log(
			`${String(row.holeNumber).padStart(4)}  ${row.rmse.toFixed(2).padStart(8)}  ${String(row.truthCount).padStart(5)}  ${row.category.padEnd(12)}  ${row.straight ? 'straight' : 'bent'}`
		);
	}

	const straightRmses = rows.filter((r) => r.straight).map((r) => r.rmse);
	const bentRmses = rows.filter((r) => !r.straight).map((r) => r.rmse);
	console.log('');
	console.log(`Straight holes (n=${straightRmses.length}): min=${Math.min(...straightRmses).toFixed(2)} max=${Math.max(...straightRmses).toFixed(2)}`);
	console.log(`Bent holes     (n=${bentRmses.length}): min=${Math.min(...bentRmses).toFixed(2)} max=${Math.max(...bentRmses).toFixed(2)}`);

	const best = bestSeparatingThreshold(rows);
	console.log('');
	console.log(`Best single threshold: RMSE <= ${best.threshold.toFixed(2)}px => straight, else bent`);
	console.log(`Accuracy: ${best.correct}/${rows.length} (${((100 * best.correct) / rows.length).toFixed(1)}%)`);
	if (best.wrong.length > 0) {
		console.log('Misclassified:');
		for (const row of best.wrong) {
			const predictedStraight = row.rmse <= best.threshold;
			console.log(
				`  Hole ${row.holeNumber} (${row.category}): rmse=${row.rmse.toFixed(2)}px, truth=${row.straight ? 'straight' : 'bent'}, predicted=${predictedStraight ? 'straight' : 'bent'}`
			);
		}
	} else {
		console.log('Misclassified: none — the threshold separates this dataset perfectly.');
	}

	console.log('');
	console.log('RMSE by category (severity check), sorted ascending within each:');
	const byCategory = new Map<string, number[]>();
	for (const row of rows) {
		if (!byCategory.has(row.category)) byCategory.set(row.category, []);
		byCategory.get(row.category)!.push(row.rmse);
	}
	for (const [category, values] of byCategory) {
		const sortedValues = [...values].sort((a, b) => a - b);
		const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
		console.log(`  ${category.padEnd(12)} n=${values.length}  mean=${mean.toFixed(2)}px  values=[${sortedValues.map((v) => v.toFixed(1)).join(', ')}]`);
	}
}

main();
