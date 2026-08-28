from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one exact block, got {count}")
    p.write_text(text.replace(old, new, 1))


g3 = "packages/alg/src/detectors/threeFactor/features/g3.teeRecovery.ts"
ribbon = "packages/alg/src/detectors/threeFactor/ribbon.ts"

old_recovery = r'''	let best = fallback;
	let bestUnexplained = Infinity;
	let bestResidual = Infinity;
	let bestAxisOffset = Infinity;
	const consider = (centerX: number, centerY: number, axisOffset: number) => {
		const badgeRay = Math.atan2(badgeY - centerY, badgeX - centerX);
		const fit: RecoveryFit = {
			centerXPx: centerX,
			centerYPx: centerY,
			halfWidthPx: halfWidth,
			halfHeightPx: halfHeight,
			angleRad: badgeRay + axisOffset,
			supportThicknessPx: thickness
		};
		let unexplained = 0;
		let residual = 0;
		for (const point of pixels) {
			if (!pointExplainsTee(point, fit)) unexplained++;
			residual += supportResidual(point, fit);
			if (unexplained > bestUnexplained) break;
		}
		const absOffset = Math.abs(axisOffset);
		if (
			unexplained < bestUnexplained ||
			(unexplained === bestUnexplained && residual < bestResidual) ||
			(unexplained === bestUnexplained && residual === bestResidual && absOffset < bestAxisOffset)
		) {
			best = fit;
			bestUnexplained = unexplained;
			bestResidual = residual;
			bestAxisOffset = absOffset;
		}
	};
	const scan = (
		x0: number,
		x1: number,
		y0: number,
		y1: number,
		centerStep: number,
		angleStepDeg: number
	) => {
		for (let y = y0; y <= y1 + 1e-9; y += centerStep) {
			for (let x = x0; x <= x1 + 1e-9; x += centerStep) {
				const scanRangeDeg = Math.max(0.5, activeAxisLimitDeg - 0.5);
				for (let degrees = -scanRangeDeg; degrees <= scanRangeDeg + 1e-9; degrees += angleStepDeg) {
					consider(x, y, degrees * Math.PI / 180);
				}
			}
		}
	};
	// The intersection above is already tiny: a complete H3/H5-sized component
	// leaves only a handful of possible centers. Search it on the native
	// half-pixel centroid lattice so a coarse local optimum cannot hide a valid
	// all-pixels explanation.
	scan(minCenterX, maxCenterX, minCenterY, maxCenterY, 0.5, 0.5);
'''

