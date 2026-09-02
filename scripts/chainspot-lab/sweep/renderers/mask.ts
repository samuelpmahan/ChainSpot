// Renderer for ArtifactKind 'mask'.
//
// @chainspot/alg's Mask is declared at
// packages/alg/src/detectors/threeFactor/raster.ts:20:
//   /** Binary mask stored one byte per pixel (0/1), row-major. */
//   export interface Mask { width: number; height: number; data: Uint8Array; }
// and its only writer, computeBrightDarkMasks (same file), confirms the
// doc comment: it does `dark[i] = 1` / `bright[i] = 1` on Uint8Array-
// initialized (zero-filled) buffers -- so a mask byte is 0 or 1, never
// 0/255. (rendererContract.ts used to assert the opposite -- that comment
// was checked against this source and found false; it has been corrected
// alongside this renderer.)
//
// This renderer never mutates or reinterprets the artifact's bytes. It
// scales 0/1 to 0/255 ONLY when building the display PNG; the receipt
// below always reports on the raw bytes as they actually are.
//
// maskBytes() (packages/alg/src/exec/operations.ts) is `return mask.data`
// -- width/height are NOT carried in the artifact's own bytes. LAB's hard
// rule is to never guess detector-shaped data, so this renderer only
// rasterizes when RendererInput.dims is populated AND agrees with the
// byte length; otherwise it declines to rasterize and writes a text
// receipt instead, with every diagnostic it CAN compute from the bytes
// alone (byte length, full value histogram, on/off counts).

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PNG } from 'pngjs';
import type { RendererFn, RendererOutput } from '../rendererContract';

const ON_VALUE = 1;
const OFF_VALUE = 0;

// Display-only colors. 0/1 are the documented mask values; anything else
// is a finding, not a rendering nuisance -- it gets painted a color that
// cannot be mistaken for a real mask pixel (opaque red) instead of being
// silently clamped into black or white.
const OFF_RGBA = [0, 0, 0, 255] as const;
const ON_RGBA = [255, 255, 255, 255] as const;
const ANOMALY_RGBA = [255, 0, 0, 255] as const;

function safeSegment(s: string): string {
	return s.replace(/[^a-zA-Z0-9_.-]+/g, '_');
}

function withCommas(n: number): string {
	return n.toLocaleString('en-US');
}

/** Fixed 256-slot histogram -- mask bytes are a Uint8Array, so every value
 * is 0-255. A plain array indexed by value is O(n) over the bytes and
 * makes "every distinct value found, with its count" trivial to print. */
function histogram(bytes: Uint8Array): number[] {
	const counts = new Array<number>(256).fill(0);
	for (let i = 0; i < bytes.length; i++) counts[bytes[i]]++;
	return counts;
}

