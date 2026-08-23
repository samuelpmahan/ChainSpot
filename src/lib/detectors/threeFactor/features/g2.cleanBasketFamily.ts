// Intact basket renderer-family refinement, ported from the LAB SmartBasket
// clean pass. This is deliberately ONLY the clean-family behavior: partial
// and total occlusion recovery are separate ABFeatures so each can be A/B'd
// and justified independently.
//
// The family test is shape-local. White coverage is measured only on the
// basket sprite's rendered white shape, and the dark shell is formed by
// dilating the actual connected bright component. We never treat the whole
// 42x66 bbox as basket pixels.

import basketSpriteData from '../assets/basket-sprite.json';
import type { BadgeStageResult } from '../badgeStage';
import { extractComponents, type ComponentStats } from '../components';
import type { SpriteMatch } from '../endpoints';
import type { Mask } from '../raster';
import type { BasketEvidence } from '../types';
import type { ABFeature, EngineUnit } from './types';

export interface CleanBasketFamilyKnobs {
	readonly bboxTolerancePx: number;
	readonly positionTolerancePx: number;
	readonly areaRatioMin: number;
	readonly areaRatioMax: number;
	readonly whiteCoverageMin: number;
	readonly shellRadiusPx: number;
	readonly darkShellMin: number;
	readonly darkCoherenceMin: number;
}

interface BasketTemplate {
	readonly width: number;
	readonly height: number;
	readonly rows: readonly string[];
}

export interface CleanBasketTestimony {
	readonly areaRatio: number;
	readonly whiteCoverage: number;
	readonly darkShell: number;
	readonly darkCoherence: number;
	readonly componentDx?: number;
	readonly componentDy?: number;
}

export interface CleanBasketDecision {
	readonly sprite: SpriteMatch;
	readonly accepted: boolean;
	readonly reason: string;
	readonly testimony: CleanBasketTestimony;
}

export interface CleanBasketFamilyResult {
	readonly sprites: readonly SpriteMatch[];
	readonly decisions: readonly CleanBasketDecision[];
}

const template = basketSpriteData as BasketTemplate;

function finiteNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}

function fraction(value: unknown, name: string): string | null {
	return finiteNumber(value) && value >= 0 && value <= 1 ? null : `${name} must be in [0, 1]`;
}

export const cleanBasketFamilyFeature = {
	id: 'cleanBasketFamily',
	gate: 'G2',
	kind: 'deviation',
	defaultEnabled: false,
	note: 'Refine baseline basket matches to intact renderer-family members using basket-shape white coverage plus a coherent local dark shell.',
	knobs: {
		bboxTolerancePx: {
			default: 0,
			note: 'allowed difference between the bright component bbox and the 42x66 renderer-family bbox',
			validate: (value: unknown) =>
				Number.isInteger(value) && (value as number) >= 0 ? null : 'bboxTolerancePx must be a non-negative integer'
		},
		positionTolerancePx: {
			default: 2,
			note: 'maximum top-left displacement between a baseline sprite match and its bright connected component',
			validate: (value: unknown) =>
				finiteNumber(value) && value >= 0 ? null : 'positionTolerancePx must be non-negative'
		},
		areaRatioMin: {
			default: 0.96,
			note: 'minimum connected bright-component area divided by the basket template white-pixel count',
			validate: (value: unknown) =>
				finiteNumber(value) && value >= 0 ? null : 'areaRatioMin must be non-negative'
		},
		areaRatioMax: {
			default: 1.03,
			note: 'maximum connected bright-component area divided by the basket template white-pixel count',
			validate: (value: unknown) =>
				finiteNumber(value) && value >= 0 ? null : 'areaRatioMax must be non-negative'
		},
		whiteCoverageMin: {
			default: 0.96,
			note: 'minimum fraction of expected basket-shape white pixels owned by the matched bright component; bbox-off pixels are ignored',
			validate: (value: unknown) => fraction(value, 'whiteCoverageMin')
		},
		shellRadiusPx: {
			default: 2,
			note: '8-neighbor dilation radius used to form the local shell around the actual bright basket component shape',
			validate: (value: unknown) =>
				Number.isInteger(value) && (value as number) >= 1 ? null : 'shellRadiusPx must be a positive integer'
		},
		darkShellMin: {
			default: 0.5,
			note: 'minimum fraction of the shape-local shell occupied by dark-mask pixels',
			validate: (value: unknown) => fraction(value, 'darkShellMin')
		},
		darkCoherenceMin: {
			default: 0.8,
			note: 'minimum fraction of dark shell pixels belonging to one connected dark component',
			validate: (value: unknown) => fraction(value, 'darkCoherenceMin')
		}
	}
} satisfies ABFeature;

function templateWhiteOffsets(t: BasketTemplate): Int32Array {
	const offsets: number[] = [];
	if (t.rows.length !== t.height) throw new Error('cleanBasketFamily: template row count mismatch');
	for (let y = 0; y < t.height; y++) {
		if (t.rows[y]?.length !== t.width) throw new Error('cleanBasketFamily: template row width mismatch');
		for (let x = 0; x < t.width; x++) if (t.rows[y][x] === '1') offsets.push(y * t.width + x);
	}
	return Int32Array.from(offsets);
}

