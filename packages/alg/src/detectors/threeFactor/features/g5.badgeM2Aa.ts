/**
 * Default-OFF Badge M2 raw expanded-frame probe.
 *
 * M1 remains byte-identical. This feature reads the original source raster
 * only when enabled, searches outside the old bbox±1 evidence crop, and
 * records raw appearance recurrence before it ever looks at historical
 * AA/residue labels. Those labels are post-discovery accounting only.
 */

import type { ExecBoard } from '../../../exec/board';
import type { ABFeatureOperation } from '../../../exec/feature-set';
import type { OperationArtifact } from '../../../exec/gateway';
import {
	encodeMaterializedBadgeM2Representation,
	materializeExpandedBadgeRawFrameProbeWithControl,
	type MaterializedBadgeM2Representation,
	type MaterializedExpandedBadgeRawFrameProbe
} from '../m2Representation';
import type { MaterializedBadgeEvidence } from '../badgeEvidence';
import type { MaterializedM1Representation } from '../m1Representation';
import type { RgbaImage } from '../types';
import type { ABFeature, FeatureContext, FeatureRender, RunTrace, UnitTrace } from './types';

export const BADGE_M2_AA_FEATURE_ID = 'badgeM2Aa' as const;
/**
 * Schema v2 (chainspot #m2-rootcause): wraps M2_RAW_SOURCE_PROBE_SCHEMA/v2
 * and M2_REPRESENTATION_SCHEMA/v2. `rawProbe.trace.margins[].observations`
 * is now retained ONLY for the final margin (superseded margins carry
 * summaries); `rawProbe.trace.final.targets[].observations` and
 * `representations[].rawTrace.observations` no longer exist -- callers join
 * the final margin's per-pixel data by `finalMarginPx` instead of reading a
 * re-embedded copy. See the EVIDENCE-RETENTION POLICY comment above
 * M2_RAW_SOURCE_PROBE_SCHEMA in m2Representation.ts for the full accounting.
 */
export const BADGE_M2_AA_LIBRARY_SCHEMA = 'chainspot.badge-m2-raw-frame-library/v2' as const;

export interface MaterializedBadgeM2Library {
	readonly schema: typeof BADGE_M2_AA_LIBRARY_SCHEMA;
	readonly featureId: typeof BADGE_M2_AA_FEATURE_ID;
	readonly state: 'disabled' | 'materialized' | 'insufficient';
	readonly provenance: {
		readonly imageId: string;
		readonly paramsHash: string;
		readonly source: 'full source RGBA expanded-frame recurrence';
	};
	/**
	 * Undefined when explicitly disabled, or when `sizeGuard` fired (the
	 * estimated serialized size exceeded V8's max string length -- see
	 * `libraryBytes()`). Otherwise this is the one raw discovery trace.
	 */
	readonly rawProbe?: MaterializedExpandedBadgeRawFrameProbe;
	/**
	 * Compatibility/control projections. M1 remains exact. A newly discovered
	 * raw pixel is promoted only when the final adequate frame has exact 18/18
	 * support and its deterministic circular-shift control passes. Empty when
	 * `sizeGuard` fired, for the same reason `rawProbe` is undefined.
	 */
	readonly representations: readonly MaterializedBadgeM2Representation[];
	/**
	 * Present only when the artifact was too large to safely JSON.stringify
	 * (a loud UNKNOWN instead of the `RangeError: Invalid string length`
	 * crash this guards against) -- either the pre-flight estimate exceeded
	 * the limit, or it didn't but the real JSON.stringify threw anyway (see
	 * `libraryBytes()`'s try/catch). `rawProbe`/`representations` are
	 * omitted from THIS encoded artifact when this fires; in-memory
	 * `ctx.measure()` numbers for the run that produced it are unaffected.
	 * `observationCount`/`bytesPerObservation`/`estimatedBytes` let a reader
	 * check the estimate's arithmetic; `marginCount`/`finalMarginPx`/
	 * `finalStatus`/`finalReason` are cheap scalar reads off the same trace
	 * that say what state the omitted rawProbe was actually in.
	 */
	readonly sizeGuard?: {
		readonly status: 'UNKNOWN';
		readonly reason: string;
		readonly estimatedBytes: number;
		readonly limitBytes: number;
		readonly observationCount: number;
		readonly bytesPerObservation: number;
		readonly marginCount: number;
		readonly finalMarginPx: number | null;
		readonly finalStatus: string | null;
		readonly finalReason: string | null;
		readonly omitted: string;
	};
}

