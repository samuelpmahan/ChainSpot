import { describe, expect, test } from 'vitest';
import {
	assembleBadgeV1,
	assembleBasketV1,
	learnBasketShellFamilyV1,
	materializeComponentAssembly
} from '@chainspot/alg/detectors/threeFactor/componentAssembly';
import { groupBrightDarkComponentFields } from '@chainspot/alg/detectors/threeFactor/componentField';
import {
	decodeMaterializedM1Representation,
	encodeMaterializedM1Representation,
	materializeM1Representation
} from '@chainspot/alg/detectors/threeFactor/m1Representation';
import type { ObjectGraph } from '@chainspot/alg/detectors/threeFactor/objects';
import type { Mask } from '@chainspot/alg/detectors/threeFactor/raster';
import type { BadgeEvidence, BasketEvidence } from '@chainspot/alg/detectors/threeFactor/types';

const width = 40;
const height = 20;
const topPx = 7;

function mask(): Mask {
	return { width, height, data: new Uint8Array(width * height) };
}

function fill(target: Mask, x: number, y: number, w: number, h: number): void {
	for (let yy = y; yy < y + h; yy++)
		for (let xx = x; xx < x + w; xx++) target.data[yy * width + xx] = 1;
}

function outline(target: Mask, x: number, y: number, w: number, h: number): void {
	for (let xx = x; xx < x + w; xx++) {
		target.data[y * width + xx] = 1;
		target.data[(y + h - 1) * width + xx] = 1;
	}
	for (let yy = y; yy < y + h; yy++) {
		target.data[yy * width + x] = 1;
		target.data[yy * width + x + w - 1] = 1;
	}
}

describe('E representation M1', () => {
	test('retains every ComponentField primitive while accounting only selected B+W ownership', () => {
		const bright = mask();
		const dark = mask();
		outline(bright, 1, 1, 10, 10);
		fill(bright, 5, 4, 1, 4);
		fill(dark, 2, 2, 8, 8);
		fill(bright, 20, 3, 4, 6);
		outline(dark, 19, 2, 6, 8);
		fill(bright, 35, 15, 2, 2); // unrelated but independently addressable primitive

		const fields = groupBrightDarkComponentFields({ bright, dark });
		const brightAt = (x: number, y: number) =>
			fields.bright.components.find(
				(component) => component.label === fields.bright.labels[y * width + x]
			)!;
		const badgeOuter = brightAt(1, 1);
		const basketBody = brightAt(20, 3);
		const badgePlan = assembleBadgeV1(
			badgeOuter,
			fields.bright.components,
			fields.dark.components,
			topPx
		);
		const basketFamily = learnBasketShellFamilyV1([basketBody], fields.dark.components);
		expect(badgePlan.status).toBe('assembled');
		expect(basketFamily).toEqual([1, 1, 1, 1]);
		if (badgePlan.status !== 'assembled' || !basketFamily) return;
		const basketPlan = assembleBasketV1(basketBody, fields.dark.components, basketFamily, topPx);
		expect(basketPlan.status).toBe('assembled');
		if (basketPlan.status !== 'assembled') return;
		const raster = {
			width,
			height,
			topPx,
			brightLabels: fields.bright.labels,
			darkLabels: fields.dark.labels
		};
		const badgeAssembly = materializeComponentAssembly(badgePlan, raster);
		const basketAssembly = materializeComponentAssembly(basketPlan, raster);
		const graph: ObjectGraph = {
			badges: [
				{
					kind: 'badge',
					id: 'badge-0',
					raster: {
						detectorId: 'badge-0',
						bbox: badgeAssembly.bbox,
						kind: 'observed',
						componentAssembly: badgeAssembly
					},
					evidence: {} as BadgeEvidence
				}
			],
			baskets: [
				{
					kind: 'basket',
					id: 'basket-0',
					raster: {
						detectorId: 'basket-0',
						bbox: basketAssembly.bbox,
						kind: 'observed',
						componentAssembly: basketAssembly
					},
					evidence: {} as BasketEvidence
				},
				{
					kind: 'basket',
					id: 'basket-failed',
					raster: {
						detectorId: 'basket-failed',
						bbox: [0, 0, 1, 1],
						kind: 'fitted',
						componentAssembly: {
							status: 'failed',
							reason: 'no intact shell',
							seedBbox: [0, 0, 1, 1]
						}
					},
					evidence: {} as BasketEvidence
				}
			],
			tees: [],
			occlusions: []
		};

		const m1 = materializeM1Representation(
			graph,
			fields,
			{ imageId: 'image', paramsHash: 'params', detector: 'test', detectorVersion: '1' },
			topPx
		);
		expect(m1.components).toHaveLength(
			fields.bright.components.length + fields.dark.components.length
		);
		const unrelated = m1.components.find(
			(component) => component.polarity === 'bright' && component.bbox[0] === 35
		);
		expect(unrelated).toMatchObject({ producedBy: 'badgeStage.components', consumers: [] });
		expect(unrelated?.pixels).toEqual(Uint32Array.from([915, 916, 955, 956]));

		for (const [object, expected] of [
			[m1.objects[0], badgeAssembly.ownedPixels],
			[m1.objects[1], basketAssembly.ownedPixels]
		] as const) {
			expect(object.accounting.status).toBe('known');
			if (object.accounting.status !== 'known') continue;
			expect(object.accounting.availablePixels).toEqual(expected);
			expect(object.accounting.explainedPixels).toEqual(expected);
			expect(object.accounting.unexplainedPixels).toHaveLength(0);
		}
		expect(m1.objects[2]).toMatchObject({
			id: 'basket-failed',
			assemblyStatus: 'failed',
			componentUses: [],
			relationshipIds: [],
			accounting: { status: 'unknown', reason: 'no intact shell' }
		});
		expect(m1.relationships.map((value) => value.predicate)).toEqual([
			'bbox-contains',
			'bbox-contains',
			'modal-shell-encloses'
		]);
		expect(
			m1.components.find((component) => component.id === 'component.bright.1')?.consumers
		).toEqual([{ objectId: 'badge-0', objectKind: 'badge', role: 'outer-bright' }]);

		const decoded = decodeMaterializedM1Representation(encodeMaterializedM1Representation(m1));
		expect(decoded).toEqual(m1);
	});
});
