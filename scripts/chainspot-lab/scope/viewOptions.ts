import type { ScopeViewOptions } from './types';

export const DEFAULT_SCOPE_VIEW: ScopeViewOptions = {
	contextSpanPx: 800,
	contextOutputPx: 800,
	// Total extra width/height, split evenly around the active request.
	localExtraWidthPx: 100,
	localExtraHeightPx: 100,
	localOutputPx: 640,
	forensicWidePx: 192,
	forensicMidPx: 96,
	forensicTightPx: 48,
	forensicOutputPx: 240,
	grid: true
};

const NUMERIC_FLAGS: Readonly<Record<string, keyof ScopeViewOptions>> = {
	'--context': 'contextSpanPx',
	'--context-out': 'contextOutputPx',
	'--local-extra-w': 'localExtraWidthPx',
	'--local-extra-h': 'localExtraHeightPx',
	'--local-out': 'localOutputPx',
	'--fw': 'forensicWidePx',
	'--fm': 'forensicMidPx',
	'--ft': 'forensicTightPx',
	'--forensic-out': 'forensicOutputPx'
};

function positiveInteger(value: unknown, name: string, allowZero = false): number {
	const n = typeof value === 'number' ? value : Number(value);
	if (!Number.isInteger(n) || (allowZero ? n < 0 : n <= 0)) {
		throw new Error(`lab scope: ${name} must be ${allowZero ? 'a non-negative' : 'a positive'} integer.`);
	}
	return n;
}

export function resolveScopeView(view?: Partial<ScopeViewOptions>): ScopeViewOptions {
	const resolved: ScopeViewOptions = { ...DEFAULT_SCOPE_VIEW, ...view };
	positiveInteger(resolved.contextSpanPx, 'contextSpanPx');
	positiveInteger(resolved.contextOutputPx, 'contextOutputPx');
	positiveInteger(resolved.localExtraWidthPx, 'localExtraWidthPx', true);
	positiveInteger(resolved.localExtraHeightPx, 'localExtraHeightPx', true);
	positiveInteger(resolved.localOutputPx, 'localOutputPx');
	positiveInteger(resolved.forensicWidePx, 'forensicWidePx');
	positiveInteger(resolved.forensicMidPx, 'forensicMidPx');
	positiveInteger(resolved.forensicTightPx, 'forensicTightPx');
	positiveInteger(resolved.forensicOutputPx, 'forensicOutputPx');
	if (!(resolved.forensicWidePx > resolved.forensicMidPx && resolved.forensicMidPx > resolved.forensicTightPx)) {
		throw new Error('lab scope: forensic source spans must satisfy --fw > --fm > --ft.');
	}
	return resolved;
}

/** Mutates args by consuming only presentation flags and returns their overrides. */
export function consumeViewOptions(args: string[]): Partial<ScopeViewOptions> {
	const view: Partial<ScopeViewOptions> = {};
	for (const [flag, field] of Object.entries(NUMERIC_FLAGS)) {
		const index = args.indexOf(flag);
		if (index < 0) continue;
		if (index + 1 >= args.length) throw new Error(`lab scope: ${flag} needs a value.`);
		const allowZero = field === 'localExtraWidthPx' || field === 'localExtraHeightPx';
		(view as Record<string, unknown>)[field] = positiveInteger(args[index + 1], flag, allowZero);
		args.splice(index, 2);
	}
	const noGrid = args.indexOf('--no-grid');
	if (noGrid >= 0) {
		view.grid = false;
		args.splice(noGrid, 1);
	}
	return view;
}

export function parseManifestView(value: unknown, where: string): Partial<ScopeViewOptions> | undefined {
	if (value === undefined) return undefined;
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`lab scope: ${where} must be an object.`);
	const raw = value as Record<string, unknown>;
	const allowed = new Set<keyof ScopeViewOptions>([
		'contextSpanPx', 'contextOutputPx', 'localExtraWidthPx', 'localExtraHeightPx', 'localOutputPx',
		'forensicWidePx', 'forensicMidPx', 'forensicTightPx', 'forensicOutputPx', 'grid'
	]);
	for (const key of Object.keys(raw)) if (!allowed.has(key as keyof ScopeViewOptions)) throw new Error(`lab scope: ${where} has unknown key '${key}'.`);
	const result: Partial<ScopeViewOptions> = {};
	for (const key of allowed) {
		if (raw[key] === undefined) continue;
		if (key === 'grid') {
			if (typeof raw[key] !== 'boolean') throw new Error(`lab scope: ${where}.grid must be boolean.`);
			result.grid = raw[key] as boolean;
			continue;
		}
		const allowZero = key === 'localExtraWidthPx' || key === 'localExtraHeightPx';
		(result as Record<string, unknown>)[key] = positiveInteger(raw[key], `${where}.${key}`, allowZero);
	}
	resolveScopeView(result);
	return result;
}
