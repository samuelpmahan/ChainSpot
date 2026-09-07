// Adapter contract tests. This is a small protocol test double, NOT native IndexedDB proof.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {openStorage} from '../../../static/creator-v0/storage.js';
import {createWorkspace} from '../../../static/creator-v0/model.js';
function fakeDB(value, abortSave=false) {
  let closed=false, writes=0, complete;
  const db={onversionchange:null,close(){closed=true;},transaction(_name, mode){
    const tx={error:abortSave?new Error('quota failure'):null,objectStore(){return {
      get(){const req={};queueMicrotask(()=>{req.result=value;req.onsuccess();});return req;},
      put(v){writes++;complete=()=>{if(abortSave)tx.onabort();else{value=structuredClone(v);tx.oncomplete();}};}
    };}};return tx;
  }};
  return {factory:{open(){const req={result:db};queueMicrotask(()=>req.onsuccess());return req;}},
    db,finish(){complete();},get writes(){return writes;},get closed(){return closed;}};
}
async function withFake(fake,run){
  const original=Object.getOwnPropertyDescriptor(globalThis,'indexedDB');
  Object.defineProperty(globalThis,'indexedDB',{value:fake?.factory,configurable:true});
  try{await run();}finally{if(original)Object.defineProperty(globalThis,'indexedDB',original);else delete globalThis.indexedDB;}
}
test('save does not report success before transaction completion',async()=>{
  const f=fakeDB();await withFake(f,async()=>{
    const s=await openStorage();let saved=false;const done=s.save(createWorkspace()).then(()=>saved=true);
    await Promise.resolve();assert.equal(saved,false);assert.equal(f.writes,1);f.finish();await done;assert.equal(saved,true);
    assert.deepEqual(await s.load(),createWorkspace());
  });
});
test('aborted save rejects instead of reporting Saved',async()=>{
  const f=fakeDB(undefined,true);await withFake(f,async()=>{
    const s=await openStorage();const done=s.save(createWorkspace());const rejected=assert.rejects(done,/quota/);f.finish();await rejected;
  });
});
test('invalid persisted schema is rejected, not silently replaced',async()=>{
  const f=fakeDB({schemaVersion:999});await withFake(f,async()=>{
    const s=await openStorage();await assert.rejects(s.load(),/Cannot open/);assert.equal(f.writes,0);
  });
});
test('missing record loads as null; version changes close the connection',async()=>{
  const f=fakeDB();await withFake(f,async()=>{
    const s=await openStorage();assert.equal(await s.load(),null);f.db.onversionchange();assert.equal(f.closed,true);
  });
});
test('unavailable IndexedDB produces a recoverable explicit error',async()=>{
  await withFake(null,()=>assert.rejects(openStorage(),/support local collection/));
});
