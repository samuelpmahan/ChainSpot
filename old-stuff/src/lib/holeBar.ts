import type { AnnotatedHole } from './domain/annotatedRound';

export interface HoleBarIndicators {
	readonly tee: boolean;
	readonly basket: boolean;
	readonly number: boolean;
	readonly bends: number;
	readonly throws: number;
}

/**
 * Derives the compact status shown in the persistent hole bar. A hole record
 * always has a numeric identity, so the number indicator is active whenever a
 * valid hole record exists; the remaining indicators reflect its annotations.
 */
export function getHoleBarIndicators(hole: AnnotatedHole): HoleBarIndicators {
	return {
		tee: Boolean(hole.tee),
		basket: Boolean(hole.basket),
		number: Number.isFinite(hole.number) && hole.number > 0,
		bends: hole.corridorBends.length,
		throws: hole.shots.length
	};
}

export function getHoleBarLabel(hole: AnnotatedHole, active: boolean): string {
	const indicators = getHoleBarIndicators(hole);
	const state = [
		indicators.tee ? 'tee present' : 'tee missing',
		indicators.basket ? 'basket present' : 'basket missing',
		indicators.number ? 'number present' : 'number missing',
		`${indicators.bends} bends`,
		`${indicators.throws} throws`
	].join(', ');
	return `Hole ${hole.number}${active ? ', selected' : ''}: ${state}`;
}
