import { canonicalJson } from './canonicalJson';
import { sha256Bytes } from './hashing';
import { SHA256_PATTERN, entityKey, type EntityRef } from './identity';
import type { StoredObjectDescriptor } from './objectStore';

/** Oracle evidence is never labeled as untouched validation truth. */
export type OracleEvidenceRole = 'discovery' | 'calibration';

export interface OracleReviewer {
	readonly kind: 'human' | 'model' | 'hybrid';
	readonly id: string;
	readonly version?: string;
	readonly sourceDigest?: string;
}

export interface OracleRenderingAttribution {
	/** Render family such as `basket-sprite`, `screen-chrome`, or `c2-semicircle`. */
	readonly layer: string;
	readonly assessment: string;
	readonly confidence?: number;
}

export interface OracleCorrectedGeometry {
	readonly coordinateFrame: 'source-raster' | 'viewport';
	readonly geometryType: string;
	readonly value: unknown;
}

export interface OracleObservationV1 {
	readonly oracleObservationSchemaVersion: 1;
	/** Stable case identity; revisions retain this ID and increment `version`. */
	readonly observationId: string;
	readonly version: number;
	readonly supersedesObservationObjectHash?: string;
	readonly evidenceRole: OracleEvidenceRole;
	readonly reviewer: OracleReviewer;
	readonly prompt: {
		readonly entities: readonly {
			readonly ref: EntityRef;
			readonly role: string;
		}[];
		readonly evidenceObjects: readonly {
			readonly objectHash: string;
			readonly role: string;
		}[];
		readonly artifacts: readonly {
			readonly objectHash: string;
			/** For example `source-crop`, `overlay`, or `raw-raster`. */
			readonly role: string;
		}[];
	};
	readonly classification: {
		/** Extensible code such as `plausible-false` or `basket-furniture`. */
		readonly code: string;
		readonly detail?: unknown;
	};
	readonly correctedGeometry?: OracleCorrectedGeometry;
	readonly renderingAttribution: readonly OracleRenderingAttribution[];
	readonly notes?: string;
	/** Multi-valued slices such as `basket-overlap` and `hard-negative`. */
	readonly tags: readonly string[];
}

export function validateOracleObservation(
	descriptor: StoredObjectDescriptor,
	observation: OracleObservationV1
): void {
	if (descriptor.kind !== 'oracle.observation.v1' || descriptor.encoding !== 'json') {
		throw new TypeError('Oracle observation must be stored as oracle.observation.v1 JSON');
	}
	if (descriptor.payloadSha256 !== sha256Bytes(canonicalJson(observation))) {
		throw new TypeError('Oracle observation payload does not match its immutable object descriptor');
	}
	if (observation.oracleObservationSchemaVersion !== 1) throw new TypeError('Unsupported oracle schema');
	if (observation.observationId.length === 0 || observation.observationId.trim() !== observation.observationId) {
		throw new TypeError('Oracle observationId is invalid');
	}
	if (!Number.isInteger(observation.version) || observation.version < 1) {
		throw new TypeError('Oracle observation version must be a positive integer');
	}
	if (observation.version === 1 && observation.supersedesObservationObjectHash) {
		throw new TypeError('Oracle observation version 1 cannot supersede another observation');
	}
	if (observation.version > 1 && !observation.supersedesObservationObjectHash) {
		throw new TypeError('Oracle observation revisions must identify the superseded object');
	}
	if (
		observation.supersedesObservationObjectHash &&
		!SHA256_PATTERN.test(observation.supersedesObservationObjectHash)
	) {
		throw new TypeError('Invalid superseded oracle observation hash');
	}
	if (observation.evidenceRole !== 'discovery' && observation.evidenceRole !== 'calibration') {
		throw new TypeError('Oracle evidence role must be discovery or calibration');
	}
	if (observation.classification.code.length === 0) throw new TypeError('Oracle classification is required');
	if (
		observation.prompt.entities.length +
			observation.prompt.evidenceObjects.length +
			observation.prompt.artifacts.length ===
		0
	) {
		throw new TypeError('Oracle observation must preserve the evidence that prompted review');
	}
	for (const source of observation.prompt.entities) {
		entityKey(source.ref);
		if (source.role.length === 0) throw new TypeError('Oracle entity evidence role is required');
	}
	for (const source of [...observation.prompt.evidenceObjects, ...observation.prompt.artifacts]) {
		if (!SHA256_PATTERN.test(source.objectHash)) throw new TypeError('Invalid oracle evidence object hash');
		if (source.role.length === 0) throw new TypeError('Oracle object evidence role is required');
	}
	const uniqueTags = new Set(observation.tags);
	if (uniqueTags.size !== observation.tags.length) throw new TypeError('Oracle tags must be unique');
	for (const tag of observation.tags) {
		if (tag.length === 0 || tag.trim() !== tag) throw new TypeError('Oracle tag is invalid');
	}
}
