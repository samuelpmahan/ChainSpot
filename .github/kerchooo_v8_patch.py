from pathlib import Path

path = Path('packages/alg/src/detectors/threeFactor/ribbon.ts')
text = path.read_text()

old_helper = '''function sampleRgbMappedInto(\n\timage: Float32Array,\n\twidth: number,\n\txMap: AxisSampleMap,\n\tyMap: AxisSampleMap,\n\tx: number,\n\ty: number,\n\tout: Float64Array,\n\toffset: number\n): void {\n\tconst ax = xMap.fraction[x];\n\tconst ay = yMap.fraction[y];\n\tconst p00 = (yMap.lo[y] * width + xMap.lo[x]) * 3;\n\tconst p10 = (yMap.lo[y] * width + xMap.hi[x]) * 3;\n\tconst p01 = (yMap.hi[y] * width + xMap.lo[x]) * 3;\n\tconst p11 = (yMap.hi[y] * width + xMap.hi[x]) * 3;\n\tfor (let channel = 0; channel < 3; channel++) {\n\t\tout[offset + channel] = image[p00 + channel] * (1 - ax) * (1 - ay) + image[p10 + channel] * ax * (1 - ay) + image[p01 + channel] * (1 - ax) * ay + image[p11 + channel] * ax * ay;\n\t}\n}\n'''
new_helper = '''function sampleRgbDifferenceMappedInto(\n\timage: Float32Array,\n\twidth: number,\n\txMapA: AxisSampleMap,\n\tyMapA: AxisSampleMap,\n\txMapB: AxisSampleMap,\n\tyMapB: AxisSampleMap,\n\tx: number,\n\ty: number,\n\tout: Float64Array,\n\toffset: number\n): void {\n\tconst axA = xMapA.fraction[x];\n\tconst ayA = yMapA.fraction[y];\n\tconst p00A = (yMapA.lo[y] * width + xMapA.lo[x]) * 3;\n\tconst p10A = (yMapA.lo[y] * width + xMapA.hi[x]) * 3;\n\tconst p01A = (yMapA.hi[y] * width + xMapA.lo[x]) * 3;\n\tconst p11A = (yMapA.hi[y] * width + xMapA.hi[x]) * 3;\n\tconst axB = xMapB.fraction[x];\n\tconst ayB = yMapB.fraction[y];\n\tconst p00B = (yMapB.lo[y] * width + xMapB.lo[x]) * 3;\n\tconst p10B = (yMapB.lo[y] * width + xMapB.hi[x]) * 3;\n\tconst p01B = (yMapB.hi[y] * width + xMapB.lo[x]) * 3;\n\tconst p11B = (yMapB.hi[y] * width + xMapB.hi[x]) * 3;\n\tfor (let channel = 0; channel < 3; channel++) {\n\t\tconst a = image[p00A + channel] * (1 - axA) * (1 - ayA) + image[p10A + channel] * axA * (1 - ayA) + image[p01A + channel] * (1 - axA) * ayA + image[p11A + channel] * axA * ayA;\n\t\tconst b = image[p00B + channel] * (1 - axB) * (1 - ayB) + image[p10B + channel] * axB * (1 - ayB) + image[p01B + channel] * (1 - axB) * ayB + image[p11B + channel] * axB * ayB;\n\t\tout[offset + channel] = a - b;\n\t}\n}\n'''
if text.count(old_helper) != 1:
    raise SystemExit(f'helper block count={text.count(old_helper)}')
text = text.replace(old_helper, new_helper, 1)

old_hot = '''\tconst samples = new Float64Array(12);\n'''
new_hot = '''\tconst gradients = new Float64Array(6);\n'''
if text.count(old_hot) != 1:
    raise SystemExit(f'samples declaration count={text.count(old_hot)}')
text = text.replace(old_hot, new_hot, 1)

old_calls = '''\t\t\t\t\tsampleRgbMappedInto(blurred, width, xA, yA, x, y, samples, 0);\n\t\t\t\t\tsampleRgbMappedInto(blurred, width, xB, yB, x, y, samples, 3);\n\t\t\t\t\tsampleRgbMappedInto(blurred, width, xC, yC, x, y, samples, 6);\n\t\t\t\t\tsampleRgbMappedInto(blurred, width, xD, yD, x, y, samples, 9);\n\t\t\t\t\tconst d1r = samples[0] - samples[3];\n\t\t\t\t\tconst d1g = samples[1] - samples[4];\n\t\t\t\t\tconst d1b = samples[2] - samples[5];\n\t\t\t\t\tconst d2r = samples[6] - samples[9];\n\t\t\t\t\tconst d2g = samples[7] - samples[10];\n\t\t\t\t\tconst d2b = samples[8] - samples[11];\n'''
new_calls = '''\t\t\t\t\tsampleRgbDifferenceMappedInto(blurred, width, xA, yA, xB, yB, x, y, gradients, 0);\n\t\t\t\t\tsampleRgbDifferenceMappedInto(blurred, width, xC, yC, xD, yD, x, y, gradients, 3);\n\t\t\t\t\tconst d1r = gradients[0];\n\t\t\t\t\tconst d1g = gradients[1];\n\t\t\t\t\tconst d1b = gradients[2];\n\t\t\t\t\tconst d2r = gradients[3];\n\t\t\t\t\tconst d2g = gradients[4];\n\t\t\t\t\tconst d2b = gradients[5];\n'''
if text.count(old_calls) != 1:
    raise SystemExit(f'hot call block count={text.count(old_calls)}')
path.write_text(text.replace(old_calls, new_calls, 1))
