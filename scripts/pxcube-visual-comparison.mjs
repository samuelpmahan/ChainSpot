/**
 * Produce renderer-independent visual comparison testimony.
 * Pixels stay in their native lineage; this only describes how a materializer
 * can place SOURCE | CLEAN | CANDIDATE | DELTA without recomputing truth.
 */
export function visualComparisonSpec({ source, clean, candidate, receipt }) {
  if (!source || !clean || !candidate) throw new Error('visual comparison requires source, clean and candidate');
  return {
    kind: 'pxcube.visual-comparison',
    authority: receipt.authority,
    candidate: receipt.candidate,
    boundary: receipt.boundary,
    panels: [
      { role: 'SOURCE', imageId: source.imageId, widthPx: source.widthPx, heightPx: source.heightPx },
      { role: 'CLEAN', imageId: clean.imageId, widthPx: clean.widthPx, heightPx: clean.heightPx },
      { role: 'CANDIDATE', imageId: candidate.imageId, widthPx: candidate.widthPx, heightPx: candidate.heightPx },
      {
        role: 'DELTA',
        mode: 'membership',
        cleanInsets: receipt.difference.cleanInsets,
        candidateInsets: receipt.difference.candidateInsets,
        sourceImageId: source.imageId
      }
    ]
  };
}

export function changedMembershipBands(widthPx, heightPx, cleanInsets, candidateInsets) {
  const zero = { top: 0, right: 0, bottom: 0, left: 0 };
  const a = cleanInsets ?? zero, b = candidateInsets ?? zero;
  const bands = [];
  for (const side of ['top','right','bottom','left']) {
    if (a[side] === b[side]) continue;
    bands.push({ side, cleanPx: a[side], candidatePx: b[side], deltaPx: b[side] - a[side] });
  }
  return { widthPx, heightPx, bands };
}
