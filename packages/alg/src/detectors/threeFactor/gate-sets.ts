import type { ABFeature, GateId } from './features/types';
import { g1BadgesFeature } from './features/g1.badges';
import { g1DigitsFeature as digitsFeature } from './features/g1.digits';
import { g2SpriteFeature } from './features/g2.sprite';
import { cleanBasketFamilyFeature } from './features/g2.cleanBasketFamily';
import { g3EndpointsFeature } from './features/g3.endpoints';
import { teeFamilyFeature } from './features/g3.teeFamily';
import { teeRecoveryFeature } from './features/g3.teeRecovery';
import { phantomTeeFeature } from './features/g3.phantomTee';
import { g4ScoringFeature } from './features/g4.scoring';
import { g4SearchFeature } from './features/g4.search';
import { fourLaneSensorFeature } from './features/st.fourLaneSensor';
import { g5RibbonFeature } from './features/g5.ribbon';
import { g5RoutingFeature } from './features/g5.routing';
import { zfitFeature } from './features/g5.zfit';
import { sharedHsvFeature } from './features/shared.hsv';
import { ALL_FEATURES } from './features/registry';
import { THREE_FACTOR_SHARED_SERVICES } from './shared-services';
import type {
	ABFeatureOperation,
	ABFeatureSet,
	ABFeatureSetOperation
} from '../../exec/feature-set';
import { ARTIFACT_EXTRACTORS, OPERATION_DEFS, operationImpls } from '../../exec/operations';

/** Stable semantic compositions. These describe ownership, not execution order.
 *
 * The LAB has seven knowledge gates: G1 badges, G2 baskets, G3 visible tees,
 * G4 endpoint recovery, G5 straight-test, G6 assignment, and G7 bend/path
 * refinement. There is no second engine vocabulary.
 */
export type GateFeatureSetId =
	| 'shared-set'
	| 'g1-set'
	| 'g2-set'
	| 'g3-set'
	| 'g4-set'
	| 'g5-set'
	| 'g6-set'
	| 'g7-set';

/** Explicit owned feature membership, intentionally excluding parked supportRoi. */
export const GATE_FEATURE_IDS = {
	'shared-set': ['hsv'],
	'g1-set': ['badges', 'digits'],
	'g2-set': ['sprite', 'cleanBasketFamily'],
	'g3-set': ['endpoints', 'teeFamily'],
	'g4-set': ['teeRecovery', 'phantomTee'],
	'g5-set': ['fourLaneSensor', 'ribbon', 'routing'],
	'g6-set': ['scoring', 'search'],
	'g7-set': ['zfit']
} as const satisfies Record<GateFeatureSetId, readonly string[]>;

const FEATURES: Record<GateFeatureSetId, readonly ABFeature[]> = {
	'shared-set': [sharedHsvFeature],
	'g1-set': [g1BadgesFeature, digitsFeature],
	'g2-set': [g2SpriteFeature, cleanBasketFamilyFeature],
	'g3-set': [g3EndpointsFeature, teeFamilyFeature],
	'g4-set': [teeRecoveryFeature, phantomTeeFeature],
	'g5-set': [fourLaneSensorFeature, g5RibbonFeature, g5RoutingFeature],
	'g6-set': [g4ScoringFeature, g4SearchFeature],
	'g7-set': [zfitFeature]
};

/** The semantic production compositions, in the required feature order. */
export const GATE_FEATURE_SETS: Record<GateFeatureSetId, ABFeatureSet> = {
	'shared-set': {
		id: 'shared-set',
		features: FEATURES['shared-set'],
		services: THREE_FACTOR_SHARED_SERVICES,
		imports: [],
		locallyOperationlessFeatureIds: ['hsv'],
		seededSlots: [],
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
		imports: ['badges', 'scoring'],
		seededSlots: ['stage', 'sprites', 'viewport']
	},
	'g4-set': {
		id: 'g4-set',
		features: FEATURES['g4-set'],
		imports: ['scoring', 'search', 'ribbon', 'routing', 'zfit'],
		seededSlots: [
			'stage',
			'badges',
			'baskets',
			'tees',
			'sprites',
			'viewport',
			'recoveredTees',
			'assignment',
			'measurement'
		],
		note: 'Endpoint recovery: assignment prerequisites are supplied by the downstream composition; teeRecovery precedes terminal phantom completion.'
	},
	'g5-set': {
		id: 'g5-set',
		features: FEATURES['g5-set'],
		imports: ['scoring'],
		locallyOperationlessFeatureIds: ['fourLaneSensor'],
		seededSlots: ['image', 'localImage', 'params', 'viewport', 'stage', 'badges', 'baskets', 'tees']
	},
	'g6-set': {
		id: 'g6-set',
		features: FEATURES['g6-set'],
		imports: ['ribbon', 'routing'],
		seededSlots: ['measurement', 'recoveredTees']
	},
	'g7-set': {
		id: 'g7-set',
		features: FEATURES['g7-set'],
		imports: ['scoring', 'search'],
		seededSlots: ['measurement', 'assignment.tees', 'assignment.rawPairs', 'assignment']
	}
};

