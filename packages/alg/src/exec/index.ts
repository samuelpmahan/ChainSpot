// Browser-safe exec surface: the shared contract, the generic evidence
// board, the in-memory/null sinks, the compiler, and the ONE gateway. The
// Node-only filesystem sink lives at a separate subpath
// ('@chainspot/alg/exec/node-sink') and is deliberately NOT re-exported
// here, so importing '@chainspot/alg/exec' never pulls in node:fs/node:path
// (R1).

export * from './contract';
export * from './board';
export * from './sink';
export * from './compile';
export * from './gateway';
export * from './operations';