interface BadgeEvidenceLibraryInput {
	readonly badges: readonly MaterializedBadgeEvidence[];
	readonly m1: MaterializedM1Representation;
}

function exactPixels(left: Uint32Array, right: Uint32Array): boolean {
	return left.length === right.length && left.every((pixel, index) => pixel === right[index]);
}

function assertM1Control(
	specimen: MaterializedBadgeEvidence,
	m1: MaterializedM1Representation
): void {
	const object = m1.objects.find((candidate) => candidate.id === specimen.id);
	if (!object || object.kind !== 'badge' || object.accounting.status !== 'known')
		throw new Error(`${specimen.id}: raw-frame M2 needs a known preserved M1 Badge composition`);
	if (!exactPixels(object.accounting.availablePixels, specimen.ownedBwPixels))
		throw new Error(`${specimen.id}: M1 available identities drift from BadgeEvidence B+W control`);
	if (!exactPixels(object.accounting.explainedPixels, specimen.ownedBwPixels))
		throw new Error(`${specimen.id}: M1 explained identities drift from BadgeEvidence B+W control`);
	if (object.accounting.unexplainedPixels.length)
		throw new Error(`${specimen.id}: M1 B+W control unexpectedly has unexplained pixels`);
}

function sourceProvenance(library: BadgeEvidenceLibraryInput): MaterializedBadgeM2Library['provenance'] {
	const first = library.badges[0];
	if (!first) {
		return {
			imageId: library.m1.provenance.imageId,
			paramsHash: library.m1.provenance.paramsHash,
			source: 'full source RGBA expanded-frame recurrence'
		};
	}
	if (
		library.badges.some(
			(specimen) =>
				specimen.provenance.imageId !== first.provenance.imageId ||
				specimen.provenance.paramsHash !== first.provenance.paramsHash
		)
	)
		throw new Error(`${BADGE_M2_AA_FEATURE_ID}: E library mixes source/parameter provenance`);
	return {
		imageId: first.provenance.imageId,
		paramsHash: first.provenance.paramsHash,
		source: 'full source RGBA expanded-frame recurrence'
	};
}

/**
 * V8's max String length is `String::kMaxLength` = 2**29 - 24 UTF-16 code
 * units on 64-bit builds (v8/src/objects/string.h; ~536,870,888 units,
 * ~512 MiB). `JSON.stringify` throws `RangeError: Invalid string length`
 * once the string it is building would cross that line -- a JS-engine
 * runtime limit, not a dataset-adequacy threshold or a knob. This payload's
 * JSON is overwhelmingly ASCII (digits, commas, field names), so 1 UTF-16
 * code unit approximates 1 byte closely enough for a pre-flight estimate.
 */
const V8_MAX_STRING_LENGTH = 2 ** 29 - 24;

