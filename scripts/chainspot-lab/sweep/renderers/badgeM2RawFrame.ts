// Renderer for the Badge M2 raw expanded-frame probe library
// (schema 'chainspot.badge-m2-raw-frame-library/v2', artifact id prefix
// 'badgeM2RawFrame.library.', produced by op 'badgeEvidence.m2Aa'; encoded
// by encodeMaterializedBadgeM2Library in
// packages/alg/src/detectors/threeFactor/features/g5.badgeM2Aa.ts). This
// artifact reports 'measurementTable' as its ArtifactKind -- see
// measurementTable.ts's small delegation at the top of its renderer, which
// hands off to this file for payloads matching BADGE_M2_RAW_FRAME_SCHEMA
// (or the id prefix) and falls back to the generic table renderer for
// everything else.
//
// OWNER CULTURE (binding): VisualRender is testimony, not another
// algorithm. This renderer arranges, colors, crops, scales and labels the
// artifact's OWN numbers. It never recomputes a candidate, an ownership
// verdict, a boundary status, or a partition -- every count printed here is
// read verbatim from the decoded JSON. Where the artifact does not carry a
// fact (e.g. no G1 badge label lives in this library), this renderer prints
// UNKNOWN/UNREAD loudly instead of guessing.
//
// Coordinate frame (read off m2Representation.ts's M2RawSourceProbeTrace /
// M2RawRegistration / M2RawTargetPartition, and confirmed against a real
// decoded artifact 2026-09-02): every per-badge local coordinate pair
// [x,y] in representations[i].rawTrace.partition.byPartition/
// exactSupportedCoordinates is relative to that badge's own
// registration.translation (== registration.ownedBbox's [x0,y0] top-left,
// integer translation only, no resampling): source pixel =
// (translation[0]+x, translation[1]+y). The margin sweep is symmetric, so
// the crop for the badge's frame at marginPx M is
// { x: translation[0]-M, y: translation[1]-M, width: frameSize[0], height:
// frameSize[1] } where frameSize comes from trace.margins[].frameSize for
// the matching marginPx -- NEVER computed here from bbox dims, because
// frameSize is shared across all 18 registrations (padded to the widest
// bbox) and is an artifact-declared field, not a per-badge derivation.
//
// RendererInput.parsed for this kind is a PLAIN JSON.parse (artifactIo.ts's
// safeParseJson), NOT decodeMaterializedBadgeM2Library's typed-array-
// reviving decode. Two consequences, both load-bearing:
//   1. parsed.rawProbe.representations is the wire-only elision marker
//      string '$chainspotElidedDuplicateOf:representations', not an array
//      -- this file NEVER reads through rawProbe.representations, only the
//      top-level parsed.representations.
//   2. Every Uint32Array-typed field the encoder tags (representations[i]'s
//      m1/m2/aa/transition pixel sets) arrives as
//      {$chainspotTypedArray:'u32', data:[...]} rather than a real array.
//      This renderer never reads those fields -- the per-badge partition
//      pixels/counts it needs (byPartition, counts, finalMarginPx) live on
//      representations[i].rawTrace, which uses plain number-pair arrays,
//      confirmed untagged against a real decoded artifact.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PNG } from 'pngjs';
import type { RendererFn, RendererOutput } from '../rendererContract';

export const BADGE_M2_RAW_FRAME_SCHEMA = 'chainspot.badge-m2-raw-frame-library/v2';
const ARTIFACT_ID_PREFIX = 'badgeM2RawFrame.library.';

/** True when this JSON payload is (or looks like) a Badge M2 raw-frame
 * library -- checked by schema string first, id prefix as a fallback for a
 * payload whose schema field didn't parse for some other loud reason. */
export function isBadgeM2RawFrameLibraryPayload(parsed: unknown, artifactId?: string): boolean {
	if (isRecord(parsed) && parsed.schema === BADGE_M2_RAW_FRAME_SCHEMA) return true;
	return typeof artifactId === 'string' && artifactId.startsWith(ARTIFACT_ID_PREFIX);
}

// ---------------------------------------------------------------------------
// Loose, defensive shape helpers. This is JSON off disk, not a typed
// in-memory object -- every access below tolerates a missing/malformed
// field by falling back to an explicit UNKNOWN note rather than throwing or
// silently omitting the line. No field here is invented; every value comes
// straight off the decoded payload.
// ---------------------------------------------------------------------------

type Pair = readonly [number, number];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asPairArray(value: unknown): Pair[] {
	if (!Array.isArray(value)) return [];
	const out: Pair[] = [];
	for (const entry of value) {
		if (Array.isArray(entry) && entry.length === 2 && typeof entry[0] === 'number' && typeof entry[1] === 'number')
			out.push([entry[0], entry[1]]);
	}
	return out;
}

function asStringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function num(value: unknown, fallback: string | number = 'UNKNOWN'): string | number {
	return typeof value === 'number' ? value : fallback;
}

function str(value: unknown, fallback = 'UNKNOWN'): string {
	return typeof value === 'string' ? value : fallback;
}