function shellEvidence(
	brightLabels: Int32Array,
	dark: Mask,
	darkLabels: Int32Array,
	component: ComponentStats,
	radius: number
): { darkShell: number; darkCoherence: number } {
	const { width, height } = dark;
	const x0 = Math.max(0, component.bboxX - radius);
	const y0 = Math.max(0, component.bboxY - radius);
	const x1 = Math.min(width, component.bboxX + component.bboxW + radius);
	const y1 = Math.min(height, component.bboxY + component.bboxH + radius);
	const localWidth = x1 - x0;
	const localHeight = y1 - y0;
	const body = new Uint8Array(localWidth * localHeight);
	for (let y = 0; y < localHeight; y++) {
		const row = (y0 + y) * width;
		for (let x = 0; x < localWidth; x++) {
			if (brightLabels[row + x0 + x] === component.label) body[y * localWidth + x] = 1;
		}
	}
	let dilated = body;
	for (let iteration = 0; iteration < radius; iteration++) {
		const next = new Uint8Array(dilated);
		for (let y = 0; y < localHeight; y++) {
			for (let x = 0; x < localWidth; x++) {
				if (dilated[y * localWidth + x]) continue;
				let adjacent = false;
				for (let dy = -1; dy <= 1 && !adjacent; dy++) {
					for (let dx = -1; dx <= 1; dx++) {
						const xx = x + dx;
						const yy = y + dy;
						if (xx < 0 || xx >= localWidth || yy < 0 || yy >= localHeight) continue;
						if (dilated[yy * localWidth + xx]) {
							adjacent = true;
							break;
						}
					}
				}
				if (adjacent) next[y * localWidth + x] = 1;
			}
		}
		dilated = next;
	}
	let shellCount = 0;
	let darkCount = 0;
	const darkComponents = new Map<number, number>();
	for (let y = 0; y < localHeight; y++) {
		const row = (y0 + y) * width;
		for (let x = 0; x < localWidth; x++) {
			const local = y * localWidth + x;
			if (!dilated[local] || body[local]) continue;
			shellCount++;
			const global = row + x0 + x;
			if (!dark.data[global]) continue;
			darkCount++;
			const label = darkLabels[global];
			if (label) darkComponents.set(label, (darkComponents.get(label) ?? 0) + 1);
		}
	}
	let dominant = 0;
	for (const count of darkComponents.values()) if (count > dominant) dominant = count;
	return {
		darkShell: shellCount ? darkCount / shellCount : 0,
		darkCoherence: darkCount ? dominant / darkCount : 0
	};
}

/** Pure core: classify each baseline sprite as an intact basket-family member. */
export function selectCleanBasketFamily(
	stage: Pick<BadgeStageResult, 'brightMask' | 'darkMask' | 'brightLabels' | 'brightComponents'>,
	sprites: readonly SpriteMatch[],
	t: BasketTemplate,
	knobs: CleanBasketFamilyKnobs
): CleanBasketFamilyResult {
	const whiteOffsets = templateWhiteOffsets(t);
	const whiteCount = Math.max(1, whiteOffsets.length);
	const darkStage = extractComponents(stage.darkMask);
	const decisions: CleanBasketDecision[] = [];
	const kept: SpriteMatch[] = [];
	for (const sprite of sprites) {
		const aligned = stage.brightComponents
			.filter((component) =>
				Math.abs(component.bboxX - sprite.x) <= knobs.positionTolerancePx &&
				Math.abs(component.bboxY - sprite.y) <= knobs.positionTolerancePx)
			.sort((a, b) =>
				Math.hypot(a.bboxX - sprite.x, a.bboxY - sprite.y) -
				Math.hypot(b.bboxX - sprite.x, b.bboxY - sprite.y) || a.label - b.label)[0];
		let testimony: CleanBasketTestimony = {
			areaRatio: 0,
			whiteCoverage: 0,
			darkShell: 0,
			darkCoherence: 0
		};
		let reason = 'intact basket family';
		let accepted = true;
		if (!aligned) {
			accepted = false;
			reason = `no isolated bright component aligned within ${knobs.positionTolerancePx}px of sprite`;
		} else if (
			Math.abs(aligned.bboxW - t.width) > knobs.bboxTolerancePx ||
			Math.abs(aligned.bboxH - t.height) > knobs.bboxTolerancePx
		) {
			accepted = false;
			reason = `bright component bbox ${aligned.bboxW}x${aligned.bboxH} is outside ${t.width}x${t.height} ±${knobs.bboxTolerancePx}px`;
			testimony = { ...testimony, componentDx: aligned.bboxX - sprite.x, componentDy: aligned.bboxY - sprite.y };
		} else {
			const areaRatio = aligned.area / whiteCount;
			let whiteHit = 0;
			for (let i = 0; i < whiteOffsets.length; i++) {
				const offset = whiteOffsets[i];
				const x = offset % t.width;
				const y = (offset - x) / t.width;
				const gx = sprite.x + x;
				const gy = sprite.y + y;
				if (gx >= 0 && gx < stage.brightMask.width && gy >= 0 && gy < stage.brightMask.height &&
					stage.brightLabels[gy * stage.brightMask.width + gx] === aligned.label) whiteHit++;
			}
			const whiteCoverage = whiteHit / whiteCount;
			const shell = shellEvidence(stage.brightLabels, stage.darkMask, darkStage.labels, aligned, knobs.shellRadiusPx);
			testimony = {
				areaRatio,
				whiteCoverage,
				darkShell: shell.darkShell,
				darkCoherence: shell.darkCoherence,
				componentDx: aligned.bboxX - sprite.x,
				componentDy: aligned.bboxY - sprite.y
			};
			if (areaRatio < knobs.areaRatioMin) {
				accepted = false;
				reason = `bright component area ratio ${areaRatio.toFixed(3)} < ${knobs.areaRatioMin}`;
			} else if (areaRatio > knobs.areaRatioMax) {
				accepted = false;
				reason = `bright component area ratio ${areaRatio.toFixed(3)} > ${knobs.areaRatioMax}`;
			} else if (whiteCoverage < knobs.whiteCoverageMin) {
				accepted = false;
				reason = `basket-shape white coverage ${whiteCoverage.toFixed(3)} < ${knobs.whiteCoverageMin}`;
			} else if (shell.darkShell < knobs.darkShellMin) {
				accepted = false;
				reason = `shape-local dark shell ${shell.darkShell.toFixed(3)} < ${knobs.darkShellMin}`;
			} else if (shell.darkCoherence < knobs.darkCoherenceMin) {
				accepted = false;
				reason = `dark-shell coherence ${shell.darkCoherence.toFixed(3)} < ${knobs.darkCoherenceMin}`;
			}
		}
		const decision = { sprite, accepted, reason, testimony } satisfies CleanBasketDecision;
		decisions.push(decision);
		if (accepted) kept.push(sprite);
	}
	return { sprites: kept, decisions };
}

