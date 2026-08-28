import { describe, expect, test } from 'vitest';
import {
	compileABFeatureSet,
	compileExecutionPlan,
	createExecBoard,
	executeABFeatureSet,
	executeCompiledPlan
} from '@chainspot/alg/exec';
import {
	DEFAULT_EXECUTION,
	GATE_FEATURE_SETS,
	resolveConfig,
	type ThreeFactorConfig
} from '@chainspot/alg/detectors/threeFactor';
import { createTraceContext } from '@chainspot/alg/detectors/threeFactor/engine';
import { createBoard, seedBoard } from '@chainspot/alg/detectors/threeFactor/measure';
import {
	teeMinAreaPoseFeature,
	teeMinAreaPoseUnit
} from '@chainspot/alg/detectors/threeFactor/features/g3.teeMinAreaPose';
import { teeMinAreaPoseRender } from '@chainspot/alg/detectors/threeFactor/features/g3.teeMinAreaPoseReceipt';
import {
	nullFeatureContext,
	type Drawable,
	type EvidenceBoard,
	type FeatureContext
} from '@chainspot/alg/detectors/threeFactor/features/types';
import type { RgbaImage, TeeEvidence } from '@chainspot/alg/detectors/threeFactor/types';
import defaultConfig from '@chainspot/alg/detectors/threeFactor/configs/default.json';
import glyphOnConfig from '@chainspot/alg/detectors/threeFactor/configs/tee-min-area-pose-on.json';

function featureContext(drawables: Drawable[]): FeatureContext {
	return {
		...nullFeatureContext,
		resolve(feature) {
			if (feature.id === 'teeMinAreaPose') {
				return {
					enabled: true,
					knobs: {}
				};
			}
			return nullFeatureContext.resolve(feature);
		},
		overlay(_unit, drawable) {
			drawables.push(drawable);
		}
	};
}

const glyphOffsets = [
	[-2, -2],
	[-1, -2],
	[0, -2],
	[1, -2],
	[2, -2],
	[-2, -1],
	[2, -1],
	[-2, 0],
	[2, 0],
	[-2, 1],
	[2, 1],
	[-2, 2],
	[-1, 2],
	[0, 2],
	[1, 2],
	[2, 2]
] as const;

function teeFixture(
	detId: string,
	componentLabel: number,
	xPx: number
): {
	readonly tee: TeeEvidence;
	readonly pixels: readonly (readonly [number, number])[];
} {
	const yPx = 12;
	const pixels = glyphOffsets.map(([x, y]) => [xPx + x, yPx + y] as const);
	return {
		pixels,
		tee: {
			detId,
			xPx,
			yPx,
			tier: 'ring',
			angleRad: 0,
			ring: { bbox: [xPx - 3, yPx - 2, 6, 4], area: 24, elongation: 2, ringFrac: 1 },
			bbox: [xPx - 2, yPx - 2, 5, 5],
			area: pixels.length,
			fill: 1,
			onRing: false,
			pad: {
				source: 'bright-mask-component',
				componentLabel,
				bbox: [xPx - 2, yPx - 2, 5, 5],
				componentCentroidXPx: xPx,
				componentCentroidYPx: yPx,
				centerXPx: xPx,
				centerYPx: yPx,
				angleRad: 0.4,
				majorPx: 5,
				minorPx: 5,
				area: pixels.length,
				fill: 1,
				axisMajorMin: -2,
				axisMajorMax: 2,
				axisMinorMin: -2,
				axisMinorMax: 2,
				orientedCorners: [
					[xPx - 2, yPx - 2],
					[xPx + 2, yPx - 2],
					[xPx + 2, yPx + 2],
					[xPx - 2, yPx + 2]
				]
			}
		}
	};
}

function glyphFixture(): {
	readonly stage: {
		readonly width: number;
		readonly height: number;
		readonly brightLabels: Int32Array;
	};
	readonly tees: readonly TeeEvidence[];
} {
	const width = 72;
	const height = 32;
	const labels = new Int32Array(width * height);
	const rows = [
		teeFixture('tee-a', 7, 12),
		teeFixture('tee-b', 8, 34),
		teeFixture('tee-target', 9, 56)
	];
	for (const { tee, pixels } of rows) {
		for (const [x, y] of pixels) labels[y * width + x] = tee.pad!.componentLabel;
	}
	return { stage: { width, height, brightLabels: labels }, tees: rows.map((row) => row.tee) };
}

