import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PNG } from 'pngjs';
import { afterEach, describe, expect, test } from 'vitest';
import {
	GUTTER,
	LABEL_STRIP_HEIGHT,
	MAX_COLUMNS,
	SCALE_FACTOR,
	isBadgeM2RawFrameLibraryPayload,
	renderBadgeM2RawFrame
} from '../../scripts/chainspot-lab/sweep/renderers/badgeM2RawFrame';
import { renderMeasurementTable } from '../../scripts/chainspot-lab/sweep/renderers/measurementTable';
import type { RendererInput } from '../../scripts/chainspot-lab/sweep/rendererContract';

// A small, hand-built v2 library: 2 badges, a 6x5 owned bbox each, three
// swept margins (2/3/4), final margin 4. Every coordinate below is chosen
// so the fixture is internally consistent the same way the real artifact
// is (crop = translation - marginPx, frameSize matches margins[].frameSize
// for that marginPx, per-badge partition counts sum to the shared final
// exact-supported coordinate count) -- confirmed against a real decoded
// DashsTrack artifact on 2026-09-02 (see badgeM2RawFrame.ts's header
// comment) before this fixture was written.
const FINAL_MARGIN_PX = 4;
// [x,y] pairs local to each badge's own translation. Four of these sit
// exactly on the marginPx=4 frame edge (x=-4, x=9, y=-4, y=8 for a
// 14x13 frame) so the renderer's red boundary-touch marker has something
// real to draw and the test has something concrete to check.
const FINAL_EXACT_SUPPORTED: readonly (readonly [number, number])[] = [
	[-4, 0], // left edge
	[9, 0], // right edge
	[0, -4], // top edge
	[0, 8], // bottom edge
	[0, 0],
	[1, 1],
	[2, 2]
];

function badgeRegistration(sampleId: string, x0: number, y0: number) {
	return {
		sampleId,
		m1ObjectId: sampleId,
		ownedBbox: [x0, y0, 6, 5],
		translation: [x0, y0],
		glyphExactCount: 2,
		glyphHaloCount: 1,
		glyphExactCoordinates: [[1, 1], [2, 1]],
		glyphHaloCoordinates: [[0, 0]],
		sourceFrame: 'full-rgba-image',
		provenance: `test registration for ${sampleId}`
	};
}

function representation(
	objectId: string,
	counts: { 'm1-owned': number; 'old-aa': number; 'old-residue': number; exterior: number },
	byPartition: Record<'m1-owned' | 'old-aa' | 'old-residue' | 'exterior', (readonly [number, number])[]>
) {
	return {
		schema: 'chainspot.badge-representation-m2/v2',
		objectId,
		frame: { status: 'insufficient', reason: `${objectId} test frame reason` },
		rawTrace: {
			targetId: objectId,
			finalMarginPx: FINAL_MARGIN_PX,
			finalExactSupportedCoordinates: FINAL_EXACT_SUPPORTED,
			exactOwnedCoordinates: [],
			partition: {
				targetId: objectId,
				exactSupportedCoordinates: FINAL_EXACT_SUPPORTED,
				exactOwnedCoordinates: [],
				byPartition,
				counts
			}
		}
	};
}

