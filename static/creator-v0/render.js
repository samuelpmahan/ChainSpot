// @ts-check
/** @typedef {import('./types').Disc} Disc */
/** @typedef {import('./types').Workspace} Workspace */
/** @typedef {import('./types').Presentation} Presentation */
/** Escape every user-controlled string, including scores and imported names. @param {unknown} s */
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c] || c));
/** @param {number} x @param {number} y @param {unknown} value @param {number} size @param {string} color @param {string} [attrs] */
const text = (x, y, value, size, color, attrs = '') => `<text x="${x}" y="${y}" font-size="${size}" fill="${color}" ${attrs}>${esc(value)}</text>`;
/** Approximate width fit for long names; deliberately no ellipsis hiding disc identity.
 * @param {string} s @param {number} width @param {number} max */
const fit = (s, width, max) => Math.min(max, width / Math.max(1, [...s].length * .60));
const palette = {
  dark: {bg:'#171c22', fg:'#f5f5ef', muted:'#afb8bf', rule:'#343b43', chip:'#252d34', hi:'#c9ef82'},
  light: {bg:'#fcfcf6', fg:'#202923', muted:'#526058', rule:'#c9d0c8', chip:'#e9eee5', hi:'#41651b'}
};
/** @param {Disc} disc @param {number} x @param {number} y @param {number} size */
export function discArt(disc, x, y, size) {
  if (disc.photo?.kind === 'upload') return `<image href="${esc(disc.photo.dataUrl)}" x="${x}" y="${y}" width="${size}" height="${size}" preserveAspectRatio="xMidYMid meet"/>`;
  if (!disc.photo) return `<g transform="translate(${x} ${y})"><rect width="${size}" height="${size}" rx="12" fill="#303840"/><path d="M${size*.25} ${size*.65}l${size*.18}-${size*.2} ${size*.14} ${size*.13} ${size*.14}-${size*.22} ${size*.12} ${size*.29}" fill="none" stroke="#9da7ae" stroke-width="2"/>${text(size/2, size*.84, 'ADD PHOTO', size*.105, '#c5cbd0', 'text-anchor="middle"')}</g>`;
  const hue = disc.photo.hue;
  return `<g transform="translate(${x} ${y}) scale(${size/120})">
    <circle cx="60" cy="61" r="57" fill="hsl(${hue} 45% 25%)"/>
    <circle cx="60" cy="58" r="56" fill="hsl(${hue} 60% 73%)"/>
    <circle cx="60" cy="58" r="49" fill="none" stroke="hsl(${hue} 39% 45%)" stroke-width="1.5"/>
    <circle cx="60" cy="58" r="44" fill="none" stroke="hsl(${hue} 52% 83%)" stroke-width="1"/>
    <path d="M26 78 Q65 38 94 33 M24 88 Q68 55 98 46" fill="none" stroke="hsl(${hue} 37% 54%)" stroke-width=".9"/>
    ${text(60,32,'SAMPLE ART',8,'#28363d','text-anchor="middle" letter-spacing="1.2"')}
    ${text(60,63,disc.facts.mold.toUpperCase(),fit(disc.facts.mold,88,17),'#25343c','text-anchor="middle" font-weight="800"')}
    ${text(60,79,'NOT YOUR PHOTO',6.4,'#30434a','text-anchor="middle" letter-spacing=".6"')}
    <path d="M43 93h34" stroke="#30434a" stroke-width="1"/>
  </g>`;
}
/** @param {Disc} d @param {number} [size] */
export const thumb = (d, size = 64) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" width="${size}" height="${size}" role="img" aria-label="${esc(d.photo?.kind === 'upload' ? `Your photo: ${d.label || d.facts.mold}` : d.photo?.kind === 'sample' ? `Sample illustration: ${d.facts.mold}` : 'Photo needed')}">${discArt(d,0,0,120)}</svg>`;
/** @param {Disc} d @param {number} x @param {number} y @param {number} cell @param {number} font @param {typeof palette.dark} p */
function flights(d, x, y, cell, font, p) {
  return d.facts.flight.map((v,i) => `<g>${text(x+i*cell+cell/2,y,v,fit(String(v),cell-8,font),p.fg,'text-anchor="middle" font-weight="750"')}${text(x+i*cell+cell/2,y+font*.78,['SPEED','GLIDE','TURN','FADE'][i],font*.40,p.muted,'text-anchor="middle" letter-spacing=".8"')}</g>`).join('');
}
/** The same component produces every battle card; scores never live on Disc.
 * @param {Disc} d @param {Presentation} view @param {{score?:string, highlighted?:boolean, winner?:boolean, battle?:boolean}} [state]
 */
