/**
 * Solid endpoint detection from render identity, replacing loose
 * bright-component family bounds ("bbox 36-48 × 58-74, fill ≥ 0.45"-style)
 * with detectors built on what UDisc actually draws (contact-sheet study of
 * all 72 dev truth tees + 72 truth baskets):
 *
 * - The BASKET is one fixed, unrotated 42×66 sprite bitmap — byte-identical
 *   in 60/66 clean dev detections (consensus template committed at
 *   resources/nuthing-p2/endpoints/basket-sprite.json). Detection is a
 *   matched filter over the bright mask, coarse-to-fine, so partially
 *   occluded sprites (badges, adjacent sprites, map furniture) still match
 *   on their visible fraction instead of falling out of a rigid
 *   connected-component family.
 *
 * - The TEE is the render stack's only small HOLLOW glyph: a thick white
 *   rectangle outline around a transparent (basemap-dark) interior, rotated
 *   to the hole direction, at two sizes (≈32×24 and ≈20×15 outer).
 *   Detection finds small enclosed dark holes in the bright mask and
 *   verifies the enclosing white ring. Merging with walking-path dashes or
 *   ring furniture does not destroy the hole, so this survives exactly the
 *   cases that broke component-family matching. Every qualifying hollow
 *   marker is a tee; squarer renderings are not a separate object class.
 */

import type { Mask } from './raster';

export interface SpriteTemplate {
	width: number;
	height: number;
	rows: string[];
}

export interface SpriteMatch {
	/** Sprite bbox top-left, source px. */
	x: number;
	y: number;
	/** Sprite center. */
	cx: number;
	cy: number;
	/** Pole-tip annotation point (center + h/2 + 4). */
	tipX: number;
	tipY: number;
	/** Fraction of template-on cells that are bright. */
	onFrac: number;
	/** Fraction of template-off cells that are bright (outline+corners). */
	offFrac: number;
	score: number;
}

export interface TeeRing {
	/** Hole (interior) centroid = tee center, source px. */
	cx: number;
	cy: number;
	/** Interior area in px. */
	holeArea: number;
	/** Interior bbox. */
	bboxX: number;
	bboxY: number;
	bboxW: number;
	bboxH: number;
	/** Principal-axis angle, radians in [0,π). */
	angle: number;
	/** Principal-axis elongation of the enclosed hole. */
	elongation: number;
	/** Bright fraction of the enclosing ring band. */
	ringFrac: number;
	/** Elongated tee versus square distractor. */
	kind: 'tee-rect' | 'diamond';
}

interface TemplateOffsets {
	w: number;
	h: number;
	on: Int32Array; // packed x + y*w
	off: Int32Array;
	onSample: Int32Array; // sparse subsets for the coarse pass
	offSample: Int32Array;
}

export function prepareSpriteTemplate(t: SpriteTemplate): TemplateOffsets {
	const on: number[] = [];
	const off: number[] = [];
	for (let y = 0; y < t.height; y++) {
		for (let x = 0; x < t.width; x++) {
			(t.rows[y][x] === '1' ? on : off).push(y * t.width + x);
		}
	}
	const sample = (a: number[], step: number): Int32Array =>
		Int32Array.from(a.filter((_, i) => i % step === 0));
	return {
		w: t.width,
		h: t.height,
		on: Int32Array.from(on),
		off: Int32Array.from(off),
		onSample: sample(on, 4),
		offSample: sample(off, 4)
	};
}

/**
 * g2.sprite knobs, threaded down as plain parameters. spriteWidth/
 * spriteHeight (measure.ts's basket bbox) are structurally coupled to the
 * committed basket-sprite.json template asset — see the validate() on those
 * two knobs in features/g2.sprite.ts, which checks the configured value
 * against the asset's actual width/height rather than letting a mismatch
 * silently misreport the basket bbox size.
 *
 * NOT here: prepareSpriteTemplate's internal `sample(a, 4)` calls (its
 * on/off subsampling stride for the coarse pass) stay a literal. That
 * function runs once at MODULE LOAD (measure.ts's top-level
 * `prepareSpriteTemplate(basketSpriteData)`), before any config or ctx
 * exists — wiring it would mean recomputing the packed template per run
 * instead of once for the process lifetime, a restructuring beyond
 * "thread as parameter" for this commit.
 */
