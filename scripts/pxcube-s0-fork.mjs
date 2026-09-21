import { materializeComposite } from '../packages/alg/dist/g0/composite.js';
import { toGrayRaster } from '../packages/alg/dist/g0/inputAsset.js';
import { stripChromeProposal } from '../packages/alg/dist/g0/stripChrome.js';

export async function runS0CropFork(fullImage, candidateInsets) {
  const tile = [{ rgba: fullImage.rgba, widthPx: fullImage.widthPx, heightPx: fullImage.heightPx, placement: { x: 0, y: 0 } }];
  const startedClean = performance.now();
  const cleanCrop = stripChromeProposal([toGrayRaster(fullImage)]);
  const clean = await materializeComposite(tile, cleanCrop.insets);
  const cleanMs = performance.now() - startedClean;

  const startedCandidate = performance.now();
  const candidate = await materializeComposite(tile, candidateInsets);
  const candidateMs = performance.now() - startedCandidate;

  return {
    tick: 'source.cropUDiscChrome',
    authoritative: {
      lineage: 'clean',
      crop: cleanCrop,
      output: { imageId: clean.imageId, widthPx: clean.widthPx, heightPx: clean.heightPx },
      elapsedMs: cleanMs
    },
    observations: [{
      lineage: 'exp/manual-insets',
      boundary: 'STOP',
      crop: { insets: candidateInsets, source: 'override' },
      output: { imageId: candidate.imageId, widthPx: candidate.widthPx, heightPx: candidate.heightPx },
      elapsedMs: candidateMs,
      comparison: {
        samePixels: clean.imageId === candidate.imageId,
        widthDeltaPx: candidate.widthPx - clean.widthPx,
        heightDeltaPx: candidate.heightPx - clean.heightPx,
        cleanInsets: cleanCrop.insets,
        candidateInsets
      }
    }]
  };
}