function buildLibrary() {
	const badge0Counts = { 'm1-owned': 3, 'old-aa': 1, 'old-residue': 1, exterior: 2 };
	const badge0ByPartition = {
		'm1-owned': [
			[0, 0],
			[1, 1],
			[2, 2]
		] as (readonly [number, number])[],
		'old-aa': [[-4, 0]] as (readonly [number, number])[],
		'old-residue': [[9, 0]] as (readonly [number, number])[],
		exterior: [
			[0, -4],
			[0, 8]
		] as (readonly [number, number])[]
	};
	// Deliberately different split for badge-1, so a test that only checked
	// badge-0's numbers could not pass by accident.
	const badge1Counts = { 'm1-owned': 2, 'old-aa': 2, 'old-residue': 1, exterior: 2 };
	const badge1ByPartition = {
		'm1-owned': [
			[0, 0],
			[1, 1]
		] as (readonly [number, number])[],
		'old-aa': [
			[2, 2],
			[-4, 0]
		] as (readonly [number, number])[],
		'old-residue': [[9, 0]] as (readonly [number, number])[],
		exterior: [
			[0, -4],
			[0, 8]
		] as (readonly [number, number])[]
	};

	const margins = [
		{
			marginPx: 2,
			frameSize: [10, 9],
			exactSupportedCoordinates: [[0, 0], [1, 1], [2, 2]],
			exactModalSupportedCoordinates: [[0, 0], [1, 1], [2, 2]],
			quantizedSupportedCoordinates: new Array(10).fill([0, 0]),
			exactBoundary: {
				left: { count: 0, status: 'clear', affectedSampleIds: [] },
				right: { count: 0, status: 'clear', affectedSampleIds: [] },
				top: { count: 0, status: 'clear', affectedSampleIds: [] },
				bottom: { count: 0, status: 'clear', affectedSampleIds: [] },
				total: 0,
				status: 'clear'
			},
			quantizedBoundary: { left: { count: 0, status: 'clear', affectedSampleIds: [] }, right: { count: 0, status: 'clear', affectedSampleIds: [] }, top: { count: 0, status: 'clear', affectedSampleIds: [] }, bottom: { count: 0, status: 'clear', affectedSampleIds: [] }, total: 1, status: 'supported' },
			clippedSampleIds: [],
			unobservedSampleCount: 0,
			status: 'measured'
		},
		{
			marginPx: 3,
			frameSize: [12, 11],
			exactSupportedCoordinates: [[0, 0], [1, 1], [2, 2], [-3, 0], [0, -3]],
			exactModalSupportedCoordinates: [[0, 0], [1, 1], [2, 2], [-3, 0], [0, -3]],
			quantizedSupportedCoordinates: new Array(12).fill([0, 0]),
			exactBoundary: {
				left: { count: 1, status: 'supported', affectedSampleIds: [] },
				right: { count: 0, status: 'clear', affectedSampleIds: [] },
				top: { count: 1, status: 'supported', affectedSampleIds: [] },
				bottom: { count: 0, status: 'clear', affectedSampleIds: [] },
				total: 2,
				status: 'supported'
			},
			quantizedBoundary: { left: { count: 0, status: 'clear', affectedSampleIds: [] }, right: { count: 0, status: 'clear', affectedSampleIds: [] }, top: { count: 0, status: 'clear', affectedSampleIds: [] }, bottom: { count: 0, status: 'clear', affectedSampleIds: [] }, total: 2, status: 'supported' },
			clippedSampleIds: [],
			unobservedSampleCount: 0,
			status: 'measured'
		},
		{
			marginPx: FINAL_MARGIN_PX,
			frameSize: [14, 13],
			exactSupportedCoordinates: FINAL_EXACT_SUPPORTED,
			exactModalSupportedCoordinates: FINAL_EXACT_SUPPORTED,
			quantizedSupportedCoordinates: new Array(15).fill([0, 0]),
			exactBoundary: {
				left: { count: 1, status: 'supported', affectedSampleIds: [] },
				right: { count: 1, status: 'supported', affectedSampleIds: [] },
				top: { count: 1, status: 'supported', affectedSampleIds: [] },
				bottom: { count: 1, status: 'supported', affectedSampleIds: [] },
				total: 4,
				status: 'supported'
			},
			quantizedBoundary: { left: { count: 0, status: 'clear', affectedSampleIds: [] }, right: { count: 0, status: 'clear', affectedSampleIds: [] }, top: { count: 0, status: 'clear', affectedSampleIds: [] }, bottom: { count: 0, status: 'clear', affectedSampleIds: [] }, total: 3, status: 'supported' },
			clippedSampleIds: [],
			unobservedSampleCount: 0,
			status: 'measured',
			// Per the schema's evidence-retention policy, only the final
			// margin keeps full per-pixel observations. Content is never read
			// by the renderer -- only presence matters.
			observations: [{ localPixel: [0, 0] }, { localPixel: [1, 1] }]
		}
	];

	return {
		schema: 'chainspot.badge-m2-raw-frame-library/v2',
		featureId: 'badgeM2Aa',
		state: 'insufficient',
		provenance: { imageId: 'test-image-id', paramsHash: 'test-params-hash', source: 'full source RGBA expanded-frame recurrence' },
		rawProbe: {
			schema: 'chainspot.badge-m2-raw-source/v2',
			state: 'insufficient',
			provenance: {
				source: 'full-rgba-image',
				exactBaseline: 'authoritative',
				quantizedDiagnostic: 'non-authoritative',
				jpegCaveat: 'test jpeg caveat'
			},
			trace: {
				algorithm: {
					exact: { authoritative: true, equality: 'exact-rgba-tuple', tuple: '(r,g,b,a)', minimumSupportCount: 2 },
					quantized: { authoritative: false, equality: 'floor-channel-bin', binWidth: 8, equation: 'q(c)=floor(c/8)' },
					modelProvenance: 'test provenance'
				},
				margins,
				registrations: [badgeRegistration('badge-0', 10, 10), badgeRegistration('badge-1', 30, 20)],
				excludedSampleIds: [],
				final: {
					status: 'insufficient',
					reason: 'test: safety cap reached before exact support stabilized',
					targets: [],
					exactSupportedCoordinates: FINAL_EXACT_SUPPORTED,
					exactModalSupportedCoordinates: FINAL_EXACT_SUPPORTED,
					quantizedSupportedCoordinates: new Array(15).fill([0, 0]),
					finalMarginPx: FINAL_MARGIN_PX,
					ownership: { promoted: false, criterion: 'test criterion' }
				}
			},
			statistics: {
				status: 'unknown',
				reason: 'test: negative-control blocked because raw frame is not adequate',
				controlSeed: 'test-seed',
				seedAlgorithm: 'fnv1a32(test)',
				replicateCount: 0,
				supportThresholds: [2, 18],
				assumptions: ['sample 0 is fixed', 'all other samples require nonzero x/y circular shifts'],
				margins: []
			}
		},
		representations: [
			representation('badge-0', badge0Counts, badge0ByPartition),
			representation('badge-1', badge1Counts, badge1ByPartition)
		]
	};
}

