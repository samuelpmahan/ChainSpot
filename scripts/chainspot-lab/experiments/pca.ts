export interface FactorComponent {
	readonly values: readonly number[];
	readonly scores: readonly number[];
	readonly energyFraction: number;
	readonly singularValue: number;
}

export interface MatrixFactorization {
	readonly rows: number;
	readonly columns: number;
	readonly centered: boolean;
	readonly mean: readonly number[];
	readonly totalEnergy: number;
	readonly components: readonly FactorComponent[];
}

function assertMatrix(input: readonly (readonly number[])[]): { rows: number; columns: number } {
	if (!input.length || !input[0]?.length) throw new Error('PCA requires a non-empty matrix.');
	const columns = input[0].length;
	for (const [rowIndex, row] of input.entries()) {
		if (row.length !== columns) throw new Error(`PCA row ${rowIndex} has ${row.length} columns; expected ${columns}.`);
		for (const [columnIndex, value] of row.entries()) {
			if (!Number.isFinite(value)) throw new Error(`PCA input [${rowIndex},${columnIndex}] is not finite.`);
		}
	}
	return { rows: input.length, columns };
}

function identity(size: number): number[][] {
	return Array.from({ length: size }, (_, row) =>
		Array.from({ length: size }, (_, column) => (row === column ? 1 : 0))
	);
}

/** Deterministic Jacobi eigensolver for the small symmetric sample-space Gram matrices LAB uses. */
function symmetricEigen(input: readonly (readonly number[])[]): { values: number[]; vectors: number[][] } {
	const size = input.length;
	const matrix = input.map((row) => [...row]);
	const vectors = identity(size);
	const tolerance = 1e-12;
	const maxIterations = Math.max(32, size * size * 64);

	for (let iteration = 0; iteration < maxIterations; iteration++) {
		let p = 0;
		let q = 0;
		let largest = 0;
		for (let row = 0; row < size; row++) {
			for (let column = row + 1; column < size; column++) {
				const magnitude = Math.abs(matrix[row][column]);
				if (magnitude > largest) {
					largest = magnitude;
					p = row;
					q = column;
				}
			}
		}
		if (largest <= tolerance) break;

		const app = matrix[p][p];
		const aqq = matrix[q][q];
		const apq = matrix[p][q];
		const angle = 0.5 * Math.atan2(2 * apq, aqq - app);
		const cosine = Math.cos(angle);
		const sine = Math.sin(angle);

		for (let index = 0; index < size; index++) {
			if (index === p || index === q) continue;
			const aip = matrix[index][p];
			const aiq = matrix[index][q];
			matrix[index][p] = matrix[p][index] = cosine * aip - sine * aiq;
			matrix[index][q] = matrix[q][index] = sine * aip + cosine * aiq;
		}
		matrix[p][p] = cosine * cosine * app - 2 * sine * cosine * apq + sine * sine * aqq;
		matrix[q][q] = sine * sine * app + 2 * sine * cosine * apq + cosine * cosine * aqq;
		matrix[p][q] = matrix[q][p] = 0;

		for (let index = 0; index < size; index++) {
			const vip = vectors[index][p];
			const viq = vectors[index][q];
			vectors[index][p] = cosine * vip - sine * viq;
			vectors[index][q] = sine * vip + cosine * viq;
		}
	}

	const order = Array.from({ length: size }, (_, index) => index).sort(
		(a, b) => matrix[b][b] - matrix[a][a] || a - b
	);
	return {
		values: order.map((index) => Math.max(0, matrix[index][index])),
		vectors: order.map((column) => vectors.map((row) => row[column]))
	};
}

function orient(values: number[], scores: number[]): void {
	const scoreSum = scores.reduce((sum, value) => sum + value, 0);
	let sign = scoreSum < 0 ? -1 : 1;
	if (Math.abs(scoreSum) < 1e-12) {
		let largestIndex = 0;
		for (let index = 1; index < values.length; index++) {
			if (Math.abs(values[index]) > Math.abs(values[largestIndex])) largestIndex = index;
		}
		sign = values[largestIndex] < 0 ? -1 : 1;
	}
	if (sign < 0) {
		for (let index = 0; index < values.length; index++) values[index] *= -1;
		for (let index = 0; index < scores.length; index++) scores[index] *= -1;
	}
}

/**
 * Factor a rows=samples, columns=features matrix through sample space.
 * With 16 baskets this diagonalizes 16x16, even when a later experiment has
 * thousands of pixel columns. `center=false` is deliberately called an
 * uncentered factorization, not PCA; `center=true` is ordinary centered PCA.
 */
export function factorMatrix(
	input: readonly (readonly number[])[],
	options: { readonly center: boolean; readonly maxComponents?: number }
): MatrixFactorization {
	const { rows, columns } = assertMatrix(input);
	const mean = Array.from({ length: columns }, (_, column) =>
		input.reduce((sum, row) => sum + row[column], 0) / rows
	);
	const matrix = input.map((row) => row.map((value, column) => value - (options.center ? mean[column] : 0)));
	const gram = Array.from({ length: rows }, (_, left) =>
		Array.from({ length: rows }, (_, right) => {
			let sum = 0;
			for (let column = 0; column < columns; column++) sum += matrix[left][column] * matrix[right][column];
			return sum;
		})
	);
	const eigen = symmetricEigen(gram);
	const totalEnergy = eigen.values.reduce((sum, value) => sum + value, 0);
	const maxComponents = Math.min(options.maxComponents ?? rows, rows, columns);
	const components: FactorComponent[] = [];
	for (let componentIndex = 0; componentIndex < maxComponents; componentIndex++) {
		const eigenvalue = eigen.values[componentIndex];
		if (!(eigenvalue > 1e-12)) break;
		const singularValue = Math.sqrt(eigenvalue);
		const left = eigen.vectors[componentIndex];
		const values = Array.from({ length: columns }, (_, column) => {
			let sum = 0;
			for (let row = 0; row < rows; row++) sum += matrix[row][column] * left[row];
			return sum / singularValue;
		});
		const scores = left.map((value) => value * singularValue);
		orient(values, scores);
		components.push({
			values,
			scores,
			energyFraction: totalEnergy > 0 ? eigenvalue / totalEnergy : 0,
			singularValue
		});
	}
	return { rows, columns, centered: options.center, mean, totalEnergy, components };
}
