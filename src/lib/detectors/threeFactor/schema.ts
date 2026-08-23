// JSON Schema (draft-07) generator for threeFactor configs — derived FROM
// the feature registry and engine units, so the schema can never drift from
// the code: a pinned test regenerates it and compares against the checked-in
// configs/threeFactor-config.schema.json. External agents and editors
// validate config files against that .json without running the engine.

import { ALL_FEATURES } from './features/registry';
import { CONFIG_SCHEMA } from './config';
import type { ABFeature, GateId } from './features/types';

const GATE_IDS: readonly GateId[] = ['G1', 'G2', 'G3', 'G4', 'ST', 'G5', 'shared'];

function knobSchema(defaultValue: unknown): Record<string, unknown> {
	switch (typeof defaultValue) {
		case 'number':
			return { type: 'number' };
		case 'boolean':
			return { type: 'boolean' };
		case 'string':
			return { type: 'string' };
		default:
			return Array.isArray(defaultValue) ? { type: 'array' } : { type: 'object' };
	}
}

function featureSchema(feature: ABFeature): Record<string, unknown> {
	const knobProperties: Record<string, unknown> = {};
	for (const [name, spec] of Object.entries(feature.knobs)) {
		knobProperties[name] = { ...knobSchema(spec.default), description: spec.note ?? '', default: spec.default };
	}
	return {
		type: 'object',
		additionalProperties: false,
		description: feature.note ?? '',
		properties: {
			enabled: { type: 'boolean', default: feature.defaultEnabled },
			knobs: { type: 'object', additionalProperties: false, properties: knobProperties }
		}
	};
}

export function buildConfigJsonSchema(unitIds: readonly string[]): Record<string, unknown> {
	const gateProperties: Record<string, unknown> = {};
	for (const gate of GATE_IDS) {
		const features = ALL_FEATURES.filter((feature) => feature.gate === gate);
		if (features.length === 0) continue;
		const properties: Record<string, unknown> = {};
		for (const feature of features) properties[feature.id] = featureSchema(feature);
		gateProperties[gate] = { type: 'object', additionalProperties: false, properties };
	}
	return {
		$schema: 'http://json-schema.org/draft-07/schema#',
		$id: 'chainspot://threeFactor-config@1',
		title: 'threeFactor engine config',
		description:
			'Sparse deviations from registry defaults. The execution list is the algorithm order, validated against unit consumes/produces at load. Default config = frozen dev72 behavior.',
		type: 'object',
		additionalProperties: false,
		required: ['schema', 'name'],
		properties: {
			$schema: { type: 'string' },
			schema: { const: CONFIG_SCHEMA },
			name: { type: 'string', minLength: 1 },
			note: { type: 'string' },
			execution: {
				type: 'array',
				items: { enum: [...unitIds] },
				uniqueItems: true,
				description: 'Full unit order; omit to inherit the default order.'
			},
			gates: { type: 'object', additionalProperties: false, properties: gateProperties }
		}
	};
}
