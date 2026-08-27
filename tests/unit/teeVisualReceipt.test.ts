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
import { renderTraceFeatures } from '../../scripts/chainspot-lab/sweep/featureRenders';

const corners = [
	[25, 20],
	[41, 32],
	[35, 40],
	[19, 28]
] as const;

function unit(id: string, gate: 'G3' | 'G4', featureId: string, drawables: Drawable[]): UnitTrace {
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

function rgb(png: PNG, x: number, y: number): readonly number[] {
	const index = (y * png.width + x) * 4;
	return [png.data[index], png.data[index + 1], png.data[index + 2]];
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
});
