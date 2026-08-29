from pathlib import Path

path = Path('packages/alg/src/detectors/threeFactor/features/g3.teeRecovery.ts')
text = path.read_text()
old = '''\tconst badgeX = target.cxPx;\n\tconst badgeY = target.cyPx - viewportTopPx;\n'''
new = '''\tconst profileCols = minCenterX > maxCenterX ? 0 : Math.floor((maxCenterX - minCenterX + 1e-9) / 0.5) + 1;\n\tconst profileRows = minCenterY > maxCenterY ? 0 : Math.floor((maxCenterY - minCenterY + 1e-9) / 0.5) + 1;\n\tconst profileRangeDeg = Math.max(0.5, activeAxisLimitDeg - 0.5);\n\tconst profileAngles = Math.floor((profileRangeDeg * 2 + 1e-9) / 0.5) + 1;\n\tconsole.error(`KERCH_FIT pixels=${pixels.length} cols=${profileCols} rows=${profileRows} centers=${profileCols * profileRows} angles=${profileAngles} poses=${profileCols * profileRows * profileAngles} bbox=${component.bboxW}x${component.bboxH}`);\n\tconst badgeX = target.cxPx;\n\tconst badgeY = target.cyPx - viewportTopPx;\n'''
if text.count(old) != 1:
    raise SystemExit(f'expected one insertion site, got {text.count(old)}')
path.write_text(text.replace(old, new, 1))
