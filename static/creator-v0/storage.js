// @ts-check
import { validateWorkspace } from './model.js';
/** @typedef {import('./types').Workspace} Workspace */
export const DB_NAME = 'chainspot-creator-v0';
/** One versioned local document, separate from the course project's persistence. */
export async function openStorage() {
  if (!globalThis.indexedDB) throw new Error('This browser does not support local collection storage.');
  const db = await new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore('workspace');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('Local storage could not open.'));
    req.onblocked = () => reject(new Error('Close other ChainSpot tabs and reload to open local storage.'));
  });
  db.onversionchange = () => db.close();
  return {
    /** @returns {Promise<Workspace|null>} */
    load: () => new Promise((resolve, reject) => {
      const tx = db.transaction('workspace', 'readonly');
      const req = tx.objectStore('workspace').get('current');
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        try { resolve(req.result === undefined ? null : validateWorkspace(req.result)); }
        catch (error) { reject(error); }
      };
    }),
    /** Only signal Saved after the transaction commits, not merely after put succeeds.
     * @param {Workspace} value @returns {Promise<void>} */
    save: value => new Promise((resolve, reject) => {
      const tx = db.transaction('workspace', 'readwrite');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('Local save failed.'));
      tx.onabort = () => reject(tx.error || new Error('Local save was interrupted.'));
      tx.objectStore('workspace').put(value, 'current');
    }),
    close: () => db.close()
  };
}

/** Full-frame resize only: no crop, background removal, segmentation or replacement.
 * @param {File} file @returns {Promise<import('./types').DiscPhoto>}
 */
export async function readPhoto(file) {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw new Error('Use a JPG, PNG or WebP photo. Export HEIC images as JPG first.');
  if (file.size > 12 * 1024 * 1024) throw new Error('Choose a photo under 12 MB.');
  let bitmap;
  try { bitmap = await createImageBitmap(file); }
  catch { throw new Error('This file could not be decoded as a photo. Try another JPG, PNG or WebP.'); }
  try {
    if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > 64_000_000) throw new Error('Choose a smaller image (under 64 megapixels).');
    const ratio = Math.min(1, 1400 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * ratio));
    canvas.height = Math.max(1, Math.round(bitmap.height * ratio));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Photo processing is unavailable in this browser.');
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return {kind: 'upload', dataUrl: canvas.toDataURL('image/webp', .93),
      fileName: file.name.slice(0, 256), width: canvas.width, height: canvas.height};
  } finally { bitmap.close(); }
}

/** @param {Blob} blob @param {string} name */
export function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
