import type {
	BadgeEvidence,
	BasketEvidence,
	CorridorParams,
	LegEvidence,
	PairFactorBreakdown,
	RawPairEvidence,
	ScoredPairEvidence,
	SupportFieldEvidence,
	TeeEvidence
} from './types';

function cell(field: SupportFieldEvidence, x: number, y: number, yOffsetPx: number): number {
	const cx = Math.max(0, Math.min(field.width - 1, Math.round(x / field.scale)));
	const cy = Math.max(0, Math.min(field.height - 1, Math.round((y - yOffsetPx) / field.scale)));
	return cy * field.width + cx;
}

function supportAt(field: SupportFieldEvidence, point: readonly [number, number], yOffsetPx: number): number {
	return field.support[cell(field, point[0], point[1], yOffsetPx)];
}

function canonicalPath(teeLeg: LegEvidence, basketLeg: LegEvidence): readonly [number, number][] {
	return [...teeLeg.path].reverse().concat(basketLeg.path.slice(1));
}

function weakWindow(samples: readonly number[], windowCells: number): number {
	if (!samples.length) return 0;
	if (samples.length <= windowCells) return samples.reduce((sum, value) => sum + value, 0) / samples.length;
	let sum = samples.slice(0, windowCells).reduce((total, value) => total + value, 0);
	let worst = sum / windowCells;
	for (let i = windowCells; i < samples.length; i++) {
		sum += samples[i] - samples[i - windowCells];
		worst = Math.min(worst, sum / windowCells);
	}
	return worst;
}

function endpointSupport(field: SupportFieldEvidence, leg: LegEvidence, yOffsetPx: number): number {
	const samples = leg.path.slice(-3);
	return samples.length ? samples.reduce((sum, point) => sum + supportAt(field, point, yOffsetPx), 0) / samples.length : 0;
}

function zoneFactor(
	field: SupportFieldEvidence,
	point: readonly [number, number],
	baskets: readonly BasketEvidence[],
	ownBasketId: string,
	yOffsetPx: number
): number {
	const [x, y] = point;
	for (const basket of baskets) {
		if (basket.detId === ownBasketId) continue;
		const d = Math.hypot(x - basket.centerXPx, y - basket.centerYPx);
		if (d <= 35) return 0.4;
		if (Math.abs(d - 84) <= 12 || Math.abs(d - 44) <= 8) {
			const theta = field.bestTheta[cell(field, x, y, yOffsetPx)];
			const radial = Math.abs(((x - basket.centerXPx) * Math.cos(theta) + (y - basket.centerYPx) * Math.sin(theta)) / Math.max(d, 1e-9));
			if (radial <= 0.5) return 0.4;
		}
	}
	return 1;
}

function alignedSamples(
	field: SupportFieldEvidence,
	path: readonly [number, number][],
	baskets: readonly BasketEvidence[],
	ownBasketId: string,
	params: CorridorParams,
	yOffsetPx: number
): number[] {
	const samples: number[] = [];
	for (let i = 0; i < path.length; i++) {
		const previous = path[Math.max(0, i - 1)];
		const next = path[Math.min(path.length - 1, i + 1)];
		const length = Math.hypot(next[0] - previous[0], next[1] - previous[1]);
		const fieldCell = cell(field, path[i][0], path[i][1], yOffsetPx);
		const alignment = length ? Math.abs(((next[0] - previous[0]) * Math.cos(field.bestTheta[fieldCell]) + (next[1] - previous[1]) * Math.sin(field.bestTheta[fieldCell])) / length) : 1;
		const support = field.support[fieldCell] * alignment ** params.alignmentPower;
		samples.push(support * zoneFactor(field, path[i], baskets, ownBasketId, yOffsetPx));
	}
	return samples;
}

function alignedPairSamples(
	field: SupportFieldEvidence,
	teeLeg: LegEvidence,
	basketLeg: LegEvidence,
	baskets: readonly BasketEvidence[],
	ownBasketId: string,
	params: CorridorParams,
	yOffsetPx: number
): number[] {
	// The reference scores each leg independently: a basket's furniture is
	// exempt only on the basket leg, never on the tee leg. Concatenate after
	// applying that distinction so a route cannot borrow its own basket's zone
	// while travelling from the tee to the badge.
	const tee = alignedSamples(field, teeLeg.path, baskets, '', params, yOffsetPx).reverse();
	const basket = alignedSamples(field, basketLeg.path, baskets, ownBasketId, params, yOffsetPx);
	return tee.concat(basket.slice(1));
}

function overlapFactor(
	teeLeg: LegEvidence,
	basketLeg: LegEvidence,
	badge: BadgeEvidence,
	yOffsetPx: number
): number {
	const teeCells = new Set(teeLeg.path.map(([x, y]) => `${Math.round(x)}:${Math.round(y)}`));
	const outside = basketLeg.path.filter(([x, y]) => Math.hypot(x - badge.cxPx, y - badge.cyPx) > 8);
	if (!outside.length) return 1;
	const shared = outside.filter(([x, y]) => teeCells.has(`${Math.round(x)}:${Math.round(y)}`)).length;
	const overlap = shared / outside.length;
	return (1 - overlap) ** 2;
}

