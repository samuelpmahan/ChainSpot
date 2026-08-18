import type { SemanticSourceLandmarks } from './semanticLandmarks';

export interface SemanticOverlayOptions {
  readonly backgroundHref?: string;
  readonly label?: string;
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[ch]!);
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
