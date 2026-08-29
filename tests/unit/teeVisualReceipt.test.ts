import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { PNG } from 'pngjs';
import { teeFamilyFeature } from '@chainspot/alg/detectors/threeFactor/features/g3.teeFamily';
import { TEE_RECOVERY_RENDER } from '@chainspot/alg/detectors/threeFactor/features/g3.teeReceipts';
import type {
	Drawable,
	RunTrace,
	UnitTrace
} from '@chainspot/alg/detectors/threeFactor/features/types';
import {
	renderRunEndpointReceipt,
	renderTraceFeatures
} from '../../scripts/chainspot-lab/sweep/featureRenders';

const corners = [
	[25, 20],
	[41, 32],
	[35, 40],
	[19, 28]
] as const;

function unit(
	id: string,
	gate: 'G1' | 'G2' | 'G3' | 'G4',
	featureId: string,
	drawables: Drawable[]
): UnitTrace {
	return {
		id,
		gate,
		featureId,
		featureIds: [featureId],
		enabled: true,
		knobs: {},
		knobsDeviating: [],
		ms: 1,
		drawables,
		measurements: []
	};
}

function fixtureTrace(): RunTrace {
	const visible = unit('teeFamily', 'G3', 'teeFamily', [
		{
			type: 'pixelSet',
			pixels: [
				[40, 20],
				[40, 21],
				[39, 21]
			],
			verdict: 'info',
			visualRole: 'tee-visible-pixels',
			ref: 'visible-tee',
			values: { componentLabel: 7, pixelCount: 3 }
		},
		{
			type: 'polyline',
			path: [...corners, corners[0]],
			verdict: 'accepted',
			visualRole: 'tee-border',
			ref: 'visible-tee',
			values: { orientedCenterX: 30, orientedCenterY: 30, frameAngleRad: Math.atan2(12, 16) }
		}
	]);
	const recovered = unit('teeRecovery', 'G4', 'teeRecovery', [
		{
			type: 'pixelSet',
			pixels: [
				[25, 20],
				[26, 21],
				[27, 22]
			],
			verdict: 'accepted',
			visualRole: 'tee-shard',
			ref: 'recovered-tee:tee-shard',
			values: { supportingComponents: 1 }
		},
		...corners.map(([xPx, yPx], index) => ({
			type: 'point' as const,
			xPx,
			yPx,
			verdict: 'info' as const,
			visualRole: 'tee-corner-tick' as const,
			ref: `recovered-tee:tee-corner-tick-${index}`,
			reason: 'detector-emitted recovery corner'
		}))
	]);
	return {
		configName: 'tee-visual-fixture',
		paramsHash: 'fixture-hash',
		execution: ['teeFamily', 'teeRecovery'],
		features: {
			teeFamily: { enabled: true, knobs: {} },
			teeRecovery: { enabled: true, knobs: {} }
		},
		units: [visible, recovered],
		heatmaps: {}
	};
}