function angleDegrees(a: number, b: number): number {
	let delta = Math.abs(a - b) % Math.PI;
	if (delta > Math.PI / 2) delta = Math.PI - delta;
	return (delta * 180) / Math.PI;
}

function geometryFactors(badge: BadgeEvidence, tee: TeeEvidence, basket: BasketEvidence): Pick<PairFactorBreakdown, 'teeOrientation' | 'badgeFraction' | 'collinearity'> {
	const tx = tee.xPx;
	const ty = tee.yPx;
	const bx = basket.tipXPx;
	const by = basket.tipYPx;
	const dx = bx - tx;
	const dy = by - ty;
	const chord = Math.hypot(dx, dy);
	const teeToBadge = Math.atan2(badge.cyPx - ty, badge.cxPx - tx);
	const teeAngle = tee.angleRad === null ? 0 : angleDegrees(tee.angleRad, teeToBadge);
	const teeOrientation = tee.angleRad === null ? 1 : Math.exp(-((teeAngle / 12) ** 2));
	const fraction = chord > 0 ? ((badge.cxPx - tx) * dx + (badge.cyPx - ty) * dy) / (chord * chord) : 0.5;
	const excess = Math.max(0, Math.abs(fraction - 0.36) - 0.19);
	const badgeFraction = Math.exp(-((excess / 0.15) ** 2));
	const badgeAngle = Math.atan2(badge.cyPx - ty, badge.cxPx - tx);
	const endpointAngle = Math.atan2(by - ty, bx - tx);
	const collinearityDegrees = angleDegrees(badgeAngle, endpointAngle);
	const collinearity = 1 + 0.6 * Math.exp(-((collinearityDegrees / 2) ** 2));
	return { teeOrientation, badgeFraction, collinearity };
}

function zfitFactor(
	field: SupportFieldEvidence,
	badge: BadgeEvidence,
	tee: TeeEvidence,
	basket: BasketEvidence,
	baskets: readonly BasketEvidence[],
	params: CorridorParams,
	yOffsetPx: number,
	current: number
): number {
	if (current >= 0.28) return 1;
	const chord = Math.hypot(basket.tipXPx - tee.xPx, basket.tipYPx - tee.yPx);
	const firstLength = Math.hypot(badge.cxPx - tee.xPx, badge.cyPx - tee.yPx);
	if (chord < 1 || firstLength < 1) return 1;
	const ux = (badge.cxPx - tee.xPx) / firstLength;
	const uy = (badge.cyPx - tee.yPx) / firstLength;
	let best = current;
	for (let distance = firstLength + 8; distance <= Math.min(chord * 0.85, firstLength + 220); distance += 14) {
		const p1: [number, number] = [tee.xPx + ux * distance, tee.yPx + uy * distance];
		for (const bendDegrees of [-60, -45, -30, -20, 0, 20, 30, 45, 60]) {
			const radians = (bendDegrees * Math.PI) / 180;
			const vx = ux * Math.cos(radians) - uy * Math.sin(radians);
			const vy = ux * Math.sin(radians) + uy * Math.cos(radians);
			const lengths = bendDegrees === 0 ? [0] : [0.8 * params.corridorWidthPx, 1.6 * params.corridorWidthPx, 3 * params.corridorWidthPx];
			for (const secondLength of lengths) {
				const p2: [number, number] = [p1[0] + vx * secondLength, p1[1] + vy * secondLength];
				if (distance + secondLength + Math.hypot(basket.tipXPx - p2[0], basket.tipYPx - p2[1]) > 1.4 * chord) continue;
				const path: [number, number][] = [];
				const segments: readonly [number, number, number, number][] = [[tee.xPx, tee.yPx, p1[0], p1[1]], ...(secondLength ? [[p1[0], p1[1], p2[0], p2[1]] as [number, number, number, number]] : []), [p2[0], p2[1], basket.tipXPx, basket.tipYPx]];
				for (const [x0, y0, x1, y1] of segments) {
					const length = Math.hypot(x1 - x0, y1 - y0);
					const steps = Math.max(1, Math.round(length / field.scale));
					for (let i = 1; i <= steps; i++) path.push([x0 + (x1 - x0) * i / steps, y0 + (y1 - y0) * i / steps]);
				}
				const samples = alignedSamples(field, path, baskets, basket.detId, params, yOffsetPx);
				const bendFactor = bendDegrees === 0 ? 1 : secondLength > 0 ? 0.8 : 0.9;
				best = Math.max(best, weakWindow(samples, Math.max(3, Math.round(params.worstWindowSrcPx / field.scale))) * bendFactor * 0.9);
			}
		}
	}
	return best > current ? best / Math.max(current, 1e-6) : 1;
}