export const renderMask: RendererFn = (input) => {
	const { artifactRef, bytes, dims, outDir, opId, gate } = input;
	const totalBytes = bytes.length;
	const counts = histogram(bytes);
	const onCount = counts[ON_VALUE];
	const offCount = counts[OFF_VALUE];
	const onPct = totalBytes > 0 ? ((onCount / totalBytes) * 100).toFixed(4) : undefined;
	const distinctValues = counts.filter((c) => c > 0).length;
	const anomalies: Array<{ value: number; count: number }> = [];
	for (let v = 0; v < 256; v++) {
		if (v === ON_VALUE || v === OFF_VALUE) continue;
		if (counts[v] > 0) anomalies.push({ value: v, count: counts[v] });
	}

	// The renderer only receives the render-OUTPUT directory
	// (<outDir>/renders/<kind>, per artifactIo.ts's renderArtifact()), not
	// the path the artifact bytes were read from. Reconstructed here from
	// that same documented convention purely for the receipt's "file read"
	// line -- this is a filesystem-path convention, not detector data, so
	// deriving it does not violate LAB's "never recompute artifact content"
	// rule. If artifactIo.ts's directory layout ever changes, this line (and
	// only this line) goes stale.
	const reconstructedBaseOutDir = resolve(outDir, '..', '..');
	const reconstructedBytesPath = resolve(reconstructedBaseOutDir, 'artifacts', artifactRef.kind, `${artifactRef.id}.bin`);

	const baseName = `mask.${safeSegment(opId)}.${safeSegment(artifactRef.id)}`;
	const filesWritten: string[] = [];

	let dimsLine: string;
	let matchLine: string;
	let rasterNote: string;
	let pngPath: string | undefined;

	if (dims) {
		const product = dims.width * dims.height;
		const matches = product === totalBytes;
		if (matches) {
			pngPath = resolve(outDir, `${baseName}.png`);
			const png = new PNG({ width: dims.width, height: dims.height });
			for (let i = 0; i < totalBytes; i++) {
				const v = bytes[i];
				const rgba = v === OFF_VALUE ? OFF_RGBA : v === ON_VALUE ? ON_RGBA : ANOMALY_RGBA;
				const p = i * 4;
				png.data[p] = rgba[0];
				png.data[p + 1] = rgba[1];
				png.data[p + 2] = rgba[2];
				png.data[p + 3] = rgba[3];
			}
			writeFileSync(pngPath, PNG.sync.write(png));
			filesWritten.push(pngPath);
			dimsLine = `${dims.width} x ${dims.height} (source: RendererInput.dims)`;
			matchLine = `${dims.width} x ${dims.height} = ${withCommas(product)} vs ${withCommas(totalBytes)} bytes -- MATCH`;
			rasterNote = `Rasterized to PNG: ${pngPath}`;
		} else {
			dimsLine = `${dims.width} x ${dims.height} (source: RendererInput.dims) -- UNTRUSTED, see mismatch below`;
			matchLine = `${dims.width} x ${dims.height} = ${withCommas(product)} vs ${withCommas(totalBytes)} bytes -- MISMATCH`;
			rasterNote =
				`Declined to rasterize: dims (${dims.width}x${dims.height} = ${withCommas(product)} px) do not match ` +
				`the ${withCommas(totalBytes)} bytes actually on disk. Rendering with a shape the byte count ` +
				`contradicts would fabricate pixels LAB never computed -- this is a stub, not a guess.`;
		}
	} else {
		dimsLine =
			'unavailable (RendererInput.dims was undefined -- see rendererContract.ts GAP note; ' +
			'artifactIo.ts forwards artifactRef.dims verbatim, so this means the producing extractor/sink ' +
			'did not populate ArtifactRef.dims for this particular artifact, not a blanket artifactIo.ts limitation)';
		matchLine = `cannot compute width*height -- dims unavailable (byte length alone: ${withCommas(totalBytes)})`;
		rasterNote = 'Declined to rasterize: no dimensions available, and LAB never guesses shape from byte length alone.';
	}

	const histogramLines = counts
		.map((c, v) => (c > 0 ? `  value ${v}: ${withCommas(c)} byte(s)` : undefined))
		.filter((line): line is string => line !== undefined);
	if (histogramLines.length === 0) histogramLines.push('  (no bytes)');

	const anomalyLine =
		anomalies.length === 0
			? 'None -- every byte is 0 or 1. Data is strictly binary.'
			: `${anomalies.length} non-binary value(s) found: ` +
				anomalies.map((a) => `value ${a.value} x${withCommas(a.count)}`).join(', ') +
				' -- shouted here, not swallowed. When rasterized, these pixels are painted opaque red so they are ' +
				'visible in the PNG rather than silently folded into black or white.';

	const receiptPath = resolve(outDir, `${baseName}.receipt.txt`);
	const receiptLines = [
		'=== MASK RENDERER RECEIPT ===',
		`artifact id:   ${artifactRef.id}`,
		`artifact kind: ${artifactRef.kind}`,
		`opId:          ${opId}`,
		`gate:          ${gate}`,
		`sha256:        ${artifactRef.sha256}`,
		`uri:           ${artifactRef.uri}`,
		'',
		`dimensions:         ${dimsLine}`,
		`byte length:        ${withCommas(totalBytes)}`,
		`width*height check: ${matchLine}`,
		'',
		`pixels ON  (value 1): ${withCommas(onCount)}`,
		`pixels OFF (value 0): ${withCommas(offCount)}`,
		`percent ON:            ${onPct !== undefined ? `${onPct}%` : 'N/A (0 bytes)'}`,
		`distinct byte values present: ${distinctValues}`,
		'',
		'full value histogram (every distinct byte value found, with count):',
		...histogramLines,
		'',
		`non-0/1 anomalies: ${anomalyLine}`,
		'',
		`file read (artifact bytes; path reconstructed from artifactIo.ts's outDir convention -- see code comment):`,
		`  ${reconstructedBytesPath}`,
		rasterNote,
		`receipt written to: ${receiptPath}`
	];
	const receiptText = receiptLines.join('\n');

	writeFileSync(receiptPath, `${receiptText}\n`);
	filesWritten.push(receiptPath);

	const summary = dims
		? pngPath
			? `${dims.width}x${dims.height} PNG, ${withCommas(onCount)}/${withCommas(totalBytes)} px ON (${onPct}%)` +
				(anomalies.length > 0 ? `, ${anomalies.length} anomalous value(s) -- see receipt` : '')
			: `dims/byte-length MISMATCH (${dims.width}x${dims.height} vs ${totalBytes} bytes) -- stub only, see receipt`
		: `dims unavailable -- stub only; ${withCommas(onCount)}/${withCommas(totalBytes)} bytes are value 1 (${onPct ?? 'N/A'}%)`;

	// Testimony: this renderer's primary product is the rasterized PNG. A
	// text receipt always gets written (diagnostics are useful either way),
	// but `rendered` must say whether the picture actually happened -- true
	// only when dims were present, matched the byte length, and a PNG was
	// written; false for the "dims unavailable" and "dims mismatch" stub
	// paths, which write a receipt but no picture.
	const output: RendererOutput = { filesWritten, summary, rendered: pngPath !== undefined };
	return output;
};

export default renderMask;
