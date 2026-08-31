export type RadialLogLevel = 'info' | 'warn';

export interface RadialLog {
  readonly rendererId: string;
  readonly level: RadialLogLevel;
  readonly message: string;
}

export interface RadialOrigin {
  readonly x: number;
  readonly y: number;
  readonly semantic: string;
}

export interface RadialAxis {
  /** Human-readable axis identity, e.g. imageNorth or incomingEvidence. */
  readonly frameId: string;
  /** Angle in degrees that should appear at visual 0° / north. */
  readonly zeroDeg: number;
  readonly label: string;
}

export interface RadialSeries {
  readonly id: string;
  readonly label: string;
  readonly values: readonly (number | null)[];
  readonly color?: string;
  readonly opacity?: number;
  readonly strokeWidth?: number;
  readonly dash?: string;
  readonly showInLegend?: boolean;
}

export interface RadialRenderSpec {
  readonly id: string;
  readonly title: string;
  readonly purpose: string;
  readonly origin: RadialOrigin;
  readonly axis: RadialAxis;
  readonly series: readonly RadialSeries[];
  readonly valueDomain?: readonly [number, number];
  readonly note?: string;
}

export interface RadialRenderResult {
  readonly status: 'skeleton' | 'rendered';
  readonly svg: string;
  readonly logs: readonly RadialLog[];
  readonly spec: RadialRenderSpec;
}

