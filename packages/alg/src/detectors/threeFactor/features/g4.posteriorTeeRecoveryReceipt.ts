// Trace-only receipt and render seam for G4 posterior tee recovery.
//
// The posteriorTeeRecovery producer owns all hypothesis scoring, joint
// enumeration, and phantom proposal. This module does not re-score, re-rank,
// re-read pixels, or rebuild geometry: it carries the producer's own emitted
// drawables into a literal CLI receipt and a declarative FeatureRender plan.
//
// It exists because a feature that cannot be seen cannot be accepted. Without
// it the CLI writes `no renderer for 'measurementTable' -- raw bytes + stub`
// and a human has to hand-draw the answer to check whether the tees landed in
// the right place.

import type { Drawable, FeatureRender, FeatureRenderPlan, RunTrace, UnitTrace } from './types';

export const POSTERIOR_TEE_RECOVERY_FEATURE_ID = 'posteriorTeeRecovery' as const;
/** The posterior op is scheduled inside the frozen teeBadgeLock unit, so its
 * drawables land on that UnitTrace, not on a unit of its own. */
const POSTERIOR_UNIT = 'teeBadgeLock';
const REF_PREFIX = `${POSTERIOR_TEE_RECOVERY_FEATURE_ID}:`;

const UNKNOWN = 'UNKNOWN' as const;

type Value = number | typeof UNKNOWN;

function finite(values: Drawable['values'], name: string): Value {
	const value = values?.[name];
	return typeof value === 'number' && Number.isFinite(value) ? value : UNKNOWN;
}

function text(value: Value, digits = 4): string {
	return typeof value === 'number' ? String(Number(value.toFixed(digits))) : value;
}

function holeText(value: Value): string {
	return typeof value === 'number' ? `H${text(value, 0)}` : UNKNOWN;
}

/** Only this producer's drawables, identified by its own ref namespace — never
 * by geometry or by a magic visualRole shared with other G4 features. */
function posteriorDrawables(unit: UnitTrace): Drawable[] {
	return unit.drawables.filter(
		(drawable) => typeof drawable.ref === 'string' && drawable.ref.startsWith(REF_PREFIX)
	);
}

function kindOf(drawable: Drawable): string {
	const ref = typeof drawable.ref === 'string' ? drawable.ref : '';
	return ref.slice(REF_PREFIX.length).split(':')[0] ?? UNKNOWN;
}

function byKind(drawables: readonly Drawable[], kind: string): Drawable[] {
	return drawables.filter((drawable) => kindOf(drawable) === kind);
}

function measurementValue(unit: UnitTrace, name: string): Value {
	const matches = (unit.measurements ?? []).filter((measurement) => measurement.name === name);
	if (matches.length !== 1) return UNKNOWN;
	const value = matches[0].sum;
	return typeof value === 'number' && Number.isFinite(value) ? value : UNKNOWN;
}

function rowsFor(drawables: readonly Drawable[]): string[] {
	return drawables.map((drawable) =>
		[
			holeText(finite(drawable.values, 'hole')),
			typeof drawable.ref === 'string' ? drawable.ref : UNKNOWN,
			`post=${text(finite(drawable.values, 'posterior'))}`,
			`logW=${text(finite(drawable.values, 'logWeightVsNull'))}`,
			`d=${text(finite(drawable.values, 'distancePx'), 1)}px`,
			`support=${text(finite(drawable.values, 'supportPixels'), 0)}px`,
			`unexplained=${text(finite(drawable.values, 'unexplainedPixels'), 0)}px`,
			`axisErr=${text(finite(drawable.values, 'axisErrorDeg'), 2)}`,
			drawable.verdict,
			typeof drawable.reason === 'string' ? drawable.reason : ''
		].join(' | ')
	);
}

