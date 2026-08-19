import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { canonicalJson } from './canonicalJson';
import { entityKey, newRunId, type EntityRef } from './identity';
import type { StoredObjectDescriptor } from './objectStore';
import { validateOracleObservation, type OracleObservationV1 } from './oracle';
import type { ResolvedImplementationCombination } from './race';
import type { RegisteredImplementation } from './registry';

const SCHEMA_VERSION = 1;

export interface ExperimentRecord {
	readonly experimentHash: string;
	readonly resolvedManifestObjectHash: string;
	readonly resolvedSuiteObjectHash: string;
	readonly registryResolution: unknown;
}

export interface StartRunInput {
	readonly experimentHash: string;
	readonly repoSha: string;
	readonly hostSnapshot: unknown;
}

export class LabLedger {
	private readonly database: DatabaseSync;

	constructor(path: string) {
		mkdirSync(dirname(path), { recursive: true });
		this.database = new DatabaseSync(path);
		this.database.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
		this.migrate();
	}

	close(): void {
		this.database.close();
	}

	recordImplementation(implementation: RegisteredImplementation): void {
		this.database
			.prepare(`
				INSERT OR IGNORE INTO implementations (
					implementation_key, id, version, node_type, language, entrypoint,
					source_digest, sources_json, resources_json
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
			`)
			.run(
				implementation.implementationKey,
				implementation.id,
				implementation.version,
				implementation.nodeType,
				implementation.language,
				implementation.entrypoint,
				implementation.sourceDigest,
				canonicalJson(implementation.sourceEntries),
				canonicalJson(implementation.resources)
			);
	}

	recordObject(descriptor: StoredObjectDescriptor, relativePath: string): void {
		this.database
			.prepare(`
				INSERT OR IGNORE INTO objects (
					hash, kind, encoding, payload_sha256, payload_bytes, relative_path
				) VALUES (?, ?, ?, ?, ?, ?)
			`)
			.run(
				descriptor.hash,
				descriptor.kind,
				descriptor.encoding,
				descriptor.payloadSha256,
				descriptor.payloadBytes,
				relativePath
			);
	}

	recordExperiment(record: ExperimentRecord): void {
		this.database
			.prepare(`
				INSERT OR IGNORE INTO experiments (
					experiment_hash, resolved_manifest_object_hash, resolved_suite_object_hash,
					registry_resolution_json
				) VALUES (?, ?, ?, ?)
			`)
			.run(
				record.experimentHash,
				record.resolvedManifestObjectHash,
				record.resolvedSuiteObjectHash,
				canonicalJson(record.registryResolution)
			);
	}

	startRun(input: StartRunInput): string {
		const runId = newRunId();
		this.database
			.prepare(`
				INSERT INTO runs (run_id, experiment_hash, repo_sha, host_snapshot_json, status)
				VALUES (?, ?, ?, ?, 'running')
			`)
			.run(runId, input.experimentHash, input.repoSha, canonicalJson(input.hostSnapshot));
		return runId;
	}

	getCacheEntry(invocationKey: string): string | null {
		const row = this.database
			.prepare('SELECT output_hash FROM cache_entries WHERE invocation_key = ?')
			.get(invocationKey) as { output_hash: string } | undefined;
		return row?.output_hash ?? null;
	}

	putCacheEntry(invocationKey: string, outputHash: string): void {
		this.database
			.prepare('INSERT OR IGNORE INTO cache_entries (invocation_key, output_hash) VALUES (?, ?)')
			.run(invocationKey, outputHash);
		const recorded = this.getCacheEntry(invocationKey);
		if (recorded !== outputHash) {
			throw new Error(`Immutable cache conflict for ${invocationKey}: ${recorded} != ${outputHash}`);
		}
	}

