import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
	ImmutableObjectStore,
	ImplementationRegistry,
	LabLedger,
	canonicalJson,
	computeExperimentHash,
	computeInvocationKey,
	entityKey,
	expandCartesianRace,
	hashCanonical,
	stableLocalEntityId,
	type OracleObservationV1
} from '../../scripts/chainspot-lab/core';

const temporaryRoots: string[] = [];

function temporaryRoot(name: string): string {
	const root = join(tmpdir(), `chainspot-lab-${name}-${crypto.randomUUID()}`);
	mkdirSync(root, { recursive: true });
	temporaryRoots.push(root);
	return root;
}

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('canonical experiment and invocation identity', () => {
	it('sorts object keys but preserves array order', () => {
		expect(canonicalJson({ b: 2, a: 1 })).toBe(canonicalJson({ a: 1, b: 2 }));
		expect(canonicalJson({ values: [1, 2] })).not.toBe(canonicalJson({ values: [2, 1] }));
		expect(() => canonicalJson([1, , 2])).toThrow(/Unsupported value/);
	});

	it('keeps experiment identity deterministic while parameters invalidate one invocation', () => {
		const experiment = {
			experimentHashSchemaVersion: 1 as const,
			resolvedManifest: { name: 'endpoint-dev5' },
			resolvedSuite: { courses: ['Alex', 'Heritage'] },
			registryResolution: { recovery: 'bbox-v2' }
		};
		expect(computeExperimentHash(experiment)).toBe(computeExperimentHash(experiment));

		const base = {
			cacheKeySchemaVersion: 1 as const,
			nodeType: 'tee.recovery',
			outputSchemaVersion: 1,
			implementation: { id: 'tee.recovery.bbox-v2', version: '2', sourceDigest: 'a'.repeat(64) },
			orderedInputObjectHashes: ['b'.repeat(64)],
			relevantEnvironment: { python: '3.12' }
		};
		expect(computeInvocationKey({ ...base, parameters: { scoreMin: 0.8 } })).not.toBe(
			computeInvocationKey({ ...base, parameters: { scoreMin: 0.81 } })
		);
	});
});

describe('immutable object store', () => {
	it('reuses identical content and detects tampering', () => {
		const root = temporaryRoot('objects');
		const store = new ImmutableObjectStore(root);
		const first = store.putJson('test.measurements.v1', { values: [3, 1, 4] });
		const second = store.putJson('test.measurements.v1', { values: [3, 1, 4] });
		expect(first.reused).toBe(false);
		expect(second.reused).toBe(true);
		expect(second.descriptor.hash).toBe(first.descriptor.hash);
		expect(store.readJson(first.descriptor.hash)).toEqual({ values: [3, 1, 4] });

		const payloadPath = join(
			root,
			'objects',
			'sha256',
			first.descriptor.hash.slice(0, 2),
			first.descriptor.hash.slice(2),
			'payload.json'
		);
		writeFileSync(payloadPath, '{"values":[9]}');
		expect(() => store.readJson(first.descriptor.hash)).toThrow(/payload/);
	});

	it('stores binary evidence outside SQLite', () => {
		const store = new ImmutableObjectStore(temporaryRoot('binary'));
		const stored = store.putBytes('mask.bright.v1', Uint8Array.from([0, 1, 1, 0]));
		expect([...store.readBytes(stored.descriptor.hash)]).toEqual([0, 1, 1, 0]);
	});
});

describe('implementation registry', () => {
	it('hashes the full declared behavior-bearing source set', () => {
		const repo = temporaryRoot('registry');
		mkdirSync(join(repo, 'src'));
		writeFileSync(join(repo, 'src', 'algorithm.py'), 'def run(): return 1\n');
		writeFileSync(join(repo, 'src', 'adapter.py'), 'from algorithm import run\n');
		const registration = {
			id: 'tee.recovery.example',
			version: '1',
			nodeType: 'tee.recovery',
			language: 'python' as const,
			entrypoint: 'src/adapter.py',
			sources: ['src/algorithm.py', 'src/adapter.py'],
			inputKinds: ['tee.candidates.v1'],
			outputKind: 'tee.recovery.v1',
			resources: { cpuCores: 1, ramMiB: 256, gpu: null }
		};
		const first = new ImplementationRegistry(repo).register(registration);
		writeFileSync(join(repo, 'src', 'adapter.py'), 'from algorithm import run\n# behavior change\n');
		const second = new ImplementationRegistry(repo).register(registration);
		expect(second.sourceDigest).not.toBe(first.sourceDigest);
		expect(second.implementationKey).not.toBe(first.implementationKey);
	});

	it('requires the adapter entrypoint in the declared source set', () => {
		const repo = temporaryRoot('registry-invalid');
		writeFileSync(join(repo, 'adapter.py'), 'print(1)\n');
		expect(() =>
			new ImplementationRegistry(repo).register({
				id: 'example',
				version: '1',
				nodeType: 'example',
				language: 'python',
				entrypoint: 'adapter.py',
				sources: ['different.py'],
				inputKinds: [],
				outputKind: 'example.v1',
				resources: { cpuCores: 1, ramMiB: 1, gpu: null }
			})
		).toThrow(/entrypoint/);
	});
});

