import type { Mask } from './raster';
import { extractComponents, type ComponentStats } from './components';

export interface SmartBasketTemplate {
	width: number;
	height: number;
	rows: string[];
}

export interface BasketBadgeLike {
	cx: number;
	cy: number;
	bboxX: number;
	bboxY: number;
	bboxW: number;
	bboxH: number;
}

export type SmartBasketTier = 'clean-family' | 'occlusion-recovery';
export type SmartBasketConfidence = 'high' | 'medium' | 'low';

export interface SmartBasketEvidence {
	/** Detector-local bright component bounds. These do not bound the sprite. */
	x: number;
	y: number;
	cx: number;
	cy: number;
	tipX: number;
	tipY: number;
	bboxW: number;
	bboxH: number;
	/** Full rendered sprite perimeter learned from white + associated black support. */
	semanticBbox: readonly [number, number, number, number];
	tier: SmartBasketTier;
	confidence: SmartBasketConfidence;
	identity: number;
	effectiveVisibility: number;
	whiteCoverage: number;
	blackBorderSupport: number;
	darkCoherence: number;
	source: string;
}

export interface SmartBasketDecision {
	readonly x: number;
	readonly y: number;
	readonly bboxW: number;
	readonly bboxH: number;
	/** Full rendered sprite perimeter; never the bright-component search window. */
	readonly semanticBbox: readonly [number, number, number, number];
	readonly tier: SmartBasketTier;
	readonly accepted: boolean;
	readonly reason: string;
	readonly source: string;
	readonly areaRatio: number;
	readonly identity: number;
	readonly effectiveVisibility: number;
	readonly whiteCoverage: number;
	readonly blackBorderSupport: number;
	readonly darkCoherence: number;
}

export interface SmartBasketOptions {
	bboxTolerancePx?: number;
	areaRatioMin?: number;
	areaRatioMax?: number;
	cleanWhiteCoverageMin?: number;
	cleanDarkShellMin?: number;
	cleanDarkCoherenceMin?: number;
	shellRadiusPx?: number;
	blackConsensusFraction?: number;
	blackConsensusMarginPx?: number;
	recoveryIdentityMin?: number;
	recoveryWhiteCoverageMin?: number;
	recoveryBlackSupportMin?: number;
	recoveryVisibilityMin?: number;
	highVisibilityMin?: number;
	dedupeRadiusPx?: number;
	semanticTipOffsetPx?: number;
	maxChildrenPerSeed?: number;
}

interface Seed {
	kind: 'badge' | 'basket';
	id: number;
	x: number;
	y: number;
	w: number;
	h: number;
	darkLabel: number;
	/** Semantic rendered footprint used only for basket-on-basket occlusion.
	 * Search geometry above remains the detector-local white component. */
	occlusionBox?: readonly [number, number, number, number];
}

interface PreparedFamily {
	width: number;
	height: number;
	white: Uint8Array;
	whiteOffsets: Int32Array;
	whiteCount: number;
	black: Uint8Array;
	blackOffsets: Int32Array;
	margin: number;
	/** Bounds relative to the white template origin. */
	objectBounds: readonly [number, number, number, number];
}

interface CandidateScore {
	identity: number;
	whiteCoverage: number;
	blackBorderSupport: number;
	darkCoherence: number;
	effectiveVisibility: number;
}

export const DEFAULT_SMART_BASKET_OPTIONS: Required<SmartBasketOptions> = {
	bboxTolerancePx: 2,
	areaRatioMin: 0.96,
	areaRatioMax: 1.03,
	cleanWhiteCoverageMin: 0.96,
	cleanDarkShellMin: 0.5,
	cleanDarkCoherenceMin: 0.8,
	shellRadiusPx: 2,
	blackConsensusFraction: 0.75,
	blackConsensusMarginPx: 4,
	recoveryIdentityMin: 0.9,
	recoveryWhiteCoverageMin: 0.9,
	recoveryBlackSupportMin: 0.8,
	recoveryVisibilityMin: 0.25,
	highVisibilityMin: 0.5,
	dedupeRadiusPx: 14,
	semanticTipOffsetPx: 4,
	maxChildrenPerSeed: 2
};

function clamp(v: number, lo: number, hi: number): number {
	return Math.max(lo, Math.min(hi, v));
}