export function makeRawPairEvidence(
	field: SupportFieldEvidence,
	badge: BadgeEvidence,
	tee: TeeEvidence,
	basket: BasketEvidence,
	teeLeg: LegEvidence,
	basketLeg: LegEvidence,
	params: CorridorParams,
	yOffsetPx: number
): RawPairEvidence {
	const path = canonicalPath(teeLeg, basketLeg);
	if (!teeLeg.reachable || !basketLeg.reachable || !path.length) {
		return {
			pairId: `${badge.detId}:${tee.detId}:${basket.detId}`,
			badgeId: badge.detId,
			teeId: tee.detId,
			basketId: basket.detId,
			teeLeg,
			basketLeg,
			supportMean: 0,
			supportMin: 0,
			supportedFraction: 0,
			worstWindowMean: 0,
			weakSpanCount: 0,
			weakSpanLongestPx: 0,
			pathLengthPx: 0,
			straightDistancePx: 0,
			efficiency: 0,
			endpointSupportTee: 0,
			endpointSupportBasket: 0,
			failureReason: 'unreachable'
		};
	}
	const samples = path.map((point) => supportAt(field, point, yOffsetPx));
	let weakSpanCount = 0;
	let weakSpanLongest = 0;
	let weak = 0;
	for (let i = 0; i <= samples.length; i++) {
		if (i < samples.length && samples[i] < params.supportTau) weak++;
		else if (weak) {
			weakSpanCount++;
			weakSpanLongest = Math.max(weakSpanLongest, weak * field.scale);
			weak = 0;
		}
	}
	let pathLength = 0;
	for (let i = 1; i < path.length; i++) pathLength += Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]);
	const straight = Math.hypot(tee.xPx - badge.cxPx, tee.yPx - badge.cyPx) + Math.hypot(basket.tipXPx - badge.cxPx, basket.tipYPx - badge.cyPx);
	return {
		pairId: `${badge.detId}:${tee.detId}:${basket.detId}`,
		badgeId: badge.detId,
		teeId: tee.detId,
		basketId: basket.detId,
		teeLeg,
		basketLeg,
		supportMean: samples.reduce((sum, value) => sum + value, 0) / samples.length,
		supportMin: Math.min(...samples),
		supportedFraction: samples.filter((value) => value >= params.supportTau).length / samples.length,
		worstWindowMean: weakWindow(samples, Math.max(3, Math.round(params.worstWindowSrcPx / field.scale))),
		weakSpanCount,
		weakSpanLongestPx: weakSpanLongest,
		pathLengthPx: pathLength,
		straightDistancePx: straight,
		efficiency: straight > 0 ? pathLength / straight : 0,
		endpointSupportTee: endpointSupport(field, teeLeg, yOffsetPx),
		endpointSupportBasket: endpointSupport(field, basketLeg, yOffsetPx),
		failureReason: null
	};
}

export function scorePair(
	raw: RawPairEvidence,
	field: SupportFieldEvidence,
	badge: BadgeEvidence,
	tee: TeeEvidence,
	basket: BasketEvidence,
	baskets: readonly BasketEvidence[],
	params: CorridorParams,
	yOffsetPx: number
): ScoredPairEvidence {
	const path = canonicalPath(raw.teeLeg, raw.basketLeg);
	const aligned = alignedPairSamples(field, raw.teeLeg, raw.basketLeg, baskets, basket.detId, params, yOffsetPx);
	const alignedWorst = weakWindow(aligned, Math.max(3, Math.round(params.worstWindowSrcPx / field.scale)));
	const alignment = raw.worstWindowMean > 0 ? alignedWorst / raw.worstWindowMean : 0;
	const zone = aligned.length && raw.supportMean > 0 ? aligned.reduce((sum, value) => sum + value, 0) / aligned.length / Math.max(raw.supportMean, 1e-6) : 0;
	const simplePath = overlapFactor(raw.teeLeg, raw.basketLeg, badge, yOffsetPx);
	const geometry = geometryFactors(badge, tee, basket);
	const basketIdentity = Math.max(0.4, Math.min(1, (basket.score - 0.2) / 0.5));
	const recoveredPrior = tee.tier === 'recovered' ? 0.7 : 1;
	const preliminary = alignedWorst * zone * simplePath * geometry.teeOrientation * geometry.badgeFraction * geometry.collinearity * basketIdentity * recoveredPrior;
	const zfit = zfitFactor(field, badge, tee, basket, baskets, params, yOffsetPx, alignedWorst);
	const score = preliminary * zfit;
	return {
		raw,
		score,
		rank: 0,
		factors: {
			alignment,
			zone,
			simplePath,
			...geometry,
			basketIdentity,
			recoveredPrior,
			zfit
		}
	};
}