function unifiedFixtureTrace(): RunTrace {
	const trace = fixtureTrace();
	const badges = unit('badges', 'G1', 'badges', [
		{
			type: 'pixelSet',
			pixels: [
				[5, 5],
				[6, 5],
				[6, 6]
			],
			verdict: 'info',
			visualRole: 'badge-pixels',
			ref: 'badge-1',
			reason: 'presentation-only exact bright-mask component pixels',
			values: { pixelCount: 3 }
		},
		{
			type: 'pixelSet',
			pixels: [[20, 20]],
			verdict: 'info',
			visualRole: 'badge-pixels',
			ref: 'orphan-badge',
			reason: 'presentation-only orphan badge pixels; no accepted badge owns this ref',
			values: { pixelCount: 1 }
		},
		{
			type: 'pixelSet',
			pixels: [],
			verdict: 'info',
			visualRole: 'badge-pixels',
			ref: 'empty-badge',
			reason: 'presentation-only empty badge pixel set',
			values: { pixelCount: 0 }
		},
		{
			type: 'pixelSet',
			pixels: [[21, 21]],
			verdict: 'info',
			visualRole: 'badge-pixels',
			reason: 'presentation-only badge pixels without an evidence ref',
			values: { pixelCount: 1 }
		},
		{
			type: 'box',
			bbox: [3, 3, 10, 10],
			verdict: 'accepted',
			ref: 'badge-1',
			values: { centerXPx: 8, centerYPx: 8, label: 1 }
		}
	]);
	const baskets = unit('baskets', 'G2', 'sprite', [
		{
			type: 'point',
			xPx: 52,
			yPx: 52,
			verdict: 'info',
			visualRole: 'basket-tip',
			ref: 'basket-1:semantic-tip'
		}
	]);
	const teeBadgeLock = {
		...unit('teeBadgeLock', 'G4', 'teeBadgeLock', [
			{
				type: 'polyline',
				path: [[60, 60], [56, 56]],
				verdict: 'accepted',
				visualRole: 'tee-badge-path',
				ref: 'teeBadgeLock:badge-1:tee-1',
				reason: 'exact producer-emitted routed testimony',
				values: { hole: 1, tierCode: 0, score: 1, weakAligned: 1, efficiency: 1, axisSourceCode: 1, pathPoints: 2 }
			},
			{
				type: 'polyline',
				path: [[2, 60], [5, 60]],
				verdict: 'rejected',
				visualRole: 'tee-badge-path',
				ref: 'teeBadgeLock:badge-1:tee-2',
				reason: 'candidate retained but not selected'
			}
		]),
		measurements: [
			{ name: 'candidates', count: 2, min: 2, max: 2, sum: 2 },
			{ name: 'locks', count: 1, min: 1, max: 1, sum: 1 },
			{ name: 'visibleLocks', count: 1, min: 1, max: 1, sum: 1 },
			{ name: 'recoveredLocks', count: 0, min: 0, max: 0, sum: 0 },
			{ name: 'unmatchedBadges', count: 0, min: 0, max: 0, sum: 0 },
			{ name: 'unusedTees', count: 0, min: 0, max: 0, sum: 0 }
		]
	};
	return {
		...trace,
		execution: ['badges', 'baskets', ...trace.execution, 'teeBadgeLock'],
		features: {
			...trace.features,
			badges: { enabled: true, knobs: {} },
			sprite: { enabled: true, knobs: {} },
			teeBadgeLock: { enabled: true, knobs: {} }
		},
		units: [badges, baskets, ...trace.units, teeBadgeLock]
	};
}

function rgb(png: PNG, x: number, y: number): readonly number[] {
	const index = (y * png.width + x) * 4;
	return [png.data[index], png.data[index + 1], png.data[index + 2]];
}

function setRgb(png: PNG, x: number, y: number, color: readonly [number, number, number]): void {
	const index = (y * png.width + x) * 4;
	png.data[index] = color[0];
	png.data[index + 1] = color[1];
	png.data[index + 2] = color[2];
	png.data[index + 3] = 255;
}