export interface SpriteKnobs {
	readonly coarseStride: number;
	readonly coarseThreshold: number;
	readonly scoreMin: number;
	readonly tipOffset: number;
	readonly coarseGateYOffset: number;
	readonly coarseGateXOffset: number;
	readonly refinementRadius: number;
	readonly staleScoreEpsilon: number;
	readonly spriteWidth: number;
	readonly spriteHeight: number;
}

export const DEFAULT_SPRITE_KNOBS: SpriteKnobs = {
	coarseStride: 3,
	coarseThreshold: 0.18,
	scoreMin: 0.28,
	tipOffset: 4,
	coarseGateYOffset: 10,
	coarseGateXOffset: 4,
	refinementRadius: 2,
	staleScoreEpsilon: 1e-3,
	spriteWidth: 42,
	spriteHeight: 66
};

/**
 * Matched filter for the fixed basket sprite over the bright mask.
 * score = onFrac − offFrac; a clean sprite scores ~0.95+, a half-occluded
 * one ~0.3, a solid white blob 0. Coarse pass on sampled offsets at stride
 * 3, stride-1 refinement around surviving peaks, then matching-pursuit
 * dedupe (see below).
 */
export function matchBasketSprites(
	bright: Mask,
	template: TemplateOffsets,
	knobs: SpriteKnobs = DEFAULT_SPRITE_KNOBS
): SpriteMatch[] {
	const scoreMin = knobs.scoreMin;
	const { width, height, data } = bright;
	const { w: tw, h: th } = template;
	const maxX = width - tw;
	const maxY = height - th;

	const evalAt = (
		x0: number,
		y0: number,
		on: Int32Array,
		off: Int32Array
	): { s: number; onF: number; offF: number } => {
		let onHit = 0;
		for (let k = 0; k < on.length; k++) {
			const o = on[k];
			const tx = o % tw;
			const ty = (o - tx) / tw;
			if (data[(y0 + ty) * width + x0 + tx]) onHit++;
		}
		let offHit = 0;
		for (let k = 0; k < off.length; k++) {
			const o = off[k];
			const tx = o % tw;
			const ty = (o - tx) / tw;
			if (data[(y0 + ty) * width + x0 + tx]) offHit++;
		}
		const onF = onHit / on.length;
		const offF = offHit / off.length;
		// Full off-penalty: a solid white blob (house roof, out-of-map fill) has
		// onFrac=offFrac=1 and must score 0, not 0.5. A clean sprite scores
		// ~0.95; a half-occluded one ~0.3 — the threshold sits between blobs
		// and occlusions, not between occlusions and clean sprites.
		return { s: onF - offF, onF, offF };
	};

	// Coarse pass.
	const peaks: { x: number; y: number; s: number }[] = [];
	for (let y = 0; y <= maxY; y += knobs.coarseStride) {
		for (let x = 0; x <= maxX; x += knobs.coarseStride) {
			// Cheap gate: the sprite's broad top must have bright pixels.
			const gy = y + knobs.coarseGateYOffset;
			const g = gy * width + x + tw / 2;
			if (!data[g] && !data[g - knobs.coarseGateXOffset] && !data[g + knobs.coarseGateXOffset]) continue;
			const { s } = evalAt(x, y, template.onSample, template.offSample);
			if (s >= knobs.coarseThreshold) peaks.push({ x, y, s });
		}
	}
	// Refine each coarse peak in a stride-1 neighborhood with the full template.
	const refined: SpriteMatch[] = [];
	for (const p of peaks) {
		let best: SpriteMatch | null = null;
		for (let dy = -knobs.refinementRadius; dy <= knobs.refinementRadius; dy++) {
			for (let dx = -knobs.refinementRadius; dx <= knobs.refinementRadius; dx++) {
				const x = p.x + dx;
				const y = p.y + dy;
				if (x < 0 || y < 0 || x > maxX || y > maxY) continue;
				const { s, onF, offF } = evalAt(x, y, template.on, template.off);
				if (!best || s > best.score) {
					best = {
						x,
						y,
						cx: x + tw / 2,
						cy: y + th / 2,
						tipX: x + tw / 2,
						tipY: y + th + knobs.tipOffset,
						onFrac: onF,
						offFrac: offF,
						score: s
					};
				}
			}
		}
		if (best && best.score >= scoreMin) refined.push(best);
	}
	// Matching-pursuit dedupe: accept the current best match, erase the bright
	// pixels it explains, and lazily re-score the rest against the live mask.
	// A shifted echo of an already-accepted sprite collapses once its pixels
	// are claimed; a genuinely overlapping neighbor sprite keeps its own
	// pixels and survives. Plain radius-NMS cannot make that distinction
	// (adjacent real sprites sit closer than a sprite diagonal).
	const live = new Uint8Array(data);
	const evalLive = (x0: number, y0: number): number => {
		let onHit = 0;
		for (let k = 0; k < template.on.length; k++) {
			const o = template.on[k];
			const tx = o % tw;
			const ty = (o - tx) / tw;
			if (live[(y0 + ty) * width + x0 + tx]) onHit++;
		}
		let offHit = 0;
		for (let k = 0; k < template.off.length; k++) {
			const o = template.off[k];
			const tx = o % tw;
			const ty = (o - tx) / tw;
			if (live[(y0 + ty) * width + x0 + tx]) offHit++;
		}
		return onHit / template.on.length - offHit / template.off.length;
	};
	const pool = refined.filter(
		(m, i) => !refined.some((o, j) => j < i && o.x === m.x && o.y === m.y)
	);
	pool.sort((a, b) => a.score - b.score); // ascending; pop() takes the max
	const kept: SpriteMatch[] = [];
	while (pool.length) {
		const m = pool.pop() as SpriteMatch;
		const s = evalLive(m.x, m.y);
		if (s < m.score - knobs.staleScoreEpsilon) {
			// Stale — some accepted sprite claimed part of it. Re-insert.
			if (s >= scoreMin) {
				const updated = { ...m, score: s };
				let lo = 0;
				while (lo < pool.length && pool[lo].score < s) lo++;
				pool.splice(lo, 0, updated);
			}
			continue;
		}
		if (s < scoreMin) continue;
		kept.push({ ...m, score: s });
		for (let k = 0; k < template.on.length; k++) {
			const o = template.on[k];
			const tx = o % tw;
			const ty = (o - tx) / tw;
			live[(m.y + ty) * width + m.x + tx] = 0;
		}
	}
	return kept;
}

