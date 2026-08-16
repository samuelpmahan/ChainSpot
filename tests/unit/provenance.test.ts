import { describe, expect, it } from 'vitest';
import {
	applySourceTransform,
	assertCoherentProvenance,
	CURRENT_PROVENANCE_SCHEMA_VERSION,
	CURRENT_RENDER_VERSION,
	identitySourceTransform,
	ProvenanceCoherenceError,
	translationSourceTransform
} from '../../src/lib/domain/provenance';
import type {
	CompositeProvenance,
	SourceCapture,
	SourceCropRect,
	SourceOverlapEdge,
	SourceTransform
} from '../../src/lib/domain/provenance';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const SHA_FINAL = 'c'.repeat(64);

/** Coverage polygon corners in the module's documented order: [TL, TR, BR, BL]. */
function coveragePolygonOf(crop: SourceCropRect, transform: SourceTransform) {
	const corners = [
		{ xPx: crop.xPx, yPx: crop.yPx },
		{ xPx: crop.xPx + crop.widthPx, yPx: crop.yPx },
		{ xPx: crop.xPx + crop.widthPx, yPx: crop.yPx + crop.heightPx },
		{ xPx: crop.xPx, yPx: crop.yPx + crop.heightPx }
	];
	return corners.map((corner) => applySourceTransform(corner, transform));
}

function buildCapture(overrides: {
	sourceId: string;
	sha256: string;
	widthPx?: number;
	heightPx?: number;
	crop?: SourceCropRect;
	transform?: SourceTransform;
	paintOrder: number;
}): SourceCapture {
	const widthPx = overrides.widthPx ?? 100;
	const heightPx = overrides.heightPx ?? 100;
	const crop = overrides.crop ?? { xPx: 0, yPx: 0, widthPx, heightPx };
	const transform = overrides.transform ?? identitySourceTransform();
	return {
		sourceId: overrides.sourceId,
		fileName: `${overrides.sourceId}.png`,
		mimeType: 'image/png',
		widthPx,
		heightPx,
		sha256: overrides.sha256,
		crop,
		transform,
		coveragePolygon: coveragePolygonOf(crop, transform),
		paintOrder: overrides.paintOrder
	};
}

/** N=1 (AutoCrop only): identity transform, no crop offset, no stitch. */
function singleSourceFixture(): CompositeProvenance {
	const source = buildCapture({ sourceId: 'src-1', sha256: SHA_A, paintOrder: 0 });
	return {
		schemaVersion: CURRENT_PROVENANCE_SCHEMA_VERSION,
		renderVersion: CURRENT_RENDER_VERSION,
		outputWidthPx: source.widthPx,
		outputHeightPx: source.heightPx,
		compositingPolicy: 'single-source-v1',
		resampling: 'none',
		sources: [source],
		overlaps: [],
		finalRasterSha256: SHA_FINAL
	};
}

/** N=2 (AutoCrop + AutoStitch): two 100x100 captures placed side by side with an overlap edge. */
function twoSourceFixture(): CompositeProvenance {
	const left = buildCapture({ sourceId: 'src-left', sha256: SHA_A, paintOrder: 0 });
	const right = buildCapture({
		sourceId: 'src-right',
		sha256: SHA_B,
		transform: translationSourceTransform(80, 0),
		paintOrder: 1
	});
	const overlap: SourceOverlapEdge = { a: 'src-left', b: 'src-right', kind: 'placement-edge', score: 0.87 };
	return {
		schemaVersion: CURRENT_PROVENANCE_SCHEMA_VERSION,
		renderVersion: CURRENT_RENDER_VERSION,
		outputWidthPx: 180,
		outputHeightPx: 100,
		compositingPolicy: 'stitch-ascending-bottom-right-v1',
		resampling: 'none',
		sources: [left, right],
		overlaps: [overlap],
		finalRasterSha256: SHA_FINAL
	};
}

