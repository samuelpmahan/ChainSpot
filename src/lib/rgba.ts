// Browser boundary for the Detector contract: original file bytes → RgbaRaster
// with a content-addressed imageId (sha256 of the bytes).
//
// The decode itself now lives in @chainspot/alg's browser adapter (CHSPT-82
// decode-adapter track), shared with the Node adapter's InputAsset contract
// (packages/alg/src/g0/inputAsset.ts) so both decode paths agree on what an
// "image" is. InputAsset is a strict superset of RgbaRaster (it adds
// sourceByteLength), so re-exporting it under this file's existing name/type
// keeps every call site (`rgbaFromFile(file): Promise<RgbaRaster>`) compiling
// unchanged.
export { decodeBrowserFile as rgbaFromFile } from '@chainspot/alg/adapters/browser';
