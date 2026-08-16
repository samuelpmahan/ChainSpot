import { describe, expect, it } from 'vitest';
import { reconstructProvenance } from '../../src/lib/domain/provenanceReconstruct';
import type { ReconstructRenderComposite } from '../../src/lib/domain/provenanceReconstruct';
import {
	applySourceTransform,
	CURRENT_PROVENANCE_SCHEMA_VERSION,
	CURRENT_RENDER_VERSION,
	identitySourceTransform,
	sealCompositeProvenance
} from '../../src/lib/domain/provenance';
import type { CompositeProvenance, DraftComposite, SourceCapture, SourceCropRect } from '../../src/lib/domain/provenance';
import { sha256Hex } from '../../src/lib/imageIntake';
import type { DecodeImageFile } from '../../src/lib/imageIntake';

const SRC_BYTES = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

function coveragePolygonOf(crop: SourceCropRect, transform: ReturnType<typeof identitySourceTransform>) {
	const corners = [
		{ xPx: crop.xPx, yPx: crop.yPx },
		{ xPx: crop.xPx + crop.widthPx, yPx: crop.yPx },
		{ xPx: crop.xPx + crop.widthPx, yPx: crop.yPx + crop.heightPx },
		{ xPx: crop.xPx, yPx: crop.yPx + crop.heightPx }
	];
	return corners.map((corner) => applySourceTransform(corner, transform));
}

async function singleSourceDraft(sha256: string): Promise<DraftComposite> {
	const transform = identitySourceTransform();
	const crop: SourceCropRect = { xPx: 0, yPx: 0, widthPx: 4, heightPx: 4 };
	const source: SourceCapture = {
		sourceId: 'src-1',
		fileName: 'udisc-1.png',
		mimeType: 'image/png',
		widthPx: 4,
		heightPx: 4,
		sha256,
		crop,
		transform,
		coveragePolygon: coveragePolygonOf(crop, transform),
		paintOrder: 0
	};
	return {
		schemaVersion: CURRENT_PROVENANCE_SCHEMA_VERSION,
		renderVersion: CURRENT_RENDER_VERSION,
		outputWidthPx: 4,
		outputHeightPx: 4,
		compositingPolicy: 'single-source-v1',
		resampling: 'none',
		sources: [source],
		overlaps: []
	};
}

const decodeOf: DecodeImageFile = async (file) => ({
	image: { simulated: true, name: file.name } as unknown as HTMLImageElement,
	widthPx: 4,
	heightPx: 4
});

/** A fake renderer that just returns a fixed blob and seals provenance from the draft with a caller-supplied hash. */
function fakeRenderer(blobBytes: Uint8Array, finalRasterSha256: string): ReconstructRenderComposite {
	return async (draft) => ({
		blob: new Blob([new Uint8Array(blobBytes)]),
		provenance: sealCompositeProvenance(draft, finalRasterSha256)
	});
}

