import { materializeBadgeSpecimens } from '$lib/server/evidence-workbench/materializeBadgeSpecimens.mjs';
import { requireDefaultPcrInspectionPlan } from '$lib/evidence-workbench/pcrInspectionPlan';

export const load = async () => {
	const library = await materializeBadgeSpecimens();
	requireDefaultPcrInspectionPlan(library);
	return { library };
};