function templateWhite(t: SmartBasketTemplate): {
	mask: Uint8Array;
	offsets: Int32Array;
	count: number;
} {
	if (t.rows.length !== t.height)
		throw new Error('basket template row count does not match height');
	const mask = new Uint8Array(t.width * t.height);
	const offsets: number[] = [];
	for (let y = 0; y < t.height; y++) {
		if (t.rows[y].length !== t.width) throw new Error('basket template row width mismatch');
		for (let x = 0; x < t.width; x++) {
			if (t.rows[y][x] !== '1') continue;
			const i = y * t.width + x;
			mask[i] = 1;
			offsets.push(i);
		}
	}
	return { mask, offsets: Int32Array.from(offsets), count: offsets.length };
}

function nearestDarkLabel(
	labels: Int32Array,
	width: number,
	height: number,
	x: number,
	y: number
): number {
	const cx = clamp(Math.round(x), 0, width - 1);
	const cy = clamp(Math.round(y), 0, height - 1);
	const direct = labels[cy * width + cx];
	if (direct) return direct;
	for (let r = 1; r <= 3; r++) {
		for (let dy = -r; dy <= r; dy++) {
			for (let dx = -r; dx <= r; dx++) {
				if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
				const xx = cx + dx;
				const yy = cy + dy;
				if (xx < 0 || xx >= width || yy < 0 || yy >= height) continue;
				const label = labels[yy * width + xx];
				if (label) return label;
			}
		}
	}
	return 0;
}

function shellEvidence(
	brightLabels: Int32Array,
	dark: Mask,
	darkLabels: Int32Array,
	component: ComponentStats,
	radius: number
): { darkFraction: number; darkCoherence: number } {
	const { width, height } = dark;
	const x0 = Math.max(0, component.bboxX - radius);
	const y0 = Math.max(0, component.bboxY - radius);
	const x1 = Math.min(width, component.bboxX + component.bboxW + radius);
	const y1 = Math.min(height, component.bboxY + component.bboxH + radius);
	const lw = x1 - x0;
	const lh = y1 - y0;
	const body = new Uint8Array(lw * lh);
	for (let y = 0; y < lh; y++) {
		const row = (y0 + y) * width;
		for (let x = 0; x < lw; x++) {
			if (brightLabels[row + x0 + x] === component.label) body[y * lw + x] = 1;
		}
	}
	let dilated = body;
	for (let it = 0; it < radius; it++) {
		const next = new Uint8Array(dilated);
		for (let y = 0; y < lh; y++) {
			for (let x = 0; x < lw; x++) {
				if (dilated[y * lw + x]) continue;
				let on = false;
				for (let dy = -1; dy <= 1 && !on; dy++) {
					for (let dx = -1; dx <= 1; dx++) {
						const xx = x + dx;
						const yy = y + dy;
						if (xx < 0 || xx >= lw || yy < 0 || yy >= lh) continue;
						if (dilated[yy * lw + xx]) {
							on = true;
							break;
						}
					}
				}
				if (on) next[y * lw + x] = 1;
			}
		}
		dilated = next;
	}
	let shellCount = 0;
	let darkCount = 0;
	const counts = new Map<number, number>();
	for (let y = 0; y < lh; y++) {
		const row = (y0 + y) * width;
		for (let x = 0; x < lw; x++) {
			const i = y * lw + x;
			if (!dilated[i] || body[i]) continue;
			shellCount++;
			const gi = row + x0 + x;
			if (!dark.data[gi]) continue;
			darkCount++;
			const label = darkLabels[gi];
			if (label) counts.set(label, (counts.get(label) ?? 0) + 1);
		}
	}
	let dominant = 0;
	for (const n of counts.values()) if (n > dominant) dominant = n;
	return {
		darkFraction: shellCount ? darkCount / shellCount : 0,
		darkCoherence: darkCount ? dominant / darkCount : 0
	};
}

function componentWhiteCoverage(
	brightLabels: Int32Array,
	width: number,
	component: ComponentStats,
	family: { width: number; height: number; offsets: Int32Array }
): number {
	if (component.bboxW !== family.width || component.bboxH !== family.height) return 0;
	let hit = 0;
	for (let k = 0; k < family.offsets.length; k++) {
		const o = family.offsets[k];
		const x = o % family.width;
		const y = (o - x) / family.width;
		if (brightLabels[(component.bboxY + y) * width + component.bboxX + x] === component.label)
			hit++;
	}
	return hit / Math.max(1, family.offsets.length);
}

