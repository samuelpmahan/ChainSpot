import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PNG } from 'pngjs';
import { describe, expect, test } from 'vitest';
import { materializeBadgeSpecimens } from '../../.storybook/storybookBadgeSource.mjs';
import {
	BADGE_STORY_PROJECTIONS,
	assertBadgeConservation,
	projectBadge,
	projectBadgeImage
} from '../../src/lib/evidence-workbench/badgeProjection';
import type { BadgeSpecimen } from '../../src/lib/evidence-workbench/badgeSpecimen';

const specimen: BadgeSpecimen = {
	id: 'badge-test',
	title: 'badge-test',
	course: 'fixture',
	detectorId: 'badge-test',
	holeLabel: '1',
	sourceSha256: 'fixture',
	crop: { x: 10, y: 20, width: 2, height: 2 },
	sourceRgba: [10, 20, 30, 255, 40, 50, 60, 255, 70, 80, 90, 255, 100, 110, 120, 255],
	brightMask: [1, 0, 0, 0],
	darkMask: [0, 1, 0, 0],
	ownedMask: [1, 1, 0, 0],
	aaMask: [0, 0, 1, 0],
	residueBeforeMask: [0, 0, 1, 1],
	residueAfterMask: [0, 0, 0, 1],
	metrics: { ownedBw: 2, aaAdded: 1, residueBefore: 2, residueAfter: 1 },
	provenance: ['fixture']
};

const PINNED_RECOMPUTATION_BACKEND_HASHES = {
	raw: '3f31a2de26cd58035763ee5a3c5cf566dbf0d6cd98bd37a1baa7ceae7b96854e',
	bw: 'ca4ac0ff3221da59e95f6a4a901ecefd4e7b95199b6b4152cf3fba2ac3390ec5',
	ownership: 'daf6bce07aaa19f84132cd40e187852c5d7985e3b68986a0adbe8a667f405f86',
	aa: '6212e45560890c58b8eda61b53242ec2822e18f6392694d22fc086e7a3b2d375',
	'residue-before': '9c90ecc4acca5bc1c162d4a2c20608a057b9dd87b2b303e974c05e445bbef6d1',
	'residue-after': '470fa5078e27d4582088897d3fdfa454b5a6df91114147d971cf3ba04be909d4',
	composed: 'c4a2852671d317375d5e93d17c18e297844a7f3733d4f64a0a50e3ebd84373ff'
};

function encodePng(value: BadgeSpecimen, projection: (typeof BADGE_STORY_PROJECTIONS)[number]) {
	const image = projectBadgeImage(value, projection);
	return PNG.sync.write({
		width: image.width,
		height: image.height,
		data: Buffer.from(image.rgba)
	});
}

function writeStoryImages(value: BadgeSpecimen, output: string) {
	mkdirSync(output, { recursive: true });
	return Object.fromEntries(
		BADGE_STORY_PROJECTIONS.map((projection) => {
			const png = encodePng(value, projection);
			writeFileSync(resolve(output, `${projection}.png`), png);
			const decoded = PNG.sync.read(png);
			expect(decoded.width).toBe(value.crop.width);
			expect(decoded.height).toBe(value.crop.height);
			expect([...decoded.data]).toEqual([...projectBadge(value, projection)]);
			return [projection, createHash('sha256').update(png).digest('hex')];
		})
	);
}

describe('E-backed badge projections', () => {
	test('conserves owned + AA + residue without overlap', () => {
		expect(() => assertBadgeConservation(specimen)).not.toThrow();
	});

	test('keeps raw evidence byte-identical and makes AA an additive view', () => {
		expect([...projectBadge(specimen, 'raw')]).toEqual(specimen.sourceRgba);
		const ownership = projectBadge(specimen, 'ownership');
		const composed = projectBadge(specimen, 'composed');
		expect([...composed.slice(0, 8)]).toEqual([...ownership.slice(0, 8)]);
		expect([...composed.slice(8, 12)]).not.toEqual([...ownership.slice(8, 12)]);
	});

	test('generates deterministic PNG receipts for every registered Story projection', () => {
		const output = resolve('artifacts/storybook-e/images/badge-test');
		const hashes = writeStoryImages(specimen, output);
		expect(hashes).toMatchInlineSnapshot(`
			{
			  "aa": "e97743acd77b0b707fde616342df7491877722e5003734e06b276ed9485ab853",
			  "bw": "1764e8f4561eb599336bb22620040e7d214894dd8673d687e108580fac726126",
			  "composed": "5d66e1421200ae3230f8b1003e9847d64ab3d3918490fc4c358ce75e16bc6edc",
			  "ownership": "c383d29d4b474e1da6c04bd7bf4d5dfd8739eae8a0697dd6c0f05753263ed4a7",
			  "raw": "bd1c049293e624ce6cfcd1155e7f6505ae0234a63065b7615ec75c03e24377aa",
			  "residue-after": "dea1a489c904f92480293b415a98da4ee8e6de1bad560361ba9cf705339ac700",
			  "residue-before": "53ea39aff390b3f5d224aad94cd2a2b3f4f2f1d5861866f722c46ae26cfd6617",
			}
		`);
	});

	test('generates the real pinned badge Story images when materialized evidence is available', async () => {
		const library = await materializeBadgeSpecimens();
		if (library.status === 'unavailable') {
			expect(library.note).toContain('Real E materialization unavailable');
			return;
		}
		const pinned = library.specimens.find((candidate) => candidate.id === 'badge-0');
		expect(pinned, 'badge-0 must exist in the real library').toBeDefined();
		if (!pinned) return;
		expect(pinned.metrics).toEqual({
			ownedBw: 2096,
			aaAdded: 278,
			residueBefore: 368,
			residueAfter: 90
		});
		assertBadgeConservation(pinned);
		const hashes = writeStoryImages(pinned, resolve('artifacts/storybook-e/images/badge-0'));
		writeFileSync(
			resolve('artifacts/storybook-e/images/badge-0/receipt.json'),
			`${JSON.stringify({ specimen: pinned.id, metrics: pinned.metrics, hashes }, null, 2)}\n`
		);
		expect(hashes).toEqual(PINNED_RECOMPUTATION_BACKEND_HASHES);
	}, 30_000);
});