describe('canonical tee VisualRender', () => {
	test('visible and recovered poses share rotated corners and exact center diagonals', () => {
		const trace = fixtureTrace();
		const visiblePlan = teeFamilyFeature.render!.draw(trace.units[0], trace);
		const recoveryPlan = TEE_RECOVERY_RENDER.draw(trace.units[1], trace);
		for (const plan of [visiblePlan, recoveryPlan]) {
			const drawables = plan.layers.flatMap((layer) => layer.drawables);
			const ticks = drawables.filter((drawable) => drawable.visualRole === 'tee-corner-tick');
			const diagonals = drawables.filter((drawable) => drawable.visualRole === 'tee-diagonal');
			expect(ticks).toHaveLength(4);
			expect(diagonals).toHaveLength(2);
			expect(ticks[0].values?.teeAxisAngleRad).toBeCloseTo(Math.atan2(12, 16));
			expect(diagonals.map((drawable) => drawable.type === 'polyline' && drawable.path)).toEqual([
				[corners[0], corners[2]],
				[corners[1], corners[3]]
			]);
			expect(drawables.some((drawable) => drawable.visualRole === 'tee-center')).toBe(false);
		}
	});

	test('SVG and PNG use one-pixel red diagonals and pad-axis-aligned cyan plus signs', () => {
		const root = mkdtempSync(join(tmpdir(), 'tee-visual-'));
		try {
			const basePath = join(root, 'base.png');
			const base = new PNG({ width: 64, height: 64 });
			base.data.fill(0);
			writeFileSync(basePath, PNG.sync.write(base));
			const output = renderTraceFeatures({
				run: fixtureTrace(),
				outDir: join(root, 'renders'),
				canvas: { widthPx: 64, heightPx: 64, source: 'test canvas' },
				bases: [{ id: 'original', pngPath: basePath, source: 'test base' }]
			});
			for (const featureId of ['teeFamily', 'teeRecovery']) {
				const result = output.results.find((candidate) => candidate.featureId === featureId);
				const svgPath = result?.filesWritten.find((path) => path.endsWith('.svg'));
				const pngPath = result?.filesWritten.find((path) => path.endsWith('.png'));
				expect(svgPath).toBeTruthy();
				expect(pngPath).toBeTruthy();
				const svg = readFileSync(svgPath!, 'utf8');
				expect(svg.match(/data-visual-role="tee-diagonal"/g)).toHaveLength(2);
				expect(svg.match(/data-visual-role="tee-corner-tick"/g)).toHaveLength(4);
				expect(svg.match(/stroke="#ff2020" stroke-width="1"/g)).toHaveLength(2);
				expect(svg).not.toContain('data-visual-role="tee-center"');
				const png = PNG.sync.read(readFileSync(pngPath!));
				expect(rgb(png, 30, 30)).toEqual([255, 32, 32]);
				expect(rgb(png, 30, 31)).not.toEqual([255, 32, 32]);
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test('normal Sweep composes one minimal endpoint VisualRender receipt', () => {
		const root = mkdtempSync(join(tmpdir(), 'endpoint-visual-'));
		try {
			const basePath = join(root, 'base.png');
			const base = new PNG({ width: 64, height: 64 });
			base.data.fill(0);
			// The accepted badge component is deliberately sparse inside its
			// detector bbox [3,3,10,10]. A bright-looking pixel at the old
			// centroid lies inside that bbox but outside the component.
			for (const [x, y] of [
				[5, 5],
				[6, 5],
				[6, 6]
			] as const)
				setRgb(base, x, y, [255, 255, 255]);
			setRgb(base, 20, 20, [230, 230, 230]);
			setRgb(base, 21, 21, [225, 225, 225]);
			setRgb(base, 8, 8, [245, 245, 245]);
			setRgb(base, 7, 7, [0, 0, 0]);
			writeFileSync(basePath, PNG.sync.write(base));
			const output = renderRunEndpointReceipt({
				run: unifiedFixtureTrace(),
				outDir: join(root, 'renders'),
				canvas: { widthPx: 64, heightPx: 64, source: 'test canvas' },
				bases: [{ id: 'original', pngPath: basePath, source: 'test base' }]
			});

			expect(output.results).toHaveLength(1);
			const [result] = output.results;
			expect(result.featureId).toBe('endpointReceipt');
			expect(result.gate).toBe('G0-G4');
			expect(result.filesWritten.map((path) => path.slice(path.lastIndexOf('/') + 1))).toEqual([
				'run.visual.png',
				'run.visual.receipt.txt'
			]);
			expect(result.receiptText).toContain('badges: 1');
			expect(result.receiptText).toContain('badgeBrightPixelSets: 1');
			expect(result.receiptText).toContain('badgeBrightPixels: 3');
			expect(result.receiptText).toContain('basketSemanticTips: 1');
			expect(result.receiptText).toContain('visibleTeeBorders: 1');
			expect(result.receiptText).toContain('visibleTeePixelSets: 1');
			expect(result.receiptText).toContain('visibleTeePixels: 3');
			expect(result.receiptText).toContain('recoveredTeePoses: 1');
			expect(result.receiptText).toContain('teeBadgeLocks: 1');
			expect(result.receiptText).toContain('TEE→BADGE LOCK');
			expect(result.receiptText).toContain('blue: exact accepted tee→badge lock path');

			const png = PNG.sync.read(readFileSync(result.filesWritten[0]));
			for (const [x, y] of [
				[5, 5],
				[6, 5],
				[6, 6]
			] as const)
				expect(rgb(png, x, y)).toEqual([255, 225, 30]);
			// The badgeBrightPixels number in the receipt is the exact count of
			// pure-yellow pixels painted — no more (nothing else is yellow) and
			// no fewer (no later layer overwrote badge evidence here).
			let yellowPixels = 0;
			for (let y = 0; y < png.height; y++)
				for (let x = 0; x < png.width; x++)
					if (rgb(png, x, y).join(',') === '255,225,30') yellowPixels++;
			expect(result.receiptText).toContain(`badgeBrightPixels: ${yellowPixels} `);
			expect(result.warnings.length).toBeGreaterThanOrEqual(2);
			expect(result.warnings.join('\n')).toMatch(/orphan|unmatched|accepted badge/i);
			expect(result.warnings.join('\n')).toMatch(/empty|no exact|pixel set/i);
			// A bright-looking orphan pixel must not leak into the endpoint layer.
			expect(rgb(png, 20, 20)).toEqual([230, 230, 230]);
			// Evidence without an identity is likewise omitted rather than painted.
			expect(rgb(png, 21, 21)).toEqual([225, 225, 225]);
			// A bright-looking pixel inside the badge bbox but outside the
			// accepted component is evidence, not badge paint. This also proves
			// the old centroid mark at (8,8) is gone.
			expect(rgb(png, 8, 8)).toEqual([245, 245, 245]);
			// Black badge pixels remain untouched.
			expect(rgb(png, 7, 7)).toEqual([0, 0, 0]);
			expect(rgb(png, 52, 49)).toEqual([255, 40, 220]);
			expect(rgb(png, 40, 20)).toEqual([30, 255, 95]);
			// The old fitted border painted this base pixel green despite the
			// detector not owning it. Exact component testimony leaves it alone.
			expect(rgb(png, 33, 26)).toEqual([0, 0, 0]);
			expect(rgb(png, 30, 30)).toEqual([255, 32, 32]);
			expect(rgb(png, 60, 60)).toEqual([0, 162, 255]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test('BUG2/BUG3: NOT FOUND names the missing badge and TEE→BADGE LOCK reconciles against the shipped assignment', () => {
		const root = mkdtempSync(join(tmpdir(), 'endpoint-visual-reconcile-'));
		try {
			const basePath = join(root, 'base.png');
			const base = new PNG({ width: 64, height: 64 });
			base.data.fill(0);
			writeFileSync(basePath, PNG.sync.write(base));

			// The fixture's only badge (badge-1) never got a shipped row --
			// this is the exact "18 badges, 17 assignments" shape, minimized.
			const output = renderRunEndpointReceipt({
				run: unifiedFixtureTrace(),
				outDir: join(root, 'renders'),
				canvas: { widthPx: 64, heightPx: 64, source: 'test canvas' },
				bases: [{ id: 'original', pngPath: basePath, source: 'test base' }],
				assignmentRows: [],
				notFoundRows: [
					{ hole: '1', holeConfidence: 0.9, badgeId: 'badge-1', breadcrumb: 'no rejected-tee evidence for this badge is carried in this trace' }
				]
			});
			const [result] = output.results;
			expect(result.receiptText).toContain('NOT FOUND (badges with no shipped assignment)');
			expect(result.receiptText).toContain('H1 | badge-1 | no tee assigned -- no rejected-tee evidence');
			// teeBadgeLock's own lock for badge-1 (tee-1) has nothing to agree
			// with -- the reconciliation must say so plainly, never silently.
			expect(result.receiptText).toContain('TEE→BADGE LOCK RECONCILIATION');
			expect(result.receiptText).toContain('ALTERNATIVE HYPOTHESIS ONLY');
			expect(result.receiptText).toContain('H1 | badge-1 | tee-1 | (none) | DIFFERS: assignment has no shipped row for this badge');
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test('BUG3: an agreeing shipped assignment is marked "agrees"; a differing one names the shipped tee', () => {
		const root = mkdtempSync(join(tmpdir(), 'endpoint-visual-agree-'));
		try {
			const basePath = join(root, 'base.png');
			const base = new PNG({ width: 64, height: 64 });
			base.data.fill(0);
			writeFileSync(basePath, PNG.sync.write(base));
			const shippedRow = {
				badgeId: 'badge-1',
				teeId: 'tee-1',
				basketId: 'basket-1',
				score: 1,
				rank: 1,
				ownership: 'selected' as const,
				alternatives: [],
				hole: '1',
				holeConfidence: 0.9
			};
			const agreeing = renderRunEndpointReceipt({
				run: unifiedFixtureTrace(),
				outDir: join(root, 'renders', 'agree'),
				canvas: { widthPx: 64, heightPx: 64, source: 'test canvas' },
				bases: [{ id: 'original', pngPath: basePath, source: 'test base' }],
				assignmentRows: [shippedRow]
			});
			expect(agreeing.results[0].receiptText).toContain('H1 | badge-1 | tee-1 | tee-1 | agrees');

			const differing = renderRunEndpointReceipt({
				run: unifiedFixtureTrace(),
				outDir: join(root, 'renders', 'differ'),
				canvas: { widthPx: 64, heightPx: 64, source: 'test canvas' },
				bases: [{ id: 'original', pngPath: basePath, source: 'test base' }],
				assignmentRows: [{ ...shippedRow, teeId: 'tee-recovered-0' }]
			});
			expect(differing.results[0].receiptText).toContain(
				'H1 | badge-1 | tee-1 | tee-recovered-0 | DIFFERS: assignment says tee-recovered-0'
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test('a run without recovery or phantom units says NOT-SCHEDULED, never 0', () => {
		const root = mkdtempSync(join(tmpdir(), 'endpoint-visual-noscheduled-'));
		try {
			const basePath = join(root, 'base.png');
			const base = new PNG({ width: 64, height: 64 });
			base.data.fill(0);
			writeFileSync(basePath, PNG.sync.write(base));
			const full = unifiedFixtureTrace();
			const sliced: RunTrace = {
				...full,
				execution: full.execution.filter((id) => id !== 'teeRecovery'),
				units: full.units.filter((candidate) => candidate.id !== 'teeRecovery')
			};
			const output = renderRunEndpointReceipt({
				run: sliced,
				outDir: join(root, 'renders'),
				canvas: { widthPx: 64, heightPx: 64, source: 'test canvas' },
				bases: [{ id: 'original', pngPath: basePath, source: 'test base' }]
			});
			const [result] = output.results;
			// "Never ran" and "ran and found 0" are different receipt lines.
			expect(result.receiptText).toContain(
				"recoveredTeePoses: NOT-SCHEDULED (no 'teeRecovery' unit in this run; 'never ran' is not 0)"
			);
			expect(result.receiptText).toContain(
				"recoveredVisibleComponents: NOT-SCHEDULED (no 'teeRecovery' unit in this run)"
			);
			expect(result.receiptText).toContain(
				"phantomTeeCenters: NOT-SCHEDULED (no 'phantomTee' unit in this run; the feature is default-OFF)"
			);
			expect(result.receiptText).not.toMatch(/recoveredTeePoses: \d/);
			// The rejections block names the absent units instead of skipping them.
			expect(result.receiptText).toContain(
				"G4 teeRecovery: NOT-SCHEDULED (no trace unit exists in this run; 'never ran' is different from '0 rejections')"
			);
			expect(result.receiptText).toContain('G4 phantomTee: NOT-SCHEDULED');
			// Scheduled units keep truthful zero/positive counts.
			expect(result.receiptText).toContain('visibleTeeBorders: 1');
			expect(result.summary).toContain('recovery not-scheduled');
			// teeBadgeLock (G4) draws lock testimony in this fixture, so the truthful span is G0-G4 even with teeRecovery not-scheduled.
			expect(result.gate).toBe('G0-G4');
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