const PARTITION_NAMES = ['m1-owned', 'old-aa', 'old-residue', 'exterior'] as const;
type PartitionName = (typeof PARTITION_NAMES)[number];

// ---------------------------------------------------------------------------
// Palette -- copied verbatim from src/lib/evidence-workbench/m2Projection.ts
// RAW_PARTITION_COLORS/COLORS (read on 2026-09-02, that file is out of this
// renderer's territory so the VALUES are duplicated here, not imported, to
// keep the CLI picture and the Storybook picture agreeing on color without
// creating a cross-territory import). If that palette changes there, this
// comment goes stale before the code does -- re-check m2Projection.ts first.
// ---------------------------------------------------------------------------
const PARTITION_COLORS: Readonly<Record<PartitionName, readonly [number, number, number]>> = {
	'm1-owned': [34, 197, 94], // m2Projection.ts COLORS.m1Owned (green)
	'old-aa': [59, 130, 246], // m2Projection.ts COLORS.oldAa (blue)
	'old-residue': [245, 158, 11], // m2Projection.ts COLORS.oldResidue (amber)
	exterior: [168, 85, 247] // m2Projection.ts COLORS.newExterior (purple)
};
/** Not from the evidence-workbench palette -- a LAB-local marker color for
 * pixels the artifact's own exact-supported set places on the searched
 * frame's outer edge (the reason a 'insufficient' verdict cites). Chosen to
 * be unmistakable against all four partition colors above. */
const BOUNDARY_TOUCH_RED: readonly [number, number, number] = [255, 0, 0];
const OUT_OF_RASTER_GRAY: readonly [number, number, number] = [80, 80, 80];
const SHEET_BACKGROUND: readonly [number, number, number] = [15, 23, 42];
const LABEL_TEXT: readonly [number, number, number] = [226, 232, 240];
const TILE_OUTLINE: readonly [number, number, number] = [100, 116, 139];

/** Exported for tests only, so an expected contact-sheet size can be
 * computed from these constants instead of a second hardcoded copy. */
export const SCALE_FACTOR = 4;

// ---------------------------------------------------------------------------
// Minimal hand-authored bitmap font. No text-rendering helper is exported
// from featureRenders.ts (checked 2026-09-02: only renderTraceFeatures,
// renderRunEndpointReceipt, printFeatureRenders and featureIdsForUnit are
// exported) and no font asset exists anywhere in scripts/chainspot-lab, so
// this is a small local font covering exactly the glyphs the tile labels
// need: digits, the letters in "BADGE/UNREAD/M1/AA/RES/EXT", and '-','=',
// ':',' '. Each row string's length is that glyph's pixel width; '#' is lit.
// ---------------------------------------------------------------------------
const FONT: Readonly<Record<string, readonly string[]>> = {
	'0': ['####', '#..#', '#..#', '#..#', '####'],
	'1': ['.#.', '##.', '.#.', '.#.', '###'],
	'2': ['###.', '...#', '.##.', '#...', '####'],
	'3': ['###.', '...#', '.##.', '...#', '###.'],
	'4': ['#.#.', '#.#.', '####', '..#.', '..#.'],
	'5': ['####', '#...', '###.', '...#', '###.'],
	'6': ['.##.', '#...', '###.', '#..#', '.##.'],
	'7': ['####', '...#', '..#.', '.#..', '.#..'],
	'8': ['.##.', '#..#', '.##.', '#..#', '.##.'],
	'9': ['.##.', '#..#', '.###', '...#', '.##.'],
	A: ['.##.', '#..#', '####', '#..#', '#..#'],
	B: ['###.', '#..#', '###.', '#..#', '###.'],
	D: ['###.', '#..#', '#..#', '#..#', '###.'],
	E: ['####', '#...', '###.', '#...', '####'],
	G: ['.###', '#...', '#.##', '#..#', '.###'],
	M: ['#...#', '##.##', '#.#.#', '#...#', '#...#'],
	N: ['#...#', '##..#', '#.#.#', '#..##', '#...#'],
	R: ['###.', '#..#', '###.', '#.#.', '#..#'],
	S: ['.###', '#...', '.##.', '...#', '###.'],
	T: ['###', '.#.', '.#.', '.#.', '.#.'],
	U: ['#..#', '#..#', '#..#', '#..#', '.##.'],
	X: ['#..#', '.##.', '.##.', '.##.', '#..#'],
	'-': ['...', '...', '###', '...', '...'],
	'=': ['...', '###', '...', '###', '...'],
	':': ['.', '#', '.', '#', '.'],
	' ': ['..', '..', '..', '..', '..']
};
const FONT_ROWS = 5;