describe('renderBadgeM2RawFrame', () => {
	let dir: string;
	let outDir: string;

	function setup() {
		dir = mkdtempSync(join(tmpdir(), 'badge-m2-raw-frame-'));
		const runDir = join(dir, 'run');
		outDir = join(runDir, 'renders', 'measurementTable');
		mkdirSync(outDir, { recursive: true });
		const inputDir = join(runDir, 'renders', 'input');
		mkdirSync(inputDir, { recursive: true });
		// Canonical raster large enough to cover both badges' crops: badge-0
		// crop is x in [6,20), y in [6,19); badge-1 crop is x in [26,40), y
		// in [16,29).
		const canonical = new PNG({ width: 50, height: 40 });
		for (let i = 0; i < canonical.data.length; i += 4) {
			canonical.data[i] = 120;
			canonical.data[i + 1] = 130;
			canonical.data[i + 2] = 140;
			canonical.data[i + 3] = 255;
		}
		writeFileSync(join(inputDir, 'g0.canonical.png'), PNG.sync.write(canonical));
		return { runDir };
	}

	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
	});

	function buildInput(): { input: RendererInput; library: ReturnType<typeof buildLibrary> } {
		setup();
		const library = buildLibrary();
		const bytes = new TextEncoder().encode(JSON.stringify(library));
		// Mirrors artifactIo.ts's safeParseJson exactly: plain JSON.parse, no
		// typed-array reviver. This fixture uses no Uint32Array-tagged fields
		// (the renderer never reads m1/m2/aa/transition), so plain parse is
		// faithful either way.
		const parsed = JSON.parse(new TextDecoder().decode(bytes));
		const input: RendererInput = {
			artifactRef: {
				id: 'badgeM2RawFrame.library.test-image-id',
				kind: 'measurementTable',
				sha256: 'deadbeef'.repeat(8),
				uri: 'test://badgeM2RawFrame.library.test-image-id.bin'
			},
			bytes,
			parsed,
			dims: undefined,
			baseRasterPngPath: undefined,
			outDir,
			opId: 'badgeEvidence.m2Aa',
			gate: 'G1'
		};
		return { input, library };
	}

	test('recognizes the v2 schema and delegates from renderMeasurementTable', () => {
		const { input } = buildInput();
		expect(isBadgeM2RawFrameLibraryPayload(input.parsed, input.artifactRef.id)).toBe(true);
		const viaDelegate = renderMeasurementTable(input);
		expect(viaDelegate.rendered).toBe(true);
		expect(viaDelegate.filesWritten.some((f) => f.endsWith('.contactsheet.png'))).toBe(true);
	});

	test('writes a contact-sheet PNG with the expected 2-tile grid dimensions', () => {
		const { input } = buildInput();
		const output = renderBadgeM2RawFrame(input);
		expect(output.rendered).toBe(true);
		const pngPath = output.filesWritten.find((f) => f.endsWith('.contactsheet.png'));
		expect(pngPath).toBeDefined();
		const png = PNG.sync.read(readFileSync(pngPath!));

		// Both badges share a 14x13 final-margin frame (frameSize for
		// marginPx=4 in the fixture above), 2 tiles -> a 2x1 grid.
		const frameW = 14;
		const frameH = 13;
		const columns = Math.min(MAX_COLUMNS, 2);
		const rows = Math.ceil(2 / columns);
		const tileCellW = frameW * SCALE_FACTOR + GUTTER;
		const tileCellH = frameH * SCALE_FACTOR + LABEL_STRIP_HEIGHT + GUTTER;
		expect(png.width).toBe(columns * tileCellW + GUTTER);
		expect(png.height).toBe(rows * tileCellH + GUTTER);
	});

	test('receipt trail rows are copied verbatim from the input margins', () => {
		const { input, library } = buildInput();
		const output = renderBadgeM2RawFrame(input);
		const receiptPath = output.filesWritten.find((f) => f.endsWith('.receipt.txt'))!;
		const text = readFileSync(receiptPath, 'utf8');
		const lines = text.split('\n');
		const trailStart = lines.findIndex((l) => l.startsWith('CONVERGENCE TRAIL'));
		expect(trailStart).toBeGreaterThanOrEqual(0);

		for (const margin of library.rawProbe.trace.margins) {
			const [w, h] = margin.frameSize;
			// Cell-parse the row (split on '|', trim each cell) rather than
			// assume exact column padding, so this test checks VALUES, not the
			// formatter's whitespace.
			const row = lines
				.slice(trailStart)
				.map((l) => l.split('|').map((c) => c.trim()))
				.find((cells) => cells[0] === String(margin.marginPx));
			expect(row, `no trail row found for marginPx=${margin.marginPx}`).toBeDefined();
			expect(row![1]).toBe(`${w}x${h}`);
			expect(row![2]).toContain(`L${margin.exactBoundary.left.status}(${margin.exactBoundary.left.count})`);
			expect(row![2]).toContain(`R${margin.exactBoundary.right.status}(${margin.exactBoundary.right.count})`);
			expect(row![2]).toContain(`T${margin.exactBoundary.top.status}(${margin.exactBoundary.top.count})`);
			expect(row![2]).toContain(`B${margin.exactBoundary.bottom.status}(${margin.exactBoundary.bottom.count})`);
			expect(row![2]).toContain(`=${margin.exactBoundary.total} ${margin.exactBoundary.status}`);
			expect(Number(row![3])).toBe(margin.exactSupportedCoordinates.length);
			expect(Number(row![4])).toBe(margin.exactModalSupportedCoordinates.length);
			expect(Number(row![5])).toBe(margin.quantizedSupportedCoordinates.length);
			expect(Number(row![6])).toBe(margin.quantizedBoundary.total);
			expect(row![7]).toBe('observations' in margin ? 'yes' : 'no');
		}
		expect(text).toContain(library.rawProbe.trace.final.status);
		expect(text).toContain(library.rawProbe.trace.final.reason);
		expect(text).toContain(library.rawProbe.statistics.reason);
		expect(text).toContain(library.rawProbe.statistics.controlSeed);
		// Evidence retention: exactly one margin (the final one, 4px) carries
		// `observations` in the fixture.
		expect(text).toContain('final margin 4px only (of 3 margins swept)');
	});

	test('receipt partition counts equal the input representations verbatim (no renderer-side recount)', () => {
		const { input, library } = buildInput();
		const output = renderBadgeM2RawFrame(input);
		const receiptPath = output.filesWritten.find((f) => f.endsWith('.receipt.txt'))!;
		const text = readFileSync(receiptPath, 'utf8');
		const lines = text.split('\n');
		const tableStart = lines.findIndex((l) => l.startsWith('PER-BADGE PARTITION COUNTS'));
		expect(tableStart).toBeGreaterThanOrEqual(0);

		for (const rep of library.representations) {
			const row = lines
				.slice(tableStart)
				.find((l) => l.trimStart().startsWith(`${rep.objectId} `) || l.trimStart().startsWith(`${rep.objectId}|`));
			expect(row, `no receipt row found for ${rep.objectId}`).toBeDefined();
			const cells = row!.split('|').map((c) => c.trim());
			// objectId | finalMarginPx | m1-owned | old-aa | old-residue | exterior | frame.status
			expect(cells[0]).toBe(rep.objectId);
			expect(Number(cells[1])).toBe(rep.rawTrace.finalMarginPx);
			expect(Number(cells[2])).toBe(rep.rawTrace.partition.counts['m1-owned']);
			expect(Number(cells[3])).toBe(rep.rawTrace.partition.counts['old-aa']);
			expect(Number(cells[4])).toBe(rep.rawTrace.partition.counts['old-residue']);
			expect(Number(cells[5])).toBe(rep.rawTrace.partition.counts.exterior);
			expect(cells[6]).toBe(rep.frame.status);
			// And the counts are exactly the lengths of that badge's own
			// byPartition coordinate lists -- proves the picture and the text
			// are reading the same underlying testimony, not two different
			// renderer-invented numbers.
			for (const name of ['m1-owned', 'old-aa', 'old-residue', 'exterior'] as const) {
				expect(rep.rawTrace.partition.byPartition[name].length).toBe(rep.rawTrace.partition.counts[name]);
			}
		}
	});

	test('G1 label prints UNREAD (the artifact does not carry BadgeEvidence.label)', () => {
		const { input } = buildInput();
		const output = renderBadgeM2RawFrame(input);
		const receiptPath = output.filesWritten.find((f) => f.endsWith('.receipt.txt'))!;
		const text = readFileSync(receiptPath, 'utf8');
		expect(text).toContain('G1 label: UNREAD');
	});

	test('provenance footer states artifact id, sha256, source PNG, scale factor and palette', () => {
		const { input } = buildInput();
		const output = renderBadgeM2RawFrame(input);
		const receiptPath = output.filesWritten.find((f) => f.endsWith('.receipt.txt'))!;
		const text = readFileSync(receiptPath, 'utf8');
		expect(text).toContain(`artifact id:   ${input.artifactRef.id}`);
		expect(text).toContain(`sha256: ${input.artifactRef.sha256}`);
		expect(text).toContain('4x nearest-neighbour');
		expect(text).toContain('g0.canonical.png');
		expect(text).toContain('m1-owned=rgb(34,197,94)');
		expect(text).toContain('old-aa=rgb(59,130,246)');
		expect(text).toContain('old-residue=rgb(245,158,11)');
		expect(text).toContain('exterior=rgb(168,85,247)');
		expect(text).toContain('boundary-touch-marker=rgb(255,0,0)');
	});

	test('sizeGuard payload declines to rasterize and says why', () => {
		const { input } = buildInput();
		const guarded = {
			schema: 'chainspot.badge-m2-raw-frame-library/v2',
			featureId: 'badgeM2Aa',
			state: 'insufficient',
			provenance: { imageId: 'x', paramsHash: 'y', source: 'full source RGBA expanded-frame recurrence' },
			representations: [],
			sizeGuard: {
				status: 'UNKNOWN',
				reason: 'estimated serialized size exceeds V8 max string length',
				estimatedBytes: 999999999,
				limitBytes: 536870888,
				omitted: 'rawProbe and representations were omitted'
			}
		};
		const guardedInput: RendererInput = { ...input, parsed: guarded, bytes: new TextEncoder().encode(JSON.stringify(guarded)) };
		const output = renderBadgeM2RawFrame(guardedInput);
		expect(output.rendered).toBe(false);
		expect(output.filesWritten.some((f) => f.endsWith('.contactsheet.png'))).toBe(false);
		const text = readFileSync(output.filesWritten[0]!, 'utf8');
		expect(text).toContain('sizeGuard: FIRED');
		expect(text).toContain('estimated serialized size exceeds V8 max string length');
	});

	test('disabled/no-rawProbe payload declines to rasterize and says why', () => {
		const { input } = buildInput();
		const disabled = {
			schema: 'chainspot.badge-m2-raw-frame-library/v2',
			featureId: 'badgeM2Aa',
			state: 'disabled',
			provenance: { imageId: 'x', paramsHash: 'y', source: 'full source RGBA expanded-frame recurrence' },
			representations: []
		};
		const disabledInput: RendererInput = { ...input, parsed: disabled, bytes: new TextEncoder().encode(JSON.stringify(disabled)) };
		const output = renderBadgeM2RawFrame(disabledInput);
		expect(output.rendered).toBe(false);
		expect(readFileSync(output.filesWritten[0]!, 'utf8')).toContain('rawProbe: ABSENT');
	});
});