const SET_BY_GATE: Record<GateId, GateFeatureSetId> = {
	shared: 'shared-set',
	G1: 'g1-set',
	G2: 'g2-set',
	G3: 'g3-set',
	G4: 'g4-set',
	G5: 'g5-set',
	G6: 'g6-set',
	G7: 'g7-set'
};

/** Feature ownership is semantic too. Several feature declarations retain
 * the engine gate needed by config parsing (G4/G5), so feature.gate cannot be
 * used as the set boundary for those cards. */
const FEATURE_SET_BY_ID: Readonly<Record<string, GateFeatureSetId>> =
	Object.fromEntries(
		(Object.entries(GATE_FEATURE_IDS) as [GateFeatureSetId, readonly string[]][]).flatMap(
			([setId, featureIds]) => featureIds.map((featureId) => [featureId, setId] as const)
		)
	);

/** Canonical semantic operation order, independent of stale engine gate labels.
 *
 * Endpoint recovery is represented by teeRecovery followed by phantomTee.
 * Straight evidence is owned by G5, assignment by G6, and Z-fit pathfinding
 * by G7; sets are never
 * consulted by production scheduling.
 */
const SEMANTIC_OPERATION_ORDER: Record<GateFeatureSetId, readonly string[]> = {
	'shared-set': [],
	'g1-set': [
		'badgeStage.masks',
		'badgeStage.components',
		'badgeStage.family',
		'badgeStage.badges',
		'badges'
	],
	'g2-set': ['baskets', 'cleanBasketFamily'],
	'g3-set': ['tees.ringMeasure', 'tees.exclusion', 'teeFamily'],
	'g4-set': ['teeRecovery', 'phantomTee'],
	'g5-set': ['supportField', 'badgeOcclusionPatch', 'rawPairs', 'measurement'],
	'g6-set': ['assignment.pairs', 'assignment.scoring', 'assignment.ranking', 'assignment.selection'],
	'g7-set': ['zfit']
};

const OPERATION_DEF_BY_ID = new Map(OPERATION_DEFS.map((definition) => [definition.spec.id, definition]));

/** Operation definitions grouped once by semantic composition order. */
export const GATE_SET_OPERATIONS: Record<GateFeatureSetId, readonly ABFeatureSetOperation[]> =
	Object.fromEntries(
		(Object.keys(GATE_FEATURE_SETS) as GateFeatureSetId[]).map((setId) => [setId, []])
	) as unknown as Record<GateFeatureSetId, readonly ABFeatureSetOperation[]>;

