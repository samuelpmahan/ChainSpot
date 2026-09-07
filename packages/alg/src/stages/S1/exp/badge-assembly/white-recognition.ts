import logisticModelData from '../../../../detectors/threeFactor/assets/logistic.json';
import { normalizeDigitMask } from '../../../../detectors/threeFactor/digits/normalize';
import { predictProbs, type LogisticModel } from '../../../../detectors/threeFactor/digits/logisticInference';
import { segmentDigits, type DigitsKnobs } from '../../../../detectors/threeFactor/digits/segment';
import { pxFn, pxKey, type PxC } from '../../../../exec/board';
import type { BadgeAssemblyResult } from './index';

export interface WhiteDigitPrepared {
	readonly bbox: readonly [number, number, number, number];
	readonly mask: Uint8Array;
	readonly normalized: Uint8Array;
	readonly method: 'cc' | 'valley-split';
	readonly notes: readonly string[];
}

export interface WhiteBadgePrepared {
	/** Original assembled candidate, retained for provenance and later rendering. */
	readonly badge: BadgeAssemblyResult['candidates'][number];
	readonly glyph: {
		readonly origin: readonly [number, number];
		readonly width: number;
		readonly height: number;
		readonly pixels: Uint32Array;
	};
	readonly digits: readonly WhiteDigitPrepared[];
	readonly notes: readonly string[];
}

export interface WhiteRecognitionPrepared {
	readonly badges: readonly WhiteBadgePrepared[];
	readonly incomplete: BadgeAssemblyResult['incomplete'];
}

export interface WhiteDigitRanking {
	readonly label: string;
	readonly score: number;
}

export interface WhiteDigitMatch extends WhiteDigitPrepared {
	readonly rankings: readonly WhiteDigitRanking[];
}

export interface WhiteBadgeReading {
	readonly value: string | null;
	readonly status: 'read' | 'unread';
	readonly digits: readonly WhiteDigitMatch[];
}

export interface WhiteRecognitionMatch {
	readonly candidates: readonly (WhiteBadgePrepared['badge'] & { readonly reading: WhiteBadgeReading })[];
	readonly incomplete: BadgeAssemblyResult['incomplete'];
}

export const WhiteRecognitionPxC = {
	model: pxKey<LogisticModel>('px.s1.whiteDigits.model')
} as const;

export const WhiteRecognitionFn = {
	prepare: pxFn<
		{ readonly badges: BadgeAssemblyResult; readonly knobs: DigitsKnobs },
		WhiteRecognitionPrepared
	>('fn.s1.whiteDigits.prepare'),
	match: pxFn<
		{ readonly prepared: WhiteRecognitionPrepared; readonly model: LogisticModel },
		WhiteRecognitionMatch
	>('fn.s1.whiteDigits.match')
} as const;

function tightMask(candidate: BadgeAssemblyResult['candidates'][number]): {
	pixels: Uint32Array;
	origin: readonly [number, number];
	width: number;
	height: number;
	data: Uint8Array;
} {
	const pixels = Uint32Array.from(
		[...new Set(candidate.digits.flatMap((digit) => Array.from(digit.part.pixels)))].sort((a, b) => a - b)
	);
	if (!pixels.length) {
		return { pixels, origin: [0, 0], width: 0, height: 0, data: new Uint8Array() };
	}
	const width = candidate.digits[0].part.widthPx;
	let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
	for (const pixel of pixels) {
		const x = pixel % width;
		const y = Math.floor(pixel / width);
		minX = Math.min(minX, x); maxX = Math.max(maxX, x);
		minY = Math.min(minY, y); maxY = Math.max(maxY, y);
	}
	const tightWidth = maxX - minX + 1, tightHeight = maxY - minY + 1;
	const data = new Uint8Array(tightWidth * tightHeight);
	for (const pixel of pixels) {
		const x = pixel % width, y = Math.floor(pixel / width);
		data[(y - minY) * tightWidth + x - minX] = 1;
	}
	return { pixels, origin: [minX, minY], width: tightWidth, height: tightHeight, data };
}

function prepare({ badges, knobs }: { badges: BadgeAssemblyResult; knobs: DigitsKnobs }): WhiteRecognitionPrepared {
	const prepared = badges.candidates.map((badge) => {
		const glyph = tightMask(badge);
		const segmented = glyph.width > 0
			? segmentDigits({ width: glyph.width, height: glyph.height, data: glyph.data }, knobs)
			: { digits: [], notes: ['empty white digit pixel union'] };
		const digits = segmented.digits.map((digit) => ({
			bbox: digit.bbox,
			mask: digit.mask,
			normalized: normalizeDigitMask(digit.mask, digit.bbox[2], digit.bbox[3], knobs),
			method: digit.method,
			notes: segmented.notes
		}));
		return {
			badge,
			glyph: { origin: glyph.origin, width: glyph.width, height: glyph.height, pixels: glyph.pixels },
			digits,
			notes: segmented.notes
		};
	});
	return { badges: prepared, incomplete: badges.incomplete };
}

function match({ prepared, model }: { prepared: WhiteRecognitionPrepared; model: LogisticModel }): WhiteRecognitionMatch {
	const candidates = prepared.badges.map(({ badge, digits }) => {
		const readings = digits.map((digit) => {
			const scores = predictProbs(model, digit.normalized);
			const rankings = scores.map((score, index) => ({ label: model.classes[index], score }))
				.sort((left, right) => right.score - left.score);
			return { ...digit, rankings };
		});
		const value = readings.map((digit) => digit.rankings[0]?.label ?? '').join('');
		const reading: WhiteBadgeReading = { value: value || null, status: value ? 'read' : 'unread', digits: readings };
		return { ...badge, reading };
	});
	return { candidates, incomplete: prepared.incomplete };
}

/** Register the bounded white digit preparation and model matching operations. */
export function prepareWhiteRecognition(pxc: PxC): void {
	pxc.set(WhiteRecognitionPxC.model, logisticModelData as LogisticModel);
	pxc.register(WhiteRecognitionFn.prepare, prepare);
	pxc.register(WhiteRecognitionFn.match, match);
}