function drawTextLine(
	dst: Uint8Array,
	dstWidth: number,
	dstHeight: number,
	originX: number,
	originY: number,
	text: string,
	scale: number,
	color: readonly [number, number, number]
): void {
	let cursorX = originX;
	for (const ch of text.toUpperCase()) {
		const glyph = FONT[ch] ?? FONT[' '];
		const glyphWidth = glyph[0]!.length;
		for (let row = 0; row < FONT_ROWS; row++) {
			const bits = glyph[row]!;
			for (let col = 0; col < glyphWidth; col++) {
				if (bits[col] !== '#') continue;
				for (let sy = 0; sy < scale; sy++) {
					for (let sx = 0; sx < scale; sx++) {
						const px = cursorX + col * scale + sx;
						const py = originY + row * scale + sy;
						if (px < 0 || py < 0 || px >= dstWidth || py >= dstHeight) continue;
						const i = (py * dstWidth + px) * 4;
						dst[i] = color[0];
						dst[i + 1] = color[1];
						dst[i + 2] = color[2];
						dst[i + 3] = 255;
					}
				}
			}
		}
		cursorX += (glyphWidth + 1) * scale;
	}
}

function safeSegment(s: string): string {
	return s.replace(/[^a-zA-Z0-9_.-]+/g, '_');
}

function withCommas(n: number | string): string {
	return typeof n === 'number' ? n.toLocaleString('en-US') : n;
}

function formatTable(headers: readonly string[], rows: readonly (readonly (string | number)[])[]): string[] {
	const cells = rows.map((row) => row.map((v) => withCommas(v).toString()));
	const widths = headers.map((h, i) => Math.max(h.length, ...cells.map((r) => r[i]!.length)));
	const line = (values: readonly string[]) =>
		values.map((v, i) => v.padEnd(widths[i]!)).join(' | ').trimEnd();
	return [line(headers), line(widths.map((w) => '-'.repeat(w))), ...cells.map(line)];
}

// ---------------------------------------------------------------------------
// Receipt (text). Built as a pure function of the decoded payload so a test
// can assert its lines equal the input's own fields without touching the PNG.
// ---------------------------------------------------------------------------

export interface BadgeM2RawFrameReceiptContext {
	readonly artifactId: string;
	readonly sha256: string;
	readonly sourcePngPath: string | undefined;
	readonly scaleFactor: number;
	readonly contactSheetPath: string | undefined;
	readonly renderNote: string;
}