	recordEntity(ref: EntityRef, kind: string, payload: unknown): string {
		const key = entityKey(ref);
		this.database
			.prepare(`
				INSERT OR IGNORE INTO entities (
					entity_key, producer_object_hash, local_id, kind, payload_json
				) VALUES (?, ?, ?, ?, ?)
			`)
			.run(key, ref.producerObjectHash, ref.localId, kind, canonicalJson(payload));
		return key;
	}

	recordEntityLineage(child: EntityRef, parent: EntityRef, relation: string): void {
		this.database
			.prepare(`
				INSERT OR IGNORE INTO entity_lineage (child_entity_key, parent_entity_key, relation)
				VALUES (?, ?, ?)
			`)
			.run(entityKey(child), entityKey(parent), relation);
	}

	recordImplementationCombination(combination: ResolvedImplementationCombination): void {
		this.database
			.prepare(`
				INSERT OR IGNORE INTO implementation_combinations (
					combination_hash, slots_json, compatibility_status, incompatibility_reason
				) VALUES (?, ?, ?, ?)
			`)
			.run(
				combination.combinationHash,
				canonicalJson(combination.slots),
				combination.applicability.status === 'applicable' ? 'compatible' : 'incompatible',
				combination.applicability.status === 'not_applicable'
					? canonicalJson(combination.applicability)
					: null
			);
	}

	linkExperimentCombination(experimentHash: string, combinationHash: string): void {
		this.database
			.prepare(`
				INSERT OR IGNORE INTO experiment_combinations (experiment_hash, combination_hash)
				VALUES (?, ?)
			`)
			.run(experimentHash, combinationHash);
	}

	recordOracleObservation(descriptor: StoredObjectDescriptor, observation: OracleObservationV1): void {
		validateOracleObservation(descriptor, observation);
		const existing = this.database
			.prepare(`
				SELECT observation_object_hash
				FROM oracle_observations
				WHERE observation_id = ? AND observation_version = ?
			`)
			.get(observation.observationId, observation.version) as
			| { observation_object_hash: string }
			| undefined;
		if (existing && existing.observation_object_hash !== descriptor.hash) {
			throw new Error(
				`Oracle observation version conflict for ${observation.observationId}@${observation.version}`
			);
		}

		if (observation.supersedesObservationObjectHash) {
			const prior = this.database
				.prepare(`
					SELECT observation_id, observation_version
					FROM oracle_observations
					WHERE observation_object_hash = ?
				`)
				.get(observation.supersedesObservationObjectHash) as
				| { observation_id: string; observation_version: number }
				| undefined;
			if (
				!prior ||
				prior.observation_id !== observation.observationId ||
				prior.observation_version >= observation.version
			) {
				throw new Error('Oracle revision must supersede an older version of the same observation');
			}
		}

		this.database.exec('BEGIN IMMEDIATE');
		try {
			this.database
				.prepare(`
					INSERT OR IGNORE INTO oracle_observations (
						observation_object_hash, observation_id, observation_version,
						supersedes_object_hash, evidence_role, classification_code,
						classification_json, corrected_geometry_json,
						rendering_attribution_json, reviewer_json, notes
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				`)
				.run(
					descriptor.hash,
					observation.observationId,
					observation.version,
					observation.supersedesObservationObjectHash ?? null,
					observation.evidenceRole,
					observation.classification.code,
					canonicalJson(observation.classification),
					observation.correctedGeometry ? canonicalJson(observation.correctedGeometry) : null,
					canonicalJson(observation.renderingAttribution),
					canonicalJson(observation.reviewer),
					observation.notes ?? null
				);

			const entityStatement = this.database.prepare(`
				INSERT OR IGNORE INTO oracle_observation_entities (
					observation_object_hash, entity_key, evidence_role
				) VALUES (?, ?, ?)
			`);
			for (const source of observation.prompt.entities) {
				entityStatement.run(descriptor.hash, entityKey(source.ref), source.role);
			}

			const objectStatement = this.database.prepare(`
				INSERT OR IGNORE INTO oracle_observation_evidence_objects (
					observation_object_hash, evidence_object_hash, evidence_role
				) VALUES (?, ?, ?)
			`);
			for (const source of observation.prompt.evidenceObjects) {
				objectStatement.run(descriptor.hash, source.objectHash, source.role);
			}

			const artifactStatement = this.database.prepare(`
				INSERT OR IGNORE INTO oracle_observation_artifacts (
					observation_object_hash, artifact_object_hash, artifact_role
				) VALUES (?, ?, ?)
			`);
			for (const artifact of observation.prompt.artifacts) {
				artifactStatement.run(descriptor.hash, artifact.objectHash, artifact.role);
			}

			const tagStatement = this.database.prepare('INSERT OR IGNORE INTO oracle_tags (tag) VALUES (?)');
			const observationTagStatement = this.database.prepare(`
				INSERT OR IGNORE INTO oracle_observation_tags (observation_object_hash, tag)
				VALUES (?, ?)
			`);
			for (const tag of observation.tags) {
				tagStatement.run(tag);
				observationTagStatement.run(descriptor.hash, tag);
			}
			this.database.exec('COMMIT');
		} catch (error) {
			this.database.exec('ROLLBACK');
			throw error;
		}
	}

