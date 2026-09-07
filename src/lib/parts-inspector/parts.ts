import { pixelLayers, type PixelLayer } from '../../../packages/alg/src/exec/render';

type RecordValue = Record<string, unknown>;
export interface InspectionItem {
  key: string;
  group: string;
  label: string;
  value: unknown;
  reason: string;
}
export interface InspectablePart {
  key: string;
  id: string;
  paths: string[];
  value: RecordValue;
  layer: PixelLayer;
}

function record(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && !ArrayBuffer.isView(value) ? value as RecordValue : undefined;
}

function identity(value: unknown): string | undefined {
  const node = record(value);
  if (!node) return undefined;
  if (typeof node.id === 'string') return node.id;
  return identity(node.part) ?? identity(node.plate) ?? identity(node.component) ?? identity(node.anchor);
}

/** Keep rejected, incomplete, and empty collections visible alongside successful outputs. */
export function outputGroups(value: unknown): { name: string; items: InspectionItem[] }[] {
  const node = record(value);
  const groups: [string, unknown[]][] = Array.isArray(value) ? [['items', value]] :
    node ? Object.entries(node).filter(([key, child]) => key !== 'pixels' && Array.isArray(child)) as [string, unknown[]][] : [];
  if (!groups.length) groups.push(['output', [value]]);
  return groups.map(([name, children]) => ({ name, items: children.map((child, index) => {
    const item = record(child);
    return {
      key: `${name}:${index}`, group: name, value: child,
      label: identity(child) ?? `Item ${index + 1}`,
      reason: Array.isArray(item?.reasons) ? item.reasons.join('; ') : typeof item?.reason === 'string' ? item.reason : ''
    };
  }) }));
}

/** Occurrence paths describe provisional roles; identity deduplicates the actual Part. */
export function inspectableParts(value: unknown): InspectablePart[] {
  const parts = new Map<string, InspectablePart>();
  const ancestors = new Set<object>();
  function visit(node: unknown, path: string) {
    if (!node || typeof node !== 'object' || ArrayBuffer.isView(node) || ancestors.has(node)) return;
    const object = node as RecordValue;
    if (object.kind === 'cropped-raster') return;
    if (object.kind === 'component' || object.kind === 'mask') {
      const key = String(object.address ?? object.id ?? path);
      const existing = parts.get(key);
      if (existing) { existing.paths.push(path); return; }
      const layer = pixelLayers(node)[0];
      if (layer) parts.set(key, { key, id: String(object.id ?? key), paths: [path], value: object, layer });
      return;
    }
    ancestors.add(node);
    for (const [key, child] of Object.entries(node)) {
      if (key !== 'pixels') visit(child, Array.isArray(node) ? `${path}[${key}]` : path ? `${path}.${key}` : key);
    }
    ancestors.delete(node);
  }
  visit(value, '');
  const palette = ['#ffbf50', '#50d6ff', '#ffffff', '#ff7b98', '#a0e38a', '#c9a1ff'];
  return [...parts.values()].map((part, index) => ({ ...part, layer: {
    ...part.layer, name: part.paths.join(' · '), color: palette[index % palette.length]
  } }));
}

/** Find membership without expanding mask buffers or creating pixel layers. */
export function containsPart(value: unknown, identity: string): boolean {
  const visited = new Set<object>();
  function visit(node: unknown): boolean {
    if (!node || typeof node !== 'object' || ArrayBuffer.isView(node) || visited.has(node)) return false;
    visited.add(node);
    const item = node as RecordValue;
    if (item.kind === 'component' || item.kind === 'mask') return String(item.address ?? item.id) === identity;
    if (item.kind === 'cropped-raster') return false;
    return Object.entries(node).some(([key, child]) => key !== 'pixels' && visit(child));
  }
  return visit(value);
}

/** Show metadata without turning a pixel buffer into thousands of JSON lines. */
export function metadata(value: unknown): string {
  return JSON.stringify(value, (key, child) => {
    if (key === 'pixels') return `[${child?.length ?? 0} pixel entries]`;
    if (ArrayBuffer.isView(child)) return `[${child.constructor.name}]`;
    return child;
  }, 2) ?? String(value);
}
