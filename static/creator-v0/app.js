import {createWorkspace, findDisc, addEntry, removeEntry, removeDisc, anotherDisc, moveEntry,
  validateWorkspace, MAX_DISCS, MAX_BACKUP_BYTES, uid} from './model.js';
import {openStorage, readPhoto, downloadBlob} from './storage.js';
import {esc, thumb, renderScene, pngFromScene} from './render.js';

const $ = id => document.getElementById(id);
let workspace = createWorkspace();
// Editor focus is intentionally not persisted or coupled to on-screen highlighting.
let selectedDiscId = workspace.card.discId;
let selectedEntryId = null;
let storage = null, storageBlocked = false, concurrentTab = false, ready = false;
let saveTimer, toastTimer;
let saveChain = Promise.resolve(), revision = 0, savedRevision = 0;
let draft = null, draftPhoto = null, photoBusy = false, photoGeneration = 0;
let contextUrl = null, clean = false, canvasIndex = 0;
const canvasStyles = ['checker','dark','light'];

function say(message, error = false) {
  $('toast').textContent = message; $('toast').dataset.error = String(error); $('toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 5500);
}
function setSaveStatus(text, state = 'saved') {
  $('save-status').textContent = text; $('save-status').dataset.state = state;
}
function storageWarning(message) {
  $('storage-warning').textContent = message; $('storage-warning').hidden = false;
  setSaveStatus('Not saved locally', 'error');
}
function changed(fullRender = true) {
  revision += 1;
  if (fullRender) render(); else {renderPreview(); renderState();}
  if (storage && !storageBlocked && !concurrentTab) {
    setSaveStatus('Unsaved changes', 'pending');
    clearTimeout(saveTimer); saveTimer = setTimeout(flushSave, 180);
  } else setSaveStatus('Session only · save backup', 'error');
}
function flushSave() {
  clearTimeout(saveTimer);
  if (!storage || storageBlocked || concurrentTab || revision === savedRevision) return saveChain;
  const capturedRevision = revision;
  let snapshot;
  try { snapshot = validateWorkspace(workspace); }
  catch(error) {storageWarning(error.message);return saveChain;}
  setSaveStatus('Saving on this browser…', 'pending');
  saveChain = saveChain.then(() => storage.save(snapshot)).then(() => {
    savedRevision = capturedRevision;
    if (revision === capturedRevision) {
      setSaveStatus('Saved on this browser'); $('storage-warning').hidden = true;
    }
  }).catch(error => storageWarning(`Changes are not saved locally: ${error.message || 'storage failed'}. Save a backup before closing this tab.`));
  return saveChain;
}

function preserveFocus(draw) {
  const active = document.activeElement;
  const key = active?.dataset?.focusKey;
  const start = active?.selectionStart, end = active?.selectionEnd;
  draw();
  if (key) {
    const target = document.querySelector(`[data-focus-key="${CSS.escape(key)}"]`);
    target?.focus({preventScroll:true});
    if (target?.setSelectionRange && start !== null) target.setSelectionRange(start,end);
  }
}
function renderCollection() {
  const query = $('disc-search').value.trim().toLowerCase();
  const filtered = workspace.discs.filter(d => [d.facts.manufacturer,d.facts.mold,d.label,d.plastic].join(' ').toLowerCase().includes(query));
  $('disc-count').textContent = workspace.discs.length;
  $('collection-list').innerHTML = filtered.map(d => `<div class="collection-item ${selectedDiscId === d.id ? 'selected' : ''}">
    <button class="disc-pick" data-action="select-disc" data-id="${esc(d.id)}" aria-label="Select ${esc(d.label || d.facts.mold)}" aria-pressed="${selectedDiscId === d.id}">
    ${thumb(d)}<span><strong>${esc(d.facts.mold)}</strong><small>${esc(d.label || d.facts.manufacturer)}</small><small class="sample-tag">${d.photo?.kind === 'sample' ? 'SAMPLE ART' : d.photo?.kind === 'upload' ? 'YOUR PHOTO' : 'PHOTO NEEDED'}</small></span></button>
    <button class="collection-add" data-action="add-entry" data-id="${esc(d.id)}" aria-label="Add ${esc(d.label || d.facts.mold)} to battle" title="Add to battle" ${workspace.battle.entries.length >= 4 ? 'disabled' : ''}>＋</button>
    </div>`).join('') || `<p class="subtle">${workspace.discs.length ? 'No matching discs. Try another name.' : 'Your shelf is empty. Add your first disc above.'}</p>`;
}
function renderLineup() {
  const b = workspace.battle;
  $('entry-count').textContent = `${b.entries.length} / 4`;
  $('lineup').dataset.count = String(b.entries.length);
  $('lineup').innerHTML = b.entries.map((entry,i) => {
    const d = findDisc(workspace,entry.discId);
    const highlighted = b.highlightedEntryId === entry.id;
    return `<article class="entry ${selectedEntryId === entry.id ? 'is-selected' : ''} ${highlighted ? 'is-highlighted' : ''}" data-entry-id="${esc(entry.id)}">
      <div class="entry-top"><button class="entry-select" data-action="select-entry" data-id="${esc(entry.id)}" aria-label="Edit ${esc(d.label || d.facts.mold)} entry" aria-pressed="${selectedEntryId === entry.id}">${esc(d.facts.mold)}</button><div class="entry-tools"><button data-action="move-left" data-id="${esc(entry.id)}" aria-label="Move ${esc(d.facts.mold)} earlier" ${i===0?'disabled':''}>←</button><button data-action="move-right" data-id="${esc(entry.id)}" aria-label="Move ${esc(d.facts.mold)} later" ${i===b.entries.length-1?'disabled':''}>→</button><button data-action="remove-entry" data-id="${esc(entry.id)}" aria-label="Remove ${esc(d.label || d.facts.mold)} from battle">×</button></div></div>
      <p class="entry-label" title="${esc(d.label)}">${esc(d.label || d.facts.manufacturer)}</p>
      <label class="score-field"><span>SCORE</span><input class="score-input" data-entry="${esc(entry.id)}" data-focus-key="score-${esc(entry.id)}" value="${esc(entry.score)}" maxlength="12" placeholder="—" aria-label="Score for ${esc(d.label || d.facts.mold)}" autocomplete="off"/></label>
      <div class="entry-state"><button data-action="highlight" data-id="${esc(entry.id)}" aria-label="Highlight ${esc(d.label || d.facts.mold)}" aria-pressed="${highlighted}">${highlighted?'● Highlighted':'Highlight'}</button><button class="winner-button" data-action="winner" data-id="${esc(entry.id)}" aria-label="Mark ${esc(d.label || d.facts.mold)} as winner" aria-pressed="${b.winnerEntryId===entry.id}" title="Manually mark winner">★</button></div>
    </article>`;
  }).join('') || '<div class="lineup-empty">Add a disc with ＋ on your shelf. Start with one; try up to four.</div>';
}
function renderSelected() {
  const d = findDisc(workspace,selectedDiscId);
  $('selected-disc').innerHTML = d ? `<span class="eyebrow">SELECTED FOR EDITING</span>
    <div class="selected-preview">${thumb(d,55)}<div><strong>${esc(d.facts.mold)}</strong><small>${esc(d.facts.manufacturer)}</small></div></div>
    <span class="disc-details">${esc(d.label || 'No nickname')}<br>${esc([d.plastic,d.weight].filter(Boolean).join(' · '))}</span>
    ${d.photo?.kind !== 'upload' ? `<p class="sample-warning">${d.photo ? 'Sample illustration, not your disc.' : 'This disc still needs its photo.'}<br>Add your exact disc's photo.</p>` : ''}
    <button class="edit-button" data-action="edit-disc" data-id="${esc(d.id)}">Edit details & photo ↗</button>
    <div class="disc-links"><button class="text-button" data-action="another-disc" data-id="${esc(d.id)}">Another of this mold</button><button class="text-button" data-action="delete-disc" data-id="${esc(d.id)}">Delete</button></div>`
    : '<p class="subtle">Select a disc to edit its details and photo.</p>';
}
function renderState() {
  const snapshot = structuredClone(workspace);
  for (const d of snapshot.discs) if (d.photo?.kind === 'upload') d.photo.dataUrl = `[embedded image, ${d.photo.dataUrl.length} characters]`;
  $('state-inspector').textContent = JSON.stringify({document:snapshot,editorOnly:{selectedDiscId,selectedEntryId},note:'Score is entry-local. Highlight and winner are manually authored, not inferred.'},null,2);
}
function renderPreview() {
  const scene = renderScene(workspace);
  $('overlay').innerHTML = scene.svg;
  $('empty-overlay').hidden = scene.cardCount > 0;
  const photoTypes = workspace.presentation.mode === 'card'
    ? workspace.discs.filter(d=>d.id===workspace.card.discId)
    : workspace.battle.entries.map(e=>findDisc(workspace,e.discId));
  const sampleCount = photoTypes.filter(d=>d?.photo?.kind==='sample').length;
  $('preview-measure').textContent = `${sampleCount ? 'Sample artwork · replace with your photos' : 'Transparent overlay · footage is preview-only'}${scene.effectiveScale < workspace.presentation.scale ? ' · size fitted to canvas' : ''}`;
  document.querySelector('[data-action=export]').disabled = scene.cardCount === 0;
}
function render() {
  preserveFocus(() => {
    const p = workspace.presentation;
    if (!findDisc(workspace,selectedDiscId)) selectedDiscId = workspace.discs[0]?.id ?? null;
    if (!workspace.battle.entries.some(e=>e.id===selectedEntryId)) selectedEntryId = null;
    document.querySelectorAll('[data-mode]').forEach(button => {
      const selected = button.dataset.mode === p.mode; button.classList.toggle('chosen',selected);button.setAttribute('aria-pressed',String(selected));
    });
    document.querySelectorAll('[data-theme]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.theme===p.theme)));
    document.querySelectorAll('[data-anchor]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.anchor===p.anchor)));
    $('mode-title').textContent = p.mode === 'battle' ? 'Let your discs compete.' : 'Your disc. In the spotlight.';
    $('mode-description').textContent = p.mode === 'battle' ? 'Your lineup, your scores. Nothing happens until you choose it.' : 'Show the actual disc, not just its name. Pick one from your shelf.';
    $('lineup-panel').hidden = p.mode !== 'battle'; $('single-note').hidden = p.mode !== 'card';
    const options = p.mode === 'battle' ? [['row','Across the screen'],['stack','Stacked cards']] : [['wide','Wide card'],['portrait','Portrait card']];
    const value = p.mode === 'battle' ? p.battleLayout : p.cardLayout;
    $('layout-control').innerHTML = options.map(([v,label])=>`<option value="${v}" ${v===value?'selected':''}>${label}</option>`).join('');
    $('scale-control').value = Math.round(p.scale*100);$('scale-value').textContent = `${Math.round(p.scale*100)}%`;
    $('show-flight').checked = p.showFlightNumbers; $('show-label').checked = p.showInstanceLabel;
    renderCollection(); renderLineup(); renderSelected(); renderPreview(); renderState();
  });
}
function showDiscDialog(disc, isNew = false) {
  if (isNew && workspace.discs.length >= MAX_DISCS) return say('This prototype supports up to 200 saved discs.',true);
  photoGeneration += 1; photoBusy = false;
  draft = disc ? structuredClone(disc) : {id:uid(),facts:{manufacturer:'',mold:'',flight:[null,null,null,null]},label:'',plastic:'',weight:'',photo:null};
  draftPhoto = draft.photo;
  $('disc-dialog').dataset.isNew = String(isNew || !disc);
  $('disc-dialog-title').textContent = isNew || !disc ? 'Add your disc' : 'Edit your disc';
  $('disc-form').reset(); $('form-error').hidden = true; $('save-disc').disabled = false;
  const values = {manufacturer:draft.facts.manufacturer,mold:draft.facts.mold,label:draft.label,plastic:draft.plastic,weight:draft.weight,
    speed:draft.facts.flight[0],glide:draft.facts.flight[1],turn:draft.facts.flight[2],fade:draft.facts.flight[3]};
  for (const [key,value] of Object.entries(values)) $('disc-form').elements.namedItem(key).value = value ?? '';
  renderPhotoPreview(); $('disc-dialog').showModal();
}
function renderPhotoPreview() {
  $('photo-preview').innerHTML = thumb({...draft,photo:draftPhoto},175);
}
function closeDialog() { photoGeneration += 1; $('disc-dialog').close(); draft=null;draftPhoto=null;photoBusy=false; }
async function acceptPhoto(file) {
  if (!file || !draft) return;
  const generation = ++photoGeneration;
  photoBusy = true; $('save-disc').disabled = true; $('form-error').hidden = true;
  try {
    const photo = await readPhoto(file);
    if (generation !== photoGeneration || !draft) return;
    draftPhoto = photo; renderPhotoPreview();
  } catch(error) {
    if (generation === photoGeneration) {$('form-error').textContent=error.message;$('form-error').hidden=false;}
  } finally {
    if (generation === photoGeneration) {photoBusy=false;$('save-disc').disabled=false;}
  }
}
$('disc-form').addEventListener('submit', event => {
  event.preventDefault();if (photoBusy || !draft) return;
  const form = new FormData(event.currentTarget);
  const value = key => String(form.get(key) || '').trim();
  const disc = {...draft,facts:{manufacturer:value('manufacturer'),mold:value('mold'),flight:['speed','glide','turn','fade'].map(k=>Number(value(k)))},
    label:value('label'),plastic:value('plastic'),weight:value('weight'),photo:draftPhoto};
  const next = structuredClone(workspace);
  const i = next.discs.findIndex(d=>d.id===disc.id);
  if (i < 0) next.discs.push(disc);else next.discs[i]=disc;
  if (!next.card.discId) next.card.discId=disc.id;
  try {workspace=validateWorkspace(next);} catch(error) {$('form-error').textContent=error.message;$('form-error').hidden=false;return;}
  selectedDiscId=disc.id;
  if (workspace.presentation.mode==='card') workspace.card.discId=disc.id;
  closeDialog();changed();say('Disc updated on your shelf.');
});
$('disc-dialog').addEventListener('cancel', event=>{event.preventDefault();closeDialog();});
$('photo-file').addEventListener('change', e=>{acceptPhoto(e.target.files[0]);e.target.value='';});
$('photo-drop').addEventListener('dragover',e=>{e.preventDefault();$('photo-drop').classList.add('drag-over');});
$('photo-drop').addEventListener('dragleave',()=> $('photo-drop').classList.remove('drag-over'));
$('photo-drop').addEventListener('drop',e=>{e.preventDefault();$('photo-drop').classList.remove('drag-over');acceptPhoto(e.dataTransfer.files[0]);});
// A mis-aimed image drop must not navigate away and destroy the current session.
window.addEventListener('dragover',e=>e.preventDefault());window.addEventListener('drop',e=>e.preventDefault());

function clearContext() {
  const video=$('context-video');video.pause();video.removeAttribute('src');video.load();video.hidden=true;
  $('context-image').removeAttribute('src');$('context-image').hidden=true;
  if (contextUrl) URL.revokeObjectURL(contextUrl);contextUrl=null;
  $('preview-placeholder').hidden=false;$('clear-context').hidden=true;
}
$('context-file').addEventListener('change',e=>{
  const file=e.target.files[0];e.target.value='';if(!file)return;
  if (!['image/jpeg','image/png','image/webp','video/mp4','video/webm'].includes(file.type) || file.size > 300*1024*1024) return say('Use a JPG, PNG, WebP, MP4 or WebM under 300 MB.',true);
  clearContext();contextUrl=URL.createObjectURL(file);
  const target=file.type.startsWith('video/')?$('context-video'):$('context-image');
  target.onerror=()=>{clearContext();say('This browser could not open that preview file.',true);};
  target.src=contextUrl;target.hidden=false;$('preview-placeholder').hidden=true;$('clear-context').hidden=false;
  if (file.type.startsWith('video/')) target.play().catch(()=>{});
});
$('restore-file').addEventListener('change',async e=>{
  const file=e.target.files[0];e.target.value='';if(!file)return;
  try {
    if(file.size>MAX_BACKUP_BYTES)throw new Error('This backup is too large (maximum 40 MB).');
    const next=validateWorkspace(JSON.parse(await file.text()));
    if(!confirm(`Replace this browser's current shelf and composition with ${next.discs.length} discs from this backup? Save a backup first to keep the current shelf.`))return;
    workspace=next;selectedDiscId=workspace.card.discId;selectedEntryId=null;
    storageBlocked=false;changed();await flushSave();say('Backup restored.');
  } catch(error){say(error.message || 'This backup could not be read. Your shelf was not changed.',true);}
});