	private migrate(): void {
		this.database.exec(`
			CREATE TABLE IF NOT EXISTS schema_versions (
				version INTEGER PRIMARY KEY,
				applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
			);
			CREATE TABLE IF NOT EXISTS implementations (
				implementation_key TEXT PRIMARY KEY,
				id TEXT NOT NULL,
				version TEXT NOT NULL,
				node_type TEXT NOT NULL,
				language TEXT NOT NULL,
				entrypoint TEXT NOT NULL,
				source_digest TEXT NOT NULL,
				sources_json TEXT NOT NULL,
				resources_json TEXT NOT NULL,
				registered_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
			);
			CREATE TABLE IF NOT EXISTS objects (
				hash TEXT PRIMARY KEY,
				kind TEXT NOT NULL,
				encoding TEXT NOT NULL,
				payload_sha256 TEXT NOT NULL,
				payload_bytes INTEGER NOT NULL,
				relative_path TEXT NOT NULL,
				created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
			);
			CREATE TABLE IF NOT EXISTS cache_entries (
				invocation_key TEXT PRIMARY KEY,
				output_hash TEXT NOT NULL REFERENCES objects(hash),
				created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
			);
			CREATE TABLE IF NOT EXISTS experiments (
				experiment_hash TEXT PRIMARY KEY,
				resolved_manifest_object_hash TEXT NOT NULL REFERENCES objects(hash),
				resolved_suite_object_hash TEXT NOT NULL REFERENCES objects(hash),
				registry_resolution_json TEXT NOT NULL,
				created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
			);
			CREATE TABLE IF NOT EXISTS runs (
				run_id TEXT PRIMARY KEY,
				experiment_hash TEXT NOT NULL REFERENCES experiments(experiment_hash),
				repo_sha TEXT NOT NULL,
				host_snapshot_json TEXT NOT NULL,
				status TEXT NOT NULL,
				started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
				completed_at TEXT
			);
			CREATE TABLE IF NOT EXISTS run_nodes (
				run_id TEXT NOT NULL REFERENCES runs(run_id),
				node_id TEXT NOT NULL,
				invocation_key TEXT,
				node_type TEXT NOT NULL,
				implementation_key TEXT REFERENCES implementations(implementation_key),
				output_hash TEXT REFERENCES objects(hash),
				status TEXT NOT NULL,
				applicability_reason TEXT,
				cache_status TEXT,
				runtime_ms REAL,
				declared_resources_json TEXT,
				observed_resources_json TEXT,
				error_json TEXT,
				PRIMARY KEY (run_id, node_id)
			);
			CREATE TABLE IF NOT EXISTS node_inputs (
				run_id TEXT NOT NULL,
				node_id TEXT NOT NULL,
				input_order INTEGER NOT NULL,
				input_hash TEXT NOT NULL REFERENCES objects(hash),
				PRIMARY KEY (run_id, node_id, input_order),
				FOREIGN KEY (run_id, node_id) REFERENCES run_nodes(run_id, node_id)
			);
			CREATE TABLE IF NOT EXISTS entities (
				entity_key TEXT PRIMARY KEY,
				producer_object_hash TEXT NOT NULL REFERENCES objects(hash),
				local_id TEXT NOT NULL,
				kind TEXT NOT NULL,
				payload_json TEXT NOT NULL,
				UNIQUE (producer_object_hash, local_id)
			);
			CREATE TABLE IF NOT EXISTS entity_lineage (
				child_entity_key TEXT NOT NULL REFERENCES entities(entity_key),
				parent_entity_key TEXT NOT NULL REFERENCES entities(entity_key),
				relation TEXT NOT NULL,
				PRIMARY KEY (child_entity_key, parent_entity_key, relation)
			);
			CREATE TABLE IF NOT EXISTS run_node_entities (
				run_id TEXT NOT NULL,
				node_id TEXT NOT NULL,
				entity_key TEXT NOT NULL REFERENCES entities(entity_key),
				PRIMARY KEY (run_id, node_id, entity_key),
				FOREIGN KEY (run_id, node_id) REFERENCES run_nodes(run_id, node_id)
			);
			CREATE TABLE IF NOT EXISTS metrics (
				run_id TEXT NOT NULL REFERENCES runs(run_id),
				scope_type TEXT NOT NULL,
				scope_id TEXT NOT NULL,
				name TEXT NOT NULL,
				value REAL NOT NULL,
				unit TEXT,
				slice_json TEXT,
				PRIMARY KEY (run_id, scope_type, scope_id, name)
			);
			CREATE TABLE IF NOT EXISTS artifacts (
				run_id TEXT NOT NULL,
				node_id TEXT NOT NULL,
				name TEXT NOT NULL,
				object_hash TEXT NOT NULL REFERENCES objects(hash),
				entity_key TEXT REFERENCES entities(entity_key),
				PRIMARY KEY (run_id, node_id, name),
				FOREIGN KEY (run_id, node_id) REFERENCES run_nodes(run_id, node_id)
			);
			CREATE TABLE IF NOT EXISTS implementation_combinations (
				combination_hash TEXT PRIMARY KEY,
				slots_json TEXT NOT NULL,
				compatibility_status TEXT NOT NULL CHECK (compatibility_status IN ('compatible', 'incompatible')),
				incompatibility_reason TEXT,
				created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
			);
			CREATE TABLE IF NOT EXISTS experiment_combinations (
				experiment_hash TEXT NOT NULL REFERENCES experiments(experiment_hash),
				combination_hash TEXT NOT NULL REFERENCES implementation_combinations(combination_hash),
				PRIMARY KEY (experiment_hash, combination_hash)
			);
			CREATE TABLE IF NOT EXISTS run_node_combinations (
				run_id TEXT NOT NULL,
				node_id TEXT NOT NULL,
				combination_hash TEXT NOT NULL REFERENCES implementation_combinations(combination_hash),
				PRIMARY KEY (run_id, node_id, combination_hash),
				FOREIGN KEY (run_id, node_id) REFERENCES run_nodes(run_id, node_id)
			);
			CREATE TABLE IF NOT EXISTS oracle_observations (
				observation_object_hash TEXT PRIMARY KEY REFERENCES objects(hash),
				observation_id TEXT NOT NULL,
				observation_version INTEGER NOT NULL,
				supersedes_object_hash TEXT REFERENCES oracle_observations(observation_object_hash),
				evidence_role TEXT NOT NULL CHECK (evidence_role IN ('discovery', 'calibration')),
				classification_code TEXT NOT NULL,
				classification_json TEXT NOT NULL,
				corrected_geometry_json TEXT,
				rendering_attribution_json TEXT NOT NULL,
				reviewer_json TEXT NOT NULL,
				notes TEXT,
				created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
				UNIQUE (observation_id, observation_version)
			);
			CREATE TABLE IF NOT EXISTS oracle_observation_entities (
				observation_object_hash TEXT NOT NULL REFERENCES oracle_observations(observation_object_hash),
				entity_key TEXT NOT NULL REFERENCES entities(entity_key),
				evidence_role TEXT NOT NULL,
				PRIMARY KEY (observation_object_hash, entity_key, evidence_role)
			);
			CREATE TABLE IF NOT EXISTS oracle_observation_evidence_objects (
				observation_object_hash TEXT NOT NULL REFERENCES oracle_observations(observation_object_hash),
				evidence_object_hash TEXT NOT NULL REFERENCES objects(hash),
				evidence_role TEXT NOT NULL,
				PRIMARY KEY (observation_object_hash, evidence_object_hash, evidence_role)
			);
			CREATE TABLE IF NOT EXISTS oracle_observation_artifacts (
				observation_object_hash TEXT NOT NULL REFERENCES oracle_observations(observation_object_hash),
				artifact_object_hash TEXT NOT NULL REFERENCES objects(hash),
				artifact_role TEXT NOT NULL,
				PRIMARY KEY (observation_object_hash, artifact_object_hash, artifact_role)
			);
			CREATE TABLE IF NOT EXISTS oracle_tags (
				tag TEXT PRIMARY KEY
			);
			CREATE TABLE IF NOT EXISTS oracle_observation_tags (
				observation_object_hash TEXT NOT NULL REFERENCES oracle_observations(observation_object_hash),
				tag TEXT NOT NULL REFERENCES oracle_tags(tag),
				PRIMARY KEY (observation_object_hash, tag)
			);
			CREATE INDEX IF NOT EXISTS oracle_observation_tags_by_tag
				ON oracle_observation_tags (tag, observation_object_hash);
			CREATE INDEX IF NOT EXISTS oracle_observations_by_classification
				ON oracle_observations (classification_code, observation_object_hash);
			CREATE TABLE IF NOT EXISTS oracle_evaluations (
				run_id TEXT NOT NULL,
				evaluation_node_id TEXT NOT NULL,
				observation_object_hash TEXT NOT NULL REFERENCES oracle_observations(observation_object_hash),
				combination_hash TEXT NOT NULL REFERENCES implementation_combinations(combination_hash),
				status TEXT NOT NULL,
				outcome_code TEXT,
				result_entity_key TEXT REFERENCES entities(entity_key),
				details_json TEXT,
				PRIMARY KEY (run_id, observation_object_hash, combination_hash),
				FOREIGN KEY (run_id, evaluation_node_id) REFERENCES run_nodes(run_id, node_id)
			);
			CREATE INDEX IF NOT EXISTS oracle_evaluations_by_observation
				ON oracle_evaluations (observation_object_hash, combination_hash, run_id);
			CREATE TABLE IF NOT EXISTS truth_sets (
				truth_set_object_hash TEXT PRIMARY KEY REFERENCES objects(hash),
				name TEXT NOT NULL,
				evidence_role TEXT NOT NULL CHECK (
					evidence_role IN ('training', 'calibration', 'held_out_validation')
				),
				created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
			);
			CREATE TABLE IF NOT EXISTS truth_set_members (
				truth_set_object_hash TEXT NOT NULL REFERENCES truth_sets(truth_set_object_hash),
				truth_object_hash TEXT NOT NULL REFERENCES objects(hash),
				subject_key TEXT NOT NULL,
				PRIMARY KEY (truth_set_object_hash, subject_key)
			);
		`);
		this.database.prepare('INSERT OR IGNORE INTO schema_versions (version) VALUES (?)').run(SCHEMA_VERSION);
	}
}
