from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "packages" / "quick_anno_py"))

from chainspot_quick_anno import Pcr


pcr = Pcr("S1")
canonical = pcr.part("px.course.canonicalPixels")
model = pcr.part("px.s1.whiteDigits.model")

raster = pcr.calc("RasterInput", "fn.s0.asMaskRaster", id="raster", image=canonical, into="px.s1.exp.maskComponents.part.croppedRaster")
black_mask = pcr.calc("BlackMask", "fn.s1.exp.maskComponents.selectHsvMask", id="blackMask", args={"polarity":"black","valueMax":45,"alpha":"ignored"}, raster=raster, into="px.s1.exp.maskComponents.part.blackMask")
black_components = pcr.calc("BlackMask", "fn.s1.exp.maskComponents.group8Connected", id="blackComponents", args={"connectivity":8,"retainSingletons":True}, mask=black_mask, into="px.s1.exp.maskComponents.part.blackComponents")
white_mask = pcr.calc("WhiteMask", "fn.s1.exp.maskComponents.selectHsvMask", id="whiteMask", args={"polarity":"white","valueMin":210,"saturationMax":45,"alpha":"ignored"}, raster=raster, into="px.s1.exp.maskComponents.part.whiteMask")
white_components = pcr.calc("WhiteMask", "fn.s1.exp.maskComponents.group8Connected", id="whiteComponents", args={"connectivity":8,"retainSingletons":True}, mask=white_mask, into="px.s1.exp.maskComponents.part.whiteComponents")
plates = pcr.calc("BadgeAssembly", "fn.s1.exp.badgeAssembly.selectComponents", id="plates", args={"predicate":"plate-bbox-and-fill","minWidth":34,"maxWidth":78,"minHeight":24,"maxHeight":54,"minAspect":1,"maxAspect":2.4,"minFill":0.55}, components=black_components, into="px.s1.exp.badgeAssembly.plates")
borders = pcr.calc("BadgeAssembly", "fn.s1.exp.badgeAssembly.findRelated", id="borders", args={"anchorRole":"plate","predicate":"candidate-bbox-contains-anchor"}, anchors=plates, candidates=white_components, into="px.s1.exp.badgeAssembly.plateBorders")
digits = pcr.calc("BadgeAssembly", "fn.s1.exp.badgeAssembly.findRelated", id="digits", args={"anchorRole":"plate","predicate":"anchor-bbox-contains-candidate"}, anchors=plates, candidates=white_components, into="px.s1.exp.badgeAssembly.plateDigits")
loops = pcr.calc("BadgeAssembly", "fn.s1.exp.badgeAssembly.findRelated", id="loops", args={"anchorRole":"related-component","predicate":"anchor-bbox-contains-candidate"}, anchors=digits, candidates=black_components, into="px.s1.exp.badgeAssembly.digitLoops")
assembly = pcr.calc("BadgeAssembly", "fn.s1.exp.badgeAssembly.assemble", id="assembly", args={"acceptance":"border-and-digit-material"}, plates=plates, plateBorders=borders, plateDigits=digits, digitLoops=loops, into="px.s1.exp.badgeAssembly.badgeCandidates")
prepared = pcr.calc("WhiteDigitRecognition", "fn.s1.whiteDigits.prepare", id="prepareDigits", args={"knobs":{"minComponentArea":6,"heightRatioMin":0.5,"wideRatio":0.95,"valleySearchLo":0.3,"valleySearchHi":0.7,"digitW":24,"digitH":32,"confidenceFloorDivisor":8,"labelAmbiguityMargin":0.045}}, badges=assembly, into="px.s1.whiteDigits.prepared")
recognized = pcr.calc("WhiteDigitRecognition", "fn.s1.whiteDigits.match", id="recognizeDigits", prepared=prepared, model=model, into="px.s1.whiteDigits.recognizedBadges")
badges = pcr.calc("BadgeOutputs", "fn.s1.badges.declareOwnership", id="ownership", recognized=recognized, into="px.badges.objects")
owned = pcr.calc("BadgeOutputs", "fn.s1.badges.ownedPixels", id="owned", badges=badges, raster=canonical, into="px.badges.px")
muted = pcr.calc("BadgeOutputs", "fn.s1.badges.mutedPixels", id="muted", badges=badges, owned=owned, raster=canonical, into="px.badges.muted")
pcr.calc("BadgeOutputs", "fn.s1.badges.remainingPixels", id="remaining", owned=owned, muted=muted, raster=canonical, into="px.remaining.afterBadges")

OUT = Path(__file__).with_name("generated")
OUT.mkdir(exist_ok=True)
(OUT / "S1.pcr.json").write_text(pcr.to_pcr_json())
(OUT / "S1.mmd").write_text(pcr.to_mermaid())

print(f"wrote {OUT / 'S1.pcr.json'}")
print(f"wrote {OUT / 'S1.mmd'}")
