/**
 * 8-connected component labeling + the exact per-component statistics the
 * Python baseline derives (centroid, bbox, area, biased-covariance PCA
 * orientation, projected major/minor extents, fill, angle).
 *
 * Label numbering: components are numbered 1..N in raster-scan first-encounter
 * order. OpenCV's block-based labeler can emit a different numbering; parity
 * comparisons therefore match components structurally (bbox+area+centroid),
 * not by label id. All downstream semantics operate on component sets and
 * explicitly sorted orders.
 */

import type { Mask } from './raster';

export interface ComponentStats {
	label: number;
	cx: number;
	cy: number;
	area: number;
	bboxX: number;
	bboxY: number;
	bboxW: number;
	bboxH: number;
	/** Projected extent along the PCA major axis (max-min+1). */
	major: number;
	/** Projected extent along the PCA minor axis (max-min+1). */
	minor: number;
	/** Orientation of the (sign-normalized) major axis, radians. */
	angle: number;
	/** Exact component-pixel projection extrema relative to (cx,cy). These are
	 * already computed for major/minor and retained so oriented object bounds
	 * do not have to assume the component is symmetric about its centroid. */
	axisMajorMin?: number;
	axisMajorMax?: number;
	axisMinorMin?: number;
	axisMinorMax?: number;
	/** area / (major*minor), clamped denominator. */
	fill: number;
}

export interface LabeledComponents {
	labels: Int32Array;
	components: ComponentStats[];
}

/**
 * PCA major axis of a point set relative to its centroid, using the biased
 * (divide-by-N) covariance like np.cov(..., bias=True), with the baseline's
 * sign normalization: flip so x > 0, or if |x| ~ 0, y > 0.
 *
 * Closed-form eigen decomposition of the symmetric 2x2 covariance
 * [[cxx, cxy], [cxy, cyy]]; matches np.linalg.eigh + argmax(eigvals) up to
 * floating-point noise. When the matrix is (numerically) diagonal, mirrors
 * eigh's behavior: equal eigenvalues -> argmax picks index 0 -> axis (1,0);
 * otherwise the axis of the larger diagonal entry.
 */
export function majorAxisOf(cxx: number, cxy: number, cyy: number): { ax: number; ay: number } {
	let ax: number;
	let ay: number;
	// np.linalg.eigh on a 2x2 goes through LAPACK dsteqr, which first applies
	// its deflation test (|e|^2 <= eps^2*|d1*d2| + safmin with eps = unit
	// roundoff): a negligible off-diagonal — e.g. the ~1e-16 summation residue
	// of a symmetric glyph — yields exact identity eigenvectors. Otherwise the
	// 2x2 block is solved by dlaev2, whose sign conventions matter for
	// degenerate (circular, 45°) components: the baseline's sign-normalization
	// + canonical projection would otherwise mirror/rotate the mask. Port both
	// paths exactly.
	const EPS = 1.1102230246251565e-16; // dlamch('E')
	const SAFMIN = 2.2250738585072014e-308;
	if (cxy * cxy <= EPS * EPS * Math.abs(cxx) * Math.abs(cyy) + SAFMIN) {
		if (cyy > cxx) {
			ax = 0;
			ay = 1;
		} else {
			ax = 1;
			ay = 0;
		}
	} else {
		// dlaev2(a=cxx, b=cxy, c=cyy): eigenvector (cs1, sn1) of the larger
		// eigenvalue rt1, reproduced verbatim.
		const a = cxx;
		const b = cxy;
		const c = cyy;
		const sm = a + c;
		const df = a - c;
		const adf = Math.abs(df);
		const tb = b + b;
		const ab = Math.abs(tb);
		let rt: number;
		if (adf > ab) {
			rt = adf * Math.sqrt(1 + (ab / adf) * (ab / adf));
		} else if (adf < ab) {
			rt = ab * Math.sqrt(1 + (adf / ab) * (adf / ab));
		} else {
			rt = ab * Math.sqrt(2);
		}
		const sgn1 = sm < 0 ? -1 : 1;
		let cs: number;
		let sgn2: number;
		if (df >= 0) {
			cs = df + rt;
			sgn2 = 1;
		} else {
			cs = df - rt;
			sgn2 = -1;
		}
		const acs = Math.abs(cs);
		let cs1: number;
		let sn1: number;
		if (acs > ab) {
			const ct = -tb / cs;
			sn1 = 1 / Math.sqrt(1 + ct * ct);
			cs1 = ct * sn1;
		} else if (ab === 0) {
			cs1 = 1;
			sn1 = 0;
		} else {
			const tn = -cs / tb;
			cs1 = 1 / Math.sqrt(1 + tn * tn);
			sn1 = tn * cs1;
		}
		if (sgn1 === sgn2) {
			const tn = cs1;
			cs1 = -sn1;
			sn1 = tn;
		}
		ax = cs1;
		ay = sn1;
	}
	if (ax < 0 || (Math.abs(ax) < 1e-9 && ay < 0)) {
		ax = -ax;
		ay = -ay;
	}
	return { ax, ay };
}

