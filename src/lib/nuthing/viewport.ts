/**
 * Map-viewport cropping for the P1.5 pipeline, delegating to the production
 * auto-crop (src/lib/stitch/autoCrop.ts `proposeSingleImageCrop` — the
 * entropy vertical-band detector already validated on UDisc screenshots)
 * rather than a parallel detector.
 *
 * Why cropping is load-bearing here: app chrome (status bar, header, bottom
 * bar) carries the strongest edges in a capture, so it dominates the ribbon
 * support field's percentile normalization (deflating real course evidence)
 * and pollutes the bright-component universe. Cropping also reproduces the
 * coordinate frames the dev annotations were drawn in (Lenard's registration
 * dy of 429px IS its chrome height).
 */

import type { RgbaImage } from './raster';
import type { AnalysisRaster } from '../stitch/analysis';
import { proposeSingleImageCrop } from '../stitch/autoCrop';

export interface Viewport {
  /** First map row (inclusive). */
  top: number;
  /** One past the last map row. */
  bottom: number;
}

/** Same grayscale as the stitch analysis pipeline, at native resolution. */
function toGrayRaster(image: RgbaImage): AnalysisRaster {
  const { width, height, data } = image;
  const gray = new Uint8Array(width * height);
  for (let i = 0, j = 0; j < gray.length; i += 4, j++) {
    gray[j] = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114 + 0.5) | 0;
  }
  return { widthPx: width, heightPx: height, gray, scale: 1 };
}

/**
 * Production auto-crop proposal applied as top/bottom row bounds. A null or
 * absent proposal (e.g. a chromeless capture like DashsTrack) keeps the full
 * image.
 */
export function detectMapViewport(image: RgbaImage): Viewport {
  const proposal = proposeSingleImageCrop(toGrayRaster(image));
  if (!proposal.insets) return { top: 0, bottom: image.height };
  return {
    top: proposal.insets.topPx,
    bottom: image.height - proposal.insets.bottomPx,
  };
}

/** Crop an RgbaImage to a row range (full width). */
export function cropRows(image: RgbaImage, viewport: Viewport): RgbaImage {
  const { width, data } = image;
  const height = viewport.bottom - viewport.top;
  const out = new Uint8Array(width * height * 4);
  out.set(data.subarray(viewport.top * width * 4, viewport.bottom * width * 4) as Uint8Array);
  return { width, height, data: out };
}
