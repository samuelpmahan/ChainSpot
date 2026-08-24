# LAB scope — intentionally deferred optimization

`lab scope` v0 optimizes for a trustworthy visual loop, not throughput.

Do not block usability on any item below:

- cache decoded rasters across repeated scopes;
- avoid repeated manifest-case decode work;
- smarter single-hole framing than tee/bends/basket bounds + corridor padding;
- crop-first execution only where it can be proven semantically equivalent;
- incremental contact-sheet updates;
- renderer acceleration or browser presentation;
- richer visual labeling for named pins/trails beyond the current sidecar + CLI handles;
- additional scope templates after a real second presentation earns the abstraction.

Search-path continuation/backtracking/branching and TempPins are NOT deferred optimization: they are required v0 usability behavior.

Load-bearing invariant: algorithm/raster execution must keep one LAB intake/execution path through sweep/shared seams. Scope must not grow a shadow detector runner.