async function handleAction(button) {
  const id=button.dataset.id, action=button.dataset.action;
  if(action==='new-disc')return showDiscDialog(null,true);
  if(action==='edit-disc')return showDiscDialog(findDisc(workspace,id));
  if(action==='another-disc')return showDiscDialog(anotherDisc(findDisc(workspace,id)),true);
  if(action==='close-dialog')return closeDialog();
  if(action==='remove-photo'){draftPhoto=null;photoGeneration+=1;photoBusy=false;$('save-disc').disabled=false;renderPhotoPreview();return;}
  if(action==='context')return $('context-file').click();
  if(action==='clear-context')return clearContext();
  if(action==='canvas'){canvasIndex=(canvasIndex+1)%canvasStyles.length;$('preview-stage').dataset.canvas=canvasStyles[canvasIndex];$('canvas-label').textContent=canvasStyles[canvasIndex];return;}
  if(action==='clean'){clean=!clean;document.body.classList.toggle('clean-mode',clean);return;}
  if(action==='restore')return $('restore-file').click();
  if(action==='backup'){
    const json=JSON.stringify(validateWorkspace(workspace),null,2);
    if(new Blob([json]).size>MAX_BACKUP_BYTES)throw new Error('This collection is too large for the v0.0 backup format. Remove unused large photos first.');
    downloadBlob(new Blob([json],{type:'application/json'}),'chainspot-creator-v0.json');say('Backup includes your photos, discs and current composition.');return;
  }
  if(action==='export'){
    button.disabled=true;const original=button.textContent;button.textContent='Rendering PNG…';
    try {const blob=await pngFromScene(renderScene(workspace).svg);downloadBlob(blob,`chainspot-${workspace.presentation.mode}-1920.png`);say('Transparent PNG saved. Your preview footage is not included.');}
    finally{button.disabled=false;button.textContent=original;}return;
  }
  if(action==='reset-demo'){
    if(!confirm('Replace your shelf, photos and composition with sample discs? Save a backup first to keep your work.'))return;
    workspace=createWorkspace();selectedDiscId=workspace.card.discId;selectedEntryId=null;storageBlocked=false;changed();return;
  }
  if(action==='select-disc'){
    selectedDiscId=id;
    if(workspace.presentation.mode==='card'){workspace.card.discId=id;changed();}
    else render();return;
  }
  if(action==='select-entry'){
    selectedEntryId=id;selectedDiscId=workspace.battle.entries.find(e=>e.id===id)?.discId;render();return;
  }
  if(action==='add-entry'){
    const entry=addEntry(workspace,id);selectedEntryId=entry.id;selectedDiscId=id;workspace.presentation.mode='battle';
  } else if(action==='remove-entry')removeEntry(workspace,id);
  else if(action==='highlight')workspace.battle.highlightedEntryId=workspace.battle.highlightedEntryId===id?null:id;
  else if(action==='winner')workspace.battle.winnerEntryId=workspace.battle.winnerEntryId===id?null:id;
  else if(action==='clear-highlight')workspace.battle.highlightedEntryId=null;
  else if(action==='move-left')moveEntry(workspace,id,-1);
  else if(action==='move-right')moveEntry(workspace,id,1);
  else if(action==='delete-disc'){
    const d=findDisc(workspace,id);const used=workspace.battle.entries.some(e=>e.discId===id);
    if(!confirm(`Delete ${d.label||d.facts.mold} from your shelf?${used?' Its battle entries and their scores will also be removed.':''}`))return;
    removeDisc(workspace,id);
  } else return;
  changed();
}
document.addEventListener('click',async event=>{
  const button=event.target.closest('button');if(!button||button.disabled||!ready)return;
  try {
    if(button.dataset.mode){workspace.presentation.mode=button.dataset.mode;if(button.dataset.mode==='card' && selectedDiscId)workspace.card.discId=selectedDiscId;changed();}
    else if(button.dataset.theme){workspace.presentation.theme=button.dataset.theme;changed();}
    else if(button.dataset.anchor){workspace.presentation.anchor=button.dataset.anchor;changed();}
    else if(button.dataset.action)await handleAction(button);
  }catch(error){say(error.message||'That change could not be completed.',true);}
});
$('disc-search').addEventListener('input',renderCollection);
$('lineup').addEventListener('input',e=>{
  if(!e.target.matches('.score-input'))return;
  const entry=workspace.battle.entries.find(entry=>entry.id===e.target.dataset.entry);
  if(entry){entry.score=e.target.value.slice(0,12);changed(false);}
});
$('layout-control').addEventListener('change',e=>{
  workspace.presentation[workspace.presentation.mode==='battle'?'battleLayout':'cardLayout']=e.target.value;changed();
});
$('scale-control').addEventListener('input',e=>{
  workspace.presentation.scale=Number(e.target.value)/100;$('scale-value').textContent=`${e.target.value}%`;changed(false);
});
$('show-flight').addEventListener('change',e=>{workspace.presentation.showFlightNumbers=e.target.checked;changed(false);});
$('show-label').addEventListener('change',e=>{workspace.presentation.showInstanceLabel=e.target.checked;changed(false);});
document.addEventListener('visibilitychange',()=>{if(document.hidden)flushSave();});
window.addEventListener('beforeunload',event=>{
  if(revision!==savedRevision){flushSave();event.preventDefault();event.returnValue='';}
});
// Do not silently overwrite another tab's collection with a stale document.
let channel;
if('BroadcastChannel' in window){
  channel=new BroadcastChannel('chainspot-creator-v0-open');
  channel.onmessage=event=>{
    if(event.data==='opening')channel.postMessage('already-open');
    if(event.data==='already-open'){
      concurrentTab=true;
      storageWarning('Another creator tab is open. This tab is session-only to avoid overwriting its work. Save a backup, then close extra tabs and reload.');
    }
  };
}
async function boot(){
  document.querySelector('.app-grid').inert=true;
  try{
    storage=await openStorage();
    const saved=await storage.load();
    if(saved)workspace=saved;else await storage.save(workspace);
    selectedDiscId=workspace.card.discId;
    setSaveStatus('Saved on this browser');
  }catch(error){storageBlocked=true;storageWarning('Session only: local storage is unavailable or the saved collection could not be read. Existing data was not replaced. Save a backup before closing.');$('storage-warning').title=error.message;}
  render();ready=true;document.querySelector('.app-grid').inert=false;
  document.documentElement.dataset.appReady='true';
  channel?.postMessage('opening');
}
boot();
