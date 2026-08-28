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

		// Unexplained-pixel count dominates the ordering. Once this pose has more
		// unexplained pixels than the current best, its residual can never affect
		// selection, so do not compute any of that expensive distance math.
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
			) {
				unexplained++;
				if (unexplained > bestUnexplained) break;
			}
		}
		if (unexplained > bestUnexplained) return;

		// Only poses that can still win pay for the original residual, in the
		// original pixel order and with the original arithmetic.
		let residual = 0;
		for (const point of pixels) {
			const dx = point[0] - centerX;
			const dy = point[1] - centerY;
			const u = dx * c + dy * s;
			const v = -dx * s + dy * c;
			const absU = Math.abs(u);
			const absV = Math.abs(v);
			const outer = Math.hypot(
				Math.max(0, absU - halfWidth),
				Math.max(0, absV - halfHeight)
			);
			const edgeDistance = Math.min(
				Math.abs(absU - halfWidth),
				Math.abs(absV - halfHeight)
			);
			residual += outer * 4 + edgeDistance;
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

	// Same exhaustive y -> x -> angle lattice and visitation order. badgeRay is
	// a center property, so calculate it once per center rather than once for
	// every angle hypothesis at that center.
	for (let y = minCenterY; y <= maxCenterY + 1e-9; y += 0.5) {
		for (let x = minCenterX; x <= maxCenterX + 1e-9; x += 0.5) {
			const badgeRay = Math.atan2(badgeY - y, badgeX - x);
			for (const axisOffset of axisOffsets) consider(x, y, badgeRay, axisOffset);
		}
	}
'''
replace_once(g3, old_recovery, new_recovery)

old_support = r'''					const d1 = [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
					const d2 = [c[0] - d[0], c[1] - d[1], c[2] - d[2]];
					const n1 = Math.hypot(...d1);
					const n2 = Math.hypot(...d2);
					const dot = d1[0] * d2[0] + d1[1] * d2[1] + d1[2] * d2[2];
					if (dot <= 0) continue;
					const score = Math.min(n1, n2) * Math.min(1, dot / (n1 * n2 + 1e-6));
'''

new_support = r'''					const d1r = a[0] - b[0];
					const d1g = a[1] - b[1];
					const d1b = a[2] - b[2];
					const d2r = c[0] - d[0];
					const d2g = c[1] - d[1];
					const d2b = c[2] - d[2];
					const dot = d1r * d2r + d1g * d2g + d1b * d2b;
					if (dot <= 0) continue;
					// Norms are irrelevant when opposing/zero gradients already fail the
					// dot-product gate. Preserve the exact hypot calls for surviving cells.
					const n1 = Math.hypot(d1r, d1g, d1b);
					const n2 = Math.hypot(d2r, d2g, d2b);
					const score = Math.min(n1, n2) * Math.min(1, dot / (n1 * n2 + 1e-6));
'''
replace_once(ribbon, old_support, new_support)
