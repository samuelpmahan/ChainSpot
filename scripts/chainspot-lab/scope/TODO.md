# LAB scope — intentionally deferred optimization

`lab scope` v0 optimizes for a trustworthy visual loop, not throughput.

Do not block usability on any item below:

- cache decoded rasters across repeated scopes;
- avoid repeated manifest-case decode work;
- smarter single-hole framing than tee/bends/basket bounds + corridor padding;
- crop-first execution only where it can be proven semantically equivalent;
- incremental contact-sheet updates;
- richer search-path editing/backtracking state;
- renderer acceleration or browser presentation;
- additional scope templates after a real second presentation earns the abstraction.

Load-bearing invariant: algorithm/raster execution must keep one LAB intake/execution path through sweep/shared seams. Scope must not grow a shadow detector runner.
