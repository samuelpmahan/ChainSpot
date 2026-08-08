import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, test } from 'vitest';
import { estimateSimilarity } from '../../src/lib/alignment/similarity';
import { applyTransform } from '../../src/lib/alignment/transform';
import { deriveCorridorBand, deriveCorridorCenterline } from '../../src/lib/corridor';
import { findImageByRole } from '../../src/lib/domain/project';
import type { ProjectState } from '../../src/lib/domain/project';
import { pointInBounds } from '../../src/lib/coords';
import { readProjectBundle } from '../../src/lib/persistence';
import type { DecodeImageFile } from '../../src/lib/imageIntake';

const FIXTURE_PATH = resolve(process.cwd(), 'static/resources/hole-spike/one-hole.chainspot.zip');

interface FixtureDocument {
	schemaVersion: number;
	images: Array<{ fileName: string; widthPx: number; heightPx: number }>;
}

async function openRealFixture(): Promise<{
	document: FixtureDocument;
	state: ProjectState;
}> {
	const bytes = Uint8Array.from(await readFile(FIXTURE_PATH));
	const entries = unzipSync(bytes);
	const document = JSON.parse(strFromU8(entries['project.json'])) as FixtureDocument;
	const dimensions = new Map(document.images.map((image) => [image.fileName, image]));
	const decode: DecodeImageFile = async (file) => {
		const image = dimensions.get(file.name);
		if (!image) throw new Error(`Unexpected fixture image '${file.name}'.`);
		return {
			image: {} as HTMLImageElement,
			widthPx: image.widthPx,
			heightPx: image.heightPx
		};
	};
	const result = await readProjectBundle(
		new File([new Uint8Array(bytes)], 'one-hole.chainspot.zip', { type: 'application/zip' }),
		{ decode }
	);
	expect(result.ok).toBe(true);
	if (!result.ok) throw new Error('The real fixture did not open.');
	return { document, state: result.state };
}

describe('real hole-spike project fixture', () => {
	test('opens through the production bundle reader with the expected annotated hole', async () => {
		const { document, state } = await openRealFixture();
		const hole = state.holes[0];

		expect(document.schemaVersion).toBe(3);
		expect(state.images).toHaveLength(2);
		expect(findImageByRole(state.images, 'target-basemap')).toMatchObject({
			widthPx: 1320,
			heightPx: 2048
		});
		expect(state.controlPointPairs).toHaveLength(4);
		expect(state.controlPointPairs.every((pair) => pair.enabled && pair.target)).toBe(true);
		expect(state.holes).toHaveLength(1);
		expect(hole).toBeDefined();
		expect(hole.corridorBends).toHaveLength(1);
		expect(hole.corridorWidthPx).toBe(40);
		expect(hole.tee).toBeDefined();
		expect(hole.basket).toBeDefined();
		expect(hole.shots).toEqual([]);
	});

	test('aligns the real hole into finite, in-bounds target geometry', async () => {
		const { state } = await openRealFixture();
		const target = findImageByRole(state.images, 'target-basemap');
		const hole = state.holes[0];
		if (!target || !hole || !hole.tee || !hole.basket) throw new Error('Fixture is missing required geometry.');

		const alignment = estimateSimilarity({
			pairs: state.controlPointPairs.map((pair) => ({
				id: pair.id,
				enabled: pair.enabled,
				source: pair.source,
				target: pair.target
			}))
		});
		expect('transform' in alignment).toBe(true);
		if (!('transform' in alignment)) return;

		const sourceGeometry = [
			...deriveCorridorCenterline(hole),
			...hole.corridorBends,
			...hole.shots.map((shot) => shot.landing),
			...(deriveCorridorBand(hole) ?? [])
		];
		const targetGeometry = sourceGeometry.map((point) => applyTransform(point, alignment.transform));

		expect(targetGeometry.every((point) => Number.isFinite(point.xPx) && Number.isFinite(point.yPx))).toBe(true);
		expect(targetGeometry.every((point) => pointInBounds(point, target.widthPx, target.heightPx))).toBe(true);
	});
});
