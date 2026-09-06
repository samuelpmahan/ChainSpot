import json
from PIL import Image
from render import render

def test_views(tmp_path):
 src=tmp_path/"s.jpg"; Image.new("RGB",(300,220),(30,40,50)).save(src)
 tr=tmp_path/"t.json"; tr.write_text(json.dumps({"winner":{"candidateId":"w","centerline":[[20,20],[120,80],[200,160]],"leftEdge":[[20,30],[120,90],[200,170]],"rightEdge":[[20,10],[120,70],[200,150]],"bends":[[120,80]]},"rows":[{"id":"bad","state":"fail","center":[180,120]}]}))
 out=tmp_path/"o"; m=render(tr,src,out)
 assert all((out/x).exists() for x in ["early-h18-source.jpg","all18-graph.jpg","focused-failures.jpg"])
 assert m["annotationReads"]==0 and m["failureCount"]==1
