/**
 * NumPy-compatible numeric kernels. The Python baseline runs its inner loops
 * on float32 arrays (cv2 distance transforms), so means and thresholds are
 * float32 arithmetic with numpy's pairwise summation. Reproducing those exact
 * semantics keeps borderline comparisons (template >= 0.5, quantile cutoffs,
 * score ordering) on the same side as the baseline.
 */

const f = Math.fround;

/**
 * numpy pairwise summation over float32 values (loops.c.src pairwise_sum):
 * sequential below 8 elements, 8-way unrolled up to 128, recursive halving
 * (rounded down to a multiple of 8) above. All partial sums in float32.
 */
export function pairwiseSumF32(a: ArrayLike<number>, offset: number, n: number): number {
	if (n < 8) {
		let res = 0;
		for (let i = 0; i < n; i++) res = f(res + a[offset + i]);
		return res;
	}
	if (n <= 128) {
		const r = new Float32Array(8);
		for (let j = 0; j < 8; j++) r[j] = a[offset + j];
		let i = 8;
		const limit = n - (n % 8);
		for (; i < limit; i += 8) {
			for (let j = 0; j < 8; j++) r[j] = f(r[j] + a[offset + i + j]);
		}
		let res = f(f(f(r[0] + r[1]) + f(r[2] + r[3])) + f(f(r[4] + r[5]) + f(r[6] + r[7])));
		for (; i < n; i++) res = f(res + a[offset + i]);
		return res;
	}
	let n2 = n >> 1;
	n2 -= n2 % 8;
	return f(pairwiseSumF32(a, offset, n2) + pairwiseSumF32(a, offset + n2, n - n2));
}

/** np.mean of a float32 array -> float32 result widened to double. */
export function meanF32(a: ArrayLike<number>, n: number): number {
	return f(pairwiseSumF32(a, 0, n) / n);
}

/** np.rint — round half to even. */
export function rintHalfEven(x: number): number {
	const floor = Math.floor(x);
	const diff = x - floor;
	if (diff < 0.5) return floor;
	if (diff > 0.5) return floor + 1;
	return floor % 2 === 0 ? floor : floor + 1;
}

/**
 * np.quantile(float32_values, q, method="linear"): numpy's _lerp computes
 * diff = float32(b - a) then interpolates in float64, using the
 * b - diff * (1 - t) form when t >= 0.5.
 */
export function quantileF32Linear(sortedF32: Float32Array, q: number): number {
	const n = sortedF32.length;
	if (n === 1) return sortedF32[0];
	const pos = q * (n - 1);
	const lo = Math.floor(pos);
	const t = pos - lo;
	if (lo + 1 >= n) return sortedF32[n - 1];
	const a = sortedF32[lo];
	const b = sortedF32[lo + 1];
	const diff = f(b - a);
	return t < 0.5 ? a + diff * t : b - diff * (1 - t);
}
