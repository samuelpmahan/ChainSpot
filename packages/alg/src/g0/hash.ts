// A single sha256-hex primitive shared by every G0 operation that needs a
// content-addressed id (composite imageId, byte-level truth matching).
//
// Deliberately NOT node:crypto: this file is part of the browser-safe
// core, reachable from the main barrel, so it must never import node:*.
// Instead it uses globalThis.crypto.subtle (the WebCrypto SubtleCrypto
// API) — a web standard that Node has also exposed as a stable global
// since Node 19, with no import required, and this repo requires Node
// >= 22 (see AGENTS.md). Verified directly against this repo's installed
// Node (v22.20.0): `crypto.subtle.digest('SHA-256', bytes)` resolves with
// no import, identical API surface to the browser. Both decode adapters
// and every G0 hash therefore run the literal same code path in Node and
// the browser — there is no separate "Node sha256" implementation to drift
// from this one.

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
	return Array.from(new Uint8Array(digest))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}
