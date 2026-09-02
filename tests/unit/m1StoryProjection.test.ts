import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PNG } from 'pngjs';
import { describe, expect, test } from 'vitest';
import { materializeBadgeSpecimens } from '../../src/lib/server/evidence-workbench/materializeBadgeSpecimens.mjs';
import { projectM1Image, type M1Projection } from '../../src/lib/evidence-workbench/m1Projection';
import type { M1WorkbenchLibrary } from '../../src/lib/evidence-workbench/badgeSpecimen';

const structuralLibrary: M1WorkbenchLibrary = {
	artifact: { id: 'structural', sha256: 'structural' },
	raster: { width: 3, height: 2, topPx: 0 },
	components: [
		{
			id: 'component.bright.1',
			polarity: 'bright',
			label: 1,
			bbox: [1, 0, 1, 2],
			area: 2,
			pixels: [1, 4],
			producedBy: 'badgeStage.components',
			consumers: [{ objectId: 'badge-0', objectKind: 'badge', role: 'outer-bright' }]
		}
	],
	relationships: [],
	basketShellFamilies: [],
	objects: [
		{
			id: 'badge-0',
			kind: 'badge',
			assemblyStatus: 'assembled',
			componentUses: [{ componentId: 'component.bright.1', role: 'outer-bright' }],
			relationshipIds: [],
			accounting: {
				status: 'known',
				availablePixels: [1, 4],
				explainedPixels: [1],
				unexplainedPixels: [4]
			}
		}
	]
};

function png(library: M1WorkbenchLibrary, subjectId: string, projection: M1Projection): Buffer {
	const image = projectM1Image(library, subjectId, projection);
	const output = new PNG({ width: image.width, height: image.height });
	output.data = Buffer.from(image.rgba);
	return PNG.sync.write(output);
}

describe('Args-driven Storybook M1 projections', () => {
	test('always projects accounting Args into exact pixels without a corpus', () => {
		const available = projectM1Image(structuralLibrary, 'badge-0', 'available');
		const explained = projectM1Image(structuralLibrary, 'badge-0', 'explained');
		const unexplained = projectM1Image(structuralLibrary, 'badge-0', 'unexplained');
		expect([available.width, available.height]).toEqual([1, 2]);
		expect([...available.rgba]).toEqual([250, 204, 21, 255, 250, 204, 21, 255]);
		expect([...explained.rgba]).toEqual([34, 197, 94, 255, 0, 0, 0, 0]);
		expect([...unexplained.rgba]).toEqual([0, 0, 0, 0, 220, 38, 38, 255]);
	});

	test('renders real Badge/Basket accounting and reverse component consumption from E', async () => {
		const materialized = await materializeBadgeSpecimens();
		if (!materialized.m1) {
			expect(materialized.status).toBe('unavailable');
			return;
		}
		const m1 = materialized.m1;
		const badge = m1.objects.find((object) => object.id === 'badge-0');
		const basket = m1.objects.find((object) => object.id === 'basket-0');
		expect(m1.basketShellFamilies).toMatchObject([
			{
				id: 'family.basket-shell.2.3.2.3',
				margins: [2, 3, 2, 3],
				relationshipIds: expect.any(Array),
				componentIds: expect.any(Array)
			}
		]);
		expect(m1.basketShellFamilies[0]?.relationshipIds).toHaveLength(16);
		expect(m1.basketShellFamilies[0]?.componentIds).toHaveLength(32);
		expect(badge?.accounting).toMatchObject({ status: 'known' });
		expect(basket?.accounting).toMatchObject({ status: 'known' });
		if (
			!badge ||
			badge.accounting.status !== 'known' ||
			!basket ||
			basket.accounting.status !== 'known'
		)
			return;
		expect([
			badge.accounting.availablePixels.length,
			badge.accounting.explainedPixels.length,
			badge.accounting.unexplainedPixels.length
		]).toEqual([2096, 2096, 0]);
		expect([
			basket.accounting.availablePixels.length,
			basket.accounting.explainedPixels.length,
			basket.accounting.unexplainedPixels.length
		]).toEqual([2145, 2145, 0]);
		const outer = m1.components.find(
			(component) => component.id === badge.componentUses[0]?.componentId
		);
		expect(outer?.consumers).toContainEqual({
			objectId: 'badge-0',
			objectKind: 'badge',
			role: 'outer-bright'
		});

		const output = resolve('artifacts/storybook-e/m1');
		mkdirSync(output, { recursive: true });
		const cases = [
			['badge-0', 'available'],
			['badge-0', 'components'],
			['badge-0', 'unexplained'],
			['basket-0', 'relationships'],
			[outer!.id, 'consumers']
		] as const;
		const hashes = Object.fromEntries(
			cases.map(([subject, projection]) => {
				const bytes = png(m1, subject, projection);
				writeFileSync(resolve(output, `${subject}-${projection}.png`), bytes);
				return [`${subject}:${projection}`, createHash('sha256').update(bytes).digest('hex')];
			})
		);
		writeFileSync(
			resolve(output, 'receipt.json'),
			`${JSON.stringify({ artifact: m1.artifact, hashes }, null, 2)}\n`
		);
		expect(hashes).toMatchSnapshot();
	}, 30_000);

	test('retained M1 identity sets mechanically distinguish preservation from discovery', async () => {
		const materialized = await materializeBadgeSpecimens();
		const badge = materialized.m1?.objects.find((object) => object.id === 'badge-0');
		if (!badge || badge.accounting.status !== 'known') return;
		const priorAvailable = new Set(badge.accounting.availablePixels);
		const priorExplained = new Set(badge.accounting.explainedPixels);
		const discoveredPixel = Math.max(...priorAvailable) + 1;
		const nextAvailable = new Set([...priorAvailable, discoveredPixel]);
		const nextExplained = new Set(priorExplained);
		const preserved = [...priorExplained].filter((pixel) => nextExplained.has(pixel));
		const lost = [...priorExplained].filter((pixel) => !nextExplained.has(pixel));
		const discovered = [...nextAvailable].filter((pixel) => !priorAvailable.has(pixel));
		const newlyExplained = discovered.filter((pixel) => nextExplained.has(pixel));
		const stillUnexplained = discovered.filter((pixel) => !nextExplained.has(pixel));
		expect({
			preserved: preserved.length,
			lost: lost.length,
			discovered: discovered.length,
			newlyExplained: newlyExplained.length,
			stillUnexplained: stillUnexplained.length
		}).toEqual({ preserved: 2096, lost: 0, discovered: 1, newlyExplained: 0, stillUnexplained: 1 });
	}, 30_000);
});
