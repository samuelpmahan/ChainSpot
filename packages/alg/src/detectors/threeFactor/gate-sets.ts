import type { ABFeature, GateId } from './features/types';
import { g1BadgesFeature } from './features/g1.badges';
import { g1DigitsFeature as digitsFeature } from './features/g1.digits';
import { g2SpriteFeature } from './features/g2.sprite';
import { cleanBasketFamilyFeature } from './features/g2.cleanBasketFamily';
import { g3EndpointsFeature } from './features/g3.endpoints';
import { teeFamilyFeature } from './features/g3.teeFamily';
import { phantomTeeFeature } from './features/g3.phantomTee';
import { g4ScoringFeature } from './features/g4.scoring';
import { g4SearchFeature } from './features/g4.search';
import { fourLaneSensorFeature } from './features/st.fourLaneSensor';
import { g5RibbonFeature } from './features/g5.ribbon';
import { g5RoutingFeature } from './features/g5.routing';
import { zfitFeature } from './features/g5.zfit';
import { sharedHsvFeature } from './features/shared.hsv';
import { ALL_FEATURES } from './features/registry';
import type {
	ABFeatureOperation,
	ABFeatureSet,
	ABFeatureSetOperation
} from '../../exec/feature-set';
import { ARTIFACT_EXTRACTORS, OPERATION_DEFS, operationImpls } from '../../exec/operations';

/** Stable production gate ids. These describe ownership, not execution order. */
export type GateFeatureSetId =
	'shared-set' | 'g1-set' | 'g2-set' | 'g3-set' | 'g4-set' | 'st-set' | 'g5-set';

/** Explicit owned feature membership, intentionally excluding parked supportRoi. */
export const GATE_FEATURE_IDS = {
	'shared-set': ['hsv'],
	'g1-set': ['badges', 'digits'],
	'g2-set': ['sprite', 'cleanBasketFamily'],
	'g3-set': ['endpoints', 'teeFamily', 'phantomTee'],
	'g4-set': ['scoring', 'search'],
	'st-set': ['fourLaneSensor'],
	'g5-set': ['ribbon', 'routing', 'zfit']
} as const satisfies Record<GateFeatureSetId, readonly string[]>;

const FEATURES: Record<GateFeatureSetId, readonly ABFeature[]> = {
	'shared-set': [sharedHsvFeature],
	'g1-set': [g1BadgesFeature, digitsFeature],
	'g2-set': [g2SpriteFeature, cleanBasketFamilyFeature],
	'g3-set': [g3EndpointsFeature, teeFamilyFeature, phantomTeeFeature],
	'g4-set': [g4ScoringFeature, g4SearchFeature],
	'st-set': [fourLaneSensorFeature],
	'g5-set': [g5RibbonFeature, g5RoutingFeature, zfitFeature]
};

/** The seven production compositions, in the required feature order. */
export const GATE_FEATURE_SETS: Record<GateFeatureSetId, ABFeatureSet> = {
	'shared-set': {
		id: 'shared-set',
		features: FEATURES['shared-set'],
		imports: [],
		locallyOperationlessFeatureIds: ['hsv'],
		seededSlots: [
			'image',
			'viewport',
			'params',
			'stage',
			'badges',
			'baskets',
			'tees',
			'supportField',
			'rawPairs'
		],
		note: 'Shared cross-gate infrastructure.'
	},
	'g1-set': {
		id: 'g1-set',
		features: FEATURES['g1-set'],
		imports: ['hsv'],
		seededSlots: ['localImage', 'viewport']
	},
	'g2-set': {
		id: 'g2-set',
		features: FEATURES['g2-set'],
		imports: [],
		seededSlots: ['stage', 'viewport']
	},
	'g3-set': {
		id: 'g3-set',
		features: FEATURES['g3-set'],
		imports: ['badges', 'scoring', 'search', 'zfit', 'ribbon', 'routing'],
		seededSlots: ['stage', 'sprites', 'viewport', 'measurement', 'assignment', 'recoveredTees']
	},
	'g4-set': {
		id: 'g4-set',
		features: FEATURES['g4-set'],
		imports: ['zfit', 'ribbon', 'routing'],
		seededSlots: ['measurement', 'recoveredTees']
	},
	'st-set': {
		id: 'st-set',
		features: FEATURES['st-set'],
		imports: [],
		locallyOperationlessFeatureIds: ['fourLaneSensor'],
		seededSlots: []
	},
	'g5-set': {
		id: 'g5-set',
		features: FEATURES['g5-set'],
		imports: ['scoring'],
		locallyOperationlessFeatureIds: ['zfit'],
		seededSlots: ['localImage', 'params', 'badges', 'viewport', 'tees', 'baskets']
	}
};

const SET_BY_GATE: Record<GateId, GateFeatureSetId> = {
	shared: 'shared-set',
	G1: 'g1-set',
	G2: 'g2-set',
	G3: 'g3-set',
	G4: 'g4-set',
	ST: 'st-set',
	G5: 'g5-set'
};

/** Operation definitions grouped once by their declared production gate. */
export const GATE_SET_OPERATIONS: Record<GateFeatureSetId, readonly ABFeatureSetOperation[]> =
	Object.fromEntries(
		(Object.keys(GATE_FEATURE_SETS) as GateFeatureSetId[]).map((setId) => [setId, []])
	) as unknown as Record<GateFeatureSetId, readonly ABFeatureSetOperation[]>;

