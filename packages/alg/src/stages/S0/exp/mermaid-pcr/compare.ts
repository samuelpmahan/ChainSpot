/** Small, runner-agnostic comparison helpers for the S0 Mermaid PCR proof. */

export const S1_OUTPUT_ADDRESSES = [
	'px.badges.objects',
	'px.badges.px',
	'px.badges.muted',
	'px.remaining.afterBadges'
] as const;

export interface MermaidBadge {
	readonly id?: string;
	readonly label?: string | number | null;
	readonly reading?: { readonly value?: string | null; readonly label?: string | number | null };
}

export interface MermaidRaster {
	readonly widthPx: number;
	readonly heightPx: number;
	readonly rgba: ArrayLike<number>;
}

export interface MermaidBounds {
	readonly left: number;
	readonly top: number;
	readonly right: number;
	readonly bottom: number;
}

export interface MermaidTrace {
	readonly namedCalls: readonly string[];
	readonly decodeCount: number;
	readonly fullImagePxCPublished: boolean;
	readonly sameFullImageAtBoundsAndApply: boolean;
}

export interface MermaidRun {
	readonly canonicalPixels: MermaidRaster;
	readonly badges: readonly MermaidBadge[];
	readonly outputAddresses: readonly string[];
	readonly cropBounds: MermaidBounds;
	readonly trace: MermaidTrace;
}

export interface MermaidParity {
	readonly canonicalPixels: boolean;
	readonly badges: boolean;
	readonly outputAddresses: boolean;
	readonly cropBounds: boolean;
	readonly namedCalls: boolean;
	readonly oneDecode: boolean;
	readonly fullImageLocal: boolean;
	readonly ok: boolean;
	readonly differences: readonly string[];
}

function badgeKey(badge: MermaidBadge): string {
	const label = badge.label ?? badge.reading?.value ?? badge.reading?.label ?? null;
	return `${badge.id ?? ''}:${label ?? ''}`;
}

function sameBytes(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
	if (a.length !== b.length) return false;
	for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return false;
	return true;
}

function sameBounds(a: MermaidBounds, b: MermaidBounds): boolean {
	return a.left === b.left && a.top === b.top && a.right === b.right && a.bottom === b.bottom;
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((value, index) => value === b[index]);
}

export function compareMermaidS0Runs(legacy: MermaidRun, generated: MermaidRun): MermaidParity {
	const canonicalPixels =
		legacy.canonicalPixels.widthPx === generated.canonicalPixels.widthPx &&
		legacy.canonicalPixels.heightPx === generated.canonicalPixels.heightPx &&
		sameBytes(legacy.canonicalPixels.rgba, generated.canonicalPixels.rgba);
	const badges =
		legacy.badges.map(badgeKey).join('|') === generated.badges.map(badgeKey).join('|');
	const outputAddresses =
		sameList([...legacy.outputAddresses].sort(), [...generated.outputAddresses].sort()) &&
		sameList([...generated.outputAddresses].sort(), [...S1_OUTPUT_ADDRESSES].sort());
	const cropBounds = sameBounds(legacy.cropBounds, generated.cropBounds);
	const namedCalls = sameList(legacy.trace.namedCalls, generated.trace.namedCalls);
	const oneDecode = legacy.trace.decodeCount === 1 && generated.trace.decodeCount === 1;
	const fullImageLocal =
		!generated.trace.fullImagePxCPublished &&
		generated.trace.sameFullImageAtBoundsAndApply;
	const differences: string[] = [];
	if (!canonicalPixels) differences.push('canonical pixel bytes or dimensions differ');
	if (!badges) differences.push('badge identities or labels differ');
	if (!outputAddresses) differences.push('S1 output address inventory differs');
	if (!cropBounds) differences.push('crop bounds differ');
	if (!namedCalls) differences.push('named call sequence differs');
	if (!oneDecode) differences.push('decode count is not exactly one per run');
	if (!fullImageLocal) differences.push('FullImage locality or identity proof failed');
	return {
		canonicalPixels,
		badges,
		outputAddresses,
		cropBounds,
		namedCalls,
		oneDecode,
		fullImageLocal,
		ok: differences.length === 0,
		differences
	};
}

export interface NamedFunctionBinding {
	readonly address: string;
	readonly implementationId: string;
}

/** Reject malformed proof metadata while allowing legitimate repeated calls. */
export function validateNamedFunctionBindings(bindings: readonly NamedFunctionBinding[]): void {
	const seen = new Map<string, string>();
	for (const binding of bindings) {
		if (!/^fn\.[A-Za-z0-9_.-]+$/.test(binding.address))
			throw new Error(`Mermaid PCR: malformed function address '${binding.address}'.`);
		if (!binding.implementationId)
			throw new Error(`Mermaid PCR: missing implementation identity for '${binding.address}'.`);
		const prior = seen.get(binding.address);
		if (prior !== undefined && prior !== binding.implementationId)
			throw new Error(
				`Mermaid PCR: function '${binding.address}' is reused with conflicting implementations '${prior}' and '${binding.implementationId}'.`
			);
		seen.set(binding.address, binding.implementationId);
	}
}
