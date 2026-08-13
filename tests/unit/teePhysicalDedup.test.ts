import { describe, expect, it } from 'vitest';
import { deduplicatePhysicalTeePads, samePhysicalTeePad } from '../../src/lib/autoAnnotation/teePhysicalDedup';
import type { TeePadCandidate } from '../../src/lib/autoAnnotation/teePadDetection';

function tee(overrides: Partial<TeePadCandidate> = {}): TeePadCandidate {
	return {
		xPx: 100,
		yPx: 100,
		orientationDeg: 5,
		widthPx: 40,
		heightPx: 24,
		score: 0.8,
		support: ['edge-loop'],
		...overrides
	};
}

describe('native-coordinate tee physical-pad deduplication', () => {
	it('merges nearby compatible hypotheses and retains detector provenance', () => {
		const clusters = deduplicatePhysicalTeePads([
			tee({ provenance: [{ tier: 'primary', support: 'edge-loop' }] }),
			tee({ xPx: 111, yPx: 104, orientationDeg: 178, score: 0.9, support: ['gray-center'], provenance: [{ tier: 'weak-template', support: 'gray-center' }] })
		]);
		expect(clusters).toHaveLength(1);
		expect(clusters[0].sourceIndexes).toEqual([0, 1]);
		expect(clusters[0].candidate.support).toEqual(['edge-loop', 'gray-center']);
		expect(clusters[0].candidate.provenance).toHaveLength(2);
	});

	it('does not collapse distinct nearby pads with incompatible axes', () => {
		expect(samePhysicalTeePad(tee(), tee({ xPx: 116, orientationDeg: 80 }))).toBe(false);
		expect(deduplicatePhysicalTeePads([tee(), tee({ xPx: 116, orientationDeg: 80 })])).toHaveLength(2);
	});

	it('is scale-relative', () => {
		const small = samePhysicalTeePad(tee({ xPx: 0, yPx: 0, widthPx: 20, heightPx: 12 }), tee({ xPx: 7, yPx: 0, widthPx: 20, heightPx: 12 }));
		const large = samePhysicalTeePad(tee({ xPx: 0, yPx: 0, widthPx: 40, heightPx: 24 }), tee({ xPx: 14, yPx: 0, widthPx: 40, heightPx: 24 }));
		expect(large).toBe(small);
	});
});
