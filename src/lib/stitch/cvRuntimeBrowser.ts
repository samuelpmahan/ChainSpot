/**
 * Isolated so this file's *static* import of `@techstark/opencv-js` is only
 * ever reached via a dynamic `import('./cvRuntimeBrowser')` from the
 * browser/worker branch of `cvRuntime.ts`'s `getCv()`. See that file's doc
 * comment for why the static import matters and why this can't just live
 * inline in `cvRuntime.ts`: a static import at that module's top level would
 * also be evaluated eagerly under Vite's SSR module runner (vitest), which
 * hits a related interop bug of its own. Because this file is never reached
 * on the Node/SSR code path (that branch returns before the dynamic import
 * happens), vitest never loads it.
 */
import cvReady from '@techstark/opencv-js';

export default cvReady;
