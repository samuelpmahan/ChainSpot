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
  /** Verdict/receipt lines drawn under the plate. Caller-authored text only. */
  readonly annotations?: readonly string[];
}

export interface RadialRenderResult {
  readonly status: 'skeleton' | 'projected';
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
  const projected = spec.series.some((s) => s.values.length > 0);
  const logs: RadialLog[] = [
    {
      rendererId: spec.id,
      level: 'info',
      message: `${spec.id}: ${projected ? 'projected' : 'skeleton'} render origin=${spec.origin.semantic} axis=${spec.axis.frameId} zeroDeg=${spec.axis.zeroDeg}`
    },
    projected
      ? {
          rendererId: spec.id,
          level: 'info',
          message: `${spec.id}: projected ${spec.series.length} caller-prepared series; renderer performed no normalization or inference`
        }
      : {
          rendererId: spec.id,
          level: 'info',
          message: `${spec.id}: scientific normalization and radial projection intentionally not implemented`
        }
  ];

  const size = 360;
  const c = size / 2;
  const guide = [45, 80, 115];
  const annotations = spec.annotations ?? [];
  const height = size + annotations.length * 15 + (annotations.length ? 10 : 0);
  const circles = guide.map((r) => `<circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="#d8d8d3" stroke-width="1"/>`).join('');
  const axis = `<line x1="${c}" y1="${c + 125}" x2="${c}" y2="${c - 125}" stroke="#333" stroke-width="2"/><path d="M ${c - 6} ${c - 116} L ${c} ${c - 128} L ${c + 6} ${c - 116}" fill="none" stroke="#333" stroke-width="2"/>`;
  const labels = `<text x="${c + 9}" y="${c - 130}" font-size="12" fill="#333">${esc(spec.axis.label)}</text><text x="${c + 9}" y="${c + 18}" font-size="11" fill="#555">${esc(spec.origin.semantic)}</text>`;

  // Series projection: values are caller-normalized to [0,1]; index i covers the
  // full turn clockwise from visual north. NaN/null gaps are honest holes.
  const palette = ['#c23b22', '#2b6cb0', '#2f855a', '#b7791f'];
  let seriesSvg = '';
  spec.series.forEach((s, si) => {
    if (!s.values.length) return;
    const col = palette[si % palette.length];
    const pts: string[] = [];
    s.values.forEach((v, i) => {
      if (Number.isNaN(v)) return;
      const clamped = Math.max(0, Math.min(1, v));
      const th = (i / s.values.length) * 2 * Math.PI - Math.PI / 2;
      const r = guide[0] + clamped * (guide[2] - guide[0]);
      pts.push(`<circle cx="${(c + r * Math.cos(th)).toFixed(1)}" cy="${(c + r * Math.sin(th)).toFixed(1)}" r="2.4" fill="${col}"/>`);
    });
    seriesSvg += pts.join('');
    seriesSvg += `<text x="12" y="${20 + si * 15}" font-size="11" fill="${col}">${esc(s.label)}</text>`;
  });

  const placeholder = projected
    ? `<circle cx="${c}" cy="${c}" r="4" fill="#777"/><text x="${c}" y="${size - 9}" text-anchor="middle" font-size="10" fill="#999">inner guide=0, outer guide=1 (caller-normalized)</text>`
    : `<circle cx="${c}" cy="${c}" r="8" fill="#777"/><text x="${c}" y="${c + 151}" text-anchor="middle" font-size="11" fill="#777">series projection pending</text>`;
  const annoSvg = annotations
    .map((line, i) => `<text x="12" y="${size + 12 + i * 15}" font-size="11" fill="#444" font-family="monospace">${esc(line)}</text>`)
    .join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${height}" role="img" aria-label="${esc(spec.title)}"><rect width="100%" height="100%" fill="#fff"/>${circles}${axis}${labels}${seriesSvg}${placeholder}${annoSvg}</svg>`;

  return { status: projected ? 'projected' : 'skeleton', svg, logs, spec };
}

export interface TrueNorthRadialInput {
  readonly origin: RadialOrigin;
  readonly series?: readonly RadialSeries[];
  readonly annotations?: readonly string[];
}

/** TrueNorth = image-up is the declared zero direction. */
export function renderTrueNorthSkeleton(input: TrueNorthRadialInput): RadialRenderResult {
  return renderRadialSkeleton({
    id: 'radial.trueNorth',
    title: 'True North radial evidence',
    purpose: 'Show directional evidence in the image-global north frame.',
    origin: input.origin,
    axis: { frameId: 'imageNorth', zeroDeg: 0, label: 'N / 0°' },
    series: input.series ?? [],
    annotations: input.annotations
  });
}

export interface AngledInfluenceRadialInput {
  readonly origin: RadialOrigin;
  readonly referenceAngleDeg: number;
  readonly referenceFrameId?: string;
  readonly series?: readonly RadialSeries[];
  readonly annotations?: readonly string[];
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
    annotations: input.annotations,
    note: 'Reference angle must be supplied by an explicit Frame/observation; RadialRender never invents it.'
  });
}