describe('reconstructProvenance: match path', () => {
	it('reconstructs and verifies the hash when original bytes and the render agree with recorded provenance', async () => {
		const sourceSha256 = await sha256Hex(SRC_BYTES);
		const renderedBytes = new Uint8Array([9, 9, 9, 9]);
		const finalSha256 = await sha256Hex(renderedBytes);
		const draft = await singleSourceDraft(sourceSha256);
		const provenance: CompositeProvenance = { ...draft, finalRasterSha256: finalSha256 };

		const result = await reconstructProvenance({
			provenance,
			sourceBytes: new Map([['src-1', SRC_BYTES]]),
			decode: decodeOf,
			render: fakeRenderer(renderedBytes, finalSha256)
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.actualSha256).toBe(finalSha256);
		expect([...new Uint8Array(await result.blob.arrayBuffer())]).toEqual([...renderedBytes]);
	});
});

describe('reconstructProvenance: mismatch and failure paths (never throw)', () => {
	it('reports missing-source-bytes without throwing when a referenced capture has no bytes', async () => {
		const sourceSha256 = await sha256Hex(SRC_BYTES);
		const draft = await singleSourceDraft(sourceSha256);
		const provenance: CompositeProvenance = { ...draft, finalRasterSha256: 'f'.repeat(64) };

		const result = await reconstructProvenance({
			provenance,
			sourceBytes: new Map(),
			decode: decodeOf,
			render: fakeRenderer(new Uint8Array([1]), 'f'.repeat(64))
		});

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toBe('missing-source-bytes');
		expect(result.message).toContain('src-1');
	});

	it('reports a hash-mismatch (not a throw) when the original capture bytes no longer match the recorded hash', async () => {
		const draft = await singleSourceDraft('a'.repeat(64)); // deliberately wrong recorded hash
		const provenance: CompositeProvenance = { ...draft, finalRasterSha256: 'f'.repeat(64) };

		const result = await reconstructProvenance({
			provenance,
			sourceBytes: new Map([['src-1', SRC_BYTES]]),
			decode: decodeOf,
			render: fakeRenderer(new Uint8Array([1]), 'f'.repeat(64))
		});

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toBe('hash-mismatch');
		expect(result.expectedSha256).toBe('a'.repeat(64));
		expect(result.actualSha256).toBe(await sha256Hex(SRC_BYTES));
	});

	it('reports a hash-mismatch (not a throw) when the reconstructed raster does not match finalRasterSha256', async () => {
		const sourceSha256 = await sha256Hex(SRC_BYTES);
		const draft = await singleSourceDraft(sourceSha256);
		const recordedFinalSha256 = 'e'.repeat(64); // deliberately wrong vs. what the renderer will actually produce
		const provenance: CompositeProvenance = { ...draft, finalRasterSha256: recordedFinalSha256 };
		const renderedBytes = new Uint8Array([9, 9, 9, 9]);
		const actualRenderedSha256 = await sha256Hex(renderedBytes);

		const result = await reconstructProvenance({
			provenance,
			sourceBytes: new Map([['src-1', SRC_BYTES]]),
			decode: decodeOf,
			render: fakeRenderer(renderedBytes, actualRenderedSha256)
		});

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toBe('hash-mismatch');
		expect(result.expectedSha256).toBe(recordedFinalSha256);
		expect(result.actualSha256).toBe(actualRenderedSha256);
	});

	it('reports decode-failure without throwing when the injected decoder rejects', async () => {
		const sourceSha256 = await sha256Hex(SRC_BYTES);
		const draft = await singleSourceDraft(sourceSha256);
		const provenance: CompositeProvenance = { ...draft, finalRasterSha256: 'f'.repeat(64) };
		const failingDecode: DecodeImageFile = async () => {
			throw new Error('simulated decode failure');
		};

		const result = await reconstructProvenance({
			provenance,
			sourceBytes: new Map([['src-1', SRC_BYTES]]),
			decode: failingDecode,
			render: fakeRenderer(new Uint8Array([1]), 'f'.repeat(64))
		});

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toBe('decode-failure');
	});

	it('reports render-failure without throwing when the injected renderer rejects', async () => {
		const sourceSha256 = await sha256Hex(SRC_BYTES);
		const draft = await singleSourceDraft(sourceSha256);
		const provenance: CompositeProvenance = { ...draft, finalRasterSha256: 'f'.repeat(64) };
		const failingRender: ReconstructRenderComposite = async () => {
			throw new Error('simulated render failure');
		};

		const result = await reconstructProvenance({
			provenance,
			sourceBytes: new Map([['src-1', SRC_BYTES]]),
			decode: decodeOf,
			render: failingRender
		});

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toBe('render-failure');
	});

	it('throws (fails loudly) on structurally incoherent provenance before attempting reconstruction', async () => {
		const draft = await singleSourceDraft(await sha256Hex(SRC_BYTES));
		const provenance: CompositeProvenance = {
			...draft,
			// Non-permutation paintOrder makes this structurally incoherent.
			sources: [{ ...draft.sources[0], paintOrder: 7 }],
			finalRasterSha256: 'f'.repeat(64)
		};
		let renderCalled = false;

		await expect(
			reconstructProvenance({
				provenance,
				sourceBytes: new Map([['src-1', SRC_BYTES]]),
				decode: decodeOf,
				render: async (...args) => {
					renderCalled = true;
					return fakeRenderer(new Uint8Array([1]), 'f'.repeat(64))(...args);
				}
			})
		).rejects.toThrow(/paintOrder/);
		expect(renderCalled).toBe(false);
	});
});