new_recovery = r'''	let best = fallback;
	let bestUnexplained = Infinity;
	let bestResidual = Infinity;
	let bestAxisOffset = Infinity;

	// The center lattice and angle lattice are unchanged. The speedup is purely
	// evaluation reuse: badgeRay is a property of one center (not one angle),
	// and the support dimensions are properties of this fit call (not one
	// pixel). Only materialize a RecoveryFit when a pose actually becomes the
	// current best instead of allocating one for every pose we inspect.
	const outerHalfWidth = halfWidth + RASTER_TOLERANCE_PX;
	const outerHalfHeight = halfHeight + RASTER_TOLERANCE_PX;
	const effectiveThickness = Math.max(0, thickness);
	const innerEdgeU = halfWidth - effectiveThickness - RASTER_TOLERANCE_PX;
	const innerEdgeV = halfHeight - effectiveThickness - RASTER_TOLERANCE_PX;
	const scanRangeDeg = Math.max(0.5, activeAxisLimitDeg - 0.5);
	const axisOffsets: number[] = [];
	for (let degrees = -scanRangeDeg; degrees <= scanRangeDeg + 1e-9; degrees += 0.5) {
		axisOffsets.push(degrees * Math.PI / 180);
	}

	const consider = (centerX: number, centerY: number, badgeRay: number, axisOffset: number) => {
		const angleRad = badgeRay + axisOffset;
		const c = Math.cos(angleRad);
		const s = Math.sin(angleRad);
		let unexplained = 0;
		let residual = 0;
		for (const point of pixels) {
			const dx = point[0] - centerX;
			const dy = point[1] - centerY;
			const u = dx * c + dy * s;
			const v = -dx * s + dy * c;
			const absU = Math.abs(u);
			const absV = Math.abs(v);
			if (
				absU > outerHalfWidth ||
				absV > outerHalfHeight ||
				(absU < innerEdgeU && absV < innerEdgeV)
			) unexplained++;
			const outer = Math.hypot(
				Math.max(0, absU - halfWidth),
				Math.max(0, absV - halfHeight)
			);
			const edgeDistance = Math.min(
				Math.abs(absU - halfWidth),
				Math.abs(absV - halfHeight)
			);
			residual += outer * 4 + edgeDistance;
			if (unexplained > bestUnexplained) break;
		}
		const absOffset = Math.abs(axisOffset);
		if (
			unexplained < bestUnexplained ||
			(unexplained === bestUnexplained && residual < bestResidual) ||
			(unexplained === bestUnexplained && residual === bestResidual && absOffset < bestAxisOffset)
		) {
			best = {
				centerXPx: centerX,
				centerYPx: centerY,
				halfWidthPx: halfWidth,
				halfHeightPx: halfHeight,
				angleRad,
				supportThicknessPx: thickness
			};
			bestUnexplained = unexplained;
			bestResidual = residual;
			bestAxisOffset = absOffset;
		}
	};
	// Same y -> x -> angle visitation order as the original exhaustive scan.
	for (let y = minCenterY; y <= maxCenterY + 1e-9; y += 0.5) {
		for (let x = minCenterX; x <= maxCenterX + 1e-9; x += 0.5) {
			const badgeRay = Math.atan2(badgeY - y, badgeX - x);
			for (const axisOffset of axisOffsets) consider(x, y, badgeRay, axisOffset);
		}
	}
'''
replace_once(g3, old_recovery, new_recovery)

old_sample = r'''function sampleRgb(image: Float32Array, width: number, height: number, x: number, y: number, channel: number): number {
	const x0 = Math.floor(x);
	const y0 = Math.floor(y);
	const ax = x - x0;
	const ay = y - y0;
	const p00 = (reflect(y0, height) * width + reflect(x0, width)) * 3 + channel;
	const p10 = (reflect(y0, height) * width + reflect(x0 + 1, width)) * 3 + channel;
	const p01 = (reflect(y0 + 1, height) * width + reflect(x0, width)) * 3 + channel;
	const p11 = (reflect(y0 + 1, height) * width + reflect(x0 + 1, width)) * 3 + channel;
	return image[p00] * (1 - ax) * (1 - ay) + image[p10] * ax * (1 - ay) + image[p01] * (1 - ax) * ay + image[p11] * ax * ay;
}
'''

new_sample = r'''interface AxisSampleMap {
	readonly lo: Int32Array;
	readonly hi: Int32Array;
	readonly fraction: Float64Array;
}

/** Precompute the exact floor/reflection/fraction result for integer cell
 * coordinates translated by one fixed sample offset. The original support
 * loop recomputed these values for every cell even though x sampling is
 * independent of y and y sampling is independent of x. */
function axisSampleMap(size: number, offset: number): AxisSampleMap {
	const lo = new Int32Array(size);
	const hi = new Int32Array(size);
	const fraction = new Float64Array(size);
	for (let index = 0; index < size; index++) {
		const coordinate = index + offset;
		const base = Math.floor(coordinate);
		lo[index] = reflect(base, size);
		hi[index] = reflect(base + 1, size);
		fraction[index] = coordinate - base;
	}
	return { lo, hi, fraction };
}

function sampleRgbMappedInto(
	image: Float32Array,
	width: number,
	xMap: AxisSampleMap,
	yMap: AxisSampleMap,
	x: number,
	y: number,
	out: Float64Array,
	offset: number
): void {
	const ax = xMap.fraction[x];
	const ay = yMap.fraction[y];
	const p00 = (yMap.lo[y] * width + xMap.lo[x]) * 3;
	const p10 = (yMap.lo[y] * width + xMap.hi[x]) * 3;
	const p01 = (yMap.hi[y] * width + xMap.lo[x]) * 3;
	const p11 = (yMap.hi[y] * width + xMap.hi[x]) * 3;
	for (let channel = 0; channel < 3; channel++) {
		out[offset + channel] = image[p00 + channel] * (1 - ax) * (1 - ay) + image[p10 + channel] * ax * (1 - ay) + image[p01 + channel] * (1 - ax) * ay + image[p11 + channel] * ax * ay;
	}
}
'''
replace_once(ribbon, old_sample, new_sample)

