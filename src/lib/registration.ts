// Pixel↔pixel registration: map thrown-round screenshot pixels onto the
// course-blank composite. Distinct from geo.ts (px ↔ lat/lng): both are
// similarity fits, but the spaces and consumers differ, and neither should
// grow the other's concerns.
//
// Pure TS. The fit is the standard 2D least-squares similarity
// (scale + rotation + translation, no shear/reflection), closed-form.

export interface PxPoint {
	readonly xPx: number;
	readonly yPx: number;
}

export interface RegistrationPair {
	readonly from: PxPoint; // thrown-round image px
	readonly to: PxPoint; // course-composite px
}

export interface Similarity2D {
	readonly scale: number;
	readonly rotationRad: number;
	readonly translate: { readonly x: number; readonly y: number };
}

/**
 * Least-squares similarity from ≥2 pairs. Returns null when the input is
 * degenerate: fewer than 2 pairs, or all `from` points coincident.
 */
export function fitSimilarity(pairs: readonly RegistrationPair[]): Similarity2D | null {
	if (pairs.length < 2) return null;

	let fx = 0;
	let fy = 0;
	let tx = 0;
	let ty = 0;
	for (const p of pairs) {
		fx += p.from.xPx;
		fy += p.from.yPx;
		tx += p.to.xPx;
		ty += p.to.yPx;
	}
	const n = pairs.length;
	fx /= n;
	fy /= n;
	tx /= n;
	ty /= n;

	// Accumulate cross terms of centered coordinates.
	let a = 0; // Σ (f·t)   (dot)
	let b = 0; // Σ (f×t)   (cross)
	let d = 0; // Σ |f|²
	for (const p of pairs) {
		const fxi = p.from.xPx - fx;
		const fyi = p.from.yPx - fy;
		const txi = p.to.xPx - tx;
		const tyi = p.to.yPx - ty;
		a += fxi * txi + fyi * tyi;
		b += fxi * tyi - fyi * txi;
		d += fxi * fxi + fyi * fyi;
	}
	if (d === 0) return null;

	const scale = Math.hypot(a, b) / d;
	if (scale === 0) return null;
	const rotationRad = Math.atan2(b, a);
	const cos = Math.cos(rotationRad) * scale;
	const sin = Math.sin(rotationRad) * scale;
	return {
		scale,
		rotationRad,
		translate: { x: tx - (cos * fx - sin * fy), y: ty - (sin * fx + cos * fy) }
	};
}

export function applySimilarity(t: Similarity2D, p: PxPoint): PxPoint {
	const cos = Math.cos(t.rotationRad) * t.scale;
	const sin = Math.sin(t.rotationRad) * t.scale;
	return {
		xPx: cos * p.xPx - sin * p.yPx + t.translate.x,
		yPx: sin * p.xPx + cos * p.yPx + t.translate.y
	};
}

export interface NumberedBadge {
	readonly n: number;
	readonly xPx: number;
	readonly yPx: number;
}

/**
 * Pair badges by hole number for registration input. A number appearing more
 * than once on EITHER side is ambiguous and contributes nothing — a wrong
 * pair silently skews the whole fit, so ambiguity is dropped, not guessed.
 */
export function matchByHoleNumber(
	round: readonly NumberedBadge[],
	composite: readonly NumberedBadge[]
): RegistrationPair[] {
	const uniqueBy = (badges: readonly NumberedBadge[]): Map<number, NumberedBadge> => {
		const seen = new Map<number, NumberedBadge | null>();
		for (const b of badges) seen.set(b.n, seen.has(b.n) ? null : b);
		const out = new Map<number, NumberedBadge>();
		for (const [n, b] of seen) if (b !== null) out.set(n, b);
		return out;
	};
	const r = uniqueBy(round);
	const c = uniqueBy(composite);
	const pairs: RegistrationPair[] = [];
	for (const [n, rb] of r) {
		const cb = c.get(n);
		if (!cb) continue;
		pairs.push({ from: { xPx: rb.xPx, yPx: rb.yPx }, to: { xPx: cb.xPx, yPx: cb.yPx } });
	}
	return pairs;
}