export function buildBadgeM2RawFrameReceiptLines(
	parsed: unknown,
	ctx: BadgeM2RawFrameReceiptContext
): string[] {
	const lines: string[] = [];
	const library = isRecord(parsed) ? parsed : {};
	lines.push('=== BADGE M2 RAW-FRAME RECEIPT ===');
	lines.push(`artifact id:   ${ctx.artifactId}`);
	lines.push(`schema:        ${str(library.schema)}`);
	lines.push(`featureId:     ${str(library.featureId)}`);
	lines.push(`library state: ${str(library.state)}`);
	const provenance = isRecord(library.provenance) ? library.provenance : undefined;
	lines.push(
		`provenance:    imageId=${str(provenance?.imageId)} paramsHash=${str(provenance?.paramsHash)} source=${str(provenance?.source)}`
	);
	lines.push('');

	if (isRecord(library.sizeGuard) && library.sizeGuard.status === 'UNKNOWN') {
		const guard = library.sizeGuard;
		lines.push('sizeGuard: FIRED -- rawProbe and representations were omitted from this artifact.');
		lines.push(`  status:          ${str(guard.status)}`);
		lines.push(`  reason:          ${str(guard.reason)}`);
		lines.push(`  estimatedBytes:  ${withCommas(num(guard.estimatedBytes))}`);
		lines.push(`  limitBytes:      ${withCommas(num(guard.limitBytes))}`);
		lines.push(`  omitted:         ${str(guard.omitted)}`);
		lines.push('');
		lines.push('No picture rendered: the fields the picture needs were not written to this artifact.');
		return lines;
	}

	const rawProbe = isRecord(library.rawProbe) ? library.rawProbe : undefined;
	if (!rawProbe) {
		lines.push(
			`rawProbe: ABSENT (library.state=${str(library.state)}). ` +
				'Either the feature is disabled or the trace was not materialized -- no picture to render.'
		);
		return lines;
	}
	const trace = isRecord(rawProbe.trace) ? rawProbe.trace : undefined;
	if (!trace) {
		lines.push('rawProbe.trace: MISSING -- cannot render the convergence trail.');
		return lines;
	}

	const algorithm = isRecord(trace.algorithm) ? trace.algorithm : undefined;
	const exactAlg = isRecord(algorithm?.exact) ? algorithm!.exact : undefined;
	const quantizedAlg = isRecord(algorithm?.quantized) ? algorithm!.quantized : undefined;
	lines.push('algorithm (verbatim from rawProbe.trace.algorithm):');
	lines.push(
		`  exact:      equality=${str((exactAlg as Record<string, unknown> | undefined)?.equality)} tuple=${str((exactAlg as Record<string, unknown> | undefined)?.tuple)} minimumSupportCount=${num((exactAlg as Record<string, unknown> | undefined)?.minimumSupportCount)}`
	);
	lines.push(
		`  quantized:  equality=${str((quantizedAlg as Record<string, unknown> | undefined)?.equality)} binWidth=${num((quantizedAlg as Record<string, unknown> | undefined)?.binWidth)} (NON-AUTHORITATIVE diagnostic only)`
	);
	lines.push('');

	// -- Per-margin convergence trail, copied verbatim from trace.margins[]. --
	const margins = Array.isArray(trace.margins) ? trace.margins.filter(isRecord) : [];
	lines.push(`CONVERGENCE TRAIL (trace.margins[], ${margins.length} entr${margins.length === 1 ? 'y' : 'ies'}):`);
	const rows = margins.map((margin) => {
		const boundary = isRecord(margin.exactBoundary) ? margin.exactBoundary : undefined;
		const side = (name: string) => {
			const s = isRecord(boundary?.[name]) ? (boundary![name] as Record<string, unknown>) : undefined;
			return `${str(s?.status, '?')}(${num(s?.count, '?')})`;
		};
		const frameSize = Array.isArray(margin.frameSize) ? margin.frameSize : undefined;
		return [
			num(margin.marginPx),
			frameSize ? `${num(frameSize[0])}x${num(frameSize[1])}` : 'UNKNOWN',
			`L${side('left')} R${side('right')} T${side('top')} B${side('bottom')} =${num(boundary?.total, '?')} ${str(boundary?.status, '?')}`,
			num(Array.isArray(margin.exactSupportedCoordinates) ? margin.exactSupportedCoordinates.length : 'UNKNOWN'),
			num(
				Array.isArray(margin.exactModalSupportedCoordinates)
					? margin.exactModalSupportedCoordinates.length
					: 'UNKNOWN'
			),
			num(
				Array.isArray(margin.quantizedSupportedCoordinates)
					? margin.quantizedSupportedCoordinates.length
					: 'UNKNOWN'
			),
			num(isRecord(margin.quantizedBoundary) ? margin.quantizedBoundary.total : 'UNKNOWN'),
			margin.observations !== undefined ? 'yes' : 'no'
		];
	});
	lines.push(
		...formatTable(
			['marginPx', 'frame', 'exactBoundary(L/R/T/B/total/status)', 'exact-sup', 'modal-sup', 'quant-sup', 'quantBoundaryTotal', 'obsRetained'],
			rows
		)
	);
	lines.push('');

	// -- Final status/reason/ownership, verbatim. --
	const final = isRecord(trace.final) ? trace.final : undefined;
	lines.push('FINAL (trace.final, verbatim):');
	lines.push(`  status:       ${str(final?.status)}`);
	lines.push(`  reason:       ${str(final?.reason)}`);
	lines.push(`  finalMarginPx: ${num(final?.finalMarginPx, 'null')}`);
	const ownership = isRecord(final?.ownership) ? final!.ownership : undefined;
	lines.push(`  ownership:    promoted=${String(ownership?.promoted ?? 'UNKNOWN')} criterion=${str(ownership?.criterion)}`);
	lines.push('');

	// -- Control status, verbatim (prefer rawProbe.statistics; trace.control / trace.statistics as fallbacks). --
	const control = isRecord(rawProbe.statistics)
		? rawProbe.statistics
		: isRecord(trace.control)
			? trace.control
			: isRecord(trace.statistics)
				? trace.statistics
				: undefined;
	lines.push('CONTROL (empirical circular-shift null; verbatim):');
	if (!control) {
		lines.push('  UNKNOWN -- no control object present on this artifact.');
	} else {
		lines.push(`  status:          ${str(control.status)}`);
		lines.push(`  reason:          ${str(control.reason)}`);
		lines.push(`  controlSeed:     ${str(control.controlSeed)}`);
		lines.push(`  seedAlgorithm:   ${str(control.seedAlgorithm)}`);
		lines.push(`  replicateCount:  ${num(control.replicateCount)}`);
		lines.push(`  supportThresholds: ${JSON.stringify(control.supportThresholds ?? 'UNKNOWN')}`);
		lines.push(`  assumptions:     ${asStringArray(control.assumptions).join(' | ') || 'UNKNOWN'}`);
		const controlMargins = Array.isArray(control.margins) ? control.margins : [];
		lines.push(`  margins measured: ${controlMargins.length}`);
	}
	lines.push('');

	// -- Evidence retention. --
	const finalObsMargin = margins.find((m) => m.observations !== undefined);
	lines.push(
		`EVIDENCE RETENTION: superseded margins retain summaries only (no per-pixel replay); full per-pixel ` +
			`observations retained for the final margin ${finalObsMargin ? num(finalObsMargin.marginPx) : 'NONE'}px only ` +
			`(of ${margins.length} margins swept). Source: m2Representation.ts EVIDENCE-RETENTION POLICY comment; ` +
			`checked here against margins[].observations presence, not re-derived.`
	);
	lines.push('');

	// -- Registrations (18 badges' frame placement in the canonical raster). --
	const registrations = Array.isArray(trace.registrations) ? trace.registrations.filter(isRecord) : [];
	lines.push(`REGISTRATIONS (trace.registrations[], ${registrations.length} badge(s)):`);
	lines.push(
		...formatTable(
			['sampleId', 'ownedBbox', 'translation', 'glyphExact', 'glyphHalo'],
			registrations.map((r) => [
				str(r.sampleId),
				Array.isArray(r.ownedBbox) ? `[${r.ownedBbox.join(',')}]` : 'UNKNOWN',
				Array.isArray(r.translation) ? `[${r.translation.join(',')}]` : 'UNKNOWN',
				num(r.glyphExactCount),
				num(r.glyphHaloCount)
			])
		)
	);
	lines.push('');

	// -- Per-badge partition counts, from representations[i].rawTrace (verbatim). --
	const representations = Array.isArray(library.representations) ? library.representations.filter(isRecord) : [];
	lines.push(`PER-BADGE PARTITION COUNTS (representations[].rawTrace.partition.counts, verbatim; ${representations.length} representation(s)):`);
	lines.push('G1 label: UNREAD for every badge -- this artifact does not carry BadgeEvidence.label (only rawProbe + representations are retained here); see gap note at the end of this receipt.');
	lines.push(
		...formatTable(
			['objectId', 'finalMarginPx', 'm1-owned', 'old-aa', 'old-residue', 'exterior', 'frame.status'],
			representations.map((rep) => {
				const rawTrace = isRecord(rep.rawTrace) ? rep.rawTrace : undefined;
				const partition = isRecord(rawTrace?.partition) ? rawTrace!.partition : undefined;
				const counts = isRecord(partition?.counts) ? partition!.counts : undefined;
				const frame = isRecord(rep.frame) ? rep.frame : undefined;
				const c = (name: string) => num(counts?.[name], 'UNKNOWN');
				return [
					str(rep.objectId),
					num(rawTrace?.finalMarginPx, 'null'),
					c('m1-owned'),
					c('old-aa'),
					c('old-residue'),
					c('exterior'),
					str(frame?.status)
				];
			})
		)
	);
	lines.push('');

	lines.push('PICTURE:');
	lines.push(`  render note: ${ctx.renderNote}`);
	if (ctx.contactSheetPath) {
		lines.push(`  contact sheet: ${ctx.contactSheetPath}`);
		lines.push(`  scale factor: ${ctx.scaleFactor}x nearest-neighbour`);
		lines.push(`  source raster PNG: ${ctx.sourcePngPath ?? 'UNKNOWN'}`);
		lines.push(
			`  palette (copied from src/lib/evidence-workbench/m2Projection.ts RAW_PARTITION_COLORS, 2026-09-02): ` +
				PARTITION_NAMES.map((name) => `${name}=rgb(${PARTITION_COLORS[name].join(',')})`).join(' ') +
				` boundary-touch-marker=rgb(${BOUNDARY_TOUCH_RED.join(',')}) [LAB-local, not from that palette]`
		);
	}
	lines.push('');

	lines.push('GAPS (things this renderer could not show because the artifact does not carry them):');
	lines.push('  - G1 badge label (hole-number digit read + confidence) is not present on this library');
	lines.push('    schema; every tile prints "G1:UNREAD". Producer-side ask: carry BadgeEvidence.label (or a');
	lines.push('    reference to it) alongside representations[] so a renderer can map badge-N to a hole label.');
	lines.push(
		'  - Per-pixel exact-support recurrence groups (which of the 18 raw samples agreed at each coordinate)'
	);
	lines.push(
		'    are retained only for the FINAL margin (trace.margins[].observations) and are not rendered here --'
	);
	lines.push('    this contact sheet shows the partitioned exact-supported SET, not the per-pixel vote detail.');

	return lines;
}

