import type { AnnotatedHole } from '$lib/domain/annotatedRound';

export const image = '/hole-spike-aerial.png';

export const widthPx = 960;
export const heightPx = 540;

export const hole = {
	id: 'sample-hole-1',
	number: 1,
	tee: { xPx: 160, yPx: 410 },
	basket: { xPx: 720, yPx: 140 },
	shots: [
		{ id: 'sample-shot-1', landing: { xPx: 290, yPx: 320 } },
		{ id: 'sample-shot-2', landing: { xPx: 490, yPx: 200 } },
		{ id: 'sample-shot-3', landing: { xPx: 610, yPx: 165 } }
	],
	corridorBends: [{ xPx: 440, yPx: 250 }],
	corridorWidthPx: 60
} satisfies AnnotatedHole;
