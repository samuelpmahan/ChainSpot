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
	return {
		...trace,
		execution: ['badges', 'baskets', ...trace.execution],
		features: {
			...trace.features,
			badges: { enabled: true, knobs: {} },
			sprite: { enabled: true, knobs: {} }
		},
		units: [badges, baskets, ...trace.units]
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
			expect(result.receiptText).toContain('recoveredTeePoses: 1');

			const png = PNG.sync.read(readFileSync(result.filesWritten[0]));
			for (const [x, y] of [
				[5, 5],
				[6, 5],
				[6, 6]
			] as const)
				expect(rgb(png, x, y)).toEqual([255, 225, 30]);
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
			expect(rgb(png, 33, 26)).toEqual([30, 255, 95]);
			expect(rgb(png, 30, 30)).toEqual([255, 32, 32]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