old_support_loop = r'''	for (let orientation = 0; orientation < parameters.orientations; orientation++) {
		const theta = (Math.PI * orientation) / parameters.orientations;
		const nx = -Math.sin(theta);
		const ny = Math.cos(theta);
		for (const widthSrc of parameters.widthsSrc) {
			const radius = widthSrc / (2 * scale);
			for (let y = 0; y < height; y++) {
				for (let x = 0; x < width; x++) {
					const sample = (distance: number): [number, number, number] => {
						const sx = x + nx * distance;
						const sy = y + ny * distance;
						return [
							sampleRgb(blurred, width, height, sx, sy, 0),
							sampleRgb(blurred, width, height, sx, sy, 1),
							sampleRgb(blurred, width, height, sx, sy, 2)
						];
					};
					const a = sample(-(radius - delta));
					const b = sample(-(radius + delta));
					const c = sample(radius - delta);
					const d = sample(radius + delta);
					const d1 = [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
					const d2 = [c[0] - d[0], c[1] - d[1], c[2] - d[2]];
					const n1 = Math.hypot(...d1);
					const n2 = Math.hypot(...d2);
					const dot = d1[0] * d2[0] + d1[1] * d2[1] + d1[2] * d2[2];
					if (dot <= 0) continue;
					const score = Math.min(n1, n2) * Math.min(1, dot / (n1 * n2 + 1e-6));
					const cell = y * width + x;
					if (score > raw[cell]) {
						raw[cell] = score;
						bestTheta[cell] = theta;
					}
				}
			}
		}
	}
'''

new_support_loop = r'''	const samples = new Float64Array(12);
	for (let orientation = 0; orientation < parameters.orientations; orientation++) {
		const theta = (Math.PI * orientation) / parameters.orientations;
		const nx = -Math.sin(theta);
		const ny = Math.cos(theta);
		for (const widthSrc of parameters.widthsSrc) {
			const radius = widthSrc / (2 * scale);
			const distanceA = -(radius - delta);
			const distanceB = -(radius + delta);
			const distanceC = radius - delta;
			const distanceD = radius + delta;
			const xA = axisSampleMap(width, nx * distanceA);
			const yA = axisSampleMap(height, ny * distanceA);
			const xB = axisSampleMap(width, nx * distanceB);
			const yB = axisSampleMap(height, ny * distanceB);
			const xC = axisSampleMap(width, nx * distanceC);
			const yC = axisSampleMap(height, ny * distanceC);
			const xD = axisSampleMap(width, nx * distanceD);
			const yD = axisSampleMap(height, ny * distanceD);
			for (let y = 0; y < height; y++) {
				for (let x = 0; x < width; x++) {
					sampleRgbMappedInto(blurred, width, xA, yA, x, y, samples, 0);
					sampleRgbMappedInto(blurred, width, xB, yB, x, y, samples, 3);
					sampleRgbMappedInto(blurred, width, xC, yC, x, y, samples, 6);
					sampleRgbMappedInto(blurred, width, xD, yD, x, y, samples, 9);
					const d1r = samples[0] - samples[3];
					const d1g = samples[1] - samples[4];
					const d1b = samples[2] - samples[5];
					const d2r = samples[6] - samples[9];
					const d2g = samples[7] - samples[10];
					const d2b = samples[8] - samples[11];
					const n1 = Math.hypot(d1r, d1g, d1b);
					const n2 = Math.hypot(d2r, d2g, d2b);
					const dot = d1r * d2r + d1g * d2g + d1b * d2b;
					if (dot <= 0) continue;
					const score = Math.min(n1, n2) * Math.min(1, dot / (n1 * n2 + 1e-6));
					const cell = y * width + x;
					if (score > raw[cell]) {
						raw[cell] = score;
						bestTheta[cell] = theta;
					}
				}
			}
		}
	}
'''
replace_once(ribbon, old_support_loop, new_support_loop)
