import { describe, expect, test } from 'vitest';
import {
	CHAIN_OF_CUSTODY_SCHEMA,
	buildChainOfCustody,
	findTeeCustody,
	type TeeEvidence,
	type ThreeFactorAssignment,
	type ThreeFactorMeasurement
} from '@chainspot/alg/detectors/threeFactor';
import type {
	RunTrace,
	UnitTrace
} from '@chainspot/alg/detectors/threeFactor/features/types';

function traceUnit(
	id: string,
	gate: UnitTrace['gate'],
	featureIds: readonly string[],
	drawables: UnitTrace['drawables'],
	enabled = true
): UnitTrace {
	return {
		id,
		gate,
		featureId: featureIds[0],
		featureIds,
		enabled,
		knobs: {},
		knobsDeviating: [],
		ms: 0,
		drawables: [...drawables],
		measurements: []
	};
}

function runTrace(units: readonly UnitTrace[]): RunTrace {
	return {
		configName: 'custody-test',
		paramsHash: 'params-hash',
		runId: 'run-id',
		imageId: 'image-id',
		traceHash: 'trace-hash',
		execution: units.map((unit) => unit.id),
		features: {},
		units: [...units],
		heatmaps: {}
	};
}

function assignmentFor(
	tees: readonly TeeEvidence[],
	rows: ThreeFactorAssignment['assignments'],
	badges: readonly { detId: string; label: string | null }[]
): ThreeFactorAssignment {
	const measurement = {
		badges
	} as unknown as ThreeFactorMeasurement;
	return {
		measurement,
		tees,
		scoredPairs: [],
		assignments: rows
	};
}

const visibleTee: TeeEvidence = {
	detId: 'tee-7',
	xPx: 101.5,
	yPx: 202.5,
	tier: 'ring',
	angleRad: 0.25,
	ring: {
		bbox: [96, 198, 12, 9],
		area: 42,
		elongation: 1.4,
		ringFrac: 0.78
	},
	bbox: [94, 196, 18, 13],
	pad: {
		source: 'bright-mask-component',
		componentLabel: 42,
		bbox: [94, 196, 18, 13],
		componentCentroidXPx: 102,
		componentCentroidYPx: 203,
		centerXPx: 102.5,
		centerYPx: 203.5,
		angleRad: 0.24,
		majorPx: 19,
		minorPx: 12,
		area: 91,
		fill: 0.72,
		axisMajorMin: -9,
		axisMajorMax: 9,
		axisMinorMin: -5.5,
		axisMinorMax: 5.5,
		orientedCorners: [
			[94, 196],
			[112, 196],
			[112, 209],
			[94, 209]
		],
		minAreaPose: {
			centerXPx: 102.25,
			centerYPx: 203.25,
			angleRad: 0.23,
			majorPx: 18.5,
			minorPx: 11.5,
			orientedCorners: [
				[94.1, 196.2],
				[111.9, 196.1],
				[112.1, 209.0],
				[94.0, 209.1]
			]
		}
	},
	area: 42,
	fill: 0.72,
	onRing: false
};

const recoveredTee: TeeEvidence = {
	detId: 'tee-recovered-0',
	xPx: 55,
	yPx: 88,
	tier: 'recovered',
	angleRad: null,
	bbox: [49, 83, 12, 10],
	area: 9,
	fill: 0.4,
	onRing: false,
	recovery: {
		source: 'tee-shard-recovery',
		note: 'teeRecovery support fit recover-H12-shard-3: every non-occluded visible component pixel contributes; discovery seed component-77',
		score: 0.81
	}
};

