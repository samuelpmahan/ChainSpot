import { createHash } from 'node:crypto';

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).sort().map(k => JSON.stringify(k)+':'+canonical(value[k])).join(',') + '}';
}
export function calculationCacheKey({ address, implementationHash, inputPartIds, runArgs = {} }) {
  const payload = canonical({ address, implementationHash, inputPartIds: [...inputPartIds], runArgs });
  return createHash('sha256').update(payload).digest('hex');
}
