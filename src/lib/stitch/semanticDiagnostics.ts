import type { SemanticSourceLandmarks } from './semanticLandmarks';
import type { SemanticTranslationResult } from './semanticTranslation';

export interface SemanticOverlayOptions {
  readonly backgroundHref?: string;
  readonly label?: string;
}

const XML_ESCAPES: Readonly<Record<string, string>> = Object.freeze({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;'
});

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => XML_ESCAPES[ch] ?? ch);
}

function background(width: number, height: number, href?: string): string {
  return href
    ? `<image href="${escapeXml(href)}" x="0" y="0" width="${width}" height="${height}" preserveAspectRatio="none"/>`
    : `<rect x="0" y="0" width="${width}" height="${height}" fill="#111827"/>`;
}

/** SVG diagnostic overlay; deliberately not part of the production render path. */
export function renderSemanticLandmarkOverlaySvg(
  source: SemanticSourceLandmarks,
  options: SemanticOverlayOptions = {}
): string {
  const marks = source.landmarks
    .map((landmark, index) => {
      const stroke = landmark.family === 'badge' ? '#ef4444' : '#22c55e';
      const x = landmark.xPx - landmark.widthPx / 2;
      const y = landmark.yPx - landmark.heightPx / 2;
      return `<g><rect x="${x}" y="${y}" width="${landmark.widthPx}" height="${landmark.heightPx}" fill="none" stroke="${stroke}" stroke-width="3"/><circle cx="${landmark.xPx}" cy="${landmark.yPx}" r="4" fill="${stroke}"/><text x="${landmark.xPx + 6}" y="${landmark.yPx - 6}" fill="${stroke}" font-size="14">${landmark.family[0].toUpperCase()}${index + 1}</text></g>`;
    })
    .join('');
  const label = escapeXml(options.label ?? source.sourceId);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${source.widthPx} ${source.heightPx}" width="${source.widthPx}" height="${source.heightPx}">${background(source.widthPx, source.heightPx, options.backgroundHref)}${marks}<rect x="8" y="8" width="${Math.max(120, label.length * 9 + 16)}" height="28" fill="#000" fill-opacity="0.72"/><text x="16" y="28" fill="#fff" font-size="16">${label}</text></svg>`;
}

/** Shows winner correspondences after mapping B into A space. */
export function renderSemanticTranslationOverlaySvg(
  a: SemanticSourceLandmarks,
  result: SemanticTranslationResult,
  options: SemanticOverlayOptions = {}
): string {
  const winner = result.winner;
  const dx = winner?.dxPx ?? 0;
  const dy = winner?.dyPx ?? 0;
  const lines = winner?.correspondences
    .map((pair, index) => {
      const bx = pair.b.xPx + dx;
      const by = pair.b.yPx + dy;
      const stroke = pair.a.family === 'badge' ? '#ef4444' : '#22c55e';
      return `<g><line x1="${pair.a.xPx}" y1="${pair.a.yPx}" x2="${bx}" y2="${by}" stroke="${stroke}" stroke-width="2"/><circle cx="${pair.a.xPx}" cy="${pair.a.yPx}" r="7" fill="${stroke}"/><circle cx="${bx}" cy="${by}" r="11" fill="none" stroke="#fff" stroke-width="3"/><text x="${pair.a.xPx + 12}" y="${pair.a.yPx - 10}" fill="#fff" font-size="14">${index + 1}</text></g>`;
    })
    .join('') ?? '';
  const status = result.ok && winner
    ? `Δ=(${winner.dxPx.toFixed(1)}, ${winner.dyPx.toFixed(1)}) inliers=${winner.inlierCount} rms=${winner.rmsResidualPx.toFixed(2)}`
    : `abstain: ${result.reason ?? 'no winner'}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${a.widthPx} ${a.heightPx}" width="${a.widthPx}" height="${a.heightPx}">${background(a.widthPx, a.heightPx, options.backgroundHref)}${lines}<rect x="8" y="8" width="${Math.max(280, status.length * 8 + 16)}" height="28" fill="#000" fill-opacity="0.72"/><text x="16" y="28" fill="#fff" font-size="16">${escapeXml(status)}</text></svg>`;
}