/**
 * CORRECTED against a direct measurement of the real 47,121,103-byte
 * DashsTrack artifact (schema v2, post-dedup) -- the original comment here
 * claimed retained per-pixel `observations` were >99% of the artifact; they
 * are 32,048,356 B = 68.0% of it. The remaining 15,072,747 B split roughly
 * as `representations` 11,694,001 B (the 18 per-badge frame sweeps over 31
 * margins), superseded-margin summaries 2,242,402 B, `final.targets`
 * 858,667 B, and `registrations` 53,061 B -- none of them free, but none
 * estimated below either. Measured full-artifact rate: 47,121,103 B /
 * 12,826 observations = ~3,674 B/observation, so the 3000 estimate below
 * underestimates the real rate by ~18%. That means this pre-flight estimate
 * ALONE would not fire for observation counts in roughly [146k, 179k),
 * where the real JSON.stringify would still throw. It stays as a cheap
 * early exit -- most oversized libraries are caught before any stringify
 * work happens at all -- but it is no longer load-bearing by itself:
 * `libraryBytes()` also wraps the real JSON.stringify call in try/catch, so
 * a RangeError thrown in that gap still degrades to the sizeGuard UNKNOWN
 * artifact below instead of crashing the sweep.
 */
const ESTIMATED_BYTES_PER_RAW_OBSERVATION = 3000;

function totalRawObservationCount(value: MaterializedBadgeM2Library): number {
	let observationCount = 0;
	for (const margin of value.rawProbe?.trace.margins ?? []) observationCount += margin.observations?.length ?? 0;
	return observationCount;
}

/**
 * `run()` sets `library.rawProbe.representations` and top-level
 * `library.representations` to the SAME array by reference (the probe's own
 * `representations` field is where the value originates; the library just
 * names it again at the top level for callers that don't want to reach
 * through `rawProbe`). JSON.stringify does not dedupe references, so without
 * this the 18 representations would be embedded twice. Strip the nested
 * duplicate for the wire only -- `decodeMaterializedBadgeM2Library` rehydrates
 * it, so every in-memory/decoded consumer still sees a complete `rawProbe`.
 */
/** Wire-only marker: `rawProbe.representations` was elided because it is an
 *  exact reference duplicate of the top-level `representations` array;
 *  decodeMaterializedBadgeM2Library() rehydrates it from there. Exported so
 *  tests can assert on the raw wire bytes, not just the rehydrated decode. */
export const RAW_PROBE_REPRESENTATIONS_ELIDED = '$chainspotElidedDuplicateOf:representations' as const;

function libraryForWire(value: MaterializedBadgeM2Library): unknown {
	if (!value.rawProbe || value.rawProbe.representations !== value.representations) return value;
	return { ...value, rawProbe: { ...value.rawProbe, representations: RAW_PROBE_REPRESENTATIONS_ELIDED } };
}

/** Build the small sizeGuard-only library both libraryBytes() branches emit. */
function sizeGuardLibrary(
	value: MaterializedBadgeM2Library,
	estimatedBytes: number,
	observationCount: number,
	reason: string
): MaterializedBadgeM2Library {
	const trace = value.rawProbe?.trace;
	return {
		schema: value.schema,
		featureId: value.featureId,
		state: value.state,
		provenance: value.provenance,
		representations: [],
		sizeGuard: {
			status: 'UNKNOWN',
			reason,
			estimatedBytes,
			limitBytes: V8_MAX_STRING_LENGTH,
			observationCount,
			bytesPerObservation: ESTIMATED_BYTES_PER_RAW_OBSERVATION,
			marginCount: trace?.margins.length ?? 0,
			finalMarginPx: trace?.final.finalMarginPx ?? null,
			finalStatus: trace?.final.status ?? null,
			finalReason: trace?.final.reason ?? null,
			omitted: 'rawProbe (all margins/targets) and representations (all objects) were omitted from this artifact; per-run ctx.measure() numbers were still recorded on the RunTrace'
		}
	};
}