/**
 * g3.endpoints knobs, threaded down as plain parameters. Covers only the
 * TEE-related detection below (detectTeeRings/detectTeeRingsPass/
 * collectTeePoints); the sprite matched-filter knobs above (SpriteKnobs /
 * matchBasketSprites) are g2.sprite's, a separate cluster.
 */
export interface EndpointsKnobs {
	readonly holeAreaMin: number;
	readonly holeAreaMax: number;
	readonly holeDimMax: number;
	readonly ringBand: number;
	readonly ringFracMin: number;
	readonly dilationRadii: readonly number[];
	readonly largeRadiiThreshold: number;
	readonly largeRadiiAreaMin: number;
	readonly ringMergeProximity: number;
	readonly elongationThreshold: number;
	readonly componentMinDim: number;
	readonly componentMaxDim: number;
	readonly componentMinArea: number;
	readonly componentMaxArea: number;
	readonly componentMinFill: number;
	readonly componentMaxFill: number;
	readonly teeRingDedupDistance: number;
	readonly teeSpriteExclusionDistance: number;
}

export const DEFAULT_ENDPOINTS_KNOBS: EndpointsKnobs = {
	holeAreaMin: 10,
	holeAreaMax: 480,
	holeDimMax: 44,
	ringBand: 3,
	ringFracMin: 0.6,
	dilationRadii: [0, 1, 2, 3],
	largeRadiiThreshold: 2,
	largeRadiiAreaMin: 40,
	ringMergeProximity: 10,
	elongationThreshold: 1.18,
	componentMinDim: 8,
	componentMaxDim: 42,
	componentMinArea: 80,
	componentMaxArea: 350,
	componentMinFill: 0.2,
	componentMaxFill: 0.85,
	teeRingDedupDistance: 12,
	teeSpriteExclusionDistance: 24
};

