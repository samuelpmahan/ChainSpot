import assert from 'node:assert/strict';
import test from 'node:test';
import { formatS0ForkReceipt, s0ForkReceipt } from '../../scripts/pxcube-s0-receipt.mjs';

test('comparison receipt makes authority, boundary, intent and difference explicit', () => {
  const run = {
    tick: 'source.cropUDiscChrome',
    authoritative: { lineage: 'clean', elapsedMs: 1 },
    observations: [{
      lineage: 'exp/A', boundary: 'STOP', elapsedMs: 2,
      comparison: { samePixels: false, widthDeltaPx: 0, heightDeltaPx: -10, cleanInsets: null, candidateInsets: { top: 10, right: 0, bottom: 0, left: 0 } }
    }]
  };
  const receipt = s0ForkReceipt(run);
  assert.equal(receipt.authority, 'clean');
  assert.equal(receipt.boundary, 'STOP');
  const text = formatS0ForkReceipt(receipt);
  assert.match(text, /authority: clean/);
  assert.match(text, /candidate: exp\/A · STOP/);
  assert.match(text, /pixels: DIFFERENT/);
  assert.match(text, /Δw=0px Δh=-10px/);
});
