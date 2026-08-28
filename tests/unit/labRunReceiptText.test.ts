import { describe, expect, test } from 'vitest';
import type { RunReceipt } from '../../scripts/chainspot-lab/sweep/runReceipt';
import { formatRunReceiptText } from '../../scripts/chainspot-lab/sweep/runReceiptText';

const receipt: RunReceipt = {
	schema: 'chainspot-lab-run-receipt@1',
	generatedAt: '2026-08-27T00:00:00.000Z',
	revision: 'rev-test',
	config: {
		name: 'fixture',
		path: '/configs/fixture.json',
		paramsHash: 'params-hash',
		planFingerprint: 'plan-fingerprint',
		throughGate: 'G2',
		enabledFeatures: ['alpha'],
		deviatingFeatures: ['beta']
	},
	intake: {
		sources: ['/input/source.png'],
		sourceImageIds: ['source-id'],
		canonicalImageId: 'canonical-id',
		widthPx: 640,
		heightPx: 480,
		sourceByteLength: 1234,
		stripChrome: { source: 'none', insets: null },
		autoStitch: { sourceCount: 1, hadFallback: false, placements: [{ x: 0, y: 0 }] },
		ledger: {} as RunReceipt['intake']['ledger'],
		truthMatch: null
	},
	timings: {
		configMs: 1,
		intakeMs: 2,
		canonicalWriteMs: 3,
		gatewayMs: 4,
		operationBodyMs: 10,
		artifactPersistenceMs: 5,
		artifactRenderMs: 6,
		truthEvaluationMs: 7,
		featureRenderMs: 8,
		observedTotalMs: 46
	},
	operations: [
		{
			index: 2,
			id: 'second',
			gate: 'G2',
			gateTitle: 'Baskets',
			kind: 'compute',
			unit: 'baskets',
			durationMs: 7,
			percentOfOperationBody: 70,
			conformance: { ok: false, missingConsumes: ['input'], missingProduces: [] },
			probes: [{ name: 'count', value: 2 }],
			artifacts: [{ id: 'a2', kind: 'measurementTable', sha256: 'hash2', uri: 'artifact://second' }]
		},
		{
			index: 1,
			id: 'first',
			gate: 'G1',
			gateTitle: 'Badges',
			kind: 'compute',
			unit: 'badges',
			durationMs: 3,
			percentOfOperationBody: 30,
			conformance: { ok: true, missingConsumes: [], missingProduces: [] },
			probes: [],
			artifacts: [{ id: 'a1', kind: 'measurementTable', sha256: 'hash1', uri: 'artifact://first' }]
		}
	],
	gates: [
		{
			gate: 'G2',
			title: 'Baskets',
			status: 'ran',
			operationIndexes: [2],
			durationMs: 7,
			percentOfOperationBody: 70
		},
		{
			gate: 'G1',
			title: 'Badges',
			status: 'ran',
			operationIndexes: [1],
			durationMs: 3,
			percentOfOperationBody: 30
		},
		{
			gate: 'G7',
			title: 'Bend Refinement',
			status: 'not-scheduled',
			operationIndexes: [],
			durationMs: 0,
			percentOfOperationBody: 0
		}
	],
	units: [
		{
			id: 'baskets',
			gate: 'G2',
			durationMs: 7,
			accepted: 1,
			rejected: 1,
			info: 1,
			measurements: [{ name: 'score', count: 2, min: 0.25, max: 0.75, sum: 1, mean: 0.5 }],
			rejectionReasons: [{ reason: 'below-threshold', count: 1 }]
		}
	],
	results: { badges: 1, baskets: 1 },
	visualRenders: [
		{
			kind: 'canonical',
			gate: 'G0',
			id: 'g0.canonical',
			owner: 'StripChrome + AutoStitch',
			status: 'rendered',
			summary: 'exact canonical raster',
			files: ['renders/input/g0.canonical.png']
		},
		{
			kind: 'feature',
			gate: 'G3',
			id: 'teeFamily.teeFamily',
			owner: 'teeFamily@teeFamily',
			status: 'rendered',
			summary: 'visible tee pose evidence',
			files: [
				'renders/features/feature.teeFamily.teeFamily.svg',
				'renders/features/feature.teeFamily.teeFamily.png'
			]
		}
	],
	evaluation: { truthSupplied: false, skipped: true, reason: 'no truth' },
	warnings: ['first warning', 'second warning']
};