export function discCard(d, view, state = {}) {
  const p = palette[view.theme];
  const battle = state.battle;
  const portrait = !battle && view.cardLayout === 'portrait';
  const width = battle ? 382 : portrait ? 350 : 610;
  const height = battle ? 176 : portrait ? 450 : 256;
  const label = d.label || [d.plastic, d.weight].filter(Boolean).join(' · ');
  let svg = `<rect x="2" y="2" width="${width-4}" height="${height-4}" rx="18" fill="${p.bg}" stroke="${state.highlighted ? p.hi : p.rule}" stroke-width="${state.highlighted ? 4 : 1.5}"/>`;
  if (state.highlighted) svg += `<rect x="26" y="0" width="${width-52}" height="5" rx="2.5" fill="${p.hi}"/>`;
  if (battle) {
    svg += discArt(d,14,22,106);
    svg += text(132,31,d.facts.manufacturer.toUpperCase(),fit(d.facts.manufacturer,155,11),p.muted,'font-weight="650" letter-spacing="1.1"');
    svg += text(130,61,d.facts.mold,fit(d.facts.mold,159,25),p.fg,'font-weight="800"');
    if (view.showInstanceLabel) svg += text(132,82,label,fit(label,150,11),p.muted);
    if (view.showFlightNumbers) svg += flights(d,122,121,40,22,p);
    svg += `<path d="M298 32v111" stroke="${p.rule}"/>`;
    const score = state.score?.trim() || '—';
    svg += text(339,87,score,fit(score,67,43),state.highlighted ? p.hi : p.fg,'text-anchor="middle" font-weight="800"');
    svg += text(339,108,'SCORE',9,p.muted,'text-anchor="middle" letter-spacing="1.2"');
    if (state.winner) svg += text(339,141,'★',24,p.hi,'text-anchor="middle" aria-label="Manually marked winner"');
    if (d.photo?.kind !== 'upload') svg += text(67,153,d.photo ? 'SAMPLE ART' : 'PHOTO NEEDED',8,p.muted,'text-anchor="middle" letter-spacing=".8"');
  } else if (portrait) {
    svg += discArt(d,67,25,216);
    svg += text(175,264,d.facts.manufacturer.toUpperCase(),fit(d.facts.manufacturer,290,13),p.muted,'text-anchor="middle" letter-spacing="2"');
    svg += text(175,304,d.facts.mold,fit(d.facts.mold,295,39),p.fg,'text-anchor="middle" font-weight="800"');
    if (view.showInstanceLabel) svg += text(175,329,label,fit(label,300,14),p.muted,'text-anchor="middle"');
    if (view.showFlightNumbers) svg += flights(d,25,383,75,30,p);
  } else {
    svg += discArt(d,20,23,206);
    svg += text(256,49,d.facts.manufacturer.toUpperCase(),fit(d.facts.manufacturer,325,13),p.muted,'font-weight="650" letter-spacing="2"');
    svg += text(253,99,d.facts.mold,fit(d.facts.mold,330,46),p.fg,'font-weight="800"');
    if (view.showInstanceLabel) svg += text(257,128,label,fit(label,325,16),p.muted);
    if (view.showFlightNumbers) svg += flights(d,240,192,81,33,p);
  }
  return {width, height, markup: `<g>${svg}</g>`};
}
/** Composition is deterministic; preview and export both use THIS scene.
 * @param {Workspace} workspace
 */
export function renderScene(workspace) {
  const view = workspace.presentation;
  /** @type {{width:number,height:number,markup:string}[]} */
  let cards = [];
  if (view.mode === 'card') {
    const disc = workspace.discs.find(d => d.id === workspace.card.discId);
    if (disc) cards = [discCard(disc,view)];
  } else {
    cards = workspace.battle.entries.flatMap(entry => {
      const disc = workspace.discs.find(d => d.id === entry.discId);
      return disc ? [discCard(disc,view,{battle:true,score:entry.score,
        highlighted: entry.id === workspace.battle.highlightedEntryId,
        winner: entry.id === workspace.battle.winnerEntryId})] : [];
    });
  }
  const stacked = view.mode === 'battle' && view.battleLayout === 'stack';
  const gap = 14;
  const width = cards.length ? (stacked ? Math.max(...cards.map(c=>c.width)) : cards.reduce((s,c)=>s+c.width,0)+gap*(cards.length-1)) : 0;
  const height = cards.length ? (stacked ? cards.reduce((s,c)=>s+c.height,0)+gap*(cards.length-1) : Math.max(...cards.map(c=>c.height))) : 0;
  // Keep the ENTIRE composition in frame at every allowed scale/layout.
  const scale = Math.min(view.scale, 1800/Math.max(width,1), 960/Math.max(height,1));
  const x = view.anchor === 'center' ? (1920-width*scale)/2 : view.anchor.endsWith('right') ? 1860-width*scale : 60;
  const y = view.anchor === 'center' ? (1080-height*scale)/2 : view.anchor.startsWith('top') ? 60 : 1020-height*scale;
  let offset = 0;
  const markup = cards.map(c => {
    const result = `<g transform="translate(${stacked?0:offset} ${stacked?offset:0})">${c.markup}</g>`;
    offset += (stacked?c.height:c.width)+gap;
    return result;
  }).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080" role="img" aria-label="${view.mode === 'battle' ? 'DiscBattle' : 'DiscCard'} overlay" font-family="Arial, Helvetica, sans-serif"><g transform="translate(${x} ${y}) scale(${scale})">${markup}</g></svg>`;
  return {svg, bounds:{x,y,width:width*scale,height:height*scale}, cardCount:cards.length, effectiveScale:scale};
}
/** @param {string} svg @param {number} [width] @returns {Promise<Blob>} */
export function pngFromScene(svg, width = 1920) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(new Blob([svg],{type:'image/svg+xml;charset=utf-8'}));
    const image = new Image();
    const cleanup = () => URL.revokeObjectURL(url);
    image.onerror = () => {cleanup();reject(new Error('This browser could not render the overlay.'));};
    image.onload = () => {
      try {
        const canvas = document.createElement('canvas');canvas.width = width;canvas.height = width*9/16;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('PNG export is unavailable in this browser.');
        ctx.drawImage(image,0,0,canvas.width,canvas.height);
        canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('PNG export failed.')), 'image/png');
      } catch(error) {reject(error);} finally {cleanup();}
    };
    image.src = url;
  });
}