/**
 * Enclosed-hole tee detection: flood the non-bright background in from the
 * image border; any remaining non-bright pixel belongs to a hole fully
 * enclosed by bright pixels. Small holes wrapped in a mostly-bright ring band
 * are tee glyphs. Near-square geometry is expected and is not a negative
 * signal; no aspect or elongation gate is applied.
 *
 * Occlusion/antialiasing cuts 1-4 px gaps into some tee outlines, letting
 * the hole leak to background (5 of 9 dev tee misses). Fix: run the flood
 * against a DILATED copy of the mask (walls only) at radii 0, 1 and 2, but
 * always measure the hole on cells that are raw-dark, unflooded and not
 * wall-covered — never on a closed mask, which fills small holes outright.
 * Detections merge across radii, preferring the smallest radius (least
 * geometric distortion). Ring brightness is verified on the raw mask.
 */
export function detectTeeRings(bright: Mask, knobs: EndpointsKnobs = DEFAULT_ENDPOINTS_KNOBS): TeeRing[] {
	const merged: TeeRing[] = [];
	for (const radius of knobs.dilationRadii) {
		// Larger radii erode the measurable hole by ~radius on each side; keep
		// the base holeAreaMin but require the coarser passes to find
		// reasonably big holes so wall-pockets between separate glyphs don't
		// slip in as fakes.
		const areaMin = radius >= knobs.largeRadiiThreshold ? knobs.largeRadiiAreaMin : knobs.holeAreaMin;
		for (const ring of detectTeeRingsPass(bright, radius, areaMin, knobs)) {
			if (merged.some((m) => Math.hypot(m.cx - ring.cx, m.cy - ring.cy) < knobs.ringMergeProximity)) continue;
			merged.push(ring);
		}
	}
	return merged;
}

