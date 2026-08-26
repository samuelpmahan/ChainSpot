export interface CapturedSource {
	readonly file: File;
	readonly selectionIndex: number;
	readonly imageId: string;
	readonly sourceByteLength: number;
	readonly readMs: number;
	readonly hashMs: number;
}

export type SourceCaptureEntry =
	| { readonly ok: true; readonly source: CapturedSource }
	| {
			readonly ok: false;
			readonly file: File;
			readonly selectionIndex: number;
			readonly reason: 'source-read-or-hash-failed';
	  };

export interface SourceCaptureReceipt {
	readonly snapshotMs: number;
	readonly totalMs: number;
	readonly entries: readonly SourceCaptureEntry[];
}

function elapsedMs(startedAt: number): number {
	return performance.now() - startedAt;
}

function hex(bytes: ArrayBuffer): string {
	return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Snapshot the live selection, then read and identify each immutable File. */
export async function captureSelectedSources(
	selection: Iterable<File> | null
): Promise<SourceCaptureReceipt> {
	const startedAt = performance.now();
	const snapshotStartedAt = performance.now();
	const files = Array.from(selection ?? []);
	const snapshotMs = elapsedMs(snapshotStartedAt);

	const entries = await Promise.all(
		files.map(async (file, selectionIndex): Promise<SourceCaptureEntry> => {
			try {
				const readStartedAt = performance.now();
				const bytes = await file.arrayBuffer();
				const readMs = elapsedMs(readStartedAt);
				const hashStartedAt = performance.now();
				const imageId = hex(await crypto.subtle.digest('SHA-256', bytes));
				const hashMs = elapsedMs(hashStartedAt);
				return {
					ok: true,
					source: {
						file,
						selectionIndex,
						imageId,
						sourceByteLength: bytes.byteLength,
						readMs,
						hashMs
					}
				};
			} catch {
				return { ok: false, file, selectionIndex, reason: 'source-read-or-hash-failed' };
			}
		})
	);

	return { snapshotMs, totalMs: elapsedMs(startedAt), entries };
}

export function formatSourceCaptureReceipt(receipt: SourceCaptureReceipt): string {
	const rows = receipt.entries.map((entry) => {
		if (!entry.ok) {
			return `source[${entry.selectionIndex}] REJECT ${entry.file.name} reason=${entry.reason}`;
		}
		const { source } = entry;
		return `source[${source.selectionIndex}] ACCEPT ${source.file.name} bytes=${source.sourceByteLength} imageId=${source.imageId} readMs=${source.readMs.toFixed(2)} hashMs=${source.hashMs.toFixed(2)}`;
	});
	return [
		`capture-source-files snapshotMs=${receipt.snapshotMs.toFixed(2)} totalMs=${receipt.totalMs.toFixed(2)}`,
		...rows
	].join('\n');
}