function spriteKey(x: number, y: number): string {
	return `${x}:${y}`;
}

export const cleanBasketFamilyUnit: EngineUnit = {
	id: 'cleanBasketFamily',
	gate: 'G2',
	consumes: ['stage', 'sprites', 'baskets', 'viewport'],
	produces: ['sprites', 'baskets'],
	note: 'refine baseline basket matches to intact renderer-family members',
	run(board, ctx) {
		const stop = ctx.span('cleanBasketFamily');
		const state = ctx.resolve(cleanBasketFamilyFeature);
		if (state.enabled) {
			const stage = board.get<BadgeStageResult>('stage');
			const sprites = board.get<readonly SpriteMatch[]>('sprites');
			const baskets = board.get<readonly BasketEvidence[]>('baskets');
			const viewport = board.get<{ topPx: number }>('viewport');
			const result = selectCleanBasketFamily(stage, sprites, template, state.knobs as unknown as CleanBasketFamilyKnobs);
			const acceptedKeys = new Set(result.sprites.map((sprite) => spriteKey(sprite.x, sprite.y)));
			const basketByKey = new Map(baskets.map((basket) => [spriteKey(basket.bbox[0], basket.bbox[1] - viewport.topPx), basket] as const));
			for (const decision of result.decisions) {
				const sprite = decision.sprite;
				const basket = basketByKey.get(spriteKey(sprite.x, sprite.y));
				const values: Record<string, number> = {
					spriteScore: sprite.score,
					areaRatio: decision.testimony.areaRatio,
					whiteCoverage: decision.testimony.whiteCoverage,
					darkShell: decision.testimony.darkShell,
					darkCoherence: decision.testimony.darkCoherence
				};
				if (decision.testimony.componentDx !== undefined) values.componentDx = decision.testimony.componentDx;
				if (decision.testimony.componentDy !== undefined) values.componentDy = decision.testimony.componentDy;
				ctx.overlay('cleanBasketFamily', {
					type: 'box',
					bbox: [sprite.x, sprite.y + viewport.topPx, template.width, template.height],
					verdict: decision.accepted ? 'accepted' : 'rejected',
					reason: decision.reason,
					ref: basket?.detId,
					values
				});
				ctx.measure('cleanBasketFamily', 'spriteScore', sprite.score);
				ctx.measure('cleanBasketFamily', 'areaRatio', decision.testimony.areaRatio);
				ctx.measure('cleanBasketFamily', 'whiteCoverage', decision.testimony.whiteCoverage);
				ctx.measure('cleanBasketFamily', 'darkShell', decision.testimony.darkShell);
				ctx.measure('cleanBasketFamily', 'darkCoherence', decision.testimony.darkCoherence);
			}
			ctx.measure('cleanBasketFamily', 'inputCount', sprites.length);
			ctx.measure('cleanBasketFamily', 'acceptedCount', result.sprites.length);
			ctx.measure('cleanBasketFamily', 'rejectedCount', sprites.length - result.sprites.length);
			board.set('sprites', [...result.sprites]);
			board.set('baskets', baskets.filter((basket) => acceptedKeys.has(spriteKey(basket.bbox[0], basket.bbox[1] - viewport.topPx))));
		}
		stop();
	}
};