// ---------------------------------------------------------------------------
// Contact sheet (PNG).
// ---------------------------------------------------------------------------

interface Tile {
	readonly objectId: string;
	readonly finalMarginPx: number;
	readonly frameWidth: number;
	readonly frameHeight: number;
	readonly cropX: number;
	readonly cropY: number;
	readonly byPartition: Readonly<Record<PartitionName, Pair[]>>;
	readonly counts: Readonly<Record<PartitionName, number | 'UNKNOWN'>>;
	readonly finalExactSupportedCoordinates: Pair[];
	readonly frameStatus: string;
}

function buildTiles(parsed: Record<string, unknown>): { tiles: Tile[]; skipped: string[] } {
	const rawProbe = isRecord(parsed.rawProbe) ? parsed.rawProbe : undefined;
	const trace = isRecord(rawProbe?.trace) ? rawProbe!.trace : undefined;
	const margins = Array.isArray(trace?.margins) ? trace!.margins.filter(isRecord) : [];
	const registrations = Array.isArray(trace?.registrations) ? trace!.registrations.filter(isRecord) : [];
	const representations = Array.isArray(parsed.representations) ? parsed.representations.filter(isRecord) : [];

	const registrationById = new Map<string, Record<string, unknown>>();
	for (const r of registrations) if (typeof r.sampleId === 'string') registrationById.set(r.sampleId, r);
	const frameSizeByMargin = new Map<number, readonly [number, number]>();
	for (const m of margins) {
		if (typeof m.marginPx === 'number' && Array.isArray(m.frameSize) && m.frameSize.length === 2)
			frameSizeByMargin.set(m.marginPx, [m.frameSize[0], m.frameSize[1]]);
	}

	const tiles: Tile[] = [];
	const skipped: string[] = [];
	for (const rep of representations) {
		const objectId = typeof rep.objectId === 'string' ? rep.objectId : undefined;
		const rawTrace = isRecord(rep.rawTrace) ? rep.rawTrace : undefined;
		const finalMarginPx = typeof rawTrace?.finalMarginPx === 'number' ? rawTrace.finalMarginPx : undefined;
		const registration = objectId ? registrationById.get(objectId) : undefined;
		const translation = Array.isArray(registration?.translation) ? registration!.translation : undefined;
		const frameSize = finalMarginPx !== undefined ? frameSizeByMargin.get(finalMarginPx) : undefined;
		if (!objectId || finalMarginPx === undefined || !registration || !translation || !frameSize) {
			skipped.push(
				`${objectId ?? 'UNKNOWN objectId'}: missing ${!objectId ? 'objectId' : !rawTrace ? 'rawTrace' : finalMarginPx === undefined ? 'rawTrace.finalMarginPx' : !registration ? 'registration' : !translation ? 'registration.translation' : 'margins[].frameSize for that finalMarginPx'}`
			);
			continue;
		}
		const partition = isRecord(rawTrace?.partition) ? rawTrace!.partition : undefined;
		const byPartitionRaw = isRecord(partition?.byPartition) ? partition!.byPartition : undefined;
		const countsRaw = isRecord(partition?.counts) ? partition!.counts : undefined;
		const byPartition = Object.fromEntries(
			PARTITION_NAMES.map((name) => [name, asPairArray(byPartitionRaw?.[name])])
		) as Record<PartitionName, Pair[]>;
		const counts = Object.fromEntries(
			PARTITION_NAMES.map((name) => [name, typeof countsRaw?.[name] === 'number' ? (countsRaw![name] as number) : 'UNKNOWN'])
		) as Record<PartitionName, number | 'UNKNOWN'>;
		const frame = isRecord(rep.frame) ? rep.frame : undefined;
		tiles.push({
			objectId,
			finalMarginPx,
			frameWidth: frameSize[0],
			frameHeight: frameSize[1],
			cropX: translation[0] - finalMarginPx,
			cropY: translation[1] - finalMarginPx,
			byPartition,
			counts,
			finalExactSupportedCoordinates: asPairArray(rawTrace?.finalExactSupportedCoordinates),
			frameStatus: str(frame?.status)
		});
	}

	// Display order only (arrangement, not a claim about the artifact's own
	// storage order): numeric by trailing badge ordinal so the sheet reads
	// left-to-right, top-to-bottom in the natural G1 sequence.
	tiles.sort((a, b) => {
		const na = Number(a.objectId.match(/(\d+)$/)?.[1] ?? Number.POSITIVE_INFINITY);
		const nb = Number(b.objectId.match(/(\d+)$/)?.[1] ?? Number.POSITIVE_INFINITY);
		return na - nb || a.objectId.localeCompare(b.objectId);
	});
	return { tiles, skipped };
}

