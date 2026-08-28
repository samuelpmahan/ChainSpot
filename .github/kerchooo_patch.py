from pathlib import Path
import re


def sub_once(path: str, pattern: str, replacement: str, flags=0):
    p = Path(path)
    text = p.read_text()
    new, count = re.subn(pattern, replacement, text, count=1, flags=flags)
    if count != 1:
        raise SystemExit(f"{path}: expected one replacement, got {count}")
    p.write_text(new)


g3 = "packages/alg/src/detectors/threeFactor/features/g3.teeRecovery.ts"
ribbon = "packages/alg/src/detectors/threeFactor/ribbon.ts"

# Recovery: same all-pixels predicate/residual, but calculate pose trig and
# local coordinates once per fitted pose instead of twice for every pixel.
sub_once(
    g3,
    r"\tconst consider = \(centerX: number, centerY: number, axisOffset: number\) => \{.*?\n\t\};\n\tconst scan =",
    """\tconst consider = (centerX: number, centerY: number, axisOffset: number) => {
\t\tconst badgeRay = Math.atan2(badgeY - centerY, badgeX - centerX);
\t\tconst angleRad = badgeRay + axisOffset;
\t\tconst fit: RecoveryFit = {
\t\t\tcenterXPx: centerX,
\t\t\tcenterYPx: centerY,
\t\t\thalfWidthPx: halfWidth,
\t\t\thalfHeightPx: halfHeight,
\t\t\tangleRad,
\t\t\tsupportThicknessPx: thickness
\t\t};
\t\tconst c = Math.cos(angleRad);
\t\tconst s = Math.sin(angleRad);
\t\tconst outerHalfWidth = halfWidth + RASTER_TOLERANCE_PX;
\t\tconst outerHalfHeight = halfHeight + RASTER_TOLERANCE_PX;
\t\tconst effectiveThickness = Math.max(0, thickness);
\t\tconst innerEdgeU = halfWidth - effectiveThickness - RASTER_TOLERANCE_PX;
\t\tconst innerEdgeV = halfHeight - effectiveThickness - RASTER_TOLERANCE_PX;
\t\tlet unexplained = 0;
\t\tlet residual = 0;
\t\tfor (const point of pixels) {
\t\t\tconst dx = point[0] - centerX;
\t\t\tconst dy = point[1] - centerY;
\t\t\tconst u = dx * c + dy * s;
\t\t\tconst v = -dx * s + dy * c;
\t\t\tconst absU = Math.abs(u);
\t\t\tconst absV = Math.abs(v);
\t\t\tconst explained =
\t\t\t\tabsU <= outerHalfWidth &&
\t\t\t\tabsV <= outerHalfHeight &&
\t\t\t\t(absU >= innerEdgeU || absV >= innerEdgeV);
\t\t\tif (!explained) unexplained++;
\t\t\tconst outer = Math.hypot(
\t\t\t\tMath.max(0, absU - halfWidth),
\t\t\t\tMath.max(0, absV - halfHeight)
\t\t\t);
\t\t\tconst edgeDistance = Math.min(
\t\t\t\tMath.abs(absU - halfWidth),
\t\t\t\tMath.abs(absV - halfHeight)
\t\t\t);
\t\t\tresidual += outer * 4 + edgeDistance;
\t\t\tif (unexplained > bestUnexplained) break;
\t\t}
\t\tconst absOffset = Math.abs(axisOffset);
\t\tif (
\t\t\tunexplained < bestUnexplained ||
\t\t\t(unexplained === bestUnexplained && residual < bestResidual) ||
\t\t\t(unexplained === bestUnexplained && residual === bestResidual && absOffset < bestAxisOffset)
\t\t) {
\t\t\tbest = fit;
\t\t\tbestUnexplained = unexplained;
\t\t\tbestResidual = residual;
\t\t\tbestAxisOffset = absOffset;
\t\t}
\t};
\tconst scan =""",
    re.S,
)

