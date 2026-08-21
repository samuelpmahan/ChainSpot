# LAB quick endpoint detector

This directory is the browser-portable quick endpoint slice copied from
`/home/mahansa/workspace/ChainSpot-lab-bootstrap` at commit
`b02c69f020a18d4e7b81fb660c5824880282199b`.

Included stages:

- shared bright/dark mask;
- connected-component measurements;
- repeated badge-family localization;
- badge digit segmentation and logistic inference;
- fixed bright-mask basket sprite matching;
- hollow-ring and component-fallback tee extraction;
- residual screen-chrome attribution.

Deliberate differences from that snapshot:

- the P1 badge constants live beside `badgeStage.ts`, avoiding the unused
  projected-border tee scorer;
- training code was removed from the logistic module; only inference ships;
- every qualifying hollow marker is a tee. The LAB snapshot's alternate
  hollow-marker category was a mistaken interpretation and is not represented;
- `index.ts` adapts the stages to `src/lib/detect.ts`. It emits object and
  badge-label events; ownership association remains a later Detector pass.

The JSON files in `assets/` are immutable copies of the LAB basket template
and trained digit model from the same snapshot.