function isOnFrameEdge(x: number, y: number, marginPx: number, frameWidth: number, frameHeight: number): boolean {
	return x === -marginPx || x === frameWidth - marginPx - 1 || y === -marginPx || y === frameHeight - marginPx - 1;
}

function paintTileInto(
	sheet: Uint8Array,
	sheetWidth: number,
	sheetHeight: number,
	tileOriginX: number,
	tileOriginY: number,
	tile: Tile,
	source: PNG,
	scale: number
): void {
	// Base raw pixels, native resolution, scaled by nearest-neighbour into
	// the sheet buffer. Overlay colors are computed per native pixel first
	// (so partition paint and the boundary-red marker are decided once, not
	// once per output sub-pixel) then blitted as a scale x scale block.
	for (let ly = 0; ly < tile.frameHeight; ly++) {
		for (let lx = 0; lx < tile.frameWidth; lx++) {
			const sourceX = tile.cropX + lx;
			const sourceY = tile.cropY + ly;
			let r: number, g: number, b: number;
			if (sourceX >= 0 && sourceY >= 0 && sourceX < source.width && sourceY < source.height) {
				const si = (sourceY * source.width + sourceX) * 4;
				r = source.data[si]!;
				g = source.data[si + 1]!;
				b = source.data[si + 2]!;
			} else {
				[r, g, b] = OUT_OF_RASTER_GRAY;
			}
			for (let sy = 0; sy < scale; sy++) {
				for (let sx = 0; sx < scale; sx++) {
					const px = tileOriginX + lx * scale + sx;
					const py = tileOriginY + ly * scale + sy;
					if (px < 0 || py < 0 || px >= sheetWidth || py >= sheetHeight) continue;
					const di = (py * sheetWidth + px) * 4;
					sheet[di] = r;
					sheet[di + 1] = g;
					sheet[di + 2] = b;
					sheet[di + 3] = 255;
				}
			}
		}
	}
	const paintLocal = (lx: number, ly: number, color: readonly [number, number, number]) => {
		if (lx < 0 || ly < 0 || lx >= tile.frameWidth || ly >= tile.frameHeight) return;
		for (let sy = 0; sy < scale; sy++) {
			for (let sx = 0; sx < scale; sx++) {
				const px = tileOriginX + lx * scale + sx;
				const py = tileOriginY + ly * scale + sy;
				if (px < 0 || py < 0 || px >= sheetWidth || py >= sheetHeight) continue;
				const di = (py * sheetWidth + px) * 4;
				sheet[di] = color[0];
				sheet[di + 1] = color[1];
				sheet[di + 2] = color[2];
				sheet[di + 3] = 255;
			}
		}
	};
	for (const name of PARTITION_NAMES) {
		const color = PARTITION_COLORS[name];
		for (const [x, y] of tile.byPartition[name]) paintLocal(x + tile.finalMarginPx, y + tile.finalMarginPx, color);
	}
	// Boundary-touching exact-supported pixels paint OVER partition color,
	// last, so the reason for an 'insufficient' verdict stays visible.
	for (const [x, y] of tile.finalExactSupportedCoordinates) {
		if (isOnFrameEdge(x, y, tile.finalMarginPx, tile.frameWidth, tile.frameHeight))
			paintLocal(x + tile.finalMarginPx, y + tile.finalMarginPx, BOUNDARY_TOUCH_RED);
	}
	// Tile outline, drawn just outside the tile's own pixels (in the gutter)
	// so it never hides a boundary-touch marker sitting on the tile's edge.
	const outlineX0 = tileOriginX - 1;
	const outlineY0 = tileOriginY - 1;
	const outlineX1 = tileOriginX + tile.frameWidth * scale;
	const outlineY1 = tileOriginY + tile.frameHeight * scale;
	for (let x = outlineX0; x <= outlineX1; x++) {
		for (const y of [outlineY0, outlineY1]) {
			if (x < 0 || y < 0 || x >= sheetWidth || y >= sheetHeight) continue;
			const di = (y * sheetWidth + x) * 4;
			sheet[di] = TILE_OUTLINE[0];
			sheet[di + 1] = TILE_OUTLINE[1];
			sheet[di + 2] = TILE_OUTLINE[2];
			sheet[di + 3] = 255;
		}
	}
	for (let y = outlineY0; y <= outlineY1; y++) {
		for (const x of [outlineX0, outlineX1]) {
			if (x < 0 || y < 0 || x >= sheetWidth || y >= sheetHeight) continue;
			const di = (y * sheetWidth + x) * 4;
			sheet[di] = TILE_OUTLINE[0];
			sheet[di + 1] = TILE_OUTLINE[1];
			sheet[di + 2] = TILE_OUTLINE[2];
			sheet[di + 3] = 255;
		}
	}
}