describe('tee chain of custody', () => {
	test('maps an opaque assigned tee id back through visible evidence and exact assignment', () => {
		const assignment = assignmentFor(
			[visibleTee],
			[
				{
					badgeId: 'badge-7',
					teeId: 'tee-7',
					basketId: 'basket-7',
					score: 0.93,
					rank: 1,
					ownership: 'selected',
					alternatives: [{ teeId: 'tee-8', basketId: 'basket-7', score: 0.44 }]
				}
			],
			[{ detId: 'badge-7', label: '7' }]
		);
		const trace = runTrace([
			traceUnit('tees', 'G3', ['endpoints'], [
				{
					type: 'point',
					xPx: 101.5,
					yPx: 202.5,
					verdict: 'accepted',
					ref: 'tee-7',
					reason: 'ring candidate survived exclusion'
				},
				{
					type: 'point',
					xPx: 1,
					yPx: 1,
					verdict: 'info',
					ref: 'tee-70',
					reason: 'must not prefix-match tee-7'
				}
			]),
			traceUnit('teeFamily', 'G3', ['teeFamily'], [
				{
					type: 'polyline',
					path: visibleTee.pad!.orientedCorners,
					verdict: 'accepted',
					visualRole: 'tee-border',
					ref: 'tee-7',
					reason: 'accepted intact visible tee family',
					values: { componentLabel: 42 }
				}
			]),
			traceUnit('teeMinAreaPose', 'G3', ['teeMinAreaPose'], [
				{
					type: 'pixelSet',
					pixels: [[101, 202]],
					verdict: 'accepted',
					visualRole: 'tee-visible-pixels',
					metadata: { targetRef: 'tee-7', targetComponent: '42' }
				}
			]),
			traceUnit('assignment', 'G6', ['search'], [])
		]);

		const ledger = buildChainOfCustody(assignment, trace);
		const record = findTeeCustody(ledger, 'tee-7');

		expect(ledger).toMatchObject({
			schema: CHAIN_OF_CUSTODY_SCHEMA,
			runId: 'run-id',
			imageId: 'image-id',
			traceHash: 'trace-hash',
			traceAvailable: true
		});
		expect(record?.originKind).toBe('visible-ring');
		expect(record?.summary).toContain('brightComponent=42');
		expect(record?.evidenceRefs).toContain('bright-component:42');
		expect(record?.gaps).toEqual([]);
		expect(record?.events.filter((event) => event.kind === 'trace')).toHaveLength(3);
		expect(record?.events.some((event) => event.kind === 'trace' && event.ref === 'tee-70')).toBe(false);
		expect(record?.events.at(-1)).toMatchObject({
			kind: 'assignment',
			producerUnit: 'assignment',
			hole: '7',
			badgeId: 'badge-7',
			basketId: 'basket-7',
			score: 0.93,
			rank: 1
		});
	});

	test('correlates recovered tee trace testimony but exposes the prose-only identity gap', () => {
		const assignment = assignmentFor(
			[recoveredTee],
			[
				{
					badgeId: 'badge-12',
					teeId: 'tee-recovered-0',
					basketId: 'basket-12',
					score: 0.61,
					rank: 2,
					ownership: 'selected',
					alternatives: []
				}
			],
			[{ detId: 'badge-12', label: '12' }]
		);
		const trace = runTrace([
			traceUnit('teeRecovery', 'G4', ['teeRecovery'], [
				{
					type: 'pixelSet',
					pixels: [[55, 88]],
					verdict: 'accepted',
					visualRole: 'tee-shard',
					ref: 'recover-H12-shard-3',
					reason: 'accepted shard'
				},
				{
					type: 'point',
					xPx: 49,
					yPx: 83,
					verdict: 'info',
					visualRole: 'tee-corner-tick',
					ref: 'recover-H12-shard-3:tee-corner-tick-0',
					reason: 'calculated tee recovery corner'
				}
			]),
			traceUnit('assignment', 'G6', ['search'], [])
		]);

		const record = findTeeCustody(buildChainOfCustody(assignment, trace), 'tee-recovered-0');

		expect(record?.originKind).toBe('recovered');
		expect(record?.summary).toContain('recoveryResult=recover-H12-shard-3');
		expect(record?.evidenceRefs).toContain('tee-recovery-result:recover-H12-shard-3');
		expect(record?.events.filter((event) => event.kind === 'trace')).toHaveLength(2);
		expect(record?.gaps.join('\n')).toContain('RecoveryProvenance.note');
		expect(record?.events.at(-1)).toMatchObject({
			kind: 'assignment',
			hole: '12',
			badgeId: 'badge-12'
		});
	});

	test('calls forgotten component identity UNKNOWN instead of inventing lineage', () => {
		const componentTee: TeeEvidence = {
			detId: 'tee-2',
			xPx: 20,
			yPx: 30,
			tier: 'component',
			angleRad: 0.1,
			bbox: [16, 27, 9, 7],
			area: 33,
			fill: 0.7,
			onRing: false
		};
		const record = findTeeCustody(
			buildChainOfCustody(assignmentFor([componentTee], [], [])),
			'tee-2'
		);

		expect(record?.summary).toContain('sourceComponent=UNKNOWN');
		expect(record?.gaps).toHaveLength(1);
		expect(record?.gaps[0]).toContain('source bright-component label');
	});
});