function learnBlackConsensus(
	dark: Mask,
	clean: SmartBasketEvidence[],
	white: Uint8Array,
	tw: number,
	th: number,
	margin: number,
	fraction: number
): Uint8Array {
	const ew = tw + 2 * margin;
	const eh = th + 2 * margin;
	const counts = new Uint16Array(ew * eh);
	let usable = 0;
	for (const b of clean) {
		if (
			b.x < margin ||
			b.y < margin ||
			b.x + tw + margin > dark.width ||
			b.y + th + margin > dark.height
		)
			continue;
		usable++;
		for (let y = 0; y < eh; y++) {
			const row = (b.y - margin + y) * dark.width;
			for (let x = 0; x < ew; x++) {
				if (dark.data[row + b.x - margin + x]) counts[y * ew + x]++;
			}
		}
	}
	const out = new Uint8Array(ew * eh);
	if (!usable) return out;
	const need = Math.ceil(usable * fraction);
	for (let i = 0; i < counts.length; i++) if (counts[i] >= need) out[i] = 1;
	for (let y = 0; y < th; y++) {
		for (let x = 0; x < tw; x++) {
			if (white[y * tw + x]) out[(y + margin) * ew + x + margin] = 0;
		}
	}
	return out;
}

function offsetsOf(mask: Uint8Array): Int32Array {
	const out: number[] = [];
	for (let i = 0; i < mask.length; i++) if (mask[i]) out.push(i);
	return Int32Array.from(out);
}

function familyObjectBounds(
	white: Uint8Array,
	black: Uint8Array,
	tw: number,
	th: number,
	margin: number
): readonly [number, number, number, number] {
	let minX = Number.POSITIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;
	const include = (x: number, y: number) => {
		minX = Math.min(minX, x);
		minY = Math.min(minY, y);
		maxX = Math.max(maxX, x);
		maxY = Math.max(maxY, y);
	};
	for (let i = 0; i < white.length; i++) {
		if (!white[i]) continue;
		include(i % tw, Math.floor(i / tw));
	}
	const ew = tw + margin * 2;
	for (let i = 0; i < black.length; i++) {
		if (!black[i]) continue;
		include((i % ew) - margin, Math.floor(i / ew) - margin);
	}
	if (!Number.isFinite(minX)) throw new Error('basket family has no semantic support pixels');
	return [minX, minY, maxX - minX + 1, maxY - minY + 1];
}

function translatedObjectBounds(
	x: number,
	y: number,
	bounds: readonly [number, number, number, number]
): readonly [number, number, number, number] {
	return [x + bounds[0], y + bounds[1], bounds[2], bounds[3]];
}

function isOccluded(
	seed: Seed,
	gx: number,
	gy: number,
	darkLabels: Int32Array,
	width: number,
	height: number,
	margin: number
): boolean {
	if (seed.kind === 'basket') {
		const [x, y, w, h] = seed.occlusionBox ?? [
			seed.x - margin,
			seed.y - margin,
			seed.w + margin * 2,
			seed.h + margin * 2
		];
		return (
			gx >= x &&
			gx < x + w &&
			gy >= y &&
			gy < y + h
		);
	}
	if (!seed.darkLabel) return false;
	for (let dy = -2; dy <= 2; dy++) {
		for (let dx = -2; dx <= 2; dx++) {
			const x = gx + dx;
			const y = gy + dy;
			if (x < 0 || x >= width || y < 0 || y >= height) continue;
			if (darkLabels[y * width + x] === seed.darkLabel) return true;
		}
	}
	return false;
}