interface PixelSet {
	xs: Float64Array;
	ys: Float64Array;
	count: number;
}

/** Statistics identical to the baseline's Component dataclass for one pixel set. */
export function statsForPixels(
	label: number,
	pixels: PixelSet,
	bboxX: number,
	bboxY: number,
	bboxW: number,
	bboxH: number
): ComponentStats | null {
	const n = pixels.count;
	if (n < 2) return null;
	const { xs, ys } = pixels;
	let sx = 0;
	let sy = 0;
	for (let i = 0; i < n; i++) {
		sx += xs[i];
		sy += ys[i];
	}
	const cx = sx / n;
	const cy = sy / n;
	let cxx = 0;
	let cxy = 0;
	let cyy = 0;
	for (let i = 0; i < n; i++) {
		const dx = xs[i] - cx;
		const dy = ys[i] - cy;
		cxx += dx * dx;
		cxy += dx * dy;
		cyy += dy * dy;
	}
	cxx /= n;
	cxy /= n;
	cyy /= n;
	const { ax, ay } = majorAxisOf(cxx, cxy, cyy);
	const mx = -ay;
	const my = ax;
	let uMin = Infinity;
	let uMax = -Infinity;
	let vMin = Infinity;
	let vMax = -Infinity;
	for (let i = 0; i < n; i++) {
		const dx = xs[i] - cx;
		const dy = ys[i] - cy;
		const u = dx * ax + dy * ay;
		const v = dx * mx + dy * my;
		if (u < uMin) uMin = u;
		if (u > uMax) uMax = u;
		if (v < vMin) vMin = v;
		if (v > vMax) vMax = v;
	}
	let major = uMax - uMin + 1;
	let minor = vMax - vMin + 1;
	if (minor > major) {
		const t = major;
		major = minor;
		minor = t;
	}
	const fill = n / Math.max(major * minor, 1.0);
	const angle = Math.atan2(ay, ax);
	return {
		label,
		cx,
		cy,
		area: n,
		bboxX,
		bboxY,
		bboxW,
		bboxH,
		major,
		minor,
		angle,
		axisMajorMin: uMin,
		axisMajorMax: uMax,
		axisMinorMin: vMin,
		axisMinorMax: vMax,
		fill
	};
}

/**
 * Two-pass 8-connected labeling with union-find, then per-component stats.
 * Mirrors extract_components() in the baseline (components with fewer than
 * 2 pixels are dropped from the stats list but keep their label in `labels`).
 */