describe('assertCoherentProvenance: well-formed fixtures', () => {
	it('accepts a single-source (AutoCrop only, N=1) fixture', () => {
		expect(() => assertCoherentProvenance(singleSourceFixture())).not.toThrow();
	});

	it('accepts a multi-source (AutoCrop + AutoStitch, N=2) fixture with a placement edge', () => {
		expect(() => assertCoherentProvenance(twoSourceFixture())).not.toThrow();
	});
});

describe('assertCoherentProvenance: contradiction cases', () => {
	it('rejects a coverage polygon that does not match transform(crop)', () => {
		const provenance = singleSourceFixture();
		const tampered: CompositeProvenance = {
			...provenance,
			sources: [
				{
					...provenance.sources[0],
					coveragePolygon: provenance.sources[0].coveragePolygon.map((point, index) =>
						index === 0 ? { xPx: point.xPx + 5, yPx: point.yPx } : point
					)
				}
			]
		};
		expect(() => assertCoherentProvenance(tampered)).toThrow(ProvenanceCoherenceError);
		expect(() => assertCoherentProvenance(tampered)).toThrow(/coveragePolygon/);
	});

	it('rejects a paintOrder that is not a permutation of the source list', () => {
		const provenance = twoSourceFixture();
		const tampered: CompositeProvenance = {
			...provenance,
			sources: provenance.sources.map((source) => ({ ...source, paintOrder: 0 }))
		};
		expect(() => assertCoherentProvenance(tampered)).toThrow(ProvenanceCoherenceError);
		expect(() => assertCoherentProvenance(tampered)).toThrow(/paintOrder/);
	});

	it('rejects an overlap edge naming an unknown source', () => {
		const provenance = twoSourceFixture();
		const tampered: CompositeProvenance = {
			...provenance,
			overlaps: [{ a: 'src-left', b: 'src-does-not-exist', kind: 'placement-edge', score: 0.5 }]
		};
		expect(() => assertCoherentProvenance(tampered)).toThrow(ProvenanceCoherenceError);
		expect(() => assertCoherentProvenance(tampered)).toThrow(/unknown source/);
	});

	it("rejects the wrong source count for compositingPolicy 'single-source-v1'", () => {
		const provenance = twoSourceFixture();
		const tampered: CompositeProvenance = { ...provenance, compositingPolicy: 'single-source-v1' };
		expect(() => assertCoherentProvenance(tampered)).toThrow(ProvenanceCoherenceError);
		expect(() => assertCoherentProvenance(tampered)).toThrow(/single-source-v1/);
	});

	it('rejects an empty sources list', () => {
		const provenance = singleSourceFixture();
		const tampered: CompositeProvenance = { ...provenance, sources: [] };
		expect(() => assertCoherentProvenance(tampered)).toThrow(ProvenanceCoherenceError);
	});

	it('rejects a duplicate sourceId across sources', () => {
		const provenance = twoSourceFixture();
		const tampered: CompositeProvenance = {
			...provenance,
			sources: [provenance.sources[0], { ...provenance.sources[1], sourceId: provenance.sources[0].sourceId }]
		};
		expect(() => assertCoherentProvenance(tampered)).toThrow(ProvenanceCoherenceError);
	});

	it('rejects a self-referencing overlap edge', () => {
		const provenance = twoSourceFixture();
		const tampered: CompositeProvenance = {
			...provenance,
			overlaps: [{ a: 'src-left', b: 'src-left', kind: 'placement-edge', score: 0.5 }]
		};
		expect(() => assertCoherentProvenance(tampered)).toThrow(ProvenanceCoherenceError);
	});

	it('rejects a non-finite or non-positive output dimension', () => {
		const provenance = singleSourceFixture();
		expect(() => assertCoherentProvenance({ ...provenance, outputWidthPx: Number.NaN })).toThrow(
			ProvenanceCoherenceError
		);
		expect(() => assertCoherentProvenance({ ...provenance, outputHeightPx: 0 })).toThrow(
			ProvenanceCoherenceError
		);
	});
});
