// Feature registry. New features register with ONE import + list entry
// (the LAB registry's basketFamily.ts out-of-band precedent). The tail of
// this module is an import-time integrity check mirroring
// scripts/chainspot-lab/invariants.ts: duplicate ids or bad knob specs
// refuse to load rather than silently drifting.

import type { ABFeature } from './types';
import { zfitFeature } from './g5.zfit';
import { phantomTeeFeature } from './g3.phantomTee';

export const ALL_FEATURES: readonly ABFeature[] = [zfitFeature, phantomTeeFeature];

export function featureById(id: string): ABFeature | undefined {
	return ALL_FEATURES.find((feature) => feature.id === id);
}

// --- integrity check (import-time) -----------------------------------------
{
	const seen = new Set<string>();
	for (const feature of ALL_FEATURES) {
		if (seen.has(feature.id)) throw new Error(`Duplicate ABFeature id: ${feature.id}`);
		seen.add(feature.id);
		if (feature.kind === 'deviation' && feature.defaultEnabled) {
			throw new Error(
				`ABFeature ${feature.id}: deviations must default OFF (frozen parity).`
			);
		}
		for (const [name, spec] of Object.entries(feature.knobs)) {
			if (spec.validate) {
				const error = spec.validate(spec.default);
				if (error !== null) {
					throw new Error(`ABFeature ${feature.id}: default for knob '${name}' invalid: ${error}`);
				}
			}
		}
	}
}
