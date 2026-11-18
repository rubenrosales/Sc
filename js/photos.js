// Photo storage for notes (slides, whiteboards, posters).
// Photos are far too big for localStorage, so they live in IndexedDB on this device:
//   { id, sid, t, full: Blob (≤1600px JPEG), thumb: Blob (≤360px JPEG) }

const DB = 'scplanner-photos';
const STORE = 'photos';
let dbp = null;

function db() {
  if (!dbp) {
    dbp = new Promise((res, rej) => {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'id' });
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    dbp.catch(() => { dbp = null; });
  }
  return dbp;
}

function run(mode, fn) {
  return db().then((d) => new Promise((res, rej) => {
    const t = d.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => res(req?.result);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error || new Error('aborted'));
  }));
}

export const photosSupported = () => typeof indexedDB !== 'undefined';
export const putPhoto = (rec) => run('readwrite', (s) => s.put(rec));
export const getPhoto = (id) => run('readonly', (s) => s.get(id));
export const allPhotoKeys = () => run('readonly', (s) => s.getAllKeys());
export async function deletePhoto(id) {
  for (const k of ['thumb', 'full']) {
    const u = urls.get(`${id}:${k}`);
    if (u) { URL.revokeObjectURL(u); urls.delete(`${id}:${k}`); }
  }
  return run('readwrite', (s) => s.delete(id));
}

function loadImage(blob) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => res({ img, url });
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('Could not read that image')); };
    img.src = url;
  });
}

function toJpeg(img, max, quality) {
  const w0 = img.naturalWidth, h0 = img.naturalHeight;
  const k = Math.min(1, max / Math.max(w0, h0));
  const c = document.createElement('canvas');
  c.width = Math.round(w0 * k);
  c.height = Math.round(h0 * k);
  const g = c.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, c.width, c.height);
  g.drawImage(img, 0, 0, c.width, c.height); // browsers apply EXIF rotation to <img>
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('Could not save image'))), 'image/jpeg', quality));
}

// Phone photos are 3–12 MB; shrink them so a whole conference of slides fits comfortably.
export async function makePhoto(file) {
  const { img, url } = await loadImage(file);
  try {
    const full = await toJpeg(img, 1600, 0.82);
    const thumb = await toJpeg(img, 360, 0.72);
    return { full, thumb };
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Cached object URLs, so re-rendering a list doesn't re-read every photo.
const urls = new Map();
export async function photoURL(id, size = 'thumb') {
  const key = `${id}:${size}`;
  if (urls.has(key)) return urls.get(key);
  const rec = await getPhoto(id);
  if (!rec || !rec[size]) return null;
  const u = URL.createObjectURL(rec[size]);
  urls.set(key, u);
  return u;
}
export const cachedPhotoURL = (id, size = 'thumb') => urls.get(`${id}:${size}`) || '';

// Fill in every <img data-pid> under root.
export function hydratePhotos(root) {
  for (const img of root.querySelectorAll('img[data-pid]')) {
    if (img.src) continue;
    photoURL(img.dataset.pid, img.dataset.size || 'thumb')
      .then((u) => { if (u) img.src = u; else img.closest('.ph')?.classList.add('missing'); })
      .catch(() => img.closest('.ph')?.classList.add('missing'));
  }
}

const blobToDataURL = (b) => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(r.result);
  r.onerror = () => rej(r.error);
  r.readAsDataURL(b);
});

// For the backup file: [{ id, sid, t, data: "data:image/jpeg;base64,..." }]
export async function exportPhotos(ids) {
  const out = [];
  for (const id of ids) {
    const rec = await getPhoto(id).catch(() => null);
    if (rec?.full) out.push({ id: rec.id, sid: rec.sid, t: rec.t, data: await blobToDataURL(rec.full) });
  }
  return out;
}

export async function importPhotos(list) {
  let n = 0;
  for (const p of Array.isArray(list) ? list : []) {
    if (!p || typeof p.id !== 'string' || !/^[\w-]{1,40}$/.test(p.id)) continue;
    if (typeof p.data !== 'string' || !/^data:image\/(jpeg|png|webp);base64,/.test(p.data)) continue;
    if (await getPhoto(p.id).catch(() => null)) continue;
    try {
      const blob = await (await fetch(p.data)).blob();
      const { full, thumb } = await makePhoto(blob);
      await putPhoto({ id: p.id, sid: String(p.sid || ''), t: +p.t || Date.now(), full, thumb });
      n++;
    } catch { /* skip broken image */ }
  }
  return n;
}