for (const definition of OPERATION_DEFS) {
	const setId = SET_BY_GATE[definition.spec.gate as GateId];
	if (!setId) throw new Error(`Unknown operation gate '${definition.spec.gate}'`);
	const run = operationImpls.get(definition.spec.id);
	if (!run) throw new Error(`Missing operation implementation '${definition.spec.id}'`);
	const extractArtifacts = Object.prototype.hasOwnProperty.call(
		ARTIFACT_EXTRACTORS,
		definition.spec.id
	)
		? ARTIFACT_EXTRACTORS[definition.spec.id]
		: undefined;
	const operation: ABFeatureOperation = {
		spec: definition.spec,
		run,
		...(extractArtifacts ? { extractArtifacts } : {})
	};
	(GATE_SET_OPERATIONS[setId] as ABFeatureSetOperation[]).push({ operation });
}

// Keep the public set object self-contained for the feature-set compiler seam.
for (const setId of Object.keys(GATE_FEATURE_SETS) as GateFeatureSetId[]) {
	GATE_FEATURE_SETS[setId] = {
		...GATE_FEATURE_SETS[setId],
		operations: GATE_SET_OPERATIONS[setId]
	};
}

/** One-to-one operation ownership, useful to receipts and conformance tests. */
export const GATE_OPERATION_OWNERSHIP: Readonly<Record<string, GateFeatureSetId>> =
	Object.fromEntries(
		(
			Object.entries(GATE_SET_OPERATIONS) as [GateFeatureSetId, readonly ABFeatureSetOperation[]][]
		).flatMap(([setId, operations]) =>
			operations.map(({ operation }) => [operation.spec.id, setId] as const)
		)
	);

/** Feature reads crossing the operation's owning gate, never inferred as membership. */
export const GATE_CROSS_GATE_DEPENDENCIES: Readonly<Record<string, readonly string[]>> =
	Object.fromEntries(
		OPERATION_DEFS.map(({ spec }) => {
			const owner = GATE_OPERATION_OWNERSHIP[spec.id];
			const reads = (spec.features ?? []).filter((featureId) => {
				const feature = Object.values(FEATURES)
					.flat()
					.find((candidate) => candidate.id === featureId);
				return feature !== undefined && SET_BY_GATE[feature.gate] !== owner;
			});
			return [spec.id, reads] as const;
		})
	);

// Import-time integrity: a newly registered ABFeature cannot silently sit
// outside the gate compositions, and an operation cannot acquire a cross-gate
// read without the owning set declaring that import.
{
	const registryIds = new Set(ALL_FEATURES.map((feature) => feature.id));
	const ownedIds = new Set<string>();
	for (const [setId, set] of Object.entries(GATE_FEATURE_SETS) as [
		GateFeatureSetId,
		ABFeatureSet
	][]) {
		const declaredIds = GATE_FEATURE_IDS[setId];
		const actualIds = set.features.map((feature) => feature.id);
		if (
			declaredIds.length !== actualIds.length ||
			declaredIds.some((id, i) => id !== actualIds[i])
		) {
			throw new Error(`Gate ABFeatureSet '${setId}': GATE_FEATURE_IDS drifted from features.`);
		}
		for (const feature of set.features) {
			if (ownedIds.has(feature.id)) {
				throw new Error(`Gate ABFeatureSet: feature '${feature.id}' is owned more than once.`);
			}
			if (SET_BY_GATE[feature.gate] !== setId) {
				throw new Error(
					`Gate ABFeatureSet '${setId}': feature '${feature.id}' declares gate '${feature.gate}'.`
				);
			}
			ownedIds.add(feature.id);
		}

		const imports = set.imports ?? [];
		if (new Set(imports).size !== imports.length) {
			throw new Error(`Gate ABFeatureSet '${setId}': duplicate imported feature id.`);
		}
		const expectedImports = new Set(
			(set.operations ?? []).flatMap(({ operation }) =>
				(operation.spec.features ?? []).filter((id) => !actualIds.includes(id))
			)
		);
		if (
			imports.length !== expectedImports.size ||
			imports.some((id) => !expectedImports.has(id) || !registryIds.has(id))
		) {
			throw new Error(
				`Gate ABFeatureSet '${setId}': explicit imports drifted from operation reads.`
			);
		}

		const locallyRead = new Set(
			(set.operations ?? []).flatMap(({ operation }) => operation.spec.features ?? [])
		);
		const expectedOperationless = set.features
			.filter((feature) => !feature.operations?.length && !locallyRead.has(feature.id))
			.map((feature) => feature.id);
		const declaredOperationless = set.locallyOperationlessFeatureIds ?? [];
		if (
			declaredOperationless.length !== expectedOperationless.length ||
			declaredOperationless.some((id) => !expectedOperationless.includes(id))
		) {
			throw new Error(
				`Gate ABFeatureSet '${setId}': locally operationless feature inventory drifted.`
			);
		}
	}
	if (ownedIds.size !== registryIds.size || [...registryIds].some((id) => !ownedIds.has(id))) {
		throw new Error('Gate ABFeatureSets must own every registered ABFeature exactly once.');
	}
}
