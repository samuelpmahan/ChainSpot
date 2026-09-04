import { executeS1BadgesCandidate, materializeS1Subtractions } from './candidate';
import type { StageContract } from '../contract';

export const stageContract: StageContract = {
	id: 'S1',
	async execute(context) {
		if (!context.pxc) throw new Error('S1 requires S0 PxC.');
		const run = executeS1BadgesCandidate(context.pxc);
		const subtraction = materializeS1Subtractions(run);
		const recovered = run.badges.filter((badge) => badge.source === 'dark-plate-recovery').length;
		const brightPixels = run.masks.bright.data.reduce((sum, value) => sum + value, 0);
		const darkPixels = run.masks.dark.data.reduce((sum, value) => sum + value, 0);
		const lines = [
			'S1 RECEIPT',
			'progression: 1=CroppedImage · 2=masks · 3=BadgePx subtraction · 4=Badge mute subtraction · 5=Badge objects',
			`input: ${context.inputLabel}`,
			`CroppedImage: ${run.croppedImage.widthPx}x${run.croppedImage.heightPx}`,
			`masks: brightPx=${brightPixels} darkPx=${darkPixels}`,
			`components: bright=${run.components.bright.components.length} dark=${run.components.dark.components.length}`,
			`Badge family: ${run.family.length}`,
			`Badge recovery: ${recovered}`,
			`output: PxC · Badge[]=${run.badges.length}`,
			`BadgePx=${subtraction.badgePx.badgePx} addedMutePx=${subtraction.muted.addedMutePx} mutedPx=${subtraction.muted.mutedPx}`,
			'materialization: subtraction rasters are PCR output only; they are not written to PxC',
			'',
			'BADGES',
			'order | source | read | bbox | white BadgePx | black BadgePx | added mute'
		];
		run.badges.forEach((badge, index) => {
			lines.push(
				`${index + 1} | ${badge.source} | ${badge.label ?? 'UNREAD'} | ${badge.bbox.join(',')} | ${badge.whitePx} | ${badge.blackPx} | ${badge.has.mute.px.length - badge.px.length}`
			);
		});
		return {
			pxc: run.pxc,
			receiptText: lines.join('\n'),
			panels: [
				{
					label: 'CroppedImage',
					widthPx: run.croppedImage.widthPx,
					heightPx: run.croppedImage.heightPx,
					rgba: run.croppedImage.rgba
				},
				{
					label: 'Masks',
					widthPx: run.croppedImage.widthPx,
					heightPx: run.croppedImage.heightPx,
					rgba: maskRgba(run)
				},
				{
					label: 'BadgePx subtraction',
					widthPx: subtraction.badgePx.widthPx,
					heightPx: subtraction.badgePx.heightPx,
					rgba: subtraction.badgePx.rgba
				},
				{
					label: 'Badge mute subtraction',
					widthPx: subtraction.muted.widthPx,
					heightPx: subtraction.muted.heightPx,
					rgba: subtraction.muted.rgba
				},
				{
					label: 'Badge objects',
					widthPx: run.croppedImage.widthPx,
					heightPx: run.croppedImage.heightPx,
					rgba: run.croppedImage.rgba,
					boxes: run.badges.map((badge) => ({
						bbox: badge.bbox,
						color: badge.source === 'dark-plate-recovery' ? [250, 204, 21, 255] : [34, 197, 94, 255]
					}))
				}
			]
		};
	}
};

function maskRgba(run: ReturnType<typeof executeS1BadgesCandidate>): Uint8Array {
	const rgba = new Uint8Array(run.croppedImage.widthPx * run.croppedImage.heightPx * 4);
	for (let index = 0; index < run.masks.bright.data.length; index++) {
		const value = run.masks.bright.data[index] ? 245 : run.masks.dark.data[index] ? 20 : 128;
		const offset = index * 4;
		rgba[offset] = value;
		rgba[offset + 1] = value;
		rgba[offset + 2] = value;
		rgba[offset + 3] = 255;
	}
	return rgba;
}
