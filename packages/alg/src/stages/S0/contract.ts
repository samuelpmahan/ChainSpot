import { createS0Stage, executeS0, formatS0ReceiptText } from './clean';
import type { StageContract } from '../contract';

export const stageContract: StageContract = {
	id: 'S0',
	async execute(context) {
		if (context.pxc) throw new Error('S0 must create the page-load PxC.');
		const run = await executeS0({
			stage: createS0Stage(),
			source: context.source,
			decode: context.decode
		});
		return {
			pxc: run.pxc,
			receiptText: formatS0ReceiptText(run, {
				inputLabel: context.inputLabel,
				progression: 'page load → decode FullImage → crop → PxC → cache FullImage'
			}),
			panels: [
				{
					label: 'FullImage',
					widthPx: run.fullImage.widthPx,
					heightPx: run.fullImage.heightPx,
					rgba: run.fullImage.rgba
				},
				{
					label: 'CroppedImage',
					widthPx: run.croppedImage.widthPx,
					heightPx: run.croppedImage.heightPx,
					rgba: run.croppedImage.rgba
				}
			]
		};
	}
};
