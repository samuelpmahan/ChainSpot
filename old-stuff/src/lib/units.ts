/** Shared unit conversion: exact NIST-defined international foot. */
export const FEET_PER_METER = 3.280839895;

export function metersToFeet(meters: number): number {
	return meters * FEET_PER_METER;
}