describe('Cartesian implementation races', () => {
	it('preserves every historical combination and records incompatibility without a champion', () => {
		const combinations = expandCartesianRace(
			[
				{
					slotId: 'chrome',
					selections: [
						{ implementationKey: 'chrome.none', parameters: {} },
						{ implementationKey: 'chrome.screen-space-v1', parameters: {} }
					]
				},
				{
					slotId: 'teeRecovery',
					selections: [
						{ implementationKey: 'tee.recovery.bbox-v2', parameters: {} },
						{ implementationKey: 'tee.recovery.consensus50-v1', parameters: {} }
					]
				}
			],
			(slots) =>
				slots.some((slot) => slot.implementationKey === 'chrome.none') &&
				slots.some((slot) => slot.implementationKey === 'tee.recovery.consensus50-v1')
					? { status: 'not_applicable', reasonCode: 'requires-chrome-attribution' }
					: { status: 'applicable' }
		);
		expect(combinations).toHaveLength(4);
		expect(new Set(combinations.map((combination) => combination.combinationHash)).size).toBe(4);
		expect(combinations.filter((combination) => combination.applicability.status === 'not_applicable')).toHaveLength(1);
		expect(combinations.every((combination) => !('champion' in combination))).toBe(true);
	});
});

describe('ledger identities and entity lineage', () => {
	it('preserves separate runs for one experiment and immutable cache mappings', () => {
		const root = temporaryRoot('ledger');
		const store = new ImmutableObjectStore(join(root, 'store'));
		const manifest = store.putJson('experiment.manifest.resolved.v1', { name: 'dev5' }).descriptor;
		const suite = store.putJson('experiment.suite.resolved.v1', { courses: ['Alex'] }).descriptor;
		const outputA = store.putJson('tee.candidates.v1', { candidates: [] }).descriptor;
		const outputB = store.putJson('tee.candidates.v1', { candidates: [{ id: 'tee:ring:x10:y20' }] }).descriptor;
		const dbPath = join(root, 'ledger.sqlite');
		const ledger = new LabLedger(dbPath);
		for (const descriptor of [manifest, suite, outputA, outputB]) {
			ledger.recordObject(descriptor, `objects/${descriptor.hash}`);
		}
		const experimentHash = hashCanonical({ manifest: manifest.hash, suite: suite.hash, registry: {} });
		ledger.recordExperiment({
			experimentHash,
			resolvedManifestObjectHash: manifest.hash,
			resolvedSuiteObjectHash: suite.hash,
			registryResolution: {}
		});
		const runA = ledger.startRun({ experimentHash, repoSha: 'a'.repeat(40), hostSnapshot: { cpu: 16 } });
		const runB = ledger.startRun({ experimentHash, repoSha: 'a'.repeat(40), hostSnapshot: { cpu: 16 } });
		expect(runB).not.toBe(runA);

		ledger.putCacheEntry('invocation-a', outputA.hash);
		ledger.putCacheEntry('invocation-a', outputA.hash);
		expect(ledger.getCacheEntry('invocation-a')).toBe(outputA.hash);
		expect(() => ledger.putCacheEntry('invocation-a', outputB.hash)).toThrow(/Immutable cache conflict/);
		ledger.close();

		const database = new DatabaseSync(dbPath, { readOnly: true });
		const runs = database.prepare('SELECT run_id, experiment_hash FROM runs ORDER BY run_id').all() as {
			run_id: string;
			experiment_hash: string;
		}[];
		expect(runs).toHaveLength(2);
		expect(new Set(runs.map((run) => run.experiment_hash))).toEqual(new Set([experimentHash]));
		database.close();
	});

	it('anchors entity identity to its producer object and records lineage', () => {
		const root = temporaryRoot('entities');
		const store = new ImmutableObjectStore(join(root, 'store'));
		const componentLocalId = stableLocalEntityId('bright-component', { label: 42, bbox: [90, 190, 20, 20] });
		const candidateLocalId = stableLocalEntityId('tee-candidate', {
			kind: 'ring',
			center: [100, 200],
			radius: 12
		});
		const components = store.putJson('components.bright.v1', {
			components: [{ localId: componentLocalId }]
		}).descriptor;
		const candidates = store.putJson('tee.candidates.v1', {
			candidates: [{ localId: candidateLocalId }]
		}).descriptor;
		const ledger = new LabLedger(join(root, 'ledger.sqlite'));
		ledger.recordObject(components, `objects/${components.hash}`);
		ledger.recordObject(candidates, `objects/${candidates.hash}`);
		const component = { producerObjectHash: components.hash, localId: componentLocalId };
		const candidate = { producerObjectHash: candidates.hash, localId: candidateLocalId };
		ledger.recordEntity(component, 'bright-component', { areaPx: 21 });
		ledger.recordEntity(candidate, 'tee-candidate', { center: [100, 200] });
		ledger.recordEntityLineage(candidate, component, 'derived-from');
		ledger.close();

		expect(entityKey(candidate)).toContain(candidates.hash);
		const database = new DatabaseSync(join(root, 'ledger.sqlite'), { readOnly: true });
		const edge = database.prepare('SELECT relation FROM entity_lineage').get() as { relation: string };
		expect(edge.relation).toBe('derived-from');
		database.close();
	});

	it('stores immutable, versioned oracle evidence separately from held-out truth', () => {
		const root = temporaryRoot('oracle');
		const store = new ImmutableObjectStore(join(root, 'store'));
		const evidence = store.putJson('tee.candidates.v1', { brightSupportPx: 21 }).descriptor;
		const crop = store.putBytes('artifact.crop.png', Uint8Array.from([137, 80, 78, 71])).descriptor;
		const entity = {
			producerObjectHash: evidence.hash,
			localId: stableLocalEntityId('tee-candidate', { center: [100, 200], angle: 7.5 })
		};
		const observation: OracleObservationV1 = {
			oracleObservationSchemaVersion: 1,
			observationId: 'heritage-h6-basket-overlap',
			version: 1,
			evidenceRole: 'discovery',
			reviewer: { kind: 'hybrid', id: 'oracle-review', version: '1' },
			prompt: {
				entities: [{ ref: entity, role: 'review-trigger-candidate' }],
				evidenceObjects: [{ objectHash: evidence.hash, role: 'upstream-tee-evidence' }],
				artifacts: [{ objectHash: crop.hash, role: 'source-crop' }]
			},
			classification: { code: 'tee-paint-visible-under-basket' },
			correctedGeometry: {
				coordinateFrame: 'viewport',
				geometryType: 'tee-center',
				value: { x: 101.5, y: 199.25 }
			},
			renderingAttribution: [
				{ layer: 'basket-sprite', assessment: 'semi-transparent-overlap', confidence: 0.97 }
			],
			notes: 'Twenty-one bright pixels survive under the basket.',
			tags: ['basket-overlap', '<=30-surviving-px', 'implementation-disagreement']
		};
		const observationObject = store.putJson('oracle.observation.v1', observation).descriptor;
		const ledger = new LabLedger(join(root, 'ledger.sqlite'));
		for (const descriptor of [evidence, crop, observationObject]) {
			ledger.recordObject(descriptor, `objects/${descriptor.hash}`);
		}
		ledger.recordEntity(entity, 'tee-candidate', { brightSupportPx: 21 });
		ledger.recordOracleObservation(observationObject, observation);

		const revision: OracleObservationV1 = {
			...observation,
			version: 2,
			supersedesObservationObjectHash: observationObject.hash,
			notes: 'Reviewed again; classification retained.'
		};
		const revisionObject = store.putJson('oracle.observation.v1', revision).descriptor;
		ledger.recordObject(revisionObject, `objects/${revisionObject.hash}`);
		ledger.recordOracleObservation(revisionObject, revision);

		const conflictingVersion = {
			...observation,
			notes: 'Different content attempting to replace version 1.'
		};
		const conflictingObject = store.putJson('oracle.observation.v1', conflictingVersion).descriptor;
		ledger.recordObject(conflictingObject, `objects/${conflictingObject.hash}`);
		expect(() => ledger.recordOracleObservation(conflictingObject, conflictingVersion)).toThrow(
			/Oracle observation version conflict/
		);

		const invalidValidationRole = {
			...observation,
			observationId: 'invalid-held-out-oracle',
			evidenceRole: 'held_out_validation'
		} as unknown as OracleObservationV1;
		const invalidObject = store.putJson('oracle.observation.v1', invalidValidationRole).descriptor;
		expect(() => ledger.recordOracleObservation(invalidObject, invalidValidationRole)).toThrow(
			/discovery or calibration/
		);
		ledger.close();

		const database = new DatabaseSync(join(root, 'ledger.sqlite'), { readOnly: true });
		const versions = database
			.prepare('SELECT observation_version, evidence_role FROM oracle_observations ORDER BY observation_version')
			.all() as { observation_version: number; evidence_role: string }[];
		expect(versions).toEqual([
			{ observation_version: 1, evidence_role: 'discovery' },
			{ observation_version: 2, evidence_role: 'discovery' }
		]);
		const tags = database
			.prepare('SELECT tag FROM oracle_observation_tags WHERE observation_object_hash = ? ORDER BY tag')
			.all(observationObject.hash) as { tag: string }[];
		expect(tags.map((row) => row.tag)).toEqual([
			'<=30-surviving-px',
			'basket-overlap',
			'implementation-disagreement'
		]);
		expect(
			database.prepare('SELECT COUNT(*) AS count FROM oracle_observation_entities').get()
		).toEqual({ count: 2 });
		database.close();
	});
});