function cliTextFor(unit: UnitTrace, run: RunTrace, drawables: readonly Drawable[]): string {
	const selected = byKind(drawables, 'selected');
	const rejected = byKind(drawables, 'alternative');
	const nulls = byKind(drawables, 'null');
	const phantoms = byKind(drawables, 'phantom');
	const retired = byKind(drawables, 'retired');
	const lines = [
		'POSTERIOR TEE RECOVERY (selected hypotheses are published as real recovered tees)',
		`config=${run.configName}`,
		`unit='${unit.id}' gate=${unit.gate}`,
		`targets=${text(measurementValue(unit, 'posteriorTargets'), 0)}`,
		`observableCompletions=${text(measurementValue(unit, 'posteriorObservableCompletions'), 0)}`,
		`phantomCompletions=${text(measurementValue(unit, 'posteriorPhantomCompletions'), 0)}`,
		`unresolvedNulls=${text(measurementValue(unit, 'posteriorUnresolvedNulls'), 0)}`,
		`recoveredTeesRetired=${text(measurementValue(unit, 'posteriorRecoveredTeesRetired'), 0)}`,
		`totalCompletions=${text(measurementValue(unit, 'posteriorTotalCompletions'), 0)}`,
		'',
		'"posterior" here is a normalized MODEL WEIGHT, not a calibrated real-world probability.',
		'Every likelihood term is exposed per row so the number cannot masquerade as certainty.',
		'',
		'hole | ref | posterior | logWeightVsNull | distance | support | unexplained | axisErr | verdict | reason'
	];
	if (selected.length) {
		lines.push('-- SELECTED (joint MAP)');
		lines.push(...rowsFor(selected));
	}
	if (nulls.length) {
		lines.push('-- NULL SELECTED (no observable hypothesis accepted)');
		lines.push(...rowsFor(nulls));
	}
	if (phantoms.length) {
		lines.push('-- PHANTOM PROPOSALS (synthesized, appearance UNKNOWN)');
		lines.push(...rowsFor(phantoms));
	}
	if (retired.length) {
		// Stated, not implied: a badge must never end up owning two endpoints,
		// so every frozen recovered tee this feature overruled is named here.
		lines.push('-- RETIRED FROZEN RECOVERED TEES (overruled; excluded from the endpoint image)');
		for (const drawable of retired) {
			lines.push(
				[
					holeText(finite(drawable.values, 'hole')),
					typeof drawable.ref === 'string' ? drawable.ref : UNKNOWN,
					`teeIndex=${text(finite(drawable.values, 'teeIndex'), 0)}`,
					drawable.verdict,
					typeof drawable.reason === 'string' ? drawable.reason : ''
				].join(' | ')
			);
		}
	}
	if (rejected.length) {
		// Repo rule: no silent drops. Every considered-but-not-selected
		// hypothesis is named with the reason it lost.
		lines.push('-- CONSIDERED AND REJECTED');
		lines.push(...rowsFor(rejected));
	}
	if (!selected.length && !nulls.length && !phantoms.length && !rejected.length) {
		lines.push('(no conflict island: the frozen locks stood unchallenged)');
	}
	return lines.join('\n');
}

export function buildPosteriorTeeRecoveryPlan(unit: UnitTrace, run: RunTrace): FeatureRenderPlan {
	const drawables = posteriorDrawables(unit);
	const selected = byKind(drawables, 'selected');
	const nulls = byKind(drawables, 'null');
	const phantoms = byKind(drawables, 'phantom');
	const alternatives = byKind(drawables, 'alternative');
	const retired = byKind(drawables, 'retired');
	const rays = byKind(drawables, 'ray');
	return {
		title: `G4 Posterior tee recovery (${run.configName})`,
		base: 'badgeStage.masks.bright',
		layers: [
			{
				name: 'Selected tee hypotheses (joint MAP)',
				note: 'the endpoint this feature would hand each conflicted badge, if it were given custody',
				drawables: selected
			},
			{
				name: 'Badge → selected tee rays',
				note: 'chord from the badge being resolved to its selected hypothesis',
				drawables: rays
			},
			{
				name: 'NULL selections',
				note: 'badges where no observable hypothesis beat the NULL hypothesis',
				drawables: nulls
			},
			{
				name: 'Phantom proposals',
				note: 'synthesized predecessor-basket positions; appearance UNKNOWN by construction',
				drawables: phantoms
			},
			{
				// Must be a real layer: the endpoint renderer reads this plan's
				// layers, so a retirement that lives only on the UnitTrace is
				// invisible to it and the superseded tee gets drawn twice.
				name: 'Retired frozen recovered tees',
				note: 'frozen recovered tees this feature overruled; excluded from the endpoint image so a badge never shows two endpoints',
				drawables: retired
			},
			{
				name: 'Considered and rejected hypotheses',
				note: 'no silent drops: every enumerated alternative, with the weight that lost',
				drawables: alternatives
			}
		],
		notes: [
			`feature: ${POSTERIOR_TEE_RECOVERY_FEATURE_ID} — ${unit.gate}, trace unit '${unit.id}'`,
			'custody: selected hypotheses are appended to recoveredTees and the frozen recovered tees they overrule are retired. assignment and the teeBadgeLock locks are NOT rewritten.',
			...cliTextFor(unit, run, drawables).split('\n')
		]
	};
}

/** FeatureRender seam: the producer's own drawables, forwarded unchanged. */
export const POSTERIOR_TEE_RECOVERY_RENDER: FeatureRender = {
	units: [POSTERIOR_UNIT],
	draw(unit, run) {
		return buildPosteriorTeeRecoveryPlan(unit, run);
	}
};
