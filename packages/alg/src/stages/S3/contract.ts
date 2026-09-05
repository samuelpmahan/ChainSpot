import { executeS3VisibleTees, materializeS3Subtraction } from './clean';
import type { StageContract } from '../contract';

const box = (bbox: readonly [number, number, number, number], color: readonly [number, number, number, number]) => ({ bbox, color });

export const stageContract: StageContract = {
	id: 'S3',
	async execute(context) {
		if (!context.pxc) throw new Error('S3 requires prior Stage PxC.');
		const run = executeS3VisibleTees(context.pxc);
		const subtraction = materializeS3Subtraction(run.image, run.tees);
		const lines = [
			'S3 RECEIPT',
			'progression: 1=CroppedImage · 2=enclosed holes · 3=elongated rings after Badge mute · 4=enclosing bright frames · 5=common visible Tee family · 6=TeePx subtraction · 7=Tee objects',
			`input: ${context.inputLabel}`,
			`enclosed holes: ${run.rings.enclosed.length}`,
			`elongated rings: ${run.rings.elongated.length}`,
			`excluded by Badge mute: ${run.rings.excludedByBadge.length}`,
			`ring candidates: ${run.rings.candidates.length}`,
			`enclosing bright frames: ${run.family.measured.length}`,
			`rings without frame: ${run.family.unframed.length}`,
			`common visible Tee family: ${run.family.members.length}`,
			`Tee objects: ${run.tees.length}`,
			`TeePx: ${subtraction.teePx}`,
			'recovery: NOT RUN',
			'component fallback: NOT RUN',
			'materialization: subtraction raster is PCR output only; it is not written to PxC',
			'',
			'TEES',
			'order | center | inner hole bbox | outer frame bbox | TeePx'
		];
		run.tees.forEach((tee, index) => {
			lines.push(
				`${index + 1} | ${tee.center.map((value) => value.toFixed(1)).join(',')} | ${tee.innerBbox.join(',')} | ${tee.bbox.join(',')} | ${tee.px.length}`
			);
		});
		return {
			pxc: run.pxc,
			receiptText: lines.join('\n'),
			panels: [
				{
					label: 'CroppedImage',
					widthPx: run.image.widthPx,
					heightPx: run.image.heightPx,
					rgba: run.image.rgba
				},
				{
					label: 'Enclosed holes',
					widthPx: run.image.widthPx,
					heightPx: run.image.heightPx,
					rgba: run.image.rgba,
					boxes: run.rings.enclosed.map((ring) =>
						box(
							[ring.bboxX, ring.bboxY, ring.bboxW, ring.bboxH],
							ring.kind === 'tee-rect' ? [34, 211, 238, 255] : [148, 163, 184, 255]
						)
					)
				},
				{
					label: 'Elongated rings after Badge mute',
					widthPx: run.image.widthPx,
					heightPx: run.image.heightPx,
					rgba: run.image.rgba,
					boxes: run.rings.candidates.map((ring) =>
						box([ring.bboxX, ring.bboxY, ring.bboxW, ring.bboxH], [250, 204, 21, 255])
					)
				},
				{
					label: 'Enclosing bright frames',
					widthPx: run.image.widthPx,
					heightPx: run.image.heightPx,
					rgba: run.image.rgba,
					boxes: run.family.measured.map((member) =>
						box(
							[member.frame.bboxX, member.frame.bboxY, member.frame.bboxW, member.frame.bboxH],
							[249, 115, 22, 255]
						)
					)
				},
				{
					label: 'Common visible Tee family',
					widthPx: run.image.widthPx,
					heightPx: run.image.heightPx,
					rgba: run.image.rgba,
					boxes: run.family.members.map((member) =>
						box(
							[member.frame.bboxX, member.frame.bboxY, member.frame.bboxW, member.frame.bboxH],
							[34, 197, 94, 255]
						)
					)
				},
				{
					label: 'TeePx subtraction',
					widthPx: subtraction.widthPx,
					heightPx: subtraction.heightPx,
					rgba: subtraction.rgba
				},
				{
					label: 'Tee objects',
					widthPx: run.image.widthPx,
					heightPx: run.image.heightPx,
					rgba: run.image.rgba,
					boxes: run.tees.map((tee) => box(tee.bbox, [168, 85, 247, 255]))
				}
			]
		};
	}
};
