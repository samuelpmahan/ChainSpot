export const PCR_MATERIALIZATION_VIEWS = [
	'raw',
	'bw',
	'ownership',
	'residue-after',
	'composed',
	'components',
	'available',
	'explained',
	'unexplained',
	'relationships'
] as const;

/** The specimen shown when a staging visitor enters the PCR ProofFloor. */
export const DEFAULT_PCR_INSPECTION_PLAN = Object.freeze({
	pcrId: 'badge-pcr',
	tickId: 'badgeStage.masks',
	specimenId: 'badge-0',
	materializationView: 'composed',
	zoom: 6,
	showGrid: false,
	showReceipt: true
});

/** Fail the staging build instead of publishing a blank or drifted default plan. */
export function requireDefaultPcrInspectionPlan(library: BadgeSpecimenLibrary) {
	if (library.status !== 'materialized') {
		throw new Error(
			`default PCR inspection plan requires materialized computation: ${library.note}`
		);
	}
	const pcr = library.pcrs.find((candidate) => candidate.id === DEFAULT_PCR_INSPECTION_PLAN.pcrId);
	if (!pcr) throw new Error(`default PCR '${DEFAULT_PCR_INSPECTION_PLAN.pcrId}' is unavailable`);
	if (!pcr.ticks.some((tick) => tick.operation.id === DEFAULT_PCR_INSPECTION_PLAN.tickId)) {
		throw new Error(
			`default Tick '${DEFAULT_PCR_INSPECTION_PLAN.tickId}' is unavailable in '${pcr.id}'`
		);
	}
	if (
		!library.specimens.some((specimen) => specimen.id === DEFAULT_PCR_INSPECTION_PLAN.specimenId)
	) {
		throw new Error(`default specimen '${DEFAULT_PCR_INSPECTION_PLAN.specimenId}' is unavailable`);
	}
	return DEFAULT_PCR_INSPECTION_PLAN;
}
import type { BadgeSpecimenLibrary } from './badgeSpecimen';