export function detectTeeRingsPass(
	bright: Mask,
	wallRadius: number,
	areaMin: number,
	knobs: EndpointsKnobs = DEFAULT_ENDPOINTS_KNOBS
): TeeRing[] {
	const { width, height, data: raw } = bright;
	const n = width * height;
	let wall = raw;
	for (let it = 0; it < wallRadius; it++) {
		const src = wall;
		const dst = new Uint8Array(n);
		for (let y = 0; y < height; y++) {
			for (let x = 0; x < width; x++) {
				const i = y * width + x;
				let acc = 0;
				for (let dy = -1; dy <= 1 && !acc; dy++) {
					const yy = y + dy;
					if (yy < 0 || yy >= height) continue;
					for (let dx = -1; dx <= 1; dx++) {
						const xx = x + dx;
						if (xx < 0 || xx >= width) continue;
						if (src[yy * width + xx]) {
							acc = 1;
							break;
						}
					}
				}
				dst[i] = acc;
			}
		}
		wall = dst;
	}
	const data = raw;
	// 0 unknown, 1 background (border-connected non-wall), 2 wall
	const state = new Uint8Array(n);
	for (let i = 0; i < n; i++) if (wall[i]) state[i] = 2;
	const stack: number[] = [];
	const pushBg = (i: number): void => {
		if (state[i] === 0) {
			state[i] = 1;
			stack.push(i);
		}
	};
	for (let x = 0; x < width; x++) {
		pushBg(x);
		pushBg((height - 1) * width + x);
	}
	for (let y = 0; y < height; y++) {
		pushBg(y * width);
		pushBg(y * width + width - 1);
	}
	while (stack.length) {
		const i = stack.pop() as number;
		const x = i % width;
		if (x > 0) pushBg(i - 1);
		if (x < width - 1) pushBg(i + 1);
		if (i >= width) pushBg(i - width);
		if (i < n - width) pushBg(i + width);
	}

	// Label enclosed holes (state 0), 4-connected.
	const out: TeeRing[] = [];
	const holeStack: number[] = [];
	const cells: number[] = [];
	for (let seed = 0; seed < n; seed++) {
		if (state[seed] !== 0) continue;
		cells.length = 0;
		holeStack.push(seed);
		state[seed] = 3;
		let overflow = false;
		while (holeStack.length) {
			const i = holeStack.pop() as number;
			cells.push(i);
			if (cells.length > knobs.holeAreaMax * 4) overflow = true;
			const x = i % width;
			const neigh = [i - 1, i + 1, i - width, i + width];
			for (const j of neigh) {
				if (j < 0 || j >= n) continue;
				if ((j === i - 1 && x === 0) || (j === i + 1 && x === width - 1)) continue;
				if (state[j] === 0) {
					state[j] = 3;
					holeStack.push(j);
				}
			}
		}
		if (overflow || cells.length < areaMin || cells.length > knobs.holeAreaMax) continue;
		let x0 = width;
		let x1 = -1;
		let y0 = height;
		let y1 = -1;
		let sx = 0;
		let sy = 0;
		for (const i of cells) {
			const x = i % width;
			const y = (i - x) / width;
			if (x < x0) x0 = x;
			if (x > x1) x1 = x;
			if (y < y0) y0 = y;
			if (y > y1) y1 = y;
			sx += x;
			sy += y;
		}
		const bw = x1 - x0 + 1;
		const bh = y1 - y0 + 1;
		if (bw > knobs.holeDimMax || bh > knobs.holeDimMax) continue;
	const cx = sx / cells.length;
	const cy = sy / cells.length;
	// Central moments → undirected tee orientation and elongation.
		let mxx = 0;
		let myy = 0;
		let mxy = 0;
		for (const i of cells) {
			const x = (i % width) - cx;
			const y = (i - (i % width)) / width - cy;
			mxx += x * x;
			myy += y * y;
			mxy += x * y;
		}
		mxx /= cells.length;
		myy /= cells.length;
		mxy /= cells.length;
		const trace = mxx + myy;
		const determinant = mxx * myy - mxy * mxy;
		const discriminant = Math.sqrt(Math.max(0, (trace * trace) / 4 - determinant));
		const lambda1 = trace / 2 + discriminant;
		const lambda2 = Math.max(trace / 2 - discriminant, 1e-6);
		const elongation = Math.sqrt(lambda1 / lambda2);
		const angle = (Math.atan2(2 * mxy, mxx - myy) / 2 + Math.PI) % Math.PI;
		// Ring band: bright fraction within ringBand px (8-neighbor dilation)
		// of the hole itself — hugs rotated shapes, unlike a bbox band.
		const lw = bw + 2 * knobs.ringBand;
		const lh = bh + 2 * knobs.ringBand;
		let grid = new Uint8Array(lw * lh);
		for (const i of cells) {
			const x = (i % width) - x0 + knobs.ringBand;
			const y = (i - (i % width)) / width - y0 + knobs.ringBand;
			grid[y * lw + x] = 1;
		}
		for (let it = 0; it < knobs.ringBand; it++) {
			const next = new Uint8Array(grid);
			for (let y = 0; y < lh; y++) {
				for (let x = 0; x < lw; x++) {
					if (grid[y * lw + x]) continue;
					for (let dy = -1; dy <= 1 && !next[y * lw + x]; dy++) {
						for (let dx = -1; dx <= 1; dx++) {
							const xx = x + dx;
							const yy = y + dy;
							if (xx < 0 || xx >= lw || yy < 0 || yy >= lh) continue;
							if (grid[yy * lw + xx]) {
								next[y * lw + x] = 1;
								break;
							}
						}
					}
				}
			}
			grid = next;
		}
		let ringOn = 0;
		let ringTot = 0;
		for (let y = 0; y < lh; y++) {
			for (let x = 0; x < lw; x++) {
				if (!grid[y * lw + x]) continue;
				const sxp = x0 - knobs.ringBand + x;
				const syp = y0 - knobs.ringBand + y;
				if (sxp < 0 || sxp >= width || syp < 0 || syp >= height) continue;
				const i = syp * width + sxp;
				if (state[i] === 3) continue; // the hole itself
				ringTot++;
				if (data[i]) ringOn++;
			}
		}
		const ringFrac = ringTot ? ringOn / ringTot : 0;
		if (ringFrac < knobs.ringFracMin) continue;
		out.push({
			cx,
			cy,
			holeArea: cells.length,
			bboxX: x0,
			bboxY: y0,
			bboxW: bw,
			bboxH: bh,
			angle,
			elongation,
			ringFrac,
			kind: elongation >= knobs.elongationThreshold ? 'tee-rect' : 'diamond'
		});
	}
	return out;
}