function libraryBytes(value: MaterializedBadgeM2Library): Uint8Array {
	const observationCount = totalRawObservationCount(value);
	const estimatedBytes = observationCount * ESTIMATED_BYTES_PER_RAW_OBSERVATION;
	if (estimatedBytes > V8_MAX_STRING_LENGTH) {
		return new TextEncoder().encode(
			JSON.stringify(
				sizeGuardLibrary(
					value,
					estimatedBytes,
					observationCount,
					'estimated serialized size exceeds V8 max string length; JSON.stringify was not attempted to avoid crashing the sweep'
				)
			)
		);
	}
	try {
		return new TextEncoder().encode(
			JSON.stringify(libraryForWire(value), (_key, field: unknown) =>
				field instanceof Uint32Array
					? { $chainspotTypedArray: 'u32', data: Array.from(field) }
					: field
			)
		);
	} catch (error) {
		// The pre-flight estimate above is a cheap heuristic, not an exact
		// accounting -- measured ~18% low on the real DashsTrack artifact
		// (see the comment above ESTIMATED_BYTES_PER_RAW_OBSERVATION) -- so it
		// can clear the check above while the real JSON.stringify still hits
		// V8's max string length. Catch that RangeError specifically and
		// degrade to the same loud sizeGuard artifact instead of crashing.
		if (!(error instanceof RangeError)) throw error;
		return new TextEncoder().encode(
			JSON.stringify(
				sizeGuardLibrary(
					value,
					estimatedBytes,
					observationCount,
					`estimated size (${estimatedBytes} B, under the ${V8_MAX_STRING_LENGTH} B limit) cleared the pre-flight check but the real JSON.stringify threw RangeError: ${error.message}`
				)
			)
		);
	}
}

export function encodeMaterializedBadgeM2Library(value: MaterializedBadgeM2Library): Uint8Array {
	return libraryBytes(value);
}

export function decodeMaterializedBadgeM2Library(bytes: Uint8Array): MaterializedBadgeM2Library {
	const value = JSON.parse(new TextDecoder().decode(bytes), (_key, field: unknown) => {
		if (!field || typeof field !== 'object' || !('$chainspotTypedArray' in field)) return field;
		const tagged = field as { readonly $chainspotTypedArray: unknown; readonly data: unknown };
		if (tagged.$chainspotTypedArray !== 'u32' || !Array.isArray(tagged.data))
			throw new Error(`${BADGE_M2_AA_FEATURE_ID}: unsupported typed-array payload`);
		return Uint32Array.from(tagged.data);
	}) as MaterializedBadgeM2Library;
	if (value.schema !== BADGE_M2_AA_LIBRARY_SCHEMA)
		throw new Error(`${BADGE_M2_AA_FEATURE_ID}: unsupported library schema '${String(value.schema)}'`);
	if (value.featureId !== BADGE_M2_AA_FEATURE_ID)
		throw new Error(`${BADGE_M2_AA_FEATURE_ID}: library has wrong feature id`);
	// Rehydrate the reference libraryForWire() elided: the wire form marks
	// rawProbe.representations instead of re-embedding it (it is identical to
	// the top-level array), so a decoded rawProbe still satisfies its type.
	if (value.rawProbe && (value.rawProbe.representations as unknown) === RAW_PROBE_REPRESENTATIONS_ELIDED)
		return { ...value, rawProbe: { ...value.rawProbe, representations: value.representations } };
	return value;
}

function disabledLibrary(library: BadgeEvidenceLibraryInput): MaterializedBadgeM2Library {
	return {
		schema: BADGE_M2_AA_LIBRARY_SCHEMA,
		featureId: BADGE_M2_AA_FEATURE_ID,
		state: 'disabled',
		provenance: sourceProvenance(library),
		representations: []
	};
}

