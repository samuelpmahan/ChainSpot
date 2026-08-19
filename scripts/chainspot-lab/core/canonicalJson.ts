export type CanonicalJsonValue =
	| null
	| boolean
	| number
	| string
	| readonly CanonicalJsonValue[]
	| { readonly [key: string]: CanonicalJsonValue };

/**
 * JSON with stable object-key ordering. Arrays keep their original order.
 * Unsupported or ambiguous values fail loudly instead of producing an
 * unstable cache identity.
 */
export function canonicalJson(value: unknown): string {
	const active = new Set<object>();

	const encode = (current: unknown, path: string): string => {
		if (current === null) return 'null';
		if (typeof current === 'string' || typeof current === 'boolean') {
			return JSON.stringify(current);
		}
		if (typeof current === 'number') {
			if (!Number.isFinite(current)) {
				throw new TypeError(`Non-finite number at ${path}`);
			}
			return JSON.stringify(Object.is(current, -0) ? 0 : current);
		}
		if (typeof current !== 'object') {
			throw new TypeError(`Unsupported value at ${path}: ${typeof current}`);
		}
		if (active.has(current)) throw new TypeError(`Cycle detected at ${path}`);
		active.add(current);
		try {
			if (Array.isArray(current)) {
				return `[${Array.from(current, (item, index) => encode(item, `${path}[${index}]`)).join(',')}]`;
			}
			const prototype = Object.getPrototypeOf(current);
			if (prototype !== Object.prototype && prototype !== null) {
				throw new TypeError(`Only plain objects are supported at ${path}`);
			}
			if (Object.getOwnPropertySymbols(current).length > 0) {
				throw new TypeError(`Symbol keys are unsupported at ${path}`);
			}
			const record = current as Record<string, unknown>;
			return `{${Object.keys(record)
				.sort()
				.map((key) => `${JSON.stringify(key)}:${encode(record[key], `${path}.${key}`)}`)
				.join(',')}}`;
		} finally {
			active.delete(current);
		}
	};

	return encode(value, '$');
}