const LABEL_LINE_HEIGHT = (FONT_ROWS + 1) * 2 + 2; // text scale 2, +1 row spacing, +2 padding
export const LABEL_STRIP_HEIGHT = LABEL_LINE_HEIGHT * 3 + 6;
export const GUTTER = 12;
export const MAX_COLUMNS = 6;

function buildContactSheet(tiles: readonly Tile[], source: PNG): { png: PNG; columns: number; rows: number } {
	const columns = Math.min(MAX_COLUMNS, Math.max(1, tiles.length));
	const rows = Math.max(1, Math.ceil(tiles.length / columns));
	const maxFrameW = Math.max(1, ...tiles.map((t) => t.frameWidth));
	const maxFrameH = Math.max(1, ...tiles.map((t) => t.frameHeight));
	const tileCellW = maxFrameW * SCALE_FACTOR + GUTTER;
	const tileCellH = maxFrameH * SCALE_FACTOR + LABEL_STRIP_HEIGHT + GUTTER;
	const width = columns * tileCellW + GUTTER;
	const height = rows * tileCellH + GUTTER;
	const sheet = new Uint8Array(width * height * 4);
	for (let i = 0; i < sheet.length; i += 4) {
		sheet[i] = SHEET_BACKGROUND[0];
		sheet[i + 1] = SHEET_BACKGROUND[1];
		sheet[i + 2] = SHEET_BACKGROUND[2];
		sheet[i + 3] = 255;
	}
	tiles.forEach((tile, index) => {
		const col = index % columns;
		const row = Math.floor(index / columns);
		const originX = GUTTER + col * tileCellW;
		const originY = GUTTER + row * tileCellH;
		paintTileInto(sheet, width, height, originX, originY, tile, source, SCALE_FACTOR);
		const labelY = originY + tile.frameHeight * SCALE_FACTOR + 6;
		const line1 = tile.objectId;
		const line2 = 'G1:UNREAD';
		const line3 =
			`M1=${tile.counts['m1-owned']} AA=${tile.counts['old-aa']} ` +
			`RES=${tile.counts['old-residue']} EXT=${tile.counts.exterior}`;
		drawTextLine(sheet, width, height, originX, labelY, line1, 2, LABEL_TEXT);
		drawTextLine(sheet, width, height, originX, labelY + LABEL_LINE_HEIGHT, line2, 2, LABEL_TEXT);
		drawTextLine(sheet, width, height, originX, labelY + LABEL_LINE_HEIGHT * 2, line3, 2, LABEL_TEXT);
	});
	const png = new PNG({ width, height });
	png.data.set(sheet);
	return { png, columns, rows };
}