for (const [setId, operationIds] of Object.entries(SEMANTIC_OPERATION_ORDER) as [
	GateFeatureSetId,
	readonly string[]
][]) {
	for (const operationId of operationIds) {
		const definition = OPERATION_DEF_BY_ID.get(operationId);
		if (!definition) throw new Error(`Unknown semantic operation '${operationId}' in '${setId}'`);
		const run = operationImpls.get(operationId);
		if (!run) throw new Error(`Missing operation implementation '${operationId}'`);
		const extractArtifacts = Object.prototype.hasOwnProperty.call(ARTIFACT_EXTRACTORS, operationId)
			? ARTIFACT_EXTRACTORS[operationId]
			: undefined;
		const operation: ABFeatureOperation = {
			spec: definition.spec,
			run,
			...(extractArtifacts ? { extractArtifacts } : {})
		};
		(GATE_SET_OPERATIONS[setId] as ABFeatureSetOperation[]).push({ operation });
	}
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

/** Operation labels whose engine `spec.gate` is an old alias for the
 * semantic LAB composition. Keeping this exported makes the divergence
 * inspectable instead of silently trusting the stale label. */
export const GATE_OPERATION_DECLARATION_DIVERGENCES: Readonly<
	Record<string, { readonly declaredGate: GateId; readonly semanticSet: GateFeatureSetId }>
> = Object.fromEntries(
		OPERATION_DEFS.flatMap(({ spec }) => {
			const semanticSet = GATE_OPERATION_OWNERSHIP[spec.id];
			const declaredSet = SET_BY_GATE[spec.gate as GateId];
			return declaredSet === semanticSet
				? []
				: [[spec.id, { declaredGate: spec.gate as GateId, semanticSet }] as const];
		})
	);

/** Feature declarations that retain the engine gate vocabulary while their
 * authoritative semantic composition is a later LAB phase. */
export const GATE_FEATURE_DECLARATION_DIVERGENCES: Readonly<
	Record<string, { readonly declaredGate: GateId; readonly semanticSet: GateFeatureSetId }>
> = Object.fromEntries(
		ALL_FEATURES.flatMap((feature) => {
			const semanticSet = FEATURE_SET_BY_ID[feature.id];
			const declaredSet = SET_BY_GATE[feature.gate];
			return declaredSet === semanticSet
				? []
				: [[feature.id, { declaredGate: feature.gate, semanticSet }] as const];
		})
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
				return feature !== undefined && FEATURE_SET_BY_ID[feature.id] !== owner;
			});
			return [spec.id, reads] as const;
		})
	);

// Import-time integrity: a newly registered ABFeature cannot silently sit
// outside the gate compositions, and an operation cannot acquire a cross-gate
// read without the owning set declaring that import.
{
	const registryIds = new Set(ALL_FEATURES.map((feature) => feature.id));
	const serviceRegistryIds = new Set<string>(
		THREE_FACTOR_SHARED_SERVICES.map((service) => service.id)
	);
	const ownedIds = new Set<string>();
	const ownedServiceIds = new Set<string>();
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
			if (FEATURE_SET_BY_ID[feature.id] !== setId) {
				throw new Error(
					`Gate ABFeatureSet '${setId}': feature '${feature.id}' is semantically owned by another set.`
				);
			}
			ownedIds.add(feature.id);
		}
		for (const service of set.services ?? []) {
			if (!serviceRegistryIds.has(service.id)) {
				throw new Error(
					`Gate ABFeatureSet '${setId}': service '${service.id}' is absent from the shared-service registry.`
				);
			}
			if (ownedServiceIds.has(service.id)) {
				throw new Error(`Gate ABFeatureSet: service '${service.id}' is owned more than once.`);
			}
			ownedServiceIds.add(service.id);
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
				`Gate ABFeatureSet '${setId}': explicit imports drifted from operation reads ` +
				`(declared=${imports.join(',') || 'none'}; expected=${[...expectedImports].join(',') || 'none'}).`
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
	const composedOperationIds = Object.values(GATE_SET_OPERATIONS).flatMap((operations) =>
		operations.map(({ operation }) => operation.spec.id)
	);
	const universeOperationIds = OPERATION_DEFS.map(({ spec }) => spec.id);
	if (
		composedOperationIds.length !== universeOperationIds.length ||
		new Set(composedOperationIds).size !== composedOperationIds.length ||
		new Set(universeOperationIds).size !== universeOperationIds.length ||
		new Set(composedOperationIds).size !== new Set(universeOperationIds).size ||
		universeOperationIds.some((id) => !composedOperationIds.includes(id))
	) {
		throw new Error('Gate ABFeatureSets must own every operation exactly once.');
	}
	if (ownedIds.size !== registryIds.size || [...registryIds].some((id) => !ownedIds.has(id))) {
		throw new Error('Gate ABFeatureSets must own every registered ABFeature exactly once.');
	}
	if (
		ownedServiceIds.size !== serviceRegistryIds.size ||
		[...serviceRegistryIds].some((id) => !ownedServiceIds.has(id))
	) {
		throw new Error('Gate ABFeatureSets must own every registered shared service exactly once.');
	}
}