/** Named aggregates are diagnostics; the reviewed raw probe remains authoritative. */
function measureRawProbe(ctx: FeatureContext, rawProbe: MaterializedExpandedBadgeRawFrameProbe): void {
	const trace = rawProbe.trace;
	ctx.measure('badgeEvidence', 'm2RawSampleCount', trace.registrations.length);
	ctx.measure('badgeEvidence', 'm2RawMarginCount', trace.margins.length);
	ctx.measure('badgeEvidence', 'm2RawFinalExactSupported', trace.final.exactSupportedCoordinates.length);
	ctx.measure('badgeEvidence', 'm2RawFinalQuantizedDiagnostic', trace.final.quantizedSupportedCoordinates.length);
	ctx.measure('badgeEvidence', 'm2RawFinalMarginPx', trace.final.finalMarginPx ?? -1);
	ctx.measure('badgeEvidence', 'm2RawOwnershipPromoted', trace.final.ownership.promoted ? 1 : 0);
	// Evidence-retention accounting (schema v2): m2RawMarginCount margins were
	// swept, but only the one whose marginPx equals m2RawFinalMarginPx retains
	// full per-pixel observations -- every other margin retains a summary
	// only. m2RawFinalMarginObservationCount is that one margin's per-pixel
	// count; it is the loud, provenance-backed version of the evidence-
	// retention statement (see EVIDENCE-RETENTION POLICY in m2Representation.ts).
	const finalMargin = trace.margins.find((margin) => margin.marginPx === trace.final.finalMarginPx);
	ctx.measure('badgeEvidence', 'm2RawFinalMarginObservationCount', finalMargin?.observations?.length ?? -1);
	ctx.measure(
		'badgeEvidence',
		'm2RawSupersededMarginsSummaryOnlyCount',
		Math.max(0, trace.margins.length - (finalMargin?.observations ? 1 : 0))
	);
	if (rawProbe.statistics) {
		ctx.measure('badgeEvidence', 'm2RawControlReplicates', rawProbe.statistics.replicateCount);
		ctx.measure('badgeEvidence', 'm2RawControlMeasured', rawProbe.statistics.status === 'measured' ? 1 : 0);
		const finalControl = rawProbe.statistics.margins.find((margin) => margin.marginPx === trace.final.finalMarginPx);
		const exact18 = finalControl?.bySupportThreshold['18'];
		if (exact18) {
			ctx.measure('badgeEvidence', 'm2RawControlExact18GlobalObserved', exact18.globalMaxExactOverlap.observed);
			ctx.measure('badgeEvidence', 'm2RawControlExact18GlobalEmpiricalP', exact18.globalMaxExactOverlap.empiricalP);
			ctx.measure('badgeEvidence', 'm2RawControlExact18ClusterObserved', exact18.largestEightConnectedCluster.observed);
			ctx.measure('badgeEvidence', 'm2RawControlExact18ClusterEmpiricalP', exact18.largestEightConnectedCluster.empiricalP);
		}
	}
	for (const margin of trace.margins) {
		ctx.measure('badgeEvidence', 'm2RawBoundaryExactSupported', margin.exactBoundary.total);
		ctx.measure('badgeEvidence', 'm2RawBoundaryUnknownSamples', margin.unobservedSampleCount);
	}
	for (const target of trace.final.targets) {
		ctx.measure('badgeEvidence', 'm2RawPartitionM1Owned', target.partition.counts['m1-owned']);
		ctx.measure('badgeEvidence', 'm2RawPartitionOldAa', target.partition.counts['old-aa']);
		ctx.measure('badgeEvidence', 'm2RawPartitionOldResidue', target.partition.counts['old-residue']);
		ctx.measure('badgeEvidence', 'm2RawPartitionExterior', target.partition.counts.exterior);
	}
}

const badgeM2AaRender: FeatureRender = {
	units: ['badgeEvidence'],
	draw(unit: UnitTrace, _run: RunTrace) {
		return {
			title: 'Badge M2 raw expanded-frame probe',
			layers: [
				{
					name: 'Raw-frame measurements',
					note: 'The content-addressed raw probe trace owns its pixels, partitions, and boundary verdicts.',
					drawables: unit.drawables
				}
			],
			notes: [
				'Exact decoded RGBA tuple recurrence is the authoritative baseline; it is sensitive to JPEG recompression.',
				'Quantized RGBA is a visibly labeled diagnostic only and never controls adequacy or ownership.',
				'M1 is preserved exactly; old AA/residue labels are applied only after raw-frame discovery.',
				'Ownership requires an adequate frame, exact 18/18 raw RGBA support, and a passing deterministic circular-shift control; lower support remains graded evidence.'
			]
		};
	}
};

