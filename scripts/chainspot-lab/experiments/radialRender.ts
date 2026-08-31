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
  /** Skeleton accepts already-normalized radial values; math comes later. */
  readonly values: readonly number[];
}

export interface RadialRenderSpec {
  readonly id: string;
  readonly title: string;
  readonly purpose: string;
  readonly origin: RadialOrigin;
  readonly axis: RadialAxis;
  readonly series: readonly RadialSeries[];
  readonly note?: string;
}

export interface RadialRenderResult {
  readonly status: 'skeleton';
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
export function renderRadialSkeleton(spec: RadialRenderSpec): RadialRenderResult {
  const logs: RadialLog[] = [
    {
      rendererId: spec.id,
      level: 'info',
      message: `${spec.id}: skeleton render origin=${spec.origin.semantic} axis=${spec.axis.frameId} zeroDeg=${spec.axis.zeroDeg}`
    },
    {
      rendererId: spec.id,
      level: 'info',
      message: `${spec.id}: scientific normalization and radial projection intentionally not implemented`
    }
  ];

  const size = 360;
  const c = size / 2;
  const guide = [45, 80, 115];
  const circles = guide.map((r) => `<circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="#d8d8d3" stroke-width="1"/>`).join('');
  const axis = `<line x1="${c}" y1="${c + 125}" x2="${c}" y2="${c - 125}" stroke="#333" stroke-width="2"/><path d="M ${c - 6} ${c - 116} L ${c} ${c - 128} L ${c + 6} ${c - 116}" fill="none" stroke="#333" stroke-width="2"/>`;
  const labels = `<text x="${c + 9}" y="${c - 130}" font-size="12" fill="#333">${esc(spec.axis.label)}</text><text x="${c + 9}" y="${c + 18}" font-size="11" fill="#555">${esc(spec.origin.semantic)}</text>`;
  const placeholder = `<circle cx="${c}" cy="${c}" r="8" fill="#777"/><text x="${c}" y="${c + 151}" text-anchor="middle" font-size="11" fill="#777">series projection pending</text>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" role="img" aria-label="${esc(spec.title)}"><rect width="100%" height="100%" fill="#fff"/>${circles}${axis}${labels}${placeholder}</svg>`;

  return { status: 'skeleton', svg, logs, spec };
}

export interface TrueNorthRadialInput {
  readonly origin: RadialOrigin;
  readonly series?: readonly RadialSeries[];
}

/** TrueNorth = image-up is the declared zero direction. */
export function renderTrueNorthSkeleton(input: TrueNorthRadialInput): RadialRenderResult {
  return renderRadialSkeleton({
    id: 'radial.trueNorth',
    title: 'True North radial evidence',
    purpose: 'Show directional evidence in the image-global north frame.',
    origin: input.origin,
    axis: { frameId: 'imageNorth', zeroDeg: 0, label: 'N / 0°' },
    series: input.series ?? []
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
  return renderRadialSkeleton({
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