// ---------------------------------------------------------------------------
// RendererFn.
// ---------------------------------------------------------------------------

export const renderBadgeM2RawFrame: RendererFn = (input): RendererOutput => {
	const { artifactRef, parsed, outDir, opId, gate } = input;
	const baseName = `badgeM2RawFrame.${safeSegment(opId)}.${safeSegment(artifactRef.id)}`;
	const receiptPath = resolve(outDir, `${baseName}.receipt.txt`);

	if (!isRecord(parsed)) {
		const text = `${artifactRef.id} (${gate} / ${opId})\nUNKNOWN: payload did not parse as an object.\n`;
		writeFileSync(receiptPath, text);
		return { filesWritten: [receiptPath], summary: 'UNPARSEABLE payload -- text note written', rendered: false };
	}

	// Canonical raster PNG: this is a sibling of <runOutDir>/renders/<kind>/
	// (this call's `outDir`), written once per run at
	// <runOutDir>/renders/input/g0.canonical.png (see operation.ts's
	// canonicalPngPath). RendererInput carries no direct pointer to it
	// (baseRasterPngPath is undefined for measurementTable), so it is
	// located by that same directory convention -- the same technique
	// mask.ts uses to reconstruct its own artifact bytes path.
	const sourcePngPath = resolve(outDir, '..', 'input', 'g0.canonical.png');
	const sourceAvailable = existsSync(sourcePngPath);

	const sizeGuardFired = isRecord(parsed.sizeGuard) && parsed.sizeGuard.status === 'UNKNOWN';
	const rawProbePresent = isRecord(parsed.rawProbe) && isRecord(parsed.rawProbe.trace);
	const representationsPresent = Array.isArray(parsed.representations) && parsed.representations.length > 0;

	let contactSheetPath: string | undefined;
	let renderNote: string;
	let skippedTiles: string[] = [];

	if (sizeGuardFired) {
		renderNote = 'declined: sizeGuard fired -- rawProbe/representations were omitted from this artifact.';
	} else if (!rawProbePresent) {
		renderNote = `declined: rawProbe absent (library.state=${str(parsed.state)}) -- feature disabled or not materialized.`;
	} else if (!representationsPresent) {
		renderNote = 'declined: representations[] is empty -- nothing to tile.';
	} else if (!sourceAvailable) {
		renderNote = `declined: canonical source raster not found at ${sourcePngPath} -- LAB never guesses pixel content.`;
	} else {
		const { tiles, skipped } = buildTiles(parsed);
		skippedTiles = skipped;
		if (tiles.length === 0) {
			renderNote = 'declined: no representation had a complete frame/registration/margin match -- see skipped list.';
		} else {
			const source = PNG.sync.read(readFileSync(sourcePngPath));
			const { png, columns, rows } = buildContactSheet(tiles, source);
			contactSheetPath = resolve(outDir, `${baseName}.contactsheet.png`);
			writeFileSync(contactSheetPath, PNG.sync.write(png));
			renderNote =
				`${tiles.length}/${(parsed.representations as unknown[]).length} badge tile(s) rendered ` +
				`(${columns}x${rows} grid, ${png.width}x${png.height}px)` +
				(skipped.length ? `; ${skipped.length} skipped (see receipt)` : '');
		}
	}

	const receiptLines = buildBadgeM2RawFrameReceiptLines(parsed, {
		artifactId: artifactRef.id,
		sha256: artifactRef.sha256,
		sourcePngPath: sourceAvailable ? sourcePngPath : undefined,
		scaleFactor: SCALE_FACTOR,
		contactSheetPath,
		renderNote
	});
	if (skippedTiles.length) {
		receiptLines.push('', 'SKIPPED TILES (incomplete data; not drawn -- artifact fact, not a renderer guess):');
		for (const s of skippedTiles) receiptLines.push(`  - ${s}`);
	}
	receiptLines.push('', `sha256: ${artifactRef.sha256}`, `uri: ${artifactRef.uri}`, `receipt written to: ${receiptPath}`);
	writeFileSync(receiptPath, `${receiptLines.join('\n')}\n`);

	const filesWritten = contactSheetPath ? [contactSheetPath, receiptPath] : [receiptPath];
	return { filesWritten, summary: renderNote, rendered: contactSheetPath !== undefined };
};

export default renderBadgeM2RawFrame;
