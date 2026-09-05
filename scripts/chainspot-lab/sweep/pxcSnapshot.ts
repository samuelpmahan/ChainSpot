import { createHash } from 'node:crypto';
import { deserialize, serialize } from 'node:v8';
import { createExecBoard, type PxC } from '@chainspot/alg/exec/board';

/** Explicit address custody: no reflection into a board's private storage. */
export function capturePxC(pxc: PxC, addresses: readonly string[]): Buffer {
  return serialize([...new Set(addresses)].map(address => {
    if (!pxc.has(address)) throw new Error(`PxC snapshot: missing declared address '${address}'.`);
    return [address, pxc.get(address)];
  }));
}

/** Each restore owns fresh arrays/objects; calculated functions are registered by its consumer. */
export function restorePxC(bytes: Uint8Array): PxC {
  // V8 can return views backed by the supplied serialized buffer. Copy per restore.
  const entries: unknown = deserialize(Buffer.from(bytes));
  if (!Array.isArray(entries)) throw new Error('PxC snapshot: invalid entries.');
  const pxc = createExecBoard();
  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string')
      throw new Error('PxC snapshot: invalid address/value pair.');
    pxc.set(entry[0], entry[1]);
  }
  return pxc;
}

export function digest(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function snapshotIdentity(parts: Readonly<Record<string, string>>): string {
  return digest(JSON.stringify(Object.entries(parts).sort(([a], [b]) => a.localeCompare(b))));
}
