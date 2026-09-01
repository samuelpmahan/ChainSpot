import { describe, expect, test } from 'vitest';
import {
	badgeOwnedPixels,
	decodeMaterializedBadgeEvidence,
	encodeMaterializedBadgeEvidence,
	materializeBadgeEvidence
} from '@chainspot/alg/detectors/threeFactor/badgeEvidence';
import { groupBrightDarkComponentFields } from '@chainspot/alg/detectors/threeFactor/componentField';
import {
	assembleBadgeV1,
	materializeComponentAssembly
} from '@chainspot/alg/detectors/threeFactor/componentAssembly';
import type { ComponentStats } from '@chainspot/alg/detectors/threeFactor/components';
import type { BadgeEvidence } from '@chainspot/alg/detectors/threeFactor/types';

function component(label: number, x: number, y: number, w: number, h: number): ComponentStats {
	return {
		label,
		cx: x + w / 2,
		cy: y + h / 2,
		area: w * h,
		bboxX: x,
		bboxY: y,
		bboxW: w,
		bboxH: h,
		major: Math.max(w, h),
		minor: Math.min(w, h),
		angle: 0,
		fill: 1
	};
}

describe('materialized badge evidence', () => {
	test('keeps B+W immutable while AA partitions the exact residue', () => {
		const width = 9;
		const height = 9;
		const bright = { width, height, data: new Uint8Array(width * height) };
		const dark = { width, height, data: new Uint8Array(width * height) };
		for (let y = 2; y <= 6; y++)
			for (let x = 2; x <= 6; x++) {
				if (x === 2 || x === 6 || y === 2 || y === 6) bright.data[y * width + x] = 1;
				else dark.data[y * width + x] = 1;
			}
		const fields = groupBrightDarkComponentFields({ bright, dark });
		const outer = fields.bright.components[0];
		const plan = assembleBadgeV1(outer, fields.bright.components, fields.dark.components);
		expect(plan.status).toBe('assembled');
		if (plan.status !== 'assembled') return;
		const assembly = materializeComponentAssembly(plan, {
			width,
			height,
			topPx: 0,
			brightLabels: fields.bright.labels,
			darkLabels: fields.dark.labels
		});
		const badge = {
			detId: 'badge-0',
			component: outer,
			cxPx: 4,
			cyPx: 4,
			bbox: [2, 2, 5, 5],
			source: 'bright-family',
			digits: [],
			rawLabel: '',
			digitCount: 0,
			label: null,
			bestLabel: null,
			labelCandidates: [],
			confidence: Infinity,
			abstentionReason: 'empty-glyph',
			confidenceFloor: 0,
			conflictWith: [],
			notes: []
		} satisfies BadgeEvidence;
		const specimen = materializeBadgeEvidence(
			{ width, height, data: new Uint8Array(width * height * 4) },
			fields,
			badge,
			assembly,
			{
				imageId: 'sha256:image',
				paramsHash: 'sha256:params',
				detector: 'test',
				detectorVersion: '1'
			}
		);

		const owned = new Set(specimen.ownedBwPixels);
		const aa = new Set(specimen.aaPixels);
		const residue = new Set(specimen.residuePixels);
		expect([...owned].some((pixel) => aa.has(pixel) || residue.has(pixel))).toBe(false);
		expect([...aa].some((pixel) => residue.has(pixel))).toBe(false);
		expect(specimen.measurements.bwOwnedPixelCount).toBe(25);
		expect(specimen.measurements.aaAddedPixelCount).toBe(24);
		expect(specimen.measurements.residueBefore).toBe(24);
		expect(specimen.measurements.residueAfter).toBe(0);
		expect(owned.size + specimen.measurements.residueBefore).toBe(49);
		expect(owned.size + aa.size + residue.size).toBe(49);
		expect([...specimen.ownedBwPixels]).toEqual([...assembly.ownedPixels]);
		expect(badgeOwnedPixels(specimen, false)).toBe(specimen.ownedBwPixels);
		expect(new Set(badgeOwnedPixels(specimen, true))).toEqual(new Set([...owned, ...aa]));
		expect(specimen.region.rgba).toHaveLength(49 * 4);
		expect(specimen.region.brightLabels).toHaveLength(49);
		const replay = decodeMaterializedBadgeEvidence(encodeMaterializedBadgeEvidence(specimen));
		expect(replay).toEqual(specimen);
		expect(replay.ownedBwPixels).toBeInstanceOf(Uint32Array);
		expect(replay.region.brightLabels).toBeInstanceOf(Int32Array);
	});
});