/** Default-OFF measurement; M1 and all downstream detector behavior remain untouched. */
export const badgeM2AaFeature = {
	id: BADGE_M2_AA_FEATURE_ID,
	gate: 'G5',
	kind: 'deviation',
	defaultEnabled: false,
	resolveOnlyWhenConfigured: true,
	note: 'Default-OFF Badge raw expanded-frame probe: direct source RGBA recurrence beyond the old bbox±1 crop, exact glyph-only masking, deterministic circular-shift control, and post-discovery M1/AA/residue/exterior partitioning. Only adequate, exact 18/18, control-significant pixels may become M2-owned.',
	knobs: {},
	render: badgeM2AaRender
} satisfies ABFeature;

/**
 * Production operation. It obtains `image` before the OFF gate so declared
 * and actual evidence custody match in both states. It never writes M1.
 */
export const badgeM2AaOperation: ABFeatureOperation = {
	spec: {
		id: 'badgeEvidence.m2Aa',
		kind: 'materialize',
		gate: 'G5',
		unit: 'badgeEvidence',
		consumes: ['image', 'badgeEvidence.library'],
		produces: ['badgeEvidence.m2Library'],
		features: [BADGE_M2_AA_FEATURE_ID],
		note: 'materialize default-OFF raw RGBA expanded-frame badge recurrence and post-discovery partition trace'
	},
	run(board: ExecBoard, ctx: FeatureContext) {
		const image = board.get<RgbaImage>('image');
		const library = board.get<BadgeEvidenceLibraryInput>('badgeEvidence.library');
		const state = ctx.resolve(badgeM2AaFeature);
		if (!state.enabled) {
			board.set('badgeEvidence.m2Library', disabledLibrary(library));
			ctx.measure('badgeEvidence', 'm2RawDisabled', 1);
			return;
		}
		for (const specimen of library.badges) assertM1Control(specimen, library.m1);
		const rawProbe = materializeExpandedBadgeRawFrameProbeWithControl({
			image,
			specimens: library.badges,
			m1: library.m1,
			options: {
				control: {
					replicates: 999,
					supportThresholds: [2, 18],
					alpha: 0.05
				}
			}
		});
		measureRawProbe(ctx, rawProbe);
		const source = sourceProvenance(library);
		if (
			source.imageId !== library.m1.provenance.imageId ||
			source.paramsHash !== library.m1.provenance.paramsHash
		)
			throw new Error(`${BADGE_M2_AA_FEATURE_ID}: M1/B+W provenance drift`);
		board.set('badgeEvidence.m2Library', {
			schema: BADGE_M2_AA_LIBRARY_SCHEMA,
			featureId: BADGE_M2_AA_FEATURE_ID,
			state: rawProbe.state,
			provenance: source,
			rawProbe,
			representations: rawProbe.representations
		} satisfies MaterializedBadgeM2Library);
	},
	extractArtifacts(board: ExecBoard): readonly OperationArtifact[] {
		const library = board.get<MaterializedBadgeM2Library>('badgeEvidence.m2Library');
		return [
			{
				kind: 'measurementTable',
				id: `badgeM2RawFrame.library.${library.provenance.imageId.slice(0, 12)}`,
				bytes: encodeMaterializedBadgeM2Library(library)
			},
			...library.representations.map((representation) => ({
				kind: 'm2Representation' as const,
				id: `m2Representation.${library.provenance.imageId.slice(0, 12)}.${representation.objectId}`,
				bytes: encodeMaterializedBadgeM2Representation(representation)
			}))
		];
	}
};
