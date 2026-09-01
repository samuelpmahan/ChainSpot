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
export const BADGE_M2_AA_LIBRARY_SCHEMA = 'chainspot.badge-m2-raw-frame-library/v1' as const;

export interface MaterializedBadgeM2Library {
	readonly schema: typeof BADGE_M2_AA_LIBRARY_SCHEMA;
	readonly featureId: typeof BADGE_M2_AA_FEATURE_ID;
	readonly state: 'disabled' | 'materialized' | 'insufficient';
	readonly provenance: {
		readonly imageId: string;
		readonly paramsHash: string;
		readonly source: 'full source RGBA expanded-frame recurrence';
	};
	/** Undefined only when explicitly disabled. This is the one raw discovery trace. */
	readonly rawProbe?: MaterializedExpandedBadgeRawFrameProbe;
	/**
	 * Compatibility/control projections. M1 remains exact. A newly discovered
	 * raw pixel is promoted only when the final adequate frame has exact 18/18
	 * support and its deterministic circular-shift control passes.
	 */
	readonly representations: readonly MaterializedBadgeM2Representation[];
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

function libraryBytes(value: MaterializedBadgeM2Library): Uint8Array {
	return new TextEncoder().encode(
		JSON.stringify(value, (_key, field: unknown) =>
			field instanceof Uint32Array
				? { $chainspotTypedArray: 'u32', data: Array.from(field) }
				: field
		)
	);
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
