#!/usr/bin/env python3
"""Recreate byte inputs from the committed, hash-checked original source."""
from pathlib import Path
from PIL import Image
import hashlib,json,shutil,tarfile
root=Path(__file__).resolve().parent
work=root/'restored/edge-diagnostic/edge-readings-work'
source=root/'restored/edge-diagnostic/edge-reading-inspection/DashsTrack-full.jpg'
metadata=json.loads((work/'inputs.json').read_text())
assert hashlib.sha256(source.read_bytes()).hexdigest()==metadata['sourceSha256']
image=Image.open(source).convert('RGBA')
assert image.size==(metadata['width'],metadata['height'])
image.save(work/'DashsTrack-source.png')
(work/'source.rgba').write_bytes(image.tobytes())
scan=root/'straight-edge-pattern/data'
shutil.copy2(work/'source.rgba',scan/'source.rgba')
shutil.copy2(source,scan/'source.jpg')
for folder in ['straight-edge-pattern/output','ternary-edge/output/gateway']:
 (root/folder).mkdir(parents=True,exist_ok=True)
print('Source SHA verified; inputs recreated.')

with tarfile.open(root/'ternary-edge/runtime.tar.gz') as archive:
 archive.extractall(root/'ternary-edge', filter='data')
print('Archived gateway runtime restored.')