function scoreCandidate(
	x: number,
	y: number,
	seed: Seed,
	bright: Mask,
	dark: Mask,
	darkLabels: Int32Array,
	family: PreparedFamily
): CandidateScore | null {
	const { width, height } = bright;
	const { width: tw, height: th, margin } = family;
	if (x < margin || y < margin || x + tw + margin > width || y + th + margin > height) return null;
	let availableWhite = 0;
	let whiteHit = 0;
	for (let k = 0; k < family.whiteOffsets.length; k++) {
		const o = family.whiteOffsets[k];
		const rx = o % tw;
		const ry = (o - rx) / tw;
		const gx = x + rx;
		const gy = y + ry;
		if (isOccluded(seed, gx, gy, darkLabels, width, height, margin)) continue;
		availableWhite++;
		if (bright.data[gy * width + gx]) whiteHit++;
	}
	if (availableWhite < family.whiteCount * 0.2) return null;
	const whiteCoverage = whiteHit / availableWhite;
	const effectiveVisibility = whiteHit / family.whiteCount;
	const ew = tw + 2 * margin;
	let availableBlack = 0;
	let darkHit = 0;
	let brightInBlack = 0;
	const darkCounts = new Map<number, number>();
	for (let k = 0; k < family.blackOffsets.length; k++) {
		const o = family.blackOffsets[k];
		const rx = o % ew;
		const ry = (o - rx) / ew;
		const gx = x - margin + rx;
		const gy = y - margin + ry;
		if (isOccluded(seed, gx, gy, darkLabels, width, height, margin)) continue;
		availableBlack++;
		const gi = gy * width + gx;
		if (bright.data[gi]) brightInBlack++;
		if (!dark.data[gi]) continue;
		darkHit++;
		const label = darkLabels[gi];
		if (label) darkCounts.set(label, (darkCounts.get(label) ?? 0) + 1);
	}
	if (availableBlack < Math.max(30, family.blackOffsets.length * 0.15)) return null;
	let dominant = 0;
	for (const n of darkCounts.values()) if (n > dominant) dominant = n;
	const blackBorderSupport = darkHit / availableBlack;
	const darkCoherence = darkHit ? dominant / darkHit : 0;
	const blackBright = brightInBlack / availableBlack;
	const identity =
		0.6 * whiteCoverage + 0.3 * blackBorderSupport + 0.1 * darkCoherence - 0.25 * blackBright;
	return { identity, whiteCoverage, blackBorderSupport, darkCoherence, effectiveVisibility };
}

function searchSeed(
	seed: Seed,
	bright: Mask,
	dark: Mask,
	darkLabels: Int32Array,
	family: PreparedFamily,
	minimumIdentity: number
): { x: number; y: number; score: CandidateScore }[] {
	const { width, height } = bright;
	const { width: tw, height: th, margin } = family;
	const xmin = Math.max(margin, seed.x - tw + 1);
	const xmax = Math.min(width - tw - margin, seed.x + seed.w - 1);
	const ymin = Math.max(margin, seed.y - th + 1);
	const ymax = Math.min(height - th - margin, seed.y + seed.h - 1);
	if (xmax < xmin || ymax < ymin) return [];
	const sx = Math.max(1, Math.floor(tw / 2));
	const sy = Math.max(1, Math.floor(th / 2));
	const xs: number[] = [];
	const ys: number[] = [];
	for (let x = xmin; x <= xmax; x += sx) xs.push(x);
	for (let y = ymin; y <= ymax; y += sy) ys.push(y);
	if (xs[xs.length - 1] !== xmax) xs.push(xmax);
	if (ys[ys.length - 1] !== ymax) ys.push(ymax);
	const coarse: { x: number; y: number; score: CandidateScore }[] = [];
	for (const y of ys) {
		for (const x of xs) {
			const score = scoreCandidate(x, y, seed, bright, dark, darkLabels, family);
			if (score) coarse.push({ x, y, score });
		}
	}
	coarse.sort((a, b) => b.score.identity - a.score.identity);
	const mid: { x: number; y: number; score: CandidateScore }[] = [];
	const seenMid = new Set<string>();
	for (const c of coarse.slice(0, 6)) {
		for (
			let y = Math.max(ymin, c.y - Math.floor(sy / 2));
			y <= Math.min(ymax, c.y + Math.floor(sy / 2));
			y += 3
		) {
			for (
				let x = Math.max(xmin, c.x - Math.floor(sx / 2));
				x <= Math.min(xmax, c.x + Math.floor(sx / 2));
				x += 3
			) {
				const key = `${x}:${y}`;
				if (seenMid.has(key)) continue;
				seenMid.add(key);
				const score = scoreCandidate(x, y, seed, bright, dark, darkLabels, family);
				if (score) mid.push({ x, y, score });
			}
		}
	}
	mid.sort((a, b) => b.score.identity - a.score.identity);
	const fine: { x: number; y: number; score: CandidateScore }[] = [];
	const seenFine = new Set<string>();
	for (const c of mid.slice(0, 4)) {
		for (let y = Math.max(ymin, c.y - 3); y <= Math.min(ymax, c.y + 3); y++) {
			for (let x = Math.max(xmin, c.x - 3); x <= Math.min(xmax, c.x + 3); x++) {
				const key = `${x}:${y}`;
				if (seenFine.has(key)) continue;
				seenFine.add(key);
				const score = scoreCandidate(x, y, seed, bright, dark, darkLabels, family);
				if (score) fine.push({ x, y, score });
			}
		}
	}
	fine.sort((a, b) => b.score.identity - a.score.identity);
	// These remain search samples until they clear the first recovery gate.
	// Filtering here is behavior-equivalent to the outer loop's first check;
	// it stops grid samples from masquerading as rejected object candidates.
	return fine.filter((candidate) => candidate.score.identity >= minimumIdentity);
}