# Recovery: the 0.5-degree offset lattice is target/run invariant. Build it
# once rather than once for every candidate center.
sub_once(
    g3,
    r"\tconst scan = \(\n\t\tx0: number,\n\t\tx1: number,\n\t\ty0: number,\n\t\ty1: number,\n\t\tcenterStep: number,\n\t\tangleStepDeg: number\n\t\) => \{.*?\n\tscan\(minCenterX, maxCenterX, minCenterY, maxCenterY, 0\.5, 0\.5\);",
    """\tconst scanRangeDeg = Math.max(0.5, activeAxisLimitDeg - 0.5);
\tconst axisOffsets: number[] = [];
\tfor (let degrees = -scanRangeDeg; degrees <= scanRangeDeg + 1e-9; degrees += 0.5) {
\t\taxisOffsets.push(degrees * Math.PI / 180);
\t}
\tconst scan = (
\t\tx0: number,
\t\tx1: number,
\t\ty0: number,
\t\ty1: number,
\t\tcenterStep: number
\t) => {
\t\tfor (let y = y0; y <= y1 + 1e-9; y += centerStep) {
\t\t\tfor (let x = x0; x <= x1 + 1e-9; x += centerStep) {
\t\t\t\tfor (const axisOffset of axisOffsets) consider(x, y, axisOffset);
\t\t\t}
\t\t}
\t};
\t// The intersection above is already tiny: a complete H3/H5-sized component
\t// leaves only a handful of possible centers. Search it on the native
\t// half-pixel centroid lattice so a coarse local optimum cannot hide a valid
\t// all-pixels explanation.
\tscan(minCenterX, maxCenterX, minCenterY, maxCenterY, 0.5);""",
    re.S,
)

# Global discovery stays global. These are exact bounds of surviving pixels,
# used only as a mathematically necessary broad phase for the existing
# every-pixel support predicate.
sub_once(
    g3,
    r"\t\treturn pixels\.length \? \[\{ component, pixels \}\] : \[\];",
    """\t\tif (pixels.length === 0) return [];
\t\tlet minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
\t\tfor (const [x, y] of pixels) {
\t\t\tif (x < minX) minX = x;
\t\t\tif (x > maxX) maxX = x;
\t\t\tif (y < minY) minY = y;
\t\t\tif (y > maxY) maxY = y;
\t\t}
\t\treturn [{ component, pixels, minX, maxX, minY, maxY }];""",
)

sub_once(
    g3,
    r"\t\t\tconst compatibleWith = \(candidateFit: RecoveryFit\) => visibleComponents\.filter\(\(entry\) =>\n\t\t\t\tentry\.component\.label === seed\.component\.label \|\|\n\t\t\t\tentry\.pixels\.every\(\(point\) => pointExplainsTee\(point, candidateFit\)\)\n\t\t\t\);",
    """\t\t\tconst compatibleWith = (candidateFit: RecoveryFit) => {
\t\t\t\tconst c = Math.cos(candidateFit.angleRad);
\t\t\t\tconst s = Math.sin(candidateFit.angleRad);
\t\t\t\tconst hw = candidateFit.halfWidthPx + RASTER_TOLERANCE_PX;
\t\t\t\tconst hh = candidateFit.halfHeightPx + RASTER_TOLERANCE_PX;
\t\t\t\tconst extentX = Math.abs(c) * hw + Math.abs(s) * hh;
\t\t\t\tconst extentY = Math.abs(s) * hw + Math.abs(c) * hh;
\t\t\t\tconst minX = candidateFit.centerXPx - extentX;
\t\t\t\tconst maxX = candidateFit.centerXPx + extentX;
\t\t\t\tconst minY = candidateFit.centerYPx - extentY;
\t\t\t\tconst maxY = candidateFit.centerYPx + extentY;
\t\t\t\tconst epsilon = 1e-9;
\t\t\t\treturn visibleComponents.filter((entry) =>
\t\t\t\t\tentry.component.label === seed.component.label ||
\t\t\t\t\t(
\t\t\t\t\t\tentry.minX >= minX - epsilon &&
\t\t\t\t\t\tentry.maxX <= maxX + epsilon &&
\t\t\t\t\t\tentry.minY >= minY - epsilon &&
\t\t\t\t\t\tentry.maxY <= maxY + epsilon &&
\t\t\t\t\t\tentry.pixels.every((point) => pointExplainsTee(point, candidateFit))
\t\t\t\t\t)
\t\t\t\t);
\t\t\t};""",
)