function esc(value: string): string {
  return value.replace(/[&<>\"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch] ?? ch);
}

/**
 * Shared RadialRender skeleton.
 *
 * It intentionally does NOT normalize, rotate, infer directions, calculate PCA,
 * or choose colors from evidence. Callers must hand it an explicit semantic
 * origin, axis Frame, and already-prepared radial series.
 */
function finiteDomain(series: readonly RadialSeries[]): [number, number] {
  const values = series.flatMap((entry) => entry.values.filter((value): value is number => value !== null && Number.isFinite(value)));
  if (!values.length) return [0, 1];
  const min = Math.min(...values);
  const max = Math.max(...values);
  return min === max ? [Math.min(0, min), max === 0 ? 1 : max] : [min, max];
}

function radialPath(values: readonly (number | null)[], cx: number, cy: number, minRadius: number, maxRadius: number, domain: readonly [number, number]): string {
  let path = '';
  let open = false;
  for (let index = 0; index <= values.length; index++) {
    const value = values[index % values.length];
    if (value === null || !Number.isFinite(value)) {
      open = false;
      continue;
    }
    const unit = domain[1] === domain[0] ? 0.5 : Math.max(0, Math.min(1, (value - domain[0]) / (domain[1] - domain[0])));
    const radius = minRadius + unit * (maxRadius - minRadius);
    const angle = ((index % values.length) / values.length) * Math.PI * 2 - Math.PI / 2;
    const x = cx + Math.cos(angle) * radius;
    const y = cy + Math.sin(angle) * radius;
    path += `${open ? ' L' : ' M'} ${x.toFixed(2)} ${y.toFixed(2)}`;
    open = true;
  }
  return path;
}

export function renderRadial(spec: RadialRenderSpec): RadialRenderResult {
  const logs: RadialLog[] = [
    {
      rendererId: spec.id,
      level: 'info',
      message: `${spec.id}: radial render origin=${spec.origin.semantic} axis=${spec.axis.frameId} zeroDeg=${spec.axis.zeroDeg}`
    },
    {
      rendererId: spec.id,
      level: 'info',
      message: `${spec.id}: ${spec.series.length} caller-supplied radial series; renderer inferred no evidence or reference direction`
    }
  ];

  const size = 360;
  const c = size / 2;
  const guide = [45, 80, 115];
  const circles = guide.map((r) => `<circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="#d8d8d3" stroke-width="1"/>`).join('');
  const axis = `<line x1="${c}" y1="${c + 125}" x2="${c}" y2="${c - 125}" stroke="#333" stroke-width="2"/><path d="M ${c - 6} ${c - 116} L ${c} ${c - 128} L ${c + 6} ${c - 116}" fill="none" stroke="#333" stroke-width="2"/>`;
  const labels = `<text x="${c + 9}" y="${c - 108}" font-size="11" fill="#333">${esc(spec.axis.label)}</text><text x="${c + 9}" y="${c + 18}" font-size="10" fill="#555">pole tip</text>`;
  const domain = spec.valueDomain ?? finiteDomain(spec.series);
  const paths = spec.series.map((series, index) => `<path d="${radialPath(series.values, c, c, 24, 122, domain)}" fill="none" stroke="${esc(series.color ?? ['#3f8cff', '#ff5a67', '#35d0ba'][index % 3])}" stroke-width="${series.strokeWidth ?? 1.5}" opacity="${series.opacity ?? 0.9}"${series.dash ? ` stroke-dasharray="${esc(series.dash)}"` : ''}><title>${esc(series.label)}</title></path>`).join('');
  const legendSeries = spec.series.filter((series) => series.showInLegend !== false).slice(-4);
  const legend = legendSeries.map((series, index) => `<g transform="translate(${18 + (index % 2) * 170},${40 + Math.floor(index / 2) * 15})"><line x1="0" y1="0" x2="18" y2="0" stroke="${esc(series.color ?? '#3f8cff')}" stroke-width="${series.strokeWidth ?? 2}"/><text x="24" y="4" font-size="9" fill="#4b5563">${esc(series.label.slice(0, 23))}</text></g>`).join('');
  const domainLabel = `<text x="${c}" y="${c + 151}" text-anchor="middle" font-size="10" fill="#777">domain ${domain[0].toFixed(2)} .. ${domain[1].toFixed(2)}</text>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" role="img" aria-label="${esc(spec.title)}"><rect width="100%" height="100%" rx="12" fill="#fff"/><text x="${c}" y="24" text-anchor="middle" font-family="sans-serif" font-size="15" font-weight="700" fill="#111827">${esc(spec.title)}</text>${circles}${axis}${labels}${paths || `<circle cx="${c}" cy="${c}" r="8" fill="#777"/>`}${legend}${domainLabel}</svg>`;

  return { status: spec.series.length ? 'rendered' : 'skeleton', svg, logs, spec };
}

/** Backward-compatible name retained while the first real experiment earns the renderer. */
export const renderRadialSkeleton = renderRadial;

export function rotateRadialValues(values: readonly (number | null)[], zeroBearingDeg: number): (number | null)[] {
  const stepDeg = 360 / values.length;
  return values.map((_, outputIndex) => {
    const source = (((outputIndex * stepDeg + zeroBearingDeg) % 360) + 360) % 360 / stepDeg;
    const leftIndex = Math.floor(source) % values.length;
    const rightIndex = (leftIndex + 1) % values.length;
    const left = values[leftIndex];
    const right = values[rightIndex];
    const fraction = source - Math.floor(source);
    if (fraction < 1e-12) return left;
    if (left === null || right === null) return null;
    return left * (1 - fraction) + right * fraction;
  });
}

export interface TrueNorthRadialInput {
  readonly origin: RadialOrigin;
  /** Series must already be rotated so its known truth direction is bin zero. */
  readonly series?: readonly RadialSeries[];
  readonly title?: string;
  readonly purpose?: string;
  readonly valueDomain?: readonly [number, number];
}

/** TrueNorth = each observation's known truth vector is rotated to visual north. */
export function renderTrueNorthSkeleton(input: TrueNorthRadialInput): RadialRenderResult {
  return renderRadial({
    id: 'radial.trueNorth',
    title: input.title ?? 'True North radial evidence',
    purpose: input.purpose ?? 'Show directional evidence after rotating each known truth vector to visual north.',
    origin: input.origin,
    axis: { frameId: 'trueNorth', zeroDeg: 0, label: 'TRUTH / 0°' },
    series: input.series ?? [],
    valueDomain: input.valueDomain,
    note: 'Caller supplies the truth bearing and performs the rotation; RadialRender never invents truth.'
  });
}

export interface AngledInfluenceRadialInput {
  readonly origin: RadialOrigin;
  readonly referenceAngleDeg: number;
  readonly referenceFrameId?: string;
  readonly series?: readonly RadialSeries[];
}

/**
 * AngledInfluence = preserve an explicit truth-blind reference angle and make
 * that direction visual zero. Actual rotation/projection remains unimplemented.
 */
export function renderAngledInfluenceSkeleton(input: AngledInfluenceRadialInput): RadialRenderResult {
  return renderRadial({
    id: 'radial.angledInfluence',
    title: 'Angled influence radial evidence',
    purpose: 'Show influence relative to an explicit observed/reference direction.',
    origin: input.origin,
    axis: {
      frameId: input.referenceFrameId ?? 'incomingEvidence',
      zeroDeg: input.referenceAngleDeg,
      label: `reference 0° (source ${input.referenceAngleDeg.toFixed(1)}°)`
    },
    series: input.series ?? [],
    note: 'Reference angle must be supplied by an explicit Frame/observation; RadialRender never invents it.'
  });
}