export function matchBasketSpritesSmart(
	bright: Mask,
	dark: Mask,
	badges: readonly BasketBadgeLike[],
	template: SmartBasketTemplate,
	options: SmartBasketOptions = {},
	decisions?: SmartBasketDecision[]
): SmartBasketEvidence[] {
	if (bright.width !== dark.width || bright.height !== dark.height)
		throw new Error('bright/dark mask dimensions differ');
	const cfg = { ...DEFAULT_SMART_BASKET_OPTIONS, ...options };
	const white = templateWhite(template);
	const brightStage = extractComponents(bright);
	const darkStage = extractComponents(dark);
	const decisionLog: SmartBasketDecision[] = [];
	const provisionalBounds = [
		-cfg.blackConsensusMarginPx,
		-cfg.blackConsensusMarginPx,
		template.width + cfg.blackConsensusMarginPx * 2,
		template.height + cfg.blackConsensusMarginPx * 2
	] as const;
	const record = (decision: SmartBasketDecision) => decisionLog.push(decision);
	const clean: SmartBasketEvidence[] = [];
	for (const c of brightStage.components) {
		if (Math.abs(c.bboxW - template.width) > cfg.bboxTolerancePx) continue;
		if (Math.abs(c.bboxH - template.height) > cfg.bboxTolerancePx) continue;
		const source = `bright-component:${c.label}`;
		const areaRatio = c.area / Math.max(1, white.count);
		if (areaRatio < cfg.areaRatioMin || areaRatio > cfg.areaRatioMax) {
			record({
				x: c.bboxX,
				y: c.bboxY,
				bboxW: template.width,
				bboxH: template.height,
				semanticBbox: translatedObjectBounds(c.bboxX, c.bboxY, provisionalBounds),
				tier: 'clean-family',
				accepted: false,
				reason: `area ratio ${areaRatio.toFixed(3)} outside [${cfg.areaRatioMin}, ${cfg.areaRatioMax}]`,
				source,
				areaRatio,
				identity: 0,
				effectiveVisibility: 0,
				whiteCoverage: 0,
				blackBorderSupport: 0,
				darkCoherence: 0
			});
			continue;
		}
		const whiteCoverage = componentWhiteCoverage(brightStage.labels, bright.width, c, {
			width: template.width,
			height: template.height,
			offsets: white.offsets
		});
		if (whiteCoverage < cfg.cleanWhiteCoverageMin) {
			record({
				x: c.bboxX,
				y: c.bboxY,
				bboxW: template.width,
				bboxH: template.height,
				semanticBbox: translatedObjectBounds(c.bboxX, c.bboxY, provisionalBounds),
				tier: 'clean-family',
				accepted: false,
				reason: `white coverage ${whiteCoverage.toFixed(3)} < ${cfg.cleanWhiteCoverageMin}`,
				source,
				areaRatio,
				identity: whiteCoverage,
				effectiveVisibility: whiteCoverage,
				whiteCoverage,
				blackBorderSupport: 0,
				darkCoherence: 0
			});
			continue;
		}
		const shell = shellEvidence(brightStage.labels, dark, darkStage.labels, c, cfg.shellRadiusPx);
		if (
			shell.darkFraction < cfg.cleanDarkShellMin ||
			shell.darkCoherence < cfg.cleanDarkCoherenceMin
		) {
			const reason =
				shell.darkFraction < cfg.cleanDarkShellMin
					? `dark shell ${shell.darkFraction.toFixed(3)} < ${cfg.cleanDarkShellMin}`
					: `dark coherence ${shell.darkCoherence.toFixed(3)} < ${cfg.cleanDarkCoherenceMin}`;
			record({
				x: c.bboxX,
				y: c.bboxY,
				bboxW: template.width,
				bboxH: template.height,
				semanticBbox: translatedObjectBounds(c.bboxX, c.bboxY, provisionalBounds),
				tier: 'clean-family',
				accepted: false,
				reason,
				source,
				areaRatio,
				identity: whiteCoverage,
				effectiveVisibility: whiteCoverage,
				whiteCoverage,
				blackBorderSupport: shell.darkFraction,
				darkCoherence: shell.darkCoherence
			});
			continue;
		}
		const evidence: SmartBasketEvidence = {
			x: c.bboxX,
			y: c.bboxY,
			cx: c.bboxX + template.width / 2,
			cy: c.bboxY + template.height / 2,
			tipX: c.bboxX + template.width / 2,
			tipY: c.bboxY + template.height + cfg.semanticTipOffsetPx,
			bboxW: template.width,
			bboxH: template.height,
			semanticBbox: translatedObjectBounds(c.bboxX, c.bboxY, provisionalBounds),
			tier: 'clean-family',
			confidence: 'high',
			identity: whiteCoverage,
			effectiveVisibility: whiteCoverage,
			whiteCoverage,
			blackBorderSupport: shell.darkFraction,
			darkCoherence: shell.darkCoherence,
			source
		};
		clean.push(evidence);
		record({
			x: evidence.x,
			y: evidence.y,
			bboxW: evidence.bboxW,
			bboxH: evidence.bboxH,
			semanticBbox: evidence.semanticBbox,
			tier: evidence.tier,
			accepted: true,
			reason: 'accepted intact renderer family',
			source,
			areaRatio,
			identity: evidence.identity,
			effectiveVisibility: evidence.effectiveVisibility,
			whiteCoverage: evidence.whiteCoverage,
			blackBorderSupport: evidence.blackBorderSupport,
			darkCoherence: evidence.darkCoherence
		});
	}
	if (clean.length < 2) {
		decisions?.push(...decisionLog);
		return clean;
	}
	const black = learnBlackConsensus(
		dark,
		clean,
		white.mask,
		template.width,
		template.height,
		cfg.blackConsensusMarginPx,
		cfg.blackConsensusFraction
	);
	const objectBounds = familyObjectBounds(
		white.mask,
		black,
		template.width,
		template.height,
		cfg.blackConsensusMarginPx
	);
	for (const evidence of clean)
		evidence.semanticBbox = translatedObjectBounds(evidence.x, evidence.y, objectBounds);
	for (let i = 0; i < decisionLog.length; i++) {
		const decision = decisionLog[i];
		decisionLog[i] = {
			...decision,
			semanticBbox: translatedObjectBounds(decision.x, decision.y, objectBounds)
		};
	}
	const family: PreparedFamily = {
		width: template.width,
		height: template.height,
		white: white.mask,
		whiteOffsets: white.offsets,
		whiteCount: white.count,
		black,
		blackOffsets: offsetsOf(black),
		margin: cfg.blackConsensusMarginPx,
		objectBounds
	};
	const accepted = clean.slice();
	const queue: Seed[] = [];
	for (let i = 0; i < badges.length; i++) {
		const b = badges[i];
		queue.push({
			kind: 'badge',
			id: i,
			x: Math.round(b.bboxX),
			y: Math.round(b.bboxY),
			w: Math.round(b.bboxW),
			h: Math.round(b.bboxH),
			darkLabel: nearestDarkLabel(darkStage.labels, dark.width, dark.height, b.cx, b.cy)
		});
	}
	for (let i = 0; i < clean.length; i++) {
		const b = clean[i];
		queue.push({
			kind: 'basket',
			id: i,
			x: b.x,
			y: b.y,
			w: b.bboxW,
			h: b.bboxH,
			darkLabel: 0,
			occlusionBox: b.semanticBbox
		});
	}
	for (let qi = 0; qi < queue.length; qi++) {
		const seed = queue[qi];
		let added = 0;
		for (const candidate of searchSeed(
			seed,
			bright,
			dark,
			darkStage.labels,
			family,
			cfg.recoveryIdentityMin
		)) {
			const cx = candidate.x + template.width / 2;
			const cy = candidate.y + template.height / 2;
			const s = candidate.score;
			const source = `${seed.kind}:${seed.id}`;
			let rejection: string | null = null;
			if (accepted.some((b) => Math.hypot(cx - b.cx, cy - b.cy) < cfg.dedupeRadiusPx))
				rejection = `duplicate within ${cfg.dedupeRadiusPx}px of accepted basket`;
			else if (s.identity < cfg.recoveryIdentityMin)
				rejection = `identity ${s.identity.toFixed(3)} < ${cfg.recoveryIdentityMin}`;
			else if (s.whiteCoverage < cfg.recoveryWhiteCoverageMin)
				rejection = `white coverage ${s.whiteCoverage.toFixed(3)} < ${cfg.recoveryWhiteCoverageMin}`;
			else if (s.blackBorderSupport < cfg.recoveryBlackSupportMin)
				rejection = `black border ${s.blackBorderSupport.toFixed(3)} < ${cfg.recoveryBlackSupportMin}`;
			else if (s.effectiveVisibility < cfg.recoveryVisibilityMin)
				rejection = `effective visibility ${s.effectiveVisibility.toFixed(3)} < ${cfg.recoveryVisibilityMin}`;
			if (rejection) {
				record({
					x: candidate.x,
					y: candidate.y,
					bboxW: template.width,
					bboxH: template.height,
					semanticBbox: translatedObjectBounds(candidate.x, candidate.y, family.objectBounds),
					tier: 'occlusion-recovery',
					accepted: false,
					reason: rejection,
					source,
					areaRatio: 0,
					identity: s.identity,
					effectiveVisibility: s.effectiveVisibility,
					whiteCoverage: s.whiteCoverage,
					blackBorderSupport: s.blackBorderSupport,
					darkCoherence: s.darkCoherence
				});
				continue;
			}
			const confidence: SmartBasketConfidence =
				s.effectiveVisibility >= cfg.highVisibilityMin
					? 'high'
					: s.effectiveVisibility >= cfg.recoveryVisibilityMin
						? 'medium'
						: 'low';
			const recovered: SmartBasketEvidence = {
				x: candidate.x,
				y: candidate.y,
				cx,
				cy,
				tipX: cx,
				tipY: candidate.y + template.height + cfg.semanticTipOffsetPx,
				bboxW: template.width,
				bboxH: template.height,
				semanticBbox: translatedObjectBounds(candidate.x, candidate.y, family.objectBounds),
				tier: 'occlusion-recovery',
				confidence,
				identity: s.identity,
				effectiveVisibility: s.effectiveVisibility,
				whiteCoverage: s.whiteCoverage,
				blackBorderSupport: s.blackBorderSupport,
				darkCoherence: s.darkCoherence,
				source
			};
			accepted.push(recovered);
			record({
				x: recovered.x,
				y: recovered.y,
				bboxW: recovered.bboxW,
				bboxH: recovered.bboxH,
				semanticBbox: recovered.semanticBbox,
				tier: recovered.tier,
				accepted: true,
				reason: 'accepted occlusion recovery',
				source,
				areaRatio: 0,
				identity: s.identity,
				effectiveVisibility: s.effectiveVisibility,
				whiteCoverage: s.whiteCoverage,
				blackBorderSupport: s.blackBorderSupport,
				darkCoherence: s.darkCoherence
			});
			queue.push({
				kind: 'basket',
				id: accepted.length - 1,
				x: recovered.x,
				y: recovered.y,
				w: recovered.bboxW,
				h: recovered.bboxH,
				darkLabel: 0,
				occlusionBox: recovered.semanticBbox
			});
			added++;
			if (added >= cfg.maxChildrenPerSeed) break;
		}
	}
	decisions?.push(...decisionLog);
	return accepted;
}