# SupportField: one bilinear coordinate calculation yields all three channels;
# channel arithmetic stays in the original operation order.
sub_once(
    ribbon,
    r"function sampleRgb\(image: Float32Array, width: number, height: number, x: number, y: number, channel: number\): number \{.*?\n\}\n\nfunction percentile",
    """function sampleRgbInto(
\timage: Float32Array,
\twidth: number,
\theight: number,
\tx: number,
\ty: number,
\tout: Float64Array,
\toffset: number
): void {
\tconst x0 = Math.floor(x);
\tconst y0 = Math.floor(y);
\tconst ax = x - x0;
\tconst ay = y - y0;
\tconst rx0 = reflect(x0, width);
\tconst rx1 = reflect(x0 + 1, width);
\tconst ry0 = reflect(y0, height);
\tconst ry1 = reflect(y0 + 1, height);
\tconst p00 = (ry0 * width + rx0) * 3;
\tconst p10 = (ry0 * width + rx1) * 3;
\tconst p01 = (ry1 * width + rx0) * 3;
\tconst p11 = (ry1 * width + rx1) * 3;
\tfor (let channel = 0; channel < 3; channel++) {
\t\tout[offset + channel] =
\t\t\timage[p00 + channel] * (1 - ax) * (1 - ay) +
\t\t\timage[p10 + channel] * ax * (1 - ay) +
\t\t\timage[p01 + channel] * (1 - ax) * ay +
\t\t\timage[p11 + channel] * ax * ay;
\t}
}

function percentile""",
    re.S,
)

# SupportField: remove per-cell closure/array allocation and precompute the four
# sample offsets per orientation/width. Same cells, orientations, widths,
# bilinear samples, vector math, max rule, and normalization.
sub_once(
    ribbon,
    r"\tfor \(let orientation = 0; orientation < parameters\.orientations; orientation\+\+\) \{.*?\n\t\}\n\tconst norm =",
    """\tconst samples = new Float64Array(12);
\tfor (let orientation = 0; orientation < parameters.orientations; orientation++) {
\t\tconst theta = (Math.PI * orientation) / parameters.orientations;
\t\tconst nx = -Math.sin(theta);
\t\tconst ny = Math.cos(theta);
\t\tfor (const widthSrc of parameters.widthsSrc) {
\t\t\tconst radius = widthSrc / (2 * scale);
\t\t\tconst distance0 = -(radius - delta);
\t\t\tconst distance1 = -(radius + delta);
\t\t\tconst distance2 = radius - delta;
\t\t\tconst distance3 = radius + delta;
\t\t\tconst ox0 = nx * distance0, oy0 = ny * distance0;
\t\t\tconst ox1 = nx * distance1, oy1 = ny * distance1;
\t\t\tconst ox2 = nx * distance2, oy2 = ny * distance2;
\t\t\tconst ox3 = nx * distance3, oy3 = ny * distance3;
\t\t\tfor (let y = 0; y < height; y++) {
\t\t\t\tfor (let x = 0; x < width; x++) {
\t\t\t\t\tsampleRgbInto(blurred, width, height, x + ox0, y + oy0, samples, 0);
\t\t\t\t\tsampleRgbInto(blurred, width, height, x + ox1, y + oy1, samples, 3);
\t\t\t\t\tsampleRgbInto(blurred, width, height, x + ox2, y + oy2, samples, 6);
\t\t\t\t\tsampleRgbInto(blurred, width, height, x + ox3, y + oy3, samples, 9);
\t\t\t\t\tconst d1r = samples[0] - samples[3];
\t\t\t\t\tconst d1g = samples[1] - samples[4];
\t\t\t\t\tconst d1b = samples[2] - samples[5];
\t\t\t\t\tconst d2r = samples[6] - samples[9];
\t\t\t\t\tconst d2g = samples[7] - samples[10];
\t\t\t\t\tconst d2b = samples[8] - samples[11];
\t\t\t\t\tconst n1 = Math.hypot(d1r, d1g, d1b);
\t\t\t\t\tconst n2 = Math.hypot(d2r, d2g, d2b);
\t\t\t\t\tconst dot = d1r * d2r + d1g * d2g + d1b * d2b;
\t\t\t\t\tif (dot <= 0) continue;
\t\t\t\t\tconst score = Math.min(n1, n2) * Math.min(1, dot / (n1 * n2 + 1e-6));
\t\t\t\t\tconst cell = y * width + x;
\t\t\t\t\tif (score > raw[cell]) {
\t\t\t\t\t\traw[cell] = score;
\t\t\t\t\t\tbestTheta[cell] = theta;
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t\t}
\t}
\tconst norm =""",
    re.S,
)