describe('teeMinAreaPose ABFeature', () => {
	test('is public, default-OFF, and owns the G3 production operation', () => {
		expect(teeMinAreaPoseFeature).toMatchObject({
			id: 'teeMinAreaPose',
			gate: 'G3',
			kind: 'deviation',
			defaultEnabled: false,
			resolveOnlyWhenConfigured: true
		});
		expect(GATE_FEATURE_SETS['g3-set'].features.map((feature) => feature.id)).toContain(
			teeMinAreaPoseFeature.id
		);
	});

	test('fits visible exact components only and emits four producer corners plus two thin diagonals per accepted tee', () => {
		const { stage, tees } = glyphFixture();
		const board = createBoard();
		board.set('stage', stage);
		board.set('viewport', { topPx: 0 });
		board.set('tees', tees);
		const drawables: Drawable[] = [];
		teeMinAreaPoseUnit.run(board, featureContext(drawables));
		const refined = board.get<readonly TeeEvidence[]>('tees');
		expect(refined).toHaveLength(3);
		for (const tee of refined) {
			expect(tee.pad?.minAreaPose).toMatchObject({
				centerXPx: tee.xPx,
				centerYPx: tee.yPx,
				angleRad: 0
			});
			expect(tee.pad?.minAreaPose?.orientedCorners).toHaveLength(4);
		}
		expect(
			drawables.filter(
				(drawable) => drawable.type === 'pixelSet' && drawable.verdict === 'accepted'
			)
		).toHaveLength(3);
		expect(drawables.filter((drawable) => drawable.visualRole === 'tee-corner-tick')).toHaveLength(
			12
		);
		expect(drawables.filter((drawable) => drawable.visualRole === 'tee-diagonal')).toHaveLength(6);
		expect(drawables.some((drawable) => drawable.visualRole === 'tee-border')).toBe(false);
		const target = drawables.find(
			(drawable) => drawable.type === 'pixelSet' && drawable.verdict === 'accepted'
		);
		expect(target?.metadata).toMatchObject({
			coordinateFrame: 'G0 canonical detector-input pixels',
			currentInput: 'unit-square envelope of exact detector-owned component cells',
			opencvParity: expect.stringMatching(/not literal/)
		});
		expect(target?.values).not.toHaveProperty('coarseRingAngleDeg');
		expect(target?.values).not.toHaveProperty('angleDeltaFromCoarseDeg');
		expect(target?.values).toMatchObject({
			producerCornerC0X: expect.any(Number),
			producerCornerC3Y: expect.any(Number)
		});
		expect(
			drawables.filter((drawable) => drawable.visualRole === 'tee-corner-tick').map(
				(drawable) => drawable.metadata?.producerCorner
			)
		).toEqual(['C0', 'C1', 'C2', 'C3', 'C0', 'C1', 'C2', 'C3', 'C0', 'C1', 'C2', 'C3']);
	});

	test('compiles and executes the declared G3 set through the production gateway with declared and actual custody', async () => {
		const defaultResolved = resolveConfig(defaultConfig as ThreeFactorConfig, DEFAULT_EXECUTION);
		const onResolved = resolveConfig(glyphOnConfig as ThreeFactorConfig, DEFAULT_EXECUTION);
		const compiled = compileABFeatureSet(GATE_FEATURE_SETS['g3-set'], {
			teeMinAreaPose: { enabled: true }
		});
		const glyphOperation = compiled.plan.ops.find(
			(operation) => operation.id === 'teeMinAreaPose'
		);
		expect(glyphOperation).toMatchObject({
			gate: 'G3',
			unit: 'teeMinAreaPose',
			consumes: ['stage', 'tees', 'viewport'],
			produces: ['tees'],
			features: ['teeMinAreaPose']
		});
		const image: RgbaImage = {
			width: 32,
			height: 32,
			data: new Uint8ClampedArray(32 * 32 * 4).fill(128)
		};
		for (let index = 3; index < image.data.length; index += 4) image.data[index] = 255;
		const board = createExecBoard();
		seedBoard(board as unknown as EvidenceBoard, image, undefined);
		board.set('recoveredTees', []);
		const defaultPlan = compileExecutionPlan(defaultResolved);
		const { ctx } = createTraceContext(onResolved, 'tee-min-area-pose-gateway', defaultPlan.ops);
		executeCompiledPlan(defaultPlan, board, ctx);
		const receipt = await executeABFeatureSet(compiled, board, ctx, {
			runId: 'tee-min-area-pose-gateway',
			invocation: 'teeMinAreaPoseFeature.test'
		});
		const operation = receipt.operations.find((entry) => entry.opId === 'teeMinAreaPose');
		expect(operation?.declaredConsumes).toEqual(['stage', 'tees', 'viewport']);
		expect(operation?.declaredProduces).toEqual(['tees']);
		expect(operation?.actualConsumes).toEqual(
			expect.arrayContaining(['stage', 'tees', 'viewport'])
		);
		expect(operation?.actualProduces).toEqual(expect.arrayContaining(['tees']));
	});

	test('uses the same trace objects for CLI and visual layers, with the restricted green/cyan/red palette intent', () => {
		const { stage, tees } = glyphFixture();
		const resolved = resolveConfig(glyphOnConfig as ThreeFactorConfig, DEFAULT_EXECUTION);
		const { ctx, trace } = createTraceContext(resolved, 'glyph-receipt', [], {
			runId: 'glyph-receipt',
			imageId: 'synthetic-glyph',
			traceHash: 'trace-glyph',
			canonicalFrame: 'G0 canonical detector-input pixels'
		});
		const board = createBoard();
		board.set('stage', stage);
		board.set('viewport', { topPx: 0 });
		board.set('tees', tees);
		teeMinAreaPoseUnit.run(board, ctx);
		const unit = trace.units.find((candidate) => candidate.id === 'teeMinAreaPose');
		expect(unit).toBeDefined();
		const plan = teeMinAreaPoseRender.draw(unit!, trace);
		expect(plan.layers.map((layer) => layer.drawables.length)).toEqual([3, 12, 6, 0]);
		expect(plan.notes.join('\n')).toMatch(
			/exact green cells, cyan corners, and one-pixel red diagonals/
		);
		expect(plan.notes.join('\n')).toMatch(/no yellow\/orange/);
	});
});