export function extractComponents(mask: Mask): LabeledComponents {
	const { width, height, data } = mask;
	const n = width * height;
	const labels = new Int32Array(n);
	// Union-find over provisional labels.
	const parent: number[] = [0];
	const find = (a: number): number => {
		let r = a;
		while (parent[r] !== r) r = parent[r];
		while (parent[a] !== r) {
			const next = parent[a];
			parent[a] = r;
			a = next;
		}
		return r;
	};
	const union = (a: number, b: number): void => {
		const ra = find(a);
		const rb = find(b);
		if (ra !== rb) {
			if (ra < rb) parent[rb] = ra;
			else parent[ra] = rb;
		}
	};

	let next = 1;
	for (let y = 0; y < height; y++) {
		const row = y * width;
		const prev = row - width;
		for (let x = 0; x < width; x++) {
			if (!data[row + x]) continue;
			let best = 0;
			const tryNeighbor = (idx: number): void => {
				const l = labels[idx];
				if (l) {
					if (!best) best = l;
					else if (l !== best) union(best, l);
				}
			};
			if (x > 0 && data[row + x - 1]) tryNeighbor(row + x - 1);
			if (y > 0) {
				if (data[prev + x]) tryNeighbor(prev + x);
				if (x > 0 && data[prev + x - 1]) tryNeighbor(prev + x - 1);
				if (x < width - 1 && data[prev + x + 1]) tryNeighbor(prev + x + 1);
			}
			if (!best) {
				best = next++;
				parent.push(best);
			}
			labels[row + x] = best;
		}
	}

	// Compact to final labels in raster-scan first-encounter order.
	const remap = new Int32Array(next);
	let finalCount = 0;
	for (let i = 0; i < n; i++) {
		const l = labels[i];
		if (!l) continue;
		const r = find(l);
		if (!remap[r]) remap[r] = ++finalCount;
		labels[i] = remap[r];
	}

	// Gather pixels per component.
	const areas = new Int32Array(finalCount + 1);
	for (let i = 0; i < n; i++) if (labels[i]) areas[labels[i]]++;
	const xsAll: Float64Array[] = [];
	const ysAll: Float64Array[] = [];
	const fill = new Int32Array(finalCount + 1);
	const minX = new Int32Array(finalCount + 1).fill(width);
	const minY = new Int32Array(finalCount + 1).fill(height);
	const maxX = new Int32Array(finalCount + 1).fill(-1);
	const maxY = new Int32Array(finalCount + 1).fill(-1);
	for (let l = 1; l <= finalCount; l++) {
		xsAll.push(new Float64Array(areas[l]));
		ysAll.push(new Float64Array(areas[l]));
	}
	for (let y = 0; y < height; y++) {
		const row = y * width;
		for (let x = 0; x < width; x++) {
			const l = labels[row + x];
			if (!l) continue;
			const k = fill[l]++;
			xsAll[l - 1][k] = x;
			ysAll[l - 1][k] = y;
			if (x < minX[l]) minX[l] = x;
			if (y < minY[l]) minY[l] = y;
			if (x > maxX[l]) maxX[l] = x;
			if (y > maxY[l]) maxY[l] = y;
		}
	}

	const components: ComponentStats[] = [];
	for (let l = 1; l <= finalCount; l++) {
		const stats = statsForPixels(
			l,
			{ xs: xsAll[l - 1], ys: ysAll[l - 1], count: areas[l] },
			minX[l],
			minY[l],
			maxX[l] - minX[l] + 1,
			maxY[l] - minY[l] + 1
		);
		if (stats) components.push(stats);
	}
	return { labels, components };
}

/** Pixel coordinates of one labeled component, in raster order. */
export function componentPixels(
	labels: Int32Array,
	width: number,
	c: ComponentStats
): { xs: Float64Array; ys: Float64Array; count: number } {
	const xs: number[] = [];
	const ys: number[] = [];
	const x1 = c.bboxX + c.bboxW;
	const y1 = c.bboxY + c.bboxH;
	for (let y = c.bboxY; y < y1; y++) {
		const row = y * width;
		for (let x = c.bboxX; x < x1; x++) {
			if (labels[row + x] === c.label) {
				xs.push(x);
				ys.push(y);
			}
		}
	}
	return { xs: Float64Array.from(xs), ys: Float64Array.from(ys), count: xs.length };
}
