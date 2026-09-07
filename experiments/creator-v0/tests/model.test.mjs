import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createWorkspace,validateWorkspace,addEntry,removeEntry,removeDisc,moveEntry,anotherDisc} from '../../../static/creator-v0/model.js';
import {renderScene,esc,discCard} from '../../../static/creator-v0/render.js';

test('seed is valid and contains two independent Buzzz instances',()=>{
  const w=validateWorkspace(createWorkspace());
  const buzzzes=w.discs.filter(d=>d.facts.mold==='Buzzz');assert.equal(buzzzes.length,2);
  assert.notEqual(buzzzes[0].id,buzzzes[1].id);
  buzzzes[0].facts.flight[0]=9;assert.equal(buzzzes[1].facts.flight[0],5);
});
test('new physical disc reuses facts, not identity or an exact-disc photograph',()=>{
  const a=createWorkspace().discs[0], b=anotherDisc(a);
  assert.notEqual(a.id,b.id);assert.equal(b.photo,null);assert.equal(b.label,'');
  b.facts.mold='different';assert.equal(a.facts.mold,'Buzzz');
});
test('scores are entry-local; the same disc may occur with different scores',()=>{
  const w=createWorkspace();const e=addEntry(w,w.discs[0].id,'same-disc-other-entry');
  e.score='-2.5';w.battle.entries[0].score='8.25';
  assert.equal(e.score,'-2.5');assert.equal(w.battle.entries[0].score,'8.25');
  assert.equal('score' in w.discs[0],false);assert.equal(w.battle.highlightedEntryId,null);
  assert.equal(w.battle.winnerEntryId,null);
});
test('no score change infers a winner; winner/highlight may be different or absent',()=>{
  const w=createWorkspace();w.battle.highlightedEntryId='entry-0';w.battle.winnerEntryId='entry-1';
  w.battle.entries[2].score='100000';const valid=validateWorkspace(w);
  assert.equal(valid.battle.highlightedEntryId,'entry-0');assert.equal(valid.battle.winnerEntryId,'entry-1');
});
test('reordering preserves entry IDs, scores, and selected emphasis',()=>{
  const w=createWorkspace();w.battle.entries[0].score='8.1';w.battle.highlightedEntryId='entry-0';
  moveEntry(w,'entry-0',1);assert.equal(w.battle.entries[1].id,'entry-0');
  assert.equal(w.battle.entries[1].score,'8.1');assert.equal(w.battle.highlightedEntryId,'entry-0');
  moveEntry(w,'entry-1',-1);assert.equal(w.battle.entries[0].id,'entry-1');
});
test('removing a referenced disc cleans up only its entries and emphasis',()=>{
  const w=createWorkspace();w.battle.highlightedEntryId='entry-0';w.battle.winnerEntryId='entry-1';w.battle.entries[1].score='9';
  removeDisc(w,w.discs[0].id);assert.equal(w.battle.entries.length,2);
  assert.equal(w.battle.highlightedEntryId,null);assert.equal(w.battle.winnerEntryId,'entry-1');
  assert.equal(w.battle.entries[0].score,'9');assert.ok(validateWorkspace(w));
});
test('entry removal leaves collection and other score values intact',()=>{
  const w=createWorkspace();removeEntry(w,'entry-1');assert.equal(w.discs.length,5);
  assert.equal(w.battle.entries.length,2);assert.ok(validateWorkspace(w));
});
test('empty shelf and empty battle are valid and render no counterfeit placeholder cards',()=>{
  const w=createWorkspace();for(const d of [...w.discs])removeDisc(w,d.id);
  assert.equal(validateWorkspace(w).card.discId,null);assert.equal(renderScene(w).cardCount,0);
  w.presentation.mode='card';assert.equal(renderScene(w).cardCount,0);
});
test('invalid backup versions and dangling references are rejected before replacement',()=>{
  for(const change of [w=>w.schemaVersion=2,w=>w.battle.entries[0].discId='missing',w=>w.card.discId='missing',w=>w.battle.winnerEntryId='missing',w=>w.discs.push(w.discs[0])]){
    const w=createWorkspace();change(w);assert.throws(()=>validateWorkspace(w),/Cannot open/);
  }
});
test('images are embedded supported raster bytes, never arbitrary URLs or SVG payloads',()=>{
  for(const dataUrl of ['https://tracker.example/a.png','javascript:alert(1)','data:image/svg+xml;base64,PHN2Zy8+']){
    const w=createWorkspace();w.discs[0].photo={kind:'upload',dataUrl,fileName:'x',width:32,height:32};
    assert.throws(()=>validateWorkspace(w),/photos/);
  }
});
test('negative and decimal flight numbers/scores survive a serialized backup',()=>{
  const w=createWorkspace();w.discs[0].facts.flight=[5,4,-1.5,.5];w.battle.entries[0].score='-2.25';
  assert.deepEqual(validateWorkspace(JSON.parse(JSON.stringify(w))),w);
});
test('invalid numeric values and oversized composition fail validation',()=>{
  const w=createWorkspace();w.discs[0].facts.flight[0]=Infinity;assert.throws(()=>validateWorkspace(w),/finite/);
  const other=createWorkspace();addEntry(other,other.discs[3].id,'fourth');assert.throws(()=>addEntry(other,other.discs[4].id,'fifth'),/four/);
});
test('imported strings cannot introduce SVG or HTML markup',()=>{
  const w=createWorkspace();w.discs[0].facts.mold='<script>alert(1)</script>';w.battle.entries[0].score='<img src=x>';
  const svg=renderScene(validateWorkspace(w)).svg;assert.ok(svg.includes('&lt;script&gt;'));assert.ok(!svg.includes('<script>'));
  assert.equal(esc('" onload="x'),'&quot; onload=&quot;x');
});
test('upload rendering preserves original local image without circle clipping',()=>{
  const w=createWorkspace();w.discs[0].photo={kind:'upload',dataUrl:'data:image/png;base64,AAAA',fileName:'actual.png',width:400,height:300};
  const svg=discCard(w.discs[0],w.presentation).markup;
  assert.match(svg,/preserveAspectRatio="xMidYMid meet"/);assert.ok(!svg.includes('clip-path'));assert.ok(svg.includes(w.discs[0].photo.dataUrl));
});
test('all supported card counts, positions, layouts, and scales stay inside the video',()=>{
  let cases=0;
  for(const count of [1,2,3,4])for(const anchor of ['top-left','top-right','bottom-left','bottom-right','center'])for(const layout of ['row','stack'])for(const scale of [.5,1,1.5]){
    const w=createWorkspace();if(count===4)addEntry(w,w.discs[3].id,'entry-3');w.battle.entries=w.battle.entries.slice(0,count);
    Object.assign(w.presentation,{anchor,battleLayout:layout,scale});const b=renderScene(w).bounds;
    assert.ok(b.x>=59 && b.y>=59);assert.ok(b.x+b.width<=1861);assert.ok(b.y+b.height<=1021);cases++;
  }assert.equal(cases,120);
});
test('DiscCard wide and portrait remain in bounds at maximum scale',()=>{
  for(const cardLayout of ['wide','portrait']){
    const w=createWorkspace();Object.assign(w.presentation,{mode:'card',cardLayout,scale:1.5,anchor:'bottom-right'});
    const scene=renderScene(w);assert.equal(scene.cardCount,1);assert.ok(scene.bounds.x>=0);assert.ok(scene.bounds.y>=0);
  }
});
test('unknown backup keys are dropped, not executed or carried into the object model',()=>{
  const w=createWorkspace();w.surprise='ignored';w.discs[0].unexpected='ignored';
  const valid=validateWorkspace(w);assert.equal('surprise' in valid,false);assert.equal('unexpected' in valid.discs[0],false);
});
