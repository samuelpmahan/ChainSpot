// @chainspot/alg — the pure course-detection algorithm surface: the
// Detector contract (detect.ts), the raster crop/stitch primitives, and the
// detector implementations (reachable via deep subpath imports, e.g.
// '@chainspot/alg/detectors/threeFactor'). No DOM, no SvelteKit, no Node-only
// APIs. See detect.ts's own header for the contract's rules.
//
// This barrel deliberately re-exports only the top-level pure algorithm
// pieces the app imports bare — detect's types, the pure raster slice, and
// autoCrop/stitch. The detectors/** subtree is intentionally NOT barreled
// here (it's large, and both detectors/threeFactor and detectors/labEndpoint
// have their own internal raster.ts that would collide by name with this
// package's raster.ts); consumers reach it via explicit subpaths, matching
// how the app already named them before this move.

export * from './detect';
export * from './raster';
export * from './autoCrop';
export * from './stitch';
