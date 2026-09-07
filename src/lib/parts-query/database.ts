import * as duckdb from '@duckdb/duckdb-wasm';
import wasm from '@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url';
import workerUrl from '@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url';
import ehWasm from '@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url';
import ehWorkerUrl from '@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url';
import type { projectRun } from './projection';
import { loadTables } from './tables';

/** One disposable database per completed run. PxC remains the source of the actual Parts. */
export async function openRunDatabase(projection: ReturnType<typeof projectRun>) {
  const bundle = await duckdb.selectBundle({ mvp: { mainModule: wasm, mainWorker: workerUrl }, eh: { mainModule: ehWasm, mainWorker: ehWorkerUrl } });
  const worker = new Worker(bundle.mainWorker!);
  const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
  try {
    await db.instantiate(bundle.mainModule);
    const connection = await db.connect();
    await loadTables(connection, projection.tables);
    const version = await db.getVersion();
    return {
      version,
      async query(sql: string): Promise<Record<string, unknown>[]> {
        const table = await connection.query(sql);
        return table.toArray().map(row => Object.fromEntries(Object.entries(row.toJSON())));
      },
      async close() {
        try { await connection.close(); } finally { await db.terminate(); }
      }
    };
  } catch (error) {
    await db.terminate();
    throw error;
  }
}
