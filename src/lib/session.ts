// In-memory cross-page session (old-app pattern: survives client-side
// navigation, dies on full reload). Pages hand each other typed artifacts —
// never pixels: by the time anything is stored here, UDisc pixels are gone.

import type { ReviewHoleState } from '$lib/guidedReview';
import type { WorldTransform } from '$lib/geo';

export interface CourseMap {
	readonly holes: readonly ReviewHoleState[];
	/** null until correspondence pairs lock the world transform */
	readonly transform: WorldTransform | null;
}

export interface MappedRound {
	/** ordered walk trace, course-blank composite px (pre-read during Import) */
	readonly walk: readonly { xPx: number; yPx: number }[];
	readonly droplets: readonly { xPx: number; yPx: number }[];
}

let courseMap: CourseMap | null = null;
let mappedRound: MappedRound | null = null;

export function setCourseMap(map: CourseMap | null): void {
	courseMap = map;
}
export function getCourseMap(): CourseMap | null {
	return courseMap;
}
export function setMappedRound(round: MappedRound | null): void {
	mappedRound = round;
}
export function getMappedRound(): MappedRound | null {
	return mappedRound;
}