export interface TeeComponentLike {
	cx: number;
	cy: number;
	bboxX?: number;
	bboxY?: number;
	bboxW: number;
	bboxH: number;
	area: number;
	fill: number;
	angle?: number;
}

export interface TeePoint {
	cx: number;
	cy: number;
	/** 'ring' = hollow-glyph detection (solid identity, has ring info);
	 * 'component' = bright-component family fallback for rings the hole
	 * method structurally cannot close (tees ON a C2D ring whose outline gap
	 * opens into the ring interior — 4 of 72 dev tees). */
	tier: 'ring' | 'component';
	ring?: TeeRing;
	component?: TeeComponentLike;
}

/**
 * Two-tier tee candidate set. Tier 1: ring-detected hollow tees. Tier 2:
 * bright components matching the (widened, dev-measured) tee-rect family,
 * excluding anything already explained by a tier-1 tee or a matched basket
 * sprite's own neighborhood. Caller removes badge glyphs
 * from `components` first (digit counters contain rect-like holes/shapes).
 */
export function collectTeePoints(
	rings: TeeRing[],
	components: TeeComponentLike[],
	spriteCenters: { cx: number; cy: number }[],
	knobs: EndpointsKnobs = DEFAULT_ENDPOINTS_KNOBS
): TeePoint[] {
	const out: TeePoint[] = rings.filter((r) => r.kind === 'tee-rect').map((r) => ({
		cx: r.cx,
		cy: r.cy,
		tier: 'ring' as const,
		ring: r
	}));
	for (const c of components) {
		const minDim = Math.min(c.bboxW, c.bboxH);
		const maxDim = Math.max(c.bboxW, c.bboxH);
		if (minDim < knobs.componentMinDim || maxDim > knobs.componentMaxDim) continue;
		if (c.area < knobs.componentMinArea || c.area > knobs.componentMaxArea) continue;
		if (c.fill < knobs.componentMinFill || c.fill > knobs.componentMaxFill) continue;
		// NOT the g4.scoring ringTolerance knob (coincidentally also 12) — a
		// distinct dedup check here, tee-vs-tee, before assignment even runs.
		if (out.some((t) => Math.hypot(t.cx - c.cx, t.cy - c.cy) < knobs.teeRingDedupDistance)) continue;
		if (spriteCenters.some((s) => Math.hypot(s.cx - c.cx, s.cy - c.cy) < knobs.teeSpriteExclusionDistance)) continue;
		out.push({ cx: c.cx, cy: c.cy, tier: 'component', component: c });
	}
	return out;
}