describe('formatRunReceiptText', () => {
	test('renders a deterministic exact fixture report', () => {
		const text = formatRunReceiptText(receipt);
		expect(text).toBe(`RUN RECEIPT
schema: chainspot-lab-run-receipt@1
generatedAt: 2026-08-27T00:00:00.000Z
revision: rev-test

IDENTITY / CONFIG / INTAKE
config.name: fixture
config.path: /configs/fixture.json
config.paramsHash: params-hash
config.planFingerprint: plan-fingerprint
config.throughGate: G2
config.enabledFeatures: [alpha]
config.deviatingFeatures: [beta]
intake.sources: [/input/source.png]
intake.sourceImageIds: [source-id]
intake.canonicalImageId: canonical-id
intake.widthPx: 640
intake.heightPx: 480
intake.sourceByteLength: 1234
intake.stripChrome.source: none
intake.stripChrome.insets: UNKNOWN
intake.autoStitch.sourceCount: 1
intake.autoStitch.hadFallback: false
intake.autoStitch.placements: [{"x":0,"y":0}]
intake.ledger: {}
intake.truthMatch: UNKNOWN

TIMING BREAKDOWN
timings.configMs: 1
timings.intakeMs: 2
timings.canonicalWriteMs: 3
timings.gatewayMs: 4
timings.operationBodyMs: 10
timings.artifactPersistenceMs: 5
timings.artifactRenderMs: 6
timings.truthEvaluationMs: 7
timings.featureRenderMs: 8
timings.observedTotalMs: 46

OPERATIONS (CHRONOLOGICAL)
index | gate | id | durationMs | percentOfOperationBody | conformance | probes
2 | G2 | second | 7 | 70 | DRIFT missingConsumes=[input] missingProduces=[] | count=2
1 | G1 | first | 3 | 30 | OK | []

CANONICAL GATE ROLLUPS
gate | title | status | operationIndexes | durationMs | percentOfOperationBody
G2 | Baskets | ran | [2] | 7 | 70
G1 | Badges | ran | [1] | 3 | 30
G7 | Bend Refinement | not-scheduled | [] | 0 | 0

UNIT RESULTS
unit baskets gate=G2 durationMs=7 accepted=1 rejected=1 info=1
  measurement score: n=2 min=0.25 max=0.75 mean=0.5
  rejectionReason below-threshold: 1

FINAL RESULTS
results.badges: 1
results.baskets: 1
results.visibleTees: UNKNOWN
results.recoveredTees: UNKNOWN
results.phantomTees: UNKNOWN
results.totalTees: UNKNOWN
results.assignments: UNKNOWN
results.rawPairs: UNKNOWN

TRUTH EVALUATION
evaluation.truthSupplied: false
evaluation.skipped: true
evaluation.reason: no truth
evaluation.scoreboard: UNKNOWN

VISUAL RENDERS
visualRenderCount: 2
index | gate | kind | owner | status | id | summary
1 | G0 | canonical | StripChrome + AutoStitch | rendered | g0.canonical | exact canonical raster
  file: renders/input/g0.canonical.png
2 | G3 | feature | teeFamily@teeFamily | rendered | teeFamily.teeFamily | visible tee pose evidence
  file: renders/features/feature.teeFamily.teeFamily.svg
  file: renders/features/feature.teeFamily.teeFamily.png

WARNINGS
- first warning
- second warning

ARTIFACTS
artifactCount: 2
artifact[1].uri: artifact://second
artifact[2].uri: artifact://first
`);
	});

	test('a sliced receipt prints the SLICE section and not-scheduled FINAL RESULTS lines verbatim', () => {
		const sliced: RunReceipt = {
			...receipt,
			slice: {
				throughGate: 'G2',
				phase: 'Baskets known',
				parentOperationCount: 19,
				scheduledOperationCount: 2,
				prerequisites: [
					{ id: 'later.op', ownerGate: 'G5', reason: "produces 'x' consumed by 'y'" }
				],
				notScheduled: [
					{ id: 'teeRecovery', ownerGate: 'G4', reason: 'not scheduled (--through G2)' }
				],
				finalResultsNotScheduled: {
					visibleTees: 'not scheduled (--through G2)',
					recoveredTees: 'not scheduled (--through G2)'
				},
				straightStory: ['story line one']
			}
		};
		const text = formatRunReceiptText(sliced);
		expect(text).toContain(
			[
				'SLICE (--through G2)',
				'slice.phase: Baskets known',
				'slice.scheduledOperations: 2 of 19 (contiguous chronological prefix of the frozen plan)',
				"  prerequisite later.op (G5): produces 'x' consumed by 'y'",
				'  not scheduled teeRecovery (G4): not scheduled (--through G2)',
				'slice.straightAssignmentStory:',
				'  story line one'
			].join('\n')
		);
		expect(text).toContain('results.visibleTees: not scheduled (--through G2)');
		expect(text).toContain('results.recoveredTees: not scheduled (--through G2)');
		// "not seen", "not there", and "not scheduled" stay different lines:
		// a metric absent for another reason still prints UNKNOWN.
		expect(text).toContain('results.phantomTees: UNKNOWN');
	});

	test('preserves chronological receipt order and prints warnings and artifact URIs', () => {
		const text = formatRunReceiptText(receipt);
		expect(text.indexOf('2 | G2 | second')).toBeLessThan(text.indexOf('1 | G1 | first'));
		expect(text).toContain('WARNINGS\n- first warning\n- second warning');
		expect(text).toContain('artifactCount: 2');
		expect(text).toContain('visualRenderCount: 2');
		expect(text).toContain('1 | G0 | canonical | StripChrome + AutoStitch');
		expect(text).toContain('artifact[1].uri: artifact://second');
		expect(text).not.toContain('sha256');
	});
});
